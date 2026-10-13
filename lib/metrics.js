'use strict';

/*
 * Kennzahlen des PV-Dashboards. Portiert aus dem Node-RED-Flow
 * (reference/node-red/pv-tab.flow.json):
 *   - "Berechnen + JSON Response"      -> computePayload()
 *   - "store 22:00 + 30d avg berechnen" -> average30d()
 *   - "store 7d/Jahreszeit/Jahr ..."    -> periodSums()
 *   - quoten()/quot()                   -> quote()
 * Alle Funktionen sind rein (keine I/O, Zeit nur ueber Parameter).
 *
 * Bewusste Abweichungen vom Original stehen jeweils am Code und in der README.
 */

const { localDateKey, startOfLocalDay, quarterStartKey, yearStartKey } = require('./time');
const { simulate } = require('./range');


function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

/** Rundet auf `digits` Nachkommastellen; null bleibt null (wie `x !== null ? Math.round(x*10)/10 : null`). */
function round(v, digits = 1) {
    if (v === null || v === undefined) return null;
    const f = 10 ** digits;
    return Math.round(v * f) / f;
}


/**
 * Reichweiten-Einstufung, identisch fuer normale und smarte Reichweite:
 *   > 72 h -> '> 72 h' ok | >= 8 h ok | >= 3 h warn | >= 1 h crit | < 1 h 'x min' crit
 */
function classifyRange(hours) {
    if (hours > 72) return { label: '> 72 h', status: 'ok' };
    if (hours >= 8) return { label: hours.toFixed(1) + ' h', status: 'ok' };
    if (hours >= 3) return { label: hours.toFixed(1) + ' h', status: 'warn' };
    if (hours >= 1) return { label: hours.toFixed(1) + ' h', status: 'crit' };
    return { label: Math.round(hours * 60) + ' min', status: 'crit' };
}


/**
 * Autarkie und "Eigenverbrauch" (wie im Original: Last / PV) in %, auf 0,1 gerundet,
 * auf 0..100 begrenzt. Fehlende oder 0-Werte bei Last/PV -> null.
 */
function quote(load, pv, grid) {
    if (!load || !pv || grid === null || grid === undefined) {
        return { autarkie: null, eigenverbrauch: null };
    }
    return {
        autarkie: Math.round(Math.max(0, Math.min(100, (load - grid) / load * 100)) * 10) / 10,
        eigenverbrauch: Math.round(Math.max(0, Math.min(100, load / pv * 100)) * 10) / 10,
    };
}


/**
 * Ø der letzten 30 Tageswerte > 1 kWh aus der Tagesreihe (inkl. des laufenden
 * Tages, wie im Original).
 * @param {{time:number, v:number|null}[]} rows Tagesmaxima, aelteste zuerst
 */
function average30d(rows) {
    const vals = (rows || []).filter(r => isNum(r.v) && r.v > 1).map(r => r.v);
    const last30 = vals.slice(-30);
    return last30.length > 0 ? last30.reduce((a, b) => a + b, 0) / last30.length : null;
}


/**
 * "Gestern" = vorletzter Tageswert > 1 kWh (wie im Original; ist der laufende
 * Tag noch <= 1 kWh, ist das der Vorvortag).
 */
function yesterdayKwh(rows) {
    const ap = (rows || []).filter(r => isNum(r.v) && r.v > 1);
    return ap.length >= 2 ? ap[ap.length - 2].v : null;
}


/**
 * Summen fuer die Quoten-Zeitraeume aus Tagesreihen (Tagesmaxima der Zaehler).
 *
 *  week:   letzte 7 Tageswerte (Last/PV > 1, Netz >= 0) aus den letzten 8 Tagen
 *  season: alle Tage ab Beginn des lokalen Kalenderquartals ("Jahreszeit" im Original)
 *  year:   alle Tage ab 1. Januar (lokal)
 *
 * Abweichung: Das Original filterte mit `>= <Stichtag> 22:00 UTC` und liess dadurch
 * den ersten Tag des Quartals/Jahres weg; hier zaehlt der Stichtag mit.
 *
 * @param {object} series { load, pv, grid } je {time:ms, v}[] (Bucket-Start = lokale Mitternacht)
 * @returns {{week:{load,pv,grid}, season:{...}, year:{...}}}
 */
function periodSums(series, now, tz) {
    const weekFrom = startOfLocalDay(now - 8 * 86400_000, tz);
    const seasonKey = quarterStartKey(now, tz);
    const yearKey = yearStartKey(now, tz);

    const pick = (rows, kind, minFilter) => {
        const ok = r => isNum(r.v) && minFilter(r.v);
        if (kind === 'week') {
            const vals = (rows || []).filter(r => r.time >= weekFrom).filter(ok).map(r => r.v);
            return vals.slice(-7).reduce((a, b) => a + b, 0);
        }
        const from = kind === 'season' ? seasonKey : yearKey;
        const vals = (rows || []).filter(r => localDateKey(r.time, tz) >= from).filter(ok).map(r => r.v);
        return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : null;
    };

    const gt1 = v => v > 1;
    const gte0 = v => v >= 0;
    const out = {};
    for (const kind of ['week', 'season', 'year']) {
        out[kind] = {
            load: pick(series.load, kind, gt1),
            pv: pick(series.pv, kind, gt1),
            grid: pick(series.grid, kind, gte0),
        };
    }
    return out;
}


/** Quoten fuer Woche/Jahreszeit/Jahr aus periodSums(). */
function periodQuotes(sums) {
    const q = s => {
        const r = quote(s.load, s.pv, s.grid);
        return { aut: r.autarkie, ev: r.eigenverbrauch };
    };
    return { woche: q(sums.week), season: q(sums.season), jahr: q(sums.year) };
}


/**
 * Berechnet die API-Antwort. Felder und Reihenfolge wie im Original.
 *
 * @param {object} d Rohwerte (null = nicht verfuegbar):
 *   soc, pv_w, load_w, bat_w, forecast_w,
 *   forecast_* / actual_yesterday_kwh (aus lib/forecast.js summarize(); forecast_tomorrow_kwh =
 *   Kalendertag morgen 0-24 Uhr lokal, im Original: naechste 24 h),
 *   daily_pv_kwh, daily_load_kwh, daily_grid_kwh, daily_bat_in, daily_bat_out,
 *   avg_rows ({time,v}[] Tagesverbrauch ~32 Tage), anchor_06, anchor_17
 * @param {object|null} quoten Ergebnis von periodQuotes() (oder null)
 * @param {object} opts { capacityKwh, minSoc, now, tz, forecast, loadProfile }
 *   forecast:    PV-Prognose {time,v}[] (W) fuer die smarte Reichweite, optional
 *   loadProfile: W je lokaler Stunde (lib/range.js buildLoadProfile), optional
 */
function computePayload(d, quoten, { capacityKwh, minSoc, now, tz = 'Europe/Berlin', forecast = [], loadProfile = null }) {
    const pq = quoten || {};
    const avg_30d_kwh = average30d(d.avg_rows);

    const wr_eigenverbrauch = (d.daily_pv_kwh != null && d.daily_load_kwh != null && d.daily_bat_in != null && d.daily_bat_out != null)
        ? d.daily_pv_kwh - d.daily_load_kwh - d.daily_bat_in + Math.abs(d.daily_bat_out)
        : null;
    const avail_kwh = d.soc != null ? ((d.soc - minSoc) / 100 * capacityKwh) : null;
    const net_kw = (d.pv_w != null && d.load_w != null) ? (d.pv_w - d.load_w) / 1000 : null;

    // Restreichweite: verfuegbare Akku-Energie / aktuelles Defizit
    let range_h = null;
    let range_label = '∞';
    let range_status = 'infinite';
    if (net_kw !== null && avail_kwh !== null && net_kw < 0) {
        range_h = avail_kwh / Math.abs(net_kw);
        ({ label: range_label, status: range_status } = classifyRange(range_h));
    }

    // Smarte Reichweite: Energiebilanz von jetzt bis Ende morgen (lib/range.js) mit
    // PV-Prognose, Lastprofil und Akku-Kapazitaet. Abweichung vom Original, das
    // "Akku + Prognose morgen >= Ø-Tagesverbrauch" rechnete und die Nacht nicht beachtete.
    // Verbrauch: Lastprofil, sonst Ø 30 Tage / 24, sonst aktuelle Last.
    const loadW = avg_30d_kwh ? avg_30d_kwh / 24 * 1000 : (d.load_w ?? null);
    const sim = simulate({
        now,
        tz,
        availKwh: avail_kwh,
        usableKwh: (100 - minSoc) / 100 * capacityKwh,
        forecast,
        loadProfile,
        loadW,
    });

    let smart_range_label = range_label;
    let smart_range_status = range_status;
    if (sim && sim.emptyTs === null) {
        smart_range_label = '∞';
        smart_range_status = 'infinite';
    } else if (sim) {
        ({ label: smart_range_label, status: smart_range_status } = classifyRange(sim.hours));
        // Wird der Akku vor Ende morgen leer, nie "ausreichend" anzeigen
        if (smart_range_status === 'ok') smart_range_status = 'warn';
    }

    let delta_pct = null;
    if (avg_30d_kwh && d.daily_load_kwh) {
        delta_pct = ((d.daily_load_kwh - avg_30d_kwh) / avg_30d_kwh) * 100;
    }

    let bat_direction = 'idle';
    if (d.bat_w != null) {
        if (d.bat_w > 50) bat_direction = 'charging';
        else if (d.bat_w < -50) bat_direction = 'discharging';
    }

    // Verbrauchs-Split ueber die Zaehlerstaende zu den Ankerzeiten (lokal):
    //   Nacht = 00:00-06:00 (Stand um 06:00), Tag = 06:00-17:00, Abend = 17:00-jetzt
    const anchor_06 = d.anchor_06 ?? null;
    const anchor_17 = d.anchor_17 ?? null;
    const load_now = d.daily_load_kwh ?? null;
    const kwh_nacht = anchor_06 !== null ? Math.max(0, anchor_06) : null;
    const kwh_tag = (anchor_17 !== null && anchor_06 !== null) ? Math.max(0, anchor_17 - anchor_06) : null;
    const kwh_abend = (load_now !== null && anchor_17 !== null) ? Math.max(0, load_now - anchor_17) : null;

    const yesterday_kwh = yesterdayKwh(d.avg_rows);
    let delta_yesterday_pct = null;
    if (yesterday_kwh !== null && avg_30d_kwh) {
        delta_yesterday_pct = ((yesterday_kwh - avg_30d_kwh) / avg_30d_kwh) * 100;
    }

    const q_heute = quote(d.daily_load_kwh, d.daily_pv_kwh, d.daily_grid_kwh);

    return {
        smart_range_label,
        smart_range_status,
        forecast_tomorrow_kwh: d.forecast_tomorrow_kwh != null ? round(d.forecast_tomorrow_kwh) : null,
        autarkie_heute: q_heute.autarkie,
        eigenverbrauch_heute: q_heute.eigenverbrauch,
        autarkie_woche: pq.woche ? pq.woche.aut : null,
        eigenverbrauch_woche: pq.woche ? pq.woche.ev : null,
        autarkie_season: pq.season ? pq.season.aut : null,
        eigenverbrauch_season: pq.season ? pq.season.ev : null,
        autarkie_jahr: pq.jahr ? pq.jahr.aut : null,
        eigenverbrauch_jahr: pq.jahr ? pq.jahr.ev : null,
        wr_eigenverbrauch: round(wr_eigenverbrauch),
        ts: new Date(now).toISOString(),
        soc: d.soc ?? null,
        avail_kwh: round(avail_kwh),
        pv_w: d.pv_w ?? null,
        load_w: d.load_w ?? null,
        bat_w: d.bat_w ?? null,
        bat_direction,
        forecast_w: d.forecast_w ?? null,
        net_kw: round(net_kw, 2),
        range_h: round(range_h),
        range_label,
        range_status,
        daily_pv_kwh: d.daily_pv_kwh ?? null,
        daily_load_kwh: d.daily_load_kwh ?? null,
        daily_grid_kwh: d.daily_grid_kwh ?? null,
        avg_30d_kwh: round(avg_30d_kwh),
        delta_pct: round(delta_pct),
        kwh_nacht: round(kwh_nacht),
        kwh_tag: round(kwh_tag),
        kwh_abend: round(kwh_abend),
        yesterday_kwh: round(yesterday_kwh),
        delta_yesterday_pct: round(delta_yesterday_pct),
        // Ergaenzungen gegenueber dem Original (Prognose)
        forecast_today_kwh: round(d.forecast_today_kwh),
        forecast_today_remaining_kwh: round(d.forecast_today_remaining_kwh),
        forecast_tomorrow_peak_w: d.forecast_tomorrow_peak_w ?? null,
        forecast_tomorrow_peak_ts: d.forecast_tomorrow_peak_ts ?? null,
        forecast_yesterday_kwh: round(d.forecast_yesterday_kwh),
        actual_yesterday_kwh: round(d.actual_yesterday_kwh),
        // Ergaenzungen: Ergebnis der Energiebilanz (smarte Reichweite)
        smart_range_empty_ts: sim && sim.emptyTs !== null ? new Date(sim.emptyTs).toISOString() : null,
        smart_range_min_kwh: sim ? round(Math.max(0, sim.minKwh)) : null,
        smart_range_min_ts: sim ? new Date(sim.minTs).toISOString() : null,
        smart_range_until_ts: sim ? new Date(sim.until).toISOString() : null,
        smart_range_basis: sim ? (loadProfile ? 'lastprofil' : avg_30d_kwh ? 'durchschnitt' : 'aktuelle_last') : null,
    };
}


module.exports = {
    classifyRange,
    quote,
    average30d,
    yesterdayKwh,
    periodSums,
    periodQuotes,
    computePayload,
    round,
};
