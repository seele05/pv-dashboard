/**
 * SolarDaily v3 — Tages- und Gesamtzähler für Solar Assistant Messwerte
 *
 * Berechnet aus den Momentanleistungen (W) die kumulierten Energiemengen (kWh)
 * durch Integration über die Zeit (Leistung × Zeitdifferenz).
 *
 * Datenpunkte:
 *   javascript.0.SolarDaily.daily.*   → Reset täglich um 00:00 Uhr
 *   javascript.0.SolarDaily.totals.*  → Laufende Gesamtsummen, kein Reset
 *   javascript.0.SolarDaily.ts.*      → Reine Timestamp-Träger, bei jedem
 *                                        Trigger aktualisiert — verhindert
 *                                        dass Nachtpause als Ausfall gilt.
 *
 * Schutz gegen Ausreißer:
 *   Zeitlücken > MAX_GAP_MINUTES werden verworfen (Solar Assistant Ausfall).
 *   Timestamp wird trotzdem aktualisiert damit der nächste Wert normal läuft.
 */

const PRE_DP = 'javascript.0.SolarDaily';
const MAX_GAP_HOURS = 5 / 60; // 5 Minuten in Stunden

// -----------------------------------------------------------------------------
// DATENPUNKTE ANLEGEN falls nicht vorhanden
// -----------------------------------------------------------------------------
const dpDefs = [
    { id: 'daily.pv_production',    name: 'PV Produktion Heute',       unit: 'kWh' },
    { id: 'daily.load_consumption', name: 'Verbrauch Heute',            unit: 'kWh' },
    { id: 'daily.bat_in',           name: 'Batterie geladen Heute',     unit: 'kWh' },
    { id: 'daily.bat_out',          name: 'Batterie entladen Heute',    unit: 'kWh' },
    { id: 'daily.grid_consumption', name: 'Netzbezug Heute',            unit: 'kWh' },
    { id: 'totals.pv_production',   name: 'PV Produktion Total',        unit: 'kWh' },
    { id: 'totals.load_consumption',name: 'Verbrauch Total',            unit: 'kWh' },
    { id: 'totals.battery_in',      name: 'Batterie geladen Total',     unit: 'kWh' },
    { id: 'totals.battery_out',     name: 'Batterie entladen Total',    unit: 'kWh' },
    { id: 'totals.grid_consumption',name: 'Netzbezug Total',            unit: 'kWh' },
    { id: 'ts.pv',                  name: 'Timestamp PV',               unit: 'W'   },
    { id: 'ts.load',                name: 'Timestamp Load',             unit: 'W'   },
    { id: 'ts.bat_in',              name: 'Timestamp Batterie laden',   unit: 'W'   },
    { id: 'ts.bat_out',             name: 'Timestamp Batterie entladen',unit: 'W'   },
    { id: 'ts.grid',                name: 'Timestamp Netz',             unit: 'W'   },
];

dpDefs.forEach(dp => {
    const fullId = PRE_DP + '.' + dp.id;
    if (!existsState(fullId)) {
        createState(fullId, 0, { name: dp.name, type: 'number', role: 'value', unit: dp.unit });
        log('SolarDaily: Datenpunkt angelegt: ' + fullId, 'info');
    }
});


// -----------------------------------------------------------------------------
// HILFSFUNKTION: Zeitdifferenz prüfen
// -----------------------------------------------------------------------------
function getValidTimeDiff(lastTs) {
    const diffH = (Date.now() - lastTs) / 3600000;
    if (isNaN(diffH) || diffH < 0 || diffH > MAX_GAP_HOURS) return null;
    return diffH;
}


// -----------------------------------------------------------------------------
// PV PRODUKTION
// -----------------------------------------------------------------------------
on('mqtt.1.solar_assistant.total.pv_power.state', () => {
    const watts = getState('mqtt.1.solar_assistant.total.pv_power.state').val;
    const dt    = getValidTimeDiff(getState(PRE_DP + '.ts.pv').ts);
    setState(PRE_DP + '.ts.pv', watts); // Timestamp immer aktualisieren
    if (dt === null) return;
    const kwh = (watts / 1000) * dt;
    setState(PRE_DP + '.totals.pv_production', getState(PRE_DP + '.totals.pv_production').val + kwh);
    setState(PRE_DP + '.daily.pv_production',  getState(PRE_DP + '.daily.pv_production').val  + kwh);
});


// -----------------------------------------------------------------------------
// LASTVERBRAUCH
// -----------------------------------------------------------------------------
on('mqtt.1.solar_assistant.total.load_power.state', () => {
    const watts = getState('mqtt.1.solar_assistant.total.load_power.state').val;
    const dt    = getValidTimeDiff(getState(PRE_DP + '.ts.load').ts);
    setState(PRE_DP + '.ts.load', watts);
    if (dt === null) return;
    const kwh = (watts / 1000) * dt;
    setState(PRE_DP + '.totals.load_consumption', getState(PRE_DP + '.totals.load_consumption').val + kwh);
    setState(PRE_DP + '.daily.load_consumption',  getState(PRE_DP + '.daily.load_consumption').val  + kwh);
});


// -----------------------------------------------------------------------------
// BATTERIE LADEN / ENTLADEN
// Beide Timestamps werden immer aktualisiert um Richtungswechsel abzufangen.
// -----------------------------------------------------------------------------
on('mqtt.1.solar_assistant.total.battery_power.state', () => {
    const watts = getState('mqtt.1.solar_assistant.total.battery_power.state').val;

    if (watts >= 0) {
        const dt = getValidTimeDiff(getState(PRE_DP + '.ts.bat_in').ts);
        setState(PRE_DP + '.ts.bat_in',  watts);
        setState(PRE_DP + '.ts.bat_out', watts);
        if (dt === null) return;
        const kwh = (watts / 1000) * dt;
        setState(PRE_DP + '.totals.battery_in', getState(PRE_DP + '.totals.battery_in').val + kwh);
        setState(PRE_DP + '.daily.bat_in',       getState(PRE_DP + '.daily.bat_in').val       + kwh);
    } else {
        const dt = getValidTimeDiff(getState(PRE_DP + '.ts.bat_out').ts);
        setState(PRE_DP + '.ts.bat_out', watts);
        setState(PRE_DP + '.ts.bat_in',  watts);
        if (dt === null) return;
        const kwh = (watts / 1000) * dt;
        setState(PRE_DP + '.totals.battery_out', getState(PRE_DP + '.totals.battery_out').val + kwh);
        setState(PRE_DP + '.daily.bat_out',       getState(PRE_DP + '.daily.bat_out').val       + kwh);
    }
});


// -----------------------------------------------------------------------------
// NETZBEZUG
// -----------------------------------------------------------------------------
on('mqtt.1.solar_assistant.total.grid_power.state', () => {
    const watts = getState('mqtt.1.solar_assistant.total.grid_power.state').val;
    const dt    = getValidTimeDiff(getState(PRE_DP + '.ts.grid').ts);
    setState(PRE_DP + '.ts.grid', watts);
    if (watts < 0) return; // Einspeisung — nicht relevant
    if (dt === null) return;
    const kwh = (watts / 1000) * dt;
    setState(PRE_DP + '.totals.grid_consumption', getState(PRE_DP + '.totals.grid_consumption').val + kwh);
    setState(PRE_DP + '.daily.grid_consumption',  getState(PRE_DP + '.daily.grid_consumption').val  + kwh);
});


// -----------------------------------------------------------------------------
// TAGESRESET — täglich um 00:00 Uhr
// -----------------------------------------------------------------------------
schedule('0 0 * * *', () => {
    log('SolarDaily: Tagesreset um 00:00 Uhr', 'info');
    setState(PRE_DP + '.daily.pv_production',    0);
    setState(PRE_DP + '.daily.load_consumption', 0);
    setState(PRE_DP + '.daily.bat_in',           0);
    setState(PRE_DP + '.daily.bat_out',          0);
    setState(PRE_DP + '.daily.grid_consumption', 0);
});