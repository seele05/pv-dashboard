'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const f = require('../lib/forecast');
const { zonedToUtc } = require('../lib/time');

const TZ = 'Europe/Berlin';
const H = 3_600_000;
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

/** Glockenkurve 06-20 Uhr lokal am Tag `day` im Raster `stepMin`, Spitze `peakW`. */
function dayCurve(y, m, d, stepMin, peakW) {
    const pts = [];
    for (let min = 6 * 60; min <= 20 * 60; min += stepMin) {
        const x = (min - 360) / 840;
        pts.push({ time: zonedToUtc(y, m, d, 0, min, 0, TZ), v: peakW * Math.sin(Math.PI * x) });
    }
    return pts;
}


test('Integration: konstante 1000 W ueber 3 h = 3 kWh, egal welches Raster', () => {
    const t0 = Date.parse('2026-06-15T08:00:00Z');
    for (const step of [60, 30, 15]) {
        const pts = [];
        for (let t = t0; t <= t0 + 3 * H; t += step * 60_000) pts.push({ time: t, v: 1000 });
        close(f.integrateKwh(pts, t0, t0 + 3 * H), 3);
    }
});


test('Original sum/1000 waere bei 30-min-Raster doppelt so hoch, Integration nicht', () => {
    const p60 = dayCurve(2026, 6, 16, 60, 4000);
    const p30 = dayCurve(2026, 6, 16, 30, 4000);
    const from = zonedToUtc(2026, 6, 16, 0, 0, 0, TZ);
    const to = zonedToUtc(2026, 6, 17, 0, 0, 0, TZ);
    const e60 = f.integrateKwh(p60, from, to);
    const e30 = f.integrateKwh(p30, from, to);
    // exakt: 4 kW * 14 h * 2/pi = 35,65 kWh; Trapez liegt leicht darunter
    assert.ok(Math.abs(e60 - 35.65) < 0.3, `60 min: ${e60}`);
    assert.ok(Math.abs(e30 - 35.65) < 0.1, `30 min: ${e30}`);
    const sum30 = p30.reduce((s, p) => s + p.v, 0) / 1000;
    assert.ok(sum30 > 1.9 * e30, 'sum/1000 bei 30 min ~ doppelt');
});


test('Grenzen werden linear interpoliert, Luecken > 2 h zaehlen nicht', () => {
    const t0 = Date.parse('2026-06-15T10:00:00Z');
    const pts = [{ time: t0, v: 0 }, { time: t0 + H, v: 2000 }];
    // halbe Stunde von 10:30 bis 11:00: Mittel aus 1000 und 2000 W x 0,5 h = 0,75 kWh
    close(f.integrateKwh(pts, t0 + H / 2, t0 + 2 * H), 0.75);
    assert.equal(f.integrateKwh([{ time: t0, v: 500 }, { time: t0 + 3 * H, v: 500 }], t0, t0 + 3 * H), null);
    assert.equal(f.integrateKwh([], t0, t0 + H), null);
    assert.equal(f.integrateKwh([{ time: t0, v: null }, { time: t0 + H, v: 5 }], t0, t0 + H), null);
});


test('summarize: Kalendertage lokal, Rest heute, Spitze morgen, gestern', () => {
    const points = [
        ...dayCurve(2026, 6, 14, 30, 3000),   // gestern
        ...dayCurve(2026, 6, 15, 30, 4000),   // heute
        ...dayCurve(2026, 6, 16, 30, 5000),   // morgen
    ];
    const now = zonedToUtc(2026, 6, 15, 13, 0, 0, TZ);
    const s = f.summarize({ points, actualYesterdayKwh: 24.1 }, now, TZ);

    const full = k => k * 14 * 2 / Math.PI;      // kWh einer Kurve mit Spitze k kW
    assert.ok(Math.abs(s.forecast_tomorrow_kwh - full(5)) < 0.15);
    assert.ok(Math.abs(s.forecast_today_kwh - full(4)) < 0.15);
    assert.ok(Math.abs(s.forecast_yesterday_kwh - full(3)) < 0.15);
    // 13:00 ist genau die Mitte von 06-20 Uhr: die Haelfte des Tages ist noch offen
    assert.ok(Math.abs(s.forecast_today_remaining_kwh - full(4) / 2) < 0.15);
    assert.equal(s.forecast_tomorrow_peak_w, 5000);
    assert.equal(s.forecast_tomorrow_peak_ts, new Date(zonedToUtc(2026, 6, 16, 13, 0, 0, TZ)).toISOString());
    assert.equal(s.actual_yesterday_kwh, 24.1);

    // nach Sonnenuntergang: Rest heute = 0, nicht null
    const late = f.summarize({ points }, zonedToUtc(2026, 6, 15, 22, 0, 0, TZ), TZ);
    assert.equal(late.forecast_today_remaining_kwh, 0);
});


test('summarize: keine Prognosedaten -> alles null', () => {
    const s = f.summarize({ points: [] }, Date.now(), TZ);
    assert.deepEqual(Object.values(s).filter(v => v !== null), []);
});


test('Kalendertag "morgen" folgt der Zeitumstellung (25-h-Tag im Oktober)', () => {
    // 25.10.2026: Ende der Sommerzeit, der Tag hat 25 h. Konstante 100 W ueber den ganzen Tag.
    const pts = [];
    for (let t = zonedToUtc(2026, 10, 25, 0, 0, 0, TZ); t <= zonedToUtc(2026, 10, 26, 0, 0, 0, TZ); t += H) pts.push({ time: t, v: 100 });
    const now = zonedToUtc(2026, 10, 24, 12, 0, 0, TZ);
    close(f.summarize({ points: pts }, now, TZ).forecast_tomorrow_kwh, 2.5);
});


test('chartData: heute 00:00 bis uebermorgen, Ist nur bis jetzt', () => {
    const now = zonedToUtc(2026, 6, 15, 12, 0, 0, TZ);
    const points = [...dayCurve(2026, 6, 14, 60, 1000), ...dayCurve(2026, 6, 15, 60, 1000), ...dayCurve(2026, 6, 16, 60, 1000), ...dayCurve(2026, 6, 17, 60, 1000)];
    const actual = [{ time: now - H, v: 800.4 }, { time: now + H, v: 1 }];
    const c = f.chartData({ points, actual }, now, TZ);
    assert.equal(c.from, zonedToUtc(2026, 6, 15, 0, 0, 0, TZ));
    assert.equal(c.midnight, zonedToUtc(2026, 6, 16, 0, 0, 0, TZ));
    assert.equal(c.forecast.length, 30);
    assert.deepEqual(c.actual, [[now - H, 800]]);
});
