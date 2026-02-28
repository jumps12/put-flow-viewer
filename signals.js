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

// ── Signal analysis ───────────────────────────────────────────────────────────

async function loadSignals() {
  const res = await fetch('./positions.json');
  if (!res.ok) throw new Error('positions.json not found — run fetch_premiums.py first');
  const all = await res.json();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Filter to active, valid positions only
  const active = all.filter(p => {
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
  });

  // Group by ticker → { puts: [], calls: [] }
  const byTicker = {};
  for (const p of active) {
    const sym = String(p.symbol ?? '').trim().toUpperCase();
    if (!sym) continue;
    if (!byTicker[sym]) byTicker[sym] = { puts: [], calls: [] };
    if ((p.type ?? 'put').toLowerCase() === 'call') {
      byTicker[sym].calls.push(p);
    } else {
      byTicker[sym].puts.push(p);
    }
  }

  const signals = [];

  for (const [ticker, { puts, calls }] of Object.entries(byTicker)) {
    // Confluence requires at least one put AND one call
    if (!puts.length || !calls.length) continue;

    // Check: any put-call pair with trade dates within 7 days of each other
    let hasConfluence = false;
    outer: for (const put of puts) {
      const pd = parseDate(put.trade_date);
      if (!pd) continue;
      for (const call of calls) {
        const cd = parseDate(call.trade_date);
        if (!cd) continue;
        if (Math.abs(pd - cd) <= 7 * 86_400_000) {
          hasConfluence = true;
          break outer;
        }
      }
    }
    if (!hasConfluence) continue;

    // Aggregate stats
    const allPos = [...puts, ...calls];

    const tradeDates = allPos.map(p => parseDate(p.trade_date)).filter(Boolean);
    const expiries   = allPos.map(p => parseDate(p.expiry)).filter(Boolean);

    const minTradeDate = new Date(Math.min(...tradeDates));
    const maxExpiry    = new Date(Math.max(...expiries));

    const daysActive = Math.max(1, Math.ceil((today - minTradeDate) / 86_400_000));

    const totalPuts  = puts.reduce((s, p)  => s + (parseInt(p.contracts)  || 0), 0);
    const totalCalls = calls.reduce((s, p) => s + (parseInt(p.contracts) || 0), 0);

    const score = (totalPuts + totalCalls) * daysActive;

    // Earliest confluence window — find the closest put-call pair dates
    let closestGap = Infinity;
    let confluenceDate = minTradeDate;
    for (const put of puts) {
      const pd = parseDate(put.trade_date);
      if (!pd) continue;
      for (const call of calls) {
        const cd = parseDate(call.trade_date);
        if (!cd) continue;
        const gap = Math.abs(pd - cd);
        if (gap < closestGap) {
          closestGap = gap;
          confluenceDate = pd < cd ? pd : cd;
        }
      }
    }

    signals.push({
      ticker,
      totalPuts,
      totalCalls,
      putCount:  puts.length,
      callCount: calls.length,
      daysActive,
      minTradeDate,
      maxExpiry,
      confluenceDate,
      score,
    });
  }

  // Sort by score descending
  signals.sort((a, b) => b.score - a.score);

  // Assign STRONG (top 25%) / NOTABLE (rest)
  const strongCount = Math.max(1, Math.ceil(signals.length * 0.25));
  signals.forEach((s, i) => {
    s.badge = i < strongCount ? 'STRONG' : 'NOTABLE';
  });

  return signals;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderSignals(signals) {
  const grid = document.getElementById('signals-grid');

  if (!signals.length) {
    grid.innerHTML = `
      <div class="sig-empty">
        <div class="sig-empty-icon">◈</div>
        <div>No confluence signals found</div>
        <div class="sig-empty-sub">Signals appear when a ticker has puts sold and calls bought within a 7-day window — a bullish confluence pattern.</div>
      </div>`;
    return;
  }

  // Summary pills
  const strongN  = signals.filter(s => s.badge === 'STRONG').length;
  const notableN = signals.length - strongN;
  const summary  = document.getElementById('sig-summary');
  summary.innerHTML = `
    <span class="sum-pill bull-key">PUT SOLD + CALL BOUGHT = BULL CONFLUENCE</span>
    <span class="sum-pill strong">${strongN} STRONG</span>
    <span class="sum-pill notable">${notableN} NOTABLE</span>
    <span class="sum-pill total">${signals.length} total tickers</span>
  `;
  summary.hidden = false;

  grid.innerHTML = signals.map(s => {
    const putPct  = Math.round(s.totalPuts  / (s.totalPuts + s.totalCalls) * 100);
    const callPct = 100 - putPct;
    const badgeCls = s.badge === 'STRONG' ? 'badge-strong' : 'badge-notable';
    const dateRange = `${fmtDate(s.minTradeDate)} → ${fmtDate(s.maxExpiry)}`;

    return `
      <div class="signal-card">
        <div class="card-top">
          <span class="card-ticker">${s.ticker}</span>
          <span class="card-badge ${badgeCls}">${s.badge}</span>
        </div>

        <div class="card-strat">PUT SOLD <span class="card-strat-bull">▲ BULLISH</span> + CALL BOUGHT</div>

        <div class="card-stats">
          <div class="stat">
            <div class="stat-val put-color">${fmtNum(s.totalPuts)}</div>
            <div class="stat-lbl">Puts Sold</div>
          </div>
          <div class="stat-divider"></div>
          <div class="stat">
            <div class="stat-val call-color">${fmtNum(s.totalCalls)}</div>
            <div class="stat-lbl">Calls Bought</div>
          </div>
          <div class="stat-divider"></div>
          <div class="stat">
            <div class="stat-val">${s.daysActive}</div>
            <div class="stat-lbl">Days active</div>
          </div>
        </div>

        <div class="ratio-wrap">
          <div class="ratio-bar">
            <div class="ratio-seg puts-seg" style="flex:${s.totalPuts}"></div>
            <div class="ratio-seg calls-seg" style="flex:${s.totalCalls}"></div>
          </div>
          <div class="ratio-labels">
            <span class="put-color">${putPct}% puts sold</span>
            <span class="call-color">${callPct}% calls bought</span>
          </div>
        </div>

        <div class="card-footer">
          <div class="card-dates">${dateRange}</div>
          <div class="card-row2">
            <span class="card-score">Score: ${fmtScore(s.score)}</span>
            <a class="card-link" href="index.html#${s.ticker}">View chart →</a>
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
});
