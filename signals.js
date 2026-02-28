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
  let totalCandidates = 0; // tickers that passed basic grouping before quality filters

  for (const [ticker, { puts, calls }] of Object.entries(byTicker)) {
    // Criterion 1: MUST have both puts sold AND calls bought
    if (!puts.length || !calls.length) continue;
    totalCandidates++;

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

    // Criterion 2: activity on at least 2 different trade dates
    const allPos = [...puts, ...calls];
    const uniqueTradeDates = new Set(
      allPos.map(p => parseDate(p.trade_date)).filter(Boolean).map(d => d.toDateString())
    );
    if (uniqueTradeDates.size < 2) continue;

    // Criterion 3: at least one put with 90+ DTE
    const has90DtePut = puts.some(p => {
      const exp = parseDate(p.expiry);
      return exp && Math.floor((exp - today) / 86_400_000) >= 90;
    });
    if (!has90DtePut) continue;

    // Aggregate stats
    const tradeDates = allPos.map(p => parseDate(p.trade_date)).filter(Boolean);
    const expiries   = allPos.map(p => parseDate(p.expiry)).filter(Boolean);

    const minTradeDate = new Date(Math.min(...tradeDates));
    const maxExpiry    = new Date(Math.max(...expiries));

    const daysActive = Math.max(1, Math.ceil((today - minTradeDate) / 86_400_000));

    const totalPuts  = puts.reduce((s, p)  => s + (parseInt(p.contracts) || 0), 0);
    const totalCalls = calls.reduce((s, p) => s + (parseInt(p.contracts) || 0), 0);
    const totalContracts = totalPuts + totalCalls;

    // ── Weighted put score by DTE ────────────────────────────
    // Longer DTE = stronger conviction (more premium at risk, further out)
    let putScore = 0;
    for (const p of puts) {
      const contracts = parseInt(p.contracts) || 0;
      const expiry    = parseDate(p.expiry);
      const dte       = expiry ? Math.floor((expiry - today) / 86_400_000) : 0;
      const weight    = dte >= 180 ? 3 : dte >= 90 ? 2 : dte >= 30 ? 1.5 : 1;
      putScore += contracts * weight;
    }

    // ── Weighted call score by original premium ──────────────
    // Higher premium = bigger directional bet
    let callScore = 0;
    for (const p of calls) {
      const contracts = parseInt(p.contracts) || 0;
      const orig      = parseFloat(p.original_premium ?? p.current_premium ?? p.premium);
      // 0 or unparseable = not yet fetched → use 1.5 as neutral default
      const weight    = (!isFinite(orig) || orig === 0) ? 1.5
                      : orig > 5  ? 2
                      : orig >= 1 ? 1.5
                      : 1;
      callScore += contracts * weight;
    }

    // ── Confluence bonus ─────────────────────────────────────
    // Having both puts sold AND calls bought signals coordinated conviction
    const rawScore      = putScore + callScore;
    const confluenceBonus = 1.5; // always true here — confluence is required to reach this point
    const score         = rawScore * confluenceBonus;

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

    const parsePos = p => ({
      strike:          parseFloat(p.strike),
      expiry:          parseDate(p.expiry),
      contracts:       parseInt(p.contracts) || 0,
      originalPremium: parseFloat(p.original_premium ?? p.current_premium ?? p.premium),
      tradeDate:       parseDate(p.trade_date),
    });

    signals.push({
      ticker,
      totalPuts,
      totalCalls,
      totalContracts,
      putScore,
      callScore,
      rawScore,
      confluenceBonus,
      putCount:  puts.length,
      callCount: calls.length,
      daysActive,
      minTradeDate,
      maxExpiry,
      confluenceDate,
      score,
      rawPuts:  puts.map(parsePos),
      rawCalls: calls.map(parsePos),
    });
  }

  // Sort by score descending, hard cap at 8
  signals.sort((a, b) => b.score - a.score);
  const qualified = signals.length;
  const capped = signals.slice(0, 8);

  // Criterion 4: badge by absolute score threshold
  capped.forEach(s => {
    s.badge = s.score > 150_000 ? 'STRONG' : s.score > 75_000 ? 'NOTABLE' : 'WATCH';
  });

  // Attach qualifying metadata for the header
  capped._qualified     = qualified;      // passed all filters before cap
  capped._totalCandidates = totalCandidates; // had both puts + calls

  return capped;
}

// ── AI Analysis ───────────────────────────────────────────────────────────────

const aiCache    = new Map(); // ticker → analysis text (session cache)
const signalMap  = new Map(); // ticker → signal object (populated in renderSignals)

function buildAiPrompt(s) {
  const today = new Date(); today.setHours(0, 0, 0, 0);

  const fmtPos = (p, type) => {
    const dte  = p.expiry ? Math.floor((p.expiry - today) / 86_400_000) : '?';
    const prem = isFinite(p.originalPremium) && p.originalPremium > 0
      ? `$${p.originalPremium.toFixed(2)}`
      : 'N/A';
    const strike = isFinite(p.strike) ? `$${p.strike}` : '?';
    return `  ${type}: ${strike} strike | ${p.contracts.toLocaleString()} contracts | ` +
           `${prem} premium | expiry ${p.expiry ? p.expiry.toLocaleDateString() : '?'} ` +
           `(${dte} DTE) | traded ${p.tradeDate ? p.tradeDate.toLocaleDateString() : '?'}`;
  };

  const putLines  = s.rawPuts.map(p  => fmtPos(p, 'PUT SOLD'));
  const callLines = s.rawCalls.map(p => fmtPos(p, 'CALL BOUGHT'));

  return [
    `Ticker: ${s.ticker}`,
    `Signal strength: ${s.badge} (Bullish Conviction Score: ${fmtScore(s.score)})`,
    `${s.putCount} put-sold position(s) | ${s.callCount} call-bought position(s) | ${s.totalContracts.toLocaleString()} total contracts`,
    `Active for ${s.daysActive} days`,
    ``,
    `Puts sold:`,
    ...putLines,
    ``,
    `Calls bought:`,
    ...callLines,
  ].join('\n');
}

const AI_SYSTEM_PROMPT =
  'You are an expert options flow analyst. Analyze the following institutional ' +
  'options flow data and write a concise 3-4 sentence trade narrative in the ' +
  'style of a professional trader. Focus on: what the flow implies directionally, ' +
  'key strike levels to watch, any notable patterns (repeat flow, large size, ' +
  'unusual expiry), and a specific actionable idea. Be direct and confident. ' +
  'Do not use bullet points. Write in plain conversational trader language.';

async function fetchAiAnalysis(ticker) {
  if (aiCache.has(ticker)) return aiCache.get(ticker);

  const s = signalMap.get(ticker);
  if (!s) throw new Error('Signal data not found');

  if (!CONFIG.ANTHROPIC_KEY || CONFIG.ANTHROPIC_KEY === 'YOUR_KEY_HERE') {
    throw new Error('Set ANTHROPIC_KEY in config.js to enable AI analysis');
  }

  const anthropicUrl = 'https://api.anthropic.com/v1/messages';
  const proxyUrl     = CONFIG.CORS_PROXY + encodeURIComponent(anthropicUrl);

  const payload = JSON.stringify({
    model:      'claude-sonnet-4-6',
    max_tokens: 400,
    system:     AI_SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: buildAiPrompt(s) }],
  });

  let res;
  try {
    res = await fetch(proxyUrl, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         CONFIG.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: payload,
    });
  } catch (netErr) {
    console.error('[AI] Network error:', netErr);
    throw new Error(`Network error: ${netErr.message}`);
  }

  let data;
  try {
    data = await res.json();
  } catch (parseErr) {
    const raw = await res.text().catch(() => '(unreadable)');
    console.error('[AI] Non-JSON response:', raw);
    throw new Error(`Non-JSON response (HTTP ${res.status})`);
  }

  if (!res.ok) {
    const msg = data?.error?.message ?? JSON.stringify(data?.error) ?? `HTTP ${res.status}`;
    console.error('[AI] Anthropic error:', res.status, data);
    throw new Error(`Anthropic ${res.status}: ${msg}`);
  }

  const text = data.content?.[0]?.text;
  if (!text) {
    console.error('[AI] Unexpected response shape:', JSON.stringify(data).slice(0, 300));
    throw new Error('Empty response from AI');
  }

  aiCache.set(ticker, text);
  return text;
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

  // Header strip
  const strongN  = signals.filter(s => s.badge === 'STRONG').length;
  const notableN = signals.filter(s => s.badge === 'NOTABLE').length;
  const qualified = signals._qualified ?? signals.length;
  const total     = signals._totalCandidates ?? qualified;
  const dateStr   = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();
  const summary   = document.getElementById('sig-summary');
  summary.innerHTML = `
    <span class="sum-pill bull-key">TOP SIGNALS · ${dateStr} · ${signals.length} of ${total} tickers qualified</span>
    <span class="sum-pill strong">${strongN} STRONG</span>
    <span class="sum-pill notable">${notableN} NOTABLE</span>
  `;
  summary.hidden = false;

  signalMap.clear();
  signals.forEach(s => signalMap.set(s.ticker, s));

  grid.innerHTML = signals.map(s => {
    const putPct  = Math.round(s.totalPuts / (s.totalPuts + s.totalCalls) * 100);
    const callPct = 100 - putPct;
    const badgeCls  = s.badge === 'STRONG' ? 'badge-strong' : s.badge === 'NOTABLE' ? 'badge-notable' : 'badge-watch';
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
            <div class="stat-val" style="color:var(--up)">${fmtNum(s.totalContracts)}</div>
            <div class="stat-lbl">Bullish Contracts</div>
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
            <span style="color:var(--accent)">${putPct}% puts sold</span>
            <span class="call-color">${callPct}% calls bought</span>
          </div>
        </div>

        <div class="card-footer">
          <div class="card-dates">${dateRange}</div>
          <div class="card-row2">
            <span class="card-score">${fmtScore(s.score)}</span>
            <a class="card-link" href="#" data-ticker="${s.ticker}">View chart →</a>
          </div>
        </div>

        <div class="card-ai">
          <button class="ai-btn" data-ticker="${s.ticker}">◈ AI ANALYSIS</button>
          <div class="ai-result" id="ai-${s.ticker}" hidden></div>
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

  document.getElementById('signals-grid').addEventListener('click', async e => {
    // "View chart →"
    const link = e.target.closest('a[data-ticker]');
    if (link) {
      e.preventDefault();
      load(link.dataset.ticker);
      document.getElementById('sec01-body').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    // "AI ANALYSIS"
    const btn = e.target.closest('.ai-btn');
    if (!btn) return;

    const ticker   = btn.dataset.ticker;
    const resultEl = document.getElementById(`ai-${ticker}`);
    if (!resultEl) return;

    // Already showing a result — toggle visibility
    if (!resultEl.hidden && resultEl.dataset.state === 'done') {
      resultEl.hidden = true;
      btn.textContent = '◈ AI ANALYSIS';
      return;
    }

    // Show spinner
    btn.disabled    = true;
    btn.textContent = '◈ GENERATING…';
    resultEl.hidden = false;
    resultEl.dataset.state = 'loading';
    resultEl.innerHTML = `
      <div class="ai-loading">
        <div class="ai-spinner"></div>
        <span>Analysing flow data…</span>
      </div>`;

    try {
      const text = await fetchAiAnalysis(ticker);
      resultEl.innerHTML     = `<p class="ai-text">${text.replace(/\n/g, '<br>')}</p>`;
      resultEl.dataset.state = 'done';
      btn.disabled    = false;
      btn.textContent = '◈ HIDE ANALYSIS';
    } catch (err) {
      resultEl.innerHTML     = `<p class="ai-error">Error: ${err.message}</p>`;
      resultEl.dataset.state = 'error';
      btn.disabled    = false;
      btn.textContent = '◈ AI ANALYSIS';
    }
  });
});
