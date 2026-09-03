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
const OPT_KEYS = ['speed', 'grind', 'hunt'];

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
  const out = { speed: null, grind: null, hunt: null };
  if (!raw || typeof raw !== 'object') return out;
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

