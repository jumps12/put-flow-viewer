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
import concurrent.futures
import http.cookiejar
import json
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime
from pathlib import Path

# ── Configuration ─────────────────────────────────────────────────────────────

POSITIONS_FILE = Path(__file__).parent / "positions.json"
HEADERS        = {"User-Agent": "Mozilla/5.0"}
TIMEOUT_SECS   = 10    # per-request HTTP timeout (seconds)
MAX_RETRIES    = 2     # attempts before permanently giving up on one fetch
RETRY_DELAY    = 1.0   # pause between retry attempts (seconds)
FETCH_DELAY    = 0.5   # polite pause between distinct fetches (rate limit)
GROUP_TIMEOUT  = 15    # hard wall-clock ceiling per (ticker, expiry) group (seconds)

# ── Google Sheets ──────────────────────────────────────────────────────────────

GS_SPREADSHEET_KEY = '11_KYNpbfuAwsiDehFZwhbQQ9ZPbpj_9i43Bt5CAdnhs'
GS_CREDENTIALS     = Path('/Users/chris/credentials.json')
GS_SCOPE           = [
    'https://spreadsheets.google.com/feeds',
    'https://www.googleapis.com/auth/drive',
]
# (worksheet name, default option type for rows without an explicit type column)
GS_WORKSHEETS = [
    ('Daily Log',  'put'),
    ('Calls Log',  'call'),
]

# ── Yahoo Finance helpers ─────────────────────────────────────────────────────

# Module-level session state — initialised once in main() before any fetches.
_YF_OPENER = None   # urllib opener with cookie jar
_YF_CRUMB  = None   # crumb string required by Yahoo Finance API


def init_yahoo_session() -> bool:
    """
    Visit finance.yahoo.com to get session cookies, then fetch the crumb
    that Yahoo Finance requires on all v7/v8 API calls since mid-2023.
    Returns True on success, False if the crumb could not be obtained.
    """
    global _YF_OPENER, _YF_CRUMB

    jar    = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    opener.addheaders = list(HEADERS.items())

    # Step 1 — establish session cookies via the consent/homepage endpoint.
    for url in (
        'https://fc.yahoo.com',
        'https://finance.yahoo.com',
    ):
        try:
            opener.open(urllib.request.Request(url, headers=HEADERS), timeout=TIMEOUT_SECS)
        except Exception:
            pass   # cookies may still be set even on error

    # Step 2 — exchange session for a crumb.
    for crumb_url in (
        'https://query1.finance.yahoo.com/v1/test/getcrumb',
        'https://query2.finance.yahoo.com/v1/test/getcrumb',
    ):
        try:
            with opener.open(
                urllib.request.Request(crumb_url, headers=HEADERS),
                timeout=TIMEOUT_SECS,
            ) as resp:
                crumb = resp.read().decode('utf-8').strip()
            if crumb and crumb.lower() != 'unauthorized' and len(crumb) < 50:
                _YF_OPENER = opener
                _YF_CRUMB  = crumb
                print(f"Yahoo session   : crumb obtained ({crumb[:6]}…)", flush=True)
                return True
        except Exception:
            pass

    print("WARN: could not obtain Yahoo Finance crumb — API calls may return 401", flush=True)
    return False


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
    qs  = f"date={ts}" + (f"&crumb={urllib.parse.quote(_YF_CRUMB)}" if _YF_CRUMB else "")
    url = f"https://query2.finance.yahoo.com/v7/finance/options/{ticker}?{qs}"
    req = urllib.request.Request(url, headers=HEADERS)

    opener = _YF_OPENER or urllib.request.build_opener()

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with opener.open(req, timeout=TIMEOUT_SECS) as resp:
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


def _raw(v):
    """Extract numeric value from either a {'raw': x} dict or a plain number."""
    if isinstance(v, dict):
        return v.get("raw")
    return v  # already a plain number (or None)


def find_contract(chain: list, strike: float, tol: float = 0.01):
    """Return the first contract whose strike matches within tol, or None."""
    for c in chain:
        c_strike = _raw(c.get("strike"))
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
        c_strike = _raw(c.get("strike"))
        if c_strike is None:
            continue
        diff = abs(float(c_strike) - strike)
        if diff < best_diff:
            best_diff, best, best_strike = diff, c, float(c_strike)
    return best, best_strike


def mid_price(contract: dict):
    """Bid/ask mid-point, falling back to lastPrice. Returns None if unavailable."""
    bid  = _raw(contract.get("bid"))
    ask  = _raw(contract.get("ask"))
    last = _raw(contract.get("lastPrice"))
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


# ── Spread helpers ────────────────────────────────────────────────────────────

def is_spread(strike_str: str) -> bool:
    """Return True if strike contains a slash indicating a spread."""
    return "/" in str(strike_str)


def parse_spread_legs(strike_str: str, option_type: str):
    """
    Parse spread legs from e.g. '140/230C' or '310/300P'.
    Returns (leg1_strike, leg2_strike) as floats, always (lower, higher).
    """
    parts = str(strike_str).replace("C", "").replace("P", "").split("/")
    strikes = sorted([float(p.strip()) for p in parts])
    return strikes[0], strikes[1]


def compute_net_premium(leg1_premium: float, leg2_premium: float, option_type: str) -> tuple:
    """
    Compute net premium and label based on option type.
    PUT spread → net credit (higher leg sold, lower leg bought).
    CALL spread → net debit (lower leg bought, higher leg sold).
    Always returns a positive net value.
    Returns (net_premium, label) e.g. (1.45, 'NET DEBIT') or (2.10, 'NET CREDIT')
    """
    net = abs(leg1_premium - leg2_premium)
    label = "NET CREDIT" if option_type.lower() == "put" else "NET DEBIT"
    return round(net, 4), label


# ── Google Sheets sync ────────────────────────────────────────────────────────

def _gs_connect():
    """Return an authorized gspread client, or None if unavailable."""
    try:
        import gspread
        from oauth2client.service_account import ServiceAccountCredentials
    except ImportError:
        print("WARN: gspread/oauth2client not installed — sheet sync disabled", flush=True)
        return None
    if not GS_CREDENTIALS.exists():
        print(f"WARN: {GS_CREDENTIALS} not found — sheet sync disabled", flush=True)
        return None
    creds = ServiceAccountCredentials.from_json_keyfile_name(str(GS_CREDENTIALS), GS_SCOPE)
    return gspread.authorize(creds)


def _col_idx(headers: list, name: str, fallback: int) -> int:
    """Return 1-based column index matching header name, or fallback."""
    for i, h in enumerate(headers):
        if str(h).strip().lower().replace(' ', '_') == name.lower():
            return i + 1
    return fallback


def _norm_strike(raw) -> str:
    """
    Canonical strike string for key comparison.
    Single-leg: strip trailing C/P suffix, parse as float → "215.0", "72.5", etc.
    Spread:     strip trailing C/P from the whole token → "140/230", "310/300".
    """
    s = str(raw).strip()
    if '/' in s:
        # Spread — strip only the final C/P letter
        return s.rstrip('CPcp')
    # Single leg — strip C/P, convert to float string for consistent format
    bare = s.rstrip('CPcp').strip()
    try:
        return str(float(bare))
    except (ValueError, TypeError):
        return s


def _pos_key(p: dict) -> tuple:
    """Stable 5-tuple identity for deduplication and sheet lookup."""
    return (
        str(p.get('symbol',     '')).strip().upper(),
        _norm_strike(p.get('strike', '')),
        str(p.get('expiry',     '')).strip()[:10],
        str(p.get('trade_date', '')).strip()[:10],
        str(p.get('type',       '')).strip().lower(),
    )


def sync_from_sheet(positions: list):
    """
    1. Reads both Google Sheets worksheets.
    2. Imports rows that are not yet in positions.json.
    3. Registers any sheet row whose original_premium cell is empty so
       write_premiums_to_sheet() can fill it in after fetching.

    Returns (updated_positions, row_refs) where row_refs maps
    pos_key → (worksheet, row_num, col_orig, col_leg1, col_leg2).
    """
    client = _gs_connect()
    if client is None:
        return positions, {}

    try:
        spreadsheet = client.open_by_key(GS_SPREADSHEET_KEY)
    except Exception as e:
        print(f"WARN: cannot open spreadsheet — {e}", flush=True)
        return positions, {}

    existing_keys = {_pos_key(p) for p in positions}
    row_refs  = {}   # pos_key → (ws, row_num, col_orig, col_leg1, col_leg2)
    imported  = 0

    for ws_name, default_type in GS_WORKSHEETS:
        try:
            ws       = spreadsheet.worksheet(ws_name)
            all_rows = ws.get_all_values()
        except Exception as e:
            print(f"WARN: cannot read '{ws_name}' — {e}", flush=True)
            continue

        if not all_rows:
            continue

        # Row 1 is a header if its first cell doesn't parse as a date.
        has_headers   = _parse_date_field(str(all_rows[0][0]).strip()) is None
        raw_hdrs      = [str(h).strip().lower().replace(' ', '_')
                         for h in all_rows[0]] if has_headers else []
        data_rows     = all_rows[1:] if has_headers else all_rows
        hdr_offset    = 1 if has_headers else 0   # rows above data in the sheet

        # Column positions — fall back to insert_mar5.py layout:
        # A=date B=symbol C=strike D=type E=direction F=expiry G=contracts
        # H=original_premium I=leg1_premium J=leg2_premium
        col_date      = _col_idx(raw_hdrs, 'trade_date',       1)
        col_symbol    = _col_idx(raw_hdrs, 'symbol',           2)
        col_strike    = _col_idx(raw_hdrs, 'strike',           3)
        col_type      = _col_idx(raw_hdrs, 'type',             4)
        col_expiry    = _col_idx(raw_hdrs, 'expiry',           6)
        col_contracts = _col_idx(raw_hdrs, 'contracts',        7)
        col_orig      = _col_idx(raw_hdrs, 'original_premium', 8)
        col_leg1      = _col_idx(raw_hdrs, 'leg1_premium',     9)
        col_leg2      = _col_idx(raw_hdrs, 'leg2_premium',    10)

        for i, row in enumerate(data_rows):
            def _cell(c, _row=row):
                return _row[c - 1].strip() if c - 1 < len(_row) else ''

            trade_date_raw = _cell(col_date)
            if not trade_date_raw or _parse_date_field(trade_date_raw) is None:
                continue   # blank or non-date row (sub-header, totals, etc.)

            symbol        = _cell(col_symbol).upper()
            strike        = _cell(col_strike)
            opt_type      = _cell(col_type).lower() or default_type
            expiry_raw    = _cell(col_expiry)
            contracts_raw = _cell(col_contracts)
            orig_in_sheet = _cell(col_orig)

            td_date  = _parse_date_field(trade_date_raw)
            exp_date = _parse_date_field(expiry_raw)
            td  = str(td_date)  if td_date  else trade_date_raw[:10]
            exp = str(exp_date) if exp_date else expiry_raw[:10]

            # Normalize strike the same way _pos_key does so dedup matches correctly.
            key        = (symbol, _norm_strike(strike), exp, td, opt_type)
            gs_row_num = i + hdr_offset + 1   # 1-based sheet row number

            # Register for write-back if the sheet cell is still empty.
            if not _has_premium(orig_in_sheet):
                row_refs[key] = (ws, gs_row_num, col_orig, col_leg1, col_leg2)

            if key in existing_keys:
                continue   # already in positions.json — no need to import

            try:
                contracts = int(float(contracts_raw)) if contracts_raw else 0
            except (ValueError, TypeError):
                contracts = 0

            # Store strike in the same canonical form as existing positions.json rows:
            # single-leg as float (e.g. 215.0), spread as raw string (e.g. "140/230C").
            if '/' in strike:
                stored_strike = strike           # keep spread string as-is
            else:
                bare = strike.rstrip('CPcp').strip()
                try:
                    stored_strike = float(bare)
                except (ValueError, TypeError):
                    stored_strike = strike

            positions.append({
                'symbol':           symbol,
                'strike':           stored_strike,
                'expiry':           exp,
                'trade_date':       td,
                'type':             opt_type,
                'contracts':        contracts,
                'original_premium': None,
                'status':           'ACTIVE',
            })
            existing_keys.add(key)
            imported += 1

    print(f"Sheet import    : {imported} new row(s) added from Google Sheets")
    return positions, row_refs


def write_premiums_to_sheet(positions: list, row_refs: dict) -> None:
    """Update original_premium (and leg premiums for spreads) in the Google Sheet."""
    if not row_refs:
        return

    from collections import defaultdict
    updates: dict = defaultdict(list)   # ws → [(row_num, col, value)]

    for p in positions:
        key = _pos_key(p)
        if key not in row_refs:
            continue
        ws, row_num, col_orig, col_leg1, col_leg2 = row_refs[key]
        if is_spread(p.get('strike')):
            if _has_premium(p.get('net_premium')):
                updates[ws].append((row_num, col_orig, p['net_premium']))
            if _has_premium(p.get('leg1_premium')):
                updates[ws].append((row_num, col_leg1, p['leg1_premium']))
            if _has_premium(p.get('leg2_premium')):
                updates[ws].append((row_num, col_leg2, p['leg2_premium']))
        else:
            if _has_premium(p.get('original_premium')):
                updates[ws].append((row_num, col_orig, p['original_premium']))

    total_written = 0
    for ws, cells in updates.items():
        try:
            import gspread.utils
            batch_data = [
                {
                    'range':  gspread.utils.rowcol_to_a1(row_num, col),
                    'values': [[val]],
                }
                for row_num, col, val in cells
            ]
            ws.batch_update(batch_data, value_input_option='RAW')
            total_written += len(cells)
        except Exception as e:
            print(f"WARN: sheet write failed for '{ws.title}' — {e}", flush=True)

    if total_written:
        print(f"Sheet write-back: {total_written} premium cell(s) updated in Google Sheets")


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    if not POSITIONS_FILE.exists():
        print(f"ERROR: {POSITIONS_FILE} not found.", file=sys.stderr)
        sys.exit(1)

    positions = json.loads(POSITIONS_FILE.read_text())
    today     = date.today()

    # ── Sync new rows from Google Sheets ─────────────────────────────────────
    positions, _gs_row_refs = sync_from_sheet(positions)

    # ── Diagnostic: show how many rows have empty original_premium ────────────
    n_empty = sum(
        1 for p in positions
        if (    is_spread(p.get('strike'))
            and (not _has_premium(p.get('leg1_premium')) or not _has_premium(p.get('leg2_premium'))))
        or (not is_spread(p.get('strike')) and not _has_premium(p.get('original_premium')))
    )
    print(f"Empty premium   : {n_empty} row(s) with missing original_premium — will fetch these")

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

        # ── Skip/fetch decision ───────────────────────────────────────────
        if is_spread(p.get("strike")):
            has_l1 = _has_premium(p.get("leg1_premium"))
            has_l2 = _has_premium(p.get("leg2_premium"))
            if has_l1 and has_l2:
                net, label = compute_net_premium(
                    float(p["leg1_premium"]), float(p["leg2_premium"]),
                    p.get("type", "put"),
                )
                p["net_premium"] = net
                p["net_label"]   = label
            else:
                needs_premium.append(idx)
        else:
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
        write_premiums_to_sheet(positions, _gs_row_refs)
        return

    # ── Initialise Yahoo Finance session (crumb + cookies) ───────────────────
    init_yahoo_session()

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
    missing   = []   # [(ticker, strike, expiry_str)] — need manual entry

    # One persistent thread pool for chain fetches; never blocks the main loop
    # longer than GROUP_TIMEOUT seconds per group.
    _fetch_executor = concurrent.futures.ThreadPoolExecutor(max_workers=4)

    for g_num, ((ticker, expiry_str), indices) in enumerate(sorted(groups.items()), 1):
        n = len(indices)
        print(
            f"[{g_num:3d}/{total_groups}]  {ticker:<8s}  {expiry_str}  "
            f"({n} position{'s' if n != 1 else ''}) ...",
            end="",
            flush=True,
        )

        ts = expiry_ts(expiry_str)

        # Run the chain fetch in a worker thread so the main loop can enforce
        # GROUP_TIMEOUT as a hard ceiling — urllib calls can stall indefinitely
        # even when per-request timeouts are set.
        def _fetch_chain(ticker=ticker, ts=ts):
            _puts, _calls, _data = [], [], None
            for chain_attempt in range(1, MAX_RETRIES + 1):
                _data = fetch_options(ticker, ts)
                if _data is None:
                    break   # HTTP failure already retried inside fetch_options
                _puts, _calls = parse_chain(_data)
                if _puts or _calls:
                    break   # got usable chain data
                if chain_attempt < MAX_RETRIES:
                    print(
                        f"\n    empty chain, retrying in 1s "
                        f"({chain_attempt}/{MAX_RETRIES})...",
                        end="", flush=True,
                    )
                    time.sleep(1.0)
            return _puts, _calls, _data

        try:
            future = _fetch_executor.submit(_fetch_chain)
            puts, calls, data = future.result(timeout=GROUP_TIMEOUT)
        except concurrent.futures.TimeoutError:
            print(f"  ✗ timed out (>{GROUP_TIMEOUT}s)", flush=True)
            for idx in indices:
                p = positions[idx]
                missing.append((ticker, p.get("strike"), expiry_str))
            failed += n
            time.sleep(FETCH_DELAY)
            continue

        if not puts and not calls:
            reason = "API failure" if data is None else "no chain data after retries"
            print(f"  ✗ {reason}", flush=True)
            for idx in indices:
                p = positions[idx]
                missing.append((ticker, p.get("strike"), expiry_str))
            failed += n
            time.sleep(FETCH_DELAY)
            continue

        group_fetched = 0
        for idx in indices:
            p      = positions[idx]
            is_put = p.get("type", "put").lower() == "put"
            chain  = puts if is_put else calls

            if is_spread(p.get("strike")):
                # ── Spread: fetch each leg separately ─────────────────────
                leg1_s, leg2_s = parse_spread_legs(
                    p.get("strike"), p.get("type", "put")
                )

                def _fetch_leg(leg_strike, leg_num):
                    c = find_contract(chain, leg_strike)
                    if c is None:
                        c, actual = find_closest_contract(chain, leg_strike)
                        if c is not None:
                            print(
                                f"\n    ⚠ leg{leg_num} {leg_strike} not listed, "
                                f"using closest ({actual})",
                                end="", flush=True,
                            )
                    return mid_price(c) if c is not None else None

                pr1 = _fetch_leg(leg1_s, 1)
                pr2 = _fetch_leg(leg2_s, 2)

                if pr1 is None or pr2 is None:
                    not_found += 1
                    missing.append((ticker, p.get("strike"), expiry_str))
                    continue

                p["leg1_premium"] = pr1
                p["leg2_premium"] = pr2
                net, label = compute_net_premium(pr1, pr2, p.get("type", "put"))
                p["net_premium"] = net
                p["net_label"]   = label
                group_fetched += 1
                fetched       += 1

            else:
                # ── Single leg: exact then closest-strike fallback ─────────
                strike = float(p.get("strike", 0))
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

    # ── Copy net_premium → original_premium for spreads ──────────────────────
    for p in positions:
        if is_spread(p.get("strike","")) and not _has_premium(p.get("original_premium")) and _has_premium(p.get("net_premium")):
            p["original_premium"] = p["net_premium"]
                group_fetched += 1
                fetched       += 1

        marker = "✓" if group_fetched == n else ("⚠" if group_fetched > 0 else "✗")
        print(f"  {marker} {group_fetched}/{n} fetched", flush=True)
        time.sleep(FETCH_DELAY)

    _fetch_executor.shutdown(wait=False)

    # ── Persist ───────────────────────────────────────────────────────────────
    POSITIONS_FILE.write_text(json.dumps(positions, indent=2))
    write_premiums_to_sheet(positions, _gs_row_refs)

    print("─" * 60)
    print(f"✓ New premiums fetched : {fetched}")
    print(f"  Not in chain         : {not_found}  (closest-strike fallback attempted)")
    print(f"  API failures         : {failed}  (all retries exhausted)")
    print(f"✓ Written to           : {POSITIONS_FILE.name}")

    # ── Manual review block ───────────────────────────────────────────────────
    if missing:
        print()
        print("MISSING PREMIUMS - add manually to sheet:")
        print(f"  {'TICKER':<10}  {'STRIKE':>14}  EXPIRY")
        print(f"  {'──────':<10}  {'──────':>14}  ──────────")
        for m_ticker, m_strike, m_expiry in sorted(missing):
            m_strike_s = str(m_strike) if m_strike is not None else "?"
            if is_spread(m_strike_s):
                strike_fmt = m_strike_s
                suffix = "  (set each leg separately with --set-premium)"
            else:
                try:
                    strike_fmt = f"{float(m_strike_s):.2f}"
                except (ValueError, TypeError):
                    strike_fmt = m_strike_s
                suffix = ""
            print(f"  {m_ticker:<10}  {strike_fmt:>14}  {m_expiry}{suffix}")


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

    matched_single = []
    matched_spread = []
    for p in positions:
        if str(p.get("symbol", "")).strip().upper() != ticker:
            continue
        if _parse_date_field(p.get("expiry")) != input_exp:
            continue
        if type_filter is not None and p.get("type", "put").lower() != type_filter:
            continue
        if is_spread(p.get("strike")):
            matched_spread.append(p)
        else:
            try:
                if abs(float(p.get("strike", "x")) - strike) <= 0.01:
                    matched_single.append(p)
            except (ValueError, TypeError):
                continue

    if not matched_single and not matched_spread:
        print(
            f"ERROR: no position found for  {ticker}  strike={strike}  "
            f"expiry={expiry}"
            + (f"  type={type_filter}" if type_filter else ""),
            file=sys.stderr,
        )
        sys.exit(1)

    strike_int = int(strike) if strike == int(strike) else strike

    for p in matched_single:
        p["original_premium"] = premium
        type_char = "C" if p.get("type", "put").lower() == "call" else "P"
        print(f"Set {ticker} {strike_int}{type_char} {expiry} manual premium = ${premium:.2f}")

    for p in matched_spread:
        leg1_s, leg2_s = parse_spread_legs(p.get("strike"), p.get("type", "put"))
        if abs(strike - leg1_s) <= 0.01:
            p["leg1_premium"] = premium
            leg_label = "leg1"
        elif abs(strike - leg2_s) <= 0.01:
            p["leg2_premium"] = premium
            leg_label = "leg2"
        else:
            print(
                f"ERROR: strike {strike} does not match leg1 ({leg1_s}) or "
                f"leg2 ({leg2_s}) of spread {p.get('strike')}",
                file=sys.stderr,
            )
            sys.exit(1)
        type_char = "C" if p.get("type", "put").lower() == "call" else "P"
        print(f"Set {ticker} {p.get('strike')} {leg_label} {strike_int}{type_char} = ${premium:.2f}")
        if _has_premium(p.get("leg1_premium")) and _has_premium(p.get("leg2_premium")):
            net, label = compute_net_premium(
                float(p["leg1_premium"]), float(p["leg2_premium"]),
                p.get("type", "put"),
            )
            p["net_premium"] = net
            p["net_label"]   = label
            print(f"  → net_premium computed: ${net:.2f} {label}")

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
