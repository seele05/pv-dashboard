'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { InfluxClient, parseResults, quoteIdent, escapeMeasurement } = require('../lib/influx');
const { InfluxSource } = require('../lib/source');
const { startInfluxInput, parsePayload } = require('../lib/inputs');
const { DEFAULTS, deepMerge, validate } = require('../lib/config');

const M = {
    soc: 'soc', pv: 'pv', load: 'load', battery: 'bat', grid: 'grid', forecast: 'fc',
    daily: { pv: 'd.pv', load: 'd.load', grid: 'd.grid', batIn: 'd.in', batOut: 'd.out' },
};

/**
 * Nachgebauter InfluxDB-Server: beantwortet jedes Statement anhand des Measurements
 * mit `answer(statement)` und protokolliert Requests.
 */
async function fakeInflux(answer) {
    const requests = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
            requests.push({ method: req.method, url: req.url, headers: req.headers, body });
            if (req.url.startsWith('/write')) {
                res.writeHead(204);
                return res.end();
            }
            const params = new URLSearchParams(body);
            const statements = params.get('q').split(';\n');
            const results = statements.map((q, i) => {
                const a = answer(q);
                if (a && a.error) return { statement_id: i, error: a.error };
                if (!a) return { statement_id: i };
                return { statement_id: i, series: [{ name: 'x', columns: ['time', 'v'], values: a }] };
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ results }));
        });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise(r => server.close(r)) };
}

function cfgWith(url) {
    return deepMerge(DEFAULTS, { influx: { url, db: 'testdb', rp: 'autogen', username: 'u', password: 'p' }, measurements: M });
}


test('Hilfsfunktionen: Quoting, Escaping, Payload-Parsing', () => {
    assert.equal(quoteIdent('a"b\\c'), '"a\\"b\\\\c"');
    assert.equal(escapeMeasurement('a b,c'), 'a\\ b\\,c');
    assert.equal(parsePayload(Buffer.from(' 1234.5 ')), 1234.5);
    assert.equal(parsePayload(Buffer.from('{"value": -20}')), -20);
    assert.equal(parsePayload(Buffer.from('n/a')), null);
    assert.equal(parsePayload(Buffer.from('')), null);
});


test('parseResults ordnet nach statement_id und meldet Fehler je Statement', () => {
    const out = parseResults({
        results: [
            { statement_id: 1, error: 'kaputt' },
            { statement_id: 0, series: [{ columns: ['time', 'v'], values: [[1000, 5], [2000, null]] }] },
        ],
    }, 3);
    assert.deepEqual(out[0].rows, [{ time: 1000, v: 5 }, { time: 2000, v: null }]);
    assert.equal(out[1].error, 'kaputt');
    assert.deepEqual(out[2], { rows: [], error: null });
});


test('Live-Zyklus: eine Mehrfach-Query, lokale Ankerfenster, tz()-Tagesbuckets, Basic-Auth', async () => {
    const now = Date.parse('2026-01-15T16:30:00Z');   // 17:30 Berlin (Winterzeit, UTC+1)
    const fake = await fakeInflux(q => {
        if (q.includes('"soc"')) return [[now, 64]];
        if (q.includes('"pv"')) return [[now, 0]];
        if (q.includes('"load"')) return [[now, 2000]];
        if (q.includes('"bat"')) return [[now, -1900]];
        if (q.includes('last("value")') && q.includes('"fc"')) return null;     // keine aktuelle Prognose
        if (q.includes('GROUP BY time(1d)')) return Array.from({ length: 33 }, (_, i) => [now - (32 - i) * 86400_000, i === 32 ? 9 : 10]);
        if (q.includes('first("value")') && q.includes('04:45:00')) return [[now, 3.2]];
        if (q.includes('first("value")') && q.includes('15:45:00')) return [[now, 8.1]];
        if (q.includes('first("value")')) return null;
        if (q.includes('"d.load"')) return [[now, 9]];
        if (q.includes('"d.pv"')) return [[now, 1.5]];
        if (q.includes('"d.grid"')) return [[now, 0.4]];
        if (q.includes('"d.in"')) return [[now, 0.5]];
        if (q.includes('"d.out"')) return [[now, -3]];
        return null;
    });
    try {
        const cfg = cfgWith(fake.url);
        const src = new InfluxSource(cfg, new InfluxClient(cfg.influx));
        const { d, errors } = await src.live(now);

        assert.equal(fake.requests.length, 1, 'genau ein HTTP-Request');
        const req = fake.requests[0];
        assert.equal(req.method, 'POST');
        assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('u:p').toString('base64'));
        const params = new URLSearchParams(req.body);
        assert.equal(params.get('db'), 'testdb');
        assert.equal(params.get('epoch'), 'ms');
        const q = params.get('q');
        assert.match(q, /FROM "testdb"\."autogen"\."soc"/);
        assert.match(q, /GROUP BY time\(1d\) fill\(null\) tz\('Europe\/Berlin'\)/);
        assert.ok(!q.includes('22h'), 'kein fester UTC-Versatz');
        // 06:00 MEZ = 05:00 UTC -> Fenster 04:45..05:15 UTC; 17:00 MEZ = 16:00 UTC
        assert.match(q, /time >= '2026-01-15T04:45:00\.000Z' AND time <= '2026-01-15T05:15:00\.000Z'/);
        assert.match(q, /time >= '2026-01-15T15:45:00\.000Z' AND time <= '2026-01-15T16:15:00\.000Z'/);

        assert.deepEqual(errors, []);
        assert.equal(d.soc, 64);
        assert.equal(d.load_w, 2000);
        assert.equal(d.bat_w, -1900);
        assert.equal(d.forecast_w, null);
        assert.ok(!q.includes('sum("value")'), 'Prognosesumme nicht mehr im Live-Zyklus');
        assert.equal(d.daily_load_kwh, 9);
        assert.equal(d.daily_bat_out, -3);
        assert.equal(d.avg_rows.length, 33);
        assert.equal(d.anchor_06, 3.2);
        assert.equal(d.anchor_17, 8.1);
    } finally {
        await fake.close();
    }
});


test('Live-Zyklus mit SolarDaily: Tageszaehler kommen nicht aus InfluxDB', async () => {
    const fake = await fakeInflux(() => [[0, 1]]);
    try {
        const cfg = cfgWith(fake.url);
        const src = new InfluxSource(cfg, new InfluxClient(cfg.influx));
        const { d } = await src.live(Date.now(), { daily_pv_kwh: 7, daily_load_kwh: 6, daily_grid_kwh: 0, daily_bat_in: 1, daily_bat_out: -1 });
        const q = new URLSearchParams(fake.requests[0].body).get('q');
        assert.ok(!/last\("value"\) AS "v" FROM "testdb"\."autogen"\."d\.pv"/.test(q));
        assert.equal(d.daily_pv_kwh, 7);
        assert.equal(d.daily_bat_out, -1);
    } finally {
        await fake.close();
    }
});


test('Statement-Fehler werden gemeldet, uebrige Werte bleiben nutzbar', async () => {
    const fake = await fakeInflux(q => (q.includes('"soc"') ? { error: 'measurement not found' } : [[0, 100]]));
    try {
        const cfg = cfgWith(fake.url);
        const src = new InfluxSource(cfg, new InfluxClient(cfg.influx));
        const { d, errors } = await src.live(Date.now());
        assert.equal(d.soc, null);
        assert.equal(d.pv_w, 100);
        assert.deepEqual(errors, ['soc: measurement not found']);
    } finally {
        await fake.close();
    }
});


test('HTTP-Fehler und Nicht-JSON werden als Fehler geworfen', async () => {
    const server = http.createServer((req, res) => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":"authorization failed"}');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
        const c = new InfluxClient({ url: `http://127.0.0.1:${server.address().port}`, db: 'x', token: 'abc' });
        await assert.rejects(c.query(['SELECT 1']), /authorization failed/);
    } finally {
        await new Promise(r => server.close(r));
    }
});


test('Aggregate: 3 Tagesreihen ueber 366 Tage, Quoten berechnet', async () => {
    const now = Date.parse('2026-05-10T10:00:00Z');
    const fake = await fakeInflux(q => {
        const v = q.includes('"d.load"') ? 10 : q.includes('"d.pv"') ? 20 : 2;
        return Array.from({ length: 367 }, (_, i) => [now - (366 - i) * 86400_000, v]);
    });
    try {
        const cfg = cfgWith(fake.url);
        const src = new InfluxSource(cfg, new InfluxClient(cfg.influx));
        const { quoten } = await src.aggregates(now);
        const q = new URLSearchParams(fake.requests[0].body).get('q');
        assert.equal(q.split(';\n').length, 3);
        assert.match(q, /now\(\) - 366d GROUP BY time\(1d\) fill\(null\) tz\('Europe\/Berlin'\)/);
        assert.deepEqual(quoten.woche, { aut: 80, ev: 50 });
        assert.deepEqual(quoten.jahr, { aut: 80, ev: 50 });
    } finally {
        await fake.close();
    }
});


test('Influx-Eingang fuer SolarDaily: jeder Zeitstempel nur einmal, Token-Auth', async () => {
    let t = 1000;
    const fake = await fakeInflux(() => [[t, 500]]);
    try {
        const client = new InfluxClient({ url: fake.url, db: 'x', token: 'user:pass' });
        const samples = [];
        const input = startInfluxInput(client, { pv: 'pv', load: 'load' }, 50, (...a) => samples.push(a), { error() {} });
        await new Promise(r => setTimeout(r, 180));
        t = 2000;
        await new Promise(r => setTimeout(r, 120));
        await input.stop();
        assert.equal(fake.requests[0].headers.authorization, 'Token user:pass');
        assert.deepEqual(samples.filter(s => s[0] === 'pv').map(s => s[2]), [1000, 2000]);
        assert.equal(input.status(), 'ok');
    } finally {
        await fake.close();
    }
});


test('Schreiben: Line Protocol mit precision=ms an /write', async () => {
    const fake = await fakeInflux(() => null);
    try {
        const c = new InfluxClient({ url: fake.url, db: 'db1', rp: 'rp1' });
        await c.write(['a value=1 1000', 'b value=2 1000']);
        const req = fake.requests[0];
        assert.equal(req.url, '/write?db=db1&precision=ms&rp=rp1');
        assert.equal(req.body, 'a value=1 1000\nb value=2 1000');
        await c.write([]);
        assert.equal(fake.requests.length, 1, 'leere Liste schreibt nichts');
    } finally {
        await fake.close();
    }
});


test('Konfiguration: Pflichtfelder ausserhalb des Mock-Modus', () => {
    const errs = validate(deepMerge(DEFAULTS, {}));
    assert.ok(errs.includes('influx.db fehlt'));
    assert.ok(errs.includes('measurements.soc fehlt'));
    assert.ok(errs.includes('measurements.daily.load fehlt'));
    assert.deepEqual(validate(deepMerge(DEFAULTS, { mock: true })), []);
    assert.ok(validate(deepMerge(DEFAULTS, { mock: true, timezone: 'Mars/Olympus' }))[0].startsWith('timezone'));
    const sd = validate(deepMerge(DEFAULTS, { influx: { db: 'x' }, measurements: M, solardaily: { enabled: true, input: 'mqtt' } }));
    assert.deepEqual(sd, ['solardaily.mqtt.url fehlt']);
});


test('Prognose-Zyklus: Rohwerte gestern bis uebermorgen (lokal), Ist als 15-min-Mittel, integriert', async () => {
    const { zonedToUtc } = require('../lib/time');
    const TZ = 'Europe/Berlin';
    const now = zonedToUtc(2026, 6, 15, 12, 0, 0, TZ);
    // morgen konstant 1000 W von 08:00 bis 18:00 im 30-min-Raster -> 10 kWh (Original sum/1000: 21)
    const pts = [];
    for (let t = zonedToUtc(2026, 6, 16, 8, 0, 0, TZ); t <= zonedToUtc(2026, 6, 16, 18, 0, 0, TZ); t += 1_800_000) pts.push([t, 1000]);
    const fake = await fakeInflux(q => {
        if (q.includes('"fc"')) return pts;
        if (q.includes('mean("value")')) return [[now - 900_000, 750]];
        if (q.includes('"d.pv"')) return [[now - 86400_000, 18.25]];
        return null;
    });
    try {
        const cfg = cfgWith(fake.url);
        const src = new InfluxSource(cfg, new InfluxClient(cfg.influx));
        const { summary, chart, errors } = await src.forecast(now);
        const q = new URLSearchParams(fake.requests[0].body).get('q');
        // 14.06. 00:00 MESZ = 13.06. 22:00 UTC; 17.06. 00:00 MESZ = 16.06. 22:00 UTC
        assert.match(q, /FROM "testdb"\."autogen"\."fc" WHERE time >= '2026-06-13T22:00:00\.000Z' AND time < '2026-06-16T22:00:00\.000Z'/);
        assert.match(q, /GROUP BY time\(15m\) fill\(none\) tz\('Europe\/Berlin'\)/);
        assert.deepEqual(errors, []);
        assert.equal(summary.forecast_tomorrow_kwh, 10);
        assert.equal(summary.forecast_tomorrow_peak_w, 1000);
        assert.equal(summary.forecast_today_kwh, null);
        assert.equal(summary.actual_yesterday_kwh, 18.25);
        assert.equal(chart.forecast.length, pts.length);
        assert.deepEqual(chart.actual, [[now - 900_000, 750]]);
    } finally {
        await fake.close();
    }
});
