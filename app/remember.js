// What the page still knows the next time it is opened.
//
// The app forgets everything on a reload, and a reload is not rare here: the
// Update button causes one on purpose, and a phone will discard a background
// tab whenever it feels like it. Everything worth keeping is small -- an index
// into the speed steps, which grind preset was tapped, what was being hunted --
// so localStorage is the whole mechanism, one JSON object under one key.
//
// The colour theme is *not* in here. It has its own key and has had it since
// before this file existed, and moving it would mean a migration for people
// who have already chosen, in exchange for nothing.
//
// Two rules shape the rest of this file.
//
// Storage throws. Private windows and cleared site data do not return null,
// they raise -- and in Node there is no `localStorage` binding at all, which is
// a ReferenceError rather than an exception you can catch by reading it. So
// every access goes through one accessor that answers "nothing remembered".
//
// And what comes back is a suggestion, not a fact. It was written by an older
// build of this app, possibly a much older one, on a phone whose owner may
// have edited it by hand. A remembered speed of 9 must not become
// `SPEEDS[9]` -- that is `undefined`, and the idle loop then steps the
// emulator `undefined` frames per animation frame. So it is checked against
// what this build can actually use before anything is done with it.
const OPTS_KEY = 'crystal-pilot-opts';
// The only keys kept. Anything else in the record is dropped on the next
// write, so a field this build has stopped using does not live forever.
//
// `at` is when the three were last chosen *on this device*, and it is stored
// rather than derived because it has to survive a reload: it is what orders
// this device's choices against another device's, and a stamp invented at load
// time would make every reload look like a fresh decision.
const OPT_KEYS = ['speed', 'grind', 'hunt', 'at'];

function store(given) {
  if (given) return given;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch (e) {
    return null;                 // a private window: nothing is remembered
  }
}

/**
 * Make sense of whatever came out of storage, against what this build can use.
 *
 * Separated from the reading so it can be tested without a browser, which is
 * the half worth testing: the storage call is three lines and a try, and every
 * bug this could have is in here.
 *
 * `speeds` is how many speed steps exist and `grinds` the preset specs the
 * markup offers -- both passed in rather than known here, so the markup and
 * the SPEEDS table stay the one source of each. An unknown value is dropped
 * rather than clamped: a grind preset that no longer exists has no nearest
 * neighbour, and a speed index out of range is more likely a different build's
 * record than a number to be salvaged.
 */
export function sanitise(raw, { speeds = 0, grinds = [] } = {}) {
  const out = { speed: null, grind: null, hunt: null, at: 0 };
  if (!raw || typeof raw !== 'object') return out;
  // A stamp, not a date: anything that is not a positive finite number is no
  // ordering at all, and 0 loses to every real choice, which is the safe way
  // for a record with no stamp to lose.
  if (Number.isFinite(raw.at) && raw.at > 0) out.at = raw.at;
  if (Number.isInteger(raw.speed) && raw.speed >= 0 && raw.speed < speeds) {
    out.speed = raw.speed;
  }
  if (typeof raw.grind === 'string' && grinds.includes(raw.grind)) {
    out.grind = raw.grind;
  }
  // A species name is only ever *used* if it is in the list of what appears
  // where you are standing, at this hour, so the real check happens there.
  // This one is only keeping something absurd out of the app.
  if (typeof raw.hunt === 'string' && raw.hunt.length > 0 && raw.hunt.length <= 24) {
    out.hunt = raw.hunt;
  }
  return out;
}

/** The remembered options, or nulls -- never a throw and never a surprise. */
export function readOpts(limits = {}, given = null) {
  const st = store(given);
  if (!st) return sanitise(null, limits);
  let raw = null;
  try {
    raw = JSON.parse(st.getItem(OPTS_KEY));
  } catch (e) {
    // Unreadable or not JSON. Either way there is nothing to honour, and
    // overwriting it is what the next choice will do.
  }
  return sanitise(raw, limits);
}

/**
 * Merge one or more choices into what is remembered.
 *
 * Called on the choice, not on the way out: there is no way out. A phone can
 * discard this tab without running a single line of ours, so `beforeunload`
 * would be a promise the platform does not keep.
 */
export function writeOpts(patch, given = null) {
  const st = store(given);
  if (!st) return;
  // Stamped here unless the caller brought its own, which is what adopting
  // another device's choices does -- their stamp travels with them, or this
  // device's clock would make every arrival look like the newest decision.
  if (!('at' in patch)) patch = { ...patch, at: Date.now() };
  let raw = {};
  try {
    raw = JSON.parse(st.getItem(OPTS_KEY)) || {};
  } catch (e) { raw = {}; }
  if (!raw || typeof raw !== 'object') raw = {};
  const next = {};
  for (const k of OPT_KEYS) {
    const v = k in patch ? patch[k] : raw[k];
    if (v !== null && v !== undefined) next[k] = v;
  }
  try {
    st.setItem(OPTS_KEY, JSON.stringify(next));
  } catch (e) {
    // Full, or refused. A forgotten preference is not worth a message.
  }
}

// --- the files, and the game that goes with them -----------------------------
//
// The ROM and the .sym used to be re-picked every session, which is two file
// pickers and a 2MB read before anything happens -- and the Update button
// causes a reload on purpose, so the app's own way of getting a fix to you was
// also the thing that made you go and find your files again.
//
// localStorage cannot hold them: a ~5MB budget of *strings* against 2MB of ROM
// and 1.8MB of symbols. IndexedDB takes both as they are.
//
// This is its own database, deliberately. saves.js opens `crystal-pilot` at
// version 1, by name and number. Putting a store for this in there would mean
// version 2, and then any tab still running the older module -- a background
// tab, a stale HTTP-cached copy, exactly the staleness that made the version
// display necessary -- opens a v2 database at v1 and gets a VersionError,
// taking the save slots down with it. A second small database has no version
// to coordinate.
//
// The battery is kept here too, and that is not scope creep: it is what makes
// the rest worth having. Measured, because the opposite had been written down
// and believed: save the game, reload, and the save is gone. WasmBoy's own
// `keyval` store held zero records after a save the app had verified byte for
// byte -- the library only persists a cartridge when something asks it to, and
// nothing here was asking. So remembering the files without the battery would
// bring the game back to a title screen with no game behind it.
const FILES_DB = 'crystal-pilot-files';
const STORE = 'kept';
const ROM = 'rom', SYM = 'sym', BATTERY = 'battery', META = 'meta';

function openFiles() {
  return new Promise((resolve, reject) => {
    // No `indexedDB` at all in a locked-down browser, and `open` itself throws
    // in a Firefox private window rather than firing onerror.
    let req;
    try {
      if (typeof indexedDB === 'undefined') throw new Error('no indexedDB');
      req = indexedDB.open(FILES_DB, 1);
    } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('another tab is holding the database'));
  });
}

function work(mode, job) {
  return openFiles().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    let out;
    try { out = job(t.objectStore(STORE)); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const one = (store, key) => new Promise((resolve, reject) => {
  const r = store.get(key);
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

/**
 * What is kept, without reading the 4MB to find out.
 *
 * A record of its own rather than the byteLengths of the real ones, because
 * the settings row is painted on every refresh and pulling two megabytes
 * through a transaction to print a filename would be absurd.
 */
export async function keptMeta() {
  try {
    return (await work('readonly', (s) => one(s, META))) || null;
  } catch (e) {
    return null;
  }
}

async function patchMeta(patch) {
  const now = (await keptMeta()) || {};
  await work('readwrite', (s) => s.put(Object.assign(now, patch), META));
}

/**
 * Keep the ROM, the symbol file, or the battery.
 *
 * Each answers whether it stuck. A phone that is full, or a browser that
 * refuses storage, is not an error worth a dialog -- the app works exactly as
 * it did before this file existed -- but the settings row must not then claim
 * the files are kept, so the answer is not thrown away.
 */
export async function keepRom(name, buffer) {
  try {
    await work('readwrite', (s) => s.put({ name, buffer }, ROM));
    await patchMeta({ romName: name, romBytes: buffer.byteLength });
    return true;
  } catch (e) { return false; }
}

export async function keepSym(name, text) {
  try {
    await work('readwrite', (s) => s.put({ name, text }, SYM));
    await patchMeta({ symName: name, symChars: text.length });
    return true;
  } catch (e) { return false; }
}

export async function keepBattery(bytes, extra = {}) {
  try {
    await work('readwrite', (s) => s.put(Uint8Array.from(bytes), BATTERY));
    // `extra` is how the room's revision gets stored beside the bytes it
    // belongs to. Kept here rather than in its own record because the two are
    // only ever true together: a revision without the bytes it names would
    // claim this device is in step with a save it does not have.
    await patchMeta({ battery: true, batteryAt: Date.now(), ...extra });
    return true;
  } catch (e) { return false; }
}

/**
 * Everything kept, for a session that is starting.
 *
 * The pair is all or nothing: a ROM without its symbol file cannot start the
 * pilot, and half a restore that leaves one picker to find is worse than
 * asking for both -- it looks broken rather than like a question.
 */
export async function recall() {
  try {
    const [rom, sym, battery] = await work('readonly', (s) => Promise.all([
      one(s, ROM), one(s, SYM), one(s, BATTERY),
    ]));
    if (!rom || !rom.buffer || !sym || !sym.text) return null;
    return { rom, sym, battery: battery || null };
  } catch (e) {
    return null;
  }
}

/** Forget the lot, for a phone that is not yours or a ROM that is not this one. */
export async function forgetKept() {
  try {
    await work('readwrite', (s) => {
      for (const k of [ROM, SYM, BATTERY, META]) s.delete(k);
    });
    return true;
  } catch (e) { return false; }
}
