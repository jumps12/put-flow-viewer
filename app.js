// ─── Put Flow Viewer ──────────────────────────────────────────────────────────

// ── Positions (from pre-exported JSON) ────────────────────────────────────────

async function fetchPutFlowData(ticker) {
  const res = await fetch('./positions.json');
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error('positions.json not found — run fetch_premiums.py first');
    }
    throw new Error(`Failed to load positions.json: HTTP ${res.status}`);
  }

  const all = await res.json();
  return all
    .filter(p => String(p.symbol ?? '').trim().toUpperCase() === ticker)
    .map(p => {
      // original_premium may be null if the column was added after this row was entered;
      // fall back to current_premium so older rows still render.
      const orig = parseFloat(p.original_premium ?? p.current_premium ?? p.premium);
      const curr = parseFloat(p.current_premium ?? p.premium);
      return {
        strike:          parseFloat(p.strike),
        expiry:          parseDate(p.expiry),
        contracts:       parseInt(p.contracts),
        originalPremium: orig,
        currentPremium:  curr,
        tradeDate:       parseDate(p.trade_date),
        type:            (p.type ?? 'put').toLowerCase(), // 'put' or 'call'
      };
    })
    .filter(d =>
      isFinite(d.strike) && isFinite(d.contracts) && isFinite(d.originalPremium) &&
      d.expiry instanceof Date && d.tradeDate instanceof Date &&
      d.expiry > d.tradeDate
    );
}

// ── Yahoo Finance ──────────────────────────────────────────────────────────────

async function fetchOHLCV(ticker) {
  const now   = Math.floor(Date.now() / 1000);
  const start = now - 2 * 365 * 24 * 3600;  // 2 years back
  const end   = now + 2   * 24 * 3600;      // 2-day buffer for timezone edge cases

  const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
                 `?period1=${start}&period2=${end}&interval=1d`;
  const url = CONFIG.CORS_PROXY + encodeURIComponent(target);

  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new Error(`Network error: ${e.message}. Check your CORS proxy in config.js.`);
  }
  if (!res.ok) throw new Error(`Price data HTTP ${res.status} — is the ticker valid?`);

  const json = await res.json();
  if (json.chart?.error) {
    throw new Error(`Yahoo Finance: ${json.chart.error.description || 'unknown error'}`);
  }

  const result = json.chart?.result?.[0];
  if (!result) throw new Error(`No price data found for "${ticker}"`);

  const timestamps = result.timestamp ?? [];
  const q          = result.indicators?.quote?.[0] ?? {};

  return timestamps
    .map((t, i) => ({
      time:  tsToDateStr(t),
      open:  q.open?.[i],
      high:  q.high?.[i],
      low:   q.low?.[i],
      close: q.close?.[i],
    }))
    .filter(d => d.open != null && d.high != null && d.low != null && d.close != null);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function cleanNum(v) {
  return parseFloat(String(v ?? '').replace(/[$,%\s,]/g, ''));
}

function parseDate(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();

  // MM/DD/YYYY or M/D/YYYY
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdy) {
    let yr = +mdy[3];
    if (yr < 100) yr += 2000;
    return new Date(yr, +mdy[1] - 1, +mdy[2]);
  }

  // YYYY-MM-DD — treat as local (not UTC) to avoid off-by-one
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);

  // Fallback: native parse, normalise to local midnight
  const d = new Date(s);
  if (!isNaN(d)) return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return null;
}

function tsToDateStr(ts) {
  const d = new Date(ts * 1000);
  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function dateToStr(d) {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function getDTE(expiry) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exp = new Date(expiry.getFullYear(), expiry.getMonth(), expiry.getDate());
  return Math.floor((exp - today) / 86_400_000);
}

// Visible right endpoint of each line (where label sits): today + 30 days.
function lineEndDate() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 30);
  return d;
}

// Far future anchor point pushed into the series data so LightweightCharts
// allocates time-axis space for future dates, enabling right-scroll.
function lineFarDate() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 90);
  return d;
}

function dteColor(dte) {
  if (dte >= 180) return '#00c8ff'; // cyan
  if (dte >= 90)  return '#00e676'; // green
  if (dte >= 30)  return '#ffb300'; // amber
  return '#ff3355';                 // red
}

function strikeLineWidth(contracts, premium) {
  const mv = contracts * premium * 100;
  if (mv > 2_000_000) return 3;
  if (mv >   500_000) return 2;
  return 1;
}

function fmtMoney(v) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

// ── Strike labels ─────────────────────────────────────────────────────────────

function createLabels(positions) {
  // Remove any labels left over from a previous load
  document.querySelectorAll('.strike-label').forEach(el => el.remove());
  _labelData = [];

  const container = document.getElementById('chart-container');

  for (const p of positions) {
    const dte   = getDTE(p.expiry);
    const color = p.type === 'call' ? '#aa44ff' : dteColor(dte);
    // Market value uses original premium — what was paid at trade time
    const mv    = p.contracts * p.originalPremium * 100;

    // Format: Jan 26 2027 · 95C · 20,000x · $18.9M  (C for calls, P for puts)
    const typeChar  = p.type === 'call' ? 'C' : 'P';
    const strikeStr = p.strike % 1 === 0 ? p.strike.toFixed(0) : p.strike.toFixed(2);
    const mvStr     = fmtMoney(mv);
    const months    = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const dateLabel = `${months[p.expiry.getMonth()]} ${p.expiry.getDate()} ${p.expiry.getFullYear()}`;
    const text      = `${dateLabel} · ${strikeStr}${typeChar} · ${p.contracts.toLocaleString()}x · ${mvStr}`;

    const el = document.createElement('div');
    el.className    = 'strike-label';
    el.style.color  = color;
    // Puts: centered horizontally under the line midpoint.
    // Calls: keep the default right-side, vertically-centered position.
    if (p.type === 'put') el.style.transform = 'translateX(-50%) translateY(3px)';
    el.textContent  = text;
    container.appendChild(el);

    _labelData.push({ p, el });
  }

  updateLabelPositions();
}

function updateLabelPositions() {
  if (!_chart || !_candlesSeries || !_labelData.length) return;

  const container   = document.getElementById('chart-container');
  const priceScaleW = 75;
  const maxLabelX   = container.clientWidth - priceScaleW;
  // Approximate rendered label height (10px font × 1.6 line-height + 2px padding)
  const LABEL_H     = 18;

  // Compute x per type:
  //   Puts  → midpoint of the line (trade date … expiry), label is translateX(-50%) centered
  //   Calls → right end (expiry) + 4 px offset, label is left-aligned
  const items = _labelData.map(({ p, el }) => {
    const y = _candlesSeries.priceToCoordinate(p.strike);
    let x;
    if (p.type === 'put') {
      const x1 = _chart.timeScale().timeToCoordinate(dateToStr(p.tradeDate));
      const x2 = _chart.timeScale().timeToCoordinate(dateToStr(p.expiry));
      x = (x1 !== null && x2 !== null) ? (x1 + x2) / 2 : (x2 ?? x1);
    } else {
      const xe = _chart.timeScale().timeToCoordinate(dateToStr(p.expiry));
      x = xe !== null ? Math.min(xe + 4, maxLabelX) : null;
    }
    return { el, x, y };
  });

  // Hide anything off-screen
  for (const item of items) {
    if (item.x === null || item.y === null) item.el.style.display = 'none';
  }

  // Resolve overlaps: sort visible labels by Y, then push each one down
  // if it would collide with the one above it.
  const visible = items
    .filter(i => i.x !== null && i.y !== null)
    .sort((a, b) => a.y - b.y);

  for (let i = 0; i < visible.length; i++) {
    visible[i].adjY = i === 0
      ? visible[i].y
      : Math.max(visible[i].y, visible[i - 1].adjY + LABEL_H);
  }

  for (const item of visible) {
    item.el.style.display = 'block';
    item.el.style.left    = `${item.x}px`;
    item.el.style.top     = `${item.adjY}px`;
  }
}

// ── Chart ─────────────────────────────────────────────────────────────────────

let _chart        = null;
let _candlesSeries = null;
let _labelData     = []; // [{ p, el }] — kept in sync with the current chart
let _strikeData    = []; // [{ p, series, color, width }] — one entry per strike line

function buildChart(ohlcv, positions) {
  const container = document.getElementById('chart-container');

  if (_chart) { _chart.remove(); _chart = null; }

  _chart = LightweightCharts.createChart(container, {
    width:  container.clientWidth,
    height: 540,
    layout: {
      background: { type: 'solid', color: '#07090d' },
      textColor:  '#c8d8ea',
      fontSize:   12,
    },
    grid: {
      vertLines: { color: '#111520' },
      horzLines: { color: '#111520' },
    },
    crosshair:       { mode: LightweightCharts.CrosshairMode.Normal },
    handleScroll:    true,
    handleScale:     true,
    rightPriceScale: { borderColor: '#1c2535' },
    timeScale: {
      borderColor:                '#1c2535',
      secondsVisible:             false,
      rightOffset:                10,
      barSpacing:                 10,
      fixLeftEdge:                false,
      fixRightEdge:               false,
      lockVisibleTimeRangeOnResize: false,
    },
  });

  // Responsive resize — also reposition labels
  new ResizeObserver(() => {
    if (_chart) _chart.applyOptions({ width: container.clientWidth });
    updateLabelPositions();
  }).observe(container);

  // Reposition labels on every pan / zoom
  _chart.timeScale().subscribeVisibleLogicalRangeChange(updateLabelPositions);

  // ── OHLC bars ────────────────────────────────────────────
  const candles = _chart.addBarSeries({
    upColor:          '#00e676',
    downColor:        '#ff3355',
    openVisible:      true,
    priceLineVisible: false, // disabled — we add a full-width one below
  });
  candles.setData(ohlcv);
  _candlesSeries = candles;

  // ── Invisible future line — forces the time axis to render 90 days ahead ──
  // LightweightCharts only allocates time slots for dates present in series data.
  // Without this, the axis stops at the last candle and right-scroll is blocked.
  const lastClose = ohlcv.length ? ohlcv[ohlcv.length - 1].close : 0;

  // ── Full-width current price line ────────────────────────
  // createPriceLine() spans the entire visible chart width (unlike the built-in
  // priceLineVisible which only draws to the last candle date).
  candles.createPriceLine({
    price:            lastClose,
    color:            '#00c8ff',
    lineWidth:        1,
    lineStyle:        LightweightCharts.LineStyle.Dashed,
    axisLabelVisible: true,
    title:            '',
  });
  const futureLine = _chart.addLineSeries({
    color:                  '#07090d', // matches chart background — effectively invisible
    lineWidth:              1,
    lastValueVisible:       false,
    priceLineVisible:       false,
    crosshairMarkerVisible: false,
  });
  const futurePts = [];
  const futureStart = new Date();
  futureStart.setHours(0, 0, 0, 0);
  for (let i = 1; i <= 90; i++) {
    const d = new Date(futureStart);
    d.setDate(d.getDate() + i);
    futurePts.push({ time: dateToStr(d), value: lastClose });
  }
  futureLine.setData(futurePts);

  // ── Strike lines ─────────────────────────────────────────
  // Puts: solid line, DTE color. Calls: dashed purple.
  // Store refs so sidebar hover can brighten/restore each line.
  _strikeData = [];
  for (const p of positions) {
    const isCall  = p.type === 'call';
    const dte     = getDTE(p.expiry);
    const color   = isCall ? '#aa44ff' : dteColor(dte);
    const width   = strikeLineWidth(p.contracts, p.originalPremium);
    const style   = isCall
      ? LightweightCharts.LineStyle.Dashed
      : LightweightCharts.LineStyle.Solid;

    const series = _chart.addLineSeries({
      color,
      lineWidth:              width,
      lineStyle:              style,
      lastValueVisible:       false,
      priceLineVisible:       false,
      crosshairMarkerVisible: false,
    });

    series.setData([
      { time: dateToStr(p.tradeDate), value: p.strike },
      { time: dateToStr(p.expiry),    value: p.strike },
    ]);

    _strikeData.push({ p, series, color, width });
  }

  // Default view: scroll to right edge (rightOffset:30 gives 30-bar buffer past last candle).
  // scrollToPosition(0) positions the last bar at the right edge minus rightOffset,
  // keeping the chart freely scrollable in both directions.
  _chart.timeScale().scrollToPosition(0, false);

  // Wait one frame for the range to settle, then place labels
  requestAnimationFrame(() => createLabels(positions));
}

// ── Sidebar (section 02 — Active Positions) ───────────────────────────────────

function renderSidebarCards(positions, isExpired) {
  const cardsEl = document.getElementById('sidebar-cards');

  if (!positions.length) {
    cardsEl.innerHTML = `<div class="sidebar-empty">${isExpired ? 'No expired positions' : 'No active positions'}</div>`;
    return;
  }

  const fmtPl = v => {
    const sign = v >= 0 ? '+' : '−';
    const abs  = Math.abs(v);
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
    return `${sign}$${abs.toFixed(0)}`;
  };

  cardsEl.innerHTML = '';

  [...positions]
    .sort((a, b) => b.tradeDate - a.tradeDate)
    .forEach(p => {
      const dte      = getDTE(p.expiry);
      const isCall   = p.type === 'call';
      const typeCol  = isCall ? '#aa44ff' : dteColor(dte);
      const typeStr  = isCall ? 'CALL' : 'PUT';

      const orig     = p.originalPremium;
      const curr     = p.currentPremium;
      const plTotal  = (orig - curr) * 100 * p.contracts;
      const plPct    = orig > 0 ? (orig - curr) / orig * 100 : null;
      const plCol    = plTotal >= 0 ? '#00e676' : '#ff3355';

      const plPctStr = plPct !== null
        ? ` (${plPct >= 0 ? '+' : '−'}${Math.abs(plPct).toFixed(1)}%)`
        : '';

      const strikeStr = p.strike % 1 === 0 ? p.strike.toFixed(0) : p.strike.toFixed(2);
      const dteLabel  = isExpired ? 'Expired' : 'DTE';
      const dteVal    = isExpired
        ? p.expiry.toLocaleDateString()
        : `<span style="color:${dteColor(dte)}">${dte}d</span>`;

      const card = document.createElement('div');
      card.className = isExpired ? 'pos-card pos-card--expired' : 'pos-card';
      card.innerHTML = `
        <div class="pos-card-top">
          <span class="pos-type-badge" style="color:${typeCol}">${typeStr}</span>
          <span class="pos-strike" style="color:${typeCol}">$${strikeStr}</span>
          <span class="pos-pl" style="color:${plCol}">${fmtPl(plTotal)}${plPctStr}</span>
        </div>
        <div class="pos-details">
          <span class="pos-detail-lbl">Expiry</span>
          <span class="pos-detail-val">${p.expiry.toLocaleDateString()}</span>
          <span class="pos-detail-lbl">${dteLabel}</span>
          <span class="pos-detail-val">${dteVal}</span>
          <span class="pos-detail-lbl">Contracts</span>
          <span class="pos-detail-val">${p.contracts.toLocaleString()}</span>
          <span></span>
          <span class="pos-detail-val" style="color:var(--fg3)">${fmtMoney(p.contracts * p.originalPremium * 100)}</span>
          <span class="pos-detail-lbl">Traded</span>
          <span class="pos-detail-val">${p.tradeDate.toLocaleDateString()}</span>
        </div>
      `;
      cardsEl.appendChild(card);

      // Highlight the corresponding strike line when hovering this card
      card.addEventListener('mouseenter', () => {
        const entry = _strikeData.find(d => d.p === p);
        if (!entry) return;
        const hoverColor = p.type === 'call' ? '#cc66ff' : '#40dfff';
        entry.series.applyOptions({ color: hoverColor, lineWidth: Math.min(entry.width + 2, 4) });
      });
      card.addEventListener('mouseleave', () => {
        const entry = _strikeData.find(d => d.p === p);
        if (!entry) return;
        entry.series.applyOptions({ color: entry.color, lineWidth: entry.width });
      });
    });
}

function buildSidebar(ticker, active, expired) {
  const infoEl = document.getElementById('sidebar-info');
  const totalMV = active.reduce((s, p) => s + p.contracts * p.originalPremium * 100, 0);
  infoEl.textContent = active.length
    ? `${ticker} · ${fmtMoney(totalMV)} deployed`
    : `${ticker} · no active positions`;

  // Reset to ACTIVE tab
  document.querySelectorAll('.stab').forEach(t => t.classList.remove('stab-on'));
  document.querySelector('.stab[data-tab="active"]').classList.add('stab-on');

  // Wire tabs — reassigning onclick replaces any previous handler
  document.querySelectorAll('.stab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.stab').forEach(t => t.classList.remove('stab-on'));
      tab.classList.add('stab-on');
      renderSidebarCards(tab.dataset.tab === 'expired' ? expired : active, tab.dataset.tab === 'expired');
    };
  });

  renderSidebarCards(active, false);
}

// ── Status bar ────────────────────────────────────────────────────────────────

function setStatus(msg, cls = '') {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className   = cls;
  el.hidden      = !msg;
}

// ── Live clock ────────────────────────────────────────────────────────────────

function startClock() {
  function tick() {
    const now  = new Date();
    const timeEl = document.getElementById('clock-time');
    const dateEl = document.getElementById('clock-date');
    if (timeEl) timeEl.textContent = now.toLocaleTimeString('en-US', {
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    if (dateEl) dateEl.textContent = now.toLocaleDateString('en-US', {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    }).toUpperCase();
  }
  tick();
  setInterval(tick, 1000);
}

// ── Collapsible sections ───────────────────────────────────────────────────────

function initCollapsibles() {
  document.querySelectorAll('.collapse-btn').forEach(btn => {
    const body = document.getElementById(btn.dataset.target);
    if (!body) return;
    btn.addEventListener('click', () => {
      const willCollapse = !body.classList.contains('collapsed');
      body.classList.toggle('collapsed', willCollapse);
      btn.classList.toggle('open', !willCollapse);
    });
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function load(raw) {
  const ticker = raw.trim().toUpperCase();
  if (!ticker) return;

  document.getElementById('ticker-input').value = ticker;
  history.replaceState(null, '', `#${ticker}`);

  setStatus(`Loading ${ticker}…`, 'info');
  document.getElementById('sidebar-info').textContent = 'Loading…';
  document.getElementById('sidebar-cards').innerHTML  = '<div class="sidebar-empty">Loading…</div>';
  document.getElementById('load-btn').disabled = true;

  try {
    const [allPositions, ohlcv] = await Promise.all([
      fetchPutFlowData(ticker),
      fetchOHLCV(ticker),
    ]);

    if (!ohlcv.length) throw new Error(`No price data returned for "${ticker}"`);

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const active  = allPositions.filter(p => p.expiry >= today);
    const expired = allPositions.filter(p => p.expiry <  today);

    buildChart(ohlcv, active);
    buildSidebar(ticker, active, expired);

    if (!active.length) {
      setStatus(`No active positions on record for ${ticker}`, 'warning');
    } else {
      setStatus('', '');
    }
  } catch (err) {
    setStatus(err.message, 'error');
    console.error(err);
  } finally {
    document.getElementById('load-btn').disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  startClock();
  initCollapsibles();

  const input = document.getElementById('ticker-input');
  const btn   = document.getElementById('load-btn');

  // Force uppercase as the user types
  input.addEventListener('input', e => {
    const pos = e.target.selectionStart;
    e.target.value = e.target.value.toUpperCase();
    e.target.setSelectionRange(pos, pos);
  });

  btn.addEventListener('click',  () => load(input.value));
  input.addEventListener('keydown', e => { if (e.key === 'Enter') load(input.value); });

  // Restore ticker from URL hash (e.g. index.html#SPY)
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash) { input.value = hash; load(hash); }
});
