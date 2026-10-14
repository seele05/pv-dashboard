'use strict';

/*
 * Energiebilanz aus den Tageszaehlern (kWh):
 *
 *     PV + Netz = Verbrauch + Akku netto + Anlagen-Eigenverbrauch
 *
 *   Akku netto            = geladen - entladen (> 0: Akku hat Energie aufgenommen)
 *   Anlagen-Eigenverbrauch = PV + Netz - Verbrauch - Akku netto
 *                            (Wechselrichter im Leerlauf, Wandler-/Ladeverluste)
 *
 * Kennzahlen:
 *   Autarkie     = PV / (PV + Netz)
 *                  Anteil der Sonne an allem, was ins System fliesst. Unabhaengig davon,
 *                  ob Netzstrom die Verbraucher oder den Akku speist, und ohne Akku-Zaehler.
 *   Wirkungsgrad = Verbrauch / (PV + Netz - Akku netto)
 *                  Anteil der im Zeitraum umgesetzten Energie, der bei den Verbrauchern
 *                  ankommt; der Rest ist der Anlagen-Eigenverbrauch.
 *
 * Annahme: keine Netzeinspeisung (SolarDaily zaehlt nur Netzbezug). Abgeregelte PV
 * erscheint im PV-Zaehler gar nicht erst und verfaelscht daher nichts.
 *
 * Abweichung vom Original: Dort war Autarkie = (Verbrauch - Netz) / Verbrauch (falsch,
 * sobald Netzstrom den Akku laedt), "Eigenverbrauch" = Verbrauch / PV (keine
 * Eigenverbrauchsquote) und WR-Eigenverbrauch = PV - Verbrauch - geladen + entladen
 * (ohne Netzbezug).
 */

function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

function pct(v) {
    return Math.round(Math.max(0, Math.min(100, v)) * 10) / 10;
}


/**
 * @param {object} e { pv, grid, load, batIn, batOut } in kWh; batOut darf negativ sein (wie im Original)
 * @returns {{batNet, systemOwn, autarkie, wirkungsgrad}} je null, wenn die Eingaben fehlen
 */
function balance({ pv, grid, load, batIn, batOut }) {
    const batNet = isNum(batIn) && isNum(batOut) ? batIn - Math.abs(batOut) : null;
    const supply = isNum(pv) && isNum(grid) ? pv + grid : null;

    const autarkie = supply !== null && supply > 0 ? pct(pv / supply * 100) : null;

    let systemOwn = null;
    let wirkungsgrad = null;
    if (supply !== null && isNum(load) && batNet !== null) {
        systemOwn = supply - load - batNet;
        const used = supply - batNet;          // im Zeitraum verbrauchte Energie inkl. Anlage
        wirkungsgrad = used > 0 ? pct(load / used * 100) : null;
    }

    return { batNet, systemOwn, autarkie, wirkungsgrad };
}


module.exports = { balance };
