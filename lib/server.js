'use strict';

/*
 * HTTP-Server: statische PWA aus web/ und JSON-API.
 * Alle Dateien aus web/ werden beim Start geladen, gzip-komprimiert und mit
 * ETag ausgeliefert. Die Content-Security-Policy erlaubt nur Ressourcen vom
 * eigenen Host – die Seite kann damit keine fremden Hosts anfragen.
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

// HTML, Manifest und Service Worker immer revalidieren, damit Updates sofort ankommen
const NO_CACHE = new Set(['/index.html', '/sw.js', '/manifest.webmanifest']);

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
            files.set(urlPath, {
                body,
                gzip: compressible ? zlib.gzipSync(body, { level: 9 }) : null,
                type: TYPES[ext],
                etag: '"' + crypto.createHash('sha1').update(body).digest('base64url').slice(0, 20) + '"',
                cache: NO_CACHE.has(urlPath) ? 'no-cache' : 'public, max-age=604800',
            });
        }
    };
    walk(webDir);
    return files;
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
            'Cache-Control': file.cache,
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


module.exports = { createServer, CSP };
