'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const m = require('../lib/metrics');
const t = require('../lib/time');

const TZ = 'Europe/Berlin';
const OPTS = { capacityKwh: 10, minSoc: 10, now: Date.parse('2026-06-15T10:00:00Z') };

/** Vollstaendige Rohdaten mit fiktiven Werten. */
function raw(over = {}) {
    return {
        soc: 60, pv_w: 2400, load_w: 1200, bat_w: 1150, forecast_w: 2600, forecast_tomorrow_kwh: 12.5,
        daily_pv_kwh: 8.2, daily_load_kwh: 7.4, daily_grid_kwh: 0.3, daily_bat_in: 3, daily_bat_out: -2.5,
        avg_rows: [], anchor_06: null, anchor_17: null,
        ...over,
    };
}

/** Tagesreihe: Werte je lokalem Tag, letzter Eintrag = heute. */
function dayRows(values, now = OPTS.now, tz = TZ) {
    const n = values.length;
    return values.map((v, i) => ({ time: t.startOfLocalDay(now, tz, i - (n - 1)), v }));
}


test('Zeit: lokale Mitternacht und Ankerzeiten folgen der Sommer-/Winterzeit', () => {
    // Sommer: 06:00 Berlin = 04:00 UTC, Winter: 06:00 Berlin = 05:00 UTC
    assert.equal(new Date(t.zonedToUtc(2026, 7, 1, 6, 0, 0, TZ)).toISOString(), '2026-07-01T04:00:00.000Z');
    assert.equal(new Date(t.zonedToUtc(2026, 1, 15, 6, 0, 0, TZ)).toISOString(), '2026-01-15T05:00:00.000Z');
    // Tag der Zeitumstellung (29.03.2026): Mitternacht noch MEZ, 06:00 schon MESZ
    assert.equal(new Date(t.zonedToUtc(2026, 3, 29, 0, 0, 0, TZ)).toISOString(), '2026-03-28T23:00:00.000Z');
    assert.equal(new Date(t.zonedToUtc(2026, 3, 29, 6, 0, 0, TZ)).toISOString(), '2026-03-29T04:00:00.000Z');
    assert.equal(t.localDateKey(Date.parse('2026-03-28T23:30:00Z'), TZ), '2026-03-29');
    assert.equal(t.localDateKey(Date.parse('2026-12-31T23:30:00Z'), TZ), '2027-01-01');
    assert.equal(t.startOfLocalDay(Date.parse('2026-10-25T12:00:00Z'), TZ, 1), Date.parse('2026-10-25T23:00:00Z'));
    assert.equal(t.quarterStartKey(Date.parse('2026-06-30T21:59:00Z'), TZ), '2026-04-01');
    assert.equal(t.quarterStartKey(Date.parse('2026-06-30T22:00:00Z'), TZ), '2026-07-01', 'Quartalswechsel um lokale Mitternacht');
});


test('Felder und Reihenfolge entsprechen reference/sample/pv-data.example.json', () => {
    const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'reference', 'sample', 'pv-data.example.json'), 'utf8'));
    const out = m.computePayload(raw(), null, OPTS);
    assert.deepEqual(Object.keys(out), Object.keys(sample));
});


test('Fehlende Werte ergeben null statt Fehler oder NaN', () => {
    const empty = {
        soc: null, pv_w: null, load_w: null, bat_w: null, forecast_w: null, forecast_tomorrow_kwh: null,
        daily_pv_kwh: null, daily_load_kwh: null, daily_grid_kwh: null, daily_bat_in: null, daily_bat_out: null,
        avg_rows: [], anchor_06: null, anchor_17: null,
    };
    const out = m.computePayload(empty, null, OPTS);
    for (const [k, v] of Object.entries(out)) {
        if (['smart_range_label', 'smart_range_status', 'range_label', 'range_status', 'bat_direction', 'ts'].includes(k)) continue;
        assert.equal(v, null, `${k} sollte null sein`);
    }
    assert.equal(out.range_label, '∞');
    assert.equal(out.range_status, 'infinite');
    assert.equal(out.bat_direction, 'idle');

    // auch fehlende Schluessel (undefined) werden wie null behandelt
    const out2 = m.computePayload({}, {}, OPTS);
    assert.equal(out2.avail_kwh, null);
    assert.equal(out2.wr_eigenverbrauch, null);
    assert.ok(!Object.values(out2).some(v => typeof v === 'number' && Number.isNaN(v)));
});


test('Reichweiten-Schwellen 1 / 3 / 8 / 72 h', () => {
    const cases = [
        [72.01, '> 72 h', 'ok'],
        [72, '72.0 h', 'ok'],
        [8, '8.0 h', 'ok'],
        [7.99, '8.0 h', 'warn'],
        [3, '3.0 h', 'warn'],
        [2.99, '3.0 h', 'crit'],
        [1, '1.0 h', 'crit'],
        [0.99, '59 min', 'crit'],
        [0.25, '15 min', 'crit'],
    ];
    for (const [h, label, status] of cases) {
        assert.deepEqual(m.classifyRange(h), { label, status }, `h=${h}`);
    }
});


test('Restreichweite: nur bei Defizit, sonst unendlich', () => {
    // avail = (60-10)% * 10 kWh = 5 kWh; Defizit 2 kW -> 2,5 h -> crit
    let out = m.computePayload(raw({ pv_w: 0, load_w: 2000 }), null, OPTS);
    assert.equal(out.avail_kwh, 5);
    assert.equal(out.net_kw, -2);
    assert.equal(out.range_h, 2.5);
    assert.equal(out.range_label, '2.5 h');
    assert.equal(out.range_status, 'crit');

    out = m.computePayload(raw({ pv_w: 3000, load_w: 3000 }), null, OPTS);
    assert.equal(out.range_h, null);
    assert.equal(out.range_status, 'infinite');

    // 5 kWh / 0,05 kW = 100 h
    out = m.computePayload(raw({ pv_w: 0, load_w: 50 }), null, OPTS);
    assert.equal(out.range_label, '> 72 h');
    assert.equal(out.range_h, 100);
});


test('Smarte Reichweite: Akku + Prognose gegen Ø 30 Tage', () => {
    const avg10 = dayRows(Array(30).fill(10));            // Ø 10 kWh/Tag -> 0,4167 kWh/h
    // 5 kWh Akku + 12,5 kWh Prognose >= 10 -> unendlich, auch bei Defizit
    let out = m.computePayload(raw({ pv_w: 0, load_w: 2000, avg_rows: avg10 }), null, OPTS);
    assert.equal(out.smart_range_status, 'infinite');
    assert.equal(out.range_status, 'crit');

    // 5 kWh + 0 Prognose = 12 h -> ok
    out = m.computePayload(raw({ forecast_tomorrow_kwh: null, avg_rows: avg10 }), null, OPTS);
    assert.equal(out.smart_range_label, '12.0 h');
    assert.equal(out.smart_range_status, 'ok');

    // SOC am Minimum, keine Prognose -> 0 h -> '0 min' crit
    out = m.computePayload(raw({ soc: 10, forecast_tomorrow_kwh: 0, avg_rows: avg10 }), null, OPTS);
    assert.equal(out.smart_range_label, '0 min');
    assert.equal(out.smart_range_status, 'crit');

    // ohne 30-Tage-Ø uebernimmt die smarte Reichweite die normale
    out = m.computePayload(raw({ pv_w: 0, load_w: 2000, avg_rows: [] }), null, OPTS);
    assert.equal(out.smart_range_label, out.range_label);
    assert.equal(out.smart_range_status, out.range_status);
});


test('Ø 30 Tage, gestern und Abweichungen', () => {
    // 35 Tage: aelteste 5 mit 100 (fallen raus), 0,5 (<= 1 wird ignoriert), heute 4
    const rows = dayRows([100, 100, 100, 100, 100, ...Array(28).fill(10), 0.5, 12, 4]);
    // letzte 30 Werte > 1: 27x10, 12, 4 und ... -> genau rechnen
    const vals = rows.map(r => r.v).filter(v => v > 1).slice(-30);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    assert.equal(m.average30d(rows), avg);
    assert.equal(m.yesterdayKwh(rows), 12);

    const out = m.computePayload(raw({ daily_load_kwh: 4, avg_rows: rows }), null, OPTS);
    assert.equal(out.avg_30d_kwh, Math.round(avg * 10) / 10);
    assert.equal(out.yesterday_kwh, 12);
    assert.equal(out.delta_pct, Math.round(((4 - avg) / avg * 100) * 10) / 10);
    assert.equal(out.delta_yesterday_pct, Math.round(((12 - avg) / avg * 100) * 10) / 10);

    // null-Buckets (fill(null)) stoeren nicht
    assert.equal(m.average30d([{ time: 0, v: null }, { time: 1, v: 5 }]), 5);
    assert.equal(m.yesterdayKwh([{ time: 0, v: 5 }]), null);
});


test('Gestern wie im Original: ist heute noch <= 1 kWh, gilt der Vorvortag', () => {
    const rows = dayRows([7, 9, 0.4]);
    assert.equal(m.yesterdayKwh(rows), 7);
});


test('Nacht/Tag/Abend-Split aus den Ankerpunkten', () => {
    let out = m.computePayload(raw({ daily_load_kwh: 9, anchor_06: 3.14, anchor_17: 7.4 }), null, OPTS);
    assert.equal(out.kwh_nacht, 3.1);
    assert.equal(out.kwh_tag, 4.3);
    assert.equal(out.kwh_abend, 1.6);

    // vor 17:00: kein Anker 17 -> Tag und Abend null
    out = m.computePayload(raw({ anchor_06: 3, anchor_17: null }), null, OPTS);
    assert.equal(out.kwh_nacht, 3);
    assert.equal(out.kwh_tag, null);
    assert.equal(out.kwh_abend, null);

    // vor 06:00: alles null
    out = m.computePayload(raw({ anchor_06: null, anchor_17: null }), null, OPTS);
    assert.equal(out.kwh_nacht, null);

    // negative Differenzen (Zaehler-Reset) werden auf 0 begrenzt
    out = m.computePayload(raw({ daily_load_kwh: 1, anchor_06: 3, anchor_17: 2 }), null, OPTS);
    assert.equal(out.kwh_tag, 0);
    assert.equal(out.kwh_abend, 0);
});


test('Quoten heute: Autarkie und "Eigenverbrauch" (Last/PV) mit Begrenzung', () => {
    assert.deepEqual(m.quote(10, 8, 2), { autarkie: 80, eigenverbrauch: 100 });
    assert.deepEqual(m.quote(10, 20, 0), { autarkie: 100, eigenverbrauch: 50 });
    assert.deepEqual(m.quote(10, 20, 12), { autarkie: 0, eigenverbrauch: 50 });
    assert.deepEqual(m.quote(0, 20, 0), { autarkie: null, eigenverbrauch: null });
    assert.deepEqual(m.quote(10, null, 0), { autarkie: null, eigenverbrauch: null });
    assert.deepEqual(m.quote(10, 5, null), { autarkie: null, eigenverbrauch: null });
    assert.deepEqual(m.quote(3, 7, 0.1), { autarkie: 96.7, eigenverbrauch: 42.9 });
});


test('WR-Eigenverbrauch, Akku-Richtung, Rundung', () => {
    const out = m.computePayload(raw(), null, OPTS);
    // 8,2 - 7,4 - 3 + |−2,5| = 0,3
    assert.equal(out.wr_eigenverbrauch, 0.3);
    assert.equal(out.net_kw, 1.2);
    assert.equal(out.bat_direction, 'charging');
    assert.equal(m.computePayload(raw({ bat_w: -51 }), null, OPTS).bat_direction, 'discharging');
    assert.equal(m.computePayload(raw({ bat_w: 50 }), null, OPTS).bat_direction, 'idle');
    assert.equal(m.computePayload(raw({ bat_w: -50 }), null, OPTS).bat_direction, 'idle');
    assert.equal(m.computePayload(raw({ forecast_tomorrow_kwh: 12.46 }), null, OPTS).forecast_tomorrow_kwh, 12.5);
    assert.equal(out.ts, '2026-06-15T10:00:00.000Z');
});


test('Perioden: Woche = letzte 7 Tage aus 8, Quartal und Jahr ab lokalem Stichtag inkl. erstem Tag', () => {
    const now = Date.parse('2026-04-03T10:00:00Z');   // 3. April, Quartal ab 1. April
    // 100 Tage zurueck bis heute; Last 10, PV 20, Netz 1 je Tag
    const mk = v => dayRows(Array(100).fill(v), now);
    const sums = m.periodSums({ load: mk(10), pv: mk(20), grid: mk(1) }, now, TZ);

    assert.deepEqual(sums.week, { load: 70, pv: 140, grid: 7 });
    // 1., 2., 3. April = 3 Tage (Original haette den 1. April ausgelassen)
    assert.deepEqual(sums.season, { load: 30, pv: 60, grid: 3 });
    // 1. Januar bis 3. April = 31 + 28 + 31 + 3 = 93 Tage
    assert.deepEqual(sums.year, { load: 930, pv: 1860, grid: 93 });

    const q = m.periodQuotes(sums);
    assert.deepEqual(q.woche, { aut: 90, ev: 50 });
    assert.deepEqual(q.season, { aut: 90, ev: 50 });
});


test('Perioden: Filter wie im Original (Last/PV > 1, Netz >= 0), leere Zeitraeume', () => {
    const now = Date.parse('2026-07-01T08:00:00Z');   // 1. Juli 10:00 lokal: Quartal hat 1 Tag
    const load = dayRows([5, 5, 0.5, 5], now);
    const grid = dayRows([0, null, 0, 0], now);
    const sums = m.periodSums({ load, pv: load, grid }, now, TZ);
    assert.equal(sums.week.load, 15);
    assert.equal(sums.week.grid, 0);
    assert.equal(sums.season.load, 5, 'nur der 1. Juli');
    assert.equal(sums.season.grid, 0);

    const none = m.periodSums({ load: [], pv: [], grid: [] }, now, TZ);
    assert.deepEqual(none.week, { load: 0, pv: 0, grid: 0 });
    assert.deepEqual(none.season, { load: null, pv: null, grid: null });
    assert.deepEqual(m.periodQuotes(none).jahr, { aut: null, ev: null });
});


test('Perioden: Tageswechsel an Silvester (lokal) startet ein neues Jahr', () => {
    const before = Date.parse('2026-12-31T22:59:00Z');  // 23:59 lokal
    const after = Date.parse('2026-12-31T23:01:00Z');   // 00:01 lokal am 1.1.2027
    const rows = dayRows(Array(10).fill(4), after);
    assert.equal(m.periodSums({ load: rows, pv: rows, grid: rows }, after, TZ).year.load, 4);
    const rowsBefore = dayRows(Array(10).fill(4), before);
    assert.equal(m.periodSums({ load: rowsBefore, pv: rowsBefore, grid: rowsBefore }, before, TZ).year.load, 40);
});


test('Quoten aus Perioden landen in der Antwort', () => {
    const out = m.computePayload(raw(), { woche: { aut: 80, ev: 88 }, season: { aut: 75, ev: 85 }, jahr: { aut: 55, ev: 95 } }, OPTS);
    assert.equal(out.autarkie_woche, 80);
    assert.equal(out.eigenverbrauch_season, 85);
    assert.equal(out.autarkie_jahr, 55);
    // (7,4 - 0,3) / 7,4 = 95,9 %
    assert.equal(out.autarkie_heute, 95.9);
});
