'use strict';
// Offline cache. Online: always the newest files (so an update shows up at once); offline or a very slow link: the saved copy.
const CACHE = 'arahet-crm-2.3.1';
const ASSETS = ["./", "./index.html", "./manifest.webmanifest", "./shim.js", "./style.css", "./i18n.js", "./i18n-ext.js", "./fields.js", "./store.js", "./sbdb.js", "./xlsxio.js", "./app.js", "./vendor/exceljs.min.js", "./vendor/jszip.min.js", "./vendor/qrcode.js", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png"];
self.addEventListener('install', function (e) { e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener('activate', function (e) { e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); })); });
function withTimeout(p, ms) { return new Promise(function (res, rej) { const t = setTimeout(function () { rej(new Error('timeout')); }, ms); p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); }); }); }
self.addEventListener('fetch', function (e) {
  const req = e.request; if (req.method !== 'GET') return;
  const u = new URL(req.url); if (u.origin !== self.location.origin) return;
  e.respondWith(withTimeout(fetch(req), 5000).then(function (res) {
    if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
    return res;
  }).catch(function () { return caches.match(req).then(function (r) { return r || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()); }); }));
});
