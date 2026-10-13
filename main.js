'use strict';

/*
 * pv-dashboard – PV-/Akku-Uebersicht als PWA mit JSON-API.
 *
 *   node main.js          Betrieb mit config.js
 *   node main.js --mock   erfundene Beispieldaten, ohne InfluxDB (config.js optional)
 */

const { loadConfig } = require('./lib/config');
const { App } = require('./lib/app');


async function main() {
    const mock = process.argv.includes('--mock');

    let cfg;
    try {
        cfg = loadConfig(__dirname, { mock });
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }

    const app = new App(cfg);
    const port = await app.start();

    console.log(`pv-dashboard ${app.status.version} -> http://localhost:${port}/`);
    console.log(cfg.mock
        ? 'Modus: Mock (erfundene Beispieldaten)'
        : `Modus: InfluxDB ${cfg.influx.url} db=${cfg.influx.db}, Zeitzone ${cfg.timezone}, SolarDaily ${cfg.solardaily.enabled ? cfg.solardaily.input : 'aus'}`);

    let stopping = false;
    const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        console.log('Beende …');
        await app.stop();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}


main().catch(err => {
    console.error(err);
    process.exit(1);
});
