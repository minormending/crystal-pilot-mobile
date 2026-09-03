// ─────────────────────────────────────────────────────────────────────────────
//  baton — hand one blob between your own devices, one holder at a time.
//
//  kidsync moves *state*: small, mergeable, everyone's copy growing together.
//  Some things are not like that. A save file is one opaque lump of bytes, and
//  there is no Math.max for a lump: two devices that both played cannot be
//  reconciled, only chosen between. So this is the other shape — a baton. One
//  device holds it, hands it on, and the other picks it up.
//
//  It sits ON TOP of kidsync rather than beside it: you pass in a live handle
//  and this uses its room, its auth, its rules, its debounce. There is no
//  second Firebase path here and no second set of rules to keep in step.
//
//  Design rules, in the order they matter:
//    1. THE CAP IS REAL. A room holds 32,768 characters of JSON. A payload that
//       does not fit is refused with a reason, out loud, rather than written
//       and silently dropped. See codec.js for the arithmetic.
//    2. ORDER BY COUNTER, NEVER BY CLOCK. Devices disagree about the time; a
//       phone that is an hour fast would win every handover it took part in.
//       Every publish takes max(seen) + 1, so the order is the order things
//       actually happened in.
//    3. THE HOLDER IS AN ANNOUNCEMENT, NOT A LOCK. Nothing here can stop a
//       device doing anything. It says who picked the baton up last, which is
//       enough for one person with several devices and is not access control.
// ─────────────────────────────────────────────────────────────────────────────
import { fits, pack, unpack } from './codec.js';

const CAP = 32 * 1024;   // kidsync's own limit; see its firebase-rules.json

/**
 * @param sync      a kidsync handle (createSync's return value)
 * @param key       where the payload lives in the room's state
 * @param holdKey   where "who has it" lives
 * @param label     what to call this device out loud -- "Phone", "Tablet"
 * @param maxBytes  the room's cap, if it is ever not kidsync's
 * @param spare     characters reserved for everything else in the state
 */
export function createBaton({
  sync,
  key = 'save',
  holdKey = 'held',
  label = 'this device',
  maxBytes = CAP,
  spare = 2048,
} = {}) {
  if (!sync) throw new Error('[baton] needs a kidsync handle');
  const me = () => sync.deviceId;
  const carried = () => (sync.state && sync.state[key]) || null;
  const holder = () => (sync.state && sync.state[holdKey]) || null;

  /** One past the highest revision either side has seen. */
  const nextRev = () => {
    const a = carried(), b = holder();
    return Math.max((a && a.rev) || 0, (b && b.rev) || 0) + 1;
  };

  return {
    /**
     * Put bytes in the room and take the baton.
     *
     * Answers rather than throwing, because "too big" is a normal outcome of a
     * real save on a bad day, not an exception: the caller has to be able to
     * say so to a person. Nothing is written when it does not fit -- a partial
     * publish would leave the room holding an older save while claiming a
     * newer one.
     */
    async publish(bytes, { says = '', tag = '' } = {}) {
      const gz = await pack(bytes);
      if (!fits(gz, maxBytes, spare)) {
        return { ok: false, reason: 'too-big', chars: gz.length, cap: maxBytes };
      }
      const rev = nextRev();
      const at = Date.now();
      sync.set({
        [key]: { gz, rev, at, by: label, id: me(), says, tag },
        [holdKey]: { by: label, id: me(), rev, at },
      });
      return { ok: true, rev, chars: gz.length };
    },

    /** What is in the room, without paying to decompress it. */
    peek() {
      const c = carried();
      if (!c || !c.gz) return { empty: true };
      const h = holder();
      return {
        empty: false,
        rev: c.rev || 0,
        at: c.at || 0,
        by: c.by || '',
        says: c.says || '',
        tag: c.tag || '',
        mine: c.id === me(),
        heldBy: (h && h.by) || c.by || '',
        heldMine: !!h && h.id === me(),
        chars: c.gz.length,
      };
    },

    /**
     * Take the bytes, and say that you have them.
     *
     * `tag` is whatever the caller uses to mean "these bytes belong to that
     * thing" -- a ROM's fingerprint, a schema version. Baton never interprets
     * it; it only refuses to hand over a payload stamped with a different one,
     * because bytes that belong to something else are worse than no bytes.
     */
    async take({ tag = null } = {}) {
      const c = carried();
      if (!c || !c.gz) return { ok: false, reason: 'empty' };
      if (tag !== null && c.tag && c.tag !== tag) {
        return { ok: false, reason: 'tag', wanted: tag, found: c.tag };
      }
      let bytes;
      try {
        bytes = await unpack(c.gz);
      } catch (e) {
        return { ok: false, reason: 'corrupt', detail: e.message };
      }
      sync.set({ [holdKey]: { by: label, id: me(), rev: nextRev(), at: Date.now() } });
      return { ok: true, bytes, says: c.says || '', by: c.by || '' };
    },

    /** Say you are the one playing, without publishing anything new. */
    claim() {
      sync.set({ [holdKey]: { by: label, id: me(), rev: nextRev(), at: Date.now() } });
    },

    /**
     * Combine two rooms' worth of baton, for kidsync's merge().
     *
     * Higher revision wins, and a tie is broken by device id rather than left
     * to chance -- two devices that publish at the same revision must both
     * arrive at the same answer, or they will push each other's version back
     * and forth for as long as the app is open. Comparing two revisions gives
     * the same result however many times it runs, which is the settling rule
     * kidsync asks of every merge.
     *
     * Compose it with your own state's rules:
     *     merge: (a, b) => ({ ...myMerge(a, b), ...baton.merge(a, b) })
     */
    merge(local, remote) {
      return {
        [key]: pick((local || {})[key], (remote || {})[key]),
        [holdKey]: pick((local || {})[holdKey], (remote || {})[holdKey]),
      };
    },

    /** Whether the room is ahead of a revision you already have. */
    compare(seenRev = 0) {
      const c = carried();
      if (!c || !c.gz) return 'empty';
      if ((c.rev || 0) > seenRev) return 'room-newer';
      if ((c.rev || 0) < seenRev) return 'local-newer';
      return 'same';
    },

    get label() { return label; },
    get id() { return me(); },
  };
}

function pick(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ra = a.rev || 0, rb = b.rev || 0;
  if (ra !== rb) return ra > rb ? a : b;
  // Same revision, different devices: settle it the same way on both sides.
  return String(a.id || '') >= String(b.id || '') ? a : b;
}
