// The two merge rules the room runs, both of which decide what one device
// believes about another. Pure functions, so they are testable without a
// browser or Firebase -- which is the only reason the bugs below were fixable
// with a test rather than with two phones and some patience.
import { test } from '../harness.mjs';
import { liveNotes, mergeOptions, mergeSignal, mergeSymbols, needsOffer } from '../../gbcore/room.js';

test('a withdrawn note stays withdrawn, however it is merged', async (t) => {
  // The bug: a cleared key was simply absent, and in the merge an absent key
  // always lost to a present one -- so the other device's stale copy handed the
  // offer straight back, and after a reload it was answered again against a
  // connection that no longer existed.
  const cleared = { rtc: { offer: { gone: true, at: 200 } } };
  const stale = { rtc: { offer: { sdp: 'x', at: 100 } } };
  t.true(mergeSignal(cleared, stale).rtc.offer.gone, 'a withdrawal beats an older note');
  t.true(mergeSignal(stale, cleared).rtc.offer.gone, 'and the same either way round');
  t.eq(Object.keys(liveNotes(mergeSignal(cleared, stale).rtc)), [],
       'and readers never see it');
});

test('a note newer than the withdrawal is a new note, not a ghost', async (t) => {
  // Pressing Show again after Stop has to work.
  const cleared = { rtc: { showing: { gone: true, at: 100 } } };
  const again = { rtc: { showing: { by: 'iPhone', at: 300 } } };
  t.eq(liveNotes(mergeSignal(cleared, again).rtc).showing.by, 'iPhone',
       'the later announcement wins');
});

test('two devices with the same option stamp reach the same answer', async (t) => {
  // Without a tie-break each side kept its own and neither ever agreed --
  // the failure kidsync's README calls "it must settle", and the one baton
  // already breaks by device id.
  const a = { opts: { speed: 1 }, optsAt: 5, optsBy: 'device-a' };
  const b = { opts: { speed: 4 }, optsAt: 5, optsBy: 'device-b' };
  t.eq(mergeOptions(a, b).opts.speed, mergeOptions(b, a).opts.speed,
       'the same winner from both directions');
  t.eq(mergeOptions(a, b).opts.speed, 4, 'and it is decided by the id, not by who asked');
});

test('a newer group still wins outright', async (t) => {
  const older = { opts: { speed: 4 }, optsAt: 5, optsBy: 'device-b' };
  const newer = { opts: { speed: 0 }, optsAt: 9, optsBy: 'device-a' };
  t.eq(mergeOptions(newer, older).opts.speed, 0, 'the stamp comes first');
  t.eq(mergeOptions(older, newer).opts.speed, 0, 'either way round');
  t.eq(mergeOptions(older, newer).optsAt, 9, 'and the stamp travels with it');
});

test('merging a merge changes nothing, which is what kidsync requires', async (t) => {
  const a = { opts: { speed: 1 }, optsAt: 5, optsBy: 'device-a',
              rtc: { offer: { sdp: 'x', at: 3 } } };
  const b = { opts: { speed: 4 }, optsAt: 5, optsBy: 'device-b',
              rtc: { offer: { gone: true, at: 9 } } };
  const once = { ...mergeOptions(a, b), ...mergeSignal(a, b) };
  const twice = { ...mergeOptions(once, b), ...mergeSignal(once, b) };
  t.eq(JSON.stringify(twice), JSON.stringify(once), 'it settles');
});

test('the same device asking twice is asked twice', async (t) => {
  // Watch, Leave, Watch again, on the one tablet you own. The second press
  // carries the same device id and a newer stamp, and the second press is the
  // one that used to be ignored.
  const made = { to: null, at: 0 };
  t.true(needsOffer({ id: 'tablet', at: 1000 }, made), 'the first ask is an ask');
  made.to = 'tablet'; made.at = 1000;
  t.false(needsOffer({ id: 'tablet', at: 1000 }, made), 'and is not re-asked');
  t.true(needsOffer({ id: 'tablet', at: 3000 }, made), 'asking again is a new ask');
});

test('a different device asking is always a new ask', async (t) => {
  // Even with an older stamp: two devices do not share a clock, and the id
  // changing is by itself enough.
  t.true(needsOffer({ id: 'phone', at: 500 }, { to: 'tablet', at: 1000 }));
});

test('nobody asking is not an ask', async (t) => {
  // liveNotes strips a withdrawal, so this is what a host sees the moment the
  // watching device presses Leave.
  t.false(needsOffer(null, { to: 'tablet', at: 1000 }), 'withdrawn');
  t.false(needsOffer({ at: 1000 }, { to: null, at: 0 }), 'a note with no id');
});

test('the newer symbol digest wins, and an absent one never does', async (t) => {
  // The one merge rule in this file that had no test, in the half of the app
  // two earlier audits found bugs in. A digest only changes when the ROM does,
  // and whoever takes one checks the fingerprint against their own cartridge
  // before believing an address -- so the worst a wrong winner can do is be
  // ignored. That is the argument for the rule being this simple; it is not an
  // argument for it being untested.
  const older = { sym: { map: { a: 1 }, tag: 'A', at: 100 } };
  const newer = { sym: { map: { b: 2 }, tag: 'B', at: 300 } };
  t.eq(mergeSymbols(older, newer).sym.tag, 'B', 'the newer one');
  t.eq(mergeSymbols(newer, older).sym.tag, 'B', 'and the same either way round');
  t.eq(mergeSymbols(null, newer).sym.tag, 'B', 'a device with none takes theirs');
  t.eq(mergeSymbols(older, null).sym.tag, 'A', 'and keeps its own against none');
  t.eq(Object.keys(mergeSymbols(null, null)).length, 0,
       'two devices with none say nothing');
  t.eq(mergeSymbols({ sym: { tag: 'A' } }, { sym: { tag: 'B', at: 1 } }).sym.tag, 'B',
       'a digest with no stamp loses to one that has any');
});

// --- the tie-breaks that make two devices agree -----------------------------
//
// `room.js` scored 48%, and the survivors that matter are all the same shape: a
// comparison whose *direction* decides whether two devices converge. The
// comments in that file say why each one is the way it is; nothing was checking
// that any of them still was.

test('a tie in options is broken the same way on both devices', async (t) => {
  // **The failure this guards is silent and permanent.** Two devices whose
  // option groups carry the same stamp have to pick the same winner, or each
  // keeps its own answer and they never agree -- and nothing on either screen
  // says anything is wrong. The rule is the device id, which is the same rule
  // `baton` uses for a tied revision.
  const a = { opts: { speed: 1 }, optsAt: 100, optsBy: 'aaa' };
  const b = { opts: { speed: 2 }, optsAt: 100, optsBy: 'bbb' };
  // Asked from both sides, which is the only way to see convergence at all.
  const fromA = mergeOptions(a, b);
  const fromB = mergeOptions(b, a);
  t.eq(fromA.optsBy, fromB.optsBy, 'both sides name the same winner');
  t.eq(fromA.opts.speed, fromB.opts.speed, 'and keep the same answer');
});

test('the newer option group wins, and it is not a maximum', async (t) => {
  // Preferences, not progress: a `Math.max` over a speed step would make the
  // fastest speed either device ever chose the speed neither can leave.
  const older = { opts: { speed: 3 }, optsAt: 100, optsBy: 'a' };
  const newer = { opts: { speed: 1 }, optsAt: 200, optsBy: 'b' };
  t.eq(mergeOptions(older, newer).opts.speed, 1, 'the newest group, wholesale');
  t.eq(mergeOptions(newer, older).opts.speed, 1, 'from either side');
});

test('a second ask from the same device still needs an offer', async (t) => {
  // Watch, Leave, Watch again on the one tablet you own: identity alone says
  // nothing new has happened, and the host makes no offer while the tablet
  // waits fifteen seconds and blames the network. The question is about the
  // asking, not the asker.
  t.false(needsOffer({ id: 'tab', at: 100 }, { to: 'tab', at: 100 }),
          'the same ask, already answered');
  t.true(needsOffer({ id: 'tab', at: 200 }, { to: 'tab', at: 100 }),
         'a newer ask from the same device');
  t.true(needsOffer({ id: 'other', at: 50 }, { to: 'tab', at: 100 }),
         'and a different device, whatever the stamp');
  t.false(needsOffer(null, { to: 'tab', at: 1 }), 'nobody asking, nothing to do');
  t.true(needsOffer({ id: 'tab', at: 1 }, null), 'and no offer yet means yes');
  // **A note with no stamp on it**, which is the case that reaches the
  // default at all. `made = null` returns at the identity check one line
  // above, so it never gets there -- which is why the first draft of this
  // test looked like it covered the line and `tools/mutate` said otherwise.
  // An unstamped note is an older build's, or a half-written one, and it has
  // to read as *older than any ask* rather than as newer than one.
  t.true(needsOffer({ id: 'tab', at: 1 }, { to: 'tab' }),
         'an offer with no stamp is older than an ask that has one');
  // And the same asymmetry the other way up: an *ask* with no stamp must not
  // read as newer than an offer that has one, or the host makes a fresh offer
  // on every poll and the handshake restarts for ever.
  t.false(needsOffer({ id: 'tab' }, { to: 'tab', at: 0 }),
          'an ask with no stamp is not newer than an answered one');
});

test('the newer half of an introduction wins, per field', async (t) => {
  // Three fields written by two devices -- a watcher asks, the host offers, the
  // watcher answers -- so a whole-object rule would have each side's write
  // erase the other's half and the handshake would never complete.
  const local = { rtc: { watching: { at: 200 }, offer: { at: 100 } } };
  const remote = { rtc: { offer: { at: 300 } } };
  const merged = mergeSignal(local, remote).rtc;
  t.eq(merged.watching.at, 200, 'a field only one side has survives');
  t.eq(merged.offer.at, 300, 'and the newer of a shared one wins');
  t.eq(mergeSignal(remote, local).rtc.offer.at, 300, 'from either side');
});

test('a withdrawn note stays withdrawn', async (t) => {
  // Withdrawing is a *note*, not a deletion: an absent key always loses to a
  // present one in the merge, so deleting a copy has it handed straight back
  // by the other device's stale one -- and after a reload, where the
  // already-answered marks are gone, that resurrected offer is answered again
  // against a connection that no longer exists.
  const live = liveNotes({ offer: { at: 1 }, answer: { gone: true, at: 2 } });
  t.eq(Object.keys(live), ['offer'], 'the withdrawn one is hidden');
  const merged = mergeSignal({ rtc: { answer: { at: 1 } } },
                             { rtc: { answer: { gone: true, at: 2 } } }).rtc;
  t.true(merged.answer.gone, 'and the withdrawal is what the merge keeps');
});

test('the newer symbol digest wins, and neither side loses one it has',
     async (t) => {
  const mine = { sym: { at: 100, map: { a: 1 } } };
  const theirs = { sym: { at: 200, map: { b: 2 } } };
  t.eq(mergeSymbols(mine, theirs).sym.at, 200, 'the newer one');
  t.eq(mergeSymbols(theirs, mine).sym.at, 200, 'from either side');
  t.eq(mergeSymbols(mine, {}).sym.at, 100, 'and nothing loses what only it has');
  t.eq(mergeSymbols({}, {}).sym, undefined, 'with nothing invented');
});
