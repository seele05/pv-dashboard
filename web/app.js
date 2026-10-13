'use strict';

/* PV-Dashboard – Oberflaeche. Holt /api/meta einmal und /api/pv zyklisch. */

(function () {
  const $ = id => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* privat/blockiert */ } },
  };

  const nf = d => new Intl.NumberFormat('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
  const NF0 = nf(0), NF1 = nf(1), NF2 = nf(2);
  const isNum = v => typeof v === 'number' && isFinite(v);

  let meta = { title: 'PV-Dashboard', pollSeconds: 30, battery: { capacityKwh: 10, minSoc: 10 }, display: { maxPvW: 10000, maxLoadW: 10000, maxBatW: 5000 }, mock: false };
  let timer = null;
  let fcData = null;

  /* ---------- Formatierung ---------- */
  function fmtW(w) {
    if (!isNum(w)) return '–';
    return Math.abs(w) >= 1000 ? NF2.format(w / 1000) + ' kW' : NF0.format(Math.round(w)) + ' W';
  }
  const fmtKwh = v => (isNum(v) ? NF1.format(v) + ' kWh' : '–');
  const fmtPct = v => (isNum(v) ? NF1.format(v) + ' %' : '–');
  const signed = (v, f) => (v > 0 ? '+' : v < 0 ? '−' : '±') + f(Math.abs(v));
  /** Labels aus der API ('12.3 h', '> 72 h', '45 min') mit deutschem Dezimalkomma. */
  const deLabel = s => (typeof s === 'string' ? s.replace(/(\d)\.(\d)/g, '$1,$2') : '–');
  const pctOf = (v, max) => (isNum(v) && max > 0 ? Math.min(100, Math.max(0, Math.abs(v) / max * 100)) : 0);

  function setText(id, text) {
    const el = $(id);
    if (el && el.textContent !== text) el.textContent = text;
  }
  function setWidth(id, pct) {
    $(id).style.width = pct.toFixed(1) + '%';
  }

  /* ---------- Fachlogik der Anzeige (aus dem bisherigen Widget) ---------- */
  function socStatus(soc) {
    if (!isNum(soc)) return 'var(--track)';
    if (soc >= 60) return 'var(--ok)';
    if (soc >= 30) return 'var(--warn)';
    if (soc >= 15) return '#ec835a';
    return 'var(--crit)';
  }

  function sourceInfo(d) {
    const pv = d.pv_w ?? 0, bat = d.bat_w ?? 0;
    const pvOn = pv > 100;
    const batDischarging = bat < -50;
    const batCharging = bat > 50;
    if (pvOn && !batDischarging) return { icon: '☀️', cls: 'solar', label: 'Solar', sub: fmtW(pv) + ' PV' + (batCharging ? ' · Akku lädt' : '') };
    if (pvOn && batDischarging) return { icon: '⚡', cls: 'mixed', label: 'Solar + Akku', sub: fmtW(pv) + ' PV · Akku stützt' };
    if (!pvOn && batDischarging) return { icon: '🔋', cls: 'battery', label: 'Akku', sub: (isNum(d.soc) ? NF0.format(d.soc) + ' % verbleibend' : 'entlädt') };
    if (batCharging) return { icon: '🔌', cls: 'grid', label: 'Netz', sub: 'Akku wird geladen' };
    return { icon: '🔌', cls: 'grid', label: 'Netz', sub: 'Netzbetrieb' };
  }

  const RANGE_TEXT = { infinite: 'Morgen genug', ok: 'Ausreichend', warn: 'Niedrig', crit: 'Kritisch' };
  const DIR_TEXT = { charging: '↑ lädt', discharging: '↓ entlädt', idle: '– Ruhe' };
  const PERIODS = [['heute', 'Heute'], ['woche', '7 Tage'], ['season', 'Quartal'], ['jahr', 'Jahr']];

  /* ---------- Rendern ---------- */
  function render(d) {
    // Energiequelle + Ring
    const src = sourceInfo(d);
    const icon = $('srcIcon');
    icon.textContent = src.icon;
    icon.className = 'source-icon ' + src.cls;
    setText('srcLabel', src.label);
    setText('srcSub', src.sub);
    const circ = 2 * Math.PI * 27;
    const arc = $('socArc');
    arc.style.strokeDasharray = circ.toFixed(2);
    arc.style.strokeDashoffset = (circ * (1 - (isNum(d.soc) ? Math.min(100, Math.max(0, d.soc)) : 0) / 100)).toFixed(2);
    arc.style.stroke = socStatus(d.soc);
    setText('socVal', isNum(d.soc) ? NF0.format(d.soc) + ' %' : '–');
    $('socRing').setAttribute('aria-label', 'Akkustand ' + (isNum(d.soc) ? NF0.format(d.soc) + ' Prozent' : 'unbekannt'));

    // Reichweite (smart = Akku + Prognose gegen Ø 30 Tage)
    const st = d.smart_range_status || d.range_status || 'ok';
    setText('rangeVal', deLabel(d.smart_range_label || d.range_label));
    const badge = $('rangeBadge');
    badge.className = 'badge ' + st;
    setText('rangeBadge', RANGE_TEXT[st] || '');
    setText('rangeNet', isNum(d.net_kw) ? 'Bilanz ' + signed(d.net_kw, v => NF2.format(v)) + ' kW' : 'Bilanz –');
    setText('rangeAvail', (isNum(d.avail_kwh) ? NF1.format(d.avail_kwh) + ' kWh im Akku' : '–') +
      (isNum(d.forecast_tomorrow_kwh) ? ' · Prognose morgen ~' + NF0.format(d.forecast_tomorrow_kwh) + ' kWh' : ''));
    setText('rangePlain', 'Nur Akku bei aktueller Last: ' + deLabel(d.range_label) +
      (d.range_status && d.range_status !== 'infinite' ? ' (' + (RANGE_TEXT[d.range_status] || '') + ')' : ''));

    // Leistung
    const disp = meta.display;
    setText('pvVal', fmtW(d.pv_w));
    setText('loadVal', fmtW(d.load_w));
    setText('batVal', isNum(d.bat_w) ? (d.bat_w > 0 ? '+' : d.bat_w < 0 ? '−' : '') + fmtW(Math.abs(d.bat_w)) : '–');
    setText('fcVal', fmtW(d.forecast_w));
    setText('batDir', DIR_TEXT[d.bat_direction] || '');
    setWidth('pvBar', pctOf(d.pv_w, disp.maxPvW));
    setWidth('loadBar', pctOf(d.load_w, disp.maxLoadW));
    setWidth('batBar', pctOf(d.bat_w, disp.maxBatW));
    setWidth('fcBar', pctOf(d.forecast_w, disp.maxPvW));
    setText('netLine', isNum(d.net_kw) ? (d.net_kw >= 0 ? 'Überschuss ' : 'Defizit ') + NF2.format(Math.abs(d.net_kw)) + ' kW (PV − Verbrauch)' : '');

    // Akku
    setText('batAvail', isNum(d.avail_kwh) ? NF1.format(d.avail_kwh) + ' kWh nutzbar' : '–');
    const socBar = $('socBar');
    socBar.style.width = (isNum(d.soc) ? Math.min(100, Math.max(0, d.soc)) : 0) + '%';
    socBar.style.background = socStatus(d.soc);
    $('socTrack').setAttribute('aria-valuenow', isNum(d.soc) ? String(Math.round(d.soc)) : '0');
    $('minMark').style.left = meta.battery.minSoc + '%';
    setText('minSocText', 'Reserve ' + NF0.format(meta.battery.minSoc) + ' %');
    setText('batState', DIR_TEXT[d.bat_direction] || '–');

    // Heute
    setText('dPv', fmtKwh(d.daily_pv_kwh));
    setText('dLoad', fmtKwh(d.daily_load_kwh));
    setText('dGrid', fmtKwh(d.daily_grid_kwh));
    setText('dWr', fmtKwh(d.wr_eigenverbrauch));
    setText('dNight', fmtKwh(d.kwh_nacht));
    // Vor 17:00 liefert die API (wie das Original) keinen Tageswert; angezeigt wird der bisherige
    const dayPartial = !isNum(d.kwh_tag) && isNum(d.kwh_nacht) && isNum(d.daily_load_kwh)
      ? Math.max(0, d.daily_load_kwh - d.kwh_nacht) : null;
    setText('lDay', dayPartial !== null ? 'Tag ab 6 Uhr (bisher)' : 'Tag 6–17 Uhr');
    setText('dDay', fmtKwh(dayPartial !== null ? dayPartial : d.kwh_tag));
    setText('dEve', fmtKwh(d.kwh_abend));
    const parts = [['s-night', d.kwh_nacht], ['s-day', dayPartial !== null ? dayPartial : d.kwh_tag], ['s-eve', d.kwh_abend]].filter(p => isNum(p[1]) && p[1] > 0);
    const total = parts.reduce((s, p) => s + p[1], 0);
    const bar = $('splitBar');
    bar.replaceChildren(...parts.map(([cls, v]) => {
      const seg = document.createElement('span');
      seg.className = cls;
      seg.style.flex = String(v / total);
      return seg;
    }));

    // Vergleich
    setText('cAvg', fmtKwh(d.avg_30d_kwh));
    deltaCell('cToday', d.delta_pct);
    setText('cYest', fmtKwh(d.yesterday_kwh));
    deltaCell('cYestDelta', d.delta_yesterday_pct);

    // Quoten
    const quotes = $('quotes');
    const cell = (v, cls) => '<div class="qv" role="cell"><b>' + fmtPct(v) + '</b><div class="track"><span class="fill' + cls + '" data-w="' + (isNum(v) ? v : 0) + '"></span></div></div>';
    const html = '<div class="qh" role="columnheader">Zeitraum</div>' +
      '<div class="qh" role="columnheader"><i class="sw sw-load" aria-hidden="true"></i>Autarkie</div>' +
      '<div class="qh" role="columnheader"><i class="sw sw-pv" aria-hidden="true"></i>Eigenverbrauch</div>' +
      PERIODS.map(([key, label]) => '<div class="qp" role="rowheader">' + label + '</div>' +
        cell(d['autarkie_' + key], '') + cell(d['eigenverbrauch_' + key], ' ev')).join('');
    if (quotes._html !== html) {
      quotes.innerHTML = html;
      quotes._html = html;
      quotes.querySelectorAll('.fill[data-w]').forEach(f => { f.style.width = f.dataset.w + '%'; });
    }
  }

  /* ---------- PV-Prognose ---------- */
  // Uhrzeiten in der Zeitzone der Anlage (aus /api/meta), nicht der des Browsers
  const timeHM = ts => new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: meta.timezone || undefined });

  function renderForecastStats(d) {
    const card = $('fcCard');
    const has = isNum(d.forecast_tomorrow_kwh) || isNum(d.forecast_today_kwh) || (fcData && fcData.forecast.length);
    card.hidden = !has;
    if (!has) return;
    $('fcTomorrow').innerHTML = isNum(d.forecast_tomorrow_kwh) ? NF1.format(d.forecast_tomorrow_kwh) + '<small>kWh</small>' : '–';
    setText('fcPeak', isNum(d.forecast_tomorrow_peak_w)
      ? 'Spitze ' + fmtW(d.forecast_tomorrow_peak_w) + ' gegen ' + timeHM(d.forecast_tomorrow_peak_ts) + ' Uhr' : '');
    const cover = $('fcCover');
    if (isNum(d.forecast_tomorrow_kwh) && isNum(d.avg_30d_kwh) && d.avg_30d_kwh > 0) {
      const pct = d.forecast_tomorrow_kwh / d.avg_30d_kwh * 100;
      cover.hidden = false;
      cover.style.setProperty('--cover', pct >= 100 ? 'var(--ok)' : pct >= 60 ? 'var(--warn)' : 'var(--crit)');
      setText('fcCover', NF0.format(pct) + ' % des Ø-Tagesverbrauchs' + (pct >= 100 ? ' – reicht' : pct >= 60 ? ' – knapp' : ' – zu wenig'));
    } else {
      cover.hidden = true;
    }
    setText('fcToday', fmtKwh(d.forecast_today_kwh));
    setText('fcTodayActual', fmtKwh(d.daily_pv_kwh));
    setText('fcTodayRest', fmtKwh(d.forecast_today_remaining_kwh));
    if (isNum(d.forecast_yesterday_kwh) && isNum(d.actual_yesterday_kwh)) {
      const dev = d.forecast_yesterday_kwh > 0 ? (d.actual_yesterday_kwh - d.forecast_yesterday_kwh) / d.forecast_yesterday_kwh * 100 : null;
      setText('fcYesterday', NF1.format(d.forecast_yesterday_kwh) + ' → ' + NF1.format(d.actual_yesterday_kwh) + ' kWh' +
        (isNum(dev) ? ' (' + signed(dev, x => NF0.format(x)) + ' %)' : ''));
    } else {
      setText('fcYesterday', isNum(d.forecast_yesterday_kwh) ? NF1.format(d.forecast_yesterday_kwh) + ' kWh → –' : '–');
    }
  }

  /** Lineare Interpolation einer [[t, w], ...]-Reihe; null ausserhalb oder ueber Luecken > 2 h. */
  function valueAt(series, t) {
    for (let i = 0; i + 1 < series.length; i++) {
      const [t0, v0] = series[i], [t1, v1] = series[i + 1];
      if (t >= t0 && t <= t1) return t1 - t0 > 7_200_000 ? null : v0 + (v1 - v0) * (t - t0) / (t1 - t0);
    }
    return null;
  }

  /** Teilt eine Reihe an Luecken > 2 h, damit die Linie nicht ueber die Nacht verbunden wird. */
  function segments(series) {
    const out = [];
    let cur = [];
    for (const p of series) {
      if (cur.length && p[0] - cur[cur.length - 1][0] > 7_200_000) { out.push(cur); cur = []; }
      cur.push(p);
    }
    if (cur.length) out.push(cur);
    return out;
  }

  function niceMaxKw(maxW) {
    const kw = Math.max(0.5, maxW / 1000);
    const step = [0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50].find(s => kw / s <= 4) || 100;
    return { max: Math.ceil(kw / step) * step, step };
  }

  function renderForecastChart() {
    const el = $('fcChart');
    if (!fcData || $('fcCard').hidden) return;
    const W = Math.max(280, el.clientWidth), H = el.clientHeight || 220;
    const pad = { l: 40, r: 10, t: 22, b: 22 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const { from, to, midnight, forecast, actual } = fcData;
    const now = Date.now();
    const maxW = Math.max(0, ...forecast.map(p => p[1]), ...actual.map(p => p[1]));
    const { max, step } = niceMaxKw(maxW);
    const x = t => pad.l + (t - from) / (to - from) * iw;
    const y = w => pad.t + ih - (w / 1000) / max * ih;

    let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">';
    for (let v = 0; v <= max + 1e-9; v += step) {
      svg += '<line class="grid-line" x1="' + pad.l + '" x2="' + (W - pad.r) + '" y1="' + y(v * 1000) + '" y2="' + y(v * 1000) + '"/>';
      svg += '<text x="' + (pad.l - 6) + '" y="' + (y(v * 1000) + 4) + '" text-anchor="end">' + NF1.format(v).replace(',0', '') + ' kW</text>';
    }
    // Stunden-Achse alle 6 h
    for (let t = from; t <= to; t += 6 * 3_600_000) {
      if (t > from && t < to) svg += '<text x="' + x(t) + '" y="' + (H - 6) + '" text-anchor="middle">' + timeHM(t) + '</text>';
    }
    svg += '<line class="day-sep" x1="' + x(midnight) + '" x2="' + x(midnight) + '" y1="' + (pad.t - 18) + '" y2="' + (pad.t + ih) + '"/>';
    svg += '<text class="day-label" x="' + (pad.l + 4) + '" y="' + (pad.t - 8) + '">Heute</text>';
    svg += '<text class="day-label" x="' + (x(midnight) + 6) + '" y="' + (pad.t - 8) + '">Morgen</text>';

    for (const seg of segments(forecast)) {
      const line = seg.map(p => x(p[0]).toFixed(1) + ',' + y(p[1]).toFixed(1)).join(' L');
      svg += '<path class="fc-area" d="M' + x(seg[0][0]).toFixed(1) + ',' + y(0) + ' L' + line + ' L' + x(seg[seg.length - 1][0]).toFixed(1) + ',' + y(0) + ' Z"/>';
      svg += '<path class="fc-line" d="M' + line + '"/>';
    }
    for (const seg of segments(actual)) {
      if (seg.length > 1) svg += '<path class="act-line" d="M' + seg.map(p => x(p[0]).toFixed(1) + ',' + y(p[1]).toFixed(1)).join(' L') + '"/>';
    }
    if (now > from && now < to) {
      svg += '<line class="now-line" x1="' + x(now) + '" x2="' + x(now) + '" y1="' + pad.t + '" y2="' + (pad.t + ih) + '"/>';
      svg += '<text class="now-label" x="' + (x(now) + 4) + '" y="' + (pad.t + 10) + '">jetzt</text>';
    }
    svg += '<g id="fcHover" visibility="hidden"><line class="cross" id="fcCross" y1="' + pad.t + '" y2="' + (pad.t + ih) + '"/>' +
      '<circle class="dot dot-fc" id="fcDotF" r="4"/><circle class="dot dot-act" id="fcDotA" r="4"/></g>';
    svg += '<rect id="fcHit" x="' + pad.l + '" y="0" width="' + iw + '" height="' + H + '" fill="transparent"/>';
    svg += '</svg>';

    el.querySelector('svg')?.remove();
    el.insertAdjacentHTML('beforeend', svg);

    const tip = $('fcTip');
    const hover = el.querySelector('#fcHover');
    const move = ev => {
      const r = el.getBoundingClientRect();
      const px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
      const t = from + (Math.min(Math.max(px, pad.l), pad.l + iw) - pad.l) / iw * (to - from);
      const vf = valueAt(forecast, t), va = t <= now ? valueAt(actual, t) : null;
      hover.setAttribute('visibility', 'visible');
      const cx = x(t);
      el.querySelector('#fcCross').setAttribute('x1', cx);
      el.querySelector('#fcCross').setAttribute('x2', cx);
      const df = el.querySelector('#fcDotF'), da = el.querySelector('#fcDotA');
      df.setAttribute('visibility', vf === null ? 'hidden' : 'visible');
      da.setAttribute('visibility', va === null ? 'hidden' : 'visible');
      if (vf !== null) { df.setAttribute('cx', cx); df.setAttribute('cy', y(vf)); }
      if (va !== null) { da.setAttribute('cx', cx); da.setAttribute('cy', y(va)); }
      const day = t >= midnight ? 'Morgen' : 'Heute';
      tip.innerHTML = '<b>' + day + ' ' + timeHM(t) + '</b><br>' +
        '<i class="k-fc"></i>Prognose ' + (vf === null ? '–' : fmtW(vf)) +
        (t <= now ? '<br><i class="k-act"></i>Ist ' + (va === null ? '–' : fmtW(va)) : '');
      tip.hidden = false;
      tip.style.left = Math.min(Math.max(cx, 70), W - 70) + 'px';
    };
    const leave = () => { hover.setAttribute('visibility', 'hidden'); tip.hidden = true; };
    const hit = el.querySelector('#fcHit');
    hit.addEventListener('mousemove', move);
    hit.addEventListener('touchstart', move, { passive: true });
    hit.addEventListener('touchmove', move, { passive: true });
    hit.addEventListener('mouseleave', leave);
    hit.addEventListener('touchend', leave);
  }

  function renderForecastTable() {
    if (!fcData) return;
    const { from, midnight, forecast, actual } = fcData;
    const rows = [];
    for (let h = 0; h < 24; h++) {
      const tToday = from + h * 3_600_000;
      const tTomorrow = midnight + h * 3_600_000;
      const ft = valueAt(forecast, tToday), at = valueAt(actual, tToday), fm = valueAt(forecast, tTomorrow);
      if ([ft, at, fm].every(v => v === null || v < 1)) continue;
      rows.push('<tr><td>' + timeHM(tToday) + '</td><td>' + fmtW(ft) + '</td><td>' + fmtW(at) + '</td><td>' + fmtW(fm) + '</td></tr>');
    }
    const html = '<table><thead><tr><th>Uhrzeit</th><th>Prognose heute</th><th>Ist heute</th><th>Prognose morgen</th></tr></thead><tbody>' +
      (rows.join('') || '<tr><td colspan="4">keine Werte</td></tr>') + '</tbody></table>';
    const wrap = $('fcTable');
    if (wrap._html !== html) { wrap.innerHTML = html; wrap._html = html; }
  }

  async function loadForecast() {
    try {
      const res = await fetch('/api/forecast', { cache: 'no-store' });
      if (res.status === 404) { fcData = null; return; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      fcData = await res.json();
      store.set('pv.forecast', JSON.stringify(fcData));
    } catch (_) {
      try { fcData = fcData || JSON.parse(store.get('pv.forecast') || 'null'); } catch (_) { fcData = null; }
    }
  }

  function renderForecast(d) {
    renderForecastStats(d);
    renderForecastChart();
    renderForecastTable();
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderForecastChart, 150);
  });

  function deltaCell(id, v) {
    const el = $(id);
    el.textContent = isNum(v) ? signed(v, x => NF1.format(x)) + ' %' : '–';
    el.className = isNum(v) && v > 10 ? 'delta-up' : isNum(v) && v < -10 ? 'delta-down' : '';
  }

  /* ---------- Status & Laden ---------- */
  function setLive(state, text) {
    $('live').className = 'live ' + state;
    setText('liveText', text);
  }

  function showNotice(text) {
    const n = $('notice');
    n.hidden = !text;
    if (text) n.textContent = text;
  }

  const timeOf = ts => new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  async function load() {
    try {
      const res = await fetch('/api/pv', { cache: 'no-store' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || ('HTTP ' + res.status));
      await loadForecast();
      render(d);
      renderForecast(d);
      store.set('pv.last', JSON.stringify(d));
      setLive('ok', 'Stand ' + timeOf(d.ts));
      showNotice(meta.mock ? 'Beispieldaten (Mock-Modus) – keine echten Messwerte.' : '');
    } catch (err) {
      const cached = store.get('pv.last');
      if (cached) {
        try {
          const d = JSON.parse(cached);
          await loadForecast();
          render(d);
          renderForecast(d);
          setLive('stale', 'Offline · Stand ' + timeOf(d.ts));
        } catch (_) { setLive('err', 'Keine Daten'); }
      } else {
        setLive('err', 'Keine Daten');
      }
      showNotice(navigator.onLine === false ? 'Keine Verbindung – zeige die zuletzt geladenen Werte.' : 'Server liefert gerade keine aktuellen Daten (' + err.message + ').');
    }
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(load, Math.max(5, meta.pollSeconds) * 1000);
  }

  async function init() {
    try {
      const res = await fetch('/api/meta', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const m = await res.json();
      meta = { ...meta, ...m };
      store.set('pv.meta', JSON.stringify(m));
    } catch (_) {
      // offline: zuletzt bekannte Einstellungen, sonst Defaults
      try { meta = { ...meta, ...JSON.parse(store.get('pv.meta') || '{}') }; } catch (_) { /* Defaults */ }
    }
    document.title = meta.title;
    setText('title', meta.title);
    setText('foot', 'pv-dashboard' + (meta.version ? ' ' + meta.version + (meta.revision ? ' · ' + meta.revision : '') : '') + (meta.mock ? ' · Mock-Modus' : '') + ' · Aktualisierung alle ' + meta.pollSeconds + ' s');
    await load();
    schedule();
  }

  // im Hintergrund nicht pollen, beim Zurueckkehren sofort aktualisieren
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearInterval(timer);
    } else {
      load();
      schedule();
    }
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* ohne SW nur keine Offline-Huelle */ });
    });
  }

  init();
})();
