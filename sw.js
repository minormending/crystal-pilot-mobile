// Cache the shell so the app opens with no network once installed. The ROM and
// .sym are never cached: they are yours, they stay in the page, and they are
// re-picked each session.
const CACHE = 'crystal-pilot-v14';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './icon.svg',
  './vendor/wasmboy.umd.js',
  './app/main.js', './app/gb.js', './app/state.js',
  './app/symbols.js', './app/tasks.js',
  './app/collision.js', './app/nav.js', './app/romdata.js',
  './app/bootstrap.js',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) =>
    Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
