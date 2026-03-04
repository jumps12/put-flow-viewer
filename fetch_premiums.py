#!/usr/bin/env python3
"""
fetch_premiums.py — Refresh current_premium for all active positions in positions.json.

Fetches live option mid-prices from Yahoo Finance and writes results back.
Also fills in original_premium when it is null or zero.

Skip rules:
  • Expired positions (expiry < today)                              — always skipped
  • original_premium already set AND expiry within 7 days          — skipped (no value updating near-expiry)

Timeout / reliability:
  • 10-second timeout per HTTP call
  • 3 retries with 1-second pause between each
  • 0.5-second polite delay between ticker fetches
  • On permanent failure: log clearly, continue — never hangs

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

POSITIONS_FILE   = Path(__file__).parent / "positions.json"
HEADERS          = {"User-Agent": "Mozilla/5.0"}
TIMEOUT_SECS     = 10    # per-request HTTP timeout (seconds)
MAX_RETRIES      = 3     # attempts before permanently giving up on one fetch
RETRY_DELAY      = 1.0   # pause between retry attempts (seconds)
FETCH_DELAY      = 0.5   # polite pause between distinct fetches (rate limit)
NEAR_EXPIRY_DAYS = 7     # skip positions expiring in fewer than this many days
                         # (only when original_premium is already set)

# ── Yahoo Finance helpers ─────────────────────────────────────────────────────

def expiry_ts(expiry_str: str) -> int:
    """Convert 'YYYY-MM-DD' → midnight UTC Unix timestamp (what Yahoo expects)."""
    d = datetime.strptime(expiry_str, "%Y-%m-%d")
    return calendar.timegm(d.timetuple())


def fetch_options(ticker: str, ts: int):
    """
    Fetch the Yahoo Finance options chain for (ticker, expiry_ts).

    Returns the parsed JSON dict on success, or None after MAX_RETRIES failures.
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
            # URLError wraps socket.timeout for connect/read timeouts
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
    print(
        f"\n    attempt {attempt}/{MAX_RETRIES}: {reason}",
        end="",
        flush=True,
    )


def parse_chain(data: dict):
    """
    Extract puts and calls from Yahoo's option chain response.
    Returns (puts_list, calls_list); both empty on parse failure.
    """
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
    """
    Return the bid/ask mid-point as the 'fair' premium.
    Falls back to lastPrice when bid/ask are absent or zero.
    Returns None if no valid price is found.
    """
    bid  = (contract.get("bid")       or {}).get("raw")
    ask  = (contract.get("ask")       or {}).get("raw")
    last = (contract.get("lastPrice") or {}).get("raw")

    if bid and ask and float(bid) > 0 and float(ask) > 0:
        return round((float(bid) + float(ask)) / 2, 4)
    if last and float(last) > 0:
        return round(float(last), 4)
    return None


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    if not POSITIONS_FILE.exists():
        print(f"ERROR: {POSITIONS_FILE} not found.", file=sys.stderr)
        sys.exit(1)

    positions = json.loads(POSITIONS_FILE.read_text())
    today     = date.today()

    # ── Classify positions ────────────────────────────────────────────────────
    to_update    = []   # indices of positions we will fetch
    skip_expired = 0
    skip_near    = 0

    for idx, p in enumerate(positions):
        try:
            exp_date = datetime.strptime(p["expiry"], "%Y-%m-%d").date()
            dte = (exp_date - today).days
        except (KeyError, ValueError):
            to_update.append(idx)   # can't parse expiry — attempt anyway
            continue

        if dte < 0:
            skip_expired += 1
            continue

        orig     = p.get("original_premium")
        has_orig = orig is not None and float(orig) > 0
        if has_orig and dte < NEAR_EXPIRY_DAYS:
            skip_near += 1
            continue

        to_update.append(idx)

    # ── Group by (ticker, expiry) — one API call per pair ────────────────────
    groups: dict = {}
    for idx in to_update:
        p   = positions[idx]
        sym = str(p.get("symbol", "")).strip().upper()
        key = (sym, str(p.get("expiry", "")))
        groups.setdefault(key, []).append(idx)

    total_groups = len(groups)

    print(f"positions.json        : {len(positions)} rows")
    print(f"To fetch              : {len(to_update)} positions  /  {total_groups} (ticker, expiry) pairs")
    print(f"Skipped — expired     : {skip_expired}")
    print(f"Skipped — near-expiry : {skip_near}  (original_premium set, DTE < {NEAR_EXPIRY_DAYS})")
    print("─" * 60)

    updated   = 0
    not_found = 0
    failed    = 0

    for g_num, ((ticker, expiry_str), indices) in enumerate(sorted(groups.items()), 1):
        n = len(indices)

        # Progress line — printed before the fetch so any retry messages appear inline
        print(
            f"[{g_num:3d}/{total_groups}]  {ticker:<8s}  {expiry_str}  "
            f"({n} position{'s' if n != 1 else ''}) ...",
            end="",
            flush=True,
        )

        ts   = expiry_ts(expiry_str)
        data = fetch_options(ticker, ts)

        if data is None:
            # fetch_options already printed the failure reason
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

        group_updated = 0
        for idx in indices:
            p         = positions[idx]
            is_put    = p.get("type", "put").lower() == "put"
            chain     = puts if is_put else calls
            contract  = find_contract(chain, float(p.get("strike", 0)))

            if contract is None:
                not_found += 1
                continue

            price = mid_price(contract)
            if price is None:
                not_found += 1
                continue

            p["current_premium"] = price

            # Back-fill original_premium if it was never set
            orig = p.get("original_premium")
            if orig is None or float(orig) == 0:
                p["original_premium"] = price

            group_updated += 1
            updated       += 1

        if group_updated == n:
            marker = "✓"
        elif group_updated > 0:
            marker = "⚠"
        else:
            marker = "✗"

        print(f"  {marker} {group_updated}/{n} updated", flush=True)
        time.sleep(FETCH_DELAY)

    # ── Persist results ───────────────────────────────────────────────────────
    POSITIONS_FILE.write_text(json.dumps(positions, indent=2))

    print("─" * 60)
    print(f"✓ Premiums updated  : {updated}")
    print(f"  Not in chain      : {not_found}  (strike not listed by Yahoo)")
    print(f"  API failures      : {failed}  (all retries exhausted)")
    print(f"✓ Written to        : {POSITIONS_FILE.name}")


if __name__ == "__main__":
    main()
