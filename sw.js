// Keeps a copy of the app on the phone so it opens even without internet.
// It always tries the internet first (so you get updates), then falls back
// to the saved copy if you're offline or the connection is slow.
const CACHE = 'today-v5';
const FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // 'no-cache' makes the phone ask GitHub whether there's a newer copy
    // instead of quietly reusing one it downloaded a few minutes ago.
    const fromNetwork = fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    });
    const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      const res = await Promise.race([fromNetwork, timeout]);
      if (res) return res;
    } catch (e) { /* offline */ }
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    return fromNetwork;
  })());
});
