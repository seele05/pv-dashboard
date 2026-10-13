'use strict';

/*
 * Mock-Datenquelle fuer Entwicklung, Tests und Screenshots. Alle Werte sind
 * erfunden und folgen nur grob einem Tagesverlauf (Sonne mittags, Grundlast,
 * Akku laedt bei Ueberschuss). Kein Bezug zu einer realen Anlage.
 */

const { localParts, startOfLocalDay } = require('./time');
const { summarize, chartData } = require('./forecast');


/** Weiche Glockenkurve 0..1 fuer die Sonne zwischen 06:00 und 20:00. */
function sun(hour) {
    if (hour <= 6 || hour >= 20) return 0;
    return Math.sin(((hour - 6) / 14) * Math.PI) ** 1.6;
}

function load(hour) {
    return 450 + 900 * Math.exp(-((hour - 7.5) ** 2) / 1.5) + 1400 * Math.exp(-((hour - 19) ** 2) / 3);
}

/** Integral 0..h (in kWh) einer Leistungsfunktion in W, grob per Summe. */
function integrate(fn, h) {
    let sum = 0;
    for (let t = 0; t < h; t += 0.05) sum += fn(t) * 0.05;
    return sum / 1000;
}


class MockSource {
    constructor(cfg) {
        this.cfg = cfg;
        this.tz = cfg.timezone;
        this.peakW = Math.round(cfg.display.maxPvW * 0.6);
    }

    async live(now) {
        const p = localParts(now, this.tz);
        const h = p.hour + p.minute / 60;
        const wiggle = Math.sin(now / 47_000) * 0.04;

        const pvAt = t => this.peakW * sun(t);
        const pv_w = Math.round(pvAt(h) * (1 + wiggle));
        const load_w = Math.round(load(h) * (1 - wiggle));
        const surplus = pv_w - load_w;
        const bat_w = Math.round(Math.max(-3000, Math.min(3000, surplus * 0.9)));
        const soc = Math.round(35 + 50 * sun(Math.min(h, 16)) + (h > 16 ? 15 : 0));

        const daily_pv_kwh = round2(integrate(pvAt, h));
        const daily_load_kwh = round2(integrate(load, h));
        const daily_grid_kwh = round2(Math.max(0, integrate(load, Math.min(h, 6)) * 0.08));
        const daily_bat_in = round2(integrate(t => Math.max(0, pvAt(t) - load(t)) * 0.9, h));
        const daily_bat_out = -round2(integrate(t => Math.max(0, load(t) - pvAt(t)) * 0.85, h));

        // 32 Tage Tagesverbrauch (fiktiv), heute = laufender Wert
        const avg_rows = [];
        for (let i = -32; i <= 0; i++) {
            const v = i === 0 ? daily_load_kwh : round2(16 + 3 * Math.sin(i * 0.9) + (i % 7 === 0 ? 2 : 0));
            avg_rows.push({ time: startOfLocalDay(now, this.tz, i), v });
        }

        return {
            d: {
                soc,
                pv_w,
                load_w,
                bat_w,
                forecast_w: Math.round(pvAt(h) * 1.08),
                daily_pv_kwh,
                daily_load_kwh,
                daily_grid_kwh,
                daily_bat_in,
                daily_bat_out,
                avg_rows,
                anchor_06: h >= 6 ? round2(integrate(load, 6)) : null,
                anchor_17: h >= 17 ? round2(integrate(load, 17)) : null,
            },
            errors: [],
        };
    }

    /** Prognose im 30-min-Raster fuer gestern/heute/morgen, Ist heute als 15-min-Mittel. */
    async forecast(now) {
        const scale = { '-1': 0.85, '0': 1.08, '1': 0.72 };   // gestern, heute, morgen (erfunden)
        const points = [];
        for (const day of [-1, 0, 1]) {
            const start = startOfLocalDay(now, this.tz, day);
            for (let m = 5 * 60; m <= 21 * 60; m += 30) {
                points.push({ time: start + m * 60_000, v: Math.round(this.peakW * sun(m / 60) * scale[String(day)]) });
            }
        }
        const actual = [];
        const today = startOfLocalDay(now, this.tz, 0);
        for (let t = today; t + 15 * 60_000 <= now; t += 15 * 60_000) {
            const h = (t - today) / 3_600_000 + 0.125;
            const cloud = 0.9 + 0.1 * Math.sin(t / 2_700_000);
            actual.push({ time: t, v: Math.round(this.peakW * sun(h) * cloud) });
        }
        const input = { points, actual, actualYesterdayKwh: round2(integrate(t => this.peakW * sun(t), 24) * 0.8) };
        return { summary: summarize(input, now, this.tz), chart: chartData(input, now, this.tz), errors: [] };
    }

    async aggregates() {
        return {
            quoten: {
                woche: { aut: 86.4, ev: 71.2 },
                season: { aut: 78.9, ev: 74.5 },
                jahr: { aut: 63.1, ev: 81.7 },
            },
            errors: [],
        };
    }
}

function round2(v) {
    return Math.round(v * 100) / 100;
}


module.exports = { MockSource };
