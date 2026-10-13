'use strict';

/*
 * Datenquelle InfluxDB: buendelt die Abfragen des Node-RED-Flows in zwei
 * Mehrfach-Queries.
 *
 *  live()       – jeder Zyklus (pollSeconds): Momentanwerte, Tageszaehler,
 *                 Prognose, Tagesreihe 32 Tage (Ø/gestern), Ankerpunkte 06/17
 *  aggregates() – alle aggregateMinutes: Tagesreihen 366 Tage fuer Last/PV/Netz,
 *                 daraus Woche, Quartal ("Jahreszeit") und Jahr
 *
 * Abweichungen vom Original:
 *  - Tagesbuckets per GROUP BY time(1d) ... tz('<timezone>') statt fest
 *    time(1d, 22h): Tagesgrenze ist ganzjaehrig lokale Mitternacht.
 *  - Ankerfenster 06:00/17:00 (+-15 min) in lokaler Zeit statt fest UTC+2.
 *  - Der ungenutzte Anker 22:00 und die doppelte Prognose-Abfrage entfallen.
 *  - Woche/Quartal/Jahr aus einer 366-Tage-Reihe je Groesse (3 statt 9 Abfragen).
 */

const { zonedToUtc, localParts } = require('./time');
const { quoteString } = require('./influx');
const { periodSums, periodQuotes } = require('./metrics');


function iso(ms) {
    return quoteString(new Date(ms).toISOString());
}

function lastValue(result) {
    if (!result || result.error || result.rows.length === 0) return null;
    const v = result.rows[result.rows.length - 1].v;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}


class InfluxSource {
    /**
     * @param {object} cfg Konfiguration (lib/config.js)
     * @param {import('./influx').InfluxClient} client
     */
    constructor(cfg, client) {
        this.cfg = cfg;
        this.client = client;
        this.tz = cfg.timezone;
        this.m = cfg.measurements;
    }

    /** Liefert die Statements fuer einen Live-Zyklus und die Zuordnung Index -> Feld. */
    liveStatements(now, { withDaily = true } = {}) {
        const c = this.client;
        const tzc = `tz(${quoteString(this.tz)})`;
        const p = localParts(now, this.tz);
        const anchor = h => {
            const t = zonedToUtc(p.year, p.month, p.day, h, 0, 0, this.tz);
            return `time >= ${iso(t - 15 * 60_000)} AND time <= ${iso(t + 15 * 60_000)}`;
        };

        const list = [
            ['soc', `SELECT last("value") AS "v" FROM ${c.from(this.m.soc)}`],
            ['pv_w', `SELECT last("value") AS "v" FROM ${c.from(this.m.pv)}`],
            ['load_w', `SELECT last("value") AS "v" FROM ${c.from(this.m.load)}`],
            ['bat_w', `SELECT last("value") AS "v" FROM ${c.from(this.m.battery)}`],
        ];
        if (this.m.forecast) {
            list.push(['forecast_w', `SELECT last("value") AS "v" FROM ${c.from(this.m.forecast)} WHERE time <= now() AND time >= now() - 1h`]);
            list.push(['forecast_sum', `SELECT sum("value") AS "v" FROM ${c.from(this.m.forecast)} WHERE time > now() AND time <= now() + 24h`]);
        }
        if (withDaily) {
            const d = this.m.daily;
            list.push(['daily_pv_kwh', `SELECT last("value") AS "v" FROM ${c.from(d.pv)} WHERE time > now() - 2d`]);
            list.push(['daily_load_kwh', `SELECT last("value") AS "v" FROM ${c.from(d.load)} WHERE time > now() - 2d`]);
            list.push(['daily_grid_kwh', `SELECT last("value") AS "v" FROM ${c.from(d.grid)} WHERE time > now() - 2d`]);
            list.push(['daily_bat_in', `SELECT last("value") AS "v" FROM ${c.from(d.batIn)} WHERE time > now() - 2d`]);
            list.push(['daily_bat_out', `SELECT last("value") AS "v" FROM ${c.from(d.batOut)} WHERE time > now() - 2d`]);
        }
        if (this.m.daily.load) {
            list.push(['avg_rows', `SELECT max("value") AS "v" FROM ${c.from(this.m.daily.load)} WHERE time >= now() - 32d GROUP BY time(1d) fill(null) ${tzc}`]);
            list.push(['anchor_06', `SELECT first("value") AS "v" FROM ${c.from(this.m.daily.load)} WHERE ${anchor(6)}`]);
            list.push(['anchor_17', `SELECT first("value") AS "v" FROM ${c.from(this.m.daily.load)} WHERE ${anchor(17)}`]);
        }
        return list;
    }

    /**
     * Ein Live-Zyklus. `dailyOverride` (SolarDaily) ersetzt die Tageszaehler aus InfluxDB.
     * @returns {Promise<{d: object, errors: string[]}>}
     */
    async live(now, dailyOverride = null) {
        const list = this.liveStatements(now, { withDaily: !dailyOverride });
        const results = await this.client.query(list.map(([, q]) => q));
        const d = {
            soc: null, pv_w: null, load_w: null, bat_w: null, forecast_w: null, forecast_tomorrow_kwh: null,
            daily_pv_kwh: null, daily_load_kwh: null, daily_grid_kwh: null, daily_bat_in: null, daily_bat_out: null,
            avg_rows: [], anchor_06: null, anchor_17: null,
        };
        const errors = [];
        list.forEach(([key], i) => {
            const r = results[i];
            if (r.error) errors.push(`${key}: ${r.error}`);
            if (key === 'avg_rows') d.avg_rows = r.error ? [] : r.rows;
            else if (key === 'forecast_sum') {
                // wie im Original: Summe der Prognosewerte (W, stuendlich) / 1000 = kWh
                const v = lastValue(r);
                d.forecast_tomorrow_kwh = v === null ? null : v / 1000;
            } else d[key] = lastValue(r);
        });
        if (dailyOverride) Object.assign(d, dailyOverride);
        return { d, errors };
    }

    aggregateStatements() {
        const c = this.client;
        const tzc = `tz(${quoteString(this.tz)})`;
        const q = name => `SELECT max("value") AS "v" FROM ${c.from(name)} WHERE time >= now() - 366d GROUP BY time(1d) fill(null) ${tzc}`;
        return [q(this.m.daily.load), q(this.m.daily.pv), q(this.m.daily.grid)];
    }

    /** Quoten Woche/Quartal/Jahr. */
    async aggregates(now) {
        const [load, pv, grid] = await this.client.query(this.aggregateStatements());
        const errors = [load, pv, grid].filter(r => r.error).map(r => r.error);
        const sums = periodSums({ load: load.rows, pv: pv.rows, grid: grid.rows }, now, this.tz);
        return { quoten: periodQuotes(sums), errors };
    }
}


module.exports = { InfluxSource };
