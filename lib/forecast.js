'use strict';

/*
 * PV-Prognose: Energie aus Prognose-Leistungswerten (W) mit beliebigem Raster.
 *
 * Der ioBroker-Adapter pvforecast schreibt `summary.power` mit zukuenftigen
 * Zeitstempeln im Raster des Dienstes (z. B. stuendlich, 30 oder 15 Minuten,
 * forecast.solar zusaetzlich mit Sonnenauf-/-untergang). Das Original rechnete
 * `sum(value) / 1000`, was nur bei genau einem Wert pro Stunde kWh ergibt.
 * Hier wird ueber die Zeit integriert (Trapez), unabhaengig vom Raster.
 */

const { startOfLocalDay } = require('./time');

const MAX_GAP_MS = 2 * 3_600_000;

function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
}


/**
 * Integriert Leistungswerte (W) zu kWh im Intervall [from, to).
 * Zwischen zwei Punkten linear (Trapez); an den Intervallgrenzen linear
 * interpoliert. Abschnitte mit mehr als `maxGapMs` Abstand zaehlen nicht
 * (fehlende Daten, Nacht ohne Punkte).
 * @param {{time:number, v:number|null}[]} points nach Zeit sortiert
 */
function integrateKwh(points, from, to, maxGapMs = MAX_GAP_MS) {
    const pts = (points || []).filter(p => isNum(p.v) && isNum(p.time));
    let wh = 0;
    let any = false;
    for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        const span = b.time - a.time;
        if (span <= 0 || span > maxGapMs) continue;
        const s = Math.max(a.time, from);
        const e = Math.min(b.time, to);
        if (e <= s) continue;
        const at = t => a.v + (b.v - a.v) * (t - a.time) / span;
        wh += (at(s) + at(e)) / 2 * (e - s) / 3_600_000;
        any = true;
    }
    return any ? wh / 1000 : null;
}


/** Hoechster Prognosewert im Intervall [from, to). */
function peak(points, from, to) {
    let best = null;
    for (const p of points || []) {
        if (p.time >= from && p.time < to && isNum(p.v) && (best === null || p.v > best.v)) best = p;
    }
    return best && best.v > 0 ? best : null;
}


function round1(v) {
    return v === null || v === undefined ? null : Math.round(v * 10) / 10;
}


/**
 * Kennzahlen der Prognose.
 * @param {object} input
 * @param {{time,v}[]} input.points       Prognosewerte gestern 00:00 bis uebermorgen 00:00 (lokal)
 * @param {number|null} input.actualYesterdayKwh  tatsaechliche PV-Erzeugung gestern
 * @param {number} now
 * @param {string} tz
 */
function summarize({ points, actualYesterdayKwh = null }, now, tz) {
    const yStart = startOfLocalDay(now, tz, -1);
    const tStart = startOfLocalDay(now, tz, 0);
    const mStart = startOfLocalDay(now, tz, 1);
    const uStart = startOfLocalDay(now, tz, 2);

    const tomorrowPeak = peak(points, mStart, uStart);
    const remaining = integrateKwh(points, Math.max(now, tStart), mStart);

    return {
        forecast_tomorrow_kwh: integrateKwh(points, mStart, uStart),
        forecast_today_kwh: integrateKwh(points, tStart, mStart),
        // nach Sonnenuntergang gibt es keine Punkte mehr bis Mitternacht -> 0 statt "unbekannt"
        forecast_today_remaining_kwh: remaining === null && (points || []).some(p => p.time >= tStart && p.time < mStart) ? 0 : remaining,
        forecast_tomorrow_peak_w: tomorrowPeak ? Math.round(tomorrowPeak.v) : null,
        forecast_tomorrow_peak_ts: tomorrowPeak ? new Date(tomorrowPeak.time).toISOString() : null,
        forecast_yesterday_kwh: integrateKwh(points, yStart, tStart),
        actual_yesterday_kwh: isNum(actualYesterdayKwh) ? actualYesterdayKwh : null,
    };
}


/**
 * Daten fuer das Diagramm: Prognose und Ist von heute 00:00 bis uebermorgen 00:00.
 * Zeiten in ms, Leistungen in W (gerundet).
 */
function chartData({ points, actual }, now, tz) {
    const from = startOfLocalDay(now, tz, 0);
    const to = startOfLocalDay(now, tz, 2);
    const keep = (rows, until) => (rows || [])
        .filter(p => p.time >= from && p.time < until && isNum(p.v))
        .map(p => [p.time, Math.round(p.v)]);
    return {
        from,
        midnight: startOfLocalDay(now, tz, 1),
        to,
        now,
        forecast: keep(points, to),
        actual: keep(actual, now + 1),
    };
}


module.exports = { integrateKwh, peak, summarize, chartData, round1, MAX_GAP_MS };
