# Übergabe: pv-dashboard bauen

Auftrag für eine Claude-Code-Session (Cloud). Lies diese Datei vollständig, dann `reference/`. Arbeite auf einem Feature-Branch `feature/pv-dashboard`, **nicht** direkt auf `main`. Am Ende: Pull Request gegen `main`, Review erfolgt danach.

## Ziel

Ein eigenständiger, generischer Dienst, der ein PV-/Akku-System (Inselanlage oder netzgekoppelt) übersichtlich darstellt:

1. **Mobile App** als PWA (installierbar „Zum Home-Bildschirm“, Vollbild, offline-fähige Hülle, Hell/Dunkel nach System).
2. **Interne Ansicht** (Desktop/Tablet-Layout derselben Oberfläche) mit allen Kennzahlen.
3. **JSON-API** `GET /api/pv` (Ersatz für das bisherige `/pv-data`, gleiche Felder, siehe `reference/sample/pv-data.example.json`).
4. **SolarDaily** integriert: Tages- und Gesamtzähler (kWh) aus den Momentanleistungen, bisher ein ioBroker-Skript.

Das Repo ist **öffentlich**. Es darf keine privaten Daten enthalten (siehe „Datenschutz“).

## Ausgangslage (Referenz, nicht weiterentwickeln)

| Datei | Was |
|---|---|
| `reference/node-red/pv-tab.flow.json` | Bisheriger Node-RED-Tab: 25 `influxdb in`-Abfragen (InfluxQL), `store`-Functions, Berechnung in der Function **„Berechnen + JSON Response“**, Quoten-Timer alle 30 min (Woche/Jahreszeit/Jahr), Anker 06:00/17:00/22:00 für Nacht/Tag/Abend-Split. |
| `reference/node-red/pv_widget.html` | Bisherige Oberfläche (pollt `/pv-data` alle 30 s). Lädt Schriften von Google Fonts — **im Neubau nicht übernehmen**. |
| `reference/iobroker/SolarDaily.js` | ioBroker-Skript „SolarDaily v3“: integriert Leistung (W) über die Zeit zu kWh (`daily.*` mit Reset 00:00, `totals.*` ohne Reset), verwirft Lücken > 5 min, Batterie getrennt nach Laden/Entladen, Netz nur Bezug (Einspeisung ignoriert). |
| `reference/sample/pv-data.example.json` | Beispielantwort der API (fiktive Werte). |

Datenquellen im Original (ioBroker → InfluxDB 1.x, je Messgröße ein Measurement mit Feld `value`):
- Momentanwerte von Solar Assistant per MQTT: `mqtt.1.solar_assistant.total.{pv_power,load_power,battery_power,grid_power,battery_state_of_charge}.state`
- Tageszähler: `javascript.0.SolarDaily.daily.{pv_production,load_consumption,grid_consumption,bat_in,bat_out}`
- Prognose: `pvforecast.0.summary.power`

## Zielarchitektur

- **Node.js ≥ 20**, wenige Abhängigkeiten. Vorbild für Stil und Aufbau: <https://github.com/seele05/vbus-to-influx> (`main.js`, `lib/`, `web/index.html`, `config.example.js` + `config.local.json`, Tests mit `node --test`).
- **Datenquelle Lesen:** InfluxDB 1.x (InfluxQL über HTTP `/query`). Alle Measurement-Namen, DB, RP, Zeitzone (Default `Europe/Berlin`), Akku-Kapazität (kWh) und Mindest-SOC (%) in der Config. `config.example.js` enthält nur Platzhalter; die ioBroker-/Solar-Assistant-Namen oben stehen dort als **kommentiertes Beispiel**.
- **SolarDaily-Modul** (`lib/solardaily.js`), zuschaltbar:
  - Eingang wahlweise **MQTT** (Solar Assistant direkt, Topics konfigurierbar) oder Polling der Momentanwerte aus InfluxDB.
  - Gleiche Semantik wie das Skript (Trapez oder Rechteck – dokumentieren, Lücken > `maxGapMinutes` verwerfen, Reset 00:00 lokale Zeit, Batterie ±, Netz nur Bezug).
  - Zustand in `solardaily-state.json` (atomar schreiben, höchstens alle paar Minuten + beim Beenden – Zielhardware kann SD-Karte sein).
  - Optional Zähler nach InfluxDB schreiben (konfigurierbare Measurement-Namen), damit bestehende Konsumenten weiterlaufen können.
  - Ist SolarDaily aus, kommen die Tageszähler wie bisher aus InfluxDB.
- **Berechnungen** (`lib/metrics.js`) 1:1 aus der Function „Berechnen + JSON Response“ und den Quoten-/Anker-Functions portieren: Autarkie/Eigenverbrauch (heute, 7 Tage, Jahreszeit, Jahr), Restreichweite + „smarte“ Reichweite mit Prognose, Nacht/Tag/Abend-Split, Δ zu Ø 30 Tage und zu gestern, Akku-Richtung. Reine Funktionen, vollständig unit-getestet.
- **Abfragen bündeln:** wenige InfluxQL-Statements pro Zyklus (Mehrfach-Query mit `;`), Ergebnisse cachen; teure Aggregate (Woche/Jahreszeit/Jahr) nur alle 30 min.
- **Web:** `web/` mit `index.html`, `manifest.webmanifest`, `sw.js`, Icons (SVG/PNG, selbst erzeugt). Schriften lokal einbinden oder System-Schriften — **keine externen Requests** (kein CDN, keine Google Fonts). Mobile-first, deutsche Texte.
- **Mock-Modus** (`--mock` bzw. Config): liefert die Beispieldaten ohne InfluxDB – für Entwicklung und Screenshots.
- **Betrieb:** `Dockerfile` (nicht-root, Healthcheck auf `/api/pv`), Beispiel `docker-compose.yml`, alternativ systemd-Unit unter `contrib/`. Port per Config (Default 8080).
- **README (deutsch):** Zweck, Screenshots (nur Mock-Daten), Schnellstart, Konfiguration, Datenmodell, SolarDaily-Erklärung, Migration vom Node-RED-Flow.

## Datenschutz (hart)

- Keine IP-Adressen, Hostnamen, Domains, Namen, Orte, Koordinaten, Zugangsdaten oder echten Messwerte ins Repo – auch nicht in Tests, Fixtures, Screenshots oder Commit-Messages.
- Anlagenspezifische Werte (Kapazität, Mindest-SOC, DB-Namen) nur als Platzhalter/Beispiel.
- `config.js`, `config.local.json`, `*-state.json` in `.gitignore`.

## Abnahmekriterien

1. `npm test` grün; Tests decken `metrics.js` (inkl. Grenzfälle: fehlende Werte → `null`, Reichweiten-Schwellen 1/3/8/72 h, Tageswechsel) und `solardaily.js` (Integration, Lücke, Reset, Batterie-Vorzeichen, Netz-Einspeisung) ab.
2. `node main.js --mock` startet; `GET /api/pv` liefert alle Felder aus `pv-data.example.json`; `GET /` liefert die Seite; Manifest und Service Worker werden ausgeliefert.
3. Lighthouse/PWA: installierbar (Manifest mit Icons, `start_url`, `display: standalone`, Service Worker).
4. `grep -rE '([0-9]{1,3}\.){3}[0-9]{1,3}'` über das Repo findet nur `127.0.0.1`/`0.0.0.0` bzw. Beispiel-Doku-Adressen (`192.0.2.x`).
5. Kein Request an fremde Hosts beim Laden der Seite.
6. `reference/` bleibt unverändert.

## Nicht im Auftrag

- Kein Deployment, keine CI für eine bestimmte Infrastruktur, keine Änderung an Node-RED oder ioBroker.
- Keine native App (iOS/Android) – PWA genügt.

## Rückmeldung

Im PR-Text: was gebaut, Testbefehl + Ergebnis, offene Punkte, bewusste Abweichungen vom Original (z. B. Integrationsverfahren).
