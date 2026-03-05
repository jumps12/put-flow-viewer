#!/usr/bin/env python3
"""
fetch_premiums.py — Stamp status + fill original_premium for new positions.

For every position in positions.json:
  • Sets status = "ACTIVE" or "EXPIRED" based on the expiry date.
  • Fetches original_premium from Yahoo Finance ONLY when it is missing or zero.
    Once set, original_premium is never overwritten.

No current_premium tracking.  No P&L calculation.
Typical run time: < 30 seconds (only new positions require API calls).

Usage:
    python3 fetch_premiums.py
"""

import calendar
import json
import socket
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime
from pathlib import Path

# ── Configuration ─────────────────────────────────────────────────────────────

POSITIONS_FILE = Path(__file__).parent / "positions.json"
HEADERS        = {"User-Agent": "Mozilla/5.0"}
TIMEOUT_SECS   = 10    # per-request HTTP timeout (seconds)
MAX_RETRIES    = 3     # attempts before permanently giving up on one fetch
RETRY_DELAY    = 1.0   # pause between retry attempts (seconds)
FETCH_DELAY    = 0.5   # polite pause between distinct fetches (rate limit)

# ── Yahoo Finance helpers ─────────────────────────────────────────────────────

def expiry_ts(expiry_str: str) -> int:
    """Convert 'YYYY-MM-DD' → midnight UTC Unix timestamp (what Yahoo expects)."""
    d = datetime.strptime(expiry_str, "%Y-%m-%d")
    return calendar.timegm(d.timetuple())


def fetch_options(ticker: str, ts: int):
    """
    Fetch the Yahoo Finance options chain for (ticker, expiry_ts).
    Returns parsed JSON on success, or None after MAX_RETRIES failures.
    Never raises — all errors are caught, logged, and retried.
    """
    url = (
        f"https://query1.finance.yahoo.com/v7/finance/options/"
        f"{ticker}?date={ts}"
    )
    req = urllib.request.Request(url, headers=HEADERS)

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_SECS) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            _retry_msg(f"HTTP {exc.code}", attempt)
        except urllib.error.URLError as exc:
            if isinstance(exc.reason, socket.timeout):
                _retry_msg("Timed out", attempt)
            else:
                _retry_msg(f"Network: {exc.reason}", attempt)
        except (socket.timeout, TimeoutError):
            _retry_msg("Timed out", attempt)
        except Exception as exc:          # pragma: no cover
            _retry_msg(f"Unexpected: {exc}", attempt)
        if attempt < MAX_RETRIES:
            time.sleep(RETRY_DELAY)

    print(f"  ✗ FAILED after {MAX_RETRIES} attempts — skipping", flush=True)
    return None


def _retry_msg(reason: str, attempt: int) -> None:
    print(f"\n    attempt {attempt}/{MAX_RETRIES}: {reason}", end="", flush=True)


def parse_chain(data: dict):
    """Extract puts and calls from Yahoo's option chain response."""
    try:
        tables = data["optionChain"]["result"][0].get("options", [])
        puts, calls = [], []
        for table in tables:
            puts.extend(table.get("puts",  []))
            calls.extend(table.get("calls", []))
        return puts, calls
    except (KeyError, IndexError, TypeError):
        return [], []


def find_contract(chain: list, strike: float, tol: float = 0.01):
    """Return the first contract whose strike matches within tol, or None."""
    for c in chain:
        c_strike = (c.get("strike") or {}).get("raw")
        if c_strike is not None and abs(float(c_strike) - strike) <= tol:
            return c
    return None


def mid_price(contract: dict):
    """Bid/ask mid-point, falling back to lastPrice. Returns None if unavailable."""
    bid  = (contract.get("bid")       or {}).get("raw")
    ask  = (contract.get("ask")       or {}).get("raw")
    last = (contract.get("lastPrice") or {}).get("raw")
    if bid and ask and float(bid) > 0 and float(ask) > 0:
        return round((float(bid) + float(ask)) / 2, 4)
    if last and float(last) > 0:
        return round(float(last), 4)
    return None


# ── Utilities ─────────────────────────────────────────────────────────────────

def _parse_date_field(raw) -> date | None:
    """Parse YYYY-MM-DD or MM/DD/YYYY; return None on failure."""
    s = str(raw).strip()
    for fmt in ("%Y-%m-%d", "%m/%d/%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    return None


def _has_premium(value) -> bool:
    """Return True if value is a non-null, non-zero number."""
    try:
        return value is not None and float(value) > 0
    except (ValueError, TypeError):
        return False


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    if not POSITIONS_FILE.exists():
        print(f"ERROR: {POSITIONS_FILE} not found.", file=sys.stderr)
        sys.exit(1)

    positions = json.loads(POSITIONS_FILE.read_text())
    today     = date.today()

    # ── Pass 1: stamp ACTIVE / EXPIRED on every row ───────────────────────────
    # No API calls here — pure date comparison.
    needs_premium = []   # indices where original_premium is missing/zero
    n_active = n_expired = 0

    for idx, p in enumerate(positions):
        exp_date = _parse_date_field(p.get("expiry"))
        if exp_date is not None and exp_date < today:
            p["status"] = "EXPIRED"
            n_expired += 1
        else:
            p["status"] = "ACTIVE"
            n_active += 1

        if not _has_premium(p.get("original_premium")):
            needs_premium.append(idx)

    print(f"positions.json  : {len(positions)} rows  ({n_active} active, {n_expired} expired)")
    print(f"Status updated  : all rows")
    print(f"Need premium    : {len(needs_premium)} positions  (original_premium missing or zero)")

    # ── Early exit if nothing to fetch ───────────────────────────────────────
    if not needs_premium:
        POSITIONS_FILE.write_text(json.dumps(positions, indent=2))
        print(f"✓ Written to    : {POSITIONS_FILE.name}  (status only, no fetches needed)")
        return

    # ── Pass 2: group by (ticker, expiry) — one API call per pair ─────────────
    groups: dict = {}
    for idx in needs_premium:
        p   = positions[idx]
        sym = str(p.get("symbol", "")).strip().upper()
        key = (sym, str(p.get("expiry", "")))
        groups.setdefault(key, []).append(idx)

    total_groups = len(groups)
    print(f"  → {total_groups} (ticker, expiry) pairs to fetch")
    print("─" * 60)

    fetched   = 0
    not_found = 0
    failed    = 0

    for g_num, ((ticker, expiry_str), indices) in enumerate(sorted(groups.items()), 1):
        n = len(indices)
        print(
            f"[{g_num:3d}/{total_groups}]  {ticker:<8s}  {expiry_str}  "
            f"({n} position{'s' if n != 1 else ''}) ...",
            end="",
            flush=True,
        )

        ts   = expiry_ts(expiry_str)
        data = fetch_options(ticker, ts)

        if data is None:
            print()
            failed += n
            time.sleep(FETCH_DELAY)
            continue

        puts, calls = parse_chain(data)

        if not puts and not calls:
            print("  ✗ no chain data", flush=True)
            failed += n
            time.sleep(FETCH_DELAY)
            continue

        group_fetched = 0
        for idx in indices:
            p        = positions[idx]
            is_put   = p.get("type", "put").lower() == "put"
            chain    = puts if is_put else calls
            contract = find_contract(chain, float(p.get("strike", 0)))

            if contract is None:
                not_found += 1
                continue

            price = mid_price(contract)
            if price is None:
                not_found += 1
                continue

            p["original_premium"] = price   # write once, never overwritten again
            group_fetched += 1
            fetched       += 1

        marker = "✓" if group_fetched == n else ("⚠" if group_fetched > 0 else "✗")
        print(f"  {marker} {group_fetched}/{n} fetched", flush=True)
        time.sleep(FETCH_DELAY)

    # ── Persist ───────────────────────────────────────────────────────────────
    POSITIONS_FILE.write_text(json.dumps(positions, indent=2))

    print("─" * 60)
    print(f"✓ New premiums fetched : {fetched}")
    print(f"  Not in chain         : {not_found}  (strike not listed by Yahoo)")
    print(f"  API failures         : {failed}  (all retries exhausted)")
    print(f"✓ Written to           : {POSITIONS_FILE.name}")


if __name__ == "__main__":
    main()
