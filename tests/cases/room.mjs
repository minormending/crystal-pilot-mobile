// The two merge rules the room runs, both of which decide what one device
// believes about another. Pure functions, so they are testable without a
// browser or Firebase -- which is the only reason the bugs below were fixable
// with a test rather than with two phones and some patience.
import { test } from '../harness.mjs';
import { liveNotes, mergeOptions, mergeSignal, needsOffer } from '../../gbcore/room.js';

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
