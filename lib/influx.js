'use strict';

/*
 * Minimaler InfluxDB-1.x-Client ueber die HTTP-API (ohne Abhaengigkeiten):
 *   POST /query  (InfluxQL, mehrere Statements mit ';', epoch=ms)
 *   POST /write  (Line Protocol, precision=ms)
 * Authentifizierung: Basic-Auth (username/password) oder `Authorization: Token <token>`
 * (InfluxDB-2.x-Kompatibilitaets-API).
 */

function quoteIdent(name) {
    return '"' + String(name).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function quoteString(s) {
    return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

/** Measurement-Name im Line Protocol: Komma und Leerzeichen escapen. */
function escapeMeasurement(name) {
    return String(name).replace(/([, \\])/g, '\\$1');
}


class InfluxClient {
    /**
     * @param {object} opts { url, db, rp, username, password, token, timeoutMs }
     */
    constructor(opts) {
        this.url = String(opts.url || '').replace(/\/+$/, '');
        this.db = opts.db;
        this.rp = opts.rp || '';
        this.timeoutMs = opts.timeoutMs ?? 10_000;
        this.headers = {};
        if (opts.token) {
            this.headers.Authorization = `Token ${opts.token}`;
        } else if (opts.username) {
            this.headers.Authorization = 'Basic ' + Buffer.from(`${opts.username}:${opts.password ?? ''}`).toString('base64');
        }
    }

    /** Vollqualifizierter Measurement-Name "db"."rp"."measurement" fuer FROM. */
    from(measurement) {
        return `${quoteIdent(this.db)}.${this.rp ? quoteIdent(this.rp) : ''}.${quoteIdent(measurement)}`;
    }

    /**
     * Fuehrt mehrere Statements in einem Request aus.
     * @returns {Promise<Array<{rows: {time:number, v:any}[], error: string|null}>>} je Statement
     *          die Zeilen der ersten Serie (Spalten time + v).
     */
    async query(statements) {
        const body = new URLSearchParams({ db: this.db, epoch: 'ms', q: statements.join(';\n') });
        const res = await fetch(`${this.url}/query`, {
            method: 'POST',
            headers: { ...this.headers, 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        const text = await res.text();
        let json;
        try {
            json = JSON.parse(text);
        } catch (_) {
            throw new Error(`InfluxDB /query: HTTP ${res.status}, keine JSON-Antwort`);
        }
        if (!res.ok || json.error) {
            throw new Error(`InfluxDB /query: ${json.error || 'HTTP ' + res.status}`);
        }
        return parseResults(json, statements.length);
    }

    /** Schreibt Zeilen im Line Protocol (precision=ms). */
    async write(lines) {
        if (lines.length === 0) return;
        const params = new URLSearchParams({ db: this.db, precision: 'ms' });
        if (this.rp) params.set('rp', this.rp);
        const res = await fetch(`${this.url}/write?${params}`, {
            method: 'POST',
            headers: { ...this.headers, 'Content-Type': 'text/plain; charset=utf-8' },
            body: lines.join('\n'),
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status !== 204) {
            const text = await res.text().catch(() => '');
            throw new Error(`InfluxDB /write: HTTP ${res.status} ${text.slice(0, 200)}`);
        }
    }
}


/** Wandelt die /query-Antwort in je ein Ergebnis pro Statement (nach statement_id). */
function parseResults(json, count) {
    const out = Array.from({ length: count }, () => ({ rows: [], error: null }));
    for (const r of json.results || []) {
        const slot = out[r.statement_id ?? 0];
        if (!slot) continue;
        if (r.error) {
            slot.error = r.error;
            continue;
        }
        const series = (r.series || [])[0];
        if (!series) continue;
        const ti = series.columns.indexOf('time');
        const vi = series.columns.indexOf('v');
        const li = series.columns.indexOf('lo');   // optionale zweite Spalte (z. B. Tagesminimum)
        slot.rows = (series.values || []).map(row => {
            const r = { time: Number(row[ti]), v: vi >= 0 ? row[vi] : null };
            if (li >= 0) r.lo = row[li];
            return r;
        });
    }
    return out;
}


/** Eine Zeile Line Protocol mit Feld `value` (float). */
function valueLine(measurement, value, timeMs) {
    return `${escapeMeasurement(measurement)} value=${Number(value)} ${Math.round(timeMs)}`;
}


module.exports = { InfluxClient, parseResults, quoteIdent, quoteString, escapeMeasurement, valueLine };
