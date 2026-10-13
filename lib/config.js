'use strict';

/*
 * Konfiguration: Defaults <- config.js <- config.local.json (tief zusammengefuehrt).
 * Im Mock-Modus darf config.js fehlen.
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
    port: 8080,
    dataDir: '',
    timezone: 'Europe/Berlin',
    title: 'PV-Anlage',
    pollSeconds: 30,
    aggregateMinutes: 30,
    mock: false,
    battery: { capacityKwh: 10, minSoc: 10 },
    display: { maxPvW: 10000, maxLoadW: 10000, maxBatW: 5000 },
    influx: { url: 'http://127.0.0.1:8086', db: '', rp: 'autogen', username: '', password: '', token: '' },
    measurements: {
        soc: '', pv: '', load: '', battery: '', grid: '', forecast: '',
        daily: { pv: '', load: '', grid: '', batIn: '', batOut: '' },
    },
    solardaily: {
        enabled: false,
        input: 'mqtt',
        method: 'rectangle',
        maxGapMinutes: 5,
        batteryChargePositive: true,
        saveIntervalMinutes: 5,
        mqtt: { url: '', username: '', password: '', topics: { pv: '', load: '', battery: '', grid: '' } },
        influxPollSeconds: 10,
        write: { enabled: false, intervalSeconds: 60, measurements: { daily: {}, totals: {} } },
    },
};


function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
    if (!isPlainObject(over)) return base;
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) {
        out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
    }
    return out;
}


function validate(cfg) {
    const errors = [];
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: cfg.timezone });
    } catch (_) {
        errors.push(`timezone: unbekannte Zeitzone "${cfg.timezone}"`);
    }
    if (!(cfg.pollSeconds >= 5)) errors.push('pollSeconds muss >= 5 sein');
    if (!(cfg.aggregateMinutes >= 1)) errors.push('aggregateMinutes muss >= 1 sein');
    if (!(cfg.battery.capacityKwh > 0)) errors.push('battery.capacityKwh muss > 0 sein');
    if (!(cfg.battery.minSoc >= 0 && cfg.battery.minSoc < 100)) errors.push('battery.minSoc muss zwischen 0 und 100 liegen');

    if (!cfg.mock) {
        if (!/^https?:\/\/.+/.test(cfg.influx.url)) errors.push('influx.url muss mit http:// oder https:// beginnen');
        if (!cfg.influx.db) errors.push('influx.db fehlt');
        for (const k of ['soc', 'pv', 'load', 'battery']) {
            if (!cfg.measurements[k]) errors.push(`measurements.${k} fehlt`);
        }
        const sd = cfg.solardaily;
        if (sd.enabled) {
            if (!['mqtt', 'influx'].includes(sd.input)) errors.push("solardaily.input muss 'mqtt' oder 'influx' sein");
            if (sd.input === 'mqtt' && !sd.mqtt.url) errors.push('solardaily.mqtt.url fehlt');
            if (sd.input === 'influx' && !cfg.measurements.grid) errors.push('measurements.grid fehlt (fuer solardaily.input = influx)');
        } else {
            for (const k of ['pv', 'load', 'grid', 'batIn', 'batOut']) {
                if (!cfg.measurements.daily[k]) errors.push(`measurements.daily.${k} fehlt`);
            }
        }
    }
    return errors;
}


/**
 * @param {string} dir Verzeichnis mit config.js / config.local.json
 * @param {{mock?: boolean}} flags
 */
function loadConfig(dir, flags = {}) {
    let fileCfg = {};
    const jsPath = path.join(dir, 'config.js');
    if (fs.existsSync(jsPath)) {
        fileCfg = require(jsPath);
    } else if (!flags.mock) {
        throw new Error('config.js fehlt. Vorlage kopieren: cp config.example.js config.js (oder zum Ausprobieren: node main.js --mock)');
    }

    let localCfg = {};
    const localPath = path.join(dir, 'config.local.json');
    if (fs.existsSync(localPath)) {
        localCfg = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    }

    const cfg = deepMerge(deepMerge(DEFAULTS, fileCfg), localCfg);
    if (flags.mock) cfg.mock = true;
    if (process.env.PORT) cfg.port = Number(process.env.PORT);
    if (process.env.DATA_DIR) cfg.dataDir = process.env.DATA_DIR;
    cfg.dataDir = path.resolve(dir, cfg.dataDir || '.');

    const errors = validate(cfg);
    if (errors.length) {
        throw new Error('Konfiguration ungueltig:\n  - ' + errors.join('\n  - '));
    }
    return cfg;
}


module.exports = { loadConfig, deepMerge, validate, DEFAULTS };
