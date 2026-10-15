'use strict';

/*
 * Kennzahlen des PV-Dashboards. Portiert aus dem Node-RED-Flow
 * (reference/node-red/pv-tab.flow.json):
 *   - "Berechnen + JSON Response"      -> computePayload()
 *   - "store 22:00 + 30d avg berechnen" -> average30d()
 *   - "store 7d/Jahreszeit/Jahr ..."    -> periodSums()
 *   - quoten()/quot()                   -> ersetzt durch lib/energy.js balance()
 * Alle Funktionen sind rein (keine I/O, Zeit nur ueber Parameter).
 *
 * Bewusste Abweichungen vom Original stehen jeweils am Code und in der README.
 */

const { localDateKey, startOfLocalDay, quarterStartKey, yearStartKey } = require('./time');
const { simulate } = require('./range');
const { balance } = require('./energy');


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
 * Summen fuer die Zeitraeume aus Tagesreihen (Tagesmaxima der Zaehler), tageweise
 * abgeglichen: Ein Tag zaehlt nur, wenn Verbrauch (> 1 kWh, wie der Filter im
 * Original), PV und Netz vorliegen – so stammen alle Summen aus denselben Tagen.
 * Akku-Summen nur, wenn fuer jeden gezaehlten Tag beide Akku-Zaehler vorliegen.
 *
 *  week:   die letzten 7 solcher Tage aus den letzten 8 (inkl. heute, wie im Original)
 *  season: alle Tage ab Beginn des lokalen Kalenderquartals ("Jahreszeit" im Original)
 *  year:   alle Tage ab 1. Januar (lokal)
 *
 * Abweichungen: Das Original filterte jede Reihe fuer sich (PV und Verbrauch konnten
 * aus unterschiedlichen Tagen stammen) und mit `>= <Stichtag> 22:00 UTC` (der erste
 * Tag des Quartals/Jahres fehlte).
 *
 * @param {object} series { load, pv, grid, batIn?, batOut? } je {time:ms, v}[] (Bucket-Start = lokale Mitternacht)
 * @returns {{week, season, year}} je { days, load, pv, grid, batIn, batOut }
 */
function periodSums(series, now, tz) {
    const weekFrom = startOfLocalDay(now - 8 * 86400_000, tz);
    const seasonKey = quarterStartKey(now, tz);
    const yearKey = yearStartKey(now, tz);

    const byDay = new Map();
    const put = (key, rows) => {
        for (const r of rows || []) {
            if (!byDay.has(r.time)) byDay.set(r.time, { time: r.time });
            byDay.get(r.time)[key] = r.v;
        }
    };
    for (const k of ['load', 'pv', 'grid', 'batIn', 'batOut']) put(k, series[k]);

    const days = [...byDay.values()]
        .filter(d => isNum(d.load) && d.load > 1 && isNum(d.pv) && d.pv >= 0 && isNum(d.grid) && d.grid >= 0)
        .sort((a, b) => a.time - b.time);

    const sum = list => {
        const total = k => list.reduce((s, d) => s + d[k], 0);
        const hasBat = list.length > 0 && list.every(d => isNum(d.batIn) && isNum(d.batOut));
        return {
            days: list.length,
            load: list.length ? total('load') : null,
            pv: list.length ? total('pv') : null,
            grid: list.length ? total('grid') : null,
            batIn: hasBat ? total('batIn') : null,
            batOut: hasBat ? list.reduce((s, d) => s + Math.abs(d.batOut), 0) : null,
        };
    };

    return {
        week: sum(days.filter(d => d.time >= weekFrom).slice(-7)),
        season: sum(days.filter(d => localDateKey(d.time, tz) >= seasonKey)),
        year: sum(days.filter(d => localDateKey(d.time, tz) >= yearKey)),
    };
}


/**
 * Quoten fuer Woche/Quartal/Jahr aus periodSums(): aut = Autarkie, ev = Wirkungsgrad
 * (Feldname `ev` aus Kompatibilitaet mit dem Original, siehe lib/energy.js).
 */
function periodQuotes(sums) {
    const q = s => {
        const b = balance(s);
        return { aut: b.autarkie, ev: b.wirkungsgrad, systemOwn: b.systemOwn, plausibel: b.plausibel, days: s.days };
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
/** Anlagenverluste eines Zeitraums pro Tag (kWh), null ohne Werte. */
function perDay(q) {
    return q && isNum(q.systemOwn) && q.days > 0 ? round(q.systemOwn / q.days) : null;
}


function computePayload(d, quoten, { capacityKwh, minSoc, now, tz = 'Europe/Berlin', forecast = [], loadProfile = null }) {
    const pq = quoten || {};
    const avg_30d_kwh = average30d(d.avg_rows);

    // Tagesbilanz: PV + Netz = Verbrauch + Akku netto + Anlagen-Eigenverbrauch (lib/energy.js)
    const heute = balance({
        pv: d.daily_pv_kwh, grid: d.daily_grid_kwh, load: d.daily_load_kwh,
        batIn: d.daily_bat_in, batOut: d.daily_bat_out,
    });
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

    return {
        smart_range_label,
        smart_range_status,
        forecast_tomorrow_kwh: d.forecast_tomorrow_kwh != null ? round(d.forecast_tomorrow_kwh) : null,
        autarkie_heute: heute.autarkie,
        eigenverbrauch_heute: heute.wirkungsgrad,
        autarkie_woche: pq.woche ? pq.woche.aut : null,
        eigenverbrauch_woche: pq.woche ? pq.woche.ev : null,
        autarkie_season: pq.season ? pq.season.aut : null,
        eigenverbrauch_season: pq.season ? pq.season.ev : null,
        autarkie_jahr: pq.jahr ? pq.jahr.aut : null,
        eigenverbrauch_jahr: pq.jahr ? pq.jahr.ev : null,
        wr_eigenverbrauch: round(heute.systemOwn),
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
        // Ergaenzungen: Akku-Tageszaehler (beide positiv) und Anlagen-Eigenverbrauch der Zeitraeume
        daily_bat_in_kwh: round(d.daily_bat_in),
        daily_bat_out_kwh: isNum(d.daily_bat_out) ? round(Math.abs(d.daily_bat_out)) : null,
        system_own_woche_kwh: pq.woche ? round(pq.woche.systemOwn) : null,
        system_own_season_kwh: pq.season ? round(pq.season.systemOwn) : null,
        system_own_jahr_kwh: pq.jahr ? round(pq.jahr.systemOwn) : null,
        // Ergaenzungen: Plausibilitaet der Energiebilanz (false: Zaehler passen nicht zusammen,
        // Eigenverbrauch und Wirkungsgrad sind dann null; null: nicht pruefbar)
        bilanz_plausibel_heute: heute.plausibel,
        bilanz_plausibel_woche: pq.woche ? pq.woche.plausibel ?? null : null,
        bilanz_plausibel_season: pq.season ? pq.season.plausibel ?? null : null,
        bilanz_plausibel_jahr: pq.jahr ? pq.jahr.plausibel ?? null : null,
        // Ergaenzung: Netzleistung (Bezug positiv, Einspeisung negativ) fuer den Energiefluss
        grid_w: isNum(d.grid_w) ? Math.round(d.grid_w) : null,
        // Ergaenzungen: Anlagenverluste je Zeitraum als Mittel pro Tag (vergleichbar, anders als die Summen)
        system_own_woche_avg_kwh: perDay(pq.woche),
        system_own_season_avg_kwh: perDay(pq.season),
        system_own_jahr_avg_kwh: perDay(pq.jahr),
    };
}


module.exports = {
    classifyRange,
    average30d,
    yesterdayKwh,
    periodSums,
    periodQuotes,
    computePayload,
    round,
};
