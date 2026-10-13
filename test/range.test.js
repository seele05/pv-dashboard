'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildLoadProfile, simulate } = require('../lib/range');
const { zonedToUtc } = require('../lib/time');

const TZ = 'Europe/Berlin';
const H = 3_600_000;
const at = (d, h, m = 0) => zonedToUtc(2026, 10, d, h, m, 0, TZ);

/** PV-Glocke 08-18 Uhr am Tag d mit `kwh` Tagesertrag, stuendliche Punkte. */
function sunDay(d, kwh) {
    const peak = kwh * 1000 * Math.PI / 20;   // Integral sin ueber 10 h = 10 h * 2/pi * peak
    const pts = [];
    for (let h = 8; h <= 18; h++) pts.push({ time: at(d, h), v: peak * Math.sin(Math.PI * (h - 8) / 10) });
    return pts;
}


test('Lastprofil: Mittel je lokaler Stunde, Luecken mit Gesamtmittel', () => {
    const rows = [];
    for (let day = 1; day <= 14; day++) {
        for (let h = 0; h < 24; h++) {
            if (h === 3) continue;                         // 03 Uhr nie gemessen
            rows.push({ time: at(day, h), v: h < 6 ? 300 : 900 });
        }
    }
    const p = buildLoadProfile(rows, TZ);
    assert.equal(p.length, 24);
    assert.equal(p[0], 300);
    assert.equal(p[12], 900);
    const mean = Math.round((5 * 300 + 18 * 900) / 23);
    assert.equal(p[3], mean);
    assert.equal(buildLoadProfile([], TZ), null);
    assert.equal(buildLoadProfile([{ time: at(1, 1), v: null }], TZ), null);
});


test('Fall A: 21 Uhr, 2 kWh, 700 W Last, morgen 20 kWh Sonne -> leer gegen Mitternacht, nicht unendlich', () => {
    const r = simulate({ now: at(13, 21), tz: TZ, availKwh: 2, usableKwh: 9, forecast: sunDay(14, 20), loadW: 700 });
    assert.ok(r.emptyTs !== null);
    assert.ok(Math.abs(r.hours - 2 / 0.7) < 0.01, `h=${r.hours}`);
});


test('Fall B: 8 Uhr, 0,5 kWh, heute 25 kWh Sonne -> Sonne von heute zaehlt mit', () => {
    const r = simulate({ now: at(13, 8), tz: TZ, availKwh: 0.5, usableKwh: 9, forecast: [...sunDay(13, 25), ...sunDay(14, 3)], loadW: 400 });
    // Heute laedt der Ueberschuss den Akku voll (9 kWh). Morgen deckt die truebe Sonne (3 kWh)
    // den Tagesverbrauch (24 h * 0,4 kW = 9,6 kWh) nicht: leer erst morgen spaet abends.
    // Das Original zeigte hier 5,3 h "Niedrig".
    assert.ok(r.emptyTs > at(14, 21) && r.emptyTs < at(15, 0), new Date(r.emptyTs).toISOString());
    assert.ok(r.hours > 36);
});


test('Kapazitaet begrenzt: Ueberschuss ueber "voll" geht verloren', () => {
    // 2 Tage viel Sonne, aber nur 3 kWh nutzbar; Nacht 18-08 Uhr = 14 h * 0,3 kW = 4,2 kWh -> leer in der Nacht
    const r = simulate({ now: at(13, 12), tz: TZ, availKwh: 3, usableKwh: 3, forecast: [...sunDay(13, 30), ...sunDay(14, 30)], loadW: 300 });
    assert.ok(r.emptyTs !== null);
    const empty = new Date(r.emptyTs);
    assert.ok(r.emptyTs > at(13, 18) && r.emptyTs < at(14, 8), `leer um ${empty.toISOString()}`);
});


test('Lastprofil statt konstanter Last: Abendspitze macht den Unterschied', () => {
    const profile = Array.from({ length: 24 }, (_, h) => (h >= 18 && h < 22 ? 2000 : 200));
    const flat = simulate({ now: at(13, 18), tz: TZ, availKwh: 4, usableKwh: 9, loadW: 600 });
    const prof = simulate({ now: at(13, 18), tz: TZ, availKwh: 4, usableKwh: 9, loadProfile: profile });
    assert.ok(Math.abs(flat.hours - 4 / 0.6) < 0.01);
    assert.ok(Math.abs(prof.hours - 2) < 0.01, `mit Profil: ${prof.hours} h`);
});


test('Tiefster Stand wird gemeldet, wenn der Akku durchhaelt', () => {
    const r = simulate({ now: at(13, 20), tz: TZ, availKwh: 6, usableKwh: 9, forecast: sunDay(14, 15), loadW: 300 });
    assert.equal(r.emptyTs, null);
    // tiefster Stand am Morgen, bevor die PV die Last uebersteigt
    assert.ok(r.minTs > at(14, 6) && r.minTs < at(14, 11), new Date(r.minTs).toISOString());
    assert.ok(r.minKwh > 1 && r.minKwh < 3, `min ${r.minKwh}`);
    assert.equal(r.until, at(15, 0));
});


test('Grenzfaelle: schon leer, keine Angaben', () => {
    assert.deepEqual(simulate({ now: at(13, 1), tz: TZ, availKwh: -0.4, usableKwh: 9, loadW: 100 }).hours, 0);
    assert.equal(simulate({ now: at(13, 1), tz: TZ, availKwh: null, usableKwh: 9, loadW: 100 }), null);
    assert.equal(simulate({ now: at(13, 1), tz: TZ, availKwh: 3, usableKwh: 9 }), null);
});
