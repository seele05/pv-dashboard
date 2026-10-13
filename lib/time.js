'use strict';

/*
 * Zeitzonen-Hilfen ohne Abhaengigkeiten (Intl). Alle Tagesgrenzen, Ankerzeiten
 * und Quartale werden in der konfigurierten Zeitzone gerechnet, nicht in UTC
 * und nicht in der Zeitzone des Prozesses.
 */

const formatters = new Map();

function formatter(tz) {
    if (!formatters.has(tz)) {
        formatters.set(tz, new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        }));
    }
    return formatters.get(tz);
}


/** Lokale Datums-/Zeitbestandteile eines Zeitpunkts in `tz`. */
function localParts(ms, tz) {
    const out = {};
    for (const p of formatter(tz).formatToParts(new Date(ms))) {
        if (p.type !== 'literal') {
            out[p.type] = Number(p.value);
        }
    }
    return { year: out.year, month: out.month, day: out.day, hour: out.hour, minute: out.minute, second: out.second };
}


/** Versatz der Zeitzone zu UTC in Millisekunden zum Zeitpunkt `ms`. */
function offsetMs(ms, tz) {
    const p = localParts(ms, tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return asUtc - (Math.floor(ms / 1000) * 1000);
}


/**
 * UTC-Zeitpunkt fuer eine lokale Wanduhrzeit in `tz`. Bei Uhrzeiten, die es wegen
 * der Zeitumstellung nicht gibt (Fruehjahr), wird auf die naechste gueltige verschoben;
 * bei doppelten (Herbst) gilt die erste.
 */
function zonedToUtc(year, month, day, hour = 0, minute = 0, second = 0, tz) {
    const wall = Date.UTC(year, month - 1, day, hour, minute, second);
    let guess = wall - offsetMs(wall, tz);
    guess = wall - offsetMs(guess, tz);
    return guess;
}


/** Lokales Datum als 'YYYY-MM-DD'. */
function localDateKey(ms, tz) {
    const p = localParts(ms, tz);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}


/** Beginn (00:00 lokal) des lokalen Tages, in dem `ms` liegt, plus `addDays` Tage. */
function startOfLocalDay(ms, tz, addDays = 0) {
    const p = localParts(ms, tz);
    return zonedToUtc(p.year, p.month, p.day + addDays, 0, 0, 0, tz);
}


/** Erster Tag des lokalen Kalenderquartals als 'YYYY-MM-DD'. */
function quarterStartKey(ms, tz) {
    const p = localParts(ms, tz);
    const m = [1, 1, 1, 4, 4, 4, 7, 7, 7, 10, 10, 10][p.month - 1];
    return `${p.year}-${String(m).padStart(2, '0')}-01`;
}


/** Erster Tag des lokalen Kalenderjahres als 'YYYY-MM-DD'. */
function yearStartKey(ms, tz) {
    return `${localParts(ms, tz).year}-01-01`;
}


module.exports = { localParts, offsetMs, zonedToUtc, localDateKey, startOfLocalDay, quarterStartKey, yearStartKey };
