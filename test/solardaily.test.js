'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SolarDaily } = require('../lib/solardaily');
const { zonedToUtc } = require('../lib/time');

const TZ = 'Europe/Berlin';
const quiet = { error() {} };
const at = (h, min = 0, s = 0, day = 15) => zonedToUtc(2026, 6, day, h, min, s, TZ);
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

function sd(opts = {}) {
    return new SolarDaily({ timezone: TZ, log: quiet, ...opts });
}

/** Sendet `watts` alle `stepS` Sekunden ueber `minutes` Minuten. */
function feed(s, channel, watts, start, minutes, stepS = 10) {
    let t = start;
    for (; t <= start + minutes * 60_000; t += stepS * 1000) {
        s.sample(channel, typeof watts === 'function' ? watts(t) : watts, t);
    }
    return t;
}


test('Integration: 1000 W ueber 1 h = 1 kWh (Rechteck wie im Original)', () => {
    const s = sd();
    feed(s, 'pv', 1000, at(12), 60);
    close(s.state.daily.pv_production, 1);
    close(s.state.totals.pv_production, 1);
});


test('Rechteck nutzt den neuen Wert, Trapez den Mittelwert', () => {
    const r = sd();
    r.sample('load', 0, at(12));
    r.sample('load', 600, at(12, 1));     // 600 W x 1 min = 0,01 kWh
    close(r.state.daily.load_consumption, 0.01);

    const tz = sd({ method: 'trapezoid' });
    tz.sample('load', 0, at(12));
    tz.sample('load', 600, at(12, 1));    // (0+600)/2 x 1 min = 0,005 kWh
    close(tz.state.daily.load_consumption, 0.005);
});


test('Erster Wert zaehlt nicht (kein Vorgaenger)', () => {
    const s = sd();
    assert.equal(s.sample('pv', 5000, at(12)), 0);
    assert.equal(s.state.daily.pv_production, 0);
});


test('Luecke > maxGapMinutes wird verworfen, danach geht es normal weiter', () => {
    const s = sd({ maxGapMinutes: 5 });
    s.sample('pv', 1200, at(12));
    assert.equal(s.sample('pv', 1200, at(12, 5, 1)), 0, '5 min 1 s Luecke');
    close(s.sample('pv', 1200, at(12, 6, 1)), 1.2 / 60);
    // genau 5 min zaehlt noch
    close(s.sample('pv', 1200, at(12, 11, 1)), 0.1);
    // Zeit rueckwaerts zaehlt nicht
    assert.equal(s.sample('pv', 1200, at(12, 10)), 0);
});


test('Tagesreset um 00:00 lokal, Gesamtzaehler laufen weiter', () => {
    const s = sd();
    feed(s, 'load', 3600, at(23), 59);                       // 23:00-23:59: 3,54 kWh am 15.
    close(s.state.daily.load_consumption, 3.54, 1e-6);
    assert.equal(s.state.day, '2026-06-15');

    // erster Wert nach Mitternacht (70 s nach dem letzten) zaehlt zum neuen Tag
    s.sample('load', 3600, at(0, 0, 10, 16));
    assert.equal(s.state.day, '2026-06-16');
    close(s.state.daily.load_consumption, 0.07, 1e-6);
    close(s.state.totals.load_consumption, 3.61, 1e-6);

    // Tageswechsel ohne Werte per tick(): dailyValues des neuen Tages = 0
    const s2 = sd();
    feed(s2, 'pv', 1000, at(10), 10);
    s2.tick(at(0, 1, 0, 16));
    assert.equal(s2.state.day, '2026-06-16');
    assert.equal(s2.dailyValues(at(0, 1, 0, 16)).daily_pv_kwh, 0);
});


test('Tageswechsel folgt der Zeitzone, nicht UTC', () => {
    const s = sd();
    // 23:30 UTC am 15.06. ist in Berlin schon der 16.06. (01:30)
    s.sample('pv', 0, Date.parse('2026-06-15T21:00:00Z'));
    assert.equal(s.state.day, '2026-06-15');
    s.sample('pv', 0, Date.parse('2026-06-15T23:30:00Z'));
    assert.equal(s.state.day, '2026-06-16');
});


test('Batterie: Laden positiv -> bat_in, Entladen -> bat_out (negativ wie im Original)', () => {
    const s = sd();
    s.sample('battery', 3000, at(12));
    s.sample('battery', 3000, at(12, 1));    // +0,05 kWh geladen
    s.sample('battery', -1200, at(12, 2));   // -0,02 kWh entladen
    close(s.state.daily.bat_in, 0.05);
    close(s.state.daily.bat_out, -0.02);
    close(s.state.totals.bat_out, -0.02);
    // Richtungswechsel nutzt den gemeinsamen Zeitstempel (1 min, nicht 2 min)
    s.sample('battery', 600, at(12, 3));
    close(s.state.daily.bat_in, 0.06);
});


test('Batterie: Vorzeichen umkehrbar fuer Quellen, die Laden negativ melden', () => {
    const s = sd({ batteryChargePositive: false });
    s.sample('battery', -3000, at(12));
    s.sample('battery', -3000, at(12, 1));
    close(s.state.daily.bat_in, 0.05);
    assert.equal(s.state.daily.bat_out, 0);
});


test('Netz: nur Bezug zaehlt, Einspeisung ignoriert, Zeitstempel laeuft weiter', () => {
    const s = sd();
    s.sample('grid', 500, at(12));
    s.sample('grid', -2000, at(12, 1));      // Einspeisung: nichts
    assert.equal(s.state.daily.grid_consumption, 0);
    s.sample('grid', 600, at(12, 2));        // 1 min seit Einspeisung: 0,01 kWh
    close(s.state.daily.grid_consumption, 0.01);
    s.sample('grid', 0, at(12, 3));          // 0 W ist Bezug 0
    close(s.state.daily.grid_consumption, 0.01);
});


test('Ungueltige Werte werden ignoriert', () => {
    const s = sd();
    assert.equal(s.sample('pv', NaN, at(12)), 0);
    assert.equal(s.sample('pv', '100', at(12)), 0);
    assert.equal(s.sample('unbekannt', 100, at(12)), 0);
    assert.equal(s.state.last.pv.ts, null);
});


test('dailyValues und Influx-Zeilen', () => {
    const s = sd();
    assert.equal(s.dailyValues(at(12)).daily_pv_kwh, null, 'vor dem ersten Wert');
    feed(s, 'pv', 1000, at(12), 60);
    const v = s.dailyValues(at(13));
    close(v.daily_pv_kwh, 1);
    assert.equal(v.daily_grid_kwh, 0);

    const lines = s.influxLines({
        daily: { pv_production: 'pv daily', load_consumption: '' },
        totals: { pv_production: 'pv,total' },
    }, at(13));
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^pv\\ daily value=[0-9.e-]+ \d+$/);
    close(Number(lines[0].match(/value=([0-9.e-]+)/)[1]), 1, 1e-9);
    assert.match(lines[1], /^pv\\,total value=/);
});


test('Zustand: atomar, gedrosselt, beim Neustart weitergezaehlt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solardaily-'));
    const file = path.join(dir, 'solardaily-state.json');
    try {
        const s = sd({ statePath: file, saveIntervalMinutes: 5 });
        feed(s, 'load', 1000, at(12), 30);
        s.save(false, at(12, 30));
        assert.ok(fs.existsSync(file));
        assert.ok(!fs.existsSync(file + '.tmp'));

        // innerhalb des Intervalls wird nicht erneut geschrieben
        s.sample('load', 1000, at(12, 30, 10));
        const before = fs.readFileSync(file, 'utf8');
        s.save(false, at(12, 31));
        assert.equal(fs.readFileSync(file, 'utf8'), before);
        s.save(true, at(12, 31));
        assert.notEqual(fs.readFileSync(file, 'utf8'), before);

        // Neustart: Zaehler und letzter Zeitstempel bleiben erhalten -> naechster Wert zaehlt
        const s2 = sd({ statePath: file });
        close(s2.state.daily.load_consumption, s.state.daily.load_consumption);
        const kwh = s2.sample('load', 1000, at(12, 31, 10));
        assert.ok(kwh > 0);

        fs.writeFileSync(file, '{kaputt');
        assert.equal(sd({ statePath: file }).state.day, null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});


test('msUntilMidnight rechnet lokal (auch am Tag der Zeitumstellung)', () => {
    const s = sd();
    assert.equal(s.msUntilMidnight(at(23, 0)), 3_600_000);
    // 29.03.2026 hat lokal 23 h: von 00:00 bis Mitternacht
    const dstDay = zonedToUtc(2026, 3, 29, 0, 0, 0, TZ);
    assert.equal(s.msUntilMidnight(dstDay), 23 * 3_600_000);
});
