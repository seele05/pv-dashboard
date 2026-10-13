'use strict';

/*
 * Smarte Reichweite als Energiebilanz ueber die Zeit.
 *
 * Das Original rechnete "Akku jetzt + Prognose morgen >= Ø-Tagesverbrauch -> unendlich",
 * zaehlte die Sonne von morgen also so, als laege sie schon im Akku – auch wenn der
 * Akku in der Nacht leer wird. Hier wird in 15-min-Schritten von jetzt bis zum Ende
 * des morgigen Tages simuliert:
 *
 *   Akku(t + dt) = min(nutzbare Kapazitaet, Akku(t) + PV-Prognose(dt) - Verbrauch(dt))
 *
 * Verbrauch aus einem Lastprofil je Uhrzeit (Ø der letzten 14 Tage). Die Reichweite
 * ist die Zeit, bis der Akku den Mindest-SOC erreicht.
 */

const { localParts, startOfLocalDay } = require('./time');
const { integrateKwh } = require('./forecast');

const STEP_MS = 15 * 60_000;

function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
}


/**
 * Lastprofil: mittlere Leistung (W) je lokaler Stunde 0..23 aus Stundenmitteln.
 * Stunden ohne Werte erhalten das Mittel aller Stunden. Ohne jede Stunde: null.
 * @param {{time:number, v:number|null}[]} rows Stundenmittel (Bucket-Start)
 */
function buildLoadProfile(rows, tz) {
    const sum = Array(24).fill(0);
    const cnt = Array(24).fill(0);
    for (const r of rows || []) {
        if (!isNum(r.v) || r.v < 0) continue;
        const h = localParts(r.time, tz).hour;
        sum[h] += r.v;
        cnt[h] += 1;
    }
    const known = sum.map((s, h) => (cnt[h] ? s / cnt[h] : null));
    const vals = known.filter(v => v !== null);
    if (vals.length === 0) return null;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return known.map(v => Math.round(v === null ? mean : v));
}


/**
 * Simuliert den Akkustand.
 * @param {object} p
 * @param {number} p.now
 * @param {string} p.tz
 * @param {number} p.availKwh        nutzbare Energie jetzt (ueber Mindest-SOC), darf <= 0 sein
 * @param {number} p.usableKwh       nutzbare Kapazitaet gesamt ((100 - minSoc) % der Kapazitaet)
 * @param {{time,v}[]} [p.forecast]  PV-Prognose (W), ohne = keine Sonne angenommen
 * @param {number[]|null} [p.loadProfile] W je lokaler Stunde
 * @param {number|null} [p.loadW]    konstanter Verbrauch, falls kein Profil
 * @param {number} [p.until]         Ende der Simulation (Default: Ende des morgigen Tages)
 * @returns {{emptyTs:number|null, hours:number|null, minKwh:number, minTs:number, until:number}|null}
 *          null, wenn ohne Akku- oder Verbrauchsangabe nichts zu rechnen ist
 */
function simulate({ now, tz, availKwh, usableKwh, forecast = [], loadProfile = null, loadW = null, until }) {
    if (!isNum(availKwh) || !isNum(usableKwh)) return null;
    if (!loadProfile && !isNum(loadW)) return null;
    const end = until ?? startOfLocalDay(now, tz, 2);

    let e = Math.min(availKwh, usableKwh);
    let minKwh = e;
    let minTs = now;
    if (e <= 0) return { emptyTs: now, hours: 0, minKwh: e, minTs: now, until: end };

    for (let t = now; t < end; t += STEP_MS) {
        const t2 = Math.min(t + STEP_MS, end);
        const hours = (t2 - t) / 3_600_000;
        const pv = integrateKwh(forecast, t, t2) ?? 0;
        const w = loadProfile ? loadProfile[localParts(t, tz).hour] : loadW;
        const load = w / 1000 * hours;
        const next = Math.min(usableKwh, e + pv - load);
        if (next <= 0) {
            // linear auf den Zeitpunkt zurueckrechnen, an dem 0 erreicht wird
            const frac = e / (e - next);
            const emptyTs = t + (t2 - t) * frac;
            return { emptyTs, hours: (emptyTs - now) / 3_600_000, minKwh: 0, minTs: emptyTs, until: end };
        }
        e = next;
        if (e < minKwh) {
            minKwh = e;
            minTs = t2;
        }
    }
    return { emptyTs: null, hours: null, minKwh, minTs, until: end };
}


module.exports = { buildLoadProfile, simulate, STEP_MS };
