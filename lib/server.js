'use strict';

/*
 * HTTP-Server: statische PWA aus web/ und JSON-API.
 * Alle Dateien aus web/ werden beim Start geladen, gzip-komprimiert und mit
 * ETag ausgeliefert. Die Content-Security-Policy erlaubt nur Ressourcen vom
 * eigenen Host – die Seite kann damit keine fremden Hosts anfragen.
 *
 * Versionierung: index.html und sw.js verweisen auf /app.css?v=<hash> und
 * /app.js?v=<hash> (Hash des Inhalts, beim Start eingesetzt). Nach einem Update
 * fordert die immer frisch geladene Seite damit neue Adressen an, die weder im
 * HTTP-Cache noch im Cache eines alten Service Workers liegen. Ohne das konnte
 * eine installierte App (z. B. iOS-Homescreen) neue Seite und altes Skript mischen.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const zlib = require('zlib');

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
};

// Dateien, die per ?v=<hash> versioniert eingebunden werden (index.html, sw.js)
const VERSIONED = ['/app.css', '/app.js'];
const IMMUTABLE = 'public, max-age=31536000, immutable';

const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
].join('; ');


const hashOf = body => crypto.createHash('sha1').update(body).digest('base64url').slice(0, 20);

/** Ersetzt jedes Vorkommen von `from` durch `to`; wirft, wenn `from` nicht vorkommt. */
function replaceAllStrict(text, from, to, file) {
    if (!text.includes(from)) throw new Error(`${file}: ${from} nicht gefunden (Versionierung)`);
    return text.split(from).join(to);
}

function loadStatic(webDir) {
    const files = new Map();
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            const ext = path.extname(entry.name);
            if (!TYPES[ext]) continue;
            const body = fs.readFileSync(full);
            const urlPath = '/' + path.relative(webDir, full).split(path.sep).join('/');
            const compressible = !['.png', '.ico'].includes(ext);
            files.set(urlPath, { body, ext, compressible });
        }
    };
    walk(webDir);

    // Versionen einsetzen: in index.html die Attribute, in sw.js die Shell-Liste und den Cache-Namen
    const version = {};
    for (const p of VERSIONED) {
        if (files.has(p)) version[p] = hashOf(files.get(p).body).slice(0, 10);
    }
    const rewrite = (p, fn) => {
        if (files.has(p)) files.get(p).body = Buffer.from(fn(files.get(p).body.toString('utf8')));
    };
    rewrite('/index.html', html => {
        for (const [p, v] of Object.entries(version)) html = replaceAllStrict(html, `"${p}"`, `"${p}?v=${v}"`, 'index.html');
        return html;
    });
    rewrite('/sw.js', js => {
        for (const [p, v] of Object.entries(version)) js = replaceAllStrict(js, `'${p}'`, `'${p}?v=${v}'`, 'sw.js');
        // Cache-Name aendert sich mit jedem Inhalt -> neuer Service Worker, alte Caches werden geloescht
        return js.replace(/const CACHE = '([^']+)';/, (_, name) => `const CACHE = '${name}-${hashOf(Object.values(version).join('.')).slice(0, 8)}';`);
    });

    for (const [urlPath, f] of files) {
        files.set(urlPath, {
            body: f.body,
            gzip: f.compressible ? zlib.gzipSync(f.body, { level: 9 }) : null,
            type: TYPES[f.ext],
            etag: '"' + hashOf(f.body) + '"',
            version: version[urlPath] || null,
        });
    }
    return files;
}


/**
 * Cache-Control je Datei: versionierte Dateien mit passendem ?v= duerfen dauerhaft
 * gecacht werden; alles andere (HTML, sw.js, Manifest, unversionierte Abrufe)
 * wird bei jedem Abruf per ETag revalidiert. Icons duerfen einen Tag alt sein.
 */
function cacheControl(urlPath, file, v) {
    if (file.version) return v === file.version ? IMMUTABLE : 'no-cache';
    if (urlPath.startsWith('/icons/')) return 'public, max-age=86400';
    return 'no-cache';
}


/**
 * @param {object} opts
 * @param {string} opts.webDir
 * @param {() => object|null} opts.getPayload aktuelle API-Antwort oder null
 * @param {() => object} opts.getStatus
 * @param {() => object} opts.getMeta
 * @param {() => object|null} [opts.getForecast]
 */
function createServer({ webDir, getPayload, getStatus, getMeta, getForecast = () => null }) {
    const files = loadStatic(webDir);

    const sendJson = (req, res, code, payload, extra = {}) => {
        const body = JSON.stringify(payload);
        res.writeHead(code, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            ...extra,
        });
        res.end(req.method === 'HEAD' ? undefined : body);
    };

    return http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://localhost');
        let p = url.pathname;

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            return sendJson(req, res, 405, { error: 'nur GET/HEAD' }, { Allow: 'GET, HEAD' });
        }

        if (p === '/api/pv' || p === '/pv-data') {
            const payload = getPayload();
            const cors = { 'Access-Control-Allow-Origin': '*' };
            return payload
                ? sendJson(req, res, 200, payload, cors)
                : sendJson(req, res, 503, { error: 'noch keine aktuellen Daten', status: getStatus() }, cors);
        }
        if (p === '/api/status') return sendJson(req, res, 200, getStatus());
        if (p === '/api/meta') return sendJson(req, res, 200, getMeta());
        if (p === '/api/forecast') {
            const fc = getForecast();
            return fc ? sendJson(req, res, 200, fc) : sendJson(req, res, 404, { error: 'keine Prognose konfiguriert' });
        }

        if (p === '/' || p === '/pv') p = '/index.html';
        const file = files.get(p);
        if (!file) return sendJson(req, res, 404, { error: 'nicht gefunden' });

        const headers = {
            'Content-Type': file.type,
            'Cache-Control': cacheControl(p, file, url.searchParams.get('v')),
            'ETag': file.etag,
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': CSP,
            'Vary': 'Accept-Encoding',
        };
        if (p === '/sw.js') headers['Service-Worker-Allowed'] = '/';

        if (req.headers['if-none-match'] === file.etag) {
            res.writeHead(304, headers);
            return res.end();
        }

        const gzip = file.gzip && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
        const body = gzip ? file.gzip : file.body;
        res.writeHead(200, { ...headers, 'Content-Length': body.length, ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) });
        res.end(req.method === 'HEAD' ? undefined : body);
    });
}


module.exports = { loadStatic, createServer, CSP };
