#!/usr/bin/env python3
"""
fetch_ema.py — Enrich positions.json with per-ticker 21-day EMA and current price.

Run this after editing positions.json to keep EMA values current:
    python3 fetch_ema.py

Adds / updates two fields on every position row:
    ema_21d  — 21-day EMA of closing prices (float, 2 d.p.)
    price    — most recent closing price      (float, 2 d.p.)

The web app reads these fields to display MA context on signal cards without
needing an extra real-time price fetch.
"""

import json
import time
import urllib.request
import urllib.error
from pathlib import Path

POSITIONS_FILE = Path(__file__).parent / "positions.json"

YAHOO_URL = (
    "https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
    "?period1={p1}&period2={p2}&interval=1d"
)
HEADERS = {"User-Agent": "Mozilla/5.0"}


def fetch_closes(ticker: str, days: int = 60):
    """Return (list_of_closes, last_close) for the last `days` calendar days."""
    now = int(time.time())
    url = YAHOO_URL.format(ticker=ticker, p1=now - days * 86_400, p2=now + 86_400)
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"  WARN {ticker}: HTTP {e.code}")
        return None, None
    except Exception as e:
        print(f"  WARN {ticker}: {e}")
        return None, None

    result = ((data.get("chart") or {}).get("result") or [None])[0]
    if not result:
        return None, None

    timestamps = result.get("timestamp") or []
    raw_closes = ((result.get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
    closes = [c for c in raw_closes if c is not None]

    last = closes[-1] if closes else None
    return closes, last


def calc_ema(closes: list, period: int = 21):
    """EMA seeded with SMA of first `period` values. Returns None if insufficient data."""
    if len(closes) < period:
        return None
    k = 2.0 / (period + 1)
    ema = sum(closes[:period]) / period
    for c in closes[period:]:
        ema = c * k + ema * (1.0 - k)
    return round(ema, 2)


def main():
    if not POSITIONS_FILE.exists():
        print(f"ERROR: {POSITIONS_FILE} not found — run from the put-flow-viewer directory.")
        return

    positions = json.loads(POSITIONS_FILE.read_text())

    # Collect unique, non-empty tickers
    tickers = sorted({
        str(p.get("symbol", "")).strip().upper()
        for p in positions
        if p.get("symbol")
    })
    print(f"Fetching 21D EMA for {len(tickers)} ticker(s): {', '.join(tickers)}\n")

    ema_map   = {}   # ticker → ema_21d
    price_map = {}   # ticker → current price

    for ticker in tickers:
        closes, last_price = fetch_closes(ticker, days=60)
        if closes and len(closes) >= 21:
            ema = calc_ema(closes, 21)
            ema_map[ticker]   = ema
            price_map[ticker] = round(last_price, 2) if last_price else None
            arrow = "↑" if last_price and ema and last_price > ema else "↓"
            print(f"  {ticker:8s}  price={last_price:>9.2f}  21D EMA={ema:>9.2f}  {arrow}")
        else:
            count = len(closes) if closes else 0
            print(f"  {ticker:8s}  insufficient data ({count} bars)")
        time.sleep(0.35)   # polite delay — avoid Yahoo rate-limiting

    # Write ema_21d and price back into each position row
    updated = 0
    for p in positions:
        sym = str(p.get("symbol", "")).strip().upper()
        if sym in ema_map:
            p["ema_21d"] = ema_map[sym]
            p["price"]   = price_map.get(sym)
            updated += 1

    POSITIONS_FILE.write_text(json.dumps(positions, indent=2))
    print(f"\n✓ Updated {updated} row(s) in {POSITIONS_FILE.name}")


if __name__ == "__main__":
    main()
