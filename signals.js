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
      maxTradeDate: td,
      allDateKeys: new Set(),
    };
    const m = tickerMeta[sym];
    if (td < m.minTradeDate) m.minTradeDate = td;
    if (td > m.maxTradeDate) m.maxTradeDate = td;
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
      const contracts = parseInt(p.contracts);
      return (
        expiry && tradeDate &&
        expiry >= today &&
        expiry > tradeDate &&
        isFinite(contracts) && contracts > 0
      );
    })
    .map(p => {
      const orig      = parseFloat(p.original_premium ?? p.current_premium ?? p.premium);
      const contracts = parseInt(p.contracts) || 0;
      const rawStrike = String(p.strike ?? '');
      const strikeNum = rawStrike.includes('/')
        ? parseFloat(rawStrike.split('/')[0])
        : parseFloat(rawStrike);
      const hasPremium  = isFinite(orig) && orig > 0;
      const premiumUsed = hasPremium ? orig : (isFinite(strikeNum) ? strikeNum * 0.03 : 0);
      return {
        type:             (p.type ?? 'put').toLowerCase(),
        strike:           strikeNum,
        expiry:           parseDate(p.expiry),
        contracts,
        originalPremium:  orig,
        premiumEstimated: !hasPremium,
        tradeDate:        parseDate(p.trade_date),
        notional:         contracts * premiumUsed * 100,
        symbol:           String(p.symbol ?? '').trim().toUpperCase(),
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

    // T1 — Mega block: single position > 10,000 contracts = institutional size
    if (allPos.some(p => p.contracts >= 10_000)) tier1.push('mega_block');

    // T1.4  Most active ticker by weighted notional over rolling 7-day window
    if (maxNotional7d > 0 && notional7d[ticker] === maxNotional7d) tier1.push('most_active_7d');

    // T1 — Rolling higher: calls bought at progressively higher strikes on different dates
    let isRolling = false;
    if (calls.length >= 2) {
      const sorted = [...calls].sort((a, b) => a.tradeDate - b.tradeDate);
      isRolling = sorted.some((c, i) => i > 0 &&
        c.strike > sorted[i-1].strike &&
        !sameDayStr(c.tradeDate, sorted[i-1].tradeDate)
      );
      if (isRolling) tier1.push('rolled_higher');
    }

    // T1 — Expiry ladder: same ticker, calls across 3+ distinct expiry months same day
    const todayCallExpiries = calls
      .filter(c => sameDayStr(c.tradeDate, dataToday))
      .map(c => `${c.expiry?.getFullYear()}-${c.expiry?.getMonth()}`)
      .filter(Boolean);
    const uniqueExpiryMonths = new Set(todayCallExpiries);
    if (uniqueExpiryMonths.size >= 3) tier1.push('expiry_ladder');

    // T1.6  Mega contract day — 10,000+ contracts in a single day regardless of history
    // Catches first-time institutional size plays like UAL 40,000x
    const todayContracts = allPos
      .filter(p => sameDayStr(p.tradeDate, dataToday))
      .reduce((s, p) => s + p.contracts, 0);
    if (todayContracts >= 10_000) tier1.push('mega_contract_day');

    // T1.7  21D EMA reclaim — injected during MA enrichment pass (set below)

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

    // T1 — ITM put sale: put strike above current price
    if (currPrice && puts.some(p => p.strike > currPrice)) tier1.push('itm_put_sale');

    // T1 — Risk reversal: put sold + call bought in same expiry month
    // Enhanced: same-strike = synthetic long = strongest possible structure
    let isRiskReversal = false;
    let isSameStrikeRR = false;
    outerRR: for (const p of puts) {
      for (const c of calls) {
        if (p.expiry && c.expiry &&
            p.expiry.getFullYear() === c.expiry.getFullYear() &&
            p.expiry.getMonth()    === c.expiry.getMonth()) {
          isRiskReversal = true;
          if (Math.abs(p.strike - c.strike) < 0.01) isSameStrikeRR = true;
          break outerRR;
        }
      }
    }
    if (isRiskReversal) tier1.push('risk_reversal');
    if (isSameStrikeRR) tier1.push('same_strike_rr'); // extra T1 trigger

    // T2.8  Zero cost structure — put sold and call bought in same expiry month
    let hasZeroCost = false;
    outerZC: for (const p of puts) {
      for (const c of calls) {
        if (p.expiry && c.expiry &&
            p.expiry.getFullYear() === c.expiry.getFullYear() &&
            p.expiry.getMonth()    === c.expiry.getMonth()) { hasZeroCost = true; break outerZC; }
      }
    }
    if (hasZeroCost) tier1.push('zero_cost');

    // ── DEPRIORITIZE — reduces weighted score by 50% if any trigger fires ─────
    const dep = [];
    if (daysActive <= 1)                                                   dep.push('one_day');
    if (allPos.every(p => p.originalPremium < 0.50))                      dep.push('all_cheap');
    const todayCalls = calls.filter(p => p.tradeDate && p.tradeDate.toDateString() === today.toDateString());
    const checkCalls = todayCalls.length > 0 ? todayCalls : calls;
    if (puts.length === 0 && checkCalls.every(p => p.originalPremium < 2.0) && uniqueExpiryMonths.size < 3)   dep.push('calls_only_cheap');
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

    // UNUSUAL: first appearance OR quiet name OR mega size — shown in separate section
    const isRecent = meta.maxTradeDate && (today - meta.maxTradeDate) / 86_400_000 <= 3;
    const isUnusual = (
      (isFirstTime || isQuiet) && isRecent && totalNotional > 200_000
    ) || todayContracts >= 5_000;

    if (!badge && isUnusual) {
      events.push({
        ticker, badge: 'UNUSUAL',
        totalNotional, putNotional, callNotional,
        puts, calls,
        daysActive, minTradeDate, maxExpiry,
        tier1Triggers: tier1, tier2Triggers: tier2, deprioritize: dep,
        multiplier, followThrough, ft250, isFirstTime, isQuiet,
        repeatDays: countLast5,
        todayContracts,
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
      repeatDays: countLast5,
      ema21d: posEma[ticker] ?? null, maContext: null,
      isRiskReversal,
      isSameStrikeRR,
      isITMPutSale: currPrice ? puts.some(p => p.strike > currPrice) : false,
      isRolling,
      hasMegaBlock: allPos.some(p => p.contracts >= 10_000),
      hasExpiryLadder: uniqueExpiryMonths.size >= 3,
    });

    // ── Learned scoring enrichment ────────────────────────────────────────────
    {
      const sig = signals[signals.length - 1];
      // Bridge fields expected by applyLearnedScoring onto the existing shape
      sig.score          = sig.totalNotional * sig.multiplier;
      sig.tier           = sig.badge;
      sig.notional       = sig.totalNotional;
      sig.tags           = sig.tags ?? [];
      sig.isRiskReversal = sig.isRiskReversal ?? false;
      sig.isITMPutSale   = sig.isITMPutSale   ?? false;
      sig.isRolling      = sig.isRolling      ?? false;
      sig.isSpread       = sig.puts.some(p => String(p.strike).includes('/')) ||
                           sig.calls.some(p => String(p.strike).includes('/'));
      applyLearnedScoring(sig, '');
      // Override tier if golden-rule forces it
      if (sig.forceEventTrade) sig.badge = 'EVENT';
      if (sig.forceTier1) sig.badge = 'STRONG';
      // Strip put positions for calls-only names
      if (sig.callsOnly) { sig.puts = []; sig.putNotional = 0; }
    }
  }

  // ── Sector sweep cross-boost ─────────────────────────────────────────────────
  // If 2+ tickers from the same sector appeared on the same trade date,
  // boost all of them by 20% and tag with SECTOR SWEEP label.
  const allSignals = [...signals, ...events];
  for (const group of SECTOR_SWEEP_GROUPS) {
    // Find which signals belong to this sector
    const sectorSigs = allSignals.filter(s => group.tickers.includes(s.ticker));
    if (sectorSigs.length < 2) continue;

    // Check if 2+ appeared on the same trade date
    const dateCounts = {};
    for (const s of sectorSigs) {
      const dateKey = s.minTradeDate?.toDateString();
      if (dateKey) dateCounts[dateKey] = (dateCounts[dateKey] || 0) + 1;
    }
    const hasSweep = Object.values(dateCounts).some(n => n >= 2);
    if (!hasSweep) continue;

    // Apply boost and tag to all sector members in the signal list
    for (const s of sectorSigs) {
      s.multiplier *= 1.20;
      s.tags = [...new Set([...(s.tags || []), group.name])];
    }
  }

  // ── Sort helper (called twice: pre-MA and post-MA) ────────────────────────
  const sortByConviction = arr => arr.sort((a, b) => {
    const ftRank = s => s.multiplier >= 2.5 ? 3 : s.multiplier >= 2 ? 2 : s.multiplier >= 1.75 ? 1 : 0;
    const tierOrder = { STRONG: 3, NOTABLE: 2, UNUSUAL: 1 };
    // Weighted score incorporates badge tier, follow-through, and raw notional
    const score = s =>
      (tierOrder[s.badge] || 0)    * 10_000_000 +
      ftRank(s)                    *  5_000_000 +
      (s.isSameStrikeRR ? 1 : 0)  *  3_000_000 +
      (s.hasMegaBlock   ? 1 : 0)  *  2_000_000 +
      (s.hasExpiryLadder? 1 : 0)  *  1_500_000 +
      s.totalNotional * s.multiplier;
    return score(b) - score(a);
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
  const ftN       = signals.filter(s => s.repeatDays >= 2).length;
  const qualified = signals._qualified    ?? signals.length;
  const tracked   = signals._totalTracked ?? qualified;
  const dateStr   = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();

  const summary = document.getElementById('sig-summary');
  summary.innerHTML = `
    <span class="sum-pill bull-key">TOP SIGNALS · ${dateStr} · ${qualified} tickers qualified out of ${tracked} tracked</span>
    ${ftN      ? `<span class="sum-pill follow-thru">${ftN} REPEAT</span>` : ''}
    ${strongN  ? `<span class="sum-pill strong">${strongN} STRONG</span>`          : ''}
    ${notableN ? `<span class="sum-pill notable">${notableN} NOTABLE</span>`       : ''}
    ${unusualN ? `<span class="sum-pill unusual">${unusualN} UNUSUAL</span>`       : ''}
    <button id="export-btn" class="export-btn">EXPORT</button>
  `;
  summary.hidden = false;

  // ── Shared card template ──────────────────────────────────────────────────
  const makeCard = (s, rank) => {
    const badgeCls = s.badge === 'STRONG'  ? 'badge-strong'
                   : s.badge === 'NOTABLE' ? 'badge-notable'
                   : s.badge === 'UNUSUAL' ? 'badge-unusual'
                   : 'badge-event';

    const cardCls  = s.badge === 'STRONG'  ? 'signal-card--strong'
                   : s.badge === 'NOTABLE' ? 'signal-card--notable'
                   : s.badge === 'UNUSUAL' ? 'signal-card--unusual'
                   : 'signal-card--event';

    // EMA indicator — only show if above or reclaim, never below
    const maStatus = s.maContext?.maStatus ?? null;
    const emaDot   = maStatus === 'reclaim'
      ? `<span class="ema-dot ema-dot--reclaim" title="21D EMA Reclaim"></span>`
      : maStatus === 'above'
      ? `<span class="ema-dot ema-dot--above" title="Above 21D EMA"></span>`
      : '';

    // Signal line — 2-3 most important signals, priority order
    const sigParts = [];
    if (maStatus === 'reclaim')          sigParts.push('⚡ RECLAIM');
    if (s.repeatDays >= 2)               sigParts.push(`REPEAT ${s.repeatDays} DAYS`);
    if (s.puts.length && s.calls.length) sigParts.push('PUT + CALL');
    else if (s.puts.length)             sigParts.push('PUT ONLY');
    else                                 sigParts.push('CALL ONLY');
    // Best qualifying tag from learned scoring (first gold tag, else first non-warning teal)
    const goldTags = ['RISK REVERSAL','ITM PUT SALE','ROLLING HIGHER','CONVICTION UPGRADE','BREAKOUT CONFIRMATION','RELATIVE STRENGTH'];
    const bestTag  = (s.tags || []).find(t => goldTags.includes(t)) ||
                     (s.tags || []).find(t => !['CALLS ONLY — BIOTECH','CALLS ONLY — SMALL CAP','ENERGY — USE SPREADS'].includes(t));
    if (bestTag)     sigParts.push(bestTag);
    const sigLine  = sigParts.slice(0, 3).join(' · ');

    // Warning tags — calls only flags shown as red pills
    const warnTags = (s.tags || []).filter(t => t.startsWith('CALLS ONLY'));
    const warnHtml = warnTags.map(t =>
      `<span style="font-family:'JetBrains Mono',monospace;font-size:9px;font-variant:small-caps;padding:2px 6px;border-radius:3px;background:rgba(255,50,50,0.12);border:1px solid rgba(255,50,50,0.4);color:#ff4444">${t}</span>`
    ).join(' ');

    return `
    <div class="signal-card ${cardCls}">
      <div class="card-top">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--fg3);letter-spacing:0.08em;min-width:18px">#${rank}</span>
          <span class="card-ticker">${s.ticker}</span>
        </div>
        <div class="card-top-right">
          ${emaDot}
          <span class="card-badge ${badgeCls}">${s.badge}</span>
        </div>
      </div>

      <div class="card-sigline">${sigLine}</div>

      ${warnHtml ? `<div style="margin-top:4px">${warnHtml}</div>` : ''}

      <div class="card-stats">
        <div class="stat">
          <div class="stat-val" style="color:var(--up)">${fmtNotional(s.totalNotional)}${s.puts.concat(s.calls).some(p => p.premiumEstimated) ? '<span class="est-label">EST</span>' : ''}</div>
          <div class="stat-lbl">TOTAL NOTIONAL</div>
        </div>
      </div>

      <div class="card-footer">
        <div class="card-dates">${fmtDate(s.minTradeDate)} → ${fmtDate(s.maxExpiry)}</div>
        <a class="card-link" href="#" onclick="event.preventDefault(); document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('tab-btn--active')); document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('tab-panel--active')); document.querySelector('.tab-btn[data-tab=chart]').classList.add('tab-btn--active'); document.getElementById('tab-chart').classList.add('tab-panel--active'); document.getElementById('ticker-input').value='${s.ticker}'; load('${s.ticker}');">View chart →</a>
      </div>
    </div>`;
  };

  // Main structural signals grid
  grid.innerHTML = signals.length
    ? signals.map((s, i) => makeCard(s, i + 1)).join('')
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
        <span class="event-hdr-label">UNUSUAL FLOW</span>
        <span class="event-hdr-sub">First appearance · Mega size · Quiet names with large notional</span>
      </div>
      <div class="signals-grid">${events.map((s, i) => makeCard(s, i + 1)).join('')}</div>
    `;
    document.getElementById('sec03-body').appendChild(wrap);
  }

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

// ── Learned Signal Intelligence (v2) ─────────────────────────────────────────

const GOLDEN_RULE_BIOTECHS = ['MRNA','BNTX','NVAX','SRPT','RARE','ALNY','BMRN','BLUE','FATE','RCUS','TVTX','QURE','VYGR','MEOX','SKLN','LAES','PHAT','CELC','CELH','CMPS','PEPG','SMR'];
const GOLDEN_RULE_SMALLCAP_CALLS_ONLY = ['MITK','DKL','FLNG','LAES','AMPX','TGB'];

const SECTOR_ENERGY = ['XLE','EOG','FCX','VLO','OXY','DVN','COP','EQT','MTDR','OVV','APA','CHRD','SLB'];
const SECTOR_DEFENSE = ['RTX','GD','LMT','AVAV','NOC','HII','TDG'];
const SECTOR_CHINA = ['BABA','FXI','BIDU','JD','PDD','KWEB'];
const SECTOR_CRYPTO = ['COIN','MSTR','IBIT','CORZ','IREN','SMR'];
const SECTOR_AI_INFRA = ['NVDA','AMD','ASTS','IREN','PLTR','SMCI'];
const SECTOR_COPPER_AI_BOOST = ['FCX','CPER','BHP','TECK','HBM'];

const SECTOR_AIRLINES = ['UAL','DAL','AAL','LUV','SAVE','JBLU','ALK','HA'];
const SECTOR_BANKS = ['JPM','BAC','WFC','C','GS','MS','USB','PNC','TFC','KEY','CFG','HBAN'];
const SECTOR_RETAIL = ['WMT','TGT','COST','AMZN','HD','LOW','TJX','ROST','BURL','DG','DLTR'];
const SECTOR_SEMIS = ['NVDA','AMD','MU','INTC','QCOM','AVGO','TSM','AMAT','KLAC','LRCX','ASML','MRVL','SMCI','SNDK'];
const SECTOR_OIL_SERVICES = ['SLB','HAL','BKR','RIG','NOV','FTI'];

// Sector sweep: if 2+ names from same sector appear on same trade date → cross-boost all
const SECTOR_SWEEP_GROUPS = [
  { name: 'AIRLINE SWEEP', tickers: SECTOR_AIRLINES },
  { name: 'BANK SWEEP', tickers: SECTOR_BANKS },
  { name: 'SEMI SWEEP', tickers: SECTOR_SEMIS },
  { name: 'ENERGY SWEEP', tickers: SECTOR_OIL_SERVICES },
  { name: 'RETAIL SWEEP', tickers: SECTOR_RETAIL },
];

const BOOST_PHRASES = [
  'first trade','first ever','never sees flow',
  'reclaiming the 21','reclaimed the 8 ema',
  'held the 200','relative strength','holding up',
  'something is brewing','maybe m&a','potential acquisition',
  'most bullish','most active','gap fill at',
  'adding to','second day','third day','building',
  'rolled higher','cup and handle','base breakout','breaking out'
];

const REDUCE_PHRASES = [
  'complete gamble','lottery ticket','pure speculation',
  'broken chart','under all key averages',
  'weird trade','odd trade','if you\'re uncomfortable'
];

const CALLS_ONLY_PHRASES = ['biotech','biopharma','sub $1b','small cap'];

function applyLearnedScoring(signal, analystNote = '') {
  let score = signal.score || 0;
  const tags = signal.tags || [];
  const note = analystNote.toLowerCase();

  // ── Golden Rules ────────────────────────────────────────
  const isBiotech = GOLDEN_RULE_BIOTECHS.includes(signal.ticker) || CALLS_ONLY_PHRASES.some(p => note.includes(p) && p.includes('bio'));
  const isSmallCap = GOLDEN_RULE_SMALLCAP_CALLS_ONLY.includes(signal.ticker) || note.includes('sub $1b') || note.includes('small cap');

  if (isBiotech) {
    tags.push('CALLS ONLY — BIOTECH');
    signal.callsOnly = true;
    // Biotech put sale is ultra-rare = automatic T1 upgrade
    if (signal.isRiskReversal || (signal.puts && signal.puts.length > 0)) {
      tags.push('BIOTECH PUT SALE — RARE');
      signal.forceTier1 = true;
    }
  }
  if (isSmallCap) { tags.push('CALLS ONLY — SMALL CAP'); signal.callsOnly = true; }

  // ── Reduce phrases ──────────────────────────────────────
  REDUCE_PHRASES.forEach(p => { if (note.includes(p)) score *= 0.7; });
  if (note.includes('complete gamble') || note.includes('lottery ticket')) {
    signal.forceEventTrade = true;
  }

  // ── Boost phrases ───────────────────────────────────────
  BOOST_PHRASES.forEach(p => { if (note.includes(p)) score *= 1.2; });

  // ── Relative strength ───────────────────────────────────
  if (note.includes('relative strength') || note.includes('holding up')) {
    score *= 1.3; tags.push('RELATIVE STRENGTH');
  }

  // ── Gap fill target ─────────────────────────────────────
  if (note.includes('gap fill')) { tags.push('GAP FILL TARGET'); }

  // ── Breakout confirmation ───────────────────────────────
  if (note.includes('cup and handle') || note.includes('breaking out') || note.includes('base breakout')) {
    score *= 1.25; tags.push('BREAKOUT CONFIRMATION');
  }

  // ── First flow ──────────────────────────────────────────
  if (note.includes('first trade') || note.includes('first ever') || note.includes('never sees flow')) {
    tags.push('FIRST FLOW');
    if (signal.notional > 500000) signal.tier = 'UNUSUAL';
    if (note.includes('up') && (note.includes('this week') || note.includes('today'))) {
      tags.push('MOMENTUM ENTRY');
    }
  }

  // ── Trade structure boosts ──────────────────────────────
  if (signal.isRiskReversal) { score *= 1.35; tags.push('RISK REVERSAL'); }
  if (signal.isITMPutSale)   { score *= 1.30; tags.push('ITM PUT SALE'); }
  if (signal.isRolling)      { score *= 1.40; tags.push('ROLLING HIGHER'); }
  if (signal.isSpread)       { tags.push('DEFINED RISK'); }
  if (signal.isCalendar)     { score *= 1.25; tags.push('CALENDAR STRUCTURE'); }

  // Same-strike risk reversal = synthetic long = maximum bullish conviction
  if (signal.isSameStrikeRR) {
    score *= 1.50;
    tags.push('SYNTHETIC LONG');
  }

  // Mega block — single position > 10,000 contracts
  if (signal.hasMegaBlock) {
    score *= 1.25;
    tags.push('MEGA BLOCK');
  }

  // Expiry ladder — institutional building across multiple timeframes
  if (signal.hasExpiryLadder) {
    score *= 1.30;
    tags.push('EXPIRY LADDER');
  }

  // ── Sector rules ────────────────────────────────────────
  if (SECTOR_ENERGY.includes(signal.ticker)) { tags.push('ENERGY — USE SPREADS'); }
  if (SECTOR_DEFENSE.includes(signal.ticker) && signal.dte < 30) { signal.forceEventTrade = true; }
  if (SECTOR_CHINA.includes(signal.ticker))  { tags.push('CATALYST WATCH'); }
  if (SECTOR_CRYPTO.includes(signal.ticker)) { tags.push('TREND CHANGE WATCH'); }

  // ── Airline sector: flag high-VIX call risk, prefer spread + put sale structure
  if (SECTOR_AIRLINES.includes(signal.ticker)) {
    tags.push('HIGH VIX — USE SPREAD STRUCTURE');
    // If spread already present, that's correct structure — boost it
    if (signal.isSpread) { score *= 1.20; }
  }

  // ── Oil services: geopolitical catalyst watch
  if (SECTOR_OIL_SERVICES.includes(signal.ticker)) {
    tags.push('CATALYST WATCH');
  }

  // ── AI infra cross-boost: if NVDA/AMD flow present same day, boost copper names
  if (SECTOR_AI_INFRA.includes(signal.ticker)) {
    tags.push('AI INFRA FLOW');
  }

  signal.score = score;
  signal.tags  = [...new Set(tags)];
  return signal;
}
