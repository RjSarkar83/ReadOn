/* ArtViSiON · Tools — offline shell (network-first online, full cache offline)
   Always serves the freshest build when online and falls back to cache offline.
   The same file is served from the repo root and from /compress/. */
const VERSION = 'readon-compress-v12';

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    const inCompress = /\/compress\/sw\.js$/i.test(self.location.pathname || '');
    const vendorBase = inCompress ? '../vendor/' : './vendor/';
    const candidates = [
      './', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png',
      vendorBase + 'pdf.min.js', vendorBase + 'pdf.worker.min.js'
    ];
    await Promise.allSettled(candidates.map((u) => cache.add(new Request(u, { cache: 'reload' }))));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const fallback = await cache.match('./index.html') || await cache.match('./compress/index.html');
        if (fallback) return fallback;
      }
      throw err;
    }
  })());
});
