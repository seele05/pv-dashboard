// Vorlage: nach config.js kopieren und anpassen. Alle Werte hier sind Platzhalter.
// Nicht gesetzte Schluessel uebernehmen die Defaults aus lib/config.js.
// config.local.json (falls vorhanden) ueberschreibt config.js.

module.exports = {
    // HTTP-Port der Oberflaeche und der API
    port: 8080,

    // Verzeichnis fuer solardaily-state.json (relativ zum Programmverzeichnis; leer = dieses).
    // Umgebungsvariable DATA_DIR hat Vorrang (Docker: /app/data).
    dataDir: '',

    // Zeitzone fuer Tagesgrenzen, Ankerzeiten (06:00/17:00), Quartal und Jahr
    timezone: 'Europe/Berlin',

    // Titel in der Oberflaeche
    title: 'PV-Anlage',

    // Live-Werte alle n Sekunden abfragen; Woche/Quartal/Jahr und PV-Prognose alle n Minuten
    pollSeconds: 30,
    aggregateMinutes: 30,
    forecastMinutes: 5,

    // Akku: nutzbare Kapazitaet und Mindest-SOC fuer die Restreichweite
    battery: {
        capacityKwh: 10,
        minSoc: 10,
    },

    // Skalen der Leistungsbalken in der Oberflaeche (W)
    display: {
        maxPvW: 10000,
        maxLoadW: 10000,
        maxBatW: 5000,
    },

    // InfluxDB 1.x (InfluxQL ueber HTTP /query). Fuer die 2.x-Kompatibilitaets-API
    // statt username/password ein token setzen.
    influx: {
        url: 'http://127.0.0.1:8086',
        db: 'meine_datenbank',
        rp: 'autogen',
        username: '',
        password: '',
        token: '',
    },

    // Measurement-Namen (je Messgroesse ein Measurement mit Feld "value").
    //
    // Beispiel fuer ioBroker mit Solar Assistant (MQTT-Adapter-Instanz 1),
    // pvforecast-Adapter und dem frueheren SolarDaily-Skript:
    //   soc:      'mqtt.1.solar_assistant.total.battery_state_of_charge.state'
    //   pv:       'mqtt.1.solar_assistant.total.pv_power.state'
    //   load:     'mqtt.1.solar_assistant.total.load_power.state'
    //   battery:  'mqtt.1.solar_assistant.total.battery_power.state'
    //   grid:     'mqtt.1.solar_assistant.total.grid_power.state'
    //   forecast: 'pvforecast.0.summary.power'
    //   daily.pv:     'javascript.0.SolarDaily.daily.pv_production'
    //   daily.load:   'javascript.0.SolarDaily.daily.load_consumption'
    //   daily.grid:   'javascript.0.SolarDaily.daily.grid_consumption'
    //   daily.batIn:  'javascript.0.SolarDaily.daily.bat_in'
    //   daily.batOut: 'javascript.0.SolarDaily.daily.bat_out'
    measurements: {
        soc: 'battery_soc',             // %
        pv: 'pv_power',                 // W
        load: 'load_power',             // W
        battery: 'battery_power',       // W, Laden positiv
        grid: 'grid_power',             // W, Bezug positiv (nur fuer SolarDaily mit input 'influx')
        forecast: 'pv_forecast_power',  // W, Prognosewerte mit zukuenftigen Zeitstempeln (beliebiges Raster)
        daily: {                        // kWh, Tageszaehler mit Reset um 00:00
            pv: 'daily_pv_production',
            load: 'daily_load_consumption',
            grid: 'daily_grid_consumption',
            batIn: 'daily_bat_in',
            batOut: 'daily_bat_out',
        },
    },

    // Eingebaute Tages-/Gesamtzaehler (Ersatz fuer das ioBroker-Skript SolarDaily).
    // Aus: Tageszaehler kommen aus InfluxDB (measurements.daily).
    solardaily: {
        enabled: false,

        // 'mqtt' (z. B. Solar Assistant direkt) oder 'influx' (Momentanwerte aus InfluxDB pollen)
        input: 'mqtt',

        // 'rectangle' (wie das Original-Skript) oder 'trapezoid'
        method: 'rectangle',
        maxGapMinutes: 5,

        // false, wenn die Quelle Laden als negative Leistung meldet
        batteryChargePositive: true,

        saveIntervalMinutes: 5,

        mqtt: {
            url: 'mqtt://127.0.0.1:1883',
            username: '',
            password: '',
            // Beispiel Solar Assistant:
            //   pv: 'solar_assistant/total/pv_power/state'
            //   load: 'solar_assistant/total/load_power/state'
            //   battery: 'solar_assistant/total/battery_power/state'
            //   grid: 'solar_assistant/total/grid_power/state'
            topics: {
                pv: 'pv_power',
                load: 'load_power',
                battery: 'battery_power',
                grid: 'grid_power',
            },
        },

        // nur input 'influx': Abfrageintervall der Momentanwerte
        influxPollSeconds: 10,

        // Zaehler zusaetzlich nach InfluxDB schreiben (gleiche Namen wie measurements.daily,
        // damit Ø 30 Tage, Quoten und Nacht/Tag/Abend weiter funktionieren)
        write: {
            enabled: false,
            intervalSeconds: 60,
            measurements: {
                daily: {
                    pv_production: 'daily_pv_production',
                    load_consumption: 'daily_load_consumption',
                    grid_consumption: 'daily_grid_consumption',
                    bat_in: 'daily_bat_in',
                    bat_out: 'daily_bat_out',
                },
                totals: {
                    pv_production: 'total_pv_production',
                    load_consumption: 'total_load_consumption',
                    grid_consumption: 'total_grid_consumption',
                    bat_in: 'total_bat_in',
                    bat_out: 'total_bat_out',
                },
            },
        },
    },
};
