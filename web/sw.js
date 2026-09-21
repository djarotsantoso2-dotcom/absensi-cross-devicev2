const CACHE = 'absensi-gps-v1.9.7-csflow-no-dashboard';
const ASSETS = ['./', './index.html', './config.js', './manifest.webmanifest', './cs-store-flow-logo.png', './icon-192.png', './icon-512.png', './icon-192.png?v=1.9.7', './icon-512.png?v=1.9.7'];
const assetUrls = new Set(ASSETS.map(path => new URL(path, self.registration.scope).href));
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('absensi-gps-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || !assetUrls.has(event.request.url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(event.request);
      if (response.ok && response.type !== 'opaque') await cache.put(event.request, response.clone());
      return response;
    } catch (err) {
      const hit = await cache.match(event.request);
      if (hit) return hit;
      if (event.request.mode === 'navigate') {
        const page = await cache.match('./index.html');
        if (page) return page;
      }
      throw err;
    }
  })());
});
