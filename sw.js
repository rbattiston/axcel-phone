// Offline cache. The app must work in a gym basement with no signal: it is
// installed once from HTTPS, and everything it needs is cached here.
//
// Bump CACHE when any file changes, or the phone will keep serving the old one.
const CACHE = 'axcel-v3';
const FILES = [
  './', './index.html', './style.css', './app.js',
  './decode.js', './exercises.js', './thresholds.js', './version.js',
  './manifest.json', './icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first, falling back to cache. A stale app that silently records the
// wrong thing is worse than a slow load.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  );
});
