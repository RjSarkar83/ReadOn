/* ArtViSiON · Tools — offline shell
   Caches the app itself so it keeps working with no connection.
   Compression never touches the network; this only makes install/offline possible.
   The same file is served from the repo root and from /compress/. */
const VERSION = 'readon-compress-v6';

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // scope-relative, so the same file is correct at / and at /compress/
    const candidates = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
    await Promise.allSettled(candidates.map((u) => cache.add(new Request(u, { cache: 'reload' }))));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) {
      fetch(req).then((res) => { if (res && res.ok) cache.put(req, res.clone()); }).catch(() => {});
      return hit;
    }
    try {
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const fallback = await cache.match('./index.html') || await cache.match('./compress/index.html');
      if (fallback) return fallback;
      throw err;
    }
  })());
});
