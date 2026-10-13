'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig } = require('../lib/config');

const FULL = {
    influx: { url: 'http://127.0.0.1:8086', db: 'beispiel' },
    measurements: {
        soc: 'soc', pv: 'pv', load: 'load', battery: 'bat',
        daily: { pv: 'd_pv', load: 'd_load', grid: 'd_grid', batIn: 'd_in', batOut: 'd_out' },
    },
};

function withEnv(value, fn) {
    const old = process.env.CONFIG_JSON;
    if (value === undefined) delete process.env.CONFIG_JSON;
    else process.env.CONFIG_JSON = value;
    try {
        return fn();
    } finally {
        if (old === undefined) delete process.env.CONFIG_JSON;
        else process.env.CONFIG_JSON = old;
    }
}

function emptyDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pvcfg-'));
}


test('CONFIG_JSON: ersetzt config.js, wird mit Defaults zusammengefuehrt', () => {
    const cfg = withEnv(JSON.stringify({ ...FULL, battery: { capacityKwh: 12 } }), () => loadConfig(emptyDir()));
    assert.equal(cfg.influx.db, 'beispiel');
    assert.equal(cfg.influx.rp, 'autogen');
    assert.equal(cfg.battery.capacityKwh, 12);
    assert.equal(cfg.battery.minSoc, 10);
});

test('CONFIG_JSON: hat Vorrang vor config.local.json', () => {
    const dir = emptyDir();
    fs.writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify({ ...FULL, title: 'Datei' }));
    const cfg = withEnv(JSON.stringify({ title: 'Umgebung' }), () => loadConfig(dir));
    assert.equal(cfg.title, 'Umgebung');
    assert.equal(cfg.influx.db, 'beispiel');
});

test('CONFIG_JSON: ungueltiges JSON und fehlende Konfiguration werden gemeldet', () => {
    assert.throws(() => withEnv('{kein json', () => loadConfig(emptyDir())), /CONFIG_JSON ist kein gueltiges JSON/);
    assert.throws(() => withEnv(undefined, () => loadConfig(emptyDir())), /config.js fehlt/);
});
