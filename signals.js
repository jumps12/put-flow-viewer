// ─── Signals Page ─────────────────────────────────────────────────────────────

// ── Date utilities ─────────────────────────────────────────────────────────────

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

function fmtNotional(v) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}

// ── Follow-through helpers ─────────────────────────────────────────────────────

function prevTradingDay(date, n = 1) {
  const d = new Date(date);
  let count = 0;
  while (count < n) {
    d.setDate(d.getDate() - 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) count++;
  }
  return d;
}

function sameDayStr(a, b) {
  if (!a || !b) return false;
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth()    &&
         a.getDate()     === b.getDate();
}

// ── MA computation ─────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

// ── MA context fetch ───────────────────────────────────────────────────────────
// 21D EMA is the primary bull/bear line.
//   Reclaim within 2 sessions → +50% boost  · maStatus = 'reclaim'
//   Price above EMA           → +20% boost  · maStatus = 'above'
//   Price below EMA           → −20% penalty · maStatus = 'below'

async function fetchMAContext(sig) {
  const now   = Math.floor(Date.now() / 1000);
  const start = now - 90 * 24 * 3600;  // 90 days is enough for a reliable 21D EMA
  const end   = now + 2  * 24 * 3600;

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

  const ema21d = calcEMA(closes, 21);
  if (!ema21d) return null;

  // Reclaim = crossed above EMA within the last 2 sessions
  const reclaim_today = !!(prevClose  != null && prevClose  < ema21d && lastClose >= ema21d);
  const reclaim_yest  = !!(prev2Close != null && prev2Close < ema21d && prevClose != null && prevClose >= ema21d);
  const reclaim       = reclaim_today || reclaim_yest;

  let maFactor = 1.0;
  let maStatus = 'neutral';
  const indicators = [];

  if (reclaim) {
    maFactor = 1.5;
    maStatus = 'reclaim';
    indicators.push({ text: '⚡ RECLAIM', cls: 'ma-strong' });
  } else if (lastClose > ema21d) {
    maFactor = 1.2;
    maStatus = 'above';
    // green dot on card — no extra text tag needed
  } else {
    maFactor = 0.8;
    maStatus = 'below';
    indicators.push({ text: '⚠ Below 21 EMA', cls: 'ma-warn' });
  }

  return { maFactor, maStatus, indicators };
}

// ── Signal analysis ────────────────────────────────────────────────────────────

async function loadSignals() {
  const res = await fetch('./positions.json');
  if (!res.ok) throw new Error('positions.json not found — run fetch_premiums.py first');
  const all = await res.json();

  // ── Reference dates ─────────────────────────────────────────────────────────
  // dataToday = max trade date in the whole dataset. Using the data's own max
  // date (not calendar today) keeps weekend runs correct.
  let dataToday = null;
  for (const p of all) {
    const td = parseDate(p.trade_date);
    if (td && (!dataToday || td > dataToday)) dataToday = td;
  }
  const dataDay1 = dataToday ? prevTradingDay(dataToday, 1) : null;
  const dataDay2 = dataToday ? prevTradingDay(dataToday, 2) : null;
  const dataDay3 = dataToday ? prevTradingDay(dataToday, 3) : null;
  const dataDay4 = dataToday ? prevTradingDay(dataToday, 4) : null;

  // ── Per-ticker metadata — scan ALL rows (active + expired) ─────────────────
  // Tracks which of the last 5 trading days each ticker appeared on,
  // plus earliest-ever trade date and total prior-appearance count.
  const tickerMeta = {};
  for (const p of all) {
    const sym = String(p.symbol ?? '').trim().toUpperCase();
    const td  = parseDate(p.trade_date);
    if (!sym || !td) continue;
    if (!tickerMeta[sym]) tickerMeta[sym] = {
      d0: false, d1: false, d2: false, d3: false, d4: false,
      minTradeDate: td,
      allDateKeys: new Set(),
    };
    const m = tickerMeta[sym];
    if (td < m.minTradeDate) m.minTradeDate = td;
    m.allDateKeys.add(td.toDateString());
    if (sameDayStr(td, dataToday)) m.d0 = true;
    if (sameDayStr(td, dataDay1))  m.d1 = true;
    if (sameDayStr(td, dataDay2))  m.d2 = true;
    if (sameDayStr(td, dataDay3))  m.d3 = true;
    if (sameDayStr(td, dataDay4))  m.d4 = true;
  }
  // priorCount = distinct trade dates strictly before dataToday
  const todayKey = dataToday?.toDateString() ?? '';
  for (const m of Object.values(tickerMeta)) {
    m.priorCount = [...m.allDateKeys].filter(k => k !== todayKey).length;
  }

  // ── Pre-computed EMA + price (written by fetch_ema.py) ─────────────────────
  const posEma   = {};
  const posPrice = {};
  for (const p of all) {
    const sym = String(p.symbol ?? '').trim().toUpperCase();
    if (sym && p.ema_21d != null && !posEma[sym])   posEma[sym]   = parseFloat(p.ema_21d);
    if (sym && p.price   != null && !posPrice[sym]) posPrice[sym] = parseFloat(p.price);
  }

  // ── Date windows ────────────────────────────────────────────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(today.getDate() - 7);

  // ── Parse + validate active positions ───────────────────────────────────────
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
        isFinite(orig) && orig > 0 &&
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

  // ── Group by ticker ──────────────────────────────────────────────────────────
  const byTicker = {};
  for (const p of active) {
    if (!p.symbol) continue;
    if (!byTicker[p.symbol]) byTicker[p.symbol] = { puts: [], calls: [] };
    (p.type === 'call' ? byTicker[p.symbol].calls : byTicker[p.symbol].puts).push(p);
  }

  const totalTracked = Object.keys(byTicker).length;

  // ── 7-day notional per ticker — for "most active" T1 trigger ────────────────
  const notional7d = {};
  for (const [sym, { puts, calls }] of Object.entries(byTicker)) {
    notional7d[sym] = [...puts, ...calls]
      .filter(p => p.tradeDate >= sevenDaysAgo)
      .reduce((s, p) => s + p.notional, 0);
  }
  const maxNotional7d = Math.max(0, ...Object.values(notional7d));

  const signals = [];
  const events  = [];

  for (const [ticker, { puts, calls }] of Object.entries(byTicker)) {
    const allPos        = [...puts, ...calls];
    const totalNotional = allPos.reduce((s, p) => s + p.notional, 0);
    const callNotional  = calls.reduce((s, p) => s + p.notional, 0);
    const putNotional   = puts.reduce((s, p) => s + p.notional, 0);

    const tradeDateKeys = new Set(allPos.map(p => p.tradeDate?.toDateString()).filter(Boolean));
    const daysActive    = tradeDateKeys.size;

    const tradeDates   = allPos.map(p => p.tradeDate).filter(Boolean);
    const expiries     = allPos.map(p => p.expiry).filter(Boolean);
    const minTradeDate = new Date(Math.min(...tradeDates));
    const maxExpiry    = new Date(Math.max(...expiries));

    const meta        = tickerMeta[ticker] ?? {};
    const isFirstTime = sameDayStr(meta.minTradeDate, dataToday);
    const isQuiet     = (meta.priorCount ?? 0) < 3;

    // ── Follow-through flags ──────────────────────────────────────────────────
    const followThrough = !!(meta.d0 && meta.d1);       // appeared yesterday + today
    const countLast3    = (meta.d0?1:0)+(meta.d1?1:0)+(meta.d2?1:0);
    const countLast5    = countLast3+(meta.d3?1:0)+(meta.d4?1:0);
    const ft175         = !followThrough && countLast3 >= 2;
    const ft250         = countLast5 >= 3;

    // Base multiplier from follow-through intensity (dep penalty applied below)
    const ftBase = ft250 ? 2.5 : followThrough ? 2.0 : ft175 ? 1.75 : 1.0;

    // ── EVENT TRADE detection ─────────────────────────────────────────────────
    // Pure call plays where at least one call expires within 14 days of today.
    // These are binary/catalyst trades, shown separately — not structural flow.
    const isEventPlay = puts.length === 0 && calls.length > 0 &&
      calls.some(c => c.expiry && Math.floor((c.expiry - today) / 86_400_000) <= 14);

    // ── TIER 1 — any single trigger → STRONG ─────────────────────────────────
    const tier1 = [];

    // T1.1  Same day: puts sold + calls bought on same calendar date
    const putDayKeys  = new Set(puts.map(p => p.tradeDate?.toDateString()).filter(Boolean));
    const callDayKeys = new Set(calls.map(p => p.tradeDate?.toDateString()).filter(Boolean));
    if ([...putDayKeys].some(d => callDayKeys.has(d))) tier1.push('same_day_both');

    // T1.2  Follow-through: appeared yesterday AND today
    if (followThrough) tier1.push('follow_through');

    // T1.3  Single-day notional > $5M
    const dailyNotional = {};
    for (const p of allPos) {
      const k = p.tradeDate?.toDateString();
      if (k) dailyNotional[k] = (dailyNotional[k] || 0) + p.notional;
    }
    if (Object.values(dailyNotional).some(n => n > 5_000_000)) tier1.push('daily_5m');

    // T1.4  Most active ticker by weighted notional over rolling 7-day window
    if (maxNotional7d > 0 && notional7d[ticker] === maxNotional7d) tier1.push('most_active_7d');

    // T1.5  Calls rolled to progressively higher strikes
    if (calls.length >= 2) {
      const sorted = [...calls].sort((a, b) => a.tradeDate - b.tradeDate);
      if (sorted.some((c, i) => i > 0 && c.strike > sorted[i - 1].strike)) tier1.push('rolled_higher');
    }

    // T1.6  21D EMA reclaim — injected during MA enrichment pass (set below)

    // ── TIER 2 — needs 2+ triggers → NOTABLE ─────────────────────────────────
    const tier2 = [];

    // T2.1  Both types within a 5-day window
    let has5day = false;
    outer5: for (const p of puts) {
      for (const c of calls) {
        if (Math.abs(p.tradeDate - c.tradeDate) <= 5 * 86_400_000) { has5day = true; break outer5; }
      }
    }
    if (has5day) tier2.push('5day_confluence');

    // T2.2  Repeat flow on 3+ distinct dates
    if (daysActive >= 3) tier2.push('repeat_3days');

    // T2.3  High premium — put > $5 or call > $3 signals real conviction
    if (puts.some(p => p.originalPremium > 5) || calls.some(p => p.originalPremium > 3))
      tier2.push('high_premium');

    // T2.4  Any single position notional > $1M
    if (allPos.some(p => p.notional > 1_000_000)) tier2.push('large_single');

    // T2.5  Active on 2+ distinct trade dates
    if (daysActive >= 2) tier2.push('active_2days');

    // T2.6  Repeat spread structure — same put strike seen on 3+ distinct dates
    //       (potential catalyst / M&A flag — systematic re-entry at same level)
    if (puts.length >= 3) {
      const strikeMap = {};
      for (const p of puts) {
        const k = `${p.strike}`;
        if (!strikeMap[k]) strikeMap[k] = new Set();
        strikeMap[k].add(p.tradeDate?.toDateString());
      }
      if (Object.values(strikeMap).some(s => s.size >= 3)) tier2.push('repeat_spread');
    }

    // T2.7  Deep support put — strike > 15% below current price
    const currPrice = posPrice[ticker];
    if (currPrice && puts.some(p => p.strike < currPrice * 0.85)) tier2.push('deep_put_support');

    // T2.8  Zero cost structure — put sold and call bought in same expiry month
    let hasZeroCost = false;
    outerZC: for (const p of puts) {
      for (const c of calls) {
        if (p.expiry && c.expiry &&
            p.expiry.getFullYear() === c.expiry.getFullYear() &&
            p.expiry.getMonth()    === c.expiry.getMonth()) { hasZeroCost = true; break outerZC; }
      }
    }
    if (hasZeroCost) tier2.push('zero_cost');

    // ── DEPRIORITIZE — reduces weighted score by 50% if any trigger fires ─────
    const dep = [];
    if (daysActive <= 1)                                                   dep.push('one_day');
    if (allPos.every(p => p.originalPremium < 0.50))                      dep.push('all_cheap');
    if (puts.length === 0 && calls.every(p => p.originalPremium < 2.0))   dep.push('calls_only_cheap');
    if (totalNotional < 100_000)                                           dep.push('low_notional');
    if (allPos.every(p => p.expiry &&
        Math.floor((p.expiry - today) / 86_400_000) <= 14) &&
        (meta.priorCount ?? 0) <= 1)                                       dep.push('short_dated_no_history');

    const depPenalty = dep.length > 0 ? 0.5 : 1.0;
    const multiplier = ftBase * depPenalty;

    // ── Badge assignment ──────────────────────────────────────────────────────
    const t1 = tier1.length, t2 = tier2.length, d = dep.length;
    let badge = null;

    if      (t1 >= 1 && d === 0)             badge = 'STRONG';
    else if (t1 >= 1 && d === 1 && t2 >= 1)  badge = 'STRONG';
    else if (t2 >= 2 && d === 0)             badge = 'NOTABLE';
    else if (t2 >= 3 && d <= 1)              badge = 'NOTABLE';
    else if (t2 >= 2 && d === 1)             badge = 'NOTABLE';

    // UNUSUAL: first-time or very quiet name with meaningful notional
    if (!badge && isQuiet && totalNotional > 500_000) badge = 'UNUSUAL';

    // EVENT TRADE: structural badge didn't fire, but it's a short-dated call play
    if (!badge && isEventPlay && totalNotional > 50_000) {
      events.push({
        ticker, badge: 'EVENT',
        totalNotional, putNotional: 0, callNotional,
        puts: [], calls,
        daysActive, minTradeDate, maxExpiry,
        tier1Triggers: tier1, tier2Triggers: tier2, deprioritize: dep,
        multiplier, followThrough, ft250, isFirstTime, isQuiet,
        ema21d: posEma[ticker] ?? null, maContext: null,
      });
      continue;
    }

    if (!badge) continue;

    signals.push({
      ticker, badge,
      totalNotional, putNotional, callNotional,
      puts, calls,
      daysActive, minTradeDate, maxExpiry,
      tier1Triggers: tier1, tier2Triggers: tier2, deprioritize: dep,
      multiplier, followThrough, ft250, isFirstTime, isQuiet,
      ema21d: posEma[ticker] ?? null, maContext: null,
    });
  }

  // ── Sort helper (called twice: pre-MA and post-MA) ────────────────────────
  const sortByConviction = arr => arr.sort((a, b) => {
    // Primary: follow-through intensity (higher multiplier first)
    const ftRank = s => s.multiplier >= 2.5 ? 3 : s.multiplier >= 2 ? 2 : s.multiplier >= 1.75 ? 1 : 0;
    const ftDiff = ftRank(b) - ftRank(a);
    if (ftDiff !== 0) return ftDiff;
    // Secondary: badge tier
    const tierOrder = { STRONG: 3, NOTABLE: 2, UNUSUAL: 1 };
    const tDiff = (tierOrder[b.badge] || 0) - (tierOrder[a.badge] || 0);
    if (tDiff !== 0) return tDiff;
    // Tertiary: weighted notional
    return (b.totalNotional * b.multiplier) - (a.totalNotional * a.multiplier);
  });

  // Pre-sort → fetch MA for the top 15 candidates in parallel.
  // Using 15 (not 10) so borderline names aren't skipped if a reclaim or
  // above-EMA boost would push them over the display threshold.
  sortByConviction(signals);

  const maWindow = signals.slice(0, Math.min(signals.length, 15));
  await Promise.all(maWindow.map(async sig => {
    const ma = await fetchMAContext(sig).catch(() => null);
    sig.maContext = ma ?? null;
    if (ma) {
      sig.multiplier *= ma.maFactor;
      // EMA reclaim is a T1 trigger — upgrade non-STRONG signals
      if (ma.maStatus === 'reclaim' && sig.badge !== 'STRONG') {
        sig.badge = 'STRONG';
        sig.tier1Triggers.push('ema_reclaim');
      }
    }
  }));

  // Final sort after MA adjustments
  sortByConviction(signals);

  // ── Threshold filter — quality over quantity ──────────────────────────────
  // Weighted score = totalNotional × all accumulated multipliers.
  // Targets ~4–8 cards on a typical day; hard cap at 12.
  const THRESH = { STRONG: 150_000, NOTABLE: 75_000, UNUSUAL: 0 };
  const shown = signals.filter(s => {
    const weighted = s.totalNotional * s.multiplier;
    return weighted >= (THRESH[s.badge] ?? 0);
  }).slice(0, 12);

  shown._qualified    = shown.length;
  shown._totalTracked = totalTracked;
  shown._events       = events.slice(0, 5);
  return shown;
}

// ── Export ────────────────────────────────────────────────────────────────────

function exportSignals(signals) {
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();
  const line50  = '─'.repeat(50);
  const events  = signals._events ?? [];
  const out     = [`OPTIONS FLOW SIGNALS — ${dateStr}`, line50];

  const formatSig = s => {
    const note    = (localStorage.getItem(`analyst_note_${s.ticker}`) ?? '').trim();
    const hasBoth = s.puts.length > 0 && s.calls.length > 0;
    const strat   = hasBoth       ? 'PUT SOLD + CALL BOUGHT (BULLISH)'
                  : s.puts.length ? 'PUT SOLD (BULLISH)'
                  : 'CALL BOUGHT (BULLISH)';
    const ftTag   = s.ft250         ? ' · 3+ OF 5 DAYS'
                  : s.followThrough ? ' · FOLLOW-THROUGH'
                  : s.isFirstTime   ? ' · NEW'
                  : '';
    const maInds  = (s.maContext?.indicators ?? []).map(i => i.text).join(' · ');
    const rows    = [
      '',
      `${s.ticker}  [${s.badge}${ftTag}]`,
      `Strategy : ${strat}`,
      `Notional : ${fmtNotional(s.totalNotional)}   Active: ${s.daysActive} days`,
      `Dates    : ${fmtDate(s.minTradeDate)} → ${fmtDate(s.maxExpiry)}`,
    ];
    if (s.ema21d != null) rows.push(`21D EMA  : $${s.ema21d.toFixed(2)}`);
    if (maInds)           rows.push(`MA       : ${maInds}`);
    if (note)             rows.push(`Note     : ${note}`);
    rows.push(line50);
    return rows;
  };

  for (const s of signals) out.push(...formatSig(s));

  if (events.length) {
    out.push('', 'EVENT TRADE', line50);
    for (const s of events) out.push(...formatSig(s));
  }

  out.push('', 'Generated by Options Flow Command Centre');
  return out.join('\n');
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderSignals(signals) {
  const grid   = document.getElementById('signals-grid');
  const events = signals._events ?? [];

  if (!signals.length && !events.length) {
    grid.innerHTML = `
      <div class="sig-empty">
        <div class="sig-empty-icon">◈</div>
        <div>No signals found</div>
        <div class="sig-empty-sub">Signals appear when a ticker meets conviction criteria based on notional value, flow frequency, and premium quality.</div>
      </div>`;
    return;
  }

  const strongN   = signals.filter(s => s.badge === 'STRONG').length;
  const notableN  = signals.filter(s => s.badge === 'NOTABLE').length;
  const unusualN  = signals.filter(s => s.badge === 'UNUSUAL').length;
  const ftN       = signals.filter(s => s.followThrough || s.ft250).length;
  const qualified = signals._qualified    ?? signals.length;
  const tracked   = signals._totalTracked ?? qualified;
  const dateStr   = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();

  const summary = document.getElementById('sig-summary');
  summary.innerHTML = `
    <span class="sum-pill bull-key">TOP SIGNALS · ${dateStr} · ${qualified} tickers qualified out of ${tracked} tracked</span>
    ${ftN      ? `<span class="sum-pill follow-thru">${ftN} FOLLOW-THROUGH</span>` : ''}
    ${strongN  ? `<span class="sum-pill strong">${strongN} STRONG</span>`          : ''}
    ${notableN ? `<span class="sum-pill notable">${notableN} NOTABLE</span>`       : ''}
    ${unusualN ? `<span class="sum-pill unusual">${unusualN} UNUSUAL</span>`       : ''}
    <button id="export-btn" class="export-btn">EXPORT</button>
  `;
  summary.hidden = false;

  // ── Shared card template ──────────────────────────────────────────────────
  const makeCard = s => {
    const badgeCls = s.badge === 'STRONG'  ? 'badge-strong'
                   : s.badge === 'NOTABLE' ? 'badge-notable'
                   : s.badge === 'UNUSUAL' ? 'badge-unusual'
                   : 'badge-event';

    const cardCls  = s.badge === 'STRONG'  ? 'signal-card--strong'
                   : s.badge === 'NOTABLE' ? 'signal-card--notable'
                   : s.badge === 'UNUSUAL' ? 'signal-card--unusual'
                   : 'signal-card--event';

    const dateRange = `${fmtDate(s.minTradeDate)} → ${fmtDate(s.maxExpiry)}`;

    // EMA status dot
    const maStatus = s.maContext?.maStatus ?? null;
    const dotTitle = maStatus === 'reclaim' ? '⚡ 21D EMA Reclaim'
                   : maStatus === 'above'   ? '↑ Above 21D EMA'
                   : maStatus === 'below'   ? '↓ Below 21D EMA'
                   : '';
    const dotCls   = maStatus === 'reclaim' ? 'ema-dot--reclaim'
                   : maStatus === 'above'   ? 'ema-dot--above'
                   : maStatus === 'below'   ? 'ema-dot--below'
                   : '';
    const emaDot   = dotCls
      ? `<span class="ema-dot ${dotCls}" title="${dotTitle}"></span>`
      : '';

    // Tags row — most significant first
    const tags = [
      s.ft250          ? `<span class="sig-tag tag-ft">3+ OF 5 DAYS</span>`   : '',
      s.followThrough  ? `<span class="sig-tag tag-ft">FOLLOW-THROUGH</span>` : '',
      s.isFirstTime    ? `<span class="sig-tag tag-new">NEW</span>`           : '',
      (!s.isFirstTime && s.isQuiet) ? `<span class="sig-tag tag-new">QUIET NAME</span>` : '',
    ].filter(Boolean).join('');

    const hasBoth   = s.puts.length > 0 && s.calls.length > 0;
    const stratLine = hasBoth
      ? `PUT SOLD <span class="card-strat-bull">▲ BULLISH</span> + CALL BOUGHT`
      : s.puts.length
        ? `PUT SOLD <span class="card-strat-bull">▲ BULLISH</span>`
        : s.badge === 'EVENT'
          ? `CALL BOUGHT <span class="card-strat-event">⚡ EVENT PLAY</span>`
          : `CALL BOUGHT <span class="card-strat-bull">▲ BULLISH</span>`;

    const maInds = s.maContext?.indicators ?? [];
    const maHtml = maInds.length
      ? `<div class="card-ma">${maInds.map(i => `<span class="ma-tag ${i.cls}">${i.text}</span>`).join('')}</div>`
      : '';

    const emaHtml = s.ema21d != null
      ? `<div class="card-ema">21D EMA <span class="card-ema-val">$${s.ema21d.toFixed(2)}</span></div>`
      : '';

    return `
      <div class="signal-card ${cardCls}">
        <div class="card-top">
          <span class="card-ticker">${s.ticker}</span>
          <div class="card-top-right">
            ${emaDot}
            <span class="card-badge ${badgeCls}">${s.badge}</span>
          </div>
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

        <div class="card-note-wrap">
          <div class="card-note-lbl">ANALYST NOTE</div>
          <textarea class="card-note" data-ticker="${s.ticker}" placeholder="Add context…" rows="2"></textarea>
        </div>
      </div>`;
  };

  // Main structural signals grid
  grid.innerHTML = signals.length
    ? signals.map(makeCard).join('')
    : `<div class="sig-empty">
         <div class="sig-empty-icon">◈</div>
         <div>No structural signals today</div>
         <div class="sig-empty-sub">Check the Event Trade section below for short-dated flow.</div>
       </div>`;

  // ── Event trades section (separate, below main grid) ──────────────────────
  document.getElementById('event-wrap')?.remove();
  if (events.length) {
    const wrap = document.createElement('div');
    wrap.id = 'event-wrap';
    wrap.innerHTML = `
      <div class="event-section-hdr">
        <span class="event-hdr-label">EVENT TRADE</span>
        <span class="event-hdr-sub">Short-dated calls · Binary / catalyst play · Not structural flow</span>
      </div>
      <div class="signals-grid">${events.map(makeCard).join('')}</div>
    `;
    document.getElementById('sec03-body').appendChild(wrap);
  }

  // ── Wire analyst notes (all cards, incl. events) ─────────────────────────
  document.getElementById('sec03-body').querySelectorAll('.card-note').forEach(ta => {
    const key   = `analyst_note_${ta.dataset.ticker}`;
    const saved = localStorage.getItem(key) ?? '';
    if (saved) { ta.value = saved; ta.classList.add('has-note'); }
    let debounce;
    ta.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (ta.value.trim()) {
          localStorage.setItem(key, ta.value);
          ta.classList.add('has-note');
        } else {
          localStorage.removeItem(key);
          ta.classList.remove('has-note');
        }
      }, 400);
    });
    ta.addEventListener('click', e => e.stopPropagation());
  });

  // ── Wire export button ────────────────────────────────────────────────────
  document.getElementById('export-btn')?.addEventListener('click', async () => {
    const btn  = document.getElementById('export-btn');
    const text = exportSignals(signals);
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'COPIED ✓';
    } catch {
      const tmp = document.createElement('textarea');
      tmp.value = text;
      tmp.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(tmp);
      tmp.select();
      document.execCommand('copy');
      document.body.removeChild(tmp);
      btn.textContent = 'COPIED ✓';
    }
    setTimeout(() => { btn.textContent = 'EXPORT'; }, 2000);
  });
}

function setSigStatus(msg, cls) {
  const el = document.getElementById('sig-status');
  el.textContent = msg;
  el.className   = cls;
  el.hidden      = !msg;
}

// ── Entry point ────────────────────────────────────────────────────────────────

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

  // Delegate chart-link clicks — covers both main grid and event section
  document.getElementById('sec03-body').addEventListener('click', e => {
    const link = e.target.closest('a[data-ticker]');
    if (!link) return;
    e.preventDefault();
    load(link.dataset.ticker);
    document.getElementById('sec01-body').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});
