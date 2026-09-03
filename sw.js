// Cache the shell so the app opens with no network once installed. The ROM and
// .sym are never cached: they are yours, they stay in the page, and they are
// re-picked each session.
const CACHE = 'crystal-pilot-v68';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './icon.svg',
  './vendor/wasmboy.umd.js',
  './app/main.js', './app/gb.js', './app/state.js',
  './app/symbols.js', './app/tasks.js', './app/saves.js',
  './app/taskbase.js', './app/menus.js', './app/battle.js', './app/jobs.js',
  './app/rows.js', './app/version.js',
  './app/collision.js', './app/nav.js', './app/romdata.js', './app/world.js',
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
// Network first, cache as the fallback -- not the other way round.
//
// Cache-first is the usual advice for an offline-first shell and it was wrong
// here, in a way that took a while to see because it looks like working. A
// returning visitor got the *previous* deploy's shell: the new worker installs
// and claims clients, but the load that is already happening has been answered
// from the old cache, so the app is always one reload behind itself. Measured
// on the deployed app, which served an index.html from before the save card
// existed while serving the new sw.js that lists it.
//
// The dangerous part is not staleness, it is mixing. `caches.match` was also
// unscoped, so it could answer from an older cache entirely -- and a module
// added in the new version is not in the old cache at all, so that one is
// fetched fresh. Old HTML against new JavaScript is a combination nobody has
// ever tested.
//
// So: ask the network, put what comes back in the cache, and fall back to the
// cache when the network is not there. Offline still works -- that is what the
// fallback is -- and online is always the deploy that is actually live. The
// cost is a network round trip per shell file when there is a network, which
// for a handful of small files is not worth being wrong over.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;   // the CDN-less app only
  e.respondWith((async () => {
    try {
      const fresh = await fetch(e.request);
      if (fresh && fresh.ok) {
        const c = await caches.open(CACHE);
        c.put(e.request, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch (err) {
      // Offline, or the file is gone. Scoped to this version's cache so a
      // leftover older one cannot answer for it.
      const c = await caches.open(CACHE);
      const hit = await c.match(e.request);
      if (hit) return hit;
      throw err;
    }
  })());
});
