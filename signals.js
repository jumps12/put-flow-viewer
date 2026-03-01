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

// ── Signal analysis ───────────────────────────────────────────────────────────

async function loadSignals() {
  const res = await fetch('./positions.json');
  if (!res.ok) throw new Error('positions.json not found — run fetch_premiums.py first');
  const all = await res.json();

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

    if (!badge) continue;

    signals.push({
      ticker, badge,
      totalNotional, putNotional, callNotional,
      puts, calls,
      daysActive, minTradeDate, maxExpiry,
      tier1Triggers: tier1, tier2Triggers: tier2, deprioritize: dep,
    });
  }

  // Sort: STRONG before NOTABLE, then by total notional descending
  signals.sort((a, b) => {
    const order = { STRONG: 2, NOTABLE: 1 };
    return (order[b.badge] - order[a.badge]) || (b.totalNotional - a.totalNotional);
  });

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
  const qualified = signals._qualified    ?? signals.length;
  const tracked   = signals._totalTracked ?? qualified;
  const dateStr   = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();
  const summary   = document.getElementById('sig-summary');
  summary.innerHTML = `
    <span class="sum-pill bull-key">TOP SIGNALS · ${dateStr} · ${qualified} tickers qualified out of ${tracked} tracked</span>
    <span class="sum-pill strong">${strongN} STRONG</span>
    <span class="sum-pill notable">${notableN} NOTABLE</span>
  `;
  summary.hidden = false;

  grid.innerHTML = signals.map(s => {
    const badgeCls  = s.badge === 'STRONG' ? 'badge-strong' : 'badge-notable';
    const dateRange = `${fmtDate(s.minTradeDate)} → ${fmtDate(s.maxExpiry)}`;

    const hasBoth = s.puts.length > 0 && s.calls.length > 0;
    const stratLine = hasBoth
      ? `PUT SOLD <span class="card-strat-bull">▲ BULLISH</span> + CALL BOUGHT`
      : s.puts.length
        ? `PUT SOLD <span class="card-strat-bull">▲ BULLISH</span>`
        : `CALL BOUGHT <span class="card-strat-bull">▲ BULLISH</span>`;

    const putPct  = s.totalNotional > 0 ? Math.round(s.putNotional  / s.totalNotional * 100) : 0;
    const callPct = 100 - putPct;

    return `
      <div class="signal-card">
        <div class="card-top">
          <span class="card-ticker">${s.ticker}</span>
          <span class="card-badge ${badgeCls}">${s.badge}</span>
        </div>

        <div class="card-strat">${stratLine}</div>

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

        ${hasBoth ? `
        <div class="ratio-wrap">
          <div class="ratio-bar">
            <div class="ratio-seg puts-seg"  style="flex:${s.putNotional}"></div>
            <div class="ratio-seg calls-seg" style="flex:${s.callNotional}"></div>
          </div>
          <div class="ratio-labels">
            <span style="color:var(--accent)">${putPct}% puts</span>
            <span class="call-color">${callPct}% calls</span>
          </div>
        </div>` : ''}

        <div class="card-footer">
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
