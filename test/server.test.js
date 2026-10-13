'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { App } = require('../lib/app');
const { DEFAULTS, deepMerge } = require('../lib/config');

const ROOT = path.join(__dirname, '..');
const quiet = { log() {}, error() {} };

async function withMockApp(fn) {
    const app = new App(deepMerge(DEFAULTS, { mock: true, port: 0 }), { log: quiet });
    const port = await app.start();
    try {
        await fn(`http://127.0.0.1:${port}`, app);
    } finally {
        await app.stop();
    }
}


test('Mock-Modus: /api/pv liefert alle Felder der Beispielantwort mit passenden Typen', async () => {
    const sample = JSON.parse(fs.readFileSync(path.join(ROOT, 'reference', 'sample', 'pv-data.example.json'), 'utf8'));
    await withMockApp(async base => {
        const res = await fetch(base + '/api/pv');
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('access-control-allow-origin'), '*');
        const body = await res.json();
        const expected = [...Object.keys(sample), ...['forecast_today_kwh', 'forecast_today_remaining_kwh', 'forecast_tomorrow_peak_w', 'forecast_tomorrow_peak_ts', 'forecast_yesterday_kwh', 'actual_yesterday_kwh']];
        assert.deepEqual(Object.keys(body), expected);
        for (const [k, v] of Object.entries(sample)) {
            if (v === null || body[k] === null) continue;
            assert.equal(typeof body[k], typeof v, `Typ von ${k}`);
        }

        // Kompatibilitaets-Pfad des Node-RED-Flows
        const legacy = await (await fetch(base + '/pv-data')).json();
        assert.deepEqual(Object.keys(legacy), expected);

        // Prognose-Kurven
        const fc = await (await fetch(base + '/api/forecast')).json();
        assert.ok(fc.forecast.length > 0 && Array.isArray(fc.actual));
        assert.ok(fc.from < fc.midnight && fc.midnight < fc.to);
        assert.equal(body.forecast_tomorrow_kwh, Math.round(fc.forecast_tomorrow_kwh * 10) / 10);
    });
});


test('Seite, Manifest, Service Worker und Icons werden ausgeliefert', async () => {
    await withMockApp(async base => {
        const page = await fetch(base + '/');
        assert.equal(page.status, 200);
        assert.match(page.headers.get('content-type'), /text\/html/);
        assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
        const html = await page.text();
        assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);

        const mf = await fetch(base + '/manifest.webmanifest');
        assert.equal(mf.status, 200);
        assert.match(mf.headers.get('content-type'), /application\/manifest\+json/);
        const manifest = await mf.json();
        assert.equal(manifest.display, 'standalone');
        assert.equal(manifest.start_url, '/');
        const sizes = manifest.icons.map(i => i.sizes);
        assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
        for (const icon of manifest.icons) {
            const r = await fetch(base + icon.src);
            assert.equal(r.status, 200, icon.src);
            await r.arrayBuffer();
        }

        const sw = await fetch(base + '/sw.js');
        assert.equal(sw.status, 200);
        assert.match(sw.headers.get('content-type'), /javascript/);
        assert.equal(sw.headers.get('cache-control'), 'no-cache');
        assert.match(await sw.text(), /addEventListener\('fetch'/);
    });
});


test('gzip, ETag/304, 404, 405, Status und Meta', async () => {
    await withMockApp(async base => {
        const raw = await fetch(base + '/app.js', { headers: { 'Accept-Encoding': 'identity' } });
        const etag = raw.headers.get('etag');
        assert.ok(etag);
        const notModified = await fetch(base + '/app.js', { headers: { 'If-None-Match': etag } });
        assert.equal(notModified.status, 304);

        const http = require('http');
        const gz = await new Promise((resolve, reject) => {
            http.get(base + '/', { headers: { 'Accept-Encoding': 'gzip' } }, res => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => resolve({ enc: res.headers['content-encoding'], body: Buffer.concat(chunks) }));
            }).on('error', reject);
        });
        assert.equal(gz.enc, 'gzip');
        assert.match(zlib.gunzipSync(gz.body).toString(), /<!DOCTYPE html>/);

        assert.equal((await fetch(base + '/gibtsnicht')).status, 404);
        assert.equal((await fetch(base + '/../config.js')).status, 404);
        assert.equal((await fetch(base + '/api/pv', { method: 'POST' })).status, 405);

        const status = await (await fetch(base + '/api/status')).json();
        assert.equal(status.mode, 'mock');
        assert.ok(status.lastUpdate);
        const meta = await (await fetch(base + '/api/meta')).json();
        assert.equal(meta.mock, true);
        assert.ok(!('influx' in meta), 'keine Zugangsdaten in /api/meta');
    });
});


test('Ohne frische Daten antwortet /api/pv mit 503', async () => {
    await withMockApp(async (base, app) => {
        app.status.lastUpdate = Date.now() - app.cfg.pollSeconds * 6000;
        const res = await fetch(base + '/api/pv');
        assert.equal(res.status, 503);
    });
});


test('Weboberflaeche laedt nichts von fremden Hosts', () => {
    const webDir = path.join(ROOT, 'web');
    const texts = fs.readdirSync(webDir).filter(f => /\.(html|css|js|webmanifest)$/.test(f))
        .map(f => [f, fs.readFileSync(path.join(webDir, f), 'utf8')]);
    for (const [f, t] of texts) {
        assert.ok(!/https?:\/\//.test(t.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')), `${f} enthaelt eine absolute URL`);
        assert.ok(!/@import|fonts\.googleapis|cdn\./i.test(t), `${f} laedt externe Ressourcen`);
    }
});

test('GIT_REVISION erscheint in Meta und Status, ohne Variable fehlt revision', async () => {
    const alt = process.env.GIT_REVISION;
    try {
        delete process.env.GIT_REVISION;
        await withMockApp(async base => {
            const meta = await (await fetch(base + '/api/meta')).json();
            assert.ok(!('revision' in meta));
        });
        process.env.GIT_REVISION = '7b7db58';
        await withMockApp(async base => {
            const meta = await (await fetch(base + '/api/meta')).json();
            const status = await (await fetch(base + '/api/status')).json();
            assert.equal(meta.revision, '7b7db58');
            assert.equal(status.revision, '7b7db58');
        });
    } finally {
        if (alt === undefined) delete process.env.GIT_REVISION; else process.env.GIT_REVISION = alt;
    }
});
