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
      (isNum(d.forecast_tomorrow_kwh) ? ' · Prognose ~' + NF0.format(d.forecast_tomorrow_kwh) + ' kWh' : ''));
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
    setText('cFc', fmtKwh(d.forecast_tomorrow_kwh));

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
      render(d);
      store.set('pv.last', JSON.stringify(d));
      setLive('ok', 'Stand ' + timeOf(d.ts));
      showNotice(meta.mock ? 'Beispieldaten (Mock-Modus) – keine echten Messwerte.' : '');
    } catch (err) {
      const cached = store.get('pv.last');
      if (cached) {
        try {
          const d = JSON.parse(cached);
          render(d);
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
    setText('foot', 'pv-dashboard' + (meta.version ? ' ' + meta.version : '') + (meta.mock ? ' · Mock-Modus' : '') + ' · Aktualisierung alle ' + meta.pollSeconds + ' s');
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
