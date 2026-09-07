// The service worker, which is the whole of "it runs with no signal".
//
// sw.js had no tests. It is 5KB of decisions that only show themselves on a bad
// network -- and two of them are fixes the eighth pass had to find by reading,
// because nothing exercises this file: the ROM was being cached by a worker
// whose first line says it never caches game data, and a captive portal's 200
// was being written over index.html.
//
// It is not a module and never will be, so it is loaded the way the browser
// loads it: evaluated in a context holding fakes for the four globals it uses.
// That is the point -- the code under test is the deployed file, byte for byte,
// not a re-description of it.
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '../harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SW = join(ROOT, 'sw.js');
const SRC = readFileSync(SW, 'utf8');
class DOMExceptionLike extends Error {}

const ORIGIN = 'https://example.test';
const BASE = `${ORIGIN}/app/`;

/** A Response with only the parts sw.js looks at. */
function reply(body, { ok = true, status = 200, redirected = false } = {}) {
  return { body, ok, status, redirected, clone() { return reply(body, { ok, status, redirected }); } };
}
const request = (url, method = 'GET') => ({ url, method });

/**
 * Evaluate sw.js with fakes, and hand back a way to fire each event at it.
 *
 * `net` is what the network does, as a function of the request -- so a test
 * says "this is a captive portal" or "this is offline" in one line.
 */
function worker({ net = () => reply('fresh'), prefill = {},
                  storage = true } = {}) {
  const store = new Map();                       // cache name -> url -> Response
  for (const [name, entries] of Object.entries(prefill)) {
    store.set(name, new Map(Object.entries(entries)));
  }
  const asCache = (name) => ({
    async match(req) { return (store.get(name) || new Map()).get(req.url) || undefined; },
    async put(req, res) {
      if (!store.has(name)) store.set(name, new Map());
      store.get(name).set(req.url, res);
    },
    async addAll(urls) {
      if (!store.has(name)) store.set(name, new Map());
      for (const u of urls) {
        const abs = new URL(u, BASE).href;
        const res = await net(request(abs));
        if (!res.ok) throw new Error(`addAll failed on ${u}`);   // it is atomic
        store.get(name).set(abs, res);
      }
    },
  });
  const listeners = {};
  const ctx = {
    self: {
      location: new URL(BASE + 'sw.js'),
      addEventListener: (type, fn) => { listeners[type] = fn; },
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
    caches: {
      open: async (name) => {
        // Storage can simply not be there: a private window, an origin whose
        // site data the browser has been told to block, a device out of quota.
        if (!storage) throw new DOMExceptionLike('storage is not available');
        return asCache(name);
      },
      keys: async () => [...store.keys()],
      delete: async (name) => store.delete(name),
      // The platform's own `caches.match` searches *every* cache, which is
      // exactly the hazard sw.js scopes itself against -- so the fake has to
      // offer it, or a test for that scoping passes for the wrong reason.
      async match(req) {
        for (const entries of store.values()) {
          const hit = entries.get(req.url);
          if (hit) return hit;
        }
        return undefined;
      },
    },
    fetch: (req) => Promise.resolve().then(() => net(req)),
    URL, Set, Promise, console,
  };
  createContext(ctx);
  // Named, so V8's coverage attributes what runs here to sw.js rather than to
  // `evalmachine.<anonymous>` -- otherwise tools/coverage cannot see this file
  // at all and would report the worker as untested however much of it runs.
  runInContext(SRC, ctx, { filename: SW });

  return {
    store,
    names: () => [...store.keys()],
    /** Fire `fetch` and return what the worker answered, or null if it passed. */
    async fetched(req) {
      let answered = null;
      listeners.fetch({ request: req, respondWith: (p) => { answered = p; } });
      return answered === null ? null : await answered;
    },
    async install() {
      let done;
      listeners.install({ waitUntil: (p) => { done = p; } });
      await done;
    },
    async activate() {
      let done;
      listeners.activate({ waitUntil: (p) => { done = p; } });
      await done;
    },
  };
}

// Read out of the worker rather than written down again. The name carries the
// version and changes on most commits; a copy here would be a test that fails
// for the one reason that is never interesting.
const CACHE = SRC.match(/const CACHE = '([^']+)'/)[1];
const shellUrl = BASE + 'app/main.js';

test('installing caches the shell, and only the shell', async (t) => {
  const w = worker();
  await w.install();
  const held = [...w.store.get(CACHE).keys()];
  t.gte(held.length, 30, 'the whole list went in');
  t.true(held.some((u) => u.endsWith('/app/main.js')), 'the app is in it');
  t.true(held.some((u) => u.endsWith('/vendor/wasmboy.umd.js')), 'so is the emulator');
  t.false(held.some((u) => /\/dev\/|\.gbc$|\.sym$/.test(u)), 'and no game data is');
});

test('activating clears older caches and keeps this one', async (t) => {
  const w = worker({ prefill: { [CACHE]: {}, 'crystal-pilot-v99': {}, 'something-else': {} } });
  await w.activate();
  t.eq(w.names(), [CACHE], 'only the current version survives');
});

test('the ROM is never answered by the worker', async (t) => {
  // The eighth pass's finding, and the reason SHELL_PATHS exists: every
  // same-origin GET used to be cached, so `?dev=1` put a 2MB ROM and a 1.8MB
  // symbol file into the one cache this file promises never holds game data.
  const w = worker();
  t.eq(await w.fetched(request(BASE + 'dev/pokecrystal.gbc')), null,
       'a ROM request is passed straight through');
  t.eq(await w.fetched(request(BASE + 'dev/pokecrystal.sym')), null,
       'and so is the symbol file');
  t.eq(w.store.size, 0, 'nothing was cached on the way past');
});

test('a POST and another origin are left alone', async (t) => {
  const w = worker();
  t.eq(await w.fetched(request(shellUrl, 'POST')), null, 'not a GET');
  t.eq(await w.fetched(request('https://gstatic.test/firebase.js')), null,
       'not this origin — the Firebase SDK stays on the network');
});

test('online, the network answers and the cache is refreshed', async (t) => {
  const w = worker({ net: () => reply('the new deploy') });
  const res = await w.fetched(request(shellUrl));
  t.eq(res.body, 'the new deploy', 'the live file, not a stale one');
  t.eq(w.store.get(CACHE).get(shellUrl).body, 'the new deploy', 'and it was kept');
});

test('a captive portal is not written over the app', async (t) => {
  // Hotel wifi answers *every* request with 200 and its own login page. Caching
  // on `ok` alone overwrites index.html and every module with that page, and
  // the app stays broken after the network comes back. Redirection is the one
  // signal that separates a portal from a real reply.
  const w = worker({
    net: () => reply('<html>please sign in</html>', { redirected: true }),
    prefill: { [CACHE]: { [shellUrl]: reply('the real app') } },
  });
  const res = await w.fetched(request(shellUrl));
  t.eq(res.body, 'the real app', 'the known-good copy is served instead');
  t.eq(w.store.get(CACHE).get(shellUrl).body, 'the real app',
       'and the portal never reached the cache');
});

test('a broken deploy falls back to the copy that worked', async (t) => {
  const w = worker({
    net: () => reply('502 Bad Gateway', { ok: false, status: 502 }),
    prefill: { [CACHE]: { [shellUrl]: reply('the real app') } },
  });
  t.eq((await w.fetched(request(shellUrl))).body, 'the real app', 'cache wins over a 502');
});

test('offline, the cache answers', async (t) => {
  const w = worker({
    net: () => { throw new TypeError('Failed to fetch'); },
    prefill: { [CACHE]: { [shellUrl]: reply('the real app') } },
  });
  t.eq((await w.fetched(request(shellUrl))).body, 'the real app', 'this is the whole promise');
});

test('offline with nothing cached says so rather than answering emptily',
     async (t) => {
  const w = worker({ net: () => { throw new TypeError('Failed to fetch'); } });
  await t.rejects(async () => w.fetched(request(shellUrl)),
                  'a first visit with no network cannot be served');
});

test('an older cache cannot answer for this version', async (t) => {
  // Scoped to CACHE deliberately: `caches.match` unscoped could answer from a
  // previous deploy, and old HTML against new JavaScript is a combination
  // nobody has ever tested.
  const w = worker({
    net: () => { throw new TypeError('Failed to fetch'); },
    prefill: { 'crystal-pilot-v99': { [shellUrl]: reply('last month’s app') } },
  });
  await t.rejects(async () => w.fetched(request(shellUrl)),
                  'the stale cache is not consulted');
});

test('a query string does not stop a shell file being recognised', async (t) => {
  // SHELL_PATHS compares pathname rather than href, which sw.js explains as
  // letting a cache-busting query still match. Worth saying plainly: nothing in
  // the app appends one today, so this is defensiveness rather than a live
  // caller -- but it is the behaviour the file promises, and a switch to href
  // would break it silently.
  const w = worker({ net: () => reply('v141') });
  const res = await w.fetched(request(BASE + 'gbcore/version.js?cb=12345'));
  t.ne(res, null, 'the worker still answers it');
  t.eq(res.body, 'v141', 'from the network, as it should');
});

test('the worker never answers for itself, which is how updates are seen',
     async (t) => {
  // Load-bearing, and easy to break by adding one line to SHELL. `showVersion`
  // fetches ./sw.js to read the deployed cache name and compare it against the
  // running one -- so a worker that served itself from its own cache would
  // report the running version as the live one, for ever, and the Update button
  // would never appear. It is the one same-origin GET this file deliberately
  // declines.
  const w = worker({ net: () => reply('const CACHE = \'crystal-pilot-v999\';') });
  t.eq(await w.fetched(request(BASE + 'sw.js')), null, 'passed to the network');
  t.false(SRC.includes("'./sw.js'"), 'and it is not in the shell list');
});

test('a worker that cannot open its cache still serves the app', async (t) => {
  // The one way this file could be worse than not existing. `caches.open` can
  // reject outright -- a private window, an origin whose site data is blocked,
  // a device out of quota -- and it sat outside the try, so the whole
  // respondWith rejected and *every shell file* failed to load. On a device
  // where, with no service worker at all, the app would have worked perfectly.
  const w = worker({ storage: false, net: () => reply('the live app') });
  const res = await w.fetched(request(shellUrl));
  t.ne(res, null, 'it still answers');
  t.eq(res.body, 'the live app', 'straight from the network, which is all it can do');
});

test('no storage and no network fails the way having no worker would',
     async (t) => {
  const w = worker({ storage: false, net: () => { throw new TypeError('Failed to fetch'); } });
  await t.rejects(async () => w.fetched(request(shellUrl)),
                  'nothing to serve, and it says so rather than hanging');
});
