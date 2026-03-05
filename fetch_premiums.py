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
    python3 fetch_premiums.py --set-premium ABBV 200P 2026-05-15 2.54
"""

import argparse
import calendar
import json
import re
import socket
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime
from pathlib import Path

# ── Configuration ─────────────────────────────────────────────────────────────

POSITIONS_FILE = Path(__file__).parent / "positions.json"
FAILURES_FILE  = Path(__file__).parent / "fetch_failures.json"
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


def find_closest_contract(chain: list, strike: float):
    """
    Fallback: return the contract with the strike nearest to target.
    Used when the exact strike is not listed in Yahoo's chain.
    Returns (contract, actual_strike) or (None, None) if chain is empty.
    """
    best, best_diff, best_strike = None, float("inf"), None
    for c in chain:
        c_strike = (c.get("strike") or {}).get("raw")
        if c_strike is None:
            continue
        diff = abs(float(c_strike) - strike)
        if diff < best_diff:
            best_diff, best, best_strike = diff, c, float(c_strike)
    return best, best_strike


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


# ── Persistent failure tracking ───────────────────────────────────────────────

def load_failures() -> set:
    """Load the set of (ticker, expiry) keys that have permanently failed before."""
    if not FAILURES_FILE.exists():
        return set()
    try:
        data = json.loads(FAILURES_FILE.read_text())
        return set(tuple(k) for k in data)
    except Exception:
        return set()


def save_failure(key: tuple, existing: set) -> None:
    """Append a new (ticker, expiry) failure key and persist to disk."""
    existing.add(key)
    FAILURES_FILE.write_text(json.dumps(sorted(existing), indent=2))


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

        # ── Skip/fetch decision (lines 161-164) ───────────────────────────
        # If original_premium has ANY non-zero non-empty value → skip entirely.
        # Only add to needs_premium if the value is missing, None, or zero.
        if not _has_premium(p.get("original_premium")):
            needs_premium.append(idx)

    n_skip = len(positions) - len(needs_premium)
    print(f"Will fetch {len(needs_premium)} positions, skipping {n_skip}")
    print(f"positions.json  : {len(positions)} rows  ({n_active} active, {n_expired} expired)")
    print(f"Status updated  : all rows")

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
    permanent_failures = load_failures()
    if permanent_failures:
        print(f"  → {len(permanent_failures)} (ticker, expiry) pairs permanently skipped (prior fetch failures)")
    print(f"  → {total_groups} (ticker, expiry) pairs to fetch")
    print("─" * 60)

    fetched   = 0
    not_found = 0
    failed    = 0
    missing   = []   # [(ticker, strike, expiry_str)] — need manual entry

    for g_num, ((ticker, expiry_str), indices) in enumerate(sorted(groups.items()), 1):
        n = len(indices)
        if (ticker, expiry_str) in permanent_failures:
            print(
                f"[{g_num:3d}/{total_groups}]  {ticker:<8s}  {expiry_str}  "
                f"({n} position{'s' if n != 1 else ''}) ...  ⊘ skipped (prior failure)",
                flush=True,
            )
            failed += n
            for idx in indices:
                p = positions[idx]
                missing.append((ticker, p.get("strike"), expiry_str))
            continue
        print(
            f"[{g_num:3d}/{total_groups}]  {ticker:<8s}  {expiry_str}  "
            f"({n} position{'s' if n != 1 else ''}) ...",
            end="",
            flush=True,
        )

        ts = expiry_ts(expiry_str)

        # Retry the chain fetch up to MAX_RETRIES times with a 2-second pause
        # when Yahoo returns an empty response (distinct from HTTP-level retries
        # that happen inside fetch_options itself).
        puts, calls, data = [], [], None
        for chain_attempt in range(1, MAX_RETRIES + 1):
            data = fetch_options(ticker, ts)
            if data is None:
                break   # HTTP failure already retried inside fetch_options
            puts, calls = parse_chain(data)
            if puts or calls:
                break   # got usable chain data
            if chain_attempt < MAX_RETRIES:
                print(
                    f"\n    empty chain, retrying in 2s "
                    f"({chain_attempt}/{MAX_RETRIES})...",
                    end="", flush=True,
                )
                time.sleep(2.0)

        if not puts and not calls:
            reason = "API failure" if data is None else "no chain data after retries"
            print(f"  ✗ {reason}", flush=True)
            save_failure((ticker, expiry_str), permanent_failures)
            for idx in indices:
                p = positions[idx]
                missing.append((ticker, p.get("strike"), expiry_str))
            failed += n
            time.sleep(FETCH_DELAY)
            continue

        group_fetched = 0
        for idx in indices:
            p        = positions[idx]
            is_put   = p.get("type", "put").lower() == "put"
            chain    = puts if is_put else calls
            strike   = float(p.get("strike", 0))

            # Try exact strike first; fall back to closest listed strike.
            contract = find_contract(chain, strike)
            used_strike = strike
            if contract is None:
                contract, used_strike = find_closest_contract(chain, strike)
                if contract is not None:
                    print(
                        f"\n    ⚠ {strike} not listed, using closest "
                        f"({used_strike})",
                        end="", flush=True,
                    )

            if contract is None:
                not_found += 1
                missing.append((ticker, p.get("strike"), expiry_str))
                continue

            price = mid_price(contract)
            if price is None:
                not_found += 1
                missing.append((ticker, p.get("strike"), expiry_str))
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
    print(f"  Not in chain         : {not_found}  (closest-strike fallback attempted)")
    print(f"  API failures         : {failed}  (all retries exhausted)")
    print(f"✓ Written to           : {POSITIONS_FILE.name}")

    # ── Manual review block ───────────────────────────────────────────────────
    if missing:
        print()
        print("MISSING PREMIUMS - add manually to sheet:")
        print(f"  {'TICKER':<10}  {'STRIKE':>8}  EXPIRY")
        print(f"  {'──────':<10}  {'──────':>8}  ──────────")
        for m_ticker, m_strike, m_expiry in sorted(missing):
            strike_str = f"{float(m_strike):.2f}" if m_strike is not None else "?"
            print(f"  {m_ticker:<10}  {strike_str:>8}  {m_expiry}")


# ── --set-premium command ─────────────────────────────────────────────────────

def set_premium_cmd(ticker_arg: str, strike_arg: str, expiry_arg: str, premium_arg: str) -> None:
    """
    Write a manual original_premium directly into positions.json.
    Matches on ticker + strike (numeric) + expiry + optional type from P/C suffix.
    """
    ticker = ticker_arg.strip().upper()
    expiry = expiry_arg.strip()

    # Parse premium — accept "$2.54" or "2.54"
    try:
        premium = float(premium_arg.replace("$", "").strip())
        if premium <= 0:
            raise ValueError
    except ValueError:
        print(f"ERROR: invalid premium '{premium_arg}' — must be a positive number.",
              file=sys.stderr)
        sys.exit(1)

    # Parse strike — accept "200P", "200C", "200.5P", bare "200"
    m = re.match(r"^([\d.]+)([PC]?)$", strike_arg.strip().upper())
    if not m:
        print(f"ERROR: invalid strike '{strike_arg}' — expected e.g. 200P, 200C, 200.5P, 200",
              file=sys.stderr)
        sys.exit(1)
    strike      = float(m.group(1))
    type_filter = {"P": "put", "C": "call"}.get(m.group(2))  # None = match both

    if not POSITIONS_FILE.exists():
        print(f"ERROR: {POSITIONS_FILE} not found.", file=sys.stderr)
        sys.exit(1)

    positions = json.loads(POSITIONS_FILE.read_text())

    # Normalise the input expiry so YYYY-MM-DD and MM/DD/YYYY both work
    input_exp = _parse_date_field(expiry)
    if input_exp is None:
        print(f"ERROR: invalid expiry '{expiry}' — expected YYYY-MM-DD or MM/DD/YYYY",
              file=sys.stderr)
        sys.exit(1)

    matched = []
    for p in positions:
        if str(p.get("symbol", "")).strip().upper() != ticker:
            continue
        try:
            if abs(float(p.get("strike", "x")) - strike) > 0.01:
                continue
        except (ValueError, TypeError):
            continue
        if _parse_date_field(p.get("expiry")) != input_exp:
            continue
        if type_filter is not None and p.get("type", "put").lower() != type_filter:
            continue
        matched.append(p)

    if not matched:
        print(
            f"ERROR: no position found for  {ticker}  strike={strike}  "
            f"expiry={expiry}"
            + (f"  type={type_filter}" if type_filter else ""),
            file=sys.stderr,
        )
        sys.exit(1)

    strike_int = int(strike) if strike == int(strike) else strike
    for p in matched:
        p["original_premium"] = premium
        type_char = "C" if p.get("type", "put").lower() == "call" else "P"
        print(f"Set {ticker} {strike_int}{type_char} {expiry} manual premium = ${premium:.2f}")

    POSITIONS_FILE.write_text(json.dumps(positions, indent=2))


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Stamp status + fill original_premium for positions.json.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python3 fetch_premiums.py\n"
            "  python3 fetch_premiums.py --set-premium ABBV 200P 2026-05-15 2.54\n"
            "  python3 fetch_premiums.py --set-premium SPY  450C 2026-06-20 8.00\n"
        ),
    )
    parser.add_argument(
        "--set-premium",
        nargs=4,
        metavar=("TICKER", "STRIKE", "EXPIRY", "PREMIUM"),
        help="Write a manual premium (e.g. --set-premium ABBV 200P 2026-05-15 2.54)",
    )
    args = parser.parse_args()

    if args.set_premium:
        set_premium_cmd(*args.set_premium)
    else:
        main()
