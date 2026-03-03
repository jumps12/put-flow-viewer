// ─── Signals Page ─────────────────────────────────────────────────────────────

// ── Date utilities (duplicated from app.js — no shared module needed) ─────────

function parseDate(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdy) {
    let yr = +mdy[3];
    if (yr < 100) yr += 2000;
    return new Date(yr, +mdy[1] - 1, +mdy[2]);
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
  const d = new Date(s);
  if (!isNaN(d)) return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return null;
}

function fmtDate(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtNum(n) {
  return n.toLocaleString();
}

function fmtScore(s) {
  if (s >= 1e6) return (s / 1e6).toFixed(1) + 'M';
  if (s >= 1e3) return Math.round(s / 1e3) + 'K';
  return String(s);
}

function fmtNotional(v) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}

// ── Follow-through helpers ────────────────────────────────────────────────────

function prevTradingDay(date, n = 1) {
  const d = new Date(date);
  let count = 0;
  while (count < n) {
    d.setDate(d.getDate() - 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) count++; // skip Sat/Sun
  }
  return d;
}

function sameDayStr(a, b) {
  if (!a || !b) return false;
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth()    &&
         a.getDate()     === b.getDate();
}

// ── MA computation ────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcSMA(closes, period) {
  if (closes.length < period) return null;
  return closes.slice(-period).reduce((s, v) => s + v, 0) / period;
}

// Aggregate daily bars into weekly closing prices (last close of each Mon–Fri week).
function toWeeklyCloses(dailyBars) {
  const weeks = {};
  for (const { time, close } of dailyBars) {
    const dow = time.getDay();
    const mon = new Date(time);
    mon.setDate(time.getDate() - (dow === 0 ? 6 : dow - 1));
    const key = mon.toISOString().slice(0, 10);
    weeks[key] = close;
  }
  return Object.entries(weeks).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v);
}

// Fetch daily OHLCV and return MA context + adjustment factor for one signal.
// Primary scoring:  21D EMA (price above/below/reclaim)
// Secondary display: 21W EMA (context tag only — no scoring)
// Short-term boost:  8/9D EMA reclaim for calls traded today (unchanged)
async function fetchMAContext(sig, dataToday) {
  const now   = Math.floor(Date.now() / 1000);
  const start = now - 2 * 365 * 24 * 3600; // 2 yr — enough for 21W EMA
  const end   = now + 2 * 24 * 3600;

  const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sig.ticker)}` +
                 `?period1=${start}&period2=${end}&interval=1d`;
  const url = CONFIG.CORS_PROXY + encodeURIComponent(target);
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;

  const json   = await res.json();
  const result = json.chart?.result?.[0];
  if (!result) return null;

  const timestamps = result.timestamp ?? [];
  const q          = result.indicators?.quote?.[0] ?? {};
  const bars       = timestamps
    .map((t, i) => ({ time: new Date(t * 1000), close: q.close?.[i] }))
    .filter(d => d.close != null && isFinite(d.close));

  if (bars.length < 22) return null;

  const closes     = bars.map(d => d.close);
  const lastClose  = closes[closes.length - 1];
  const prevClose  = closes.length > 1 ? closes[closes.length - 2] : null;
  const prev2Close = closes.length > 2 ? closes[closes.length - 3] : null;

  const ema9d  = calcEMA(closes, 9);
  const ema21d = calcEMA(closes, 21);

  // ── PRIMARY: 21D EMA reclaim within the last 2 trading sessions ─────────────
  // "Reclaim today"     — yesterday < EMA, today ≥ EMA
  // "Reclaim yesterday" — two days ago < EMA, yesterday ≥ EMA
  const reclaim21D_today = !!(prevClose  != null && ema21d && prevClose  < ema21d && lastClose >= ema21d);
  const reclaim21D_yest  = !!(prev2Close != null && prevClose != null && ema21d &&
                               prev2Close < ema21d && prevClose >= ema21d);
  const reclaim21D_recent = reclaim21D_today || reclaim21D_yest;

  // ── SHORT-TERM: 8/9D EMA reclaim for calls traded today (unchanged) ─────────
  const reclaim9D  = !!(prevClose != null && ema9d && prevClose < ema9d && lastClose >= ema9d);
  const latestCall = sig.calls.length
    ? sig.calls.reduce((a, b) => (a.tradeDate > b.tradeDate ? a : b))
    : null;
  const callToday  = !!(latestCall && dataToday && sameDayStr(latestCall.tradeDate, dataToday));

  // ── MA adjustment factor ──────────────────────────────────────────────────────
  let maFactor = 1.0;
  const indicators = []; // { text, cls } — shown on signal card

  // 1. Primary scoring — 21D EMA (applies to all positions for this ticker)
  if (ema21d) {
    if (reclaim21D_recent) {
      maFactor *= 2.0; // maximum boost — just reclaimed the 21D EMA
      indicators.push({ text: '⚡ 21 EMA Reclaim', cls: 'ma-strong' });
    } else if (lastClose > ema21d) {
      maFactor *= 1.3; // bullish bias — price above 21D EMA
      // No extra indicator tag: absence of warning implies bullish
    } else {
      maFactor *= 0.75; // bearish bias — price below 21D EMA
      indicators.push({ text: '⚠ Below 21 EMA', cls: 'ma-warn' });
    }
  }

  // 2. Short-term boost — 8/9D EMA reclaim for calls traded today
  if (sig.calls.length && callToday && reclaim9D) {
    maFactor *= 1.5;
    indicators.push({ text: '⚡ 9D reclaim', cls: 'ma-bull' });
  }

  return { maFactor, indicators };
}

// ── Signal analysis ───────────────────────────────────────────────────────────

async function loadSignals() {
  const res = await fetch('./positions.json');
  if (!res.ok) throw new Error('positions.json not found — run fetch_premiums.py first');
  const all = await res.json();

  // ── Follow-through: scan ALL positions (active + expired) ─────────────────
  // Find the most recent trade date in the whole dataset — this is "data today".
  // Using the data's max date (rather than calendar today) keeps weekend runs correct.
  let dataToday = null;
  for (const p of all) {
    const td = parseDate(p.trade_date);
    if (td && (!dataToday || td > dataToday)) dataToday = td;
  }
  const dataDay1 = dataToday ? prevTradingDay(dataToday, 1) : null; // yesterday
  const dataDay2 = dataToday ? prevTradingDay(dataToday, 2) : null; // 2 days ago

  // Per-ticker flags: which reference days did it appear on? What is its earliest trade date?
  const tickerMeta = {}; // ticker → { d0, d1, d2, minTradeDate }
  for (const p of all) {
    const sym = String(p.symbol ?? '').trim().toUpperCase();
    const td  = parseDate(p.trade_date);
    if (!sym || !td) continue;
    if (!tickerMeta[sym]) tickerMeta[sym] = { d0: false, d1: false, d2: false, minTradeDate: td };
    const m = tickerMeta[sym];
    if (td < m.minTradeDate) m.minTradeDate = td;
    if (sameDayStr(td, dataToday)) m.d0 = true;
    if (sameDayStr(td, dataDay1))  m.d1 = true;
    if (sameDayStr(td, dataDay2))  m.d2 = true;
  }

  // Read pre-computed 21D EMA from positions.json (written by fetch_ema.py).
  // Used for display; scoring uses a fresh fetch inside fetchMAContext.
  const posEma = {}; // ticker → ema_21d
  for (const p of all) {
    const sym = String(p.symbol ?? '').trim().toUpperCase();
    if (sym && p.ema_21d != null && !posEma[sym]) posEma[sym] = parseFloat(p.ema_21d);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // Parse and validate all active positions
  const active = all
    .filter(p => {
      const expiry    = parseDate(p.expiry);
      const tradeDate = parseDate(p.trade_date);
      const orig      = parseFloat(p.original_premium ?? p.current_premium ?? p.premium);
      const contracts = parseInt(p.contracts);
      return (
        expiry && tradeDate &&
        expiry >= today &&
        expiry > tradeDate &&
        isFinite(orig) &&
        isFinite(contracts) && contracts > 0
      );
    })
    .map(p => {
      const orig      = parseFloat(p.original_premium ?? p.current_premium ?? p.premium);
      const contracts = parseInt(p.contracts) || 0;
      return {
        type:            (p.type ?? 'put').toLowerCase(),
        strike:          parseFloat(p.strike),
        expiry:          parseDate(p.expiry),
        contracts,
        originalPremium: orig,
        tradeDate:       parseDate(p.trade_date),
        notional:        contracts * orig * 100,
        symbol:          String(p.symbol ?? '').trim().toUpperCase(),
      };
    });

  // Group by ticker
  const byTicker = {};
  for (const p of active) {
    if (!p.symbol) continue;
    if (!byTicker[p.symbol]) byTicker[p.symbol] = { puts: [], calls: [] };
    (p.type === 'call' ? byTicker[p.symbol].calls : byTicker[p.symbol].puts).push(p);
  }

  const totalTracked = Object.keys(byTicker).length;

  // 30-day notional per ticker — used for T1.3 "most active" check
  const notional30d = {};
  for (const [sym, { puts, calls }] of Object.entries(byTicker)) {
    notional30d[sym] = [...puts, ...calls]
      .filter(p => p.tradeDate >= thirtyDaysAgo)
      .reduce((s, p) => s + p.notional, 0);
  }
  const maxNotional30d = Math.max(0, ...Object.values(notional30d));

  const signals = [];

  for (const [ticker, { puts, calls }] of Object.entries(byTicker)) {
    const allPos       = [...puts, ...calls];
    const totalNotional = allPos.reduce((s, p) => s + p.notional, 0);
    const putNotional   = puts.reduce((s, p) => s + p.notional, 0);
    const callNotional  = calls.reduce((s, p) => s + p.notional, 0);

    const tradeDateKeys = new Set(allPos.map(p => p.tradeDate?.toDateString()).filter(Boolean));
    const daysActive    = tradeDateKeys.size;

    const tradeDates = allPos.map(p => p.tradeDate).filter(Boolean);
    const expiries   = allPos.map(p => p.expiry).filter(Boolean);
    const minTradeDate = new Date(Math.min(...tradeDates));
    const maxExpiry    = new Date(Math.max(...expiries));

    // ── TIER 1 — any single trigger → STRONG ─────────────────
    const tier1 = [];

    // T1.1: Same day has both puts AND calls
    const putDayKeys  = new Set(puts.map(p => p.tradeDate?.toDateString()).filter(Boolean));
    const callDayKeys = new Set(calls.map(p => p.tradeDate?.toDateString()).filter(Boolean));
    if ([...putDayKeys].some(d => callDayKeys.has(d)))
      tier1.push('same_day_both');

    // T1.2: Any single day's total notional > $5M
    const dailyNotional = {};
    for (const p of allPos) {
      const k = p.tradeDate?.toDateString();
      if (k) dailyNotional[k] = (dailyNotional[k] || 0) + p.notional;
    }
    if (Object.values(dailyNotional).some(n => n > 5_000_000))
      tier1.push('daily_notional_5m');

    // T1.3: Most active ticker over rolling 30-day window
    if (maxNotional30d > 0 && notional30d[ticker] === maxNotional30d)
      tier1.push('most_active_30d');

    // T1.4: Calls rolled to progressively higher strikes over time
    if (calls.length >= 2) {
      const sorted = [...calls].sort((a, b) => a.tradeDate - b.tradeDate);
      if (sorted.some((c, i) => i > 0 && c.strike > sorted[i - 1].strike))
        tier1.push('rolled_higher');
    }

    // T1.5: Both types present AND active 4+ distinct days
    if (puts.length && calls.length && daysActive >= 4)
      tier1.push('both_types_4days');

    // ── TIER 2 — needs 2+ triggers → NOTABLE ─────────────────
    const tier2 = [];

    // T2.1: Put + call within any 5-day window
    let has5day = false;
    outer5: for (const p of puts) {
      for (const c of calls) {
        if (Math.abs(p.tradeDate - c.tradeDate) <= 5 * 86_400_000) { has5day = true; break outer5; }
      }
    }
    if (has5day) tier2.push('5day_confluence');

    // T2.2: Flow on 3+ distinct days
    if (daysActive >= 3) tier2.push('repeat_3days');

    // T2.3: High premium (put >$5 or call >$3)
    if (puts.some(p => p.originalPremium > 5) || calls.some(p => p.originalPremium > 3))
      tier2.push('high_premium');

    // T2.4: Any single position notional > $1M
    if (allPos.some(p => p.notional > 1_000_000))
      tier2.push('large_single_notional');

    // T2.5: Active 2+ distinct days
    if (daysActive >= 2) tier2.push('active_2days');

    // T2.6: Risk reversal — put sold + call bought in same expiry month
    let hasRR = false;
    outerRR: for (const p of puts) {
      for (const c of calls) {
        if (p.expiry && c.expiry &&
            p.expiry.getFullYear() === c.expiry.getFullYear() &&
            p.expiry.getMonth()    === c.expiry.getMonth()) { hasRR = true; break outerRR; }
      }
    }
    if (hasRR) tier2.push('risk_reversal');

    // T2.7: Short-dated catalyst — expiry within 45 days of trade date
    if (allPos.some(p => p.expiry && p.tradeDate &&
        Math.floor((p.expiry - p.tradeDate) / 86_400_000) <= 45))
      tier2.push('catalyst_expiry');

    // ── DEPRIORITIZE ──────────────────────────────────────────
    const dep = [];
    if (daysActive <= 1)                                 dep.push('one_day');
    if (allPos.every(p => p.originalPremium < 0.50))    dep.push('all_cheap');
    if (puts.length === 0)                               dep.push('no_puts');
    if (totalNotional < 100_000)                         dep.push('low_notional');

    // ── Tier determination ────────────────────────────────────
    const t1 = tier1.length, t2 = tier2.length, d = dep.length;
    let badge = null;

    if      (t1 >= 1 && d === 0)              badge = 'STRONG';
    else if (t1 >= 1 && d === 1 && t2 >= 1)  badge = 'STRONG';
    else if (t2 >= 2 && d === 0)              badge = 'NOTABLE';
    else if (t2 >= 3 && d <= 1)              badge = 'NOTABLE';
    else if (t2 >= 2 && d === 1)             badge = 'NOTABLE';

    // ── UNUSUAL ACTIVITY — first-time ticker with significant notional ─────────
    const meta = tickerMeta[ticker] ?? {};
    const isFirstTime = sameDayStr(meta.minTradeDate, dataToday);
    if (!badge && isFirstTime && totalNotional > 500_000) badge = 'UNUSUAL';

    if (!badge) continue;

    // ── Follow-through multiplier ─────────────────────────────────────────────
    // 2x:    appeared yesterday (d1) AND today (d0) — single strongest signal
    // 1.75x: appeared on 2 of the last 3 trading days (but not the 2x case)
    const followThrough = !!(meta.d0 && meta.d1);
    const countLast3    = (meta.d0 ? 1 : 0) + (meta.d1 ? 1 : 0) + (meta.d2 ? 1 : 0);
    const ft175         = !followThrough && countLast3 >= 2;
    const multiplier    = followThrough ? 2.0 : ft175 ? 1.75 : 1.0;

    signals.push({
      ticker, badge,
      totalNotional, putNotional, callNotional,
      puts, calls,
      daysActive, minTradeDate, maxExpiry,
      tier1Triggers: tier1, tier2Triggers: tier2, deprioritize: dep,
      multiplier, followThrough, isFirstTime,
      ema21d: posEma[ticker] ?? null, // stored by fetch_ema.py — for display
    });
  }

  // ── Sort helper (called twice: pre-MA and post-MA) ───────────────────────────
  const sortByConviction = arr => arr.sort((a, b) => {
    const ftRank = s => s.multiplier >= 2 ? 2 : s.multiplier >= 1.75 ? 1 : 0;
    const ftDiff = ftRank(b) - ftRank(a);
    if (ftDiff !== 0) return ftDiff;
    const tierOrder = { STRONG: 3, NOTABLE: 2, UNUSUAL: 1 };
    const tDiff = (tierOrder[b.badge] || 0) - (tierOrder[a.badge] || 0);
    if (tDiff !== 0) return tDiff;
    return b.totalNotional - a.totalNotional;
  });

  // Pre-sort → pick top candidates for MA enrichment (avoids fetching unlimited tickers)
  sortByConviction(signals);

  // ── MA context enrichment ─────────────────────────────────────────────────
  // Fetch price data in parallel for the top candidates; update multiplier in-place.
  const maWindow = signals.slice(0, Math.min(signals.length, 10));
  await Promise.all(maWindow.map(async sig => {
    const ma = await fetchMAContext(sig, dataToday).catch(() => null);
    sig.maContext = ma ?? null;
    if (ma) sig.multiplier *= ma.maFactor;
  }));

  // Final sort after MA adjustment, then cap at 5
  sortByConviction(signals);

  const qualified = signals.length;
  const capped    = signals.slice(0, 5);
  capped._qualified    = qualified;
  capped._totalTracked = totalTracked;
  return capped;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderSignals(signals) {
  const grid = document.getElementById('signals-grid');

  if (!signals.length) {
    grid.innerHTML = `
      <div class="sig-empty">
        <div class="sig-empty-icon">◈</div>
        <div>No signals found</div>
        <div class="sig-empty-sub">Signals appear when a ticker meets STRONG or NOTABLE conviction criteria based on notional value, flow frequency, and premium quality.</div>
      </div>`;
    return;
  }

  const strongN   = signals.filter(s => s.badge === 'STRONG').length;
  const notableN  = signals.filter(s => s.badge === 'NOTABLE').length;
  const unusualN  = signals.filter(s => s.badge === 'UNUSUAL').length;
  const ftN       = signals.filter(s => s.followThrough).length;
  const qualified = signals._qualified    ?? signals.length;
  const tracked   = signals._totalTracked ?? qualified;
  const dateStr   = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();
  const summary   = document.getElementById('sig-summary');
  summary.innerHTML = `
    <span class="sum-pill bull-key">TOP SIGNALS · ${dateStr} · ${qualified} tickers qualified out of ${tracked} tracked</span>
    ${ftN      ? `<span class="sum-pill follow-thru">${ftN} FOLLOW-THROUGH</span>` : ''}
    ${strongN  ? `<span class="sum-pill strong">${strongN} STRONG</span>`          : ''}
    ${notableN ? `<span class="sum-pill notable">${notableN} NOTABLE</span>`       : ''}
    ${unusualN ? `<span class="sum-pill unusual">${unusualN} UNUSUAL</span>`       : ''}
  `;
  summary.hidden = false;

  grid.innerHTML = signals.map(s => {
    const badgeCls  = s.badge === 'STRONG'  ? 'badge-strong'
                    : s.badge === 'NOTABLE' ? 'badge-notable'
                    : 'badge-unusual';
    const dateRange = `${fmtDate(s.minTradeDate)} → ${fmtDate(s.maxExpiry)}`;

    const tags = [
      s.followThrough ? `<span class="sig-tag tag-ft">FOLLOW-THROUGH</span>` : '',
      s.isFirstTime   ? `<span class="sig-tag tag-new">NEW</span>`           : '',
    ].filter(Boolean).join('');

    const hasBoth = s.puts.length > 0 && s.calls.length > 0;
    const stratLine = hasBoth
      ? `PUT SOLD <span class="card-strat-bull">▲ BULLISH</span> + CALL BOUGHT`
      : s.puts.length
        ? `PUT SOLD <span class="card-strat-bull">▲ BULLISH</span>`
        : `CALL BOUGHT <span class="card-strat-bull">▲ BULLISH</span>`;

    const maInds = s.maContext?.indicators ?? [];
    const maHtml = maInds.length
      ? `<div class="card-ma">${maInds.map(i => `<span class="ma-tag ${i.cls}">${i.text}</span>`).join('')}</div>`
      : '';
    const emaHtml = s.ema21d != null
      ? `<div class="card-ema">21D EMA <span class="card-ema-val">$${s.ema21d.toFixed(2)}</span></div>`
      : '';

    return `
      <div class="signal-card">
        <div class="card-top">
          <span class="card-ticker">${s.ticker}</span>
          <span class="card-badge ${badgeCls}">${s.badge}</span>
        </div>

        ${tags ? `<div class="card-tags">${tags}</div>` : ''}

        <div class="card-strat">${stratLine}</div>

        ${maHtml}

        <div class="card-stats">
          <div class="stat">
            <div class="stat-val" style="color:var(--up)">${fmtNotional(s.totalNotional)}</div>
            <div class="stat-lbl">Total Notional</div>
          </div>
          <div class="stat-divider"></div>
          <div class="stat">
            <div class="stat-val">${s.daysActive}</div>
            <div class="stat-lbl">Days active</div>
          </div>
        </div>

        <div class="card-footer">
          ${emaHtml}
          <div class="card-dates">${dateRange}</div>
          <div class="card-row2">
            <a class="card-link" href="#" data-ticker="${s.ticker}">View chart →</a>
          </div>
        </div>
      </div>`;
  }).join('');
}

function setSigStatus(msg, cls) {
  const el = document.getElementById('sig-status');
  el.textContent = msg;
  el.className   = cls;
  el.hidden      = !msg;
}

// ── Entry point ───────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const signals = await loadSignals();
    renderSignals(signals);
    setSigStatus('', '');
  } catch (err) {
    document.getElementById('signals-grid').innerHTML = '';
    setSigStatus(err.message, 'error');
    console.error(err);
  }

  document.getElementById('signals-grid').addEventListener('click', e => {
    const link = e.target.closest('a[data-ticker]');
    if (!link) return;
    e.preventDefault();
    load(link.dataset.ticker);
    document.getElementById('sec01-body').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});
