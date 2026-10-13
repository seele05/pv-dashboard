'use strict';

/*
 * Eingaenge fuer SolarDaily: liefern Messwerte (Kanal, Watt, Zeitpunkt) an onSample.
 *
 *  mqtt   – abonniert je Kanal ein Topic; Zeitpunkt = Empfangszeit.
 *  influx – fragt die letzten Momentanwerte ab; ein Wert wird nur einmal
 *           verarbeitet (neuer Zeitstempel noetig), Zeitpunkt = Zeitstempel in InfluxDB.
 *           Schreibt die Quelle nur bei Aenderung, entstehen bei konstanten Werten
 *           Luecken, die ab maxGapMinutes verworfen werden – MQTT ist genauer.
 */

const CHANNEL_KEYS = ['pv', 'load', 'battery', 'grid'];


/** Wandelt eine MQTT-Payload in eine Zahl (reine Zahl oder JSON mit `value`). */
function parsePayload(buf) {
    const s = String(buf).trim();
    let n = Number(s);
    if (s !== '' && Number.isFinite(n)) return n;
    try {
        const j = JSON.parse(s);
        n = Number(typeof j === 'object' && j !== null ? j.value : j);
        return Number.isFinite(n) ? n : null;
    } catch (_) {
        return null;
    }
}


function startMqttInput(cfg, onSample, log = console) {
    // erst hier laden: ohne SolarDaily/MQTT wird das Paket nicht benoetigt
    const mqtt = require('mqtt');
    const topics = cfg.topics || {};
    const byTopic = new Map(CHANNEL_KEYS.filter(k => topics[k]).map(k => [topics[k], k]));

    const client = mqtt.connect(cfg.url, {
        username: cfg.username || undefined,
        password: cfg.password || undefined,
        reconnectPeriod: 5_000,
        connectTimeout: 10_000,
    });

    client.on('connect', () => {
        log.log(`SolarDaily: MQTT verbunden, abonniere ${byTopic.size} Topics`);
        client.subscribe([...byTopic.keys()], err => {
            if (err) log.error(`SolarDaily: MQTT-Abo fehlgeschlagen: ${err.message}`);
        });
    });
    client.on('error', err => log.error(`SolarDaily: MQTT-Fehler: ${err.message}`));
    client.on('message', (topic, payload) => {
        const channel = byTopic.get(topic);
        const watts = parsePayload(payload);
        if (channel && watts !== null) onSample(channel, watts, Date.now());
    });

    return {
        status: () => (client.connected ? 'connected' : 'disconnected'),
        stop: () => new Promise(resolve => client.end(false, {}, resolve)),
    };
}


function startInfluxInput(client, measurements, intervalMs, onSample, log = console) {
    const keys = CHANNEL_KEYS.filter(k => measurements[k]);
    const statements = keys.map(k => `SELECT last("value") AS "v" FROM ${client.from(measurements[k])}`);
    const lastSeen = new Map();
    let state = 'starting';
    let timer = null;

    const poll = async () => {
        try {
            const results = await client.query(statements);
            results.forEach((r, i) => {
                const row = r.rows[r.rows.length - 1];
                if (r.error || !row || typeof row.v !== 'number') return;
                if (lastSeen.get(keys[i]) === row.time) return;
                lastSeen.set(keys[i], row.time);
                onSample(keys[i], row.v, row.time);
            });
            state = 'ok';
        } catch (err) {
            if (state !== 'error') log.error(`SolarDaily: Influx-Abfrage fehlgeschlagen: ${err.message}`);
            state = 'error';
        }
    };

    poll();
    timer = setInterval(poll, intervalMs);
    return {
        status: () => state,
        stop: async () => clearInterval(timer),
    };
}


module.exports = { startMqttInput, startInfluxInput, parsePayload };
