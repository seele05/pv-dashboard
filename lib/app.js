'use strict';

/*
 * Verdrahtung: Datenquelle (InfluxDB oder Mock), optional SolarDaily, Zyklen,
 * Berechnung und HTTP-Server.
 */

const path = require('path');

const { InfluxClient } = require('./influx');
const { InfluxSource } = require('./source');
const { MockSource } = require('./mock');
const { SolarDaily } = require('./solardaily');
const { startMqttInput, startInfluxInput } = require('./inputs');
const { computePayload } = require('./metrics');
const { createServer } = require('./server');

const VERSION = require('../package.json').version;


class App {
    /**
     * @param {object} cfg Konfiguration aus lib/config.js
     * @param {object} [opts] { baseDir, log }
     */
    constructor(cfg, { baseDir = path.join(__dirname, '..'), log = console } = {}) {
        this.cfg = cfg;
        this.baseDir = baseDir;
        this.log = log;
        this.timers = [];
        this.payload = null;
        this.quoten = null;
        this.forecast = null;
        this.revision = String(process.env.GIT_REVISION || '').trim();
        this.loadProfile = null;
        this.status = {
            version: VERSION,
            ...(this.revision ? { revision: this.revision } : {}),
            mode: cfg.mock ? 'mock' : 'influx',
            startedAt: Date.now(),
            lastUpdate: null,
            lastError: null,
            aggregatesAt: null,
            aggregatesError: null,
            forecastAt: null,
            forecastError: null,
            solardaily: null,
        };

        if (cfg.mock) {
            this.source = new MockSource(cfg);
        } else {
            this.client = new InfluxClient(cfg.influx);
            this.source = new InfluxSource(cfg, this.client);
        }

        const sdCfg = cfg.solardaily;
        this.solardaily = (!cfg.mock && sdCfg.enabled)
            ? new SolarDaily({
                timezone: cfg.timezone,
                maxGapMinutes: sdCfg.maxGapMinutes,
                method: sdCfg.method,
                batteryChargePositive: sdCfg.batteryChargePositive,
                statePath: path.join(cfg.dataDir || baseDir, 'solardaily-state.json'),
                saveIntervalMinutes: sdCfg.saveIntervalMinutes,
                log,
            })
            : null;
    }

    async cycle() {
        const now = Date.now();
        try {
            const daily = this.solardaily ? this.solardaily.dailyValues(now) : null;
            const { d, errors } = await this.source.live(now, daily);
            if ((d.grid_w === null || d.grid_w === undefined) && this.solardaily) d.grid_w = this.solardaily.liveWatts('grid', now);
            if (this.forecast) Object.assign(d, this.forecast.summary);
            this.payload = computePayload(d, this.quoten, {
                capacityKwh: this.cfg.battery.capacityKwh,
                minSoc: this.cfg.battery.minSoc,
                now,
                tz: this.cfg.timezone,
                forecast: this.forecast ? this.forecast.chart.forecast.map(([time, v]) => ({ time, v })) : [],
                loadProfile: this.loadProfile,
            });
            this.status.lastUpdate = now;
            this.status.lastError = errors.length ? errors.join('; ') : null;
        } catch (err) {
            this.status.lastError = err.message;
            this.log.error(`Abfrage fehlgeschlagen: ${err.message}`);
        }
    }

    async aggregateCycle() {
        const now = Date.now();
        try {
            const { quoten, loadProfile, errors } = await this.source.aggregates(now);
            this.quoten = quoten;
            this.loadProfile = loadProfile ?? null;
            this.status.aggregatesAt = now;
            this.status.aggregatesError = errors.length ? errors.join('; ') : null;
        } catch (err) {
            this.status.aggregatesError = err.message;
            this.log.error(`Quoten-Abfrage fehlgeschlagen: ${err.message}`);
        }
    }

    async forecastCycle() {
        const now = Date.now();
        try {
            const { summary, chart, errors } = await this.source.forecast(now);
            this.forecast = { summary, chart };
            this.status.forecastAt = now;
            this.status.forecastError = errors.length ? errors.join('; ') : null;
        } catch (err) {
            this.status.forecastError = err.message;
            this.log.error(`Prognose-Abfrage fehlgeschlagen: ${err.message}`);
        }
    }

    /** Prognose- und Ist-Kurven fuer das Diagramm (null ohne Prognose-Measurement). */
    currentForecast() {
        return this.forecast ? { ...this.forecast.chart, ...this.forecast.summary } : null;
    }

    /** Antwort nur, solange sie frisch ist (max. 5 Zyklen alt). */
    currentPayload() {
        if (!this.payload || !this.status.lastUpdate) return null;
        return Date.now() - this.status.lastUpdate <= this.cfg.pollSeconds * 5000 ? this.payload : null;
    }

    meta() {
        return {
            title: this.cfg.title,
            timezone: this.cfg.timezone,
            mock: !!this.cfg.mock,
            pollSeconds: this.cfg.pollSeconds,
            battery: this.cfg.battery,
            display: this.cfg.display,
            version: VERSION,
            ...(this.revision ? { revision: this.revision } : {}),
        };
    }

    statusView() {
        const sd = this.solardaily;
        return {
            ...this.status,
            uptime: Date.now() - this.status.startedAt,
            solardaily: sd ? {
                input: this.cfg.solardaily.input,
                inputStatus: this.input ? this.input.status() : null,
                day: sd.state.day,
                daily: sd.state.daily,
                totals: sd.state.totals,
                lastWrite: this.lastSdWrite ?? null,
                writeError: this.sdWriteError ?? null,
            } : null,
        };
    }

    every(ms, fn) {
        const t = setInterval(fn, ms);
        this.timers.push(t);
        return t;
    }

    startSolarDaily() {
        const sd = this.solardaily;
        const sdCfg = this.cfg.solardaily;
        const onSample = (channel, watts, ts) => sd.sample(channel, watts, ts);

        this.input = sdCfg.input === 'influx'
            ? startInfluxInput(this.client, this.cfg.measurements, sdCfg.influxPollSeconds * 1000, onSample, this.log)
            : startMqttInput(sdCfg.mqtt, onSample, this.log);

        // Tageswechsel auch ohne neue Messwerte; Speichern gedrosselt in tick()
        this.every(60_000, () => sd.tick());
        const midnight = () => {
            const t = setTimeout(() => {
                sd.tick();
                midnight();
            }, sd.msUntilMidnight() + 1000);
            this.timers.push(t);
        };
        midnight();

        if (sdCfg.write.enabled) {
            this.every(sdCfg.write.intervalSeconds * 1000, async () => {
                const lines = sd.influxLines(sdCfg.write.measurements);
                try {
                    await this.client.write(lines);
                    this.lastSdWrite = Date.now();
                    this.sdWriteError = null;
                } catch (err) {
                    if (!this.sdWriteError) this.log.error(`SolarDaily: Schreiben fehlgeschlagen: ${err.message}`);
                    this.sdWriteError = err.message;
                }
            });
        }
    }

    /** Startet Zyklen und Server. Liefert den gebundenen Port. */
    async start({ listen = true } = {}) {
        if (this.solardaily) this.startSolarDaily();

        // Quoten (falls Tagesreihen konfiguriert) und Lastprofil fuer die smarte Reichweite
        await this.aggregateCycle();
        this.every(this.cfg.aggregateMinutes * 60_000, () => this.aggregateCycle());
        if (this.cfg.mock || this.cfg.measurements.forecast) {
            await this.forecastCycle();
            this.every(this.cfg.forecastMinutes * 60_000, () => this.forecastCycle());
        }
        await this.cycle();
        this.every(this.cfg.pollSeconds * 1000, () => this.cycle());

        this.server = createServer({
            webDir: path.join(__dirname, '..', 'web'),
            getPayload: () => this.currentPayload(),
            getStatus: () => this.statusView(),
            getMeta: () => this.meta(),
            getForecast: () => this.currentForecast(),
        });
        if (!listen) return null;
        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(this.cfg.port, resolve);
        });
        return this.server.address().port;
    }

    async stop() {
        for (const t of this.timers) {
            clearInterval(t);
            clearTimeout(t);
        }
        this.timers = [];
        if (this.input) await this.input.stop().catch(() => {});
        if (this.solardaily) this.solardaily.save(true);
        if (this.server) await new Promise(resolve => this.server.close(resolve));
    }
}


module.exports = { App };
