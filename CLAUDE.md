# Hinweise für Claude-Sitzungen

- **Version bei jeder Änderung anheben** (SemVer): Fehlerbehebung → Patch, neue Funktion → Minor, inkompatible Änderung an API/Konfiguration → Major. `npm version <x.y.z> --no-git-tag-version` (ändert `package.json` und `package-lock.json`); die Version erscheint in der Fußzeile.
- Commits ohne `Co-Authored-By`-/`Claude-Session`-Trailer; Autor ist der Repository-Besitzer (git config des Repos).
- Arbeiten auf einem Feature-Branch, Pull Request gegen `main`.
- Datenschutz: keine IP-Adressen (außer `127.0.0.1`/`0.0.0.0`/`192.0.2.x`), Hostnamen, Namen, Orte, Zugangsdaten oder echten Messwerte ins Repo – auch nicht in Tests, Screenshots (nur `--mock`) oder Commit-Messages.
- `reference/` nicht verändern.
- Vor dem Commit: `npm test` grün; die Oberfläche lädt nichts von fremden Hosts (CSP `default-src 'self'`).
- Ändern sich `web/app.js`, `web/app.css` oder `web/index.html`, die Cache-Version in `web/sw.js` erhöhen.
