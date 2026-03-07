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
      const strikeRaw = String(p.strike ?? '');
      const spread    = strikeRaw.includes('/');

      let strike, leg1Strike, leg2Strike, netLabel;
      if (spread) {
        const parts = strikeRaw.replace(/[CP]/gi, '').split('/').map(s => parseFloat(s.trim()));
        parts.sort((a, b) => a - b);
        leg1Strike = parts[0];
        leg2Strike = parts[1];
        strike     = strikeRaw;                   // raw string for display e.g. "140/230C"
        netLabel   = p.net_label ?? '';
      } else {
        strike = parseFloat(strikeRaw);
      }

      // Spreads: use net_premium for notional; single legs: use original_premium.
      const orig = spread
        ? parseFloat(p.net_premium ?? p.original_premium)
        : parseFloat(p.original_premium ?? p.current_premium ?? p.premium);
      const curr = parseFloat(p.current_premium ?? p.premium);

      return {
        strike,
        leg1Strike,
        leg2Strike,
        isSpread:        spread,
        netLabel,
        expiry:          parseDate(p.expiry),
        contracts:       parseInt(p.contracts),
        originalPremium: orig,
        currentPremium:  curr,
        tradeDate:       parseDate(p.trade_date),
        type:            (p.type ?? 'put').toLowerCase(),
      };
    })
    .filter(d => {
      const strikeOk = d.isSpread
        ? isFinite(d.leg1Strike) && isFinite(d.leg2Strike)
        : isFinite(d.strike);
      return (
        strikeOk && isFinite(d.contracts) && isFinite(d.originalPremium) &&
        d.expiry instanceof Date && d.tradeDate instanceof Date &&
        d.expiry > d.tradeDate
      );
    });
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

// Maximum right boundary for strike lines and the invisible future anchor.
// LightweightCharts allocates time-axis space for every date present in any
// series. Clamping to 90 days prevents far-dated expiries (e.g. 2028) from
// stretching the chart to years of empty whitespace.
function lineFarDate() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 90);
  return d;
}

// Set the visible time window. `months` is how much history to show;
// the right edge is always today + 90 days (the future anchor).
function applyTimeframe(months) {
  if (!_chart) return;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const from  = new Date(today);
  from.setMonth(from.getMonth() - months);
  const to = lineFarDate(); // today + 90 days
  _chart.timeScale().setVisibleRange({ from: dateToStr(from), to: dateToStr(to) });
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

  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  for (const p of positions) {
    const dte   = getDTE(p.expiry);
    const color = p.type === 'call' ? '#aa44ff' : dteColor(dte);
    const mv    = p.contracts * p.originalPremium * 100;
    const mvStr = fmtMoney(mv);
    const dateLabel = `${months[p.expiry.getMonth()]} ${p.expiry.getDate()} ${p.expiry.getFullYear()}`;

    let text, labelStrike;
    if (p.isSpread) {
      // e.g. "Jan 17 2027 · 140/230C · 1,150x · $1.2M NET DEBIT"
      const netStr = p.netLabel ? ` ${p.netLabel}` : '';
      text        = `${dateLabel} · ${p.strike} · ${p.contracts.toLocaleString()}x · ${mvStr}${netStr}`;
      labelStrike = (p.leg1Strike + p.leg2Strike) / 2;
    } else {
      const typeChar  = p.type === 'call' ? 'C' : 'P';
      const strikeStr = p.strike % 1 === 0 ? p.strike.toFixed(0) : p.strike.toFixed(2);
      text        = `${dateLabel} · ${strikeStr}${typeChar} · ${p.contracts.toLocaleString()}x · ${mvStr}`;
      labelStrike = p.strike;
    }

    const el = document.createElement('div');
    el.className   = 'strike-label';
    el.style.color = color;
    el.textContent = text;
    container.appendChild(el);

    _labelData.push({ p, el, labelStrike });
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

  // Labels sit at the right end of their line. Because strike lines are clamped
  // to today+90, use the same clamped date so the label tracks the line tip.
  const farDate = lineFarDate();
  const items = _labelData.map(({ p, el, labelStrike }) => {
    const y      = _candlesSeries.priceToCoordinate(labelStrike ?? p.strike);
    const tipDate = p.expiry < farDate ? p.expiry : farDate;
    const xe     = _chart.timeScale().timeToCoordinate(dateToStr(tipDate));
    const x      = xe !== null ? Math.min(xe + 4, maxLabelX) : null;
    return { el, x, y };
  });

  // Hide off-screen items
  for (const item of items) {
    if (item.x === null || item.y === null) item.el.style.display = 'none';
  }

  // Resolve vertical overlaps for all labels together (all on the right side now).
  const visible = items.filter(i => i.x !== null && i.y !== null);
  visible.sort((a, b) => a.y - b.y);
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

let _chart         = null;
let _candlesSeries = null;
let _labelData     = []; // [{ p, el }] — kept in sync with the current chart
let _strikeData    = []; // [{ p, series, color, width }] — one entry per strike line
let _lastOhlcv     = null;   // cached for filter toggle
let _lastPositions = null;   // cached active positions for filter toggle
let _filterLarge   = true;   // true = show only notional ≥ $1M
let _currentMonths = 12;     // current timeframe selection (months of history)

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

  // Responsive resize
  new ResizeObserver(() => {
    if (_chart) _chart.applyOptions({ width: container.clientWidth });
  }).observe(container);

  // ── OHLC bars ────────────────────────────────────────────
  const candles = _chart.addBarSeries({
    upColor:          '#00e676',
    downColor:        '#ff3355',
    openVisible:      true,
    priceLineVisible: false, // disabled — we add a full-width one below
    autoscaleInfoProvider: orig => {
      const res = orig();
      if (!res) return res;
      const pad = (res.priceRange.maxValue - res.priceRange.minValue) * 0.1;
      return { priceRange: { minValue: res.priceRange.minValue - pad, maxValue: res.priceRange.maxValue + pad } };
    },
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
    autoscaleInfoProvider:  () => null,
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

  // ── Filter positions for chart display ───────────────────
  // >$1M mode: keep all positions with notional ≥ $1M, no price-range gate.
  //            High-notional strikes are always relevant regardless of distance.
  // ALL mode:  apply ±60% price range to avoid clutter from cheap distant OTM positions.
  // Both modes: sort largest-notional first, cap at 8 lines.
  const lastPrice = ohlcv.length ? ohlcv[ohlcv.length - 1].close : 0;

  const chartPositions = positions
    .filter(p => {
      const notional = p.contracts * p.originalPremium * 100;
      if (_filterLarge) {
        return notional >= 1_000_000;
      } else {
        const strikeRef = p.isSpread ? (p.leg1Strike + p.leg2Strike) / 2 : p.strike;
        return strikeRef >= lastPrice * 0.40 && strikeRef <= lastPrice * 1.60;
      }
    })
    .sort((a, b) => (b.contracts * b.originalPremium * 100) - (a.contracts * a.originalPremium * 100))
    .slice(0, 8);

  // ── Strike lines ─────────────────────────────────────────
  // Puts: solid line, DTE color. Calls: dashed purple.
  // Store refs so sidebar hover can brighten/restore each line.
  // autoscaleInfoProvider: () => null keeps strike lines from stretching the y-axis.
  _strikeData = [];
  for (const p of chartPositions) {
    const isCall  = p.type === 'call';
    const dte     = getDTE(p.expiry);
    const color   = isCall ? '#aa44ff' : dteColor(dte);
    const width   = strikeLineWidth(p.contracts, p.originalPremium);
    const style   = isCall
      ? LightweightCharts.LineStyle.Dashed
      : LightweightCharts.LineStyle.Solid;

    // Clamp the right endpoint to today+90 so far-dated expiries (e.g. 2028)
    // don't stretch the time axis into years of empty whitespace.
    const farDate = lineFarDate();
    const lineEnd = p.expiry < farDate ? p.expiry : farDate;

    if (p.isSpread) {
      // Draw one line per leg; store both refs so hover can brighten/dim together.
      const makeLeg = strikeVal => {
        const s = _chart.addLineSeries({
          color,
          lineWidth:              width,
          lineStyle:              style,
          lastValueVisible:       false,
          priceLineVisible:       false,
          crosshairMarkerVisible: false,
          autoscaleInfoProvider:  () => null,
        });
        s.setData([
          { time: dateToStr(p.tradeDate), value: strikeVal },
          { time: dateToStr(lineEnd),     value: strikeVal },
        ]);
        return s;
      };
      const series1 = makeLeg(p.leg1Strike);
      const series2 = makeLeg(p.leg2Strike);
      _strikeData.push({ p, series1, series2, isSpread: true, color, width });
    } else {
      const series = _chart.addLineSeries({
        color,
        lineWidth:              width,
        lineStyle:              style,
        lastValueVisible:       false,
        priceLineVisible:       false,
        crosshairMarkerVisible: false,
        autoscaleInfoProvider:  () => null,
      });
      series.setData([
        { time: dateToStr(p.tradeDate), value: p.strike },
        { time: dateToStr(lineEnd),     value: p.strike },
      ]);
      _strikeData.push({ p, series, color, width });
    }
  }

  // Set the initial visible range to the current timeframe selection.
  // Done inline (not in rAF) so the label positions computed one frame later
  // already reflect the correct coordinate mapping.
  applyTimeframe(_currentMonths);

  // Wait one frame for the range to settle, then place labels.
  requestAnimationFrame(() => createLabels(chartPositions));
}

// ── Sidebar (section 02 — Active Positions) ───────────────────────────────────

function renderSidebarCards(positions, isExpired) {
  const cardsEl = document.getElementById('sidebar-cards');

  if (!positions.length) {
    cardsEl.innerHTML = `<div class="sidebar-empty">${isExpired ? 'No expired positions' : 'No active positions'}</div>`;
    return;
  }

  cardsEl.innerHTML = '';

  // Deduplicate spread positions: one card per unique (type+expiry+tradeDate+strike).
  const seenSpreads = new Set();
  const deduped = [...positions]
    .sort((a, b) => b.tradeDate - a.tradeDate)
    .filter(p => {
      if (!p.isSpread) return true;
      const key = `${p.type}|${dateToStr(p.expiry)}|${dateToStr(p.tradeDate)}|${p.strike}`;
      if (seenSpreads.has(key)) return false;
      seenSpreads.add(key);
      return true;
    });

  deduped.forEach(p => {
      const dte      = getDTE(p.expiry);
      const isCall   = p.type === 'call';
      const typeCol  = isCall ? '#aa44ff' : dteColor(dte);
      const typeStr  = isCall ? 'CALL' : 'PUT';

      const dteLabel  = isExpired ? 'Expired' : 'DTE';
      const dteVal    = isExpired
        ? p.expiry.toLocaleDateString()
        : `<span style="color:${dteColor(dte)}">${dte}d</span>`;

      let strikeDisplay, notionalLabel;
      if (p.isSpread) {
        strikeDisplay = p.strike;                       // raw string e.g. "140/230C"
        notionalLabel = p.netLabel || '';
      } else {
        const sf = p.strike % 1 === 0 ? p.strike.toFixed(0) : p.strike.toFixed(2);
        strikeDisplay = `$${sf}`;
        notionalLabel = '';
      }

      const card = document.createElement('div');
      card.className = isExpired ? 'pos-card pos-card--expired' : 'pos-card';
      card.innerHTML = `
        <div class="pos-card-top">
          <span class="pos-type-badge" style="color:${typeCol}">${typeStr}</span>
          ${p.isSpread ? '<span class="pos-spread-badge">SPREAD</span>' : ''}
          <span class="pos-strike" style="color:${typeCol}">${strikeDisplay}</span>
        </div>
        <div class="pos-details">
          <span class="pos-detail-lbl">Expiry</span>
          <span class="pos-detail-val">${p.expiry.toLocaleDateString()}</span>
          <span class="pos-detail-lbl">${dteLabel}</span>
          <span class="pos-detail-val">${dteVal}</span>
          <span class="pos-detail-lbl">Contracts</span>
          <span class="pos-detail-val">${p.contracts.toLocaleString()}</span>
          <span class="pos-detail-lbl">${notionalLabel}</span>
          <span class="pos-detail-val" style="color:var(--fg3)">${fmtMoney(p.contracts * p.originalPremium * 100)}</span>
          <span class="pos-detail-lbl">Traded</span>
          <span class="pos-detail-val">${p.tradeDate.toLocaleDateString()}</span>
        </div>
      `;
      cardsEl.appendChild(card);

      // Highlight the corresponding strike line(s) when hovering this card
      card.addEventListener('mouseenter', () => {
        const entry = _strikeData.find(d => d.p === p);
        if (!entry) return;
        const hoverColor = p.type === 'call' ? '#cc66ff' : '#40dfff';
        if (entry.isSpread) {
          entry.series1.applyOptions({ color: hoverColor, lineWidth: Math.min(entry.width + 2, 4) });
          entry.series2.applyOptions({ color: hoverColor, lineWidth: Math.min(entry.width + 2, 4) });
        } else {
          entry.series.applyOptions({ color: hoverColor, lineWidth: Math.min(entry.width + 2, 4) });
        }
        // Dim all other strike lines
        _strikeData.forEach(e => {
          if (e === entry) return;
          const dim = e.color + '33';
          if (e.isSpread) {
            e.series1.applyOptions({ color: dim });
            e.series2.applyOptions({ color: dim });
          } else {
            e.series.applyOptions({ color: dim });
          }
        });
      });
      card.addEventListener('mouseleave', () => {
        // Restore all strike lines to their original colour and width
        _strikeData.forEach(e => {
          if (e.isSpread) {
            e.series1.applyOptions({ color: e.color, lineWidth: e.width });
            e.series2.applyOptions({ color: e.color, lineWidth: e.width });
          } else {
            e.series.applyOptions({ color: e.color, lineWidth: e.width });
          }
        });
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

    // Cache for filter toggle rebuilds
    _lastOhlcv     = ohlcv;
    _lastPositions = active;

    // Reset to 1Y default on every new ticker load
    _currentMonths = 12;
    document.querySelectorAll('.tf-btn').forEach(b =>
      b.classList.toggle('tf-btn--active', b.dataset.months === '12')
    );

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

  // Drive label positions from the browser's own paint loop so HTML overlays
  // stay pixel-perfect against the chart canvas on every scroll and zoom frame.
  // updateLabelPositions() is a no-op when no chart or labels are loaded.
  (function syncLabels() {
    updateLabelPositions();
    requestAnimationFrame(syncLabels);
  })();

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

  // Notional filter toggle: '>$1M only' ↔ 'ALL'
  document.getElementById('filter-btn').addEventListener('click', () => {
    _filterLarge = !_filterLarge;
    const filterBtn = document.getElementById('filter-btn');
    filterBtn.textContent = _filterLarge ? '>$1M' : 'ALL';
    filterBtn.classList.toggle('filter-btn--all', !_filterLarge);
    if (_lastOhlcv && _lastPositions) buildChart(_lastOhlcv, _lastPositions);
  });

  // Timeframe selector buttons (3M / 6M / 1Y / 2Y)
  document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _currentMonths = parseInt(btn.dataset.months);
      document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('tf-btn--active'));
      btn.classList.add('tf-btn--active');
      applyTimeframe(_currentMonths);
    });
  });

  // Restore ticker from URL hash (e.g. index.html#SPY)
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash) { input.value = hash; load(hash); }
});
