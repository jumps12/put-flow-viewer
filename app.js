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
      };
    })
    .filter(d => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return (
        isFinite(d.strike) && isFinite(d.contracts) && isFinite(d.originalPremium) &&
        d.expiry instanceof Date && d.tradeDate instanceof Date &&
        d.expiry > d.tradeDate &&
        d.expiry >= today
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

// Far future anchor point pushed into the series data so LightweightCharts
// allocates time-axis space for future dates, enabling right-scroll.
function lineFarDate() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 90);
  return d;
}

function dteColor(dte) {
  if (dte >= 180) return '#00BCD4'; // teal
  if (dte >= 90)  return '#4CAF50'; // green
  if (dte >= 30)  return '#FFC107'; // yellow
  return '#F44336';                 // red
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
    const color = dteColor(dte);
    // Market value uses original premium — what was paid at trade time
    const mv    = p.contracts * p.originalPremium * 100;

    // Format: 2027-01-15 | 300P | 4,000x | $36.3M
    const strikeStr = p.strike % 1 === 0 ? p.strike.toFixed(0) : p.strike.toFixed(2);
    const mvStr     = fmtMoney(mv);
    const text      = `${dateToStr(p.expiry)} | ${strikeStr}P | ${p.contracts.toLocaleString()}x | ${mvStr}`;

    const el = document.createElement('div');
    el.className    = 'strike-label';
    el.style.color  = color;
    el.textContent  = text;
    container.appendChild(el);

    _labelData.push({ p, el });
  }

  updateLabelPositions();
}

function updateLabelPositions() {
  if (!_chart || !_candlesSeries || !_labelData.length) return;

  for (const { p, el } of _labelData) {
    const x = _chart.timeScale().timeToCoordinate(dateToStr(lineEndDate()));
    const y = _candlesSeries.priceToCoordinate(p.strike);

    if (x === null || y === null) {
      el.style.display = 'none';
      continue;
    }

    el.style.display = 'block';
    el.style.left    = `${x + 4}px`;
    el.style.top     = `${y}px`;
  }
}

// ── Chart ─────────────────────────────────────────────────────────────────────

let _chart        = null;
let _candlesSeries = null;
let _labelData     = []; // [{ p, el }] — kept in sync with the current chart

function buildChart(ohlcv, positions) {
  const container = document.getElementById('chart-container');

  if (_chart) { _chart.remove(); _chart = null; }

  _chart = LightweightCharts.createChart(container, {
    width:  container.clientWidth,
    height: 540,
    layout: {
      background: { type: 'solid', color: '#0d1117' },
      textColor:  '#c9d1d9',
      fontSize:   12,
    },
    grid: {
      vertLines: { color: '#1c2128' },
      horzLines: { color: '#1c2128' },
    },
    crosshair:       { mode: LightweightCharts.CrosshairMode.Normal },
    handleScroll:    true,
    handleScale:     true,
    rightPriceScale: { borderColor: '#30363d' },
    timeScale: {
      borderColor:                '#30363d',
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

  // ── Candlesticks ────────────────────────────────────────
  const candles = _chart.addCandlestickSeries({
    upColor:         '#2ea043',
    downColor:       '#f85149',
    borderUpColor:   '#2ea043',
    borderDownColor: '#f85149',
    wickUpColor:     '#2ea043',
    wickDownColor:   '#f85149',
  });
  candles.setData(ohlcv);
  _candlesSeries = candles;

  // ── Invisible future line — forces the time axis to render 90 days ahead ──
  // LightweightCharts only allocates time slots for dates present in series data.
  // Without this, the axis stops at the last candle and right-scroll is blocked.
  const lastClose = ohlcv.length ? ohlcv[ohlcv.length - 1].close : 0;
  const futureLine = _chart.addLineSeries({
    color:                  'transparent',
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
  // Each position becomes a horizontal line from trade date → expiry
  for (const p of positions) {
    const dte   = getDTE(p.expiry);
    const color = dteColor(dte);
    const width = strikeLineWidth(p.contracts, p.originalPremium);

    const line = _chart.addLineSeries({
      color,
      lineWidth:              width,
      lineStyle:              LightweightCharts.LineStyle.Solid,
      lastValueVisible:       false,
      priceLineVisible:       false,
      crosshairMarkerVisible: false,
    });

    line.setData([
      { time: dateToStr(p.tradeDate),   value: p.strike },
      { time: dateToStr(lineEndDate()), value: p.strike },
      { time: dateToStr(lineFarDate()), value: p.strike },
    ]);
  }

  // Default view: scroll to right edge (rightOffset:30 gives 30-bar buffer past last candle).
  // scrollToPosition(0) positions the last bar at the right edge minus rightOffset,
  // keeping the chart freely scrollable in both directions.
  _chart.timeScale().scrollToPosition(0, false);

  // Wait one frame for the range to settle, then place labels
  requestAnimationFrame(() => createLabels(positions));
}

// ── Positions table ───────────────────────────────────────────────────────────

function buildTable(positions) {
  const tbody = document.getElementById('positions-body');
  tbody.innerHTML = '';

  if (!positions.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty">No positions on record for this ticker</td></tr>`;
    return;
  }

  [...positions]
    .sort((a, b) => b.strike - a.strike)
    .forEach(p => {
      const dte  = getDTE(p.expiry);
      const col  = dteColor(dte);

      const orig = p.originalPremium;
      const curr = p.currentPremium;

      const plPerCt = (orig - curr) * 100;
      const plTotal = plPerCt * p.contracts;
      const plPct   = orig > 0 ? (orig - curr) / orig * 100 : null;

      // Green when premium has decayed (winning), red when it has grown (losing)
      const plCol = plTotal >= 0 ? '#2ea043' : '#f85149';

      const fmtPl = v => {
        const sign = v >= 0 ? '+' : '−';
        const abs  = Math.abs(v);
        if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
        if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
        return `${sign}$${abs.toFixed(0)}`;
      };

      const plPctStr = plPct !== null
        ? `${plPct >= 0 ? '+' : '−'}${Math.abs(plPct).toFixed(1)}%`
        : '—';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><b style="color:${col}">$${p.strike.toFixed(2)}</b></td>
        <td>${p.expiry.toLocaleDateString()}</td>
        <td style="color:${col}">${dte}d</td>
        <td>${p.contracts.toLocaleString()}</td>
        <td>$${orig.toFixed(2)}</td>
        <td style="color:${plCol}">$${curr.toFixed(2)}</td>
        <td style="color:${plCol}">${plPerCt >= 0 ? '+' : '−'}$${Math.abs(plPerCt).toFixed(2)}</td>
        <td style="color:${plCol}">${fmtPl(plTotal)}</td>
        <td style="color:${plCol}">${plPctStr}</td>
        <td>${p.tradeDate.toLocaleDateString()}</td>
      `;
      tbody.appendChild(tr);
    });
}

// ── Status bar ────────────────────────────────────────────────────────────────

function setStatus(msg, cls = '') {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className   = cls;
  el.hidden      = !msg;
}

function setTickerBar(ticker, positions) {
  const el = document.getElementById('ticker-bar');
  if (!positions.length) { el.hidden = true; return; }
  const totalMV = positions.reduce((s, p) => s + p.contracts * p.originalPremium * 100, 0);
  el.innerHTML = `
    <span class="tb-ticker">${ticker}</span>
    <span class="tb-sep">·</span>
    <span class="tb-stat"><b>${positions.length}</b> put position${positions.length !== 1 ? 's' : ''}</span>
    <span class="tb-sep">·</span>
    <span class="tb-stat">Deployed: <b class="tb-mv">${fmtMoney(totalMV)}</b></span>
  `;
  el.hidden = false;
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function load(raw) {
  const ticker = raw.trim().toUpperCase();
  if (!ticker) return;

  document.getElementById('ticker-input').value = ticker;
  history.replaceState(null, '', `#${ticker}`);

  setStatus(`Loading ${ticker}…`, 'info');
  document.getElementById('ticker-bar').hidden = true;
  document.getElementById('load-btn').disabled = true;

  try {
    const [positions, ohlcv] = await Promise.all([
      fetchPutFlowData(ticker),
      fetchOHLCV(ticker),
    ]);

    if (!ohlcv.length) throw new Error(`No price data returned for "${ticker}"`);

    buildChart(ohlcv, positions);
    buildTable(positions);
    setTickerBar(ticker, positions);

    if (!positions.length) {
      setStatus(`No put positions on record for ${ticker}`, 'warning');
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
