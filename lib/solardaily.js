'use strict';

/*
 * SolarDaily: Tages- und Gesamtzaehler (kWh) aus Momentanleistungen (W).
 * Portiert aus reference/iobroker/SolarDaily.js ("SolarDaily v3"), gleiche Semantik:
 *
 *  - Integration je Kanal ueber die Zeit seit dem letzten Wert dieses Kanals.
 *    Verfahren `rectangle` (Default, wie im Original): neuer Wert x Zeitdifferenz.
 *    Alternativ `trapezoid`: Mittel aus altem und neuem Wert x Zeitdifferenz.
 *  - Luecken > maxGapMinutes (oder Zeit rueckwaerts) werden verworfen; der
 *    Zeitstempel wird trotzdem nachgefuehrt, damit der naechste Wert normal zaehlt.
 *  - Batterie: Wert >= 0 -> geladen (bat_in), < 0 -> entladen (bat_out). Wie im
 *    Original wird bat_out mit negativem Vorzeichen aufsummiert (Leistung < 0).
 *    Beide Richtungen teilen sich einen Zeitstempel (Richtungswechsel).
 *  - Netz: nur Bezug (>= 0) wird gezaehlt, Einspeisung (< 0) ignoriert; der
 *    Zeitstempel laeuft auch bei Einspeisung weiter.
 *  - Tagesreset um 00:00 in der konfigurierten Zeitzone. Ein Intervall, das ueber
 *    Mitternacht reicht, zaehlt (wie beim Original-Reset per Zeitplan) zum neuen Tag.
 *
 * Zustand in einer JSON-Datei (atomar), gespeichert hoechstens alle
 * `saveIntervalMinutes` sowie bei Tageswechsel und Beenden.
 */

const fs = require('fs');
const { localDateKey, startOfLocalDay } = require('./time');
const { valueLine } = require('./influx');

const CHANNELS = ['pv', 'load', 'battery', 'grid'];
const COUNTERS = ['pv_production', 'load_consumption', 'grid_consumption', 'bat_in', 'bat_out'];

function emptyCounters() {
    return Object.fromEntries(COUNTERS.map(k => [k, 0]));
}

function emptyState() {
    return {
        version: 1,
        day: null,
        daily: emptyCounters(),
        totals: emptyCounters(),
        last: Object.fromEntries(CHANNELS.map(c => [c, { ts: null, w: null }])),
    };
}

function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
}


class SolarDaily {
    /**
     * @param {object} opts
     * @param {string} opts.timezone
     * @param {number} [opts.maxGapMinutes=5]
     * @param {'rectangle'|'trapezoid'} [opts.method='rectangle']
     * @param {boolean} [opts.batteryChargePositive=true] false: Quelle meldet Laden negativ -> Vorzeichen drehen
     * @param {string|null} [opts.statePath]
     * @param {number} [opts.saveIntervalMinutes=5]
     * @param {object} [opts.log]
     */
    constructor(opts) {
        this.tz = opts.timezone;
        this.maxGapMs = (opts.maxGapMinutes ?? 5) * 60_000;
        this.method = opts.method === 'trapezoid' ? 'trapezoid' : 'rectangle';
        this.batterySign = opts.batteryChargePositive === false ? -1 : 1;
        this.statePath = opts.statePath ?? null;
        this.saveIntervalMs = (opts.saveIntervalMinutes ?? 5) * 60_000;
        this.log = opts.log ?? console;
        this.dirty = false;
        this.lastSaved = 0;
        this.state = this.load();
    }

    load() {
        if (!this.statePath) return emptyState();
        try {
            const s = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
            const base = emptyState();
            return {
                ...base,
                ...s,
                daily: { ...base.daily, ...s.daily },
                totals: { ...base.totals, ...s.totals },
                last: Object.fromEntries(CHANNELS.map(c => [c, { ...base.last[c], ...s.last?.[c] }])),
            };
        } catch (err) {
            if (err.code !== 'ENOENT') {
                this.log.error(`SolarDaily: ${this.statePath} unlesbar (${err.message}), starte mit 0`);
            }
            return emptyState();
        }
    }

    /** Atomar speichern (tmp + rename). `force` ignoriert das Intervall. */
    save(force = false, now = Date.now()) {
        if (!this.statePath || !this.dirty) return;
        if (!force && now - this.lastSaved < this.saveIntervalMs) return;
        const tmp = this.statePath + '.tmp';
        try {
            fs.writeFileSync(tmp, JSON.stringify(this.state));
            fs.renameSync(tmp, this.statePath);
            this.dirty = false;
            this.lastSaved = now;
        } catch (err) {
            this.log.error(`SolarDaily: Zustand nicht gespeichert: ${err.message}`);
        }
    }

    /** Setzt die Tageszaehler zurueck, wenn `ts` in einem neuen lokalen Tag liegt. */
    rolloverIfNeeded(ts) {
        const day = localDateKey(ts, this.tz);
        if (this.state.day === day) return false;
        const first = this.state.day === null;
        this.state.day = day;
        if (!first) {
            this.state.daily = emptyCounters();
        }
        this.dirty = true;
        if (!first) this.save(true, ts);
        return !first;
    }

    add(counter, kwh) {
        this.state.daily[counter] += kwh;
        this.state.totals[counter] += kwh;
    }

    /**
     * Verarbeitet einen Messwert.
     * @param {'pv'|'load'|'battery'|'grid'} channel
     * @param {number} watts
     * @param {number} ts Zeitpunkt in ms
     * @returns {number} gezaehlte kWh (0 bei Luecke/ungueltig)
     */
    sample(channel, watts, ts) {
        if (!CHANNELS.includes(channel) || !isNum(watts) || !isNum(ts)) return 0;
        if (channel === 'battery') watts *= this.batterySign;

        this.rolloverIfNeeded(ts);

        const last = this.state.last[channel];
        const diff = last.ts === null ? NaN : ts - last.ts;
        const prevW = last.w;
        last.ts = ts;
        last.w = watts;
        this.dirty = true;

        if (!(diff >= 0) || diff > this.maxGapMs) return 0;
        const hours = diff / 3_600_000;

        // Rechteck wie im Original; Trapez nur ohne Vorzeichenwechsel (sonst Rechteck),
        // damit Laden/Entladen bzw. Bezug/Einspeisung nicht vermischt werden
        let w = watts;
        if (this.method === 'trapezoid' && isNum(prevW) && prevW * watts >= 0) {
            w = (prevW + watts) / 2;
        }
        const kwh = (w / 1000) * hours;

        switch (channel) {
            case 'pv': this.add('pv_production', kwh); break;
            case 'load': this.add('load_consumption', kwh); break;
            case 'battery': this.add(watts >= 0 ? 'bat_in' : 'bat_out', kwh); break;
            case 'grid':
                if (watts < 0) return 0;   // Einspeisung
                this.add('grid_consumption', kwh);
                break;
        }
        return kwh;
    }

    /** Fuer Zeitgeber: Tageswechsel auch ohne neue Werte vollziehen. */
    tick(now = Date.now()) {
        if (this.state.day !== null) this.rolloverIfNeeded(now);
        this.save(false, now);
    }

    /** Millisekunden bis zur naechsten lokalen Mitternacht. */
    msUntilMidnight(now = Date.now()) {
        return startOfLocalDay(now, this.tz, 1) - now;
    }

    /** Tageswerte in der Form der API-Rohdaten (null, solange noch kein Tag laeuft). */
    dailyValues(now = Date.now()) {
        if (this.state.day === null) {
            return { daily_pv_kwh: null, daily_load_kwh: null, daily_grid_kwh: null, daily_bat_in: null, daily_bat_out: null };
        }
        const d = this.state.day === localDateKey(now, this.tz) ? this.state.daily : emptyCounters();
        return {
            daily_pv_kwh: d.pv_production,
            daily_load_kwh: d.load_consumption,
            daily_grid_kwh: d.grid_consumption,
            daily_bat_in: d.bat_in,
            daily_bat_out: d.bat_out,
        };
    }

    /**
     * Line-Protocol-Zeilen fuer die konfigurierten Measurements.
     * @param {{daily?: object, totals?: object}} names je Zaehler ein Measurement-Name (leer = nicht schreiben)
     */
    influxLines(names, now = Date.now()) {
        const lines = [];
        const daily = this.state.day === localDateKey(now, this.tz) ? this.state.daily : emptyCounters();
        for (const [scope, values] of [['daily', daily], ['totals', this.state.totals]]) {
            for (const k of COUNTERS) {
                const name = names?.[scope]?.[k];
                if (name && isNum(values[k])) lines.push(valueLine(name, values[k], now));
            }
        }
        return lines;
    }
}


module.exports = { SolarDaily, CHANNELS, COUNTERS };
