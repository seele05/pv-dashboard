'use strict';

/*
 * Service Worker: haelt die App-Huelle (HTML, CSS, JS, Manifest, Icons) offline vor.
 * Seiten: erst Netz, bei Fehler Cache. Statische Dateien: Cache, im Hintergrund
 * aktualisiert. /api/* wird nie gecacht (die Seite merkt sich den letzten Stand selbst).
 *
 * Der Server setzt beim Ausliefern die Inhalts-Versionen ein: Die Eintraege fuer
 * app.css und app.js in SHELL erhalten ?v=<hash>, an CACHE wird ein Hash gehaengt.
 * Neue Inhalte haben so neue Adressen und einen neuen Cache.
 */

const CACHE = 'pv-shell-v7';
const SHELL = [
  '/',
  '/app.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  // cache: 'reload' umgeht den HTTP-Cache des Browsers, damit nur aktuelle Dateien in den Cache kommen
  event.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL.map(url => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(cached => {
      const fresh = fetch(req).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || fresh;
    })
  );
});
