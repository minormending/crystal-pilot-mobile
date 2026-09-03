// Sharing what this build remembers, between your own devices.
//
// A thin seam over kidsync (vendored in sync/), which does the real work: a
// room is one key in a Firebase Realtime Database, named after a code like
// TIGER-COMET-BANJO-472, and every device holding that code reads and writes
// it. There are no accounts. The code is the password, which is the right
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

/**
 * What to call this device out loud, so a row can say "Phone is playing".
 *
 * A guess off the user agent, and deliberately a crude one: it only has to
 * tell your two devices apart in a sentence. Getting it wrong costs a word in
 * a status line, and asking someone to name their phone before they can share
 * a save costs more than that.
 */
function deviceName() {
  const ua = navigator.userAgent || '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'PC';
  return 'this device';
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
 * however many times it runs.
 */
export function mergeOptions(local, remote) {
  const mine = (local && local.optsAt) || 0;
  const theirs = (remote && remote.optsAt) || 0;
  const winner = mine >= theirs ? local : remote;
  return {
    opts: (winner && winner.opts) || {},
    optsAt: Math.max(mine, theirs),
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
export async function openRoom({ options, onOptions, onSave, onStatus } = {}) {
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
    // Seeded with what this device already remembers, not with an empty group.
    // kidsync keeps its own copy of the synced state, so a device joining with
    // `{}` would hand the room an empty group -- and on the way back through
    // onChange, adopt it over its own choices. Measured, the first time this
    // ran: pressing Share emptied the record it was supposed to be sharing.
    initialState: options ? { opts: options, optsAt: options.at || 0 }
                          : { opts: {}, optsAt: 0 },
    // Two things share this room and each owns its own keys: the options merge
    // by stamp, the save by revision. Composed rather than combined, because
    // neither knows the other's rules and neither should.
    merge: (a, b) => ({
      ...mergeOptions(a, b),
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
    },
    onStatus: (s) => { if (onStatus) onStatus(s); },
  });
  baton = createBaton({ sync, label: deviceName() });
  return {
    sync,
    baton,
    /** What the room is holding, without paying to unpack it. */
    peekSave() { return baton.peek(); },
    /** Put this device's battery in the room and take the baton. */
    publishSave(bytes, says, tag) { return baton.publish(bytes, { says, tag }); },
    /** The bytes back, refused if they belong to a different cartridge. */
    takeSave(tag) { return baton.take({ tag }); },
    get device() { return baton.label; },
    /** Publish the three options, with the stamp they were chosen at. */
    share(opts) { sync.set({ opts, optsAt: opts.at || Date.now() }); },
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
