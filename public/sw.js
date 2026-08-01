// Minimal service worker: cache the app shell so the PWA opens offline. API
// calls are always network (never cached), so operational data stays live.
const SHELL = 'profsol-shell-v1';
const ASSETS = [
  '/app/',
  '/app/index.html',
  '/app/styles.css',
  '/app/app.js',
  '/app/manifest.webmanifest',
  '/app/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Only the shell is cache-first. Everything else (the API) goes to network.
  if (e.request.method === 'GET' && url.pathname.startsWith('/app/')) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
  }
});
