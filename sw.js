// Cache the shell so the app opens with no network once installed.
//
// The ROM and .sym are never in *this* cache, and never on the wire: they are
// yours, read in the page, and no game data is served from here. They are kept
// in IndexedDB on the device by app/remember.js, so a reload does not send you
// looking for them -- which is a different thing from being cached, and is
// thrown away by Forget in the settings card.
const CACHE = 'crystal-pilot-v135';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './icon.svg',
  './vendor/wasmboy.umd.js',
  './app/main.js', './gbcore/cartridge.js', './gbcore/gb.js', './gen2/engine.js', './gen2/state.js',
  './gen2/symbols.js', './gen2/tasks.js', './gbcore/saves.js',
  './gbcore/taskbase.js', './gen2/menus.js', './gen2/battle.js', './gen2/jobs.js',
  './app/rows.js', './gbcore/version.js', './gbcore/remember.js',
  './gen2/collision.js', './gen2/nav.js', './gen2/romdata.js', './gen2/world.js',
  './gen2/journey.js', './titles/contract.js', './titles/crystal.js', './titles/crystal-early.js', './titles/generic.js', './titles/pick.js', './gbcore/room.js', './gbcore/stream.js',
  // Vendored from the kidsync repo, and cached for the same reason as the rest:
  // unlisted means served from the network, which is invisible until someone is
  // on a train. The Firebase SDK these pull from gstatic is *not* cached -- it
  // is another origin, and this worker deliberately answers for this one only.
  // Offline you keep the app and lose sharing, which is the right way round.
  './sync/kidsync.js', './sync/bridge.js', './sync/firebase-config.js',
  './baton/baton.js', './baton/codec.js',
];
// The shell as paths, for the fetch handler to match against. Resolved once,
// relative to this worker -- which sits at the app root, so './' is the root
// itself. Compared by pathname rather than by href so a cache-busting query
// still matches the file it is asking for.
const SHELL_PATHS = new Set(SHELL.map((p) => new URL(p, self.location).pathname));
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
  // The *shell*, which is what the first line of this file says it caches and
  // what it was not doing: every same-origin GET went in. With `?dev=1` that
  // is the 2MB ROM and the 1.8MB symbol file, fetched from ./dev/ -- so the
  // one cache this file promises never holds game data held 3.8MB of it, and
  // `activate` does not clear it because it is the current version's cache.
  // check-app already keeps SHELL complete, so matching against it cannot
  // starve the app of anything it needs.
  if (!SHELL_PATHS.has(url.pathname)) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      const fresh = await fetch(e.request);
      // `ok` is not enough on its own. A captive portal -- hotel wifi, an
      // airline -- answers *every* request with 200 and its own login page, so
      // caching on `ok` alone overwrites index.html and every module with that
      // page, and the app stays broken after the network comes back. Those
      // answers arrive redirected, which is the one signal that separates them
      // from a real reply.
      if (fresh && fresh.ok && !fresh.redirected) {
        c.put(e.request, fresh.clone()).catch(() => {});
        return fresh;
      }
      // A 500, a 404, or a portal. The deploy is broken or the network is
      // lying; a known-good copy of a shell file beats either.
      const hit = await c.match(e.request);
      return hit || fresh;
    } catch (err) {
      // Offline. Scoped to this version's cache so a leftover older one cannot
      // answer for it.
      const hit = await c.match(e.request);
      if (hit) return hit;
      throw err;
    }
  })());
});
