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
      time:   tsToDateStr(t),
      open:   q.open?.[i],
      high:   q.high?.[i],
      low:    q.low?.[i],
      close:  q.close?.[i],
      volume: q.volume?.[i],
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

// Maximum right boundary for the invisible future anchor.
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

function fmtMoney(v) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

// ── Marker helpers ─────────────────────────────────────────────────────────────

function makeStrikeLine(p) {
  const isCall   = p.type === 'call';
  const color    = isCall ? '#aa44ff' : '#00c8ff';
  const typeChar = isCall ? 'C' : 'P';
  let priceVal, title;
  if (p.isSpread) {
    priceVal = (p.leg1Strike + p.leg2Strike) / 2;
    title    = String(p.strike);
  } else {
    priceVal = p.strike;
    const sf = p.strike % 1 === 0 ? p.strike.toFixed(0) : p.strike.toFixed(2);
    title    = `${sf}${typeChar}`;
  }
  return _candlesSeries.createPriceLine({
    price:            priceVal,
    color,
    lineWidth:        1,
    lineStyle:        LightweightCharts.LineStyle.Dashed,
    axisLabelVisible: true,
    title,
  });
}

function createMarkers(positions) {
  _markerData = new Map();
  for (const p of positions) {
    const key = `${dateToStr(p.tradeDate)}|${p.type}`;
    if (!_markerData.has(key)) {
      _markerData.set(key, { positions: [], type: p.type, dateStr: dateToStr(p.tradeDate) });
    }
    _markerData.get(key).positions.push(p);
  }
  const markers = [];
  for (const [, group] of _markerData) {
    const count = group.positions.length;
    markers.push({
      time:     group.dateStr,
      position: 'belowBar',
      shape:    'arrowUp',
      color:    group.type === 'put' ? '#00c8ff' : '#aa44ff',
      size:     Math.min(count + 1, 4),
      text:     '',
    });
  }
  markers.sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0);
  // v5: markers are added as a separate series overlay
  if (_markerSeries) { _chart.removeSeries(_markerSeries); _markerSeries = null; }
  if (markers.length) {
    _markerSeries = _chart.addSeries(LightweightCharts.LineSeries, {
      lastValueVisible:       false,
      priceLineVisible:       false,
      crosshairMarkerVisible: false,
      autoscaleInfoProvider:  () => null,
      color:                  'transparent',
    });
    _markerSeries.setData(_lastOhlcv.map(d => ({ time: d.time, value: d.close })));
  }
}

function setMarkerHighlight(highlightKey) {
  if (!_candlesSeries) return;
  const markers = [];
  for (const [key, group] of _markerData) {
    const count = group.positions.length;
    const isPut = group.type === 'put';
    const isHL  = key === highlightKey;
    markers.push({
      time:     group.dateStr,
      position: 'belowBar',
      shape:    'arrowUp',
      color:    isPut
        ? (isHL ? '#40e0ff' : '#00c8ff')
        : (isHL ? '#cc88ff' : '#aa44ff'),
      size:     isHL ? Math.min(count + 2, 5) : Math.min(count + 1, 4),
      text:     '',
    });
  }
  markers.sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0);
}

// ── Chart ─────────────────────────────────────────────────────────────────────

let _chart         = null;
let _candlesSeries = null;
let _markerSeries  = null;
let _markerData    = new Map(); // "YYYY-MM-DD|put"|"YYYY-MM-DD|call" → { positions[], type, dateStr }
let _hoveredLine   = null;      // temporary price line from card mouseenter
let _lockedLine    = null;      // locked price line from card click
let _lockedPos     = null;      // position object currently locked
let _lastOhlcv     = null;   // cached for filter toggle
let _lastPositions = null;   // cached active positions for filter toggle
let _filterLarge   = true;   // true = show only notional ≥ $1M
let _currentMonths = 12;     // current timeframe selection (months of history)

function buildChart(ohlcv, positions) {
  const container = document.getElementById('chart-container');
  if (_chart) { _chart.remove(); _chart = null; _markerSeries = null; }
  // Clean up overlays from any previous chart instance
  container.querySelectorAll('.chart-overlay').forEach(el => el.remove());

  // Calculate chart height from known fixed element heights
  const tabBarH  = document.querySelector('.tab-bar')?.offsetHeight  ?? 37;
  const headerH  = document.querySelector('#header')?.offsetHeight   ?? 56;
  const hdrRuleH = document.querySelector('.hdr-rule')?.offsetHeight ?? 2;
  const secHdrH  = document.querySelector('#sec01 .section-hdr')?.offsetHeight ?? 55;
  const legendH  = document.querySelector('#sec01 .legend-bar')?.offsetHeight  ?? 34;
  const chartH   = window.innerHeight - tabBarH - headerH - hdrRuleH - secHdrH - legendH;
  container.style.height = chartH + 'px';

  _chart = LightweightCharts.createChart(container, {
    width:  container.clientWidth,
    height: container.clientHeight,
    layout: {
      background: { type: 'solid', color: '#07090d' },
      textColor:  '#c8d8ea',
      fontSize:   12,
      panes: { separatorColor: '#1c2535' },
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
      borderColor:                  '#1c2535',
      secondsVisible:               false,
      rightOffset:                  10,
      barSpacing:                   10,
      fixLeftEdge:                  false,
      fixRightEdge:                 false,
      lockVisibleTimeRangeOnResize: false,
    },
  });

  const ohlcDisplay = document.createElement('div');
  ohlcDisplay.id = 'ohlc-display';
  ohlcDisplay.className = 'chart-overlay';
  container.appendChild(ohlcDisplay);

  const tooltip = document.createElement('div');
  tooltip.id = 'chart-tooltip';
  tooltip.className = 'chart-overlay';
  container.appendChild(tooltip);

  const _months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  _chart.subscribeCrosshairMove(param => {
    // — OHLC display —
    if (!param.time || !param.seriesData) {
      ohlcDisplay.style.display = 'none';
    } else {
      const bar = param.seriesData.get(_candlesSeries);
      if (!bar) {
        ohlcDisplay.style.display = 'none';
      } else {
        const chg = bar.close - bar.open;
        const pct = ((chg / bar.open) * 100).toFixed(2);
        const col = chg >= 0 ? '#00e676' : '#ff3355';
        ohlcDisplay.style.display = 'block';
        ohlcDisplay.innerHTML = `
          <span style="color:var(--fg3)">O</span> <span style="color:${col}">${bar.open.toFixed(2)}</span>
          <span style="color:var(--fg3)">H</span> <span style="color:${col}">${bar.high.toFixed(2)}</span>
          <span style="color:var(--fg3)">L</span> <span style="color:${col}">${bar.low.toFixed(2)}</span>
          <span style="color:var(--fg3)">C</span> <span style="color:${col}">${bar.close.toFixed(2)}</span>
          <span style="color:${col}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)} (${chg >= 0 ? '+' : ''}${pct}%)</span>
        `;
      }
    }

    // — Marker tooltip —
    if (!param.time || !param.point) { tooltip.style.display = 'none'; return; }
    const putGroup  = _markerData.get(`${param.time}|put`);
    const callGroup = _markerData.get(`${param.time}|call`);
    const groups    = [putGroup, callGroup].filter(Boolean);
    if (!groups.length) { tooltip.style.display = 'none'; return; }

    const dp  = String(param.time).split('-');
    let html  = `<div class="ctt-date">${_months[+dp[1]-1]} ${+dp[2]}, ${dp[0]}</div>`;
    for (const group of groups) {
      for (const p of group.positions) {
        const typeChar  = p.type === 'call' ? 'C' : 'P';
        const sf        = p.isSpread ? p.strike : (p.strike % 1 === 0 ? p.strike.toFixed(0) : p.strike.toFixed(2));
        const strikeStr = p.isSpread ? String(p.strike) : `${sf}${typeChar}`;
        const notional  = fmtMoney(p.contracts * p.originalPremium * 100);
        const color     = p.type === 'call' ? '#aa44ff' : '#00c8ff';
        html += `<div class="ctt-row" style="color:${color}">${strikeStr} · ${p.contracts.toLocaleString()}x · ${notional}</div>`;
      }
    }
    tooltip.innerHTML = html;

    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const tw = tooltip.offsetWidth  || 200;
    const th = tooltip.offsetHeight || 60;
    let tx = param.point.x + 12;
    let ty = param.point.y - th / 2;
    if (tx + tw > cw - 10) tx = param.point.x - tw - 12;
    if (ty < 4) ty = 4;
    if (ty + th > ch - 4) ty = ch - th - 4;
    tooltip.style.left    = `${tx}px`;
    tooltip.style.top     = `${ty}px`;
    tooltip.style.display = 'block';
  });

  window.addEventListener('resize', () => {
    if (!_chart) return;
    const newTabBarH  = document.querySelector('.tab-bar')?.offsetHeight  ?? 37;
    const newHeaderH  = document.querySelector('#header')?.offsetHeight   ?? 56;
    const newHdrRuleH = document.querySelector('.hdr-rule')?.offsetHeight ?? 2;
    const newSecHdrH  = document.querySelector('#sec01 .section-hdr')?.offsetHeight ?? 55;
    const newLegendH  = document.querySelector('#sec01 .legend-bar')?.offsetHeight  ?? 34;
    const newH = window.innerHeight - newTabBarH - newHeaderH - newHdrRuleH - newSecHdrH - newLegendH;
    container.style.height = newH + 'px';
    _chart.applyOptions({ width: container.clientWidth, height: newH });
  });

  // ── OHLC bars ────────────────────────────────────────────
  const candles = _chart.addSeries(LightweightCharts.BarSeries, {
    upColor:          '#00e676',
    downColor:        '#ff3355',
    openVisible:      true,
    priceLineVisible: false, // disabled — we add a full-width one below
    autoscaleInfoProvider: orig => {
      const res = orig();
      if (!res) return res;
      const pad = (res.priceRange.maxValue - res.priceRange.minValue) * 0.1;
      return { priceRange: { minValue: Math.max(0, res.priceRange.minValue - pad), maxValue: res.priceRange.maxValue + pad } };
    },
  });
  candles.setData(ohlcv);
  _candlesSeries = candles;

  const volumeSeries = _chart.addSeries(LightweightCharts.HistogramSeries, {
    color: '#1c2535',
    priceFormat: { type: 'volume' },
  }, 1); // pane index 1 = separate pane below

  volumeSeries.setData(ohlcv.map(d => ({
    time:  d.time,
    value: d.volume ?? 0,
    color: d.close >= d.open ? 'rgba(0,230,118,0.4)' : 'rgba(255,51,85,0.4)',
  })));

  // Size the panes: 80% price, 20% volume
  _chart.panes()[0].setHeight(Math.floor(container.clientHeight * 0.80));
  _chart.panes()[1].setHeight(Math.floor(container.clientHeight * 0.20));

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
  const futureLine = _chart.addSeries(LightweightCharts.LineSeries, {
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

  // ── Trade-date markers ────────────────────────────────────
  // One arrowUp marker per unique (tradeDate × type) pair — all active positions.
  // Size scales with how many positions share that date/type combo.
  // createMarkers disabled — v5 migration pending

  // Set the initial visible range to the current timeframe selection.
  applyTimeframe(_currentMonths);
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

      const markerKey = `${dateToStr(p.tradeDate)}|${p.type}`;

      card.addEventListener('mouseenter', () => {
        setMarkerHighlight(markerKey);
        if (_lockedPos !== p && _chart) {
          if (_hoveredLine) { _candlesSeries.removePriceLine(_hoveredLine); _hoveredLine = null; }
          _hoveredLine = makeStrikeLine(p);
        }
      });

      card.addEventListener('mouseleave', () => {
        if (_lockedPos !== p) {
          const lockedKey = _lockedPos ? `${dateToStr(_lockedPos.tradeDate)}|${_lockedPos.type}` : null;
          setMarkerHighlight(lockedKey);
          if (_hoveredLine) { _candlesSeries.removePriceLine(_hoveredLine); _hoveredLine = null; }
        }
      });

      card.addEventListener('click', () => {
        if (_lockedPos === p) {
          // Unlock
          _lockedPos = null;
          if (_lockedLine)  { _candlesSeries.removePriceLine(_lockedLine);  _lockedLine  = null; }
          if (_hoveredLine) { _candlesSeries.removePriceLine(_hoveredLine); _hoveredLine = null; }
          setMarkerHighlight(null);
          card.classList.remove('pos-card--locked');
        } else {
          // Lock this card
          if (_lockedLine) _candlesSeries.removePriceLine(_lockedLine);
          document.querySelectorAll('.pos-card--locked').forEach(c => c.classList.remove('pos-card--locked'));
          _lockedPos  = p;
          _lockedLine = makeStrikeLine(p);
          if (_hoveredLine) { _candlesSeries.removePriceLine(_hoveredLine); _hoveredLine = null; }
          card.classList.add('pos-card--locked');
          setMarkerHighlight(markerKey);
        }
      });
    });
}

function buildSidebar(ticker, active, expired) {
  // Reset hover/lock state whenever a new ticker is loaded
  _lockedPos = null;
  if (_lockedLine  && _candlesSeries) { _candlesSeries.removePriceLine(_lockedLine);  } _lockedLine  = null;
  if (_hoveredLine && _candlesSeries) { _candlesSeries.removePriceLine(_hoveredLine); } _hoveredLine = null;

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
