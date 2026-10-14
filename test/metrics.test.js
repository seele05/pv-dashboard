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


test('Felder: zuerst alle der Beispielantwort in gleicher Reihenfolge, danach die Prognose-Ergaenzungen', () => {
    const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'reference', 'sample', 'pv-data.example.json'), 'utf8'));
    const out = m.computePayload(raw(), null, OPTS);
    assert.deepEqual(Object.keys(out), [...Object.keys(sample), ...['forecast_today_kwh', 'forecast_today_remaining_kwh', 'forecast_tomorrow_peak_w', 'forecast_tomorrow_peak_ts', 'forecast_yesterday_kwh', 'actual_yesterday_kwh', 'smart_range_empty_ts', 'smart_range_min_kwh', 'smart_range_min_ts', 'smart_range_until_ts', 'smart_range_basis', 'daily_bat_in_kwh', 'daily_bat_out_kwh', 'system_own_woche_kwh', 'system_own_season_kwh', 'system_own_jahr_kwh', 'bilanz_plausibel_heute', 'bilanz_plausibel_woche', 'bilanz_plausibel_season', 'bilanz_plausibel_jahr']]);
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


test('Smarte Reichweite: Energiebilanz bis Ende morgen statt "Akku + Prognose morgen >= Ø"', () => {
    const avg16 = dayRows(Array(30).fill(16.8));                  // Ø 16,8 kWh/Tag = 700 W
    const sunAt = (day, kwh) => {                                  // PV 08-18 Uhr lokal, stuendlich
        const peak = kwh * 1000 * Math.PI / 20;
        return Array.from({ length: 11 }, (_, i) => ({ time: t.zonedToUtc(2026, 10, day, 8 + i, 0, 0, TZ), v: peak * Math.sin(Math.PI * i / 10) }));
    };

    // Fall A: 21:00, SOC 30 % (2 kWh nutzbar), morgen 20 kWh. Original: "∞ Morgen genug".
    const nowA = t.zonedToUtc(2026, 10, 13, 21, 0, 0, TZ);
    let out = m.computePayload(raw({ soc: 30, pv_w: 0, load_w: 700, avg_rows: avg16, forecast_tomorrow_kwh: 20 }), null,
        { ...OPTS, now: nowA, tz: TZ, forecast: sunAt(14, 20) });
    assert.equal(out.smart_range_status, 'crit');   // 2,86 h < 3 h
    assert.equal(out.smart_range_label, '2.9 h');
    assert.equal(out.smart_range_empty_ts, new Date(nowA + 2 / 0.7 * 3_600_000).toISOString());
    assert.equal(out.smart_range_basis, 'durchschnitt');

    // Akku haelt bis zur Sonne und darueber hinaus -> unendlich, mit tiefstem Stand
    out = m.computePayload(raw({ soc: 100, pv_w: 0, load_w: 300, avg_rows: [] }), null,
        { ...OPTS, now: nowA, tz: TZ, forecast: sunAt(14, 25), loadProfile: Array(24).fill(300) });
    assert.equal(out.smart_range_status, 'infinite');
    assert.equal(out.smart_range_label, '∞');
    assert.equal(out.smart_range_empty_ts, null);
    assert.equal(out.smart_range_basis, 'lastprofil');
    assert.ok(out.smart_range_min_kwh > 0 && out.smart_range_min_kwh < 9);

    // leer erst nach ~13 h (vor Sonnenaufgang): Schwelle >= 8 h waere "ok", leer vor Ende morgen -> "warn"
    out = m.computePayload(raw({ soc: 100, pv_w: 0, load_w: 700, avg_rows: [] }), null,
        { ...OPTS, now: nowA, tz: TZ, loadProfile: Array(24).fill(700) });
    assert.equal(out.smart_range_label, '12.9 h');
    assert.equal(out.smart_range_status, 'warn');

    // SOC am Minimum -> sofort leer
    out = m.computePayload(raw({ soc: 10, avg_rows: avg16 }), null, { ...OPTS, tz: TZ });
    assert.equal(out.smart_range_label, '0 min');
    assert.equal(out.smart_range_status, 'crit');

    // ohne Ø und ohne aktuelle Last nichts zu rechnen -> normale Reichweite
    out = m.computePayload(raw({ pv_w: 0, load_w: null, avg_rows: [] }), null, { ...OPTS, tz: TZ });
    assert.equal(out.smart_range_label, out.range_label);
    assert.equal(out.smart_range_basis, null);
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


test('Energiebilanz: Tag mit Netzladung des Akkus geht auf', () => {
    const { balance } = require('../lib/energy');
    // PV 20 + Netz 5 = Verbrauch 8 + Akku netto 13 + Anlage 4
    const b = balance({ pv: 20.0, grid: 5.0, load: 8.0, batIn: 14.0, batOut: -1.0 });
    assert.ok(Math.abs(b.batNet - 13.0) < 1e-9);
    assert.ok(Math.abs(b.systemOwn - 4.0) < 1e-9);
    assert.equal(b.autarkie, 80);            // 20 / 25 (Original: (8 - 5) / 8 = 37,5 %)
    assert.equal(b.wirkungsgrad, 66.7);      // 8 / (25 - 13)

    // Akku entlaedt netto: Energie aus dem Akku zaehlt zur umgesetzten Energie
    const n = balance({ pv: 2, grid: 1, load: 8, batIn: 0, batOut: 6 });
    assert.equal(n.batNet, -6);
    assert.equal(n.systemOwn, 1);
    assert.equal(n.wirkungsgrad, 88.9);      // 8 / 9
    assert.equal(n.autarkie, 66.7);          // 2 / 3

    // fehlende Akku-Zaehler: Autarkie geht trotzdem, Anlage/Wirkungsgrad nicht
    const o = balance({ pv: 5, grid: 5, load: 8 });
    assert.equal(o.autarkie, 50);
    assert.equal(o.systemOwn, null);
    assert.equal(o.wirkungsgrad, null);
    assert.equal(o.plausibel, null);
    assert.deepEqual(balance({ pv: 0, grid: 0, load: 0, batIn: 0, batOut: 0 }).autarkie, null);
    assert.equal(balance({ pv: null, grid: 1 }).autarkie, null);
    assert.equal(b.plausibel, true);
});


test('Energiebilanz: unplausible Zaehler ergeben null und Hinweis statt gekappter Werte', () => {
    const { balance } = require('../lib/energy');
    // Entladung zu klein erfasst (z. B. Tagesmaximum eines negativ laufenden Zaehlers ~ 0):
    // PV 20 + Netz 2 - Verbrauch 10 - Akku netto (15 - 0) = -3 -> physikalisch unmoeglich
    const b = balance({ pv: 20, grid: 2, load: 10, batIn: 15, batOut: 0 });
    assert.equal(b.plausibel, false);
    assert.equal(b.systemOwn, null);
    assert.equal(b.wirkungsgrad, null);      // frueher auf 100 % gekappt
    assert.equal(b.autarkie, 90.9);          // haengt nicht an den Akku-Zaehlern
    assert.equal(b.batNet, 15);

    // Grenzfall: Eigenverbrauch genau 0 ist plausibel (Wirkungsgrad 100 %)
    const z = balance({ pv: 10, grid: 0, load: 8, batIn: 2, batOut: 0 });
    assert.equal(z.plausibel, true);
    assert.equal(z.systemOwn, 0);
    assert.equal(z.wirkungsgrad, 100);

    const out = m.computePayload(raw({ daily_bat_in: 15, daily_bat_out: 0 }), m.periodQuotes({
        week: { days: 7, pv: 140, grid: 14, load: 70, batIn: 105, batOut: 0 },
        season: { days: 9, pv: 180, grid: 18, load: 90, batIn: 72, batOut: 0 },
        year: { days: 9, pv: 180, grid: 18, load: 90, batIn: 60, batOut: 54 },
    }), OPTS);
    assert.equal(out.bilanz_plausibel_heute, false);
    assert.equal(out.wr_eigenverbrauch, null);
    assert.equal(out.eigenverbrauch_heute, null);
    assert.equal(out.bilanz_plausibel_woche, false);
    assert.equal(out.system_own_woche_kwh, null);
    assert.equal(out.eigenverbrauch_woche, null);
    assert.equal(out.bilanz_plausibel_season, true);   // 198 - 90 - 72 = 36
    assert.equal(out.system_own_season_kwh, 36);
    assert.equal(out.bilanz_plausibel_jahr, true);     // 198 - 90 - 6 = 102
    assert.equal(out.system_own_jahr_kwh, 102);
    assert.equal(m.computePayload(raw(), null, OPTS).bilanz_plausibel_woche, null);
});


test('WR-Eigenverbrauch, Akku-Richtung, Rundung', () => {
    const out = m.computePayload(raw(), null, OPTS);
    // Anlagen-Eigenverbrauch = 8,2 + 0,3 - 7,4 - (3 - 2,5) = 0,6 (Original ohne Netz: 0,3)
    assert.equal(out.wr_eigenverbrauch, 0.6);
    assert.equal(out.daily_bat_in_kwh, 3);
    assert.equal(out.daily_bat_out_kwh, 2.5);
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
    const sums = m.periodSums({ load: mk(10), pv: mk(20), grid: mk(1), batIn: mk(5), batOut: mk(-5) }, now, TZ);

    assert.deepEqual(sums.week, { days: 7, load: 70, pv: 140, grid: 7, batIn: 35, batOut: 35 });
    // 1., 2., 3. April = 3 Tage (Original haette den 1. April ausgelassen)
    assert.deepEqual(sums.season, { days: 3, load: 30, pv: 60, grid: 3, batIn: 15, batOut: 15 });
    // 1. Januar bis 3. April = 31 + 28 + 31 + 3 = 93 Tage
    assert.equal(sums.year.days, 93);
    assert.equal(sums.year.load, 930);

    // Autarkie 20/21, Wirkungsgrad 10/21, Anlage je Tag 21 - 10 = 11 kWh
    const q = m.periodQuotes(sums);
    assert.deepEqual(q.woche, { aut: 95.2, ev: 47.6, systemOwn: 77, plausibel: true, days: 7 });
    assert.equal(q.season.systemOwn, 33);
});


test('Perioden: tageweise abgeglichen (Verbrauch > 1, PV und Netz vorhanden), leere Zeitraeume', () => {
    const now = Date.parse('2026-07-01T08:00:00Z');   // 1. Juli 10:00 lokal: Quartal hat 1 Tag
    const load = dayRows([5, 5, 0.5, 5], now);
    const pv = dayRows([9, 9, 9, 9], now);
    const grid = dayRows([0, null, 0, 0], now);
    const sums = m.periodSums({ load, pv, grid }, now, TZ);
    // Tag 2 (Netz fehlt) und Tag 3 (Verbrauch <= 1) fallen in ALLEN Reihen weg
    assert.equal(sums.week.days, 2);
    assert.equal(sums.week.load, 10);
    assert.equal(sums.week.pv, 18, 'PV nur von denselben Tagen');
    assert.equal(sums.week.batIn, null, 'ohne Akku-Reihen keine Akku-Summe');
    assert.equal(sums.season.load, 5, 'nur der 1. Juli');

    const none = m.periodSums({ load: [], pv: [], grid: [] }, now, TZ);
    assert.deepEqual(none.week, { days: 0, load: null, pv: null, grid: null, batIn: null, batOut: null });
    assert.deepEqual(m.periodQuotes(none).jahr, { aut: null, ev: null, systemOwn: null, plausibel: null, days: 0 });
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
    // Autarkie heute = 8,2 / (8,2 + 0,3) = 96,5 %; Wirkungsgrad = 7,4 / (8,5 - 0,5) = 92,5 %
    assert.equal(out.autarkie_heute, 96.5);
    assert.equal(out.eigenverbrauch_heute, 92.5);
});
