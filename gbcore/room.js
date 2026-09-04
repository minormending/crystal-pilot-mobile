// Sharing what this build remembers, between your own devices.
//
// A thin seam over kidsync (vendored in sync/), which does the real work: a
// room is one key in a Firebase Realtime Database, named after a code like
// K7M2P, and every device holding that code reads and writes it. There are no accounts. The code is the password, which is the right
// shape for one person with three devices and the wrong shape for sharing with
// anyone else -- so the code belongs in your pocket, never in this repo.
//
// Two rules this file exists to keep.
//
// **Nothing here may be able to break the app.** kidsync imports the Firebase
// SDK from gstatic at the top of its module, so a static import of it would
// put a cross-origin fetch in the middle of this app's module graph: offline,
// that import fails, and every module downstream of it fails with it -- which
// is the whole app, in an app whose service worker exists so it runs with no
// signal. So it is loaded with a dynamic import, inside a try, at the moment
// someone asks to share. Offline you lose sharing; you do not lose the game.
//
// (kidsync's own bridge.js insulates its other apps for free, because there
// the bridge is a separate entry point and the app's classic scripts have
// already run. An ES-module app has to do that insulating itself. bridge.js is
// vendored here unused, so `tools/check` in kidsync still sees a byte-identical
// copy.)
//
// **Local storage stays the source of truth.** remember.js owns the options;
// this only carries them between devices. If the room never answers, the app
// behaves exactly as it did before this file existed.
import { firebaseConfig } from '../sync/firebase-config.js';
import { createBaton } from '../baton/baton.js';

// Namespaces rooms, so a code here can never collide with one from the games
// that share this Firebase project.
const GAME = 'crystal-pilot';

// Five characters, not three words.
//
// kidsync's own codes are BANJO-COMET-OTTER-472, and that format is right for
// the apps it was written for: a child reads the code aloud and somebody else
// types it, so the words are chosen for having no homophones. Here one person
// holds both devices. There is nobody to read it to, and a code you glance at
// and type once should be short enough to hold in your head while you look
// away from the screen.
//
// The alphabet is Crockford's base32 -- the digits and the letters except
// I, L, O and U. The four are left out for one reason each: I and L are 1, O is
// 0, and U is left out of every hand-typed alphabet to keep an accidental word
// from appearing. So a code cannot contain a character whose neighbour it might
// be mistaken for, and `readCode` folds the three substitutions people make
// anyway.
//
// What this costs, stated rather than buried: 32^5 is 33,554,432 codes against
// the words' 2,048,256,000, so about sixty times fewer. The code is still the
// only thing between a room and a stranger, and a room still holds a gzipped
// save and a sentence about where you are. That is a smaller number to guess,
// and it is a number worth writing down: someone would have to try tens of
// millions of codes, each a network round trip, to land on a room that exists.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 5;

/**
 * A fresh code, from the platform's own randomness.
 *
 * `% ALPHABET.length` is unbiased here and only here: 256 divides by 32
 * exactly, so every byte maps to eight of the 32 characters and none is
 * favoured. At any other alphabet size this would need rejection sampling --
 * kidsync's own `randomInt` does exactly that, and this is the one case that
 * does not need it.
 */
function makeCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/**
 * Read a code the way it was probably meant.
 *
 * Case, spaces and dashes are noise -- someone typing a code they can see is
 * not thinking about either. The three letter-for-digit swaps are the ones the
 * alphabet is designed around: a code never contains I, L or O, so a typed one
 * can only have meant the digit it looks like.
 */
export function readCode(input) {
  if (typeof input !== 'string') return null;
  const cleaned = input.trim().toUpperCase()
    .replace(/[\s\-_]+/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  const ok = cleaned.length === CODE_LENGTH
    && [...cleaned].every((c) => ALPHABET.includes(c));
  return ok ? cleaned : null;
}

const NAME_KEY = 'crystal-pilot-device-name';

/** The name you chose for this device, if you chose one. */
export function chosenName() {
  try {
    if (typeof localStorage === 'undefined') return '';
    return localStorage.getItem(NAME_KEY) || '';
  } catch (e) { return ''; }
}

function rememberName(name) {
  try { localStorage.setItem(NAME_KEY, name); } catch (e) { /* fine */ }
}

/**
 * What to call this device out loud, so a row can say "Phone is playing".
 *
 * A guess off the user agent, and deliberately a crude one: it only has to
 * tell your two devices apart in a sentence. Getting it wrong costs a word in
 * a status line, and asking someone to name their phone before they can share
 * a save costs more than that.
 *
 * The guess is wrong in the way that matters when two of your devices are the
 * same kind -- "Mac has the newer save" is no help when both are Macs -- so a
 * name you choose overrides it, and that is what every sentence uses from then
 * on.
 */
function deviceName() {
  const chosen = chosenName();
  if (chosen) return chosen;
  const ua = navigator.userAgent || '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'PC';
  return 'this device';
}

/**
 * Keep the newer symbol digest.
 *
 * Simplest possible rule, and it is enough: a digest only changes when the ROM
 * does, and whoever takes one checks the fingerprint against their own
 * cartridge before believing a single address. So the worst a wrong winner can
 * do is be ignored.
 */
export function mergeSymbols(local, remote) {
  const mine = (local && local.sym && local.sym.at) || 0;
  const theirs = (remote && remote.sym && remote.sym.at) || 0;
  const winner = theirs > mine ? remote : local;
  return (winner && winner.sym) ? { sym: winner.sym } : {};
}

/**
 * Keep the newest of each half of an introduction.
 *
 * The three fields are written by two different devices -- a watcher asks, the
 * host offers, the watcher answers -- so a whole-object rule would have each
 * side's write erase the other's half and the handshake would never complete.
 * Per-field by stamp, and it settles because comparing two stamps gives the
 * same answer however often it runs.
 */
export function mergeSignal(local, remote) {
  const a = (local && local.rtc) || {};
  const b = (remote && remote.rtc) || {};
  const out = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const mine = a[k], theirs = b[k];
    if (!mine) { out[k] = theirs; continue; }
    if (!theirs) { out[k] = mine; continue; }
    out[k] = (theirs.at || 0) > (mine.at || 0) ? theirs : mine;
  }
  return Object.keys(out).length ? { rtc: out } : {};
}

/**
 * The notes worth acting on: everything that has not been withdrawn.
 *
 * Withdrawing is a *note*, not a deletion, and that is the whole reason this
 * function exists. In the merge above, an absent key always loses to a present
 * one -- so a device that deletes its copy of an offer has it handed straight
 * back by the other device's stale copy, and after a reload, where the
 * already-answered marks are gone, that resurrected offer is answered again
 * against a connection that no longer exists. A withdrawal has to be something
 * the merge can see is newer, so it is `{ gone: true, at }`, and this is what
 * hides them from everyone upstream.
 */
export function liveNotes(rtc) {
  const out = {};
  for (const [k, v] of Object.entries(rtc || {})) {
    if (v && !v.gone) out[k] = v;
  }
  return out;
}

/**
 * Combine two devices' options.
 *
 * These are preferences, not progress: nothing here is a score to protect, and
 * every one of the three can be *changed back*. So this is kidsync's settings
 * pattern -- the newest group wins wholesale -- rather than its grow-only one.
 * A Math.max over a speed step would mean the fastest speed either device ever
 * chose becomes the speed neither can leave.
 *
 * Whole-group rather than per-field because the three are chosen together in
 * one sitting, and interleaving halves of two sittings makes a state neither
 * device ever had.
 *
 * It must settle, and it does: comparing two stamps gives the same answer
 * however many times it runs. A tie is broken by the device id rather than by
 * preferring whichever side is asking, because two devices that each keep
 * their own answer never agree -- the same rule baton uses on a tied revision.
 */
export function mergeOptions(local, remote) {
  const mine = (local && local.optsAt) || 0;
  const theirs = (remote && remote.optsAt) || 0;
  let winner = mine > theirs ? local : remote;
  if (mine === theirs) {
    const a = (local && local.optsBy) || '';
    const b = (remote && remote.optsBy) || '';
    winner = String(a) >= String(b) ? local : remote;
  }
  return {
    opts: (winner && winner.opts) || {},
    optsAt: Math.max(mine, theirs),
    optsBy: (winner && winner.optsBy) || '',
  };
}

// Whether this device has ever joined a room. Its own key, deliberately: the
// alternative is reading kidsync's private one, and a module that reaches into
// another module's storage keys breaks the day that module renames one.
const JOINED_KEY = 'crystal-pilot-sharing';

function flag(value) {
  try {
    if (typeof localStorage === 'undefined') return false;
    if (value === undefined) return localStorage.getItem(JOINED_KEY) === 'yes';
    localStorage.setItem(JOINED_KEY, value ? 'yes' : 'no');
    return value;
  } catch (e) {
    return false;      // a private window shares nothing, and says nothing
  }
}

/** Has this device joined a room before? Decides whether to reach the network. */
export function wasSharing() { return flag(); }

/**
 * Open the room, if this device has ever joined one.
 *
 * Resolves to null when there is nothing to open or the SDK could not be
 * fetched, and never throws: every caller of this treats sharing as a bonus.
 */
export async function openRoom({ options, onOptions, onSave, onSignal,
                                 onSymbols, onStatus } = {}) {
  let createSync;
  try {
    ({ createSync } = await import('../sync/kidsync.js'));
  } catch (e) {
    // Offline, or gstatic blocked. The app is unaffected.
    if (onStatus) onStatus('unavailable');
    return null;
  }
  // Both `let`, and every use guarded, because kidsync calls onChange -- and
  // can call merge -- from inside createSync, before the handle it returns
  // exists. Written the obvious way round this throws "Cannot access 'sync'
  // before initialization" on the first load and the app never starts. baton's
  // own demo page met this first; see its README.
  let sync = null;
  let baton = null;
  sync = await createSync({
    firebaseConfig,
    game: GAME,
    // `crystal-pilot-` plus five is 19 characters, and the deployed rules want
    // at least 16 -- which kidsync now checks rather than letting Firebase
    // answer with a permission denial that reads as a network fault.
    codes: { generate: makeCode, normalize: readCode },
    // Seeded with what this device already remembers, not with an empty group.
    // kidsync keeps its own copy of the synced state, so a device joining with
    // `{}` would hand the room an empty group -- and on the way back through
    // onChange, adopt it over its own choices. Measured, the first time this
    // ran: pressing Share emptied the record it was supposed to be sharing.
    initialState: options
      ? { opts: options, optsAt: options.at || 0, optsBy: '' }
      : { opts: {}, optsAt: 0, optsBy: '' },
    // Two things share this room and each owns its own keys: the options merge
    // by stamp, the save by revision. Composed rather than combined, because
    // neither knows the other's rules and neither should.
    merge: (a, b) => ({
      ...mergeOptions(a, b),
      ...mergeSymbols(a, b),
      ...mergeSignal(a, b),
      ...(baton ? baton.merge(a, b) : {}),
    }),
    onChange: (state) => {
      if (!state) return;
      if (onOptions && state.opts) {
        // The stamp travels with the group: whoever adopts it has to order it
        // against their own, and their clock is not the one that chose it.
        onOptions({ ...state.opts, at: state.optsAt || 0 });
      }
      // Metadata only. Nothing decompresses a payload to paint a row -- that
      // happens when someone asks for the bytes.
      if (onSave && baton) onSave(baton.peek());
      if (onSymbols && state.sym) onSymbols(state.sym);
      if (onSignal) onSignal(liveNotes(state.rtc));
    },
    onStatus: (s) => { if (onStatus) onStatus(s); },
  });
  baton = createBaton({ sync, label: deviceName() });
  return {
    sync,
    // A getter, not the value: rename() replaces the baton, and a property
    // captured here would go on pointing at the one from before the rename
    // while every method below used the new one.
    get baton() { return baton; },
    /** What the room is holding, without paying to unpack it. */
    peekSave() { return baton.peek(); },
    /** Put this device's battery in the room and take the baton. */
    publishSave(bytes, says, tag) { return baton.publish(bytes, { says, tag }); },
    /** The bytes back, refused if they belong to a different cartridge. */
    takeSave(tag) { return baton.take({ tag }); },
    /**
     * Publish the addresses this app reads, for a device that has the ROM and
     * not the .sym. About a kilobyte, against the 1.8MB file they came from.
     */
    shareSymbols(map, tag) { sync.set({ sym: { map, tag, at: Date.now() } }); },
    /** What the room is offering, or null. The caller checks the tag. */
    symbols() { return (sync.state && sync.state.sym) || null; },

    /**
     * Leave a note for the other device, on the way to a direct connection.
     *
     * Merged field by field and flushed immediately: a handshake sitting in the
     * debounce is half a second of nothing happening while two people watch a
     * button they just pressed.
     */
    signal(patch) {
      const now = (sync.state && sync.state.rtc) || {};
      const next = { ...now };
      const at = Date.now();
      for (const [k, v] of Object.entries(patch)) {
        // A withdrawal is written down rather than deleted -- see liveNotes.
        next[k] = v === null ? { gone: true, at } : { ...v, at };
      }
      sync.set({ rtc: next });
      return sync.flush();
    },
    /** Whose device this is, for addressing a note to the other one. */
    get id() { return sync.deviceId; },
    get device() { return baton.label; },
    /**
     * Call this device something else.
     *
     * The baton is rebuilt rather than mutated: its label is fixed at
     * construction, on purpose -- a published save carries the name the device
     * had when it published, and nothing should be able to reach back and
     * change what a past handover said.
     */
    rename(name) {
      const clean = String(name || '').trim().slice(0, 24);
      if (!clean) return baton.label;
      rememberName(clean);
      baton = createBaton({ sync, label: clean });
      return clean;
    },
    /** Publish the three options, with the stamp they were chosen at. */
    share(opts) {
      sync.set({ opts, optsAt: opts.at || Date.now(), optsBy: sync.deviceId });
    },
    async start() {
      const code = await sync.createRoom();
      flag(true);
      return code;
    },
    async join(code) {
      const r = await sync.joinRoom(code);
      if (r.ok) flag(true);
      return r;
    },
    stop() {
      sync.leaveRoom();
      flag(false);
    },
    get code() { return sync.roomCode; },
    get status() { return sync.status; },
  };
}
