// What the interface says, and when a button works.
//
// This is the "why is that greyed out?" logic. It used to be inseparable from
// fifty-odd textContent assignments, which is why none of it was ever tested
// and why one row decided its own state by reading a disabled property back
// out of the DOM.
import { fakeRom, symbols, test, worldRam } from '../harness.mjs';
import { GameState } from '../../gen2/state.js';
import { readCode } from '../../gbcore/room.js';
import { describeHandoff, describeOffers, describeParty, describeReplaced,
         describeRoom, describeScreen, joinFailure, describeRows, describeSlot,
         betterGrind, betterHour, hoursLine, otherHour,
         describeUndo, describeSaying, describeAuto, describeDex,
         describeDexTotals, describeTitle, findSpecies, saySpan,
         shiftTo, waitCost, waitOffer } from '../../app/rows.js';
import { gen2 } from '../../gen2/engine.js';

const sym = symbols();
const state = new GameState(sym);
const rom = fakeRom({}, {});
const CYNDAQUIL = 155, PIDGEY = 16, POKE_BALL = 5;

const look = (world, ctx = {}) =>
  describeRows(state.read(worldRam(sym, world)), { rom, ...ctx });
const offers = (world, ctx = {}) =>
  describeOffers(state.read(worldRam(sym, world)), { rom, ...ctx });

test('with no party, only the rows that need none are offered', async (t) => {
  const r = look({});
  t.false(r.grind.enabled, 'nothing to grind');
  t.contains(r.grind.text, 'no party', 'and it says why');
  t.false(r.grind.levels, 'the level presets are hidden');
  t.false(r.heal.enabled, 'nothing to heal');
  t.contains(r.heal.text, 'no party', 'and it says why');
});

test('a job is never enabled without saying what it would do', async (t) => {
  // Every row is either usable or explains itself. A greyed-out button with a
  // stale caption is the failure this guards.
  const worlds = [
    {},
    { party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }] },
    { battleMode: 1, party: [{ hp: 20, maxHp: 20 }], enemy: { species: PIDGEY, level: 3, hp: 15, maxHp: 15 } },
    { battleMode: 2, party: [{ hp: 20, maxHp: 20 }], enemy: { species: PIDGEY, level: 9, hp: 15, maxHp: 15 } },
  ];
  // **Or offers a slot to fill**, which is the stronger version of the same
  // rule. Three rows used to read "pick something below" -- a sentence that
  // exists only because the control was somewhere else, and that asks the
  // person to do the linking. They carry a tappable slot now, so a row with no
  // words is a row whose next step is *in* it. Silence with nothing to press
  // is still the defect this test was written for.
  for (const w of worlds) {
    for (const [name, row] of Object.entries(look(w))) {
      const says = typeof row.text === 'string' && row.text.length > 0;
      t.true(says || !!row.needs,
             `${name} says something or offers a slot`);
    }
  }
});

test('catch offers the errand instead of itself when there are no balls', async (t) => {
  const world = { party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }] };
  const without = look(world, { huntWanted: 'SENTRET' });
  t.true(without.catch.needsBalls, 'no ball chosen means no balls');
  t.contains(without.catch.text, 'no Poké Balls', 'it says what is missing');
  // The words "fetch them first" are gone, and the flag they were duplicating
  // is what stays: `needsBalls` is what draws the Get button, and a sentence
  // telling somebody to press a button sitting beside it is the sentence this
  // pass is trying to stop writing.
  t.false(without.catch.enabled, 'and catch itself is not offered');

  const with_ = look(world, { huntWanted: 'SENTRET', ballId: POKE_BALL });
  t.false(with_.catch.needsBalls, 'a ball is available');
  t.true(with_.catch.enabled, 'so catch is offered');
  t.contains(with_.catch.text, 'SENTRET', 'naming the target');
});

test("a trainer's Pokemon is never offered as catchable", async (t) => {
  const trainer = look({
    battleMode: 2, party: [{ hp: 20, maxHp: 20 }],
    enemy: { species: PIDGEY, level: 9, hp: 15, maxHp: 15 },
  }, { ballId: POKE_BALL });
  t.false(trainer.here.enabled, 'the throw is refused');
  t.contains(trainer.here.text, 'cannot be caught', 'and it says why');
  t.true(trainer.battle.enabled, 'but the battle can still be played out');
  t.contains(trainer.battle.text, 'trainer', 'and it says which kind');
});

test('a full party refuses a catch, and says so rather than failing later', async (t) => {
  const six = Array.from({ length: 6 }, () => ({ hp: 20, maxHp: 20 }));
  const r = look({
    battleMode: 1, party: six,
    enemy: { species: PIDGEY, level: 3, hp: 15, maxHp: 15 },
  }, { ballId: POKE_BALL });
  t.false(r.here.enabled, 'refused up front');
  t.contains(r.here.text, 'party is full', 'with the reason on screen');
});

test('saving explains which of the three things is in the way', async (t) => {
  t.contains(look({ mapStatus: 1 }).save.text, 'start a game', 'no world');
  t.contains(look({ battleMode: 1, enemy: { hp: 1, maxHp: 1 } }).save.text,
             'finish the battle', 'mid-battle');
  t.contains(look({ scriptMode: 1 }).save.text, 'settle', 'mid-script');
  const ready = look({});
  t.true(ready.save.enabled, 'and out in the world it is offered');
  t.contains(ready.save.text, 'not saved yet', 'saying where it stands');
  t.contains(look({}, { savedThisSession: true }).save.text, 'saved this session',
             'which changes once a save is made');
});

test('heal counts who is hurt and names where it would go', async (t) => {
  const r = look({
    party: [{ species: CYNDAQUIL, level: 5, hp: 4, maxHp: 20 },
            { species: PIDGEY, level: 3, hp: 15, maxHp: 15 }],
  }, { healPlace: "Elm's computer" });
  t.true(r.heal.enabled, 'someone is hurt');
  // The count is *not* in this row, and that is deliberate: the party summary
  // sits one line above it and says "1 hurt", and this row's own glyph is a
  // heart. What only this row can tell you is where it would go.
  t.false(r.heal.text.includes('1 hurt'), 'not counting what the party line counts');
  t.contains(r.heal.text, "Elm's computer", 'naming the destination, which is its job');

  const well = look({ party: [{ hp: 20, maxHp: 20 }] });
  t.false(well.heal.enabled, 'nobody hurt means nothing to do');
  t.contains(well.heal.text, 'full health', 'said plainly');
});

test('heal refuses mid-battle even with someone hurt', async (t) => {
  const r = look({
    battleMode: 1, party: [{ hp: 4, maxHp: 20 }],
    enemy: { species: PIDGEY, level: 3, hp: 15, maxHp: 15 },
  });
  t.false(r.heal.enabled, 'it would have to walk, and it cannot');
  t.contains(r.heal.text, 'finish the battle', 'with the reason');
});

// --- slots and undo ---------------------------------------------------------
test('an empty slot reads as empty, and a kept one describes itself', async (t) => {
  t.eq(describeSlot(null), 'empty', 'nothing kept');
  const line = describeSlot({ where: 'Route 29', lead: 'CYNDAQUIL Lv5',
                              when: new Date(2026, 8, 2, 18, 4).getTime() });
  t.contains(line, 'Route 29', 'where');
  t.contains(line, 'CYNDAQUIL Lv5', 'who');
  t.contains(line, '18:04', 'and when');
});

test('undo tells apart "no job yet" from "that job could not be undone"', async (t) => {
  // These shared a sentence, so a lost undo point looked like a fresh session.
  const fresh = describeUndo(null, null);
  t.contains(fresh.text, 'nothing to undo yet', 'no job has run');
  t.false(fresh.enabled, 'and nothing to press');

  const refused = describeUndo(null, 'the screen is busy');
  t.contains(refused.text, 'could not be undone', 'a job ran and left no point');
  t.contains(refused.text, 'the screen is busy', 'with the reason');
  t.false(refused.enabled, 'still nothing to press');
  t.ne(refused.text, fresh.text, 'and it does not read like a fresh session');

  const ready = describeUndo({ job: 'grinding to Lv6', where: 'Route 29',
                               lead: 'CYNDAQUIL Lv5' }, null);
  t.true(ready.enabled, 'there is a point to go back to');
  t.contains(ready.text, 'grinding to Lv6', 'naming the job it would undo');
});

test('the sharing row says which of the four states it is in', async (t) => {
  // Four states and a code. The one that used to be a shrug is 'unavailable':
  // an offline first load cannot fetch the Firebase SDK at all, and "sharing is
  // broken" would be the wrong sentence for "you have no signal".
  t.eq(describeRoom({ status: 'local', code: null }).text, 'not sharing',
       'no room yet');
  t.eq(describeRoom({ status: 'local', code: null }).button, 'Share',
       'and the button offers one');
  t.true(describeRoom({ status: 'local', code: null }).joining,
         'the code box is there for the second device');
  t.contains(describeRoom({ status: 'connecting', code: 'TIGER-COMET-BANJO-472' }).text,
             'connecting', 'a room, not reached yet');
  t.contains(describeRoom({ status: 'synced', code: 'TIGER-COMET-BANJO-472' }).text,
             'sharing as TIGER-COMET-BANJO-472', 'connected, and says the code');
  t.contains(describeRoom({ status: 'offline', code: 'TIGER-COMET-BANJO-472' }).text,
             'will catch up', 'offline is a delay, not a failure');
  t.eq(describeRoom({ status: 'unavailable' }).button, null,
       'nothing to press when the SDK could not be fetched');
  t.false(describeRoom({ status: 'synced', code: 'X-Y-Z-1' }).joining,
          'no code box while already in a room');
});

test('a code that does not join says why, and never says nothing', async (t) => {
  t.contains(joinFailure('malformed'), 'five letters and numbers',
             'a half-typed code says what a whole one looks like');
  t.contains(joinFailure('not-found'), 'typo', 'the room is not there');
  t.contains(joinFailure('network'), 'try again', 'the network, not the code');
  // A reason from a newer kidsync than this build knows about.
  t.contains(joinFailure('rate-limited'), 'rate-limited',
             'an unknown reason still reaches the person');
});

test('only two handoff states earn the status line', async (t) => {
  const u = (arg) => describeHandoff(arg).urgent;
  t.false(u({ seen: { empty: true } }), 'nothing shared is not news');
  t.true(u({ seen: { by: 'iPad', rev: 4, says: 'Route 29' }, rev: 2 }),
         'the other device being ahead is the whole point of the row');
  t.true(u({ seen: { by: 'iPad', rev: 4, tag: 'aaaa' }, rev: 2, tag: 'bbbb' }),
         'and a save from another build is a problem, not a state');
  t.false(u({ seen: { by: 'iPad', rev: 1 }, rev: 3 }),
          'this device being ahead is for the save row to mention');
  t.false(u({ seen: { by: 'iPad', rev: 3, says: 'Route 29' }, rev: 3 }),
          'and "in step" is the good state, which needs no line');
});

test('the handoff row tells the two devices apart, and only offers when it should', async (t) => {
  const there = { empty: false, rev: 5, by: 'iPhone', says: 'Route 29 · TOTODILE Lv5', tag: 'abc123' };

  t.eq(describeHandoff({ seen: null }).button, null, 'nothing shared, nothing to take');
  t.contains(describeHandoff({ seen: null }).text, 'save the game',
             'and it says how to put something there');

  const behind = describeHandoff({ seen: there, rev: 4, tag: 'abc123' });
  t.eq(behind.button, 'Take over', 'their save is newer than ours');
  t.contains(behind.text, 'iPhone', 'and it says whose');
  t.contains(behind.text, 'Route 29 · TOTODILE Lv5', 'and where it is');

  t.eq(describeHandoff({ seen: there, rev: 6, tag: 'abc123' }).button, null,
       'ours is newer: nothing to take');
  t.contains(describeHandoff({ seen: there, rev: 6, tag: 'abc123' }).text, 'save again',
             'and it says how to share it');

  const level = describeHandoff({ seen: there, rev: 5, tag: 'abc123' });
  t.eq(level.button, null, 'the same save on both: nothing to do');
  t.contains(level.text, 'in step', 'and it says so rather than staying blank');
});

test('a save from a different ROM is named, not offered', async (t) => {
  // The addresses the pilot reads and the layout a save is written in come out
  // of the same build. Bytes from another one load, and then everything after
  // is confidently wrong -- which is worse than not loading at all.
  const said = describeHandoff({
    seen: { empty: false, rev: 9, by: 'iPad', says: 'Goldenrod', tag: 'other-build' },
    rev: 0,
    tag: 'abc123',
  });
  t.eq(said.button, null, 'no offer to take it');
  t.contains(said.text, 'different ROM', 'and the reason is on screen');
});

test('the replaced game is offered back only when there is one', async (t) => {
  // A row reading "nothing was replaced" explains a mechanism nobody has met.
  t.false(describeReplaced(null).show, 'no handoff has replaced anything yet');
  const said = describeReplaced({ where: 'Route 29', lead: 'TOTODILE Lv5', party: 1,
                                  when: Date.now() });
  t.true(said.show, 'a handoff replaced a game, so the way back is on screen');
  t.contains(said.text, 'Route 29', 'and it says which game it was');
});

test('the screen row says whose screen, and what pressing it would do', async (t) => {
  t.eq(describeScreen({}).button, 'Show', 'nobody is showing anything');
  t.eq(describeScreen({ host: 'iPhone' }).button, 'Watch',
       'someone else is showing, so this device can ask to see it');
  t.contains(describeScreen({ host: 'iPhone' }).text, 'iPhone is showing',
             'and it says who');
  t.contains(describeScreen({ hosting: true }).text, 'press Watch on the other device',
             'showing, with nobody watching yet, says what to do next');
  t.contains(describeScreen({ hosting: true, viewer: 'iPad' }).text, 'to iPad',
             'and names the device once one is watching');
  t.eq(describeScreen({ watching: true, host: 'iPhone' }).button, 'Leave',
       'watching offers the way out');
});

test('a device with no game is never offered to show one', async (t) => {
  // The device that took the "watch my other device" door has no ROM by
  // definition. Offering Show there is not a button that does nothing: it
  // captures the blank canvas and announces this device as showing, so the
  // other one is handed a black rectangle and both rows insist a screen is
  // being shared.
  const empty = describeScreen({ game: false });
  t.eq(empty.button, null, 'no button at all, rather than a disabled one');
  t.contains(empty.text, 'waiting for your other device',
             'and it says what it is waiting for');
  t.eq(describeScreen({ game: false, host: 'iPhone' }).button, 'Watch',
       'but once there is a screen to watch, watching is still the offer');
  t.eq(describeScreen({}).button, 'Show',
       'a device that has a game is unaffected');
});

test('a host with its screen off says so rather than showing a still picture', async (t) => {
  // A hidden page runs about one frame a second, measured -- so the picture
  // stops being a picture and starts being a photograph. Saying it beats
  // letting someone tap a pad that is going nowhere.
  const said = describeScreen({ watching: true, host: 'iPhone', asleep: true });
  t.contains(said.text, 'screen off', 'the row explains the frozen picture');
  t.eq(said.button, 'Leave', 'and leaving is still on offer');
});

test('the pilot offers nothing before there is a world to act in', async (t) => {
  const o = offers({ mapStatus: 0 });
  t.eq(o.offered.length, 0, 'no jobs on the title screen');
  t.eq(o.hint, '', 'and no advice about unlocking them either');
});

test('a battle empties the list, and says where its own actions went',
     async (t) => {
  // Fight and Throw are not offers -- they answer what is in front of you, and
  // they live beside the pad. Nothing that walks can start, so nothing does.
  const o = offers({
    battleMode: 1, party: [{ species: CYNDAQUIL, level: 5, hp: 4, maxHp: 20 }],
    enemy: { species: PIDGEY, level: 3, hp: 15, maxHp: 15 },
  }, { huntWanted: 'PIDGEY', ballId: POKE_BALL });
  t.eq(o.offered.length, 0, 'the pilot has nothing to propose mid-battle');
  t.false('battle' in o.rank, 'and does not rank the battle actions itself');
  t.contains(o.hint, 'by the pad', 'an empty list explains itself');
});

test('a fainted party lifts healing above the jobs it would block', async (t) => {
  const world = (hp) => ({
    party: [{ species: CYNDAQUIL, level: 5, hp, maxHp: 20 }],
  });
  const down = offers(world(0), { huntWanted: 'SENTRET', ballId: POKE_BALL });
  t.true(down.offered.indexOf('heal') < down.offered.indexOf('grind'),
         'a trip to the Center comes before another fight');

  const hurt = offers(world(4), { huntWanted: 'SENTRET', ballId: POKE_BALL });
  t.true(hurt.offered.indexOf('heal') > hurt.offered.indexOf('grind'),
         'merely scratched, and healing drops to the bottom');
});

test('only jobs that would start are offered, and the rest go unmentioned',
     async (t) => {
  const o = offers({ party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }] },
                   { huntWanted: 'SENTRET', ballId: POKE_BALL });
  t.eq(o.offered.join(','), 'catch,hunt,grind',
          'three jobs, in the order you would want them');
  t.eq(o.rank.catch, 1, 'ranks are 1-based, because they become CSS order');
  t.eq(o.hint, '', 'and nothing is missing, so nothing is explained');
});

test('with no balls, Catch goes and the Errand row carries the way out',
     async (t) => {
  // **This replaces the opposite rule.** v165 kept Catch on the list without
  // balls, because the errand that fetches them was a second button on that
  // row and hiding the row would have hidden the way out of the very state it
  // described.
  //
  // The errand is a row of its own now, ranked high, so the way out is on the
  // list either way -- and said by a row that can actually be pressed rather
  // than by one that cannot. Which matters because of the runner: it presses a
  // row's *own* button, so a secondary button was invisible to it and "Run the
  // list" could never fetch the first balls.
  const world = { party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }],
                  map: [3, 1] };
  const ctx = { huntWanted: 'PIDGEY', huntable: 2,
                wilds: { low: 2, high: 3 } };
  const list = offers(world, ctx);
  t.false(list.offered.includes('catch'), 'Catch cannot run, so it is not drawn');
  t.true(list.offered.includes('errand'), 'and the errand is');
  t.eq(look(world, ctx).errand.text, 'the first Poké Balls', 'saying what it fetches');
});

test('the hint only names things there is something to do about', async (t) => {
  const empty = offers({}, { huntable: 4 });
  t.contains(empty.hint, 'need a Pokémon', 'no party is worth saying');
  // **"pick something below" is gone from here**, because the Hunt and Catch
  // rows carry a slot that scrolls straight to the picker: the sentence was
  // describing a journey nobody has to make now. What it was paired with -- the
  // ranking rule that keeps a row waiting on a choice *on* the list, or its
  // picker can never be reached -- is still load-bearing, and is tested below.
  t.false(empty.hint.includes('pick something'),
          'the rows point at their own picker now');

  const indoors = offers({}, { huntable: 0 });
  t.contains(indoors.hint, 'need a Pokémon', 'the rest of the line stands');

  const chosen = offers({ party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }] },
                        { huntWanted: 'SENTRET' });
  t.eq(chosen.hint, '', 'a target is picked and a party is out, so silence');

  const battling = offers({
    battleMode: 1, party: [{ hp: 20, maxHp: 20 }],
    enemy: { species: PIDGEY, level: 3, hp: 15, maxHp: 15 },
  });
  t.false(battling.hint.includes('pick something'),
          'nothing about picking targets while a battle is on the screen');
  t.contains(battling.hint, 'Fight and Throw', 'only where the actions are');
});

test('the party reads as one line, and says fainted rather than hurt',
     async (t) => {
  const party = (world) => describeParty(state.read(worldRam(sym, world)), { rom });

  t.eq(party({}), 'no party yet', 'with nobody, it says so and stops');

  const alone = party({ party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }] });
  t.contains(alone, 'Lv5', 'the lead carries its level');
  t.contains(alone, '20/20', 'and its health');
  t.false(alone.includes('more'), 'and says nothing about a party of one');

  const three = party({ party: [
    { species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 },
    { species: PIDGEY, level: 4, hp: 9, maxHp: 15 },
    { species: PIDGEY, level: 3, hp: 12, maxHp: 12 },
  ] });
  t.contains(three, '+2 more', 'the rest are counted, not listed');
  t.contains(three, '1 hurt', 'and the one that is hurt is the reason to care');

  const down = party({ party: [
    { species: CYNDAQUIL, level: 5, hp: 0, maxHp: 20 },
    { species: PIDGEY, level: 4, hp: 9, maxHp: 15 },
  ] });
  t.contains(down, '1 fainted', 'fainted is said instead of hurt');
  t.false(down.includes('hurt'), 'because it is the half that stops a job');
});

test('showing a screen says whether the watcher may play, and offers the other way',
     async (t) => {
  const open = describeScreen({ hosting: true, viewer: 'iPad' });
  t.contains(open.text, 'they can play', 'handing the pad over is said out loud');
  t.eq(open.second, 'View only', 'and the second control is the other mode');

  const shut = describeScreen({ hosting: true, viewer: 'iPad', play: false });
  t.contains(shut.text, 'view only', 'so is keeping it');
  t.eq(shut.second, 'Hand over', 'and the offer flips with it');
  t.eq(shut.button, 'Stop', 'while Stop stays where it is');

  t.eq(describeScreen({}).second, 'View only',
       'the choice is offered before anyone is watching, not after');
  t.contains(describeScreen({ host: 'iPhone', play: false }).text, 'view only',
             'and the other device is told before it presses Watch');
  t.false(describeScreen({ host: 'iPhone' }).text.includes('view only'),
          'but not when there is nothing to warn about');
  t.eq(describeScreen({ hosting: true, play: false }).second, 'Hand over',
       'including with nobody watching yet');
});

test('a watcher is told which of the two reasons its pad is doing nothing',
     async (t) => {
  const at = (input) => describeScreen({ watching: true, host: 'iPhone', input });

  t.eq(at({ ok: true }).text, 'watching iPhone',
       'when it works there is nothing to explain');
  t.contains(at({ ok: false, why: 'view' }).text, 'view only',
             'a decision on the other device');
  t.contains(at({ ok: false, why: 'busy' }).text, 'the pilot is driving',
             'and a job holding the joypad, which ends by itself');
  t.eq(at({ ok: false, why: 'busy' }).button, 'Leave',
       'neither changes what the button does');

  // A screen that is off outranks both: there is nothing to look at, never
  // mind press.
  t.contains(describeScreen({ watching: true, host: 'iPhone', asleep: true,
                              input: { ok: false, why: 'view' } }).text,
             'screen off', 'and a dark screen is the bigger news');
});

test('a room code is read the way it was probably meant', async (t) => {
  t.eq(readCode('K7M2P'), 'K7M2P', 'a clean code comes back unchanged');
  t.eq(readCode(' k7m2p '), 'K7M2P', 'case and stray space are noise');
  t.eq(readCode('K7-M2P'), 'K7M2P', 'so are dashes someone added for rhythm');

  // The alphabet exists so that these three can only have meant the digit.
  t.eq(readCode('KIM2P'), 'K1M2P', 'a typed I can only have meant 1');
  t.eq(readCode('KLM2P'), 'K1M2P', 'and so can an L');
  t.eq(readCode('K7M2O'), 'K7M20', 'a typed O can only have meant 0');

  t.eq(readCode('K7M2'), null, 'four characters is not a code');
  t.eq(readCode('K7M2PQ'), null, 'nor is six');
  t.eq(readCode('K7M2U'), null, 'U is not in the alphabet, so it is a mistake');
  t.eq(readCode(''), null, 'and nothing is nothing');
  t.eq(readCode(null), null, 'including the wrong type entirely');
});

test('a slot from another cartridge is named rather than offered', async (t) => {
  const kept = { where: 'Route 29', lead: 'TOTODILE Lv5', when: Date.now(),
                 tag: 'aaaaaaaaaaaaaaaa' };

  t.contains(describeSlot(kept, 'aaaaaaaaaaaaaaaa'), 'Route 29',
             'the same ROM reads as it always did');
  t.eq(describeSlot(kept, 'bbbbbbbbbbbbbbbb'), 'from a different ROM',
       'another ROM is said instead of a place and a time');

  // A slot kept before slots recorded a tag, and a session that has not worked
  // one out yet, are both believed -- the check needs two answers to compare.
  t.contains(describeSlot({ ...kept, tag: undefined }, 'bbbbbbbbbbbbbbbb'), 'Route 29',
             'an untagged slot is loaded the way it always was');
  t.contains(describeSlot(kept, null), 'Route 29',
             'and so is any slot before this device knows its own ROM');

  const mine = describeReplaced(kept, 'aaaaaaaaaaaaaaaa');
  t.true(mine.enabled && mine.show, 'a replaced game from this ROM is offered back');
  const theirs = describeReplaced(kept, 'bbbbbbbbbbbbbbbb');
  t.true(theirs.show, 'one from another ROM is still shown, because it is a record');
  t.false(theirs.enabled, 'but putting it back is not offered');
});

test('a cartridge that cannot fetch balls offers neither the catch nor an errand',
     async (t) => {
  // `canFetch` is a title question: the trip that gets the first balls is a
  // scripted walk to particular places, and a cartridge nobody has described
  // has no such walk. Then there is nothing to draw and a sentence to say.
  const world = { party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }],
                  map: [3, 1] };
  const ctx = { canFetch: false, huntWanted: 'PIDGEY', huntable: 2,
                wilds: { low: 2, high: 3 } };
  const list = offers(world, ctx);
  t.false(list.offered.includes('catch'), 'no catch');
  t.false(list.offered.includes('errand'), 'and no errand to unstick it');
  t.contains(list.hint, 'cannot fetch them', 'but the reason is said');
});

// --- travel -----------------------------------------------------------------

const PLACES = [
  { key: 26 * 256 + 1, name: 'Cherrygrove City', legs: 1 },
  { key: 26 * 256 + 2, name: 'Route 30', legs: 3 },
];
const PARTY = { party: [{ hp: 20, maxHp: 20, species: CYNDAQUIL, level: 5 }] };
const FIGHTING = { ...PARTY, battleMode: 1, enemy: { species: PIDGEY, level: 3 } };

test('travel names the place and what the walk will cost', async (t) => {
  const none = look(PARTY, { places: PLACES }).travel;
  t.eq(none.text, '', 'with nothing chosen it says nothing');
  t.eq(none.needs, 'place', 'and offers a slot instead of an instruction');
  t.false(none.enabled, 'and will not walk');

  const near = look(PARTY, { places: PLACES, travelTo: PLACES[0].key }).travel;
  t.eq(near.text, 'Cherrygrove City · one map away', 'singular for one leg');
  t.true(near.enabled, 'and it can go');

  const far = look(PARTY, { places: PLACES, travelTo: PLACES[1].key }).travel;
  t.eq(far.text, 'Route 30 · three maps away', 'and plural beyond that');
});

test('a cartridge with no named places offers no travel at all', async (t) => {
  // The rule the scripted intro and the ball errand follow: a row full of
  // `map 26.4` is a data dump, not an offer.
  const row = look(PARTY, { places: [] }).travel;
  t.eq(row.text, 'nowhere named to walk to', 'it says so if asked');
  t.false(row.enabled, 'and cannot be pressed');
  const o = offers(PARTY, { places: [] });
  t.eq(o.rank.travel, undefined, 'and the row is not drawn');
  t.false(o.hint.includes('walk to'),
          'nor nagged about — there is nothing to be done about it from here');
});

test('a place that has gone out of reach is not still offered', async (t) => {
  // Walking changes the answer. A chosen key no longer in the list would be a
  // button that fails on being pressed.
  const row = look(PARTY, { places: PLACES, travelTo: 999 }).travel;
  t.eq(row.text, '', 'it says nothing about a place it cannot reach');
  t.eq(row.needs, 'place', 'and offers the slot again');
  t.false(row.enabled, 'rather than offering a walk it cannot make');
});

test('travel is last of the five, and gone in a battle', async (t) => {
  const rank = offers(PARTY, { places: PLACES, travelTo: PLACES[0].key,
                               ballId: POKE_BALL, huntWanted: 'PIDGEY' }).rank;
  t.eq(rank.travel, 4, 'below the jobs, because a place is still there later');

  const fighting = offers(FIGHTING, { places: PLACES, travelTo: PLACES[0].key });
  t.eq(fighting.rank.travel, undefined, 'and not offered mid-battle');
  t.eq(look(FIGHTING, { places: PLACES, travelTo: PLACES[0].key }).travel.text,
       'finish the battle first', 'which the row says if it is looked at');
});

test('the Travel row offers its own slot instead of a hint', async (t) => {
  // **The hint is gone, and the condition that guarded it now draws a slot.**
  // It said "or a place to walk to" under a row already offering to choose one,
  // which is the app talking to itself -- and it asked the reader to go and
  // find a list that the row can now scroll to itself.
  //
  // The *rule* underneath is unchanged and is what this still checks: offered
  // while the row is drawn and waiting, silent once a place is chosen.
  const waiting = offers(PARTY, { places: PLACES });
  t.false(waiting.hint.includes('a place to walk to'), 'no hint about it');
  t.eq(describeRows(state.read(worldRam(sym, PARTY)),
                    { rom, places: PLACES }).travel.needs,
       'place', 'the row asks, in the row');

  const chosen = describeRows(state.read(worldRam(sym, PARTY)),
                              { rom, places: PLACES, travelTo: PLACES[0].key });
  t.eq(chosen.travel.needs, null, 'and stops asking once one is chosen');
});

// --- what the grass here gives ----------------------------------------------

test('the grind row names the levels the grass actually gives', async (t) => {
  // Measured on the cartridge: Route 29 produces Lv2–3, Route 30 Lv4–5. The
  // level byte was sitting unread in the encounter table -- a slot is two bytes,
  // level then species, and the species reader stepped over the first.
  const party = { party: [{ hp: 40, maxHp: 40, species: CYNDAQUIL, level: 15 }] };
  t.contains(look(party, { target: 20, wilds: { low: 2, high: 3 } }).grind.text,
             'here Lv2–3', 'a range reads as a range');
  t.contains(look(party, { target: 20, wilds: { low: 7, high: 7 } }).grind.text,
             'here Lv7', 'and one level reads as one level');
  t.false(look(party, { target: 20, wilds: null }).grind.text.includes('here:'),
          'a map with no grass says nothing about levels rather than guessing');
});

test('a lead above everything here is told the grind will be slow', async (t) => {
  // The measured failure this exists for: a Lv15 Pokémon aimed at Lv20 on
  // Route 29 won 32 of 35 battles for two levels and a knockout, and the app
  // offered Lv20 as a preset with nothing to say about it.
  const high = { party: [{ hp: 40, maxHp: 40, species: CYNDAQUIL, level: 15 }] };
  const low = { party: [{ hp: 20, maxHp: 20, species: CYNDAQUIL, level: 3 }] };
  const wilds = { low: 2, high: 3 };

  t.true(look(high, { target: 20, wilds }).grind.outlevelled,
         'Lv15 against Lv2–3 is above all of it');
  t.contains(offers(high, { target: 20, wilds, huntable: 4 }).hint, 'will be slow',
             'and the hint says so, because that is advice rather than state');

  t.false(look(low, { target: 10, wilds }).grind.outlevelled,
          'Lv3 against Lv2–3 is not');
  t.false(offers(low, { target: 10, wilds, huntable: 4 }).hint.includes('slow'),
          'so nothing is said');
  t.false(offers(high, { target: 20, wilds: null, huntable: 0 }).hint.includes('slow'),
          'and a map with no grass is unknown rather than unfavourable');
});

// --- somewhere better to grind ----------------------------------------------

// The real numbers, measured off the cartridge: Route 29 gives Lv2–3, Route 30
// Lv4–5, and Elm's lab has no grass at all.
const JOHTO = [
  { key: 24 * 256 + 3, name: 'Route 29', legs: 1, wilds: { low: 2, high: 3 } },
  { key: 26 * 256 + 2, name: 'Route 30', legs: 2, wilds: { low: 4, high: 5 } },
  { key: 26 * 256 + 3, name: 'Route 31', legs: 3, wilds: { low: 5, high: 8 } },
  { key: 24 * 256 + 5, name: "Elm's lab", legs: 1, wilds: null },
];

test('a better place to grind is the nearest one whose grass pays', async (t) => {
  // One fact about two numbers, not a model of experience: a place is worth
  // walking to when its grass tops out at or above the level being trained.
  t.eq(betterGrind(JOHTO, 3).name, 'Route 29', 'Lv3 is still paid here');
  t.eq(betterGrind(JOHTO, 5).name, 'Route 30',
       'Lv5 needs Route 30, and two legs beat three');
  t.eq(betterGrind(JOHTO, 7).name, 'Route 31',
       'Lv7 outgrows Route 30, so the further one wins on its ceiling');
  t.eq(betterGrind(JOHTO, 15), null,
       'and nothing reachable pays a Lv15 lead, which has to read as silence');
});

test('a map with no grass is never suggested', async (t) => {
  const indoors = [{ key: 1, name: "Elm's lab", legs: 1, wilds: null }];
  t.eq(betterGrind(indoors, 5), null, 'no table means no answer, not a guess');
  t.eq(betterGrind([], 5), null, 'and nowhere reachable means the same');
  t.eq(betterGrind(null, 5), null, 'as does having asked before the list exists');
});

test('the hint names where to go rather than only that here is slow',
     async (t) => {
  // The two previous passes meeting: one read the level beside every species,
  // the other built the list of reachable named maps. Neither alone answers the
  // question a slow grind actually raises.
  const lead = (level) => ({ party: [{ hp: 40, maxHp: 40,
                                       species: CYNDAQUIL, level }] });
  const here = { low: 2, high: 3 };

  const said = offers(lead(6), { target: 20, wilds: here, places: JOHTO,
                                 huntable: 4 }).hint;
  t.contains(said, 'Route 31', 'it names the place');
  t.contains(said, 'Lv5–8', 'and what that place gives');
  t.contains(said, 'three maps away', 'and what the walk costs');

  // Nothing better reachable: the older, vaguer line, because there is nothing
  // to do about it from here and pretending otherwise would be worse.
  const stuck = offers(lead(20), { target: 30, wilds: here, places: JOHTO,
                                   huntable: 4 }).hint;
  t.contains(stuck, 'everything is below your lead', 'it says only what it knows');
  t.false(stuck.includes('Route'), 'and names nowhere');

  // And a lead the grass here still pays gets no advice at all.
  const fine = offers(lead(3), { target: 10, wilds: here, places: JOHTO,
                                 huntable: 4 }).hint;
  t.false(fine.includes('slow'), 'nothing is wrong, so nothing is said');
});

// The same patch of grass at three hours, indexed by wTimeOfDay the way
// `wildHours` returns it. Route 29's real shape, plus one map whose night block
// is worth waiting for -- because Route 29's is not, which is the honest thing
// about this feature and the reason it says nothing there.
const R29_HOURS = [
  { species: ['SENTRET', 'PIDGEY', 'RATTATA'], levels: { low: 2, high: 4 } },
  { species: ['SENTRET', 'PIDGEY', 'RATTATA'], levels: { low: 2, high: 4 } },
  { species: ['HOOTHOOT', 'RATTATA'], levels: { low: 2, high: 4 } },
];
const NIGHT_PAYS = [
  { species: ['PIDGEY'], levels: { low: 2, high: 4 } },
  { species: ['PIDGEY'], levels: { low: 2, high: 4 } },
  { species: ['GASTLY', 'HOOTHOOT'], levels: { low: 6, high: 9 } },
];

test('a better hour is the grass under your feet, later', async (t) => {
  // The cheapest fix there is: no route, no legs, nothing to go wrong.
  t.eq(betterHour(NIGHT_PAYS, 6, 1).name, 'after dark', 'a Lv6 lead should wait');
  t.eq(betterHour(NIGHT_PAYS, 6, 1).wilds, { low: 6, high: 9 },
       'and it carries what that hour gives');
  t.eq(betterHour(NIGHT_PAYS, 10, 1), null,
       'a Lv10 lead outgrows every hour here, so there is nothing to wait for');
  t.eq(betterHour(R29_HOURS, 6, 1), null,
       'and Route 29 is the same all day, which is why it says nothing');
});

test('an hour has to beat this hour, not only the lead', async (t) => {
  // Caught by measuring rather than by reading. Crystal's three blocks carry
  // the *same* levels and swap only the species -- Route 30 is Lv3-4 three
  // times over -- so a rule that asked only "does this hour pay the lead"
  // answered "come back in the morning" while standing in an identical
  // afternoon. The app's caller was already asking about a lead the grass here
  // does not pay, so it never saw this; the rule was right by a precondition
  // nobody had written down.
  t.eq(betterHour(R29_HOURS, 4, 1), null,
       'every hour here tops out at Lv4, so no hour is an improvement');
  t.eq(betterHour(R29_HOURS, 2, 1), null, 'and the same below the ceiling');
  t.eq(betterHour(NIGHT_PAYS, 4, 1).name, 'after dark',
       'while a night that really is higher is still named');
});

test('the hour it already is is never the advice', async (t) => {
  // "Come back at a time that is now" is worse than silence.
  t.eq(betterHour(NIGHT_PAYS, 6, 2), null, 'standing here after dark, nothing to say');
  t.eq(betterHour(null, 6, 1), null, 'asked before the table is read');
  // Not knowing the hour has to be a refusal. With no `now` every block is a
  // candidate, this one included, so the advice would eventually be "come back
  // at a time that is now".
  t.eq(betterHour(NIGHT_PAYS, 6, null), null, 'and one where the clock is unread');
});

test('waiting is advised before walking', async (t) => {
  // The ordering is the feature. A map that pays is two maps of walking; an
  // hour that pays is standing still, so it wins however near the map is.
  const lead = (level) => ({ party: [{ hp: 40, maxHp: 40,
                                       species: CYNDAQUIL, level }] });
  const both = offers(lead(6), { target: 20, wilds: { low: 2, high: 4 },
                                 places: JOHTO, hours: NIGHT_PAYS, hourNow: 1,
                                 huntable: 4 }).hint;
  t.contains(both, 'Lv6–9 after dark', 'the hour is named');
  t.false(both.includes('Route'), 'and the walk is not offered instead');

  // With no better hour, the walk comes back -- so this adds a preference and
  // does not replace the answer underneath it.
  const walk = offers(lead(6), { target: 20, wilds: { low: 2, high: 4 },
                                 places: JOHTO, hours: R29_HOURS, hourNow: 1,
                                 huntable: 4 }).hint;
  t.contains(walk, 'Route 31', 'the place is named again');

  // And a cartridge whose table was never read behaves as it did before the
  // feature existed, which is the shape every one of these additions takes.
  const blind = offers(lead(6), { target: 20, wilds: { low: 2, high: 4 },
                                  places: JOHTO, huntable: 4 }).hint;
  t.contains(blind, 'Route 31', 'no hours, same answer as before');
});

test('a quarry that is not here now is somewhere in the day, not nowhere',
     async (t) => {
  t.eq(otherHour(R29_HOURS, 'HOOTHOOT', 1).name, 'after dark',
       'picked at night, asked at noon');
  t.eq(otherHour(R29_HOURS, 'PIDGEY', 2).name, 'in the morning',
       'and the first hour that has it is the one named');
  t.eq(otherHour(R29_HOURS, 'MEWTWO', 1), null,
       'something this grass never gives is not a matter of waiting');
  t.eq(otherHour(R29_HOURS, null, 1), null, 'nothing chosen, nothing to explain');
  t.eq(otherHour(null, 'PIDGEY', 1), null, 'and no table means no answer');
});

test('the other hours are only mentioned where they differ', async (t) => {
  t.contains(hoursLine(R29_HOURS, 1), 'HOOTHOOT after dark',
             'the species the day does not have');
  // Commonest first inside an hour, hours in clock order -- both inherited from
  // what `wildHours` hands over, rather than re-sorted here into an order that
  // would carry less.
  t.eq(hoursLine(R29_HOURS, 2), 'also here: SENTRET in the morning, '
       + 'PIDGEY in the morning', 'and it reads both ways round the clock');
  const flat = [{ species: ['PIDGEY'], levels: { low: 2, high: 3 } },
                { species: ['PIDGEY'], levels: { low: 2, high: 3 } },
                { species: ['PIDGEY'], levels: { low: 2, high: 3 } }];
  t.eq(hoursLine(flat, 1), '', 'a patch that never changes says nothing');
  t.eq(hoursLine(null, 1), '', 'and neither does one nobody has read');
});

test('a long list of other hours is counted rather than recited', async (t) => {
  const many = [
    { species: ['PIDGEY'], levels: { low: 2, high: 3 } },
    { species: ['PIDGEY'], levels: { low: 2, high: 3 } },
    { species: ['GASTLY', 'HOOTHOOT', 'ZUBAT', 'DROWZEE'], levels: { low: 6, high: 9 } },
  ];
  const said = hoursLine(many, 1);
  t.contains(said, 'and 2 more', 'two named, the rest counted');
  t.false(said.includes('DROWZEE'), 'because a line is a line');
});

// --- what the map is holding -------------------------------------------------

test('the Take row counts what is placed here, and never promises what is left',
     async (t) => {
  // Counted rather than named on purpose: an item ball stays in work RAM after
  // it has been taken -- measured, the object at (8,35) on Route 30 was still
  // there with the ANTIDOTE in the bag -- so the row cannot know what is left.
  const ball = { x: 4, y: 4, what: 'ball' }, tree = { x: 9, y: 2, what: 'tree' };
  t.eq(look({}, { takeables: [ball] }).take.text, 'one item ball', 'one of one kind');
  t.eq(look({}, { takeables: [ball, tree] }).take.text,
       'one item ball and one fruit tree', 'both kinds, both counted');
  t.eq(look({}, { takeables: [tree, tree, tree] }).take.text, 'three fruit trees',
       'and it pluralises');
  t.eq(look({}, { takeables: [] }).take.text, 'nothing lying about here',
       'an empty map says so rather than nothing');
});

test('a sprite the profile names that is neither still counts', async (t) => {
  // A hack's own. The row must not go silent about a thing the pilot will
  // happily walk to and press A at.
  const r = look({}, { takeables: [{ x: 1, y: 1, what: 'shrine' }] });
  t.contains(r.take.text, 'one other thing', 'counted without being named');
});

test('Take is offered only where there is something to take', async (t) => {
  const ball = { x: 4, y: 4, what: 'ball' };
  const world = { party: [{ hp: 20, maxHp: 20, species: CYNDAQUIL, level: 5 }] };
  t.true(offers(world, { takeables: [ball] }).offered.includes('take'),
         'on a map holding something');
  t.false(offers(world, { takeables: [] }).offered.includes('take'),
          'and not on one that is not');
  t.false(offers({ ...world, battleMode: 1 }, { takeables: [ball] })
            .offered.includes('take'),
          'nor in a battle, where nothing on the map can be walked to');
});

// --- the Heal row, and the bag ----------------------------------------------

test('the Heal row names what it will spend, and prefers the bag', async (t) => {
  // The walk is priced in tiles -- 31 against 53 from the east end of Route 29
  // -- and a POTION already in the pocket costs none of them. So the row says
  // which it will be before it is pressed, the way it already named the nearer
  // Center.
  const hurt = { party: [{ hp: 10, maxHp: 40, species: CYNDAQUIL, level: 5 }] };
  const withBag = look(hurt, { bagHeal: 'POTION', healPlace: "Elm's lab" });
  t.true(withBag.heal.fromBag, 'the bag is the answer');
  t.contains(withBag.heal.text, 'POTION in the bag', 'and it is named');

  const without = look(hurt, { healPlace: "Elm's lab" });
  t.false(without.heal.fromBag, 'with nothing in the bag it is the walk');
  t.contains(without.heal.text, "Elm's lab", 'and the walk is named');
});

test('a fainted party is a Centre’s job whatever the bag holds', async (t) => {
  // A Potion does nothing for a Pokémon at 0 HP in Gen 2, so offering the bag
  // would be a promise the row cannot keep.
  const r = look({ party: [{ hp: 0, maxHp: 40, species: CYNDAQUIL, level: 5 }] },
                 { bagHeal: 'POTION', healPlace: 'Cherrygrove City' });
  t.false(r.heal.fromBag, 'the bag is not offered');
  t.contains(r.heal.text, 'Cherrygrove City', 'the walk is');
});

test('a Heal row with nowhere open says what turned the pilot back',
     async (t) => {
  // `nearestHeal` already skips a place the game refused, so a `healShut` that
  // reaches this row means *every* healer is written off. Saying "nearest is
  // ROUTE 32" then is a promise the row knows cannot be kept -- and the words
  // are what a person can act on, because a badge is what opens these.
  const hurt = { party: [{ hp: 10, maxHp: 40, species: CYNDAQUIL, level: 5 }] };
  const r = look(hurt, { healPlace: 'ROUTE 32',
                         healShut: "Wait up! / What's the hurry?" });
  t.contains(r.heal.text, 'turned back', 'the row says so');
  t.contains(r.heal.text, 'Wait up!', 'in the words the game used');
  t.false(r.heal.enabled, 'and does not offer a walk it knows will fail');
});

test('the shut explanation survives the row being hidden', async (t) => {
  // **The trap this repository has fallen into twice.** A row earns its place
  // on the offers list by being `enabled`, and a route the game has refused is
  // exactly when Heal is not -- so the sentence written into the row text is
  // never read by anybody. The species picker did the same thing eight passes
  // ago: a hint pointing at a picker that is hidden whenever the hint applies.
  //
  // So the explanation has to be in the hint, and this test is here to fail if
  // it ever moves back into the row.
  const hurt = { party: [{ hp: 10, maxHp: 40, species: CYNDAQUIL, level: 5 }] };
  const o = offers(hurt, { healPlace: 'ROUTE 32',
                           healShut: "Wait up! / What's the hurry?" });
  t.eq(o.rank.heal, undefined, 'the row is off the list, as it must be');
  t.contains(o.hint, 'every way to heal is shut', 'and the hint carries it');
  t.contains(o.hint, 'Wait up!', 'with the words the game used');
});

test('nothing is said about a shut route while nobody is hurt', async (t) => {
  // The rule every hint here follows: explaining the absence of an offer
  // nobody wanted is the noise this whole list exists to replace.
  const o = offers({ party: [{ hp: 40, maxHp: 40, species: CYNDAQUIL, level: 5 }] },
                   { healPlace: 'ROUTE 32', healShut: 'somebody said no' });
  t.false(o.hint.includes('shut'), 'no hurt, no line');
});

test('a shut route does not take the bag away', async (t) => {
  // The bag comes first and is free, so a route being shut is irrelevant while
  // a POTION can answer -- and disabling the row would have taken a working
  // heal away over a walk it was never going to do.
  const hurt = { party: [{ hp: 10, maxHp: 40, species: CYNDAQUIL, level: 5 }] };
  const r = look(hurt, { bagHeal: 'POTION', healPlace: 'ROUTE 32',
                         healShut: 'somebody said no' });
  t.true(r.heal.enabled, 'still offered');
  t.true(r.heal.fromBag, 'out of the bag');
  t.contains(r.heal.text, 'POTION in the bag', 'and it says so');
});

test('a fainted party with every route shut is refused, bag or no bag',
     async (t) => {
  // The two rules meeting: a Potion does nothing at 0 HP, so the walk is the
  // only answer, and the walk is shut. This is the one case where the row has
  // to admit it cannot help.
  const r = look({ party: [{ hp: 0, maxHp: 40, species: CYNDAQUIL, level: 5 }] },
                 { bagHeal: 'POTION', healPlace: 'ROUTE 32',
                   healShut: 'a man with a rite of passage' });
  t.false(r.heal.enabled, 'refused');
  t.contains(r.heal.text, 'turned back', 'and it says why');
});

test('one hurt and one fainted still needs the walk', async (t) => {
  const r = look({ party: [{ hp: 10, maxHp: 40, species: CYNDAQUIL, level: 5 },
                           { hp: 0, maxHp: 30, species: CYNDAQUIL, level: 4 }] },
                 { bagHeal: 'POTION', healPlace: "Elm's lab" });
  t.false(r.heal.fromBag, 'because the walk mends both and the bag mends one');
});

test('a full-health party says nothing about the bag', async (t) => {
  const r = look({ party: [{ hp: 40, maxHp: 40, species: CYNDAQUIL, level: 5 }] },
                 { bagHeal: 'POTION' });
  t.contains(r.heal.text, 'full health', 'the good state, and it is the good state');
  t.false(r.heal.enabled, 'and nothing to press');
});

// --- what is wrong besides the HP -------------------------------------------

test('a poisoned Pokémon at full HP is not "at full health"', async (t) => {
  // The row said it was, because the app read HP and never the status byte --
  // and poison goes on doing damage while you walk.
  const r = look({ party: [{ hp: 20, maxHp: 20, species: CYNDAQUIL, level: 5,
                             statusByte: 0x08 }] },
                 { bagCure: 'ANTIDOTE in the bag' });
  t.contains(r.heal.text, 'poisoned', 'it says which');
  t.contains(r.heal.text, 'ANTIDOTE', 'and what will fix it');
  t.true(r.heal.enabled, 'and the row can be pressed');
  t.eq(r.heal.ailing, 1, 'one of them');
});

test('the ailment is named, because which one decides what fixes it', async (t) => {
  const one = (byte) => look({ party: [{ hp: 20, maxHp: 20, species: CYNDAQUIL,
                                         level: 5, statusByte: byte }] }).heal.text;
  t.contains(one(0x40), 'paralysed', 'paralysis');
  t.contains(one(0x10), 'burned', 'a burn');
  t.contains(one(0x20), 'frozen', 'frozen');
  t.contains(one(0x03), 'asleep', 'and asleep, which is a counter not a flag');
});

test('two of them are counted rather than listed twice', async (t) => {
  const r = look({ party: [
    { hp: 20, maxHp: 20, species: CYNDAQUIL, level: 5, statusByte: 0x08 },
    { hp: 18, maxHp: 18, species: CYNDAQUIL, level: 4, statusByte: 0x08 },
  ] });
  t.contains(r.heal.text, '2 poisoned', 'a count and the kind');
});

test('hurt outranks poisoned, because HP is the thing that ends a job',
     async (t) => {
  const r = look({ party: [{ hp: 4, maxHp: 20, species: CYNDAQUIL, level: 5,
                             statusByte: 0x08 }] },
                 { bagHeal: 'POTION' });
  t.contains(r.heal.text, '1 hurt', 'the HP is said first');
});

test('a fainted Pokémon has no status worth curing', async (t) => {
  const r = look({ party: [{ hp: 0, maxHp: 20, species: CYNDAQUIL, level: 5,
                             statusByte: 0x08 }] },
                 { healPlace: "Elm's lab" });
  t.eq(r.heal.ailing, 0, 'the faint is the problem');
  t.contains(r.heal.text, "Elm's lab", 'and only a Center answers it');
});

// --- duels -------------------------------------------------------------------

test('the duel row counts who is near, and says how many are further on',
     async (t) => {
  // Two numbers because the game only loads an object you are close to.
  // Measured: standing at the south end of Route 30 the game had spawned
  // nothing, and twenty tiles north a ball, a wanderer and a trainer came into
  // being one after another. Without the map's own total, a route with three
  // trainers reads as empty until you are standing on one.
  const near = look({ party: [{ hp: 20, maxHp: 20 }], money: 3064 },
                       { trainers: [{ x: 2, y: 28, sprite: 39 }], trainersOnMap: 3 });
  t.contains(near.duel.text, 'one trainer nearby', 'who is here');
  // The money is *not* here any more, and that is the point. It is global
  // state -- a battle changes it -- and it was printed in this row and the
  // Shop row both: the same number twice, reading as clutter in each. It lives
  // in the header now, beside the place name, which is the other thing that is
  // true of the whole app rather than of one offer.
  t.false(near.duel.text.includes('3,064'), 'and not the money, which is global');
  t.true(near.duel.enabled, 'and it can run');

  const far = look({ party: [{ hp: 20, maxHp: 20 }] },
                   { trainers: [], trainersOnMap: 3 });
  t.contains(far.duel.text, 'nobody here', 'plainly, when nobody is near');
  t.false(far.duel.enabled, 'and nothing to fight from here');
  t.eq(far.duel.onMap, 3, 'while the map total is still carried');
});

test('trainers further along the map are said in the hint, not the row',
     async (t) => {
  // Because the row is hidden whenever it cannot run: a sentence in the row
  // saying "three further along" could only ever be read once walking on had
  // already happened, which is the moment it stops being useful. The hint is
  // where the things that would *add* to the list live.
  const list = offers({ party: [{ hp: 20, maxHp: 20 }] },
                      { trainers: [], trainersOnMap: 3 });
  t.false(list.offered.includes('duel'), 'no offer, because none is runnable');
  t.contains(list.hint, '3 more trainers further along', 'but the reason is said');

  const none = offers({ party: [{ hp: 20, maxHp: 20 }] },
                      { trainers: [], trainersOnMap: 0 });
  t.false(none.hint.includes('further along'),
          'and a map with none stays silent about it');
});

test('a map with no trainers on it at all says so, not "none nearby"',
     async (t) => {
  // Measured on Route 29, whose every object reads type 0: there is nothing
  // further along either, and pointing down an empty route would be a lie.
  const rows = look({ party: [{ hp: 20, maxHp: 20 }] },
                       { trainers: [], trainersOnMap: 0 });
  t.contains(rows.duel.text, 'nobody here wants a battle', 'the plain truth');
  t.false(rows.duel.enabled, 'and no offer');
});

test('a duel needs somebody who can be sent out', async (t) => {
  // The one job that cannot start with a fainted party. Every other job either
  // walks -- and a fainted party still walks -- or refuses in a battle.
  const rows = look({ party: [{ hp: 0, maxHp: 20 }] },
                       { trainers: [{ x: 2, y: 28, sprite: 39 }], trainersOnMap: 1 });
  t.contains(rows.duel.text, 'nobody fit', 'and says which');
  t.false(rows.duel.enabled, 'so it is not offered as runnable');
});

test('a duel is not offered in a battle, because a battle is already on',
     async (t) => {
  const rows = look({ party: [{ hp: 20, maxHp: 20 }], battleMode: 1,
                         enemy: { species: 16 } },
                       { trainers: [{ x: 2, y: 28, sprite: 39 }] });
  t.contains(rows.duel.text, 'finish the battle first', 'the same as Take');
  t.false(rows.duel.enabled, 'and it cannot run');
});

test('Duel is offered after Grind and before Take', async (t) => {
  // Grass is always there and a trainer is beaten once, so a trainer here now
  // is the more perishable offer -- but a duel can also be lost, and grinding
  // cannot. Grind first, therefore, and Duel immediately after it.
  const order = offers(
    { party: [{ hp: 20, maxHp: 20, level: 5 }], map: [26, 1] },
    { trainers: [{ x: 2, y: 28, sprite: 39 }],
      takeables: [{ x: 8, y: 35, what: 'ball' }],
      huntable: 2, wilds: { low: 4, high: 5 } }).offered;
  t.true(order.indexOf('duel') > order.indexOf('grind'), 'below Grind');
  t.true(order.indexOf('duel') < order.indexOf('take'), 'and above Take');
});

test('a fainted party with a trainer in front of it is told what is in the way',
     async (t) => {
  // Worth a line because the fix is a job that *is* on the list: Heal is
  // offered by the same fainted party, and without the sentence the two read as
  // unrelated.
  const list = offers({ party: [{ hp: 0, maxHp: 20 }] },
                      { trainers: [{ x: 2, y: 28, sprite: 39 }] });
  t.contains(list.hint, 'somebody fit to send out', 'said plainly');
  t.false(list.offered.includes('duel'), 'and the duel is not offered');
});


// --- what the game itself is saying -----------------------------------------

test("the game's own line is the bottom of its screen", async (t) => {
  // Where Gen 2 puts its text box: the menu rows sit above it, and when there
  // is no text the bottom of a menu is the next most useful thing.
  const said = describeSaying([
    ' SENTRET', '       3', '   CYNDAQUIL', '       5', '    20/ 20',
    ' >FIGHT', '  PACK  RUN',
  ]);
  t.eq(said.text, '>FIGHT PACK RUN', 'the two lines a person is choosing from');
  t.false(said.hidden, 'and it is shown');
});

test('an empty screen says nothing, and is hidden rather than blank',
     async (t) => {
  // Which is most of the time a walk is running: an overworld has an empty
  // tilemap. A bar element that is present-but-empty pushes the line it shares.
  const said = describeSaying([]);
  t.eq(said.text, '', 'nothing to say');
  t.true(said.hidden, 'so nothing is shown');
  t.true(describeSaying(null).hidden, 'and a screen that cannot be read is the same');
});

test('a long line is cut rather than allowed to push the bar', async (t) => {
  const said = describeSaying([' CHRIS turned on the PC and looked at every item']);
  t.true(said.text.length <= 46, `it fits: ${said.text.length}`);
  t.contains(said.text, '…', 'and says that it was cut');
});

test('the screen is twenty columns of padding, and it collapses', async (t) => {
  const said = describeSaying(['  Give  a nickname  to  ', '  the CYNDAQUIL  ']);
  t.eq(said.text, 'Give a nickname to the CYNDAQUIL', 'one space between words');
});

test('a gap wide enough to be a column stays one', async (t) => {
  // Measured on the START menu: one tilemap row carries "Save your" on the left
  // and "EXIT" on the right, and collapsing the gap between them reads as one
  // sentence that says neither.
  const said = describeSaying(['Save your          EXIT', 'progress']);
  t.contains(said.text, 'Save your · EXIT', 'the columns stay apart');
});

// --- catching with a full party ---------------------------------------------

test('a full party is only a refusal where the box cannot be read', async (t) => {
  // Gen 2 sends a caught Pokemon to the box -- measured with six carried -- so
  // the row offers it. It is a refusal only on a cartridge whose title has not
  // said what that message looks like, because with nothing to read a boxed
  // catch and a getaway are the same thing.
  const full = { party: Array.from({ length: 6 }, () => ({ hp: 20, maxHp: 20 })),
                 battleMode: 1, enemy: { species: PIDGEY } };
  const cannot = look(full, { ballId: POKE_BALL, canBox: false });
  t.contains(cannot.here.text, 'the party is full', 'it says so');
  t.false(cannot.here.enabled, 'and will not run');

  const can = look(full, { ballId: POKE_BALL, canBox: true });
  t.false(can.here.text.includes('full'), 'no longer the thing in the way');
  t.true(can.here.enabled, 'and it can run');
});

test('room in the party needs no phrase at all', async (t) => {
  const one = { party: [{ hp: 20, maxHp: 20 }], battleMode: 1,
                enemy: { species: PIDGEY } };
  t.true(look(one, { ballId: POKE_BALL, canBox: false }).here.enabled,
         'five slots free, nothing to read');
});

// --- running the list -------------------------------------------------------
//
// The runner has no ranking of its own: it takes the front of the list the
// screen is showing. So what is worth testing is exactly the four things it
// adds -- which rows it will never take on its own, that it refuses a row
// still waiting on a choice, that it stops rather than repeating a job that
// changed nothing, and that it never chooses itself.

const autoFor = (world, ctx = {}, opts = {}) => {
  const s = state.read(worldRam(sym, world));
  const c = { rom, ...ctx };
  return describeAuto(describeOffers(s, c), describeRows(s, c), opts);
};

test('the runner takes the front of the list, and says which row that is',
     async (t) => {
  // Grind, and not Heal: a party that is *hurt* does not put Heal first --
  // only a fainted one does, and the ranking says so two hundred lines above.
  // Worth writing the test around, because it is the whole claim: the runner
  // has no ranking of its own and takes whatever the screen is showing.
  // Balls in the bag, so the *ball* errand is not the front of the list --
  // these tests are about the runner's choosing, not about being unstuck.
  const world = { party: [{ species: CYNDAQUIL, level: 5, hp: 8, maxHp: 20 }],
                  items: [[POKE_BALL, 5]] };
  const ctx = { bagHeal: 'POTION', ballId: POKE_BALL };
  const list = offers(world, ctx);
  const rows = look(world, ctx);
  const a = autoFor(world, ctx);
  // The front of the list *among the rows it could press*. Not simply
  // `offered[0]`: with no Poké Balls the row wearing the accent is Catch,
  // whose own button is greyed and whose action is the ball errand beside it.
  // A runner that pressed a disabled button would be doing something a person
  // cannot, and the row says which one it starts with so the difference is on
  // screen rather than a surprise.
  const pressable = list.offered.filter(
    (k) => rows[k].enabled && !rows[k].needs && !['travel', 'hunt'].includes(k));
  t.eq(a.key, pressable[0], 'the front of what it can press');
  t.eq(a.key, 'grind', 'which here is Grind, hurt party and all');
  t.contains(a.text, 'Grind', 'named on the row before it is pressed');
  t.true(a.enabled, 'and it can be pressed');
});

test('a place is a choice, so Travel is never taken on its own', async (t) => {
  // Travel alone on the list: a party at full health with nowhere else to be.
  // The row is offered to a person and refused to the runner, which is the
  // one asymmetry in here.
  const world = { party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }] };
  const ctx = { places: [{ key: '3.1', name: 'ROUTE 30', legs: 1 }] };
  const list = offers(world, ctx);
  t.true(list.offered.includes('travel'), 'a person is offered it');
  const a = autoFor(world, ctx);
  t.ne(a.key, 'travel', 'the runner is not');
});

test('Hunt is never taken on its own, because it ends inside a battle',
     async (t) => {
  // A remembered species clears `needs`, so this is not the picker rule doing
  // the work -- it is the rule about where a step is allowed to finish.
  const world = { party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }],
                  map: [3, 1] };
  const ctx = { huntWanted: 'PIDGEY', huntable: 2,
                wilds: { low: 2, high: 3 } };
  const a = autoFor(world, ctx);
  t.ne(a.key, 'hunt', 'not on its own');
});

test('a row still waiting on a choice is not taken either', async (t) => {
  // Catch with balls and no species picked keeps its place on the list -- that
  // ranking rule is load-bearing and tested above -- and carries `needs`. The
  // runner cannot fill a slot, so it must not press the row that has one.
  const world = { party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }],
                  items: [[POKE_BALL, 5]], map: [3, 1] };
  const ctx = { ballId: POKE_BALL, huntable: 2,
                wilds: { low: 2, high: 3 } };
  const list = offers(world, ctx);
  t.true(list.offered.includes('catch'), 'the row is on the list');
  const a = autoFor(world, ctx);
  t.ne(a.key, 'catch', 'and the runner leaves it alone');
});

test('a job that ran and changed nothing stops the sequence', async (t) => {
  // The loop that must end. `changed` is the caller's evidence -- a signature
  // of the map, the money, the badges, the party and the bag -- and a job that
  // reports success while all of that stands still did nothing, whatever it
  // said.
  const world = { party: [{ species: CYNDAQUIL, level: 5, hp: 8, maxHp: 20 }],
                  items: [[POKE_BALL, 5]] };
  const ctx = { bagHeal: 'POTION', ballId: POKE_BALL };
  const again = autoFor(world, ctx, { last: 'grind', changed: true });
  t.eq(again.key, 'grind', 'the same job twice is fine while something moves');
  const stuck = autoFor(world, ctx, { last: 'grind', changed: false });
  t.eq(stuck.key, null, 'and not once it stops moving');
  t.contains(stuck.text, 'changed nothing', 'with the reason it stopped');
});

test('an empty list stops it rather than picking something', async (t) => {
  // No party at all, which is the only state where the list is truly empty --
  // every job here is a walk or a fight and both want somebody along.
  const a = autoFor({});
  t.eq(a.key, null, 'nothing to start');
  t.false(a.enabled, 'so the row is not drawn');
  t.contains(a.text, 'on its own', 'and says what kind of nothing');
});

test('the runner is never one of the jobs it can choose', async (t) => {
  // It presses a row's button. Its own row is not in that table, and the day
  // it is, one press would recurse.
  const world = { party: [{ species: CYNDAQUIL, level: 5, hp: 8, maxHp: 20 }] };
  const a = autoFor(world, { bagHeal: 'POTION' });
  t.ne(a.key, 'auto', 'not itself');
  t.true(['heal', 'grind', 'duel', 'gym', 'take', 'shop', 'catch',
          'errand'].includes(a.key),
         'always one of the jobs with a button');
});

test('shopping is not offered with an empty party', async (t) => {
  // Found by the runner: with no party, in the bedroom of a new game, Shop was
  // the front of the list and it pressed it. Every mart is in another town, and
  // the town the game starts you in is the one it will not let you leave
  // without a Pokémon -- so the whole job is a walk into a roadblock.
  const ctx = { marts: [{ key: '3.2', name: 'CHERRYGROVE CITY', legs: 2 }],
                shopFor: '5 more potion' };
  const empty = look({}, ctx);
  t.false(empty.shop.enabled, 'nothing to send to the counter');
  t.contains(empty.shop.text, 'without a Pok', 'and it says which');
  const held = look({ party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }] },
                    ctx);
  t.true(held.shop.enabled, 'and with one along it is on again');
  t.contains(held.shop.text, '5 more potion', 'saying what it would buy');
});

// --- the gaps the mutation tool found ---------------------------------------
//
// Every test below was written because `tools/mutate` moved a number or an
// operator in rows.js and the suite went on passing. A surviving mutation is
// not automatically a defect -- three of the ones in this file are genuinely
// unobservable -- but each of these is a rule the app relies on with nothing
// asserting it.

test('a device already in a room is not offered a code box', async (t) => {
  // `joining` gates two controls now: the Join button on the Devices row and
  // the code row indented under it. A `joining: true` in any of these three
  // states would put a text box asking for a code under a row saying it is
  // already sharing.
  t.false(describeRoom({ status: 'connecting', code: 'K7M2P' }).joining,
          'mid-connect');
  t.false(describeRoom({ status: 'synced', code: 'K7M2P' }).joining,
          'connected');
  t.false(describeRoom({ status: 'offline', code: 'K7M2P' }).joining,
          'connected and offline');
  t.false(describeRoom({ status: 'unavailable' }).joining,
          'and not where sharing cannot work at all');
  t.true(describeRoom({ status: 'local' }).joining,
         'only where there is a room to join');
});

test('a profile with names but no healers is still worth a sentence',
     async (t) => {
  // Three conditions, and the middle one is the interesting case: somebody's
  // half-finished title file. It names maps, so the header reads properly and
  // the app looks complete -- and then Heal has nowhere to go. Worth saying
  // differently from "no profile at all", because it is a file to go and
  // finish rather than a cartridge nobody has described.
  const full = describeTitle({ names: { '3.1': 'ROUTE 30' }, healers: [{}],
                               drive: class { async run() {} } });
  t.false(full.show, 'a cartridge the pilot knows says nothing');
  const noHealers = describeTitle({ names: { '3.1': 'ROUTE 30' }, healers: [],
                                    drive: class { async run() {} } });
  t.true(noHealers.show, 'one with nowhere to heal does');
  const noNames = describeTitle({ names: {}, healers: [{}] });
  t.true(noNames.show, 'and so does one with no names');
  t.ne(noHealers.text, noNames.text, 'and the two do not say the same thing');
});

test('the offer hint says two things at most', async (t) => {
  // A third clause is a paragraph, and this is a line. Nothing asserted the
  // cap, so a fourth hint added one day would have quietly made it one.
  const world = { battleMode: 1, party: [], map: [3, 1],
                  enemy: { species: PIDGEY, level: 3, hp: 15, maxHp: 15 } };
  const list = offers(world, { trainers: [{ x: 1, y: 1, sprite: 39 }],
                               trainersOnMap: 3 });
  t.true(list.hint.split(' · ').length <= 2, 'at most two clauses');
});

test('a trainer on the map with nobody fit is said, and only then', async (t) => {
  // The fix is a job that *is* on the list -- Heal, put first by the same
  // fainted party -- and without the sentence the two offers read as
  // unrelated.
  const down = { party: [{ species: CYNDAQUIL, level: 5, hp: 0, maxHp: 20 }] };
  const withTrainers = offers(down, { trainers: [{ x: 2, y: 2, sprite: 39 }],
                                      trainersOnMap: 1 });
  t.contains(withTrainers.hint, 'somebody fit', 'said where it is in the way');
  const fit = { party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }] };
  const ok = offers(fit, { trainers: [{ x: 2, y: 2, sprite: 39 }],
                           trainersOnMap: 1 });
  t.false(ok.hint.includes('somebody fit'), 'and not where it is not');
});

test('Travel earns its place on the list from having somewhere to go',
     async (t) => {
  // The row is drawn while it waits for a place to be picked -- which is the
  // rule that makes the picker reachable at all -- and not drawn where the
  // cartridge has named nowhere.
  const world = { party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }] };
  const somewhere = offers(world,
    { places: [{ key: '3.1', name: 'ROUTE 30', legs: 1 }] });
  t.true(somewhere.offered.includes('travel'), 'a named place puts it on');
  const nowhere = offers(world, { places: [] });
  t.false(nowhere.offered.includes('travel'), 'and none takes it off');
});

test('a replaced save with nothing in it offers nothing', async (t) => {
  const none = describeReplaced(null);
  t.false(none.show, 'no row');
  t.false(none.enabled, 'and nothing to press');
});

test('a line exactly as long as the limit is not truncated', async (t) => {
  // The boundary, which nothing asserted: `>` and `>=` behaved identically for
  // every length the other tests use. One character either side of the limit is
  // where an off-by-one in a truncation lives.
  const max = 20;
  const exact = 'x'.repeat(max);
  t.eq(describeSaying([exact], { max }).text, exact, 'exactly the limit stands');
  const over = 'x'.repeat(max + 1);
  t.ne(describeSaying([over], { max }).text, over, 'one more is cut');
  t.contains(describeSaying([over], { max }).text, '…', 'and says so');
});

test('a road the game is keeping shut says what opens it', async (t) => {
  // Otherwise a gated destination is written off after one failed walk and then
  // simply stops being offered: Travel loses a place, says nothing, and the
  // person is left to work out that the app is not broken.
  const world = { party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }] };
  const list = offers(world,
    { gated: [{ where: 'ROUTE 32', needs: 'the Egg from Elm’s aide' }] });
  t.contains(list.hint, 'ROUTE 32', 'which road');
  t.contains(list.hint, 'Egg', 'and what it wants');
  const quiet = offers(world, { gated: [] });
  t.false(quiet.hint.includes('wants'), 'and nothing where no gate is in the way');
});

test('an errand is offered where a gated road has something to do about it',
     async (t) => {
  // The hint says what a road wants; this row goes and gets it. Ranked above
  // Gym, because a gate is worth more than levelling up -- everything else on
  // the list is reachable afterwards and the road is not reachable without it.
  const world = { party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }] };
  const gated = [{ where: 'ROUTE 32', needs: 'the Egg from Elm’s aide',
                   errand: 'talkToOpen' }];
  const rows = look(world, { gated });
  t.true(rows.errand.enabled, 'on offer');
  t.contains(rows.errand.text, 'Egg', 'saying what it would fetch');
  const list = offers(world, { gated });
  t.true(list.offered.includes('errand'), 'and on the list');
  t.true(list.rank.errand < (list.rank.gym ?? 99), 'above Gym');
  // And above Grind, which is the half the first draft got wrong: the comment
  // said "worth more than levelling up" while the order said otherwise. An
  // errand is finite and a precondition; grinding is infinite and can wait.
  t.true(list.rank.errand < (list.rank.grind ?? 99), 'and above Grind');
});

test('a gate with no errand is a hint and not a row', async (t) => {
  // A road the pilot cannot open is worth saying and not worth a button. This
  // is the same rule the whole list runs on: nothing is drawn that cannot be
  // done.
  // Balls in the bag, so the *only* candidate errand is the gate's -- and it
  // has none, which is the case under test.
  const world = { party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }],
                  items: [[POKE_BALL, 5]] };
  const gated = [{ where: 'ROUTE 32', needs: 'a badge', errand: null }];
  const rows = look(world, { gated, ballId: POKE_BALL });
  t.false(rows.errand.enabled, 'no offer');
  t.contains(rows.errand.text, 'nothing to fetch', 'and it says why');
  const list = offers(world, { gated, ballId: POKE_BALL });
  t.false(list.offered.includes('errand'), 'not on the list');
  t.contains(list.hint, 'ROUTE 32', 'but still hinted');
});

test('the whole ranking, in one assertion', async (t) => {
  // **The ordering is load-bearing now.** It decides which row wears the rail,
  // and since v167 it decides what "Run the list" presses -- so a reorder is a
  // behaviour change and not a presentation one. Twice it has been tuned by
  // editing a list and a comment beside it, and the second time the two
  // disagreed: the comment said an errand outranks levelling up while the list
  // put it below Grind. Nothing failed, because every test asserted one pair at
  // a time.
  //
  // This asserts all of it. A situation with everything on offer at once, and
  // the exact order it comes out in -- so any future reorder has to be
  // deliberate enough to edit this line.
  const world = {
    party: [{ species: CYNDAQUIL, level: 5, hp: 8, maxHp: 20 }],
    items: [[POKE_BALL, 5]], map: [3, 1],
  };
  const list = offers(world, {
    ballId: POKE_BALL, huntWanted: 'PIDGEY', huntable: 2,
    wilds: { low: 2, high: 3 },
    gated: [{ where: 'ROUTE 32', needs: 'an Egg', errand: 'talkToOpen' }],
    gym: { at: 'Violet City', leader: 'FALKNER', legs: 1 },
    trainers: [{ x: 2, y: 2, sprite: 39 }], trainersOnMap: 1,
    takeables: [{ x: 4, y: 4 }],
    places: [{ key: '3.2', name: 'ROUTE 31', legs: 1 }], travelTo: '3.2',
    marts: [{ key: '3.9', name: 'CHERRYGROVE CITY', legs: 2 }],
    shopFor: '5 more potion',
    bagHeal: 'POTION',
  });
  t.eq(list.offered,
       ['catch', 'hunt', 'errand', 'grind', 'duel', 'gym', 'heal', 'take',
        'travel', 'shop'],
       'every offer, in the order the app ranks them');
});

test('a fainted party puts Heal first, whatever else is on offer', async (t) => {
  // The one override in the ordering, and the reason for it: nothing else on
  // the list can be done at all by a party that cannot fight.
  const world = {
    party: [{ species: CYNDAQUIL, level: 5, hp: 0, maxHp: 20 }],
    map: [3, 1],
  };
  const list = offers(world, {
    healPlace: "Elm's lab",
    gated: [{ where: 'ROUTE 32', needs: 'an Egg', errand: 'talkToOpen' }],
    takeables: [{ x: 4, y: 4 }],
  });
  t.eq(list.offered[0], 'heal', `heal leads: ${list.offered.join(',')}`);
});

test('no row ever says "undefined" or "[object Object]"', async (t) => {
  // **The guard for a fixture that has drifted from the app.** Seven fixtures
  // in this file passed `bagHeal` as an item object and `wilds` as a list,
  // where `main.js` passes a *name* and a `{low, high}` pair -- and nothing
  // noticed, because every test asserted `enabled` or a key and none asserted
  // the text those fields feed. `tools/rank` printed "1 hurt · [object Object]
  // in the bag" the first time it was run.
  //
  // Which is the same trap as a fake laid out more conveniently than the thing
  // it stands for: the fixture was wrong, the tests passed, and the row on a
  // real phone would have read the same nonsense if the app had ever been
  // handed that shape.
  //
  // So this asserts the one thing that is true of every row in every
  // situation, whatever the fields are: a row says words. A future ctx field
  // read with the wrong shape lands here rather than on somebody's screen.
  const situations = [
    ['nothing', {}, {}],
    ['a party', { party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }] }, {}],
    ['hurt, with a potion',
     { party: [{ species: CYNDAQUIL, level: 5, hp: 8, maxHp: 20 }] },
     { bagHeal: 'POTION', healPlace: "Elm's lab" }],
    ['fainted', { party: [{ species: CYNDAQUIL, level: 5, hp: 0, maxHp: 20 }] },
     { healPlace: "Elm's lab" }],
    ['grass here', { party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }], map: [3, 1] },
     { wilds: { low: 2, high: 3 }, huntable: 2, huntWanted: 'PIDGEY',
       ballId: POKE_BALL }],
    ['a gate', { party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }] },
     { gated: [{ where: 'ROUTE 32', needs: 'an Egg', errand: 'talkToOpen' }] }],
    ['a gym', { party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }] },
     { gym: { at: 'Violet City', leader: 'FALKNER', legs: 1 } }],
    ['a mart', { party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }] },
     { marts: [{ key: '3.9', name: 'CHERRYGROVE CITY', legs: 2 }],
       shopFor: '5 more potion' }],
    ['somewhere to go', { party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }] },
     { places: [{ key: '3.2', name: 'ROUTE 31', legs: 1 }], travelTo: '3.2' }],
    ['a trainer', { party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }] },
     { trainers: [{ x: 2, y: 2, sprite: 39 }], trainersOnMap: 1 }],
    ['something on the ground', { party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }] },
     { takeables: [{ x: 4, y: 4 }] }],
    ['a battle', { battleMode: 1, party: [{ hp: 20, maxHp: 20 }],
                   enemy: { species: PIDGEY, level: 3, hp: 15, maxHp: 15 } }, {}],
  ];
  for (const [what, world, ctx] of situations) {
    const rows = look(world, ctx);
    const list = offers(world, ctx);
    for (const [key, row] of Object.entries(rows)) {
      const text = String(row && row.text !== undefined ? row.text : '');
      t.false(text.includes('undefined'), `${what}: ${key} says "${text}"`);
      t.false(text.includes('[object'), `${what}: ${key} says "${text}"`);
      t.false(text.includes('NaN'), `${what}: ${key} says "${text}"`);
    }
    t.false(String(list.hint).includes('undefined'),
            `${what}: the hint says "${list.hint}"`);
    t.false(String(list.hint).includes('[object'),
            `${what}: the hint says "${list.hint}"`);
  }
});

test('the runner can now fetch the first balls, which it never could',
     async (t) => {
  // **The defect this arrangement exists for.** The runner presses a row's own
  // button; the ball errand was a *second* button on the Catch row; Catch is
  // not enabled without balls. So "Run the list" in a fresh game reached the
  // one state it could not get out of, and stopped one step before the thing
  // that would have unstuck it.
  const world = { party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }],
                  map: [3, 1] };
  const ctx = { huntWanted: 'PIDGEY', huntable: 2, wilds: { low: 2, high: 3 } };
  const s = state.read(worldRam(sym, world));
  const c = { rom, ...ctx };
  const pick = describeAuto(describeOffers(s, c), describeRows(s, c));
  t.eq(pick.key, 'errand', `the runner takes it: ${pick.text}`);
  t.contains(pick.text, 'Errand', 'and names it');
});

test('an errand needs somebody along, like every other walk', async (t) => {
  // The state Shop was caught offering itself in, found the same way -- by a
  // mechanism with no judgement pressing the front of the list. The game will
  // not let anybody leave the first town without a Pokémon, so a trip to
  // another one is not a thing that can be done.
  const empty = look({}, {});
  t.false(empty.errand.enabled, 'nothing to fetch with nobody to fetch it');
  t.contains(empty.errand.text, 'without a Pok', 'and it says which');
  t.false(offers({}, {}).offered.includes('errand'), 'so it is not drawn');
});

// --- what is behind the Gym door, before the walk -------------------------
//
// The row can say where the Gym is and who is in it. Whether it is worth
// going is two facts the cartridge has had all along: the levels waiting in
// there, and whether anything you carry can take HP off them.

const BUG = 0x07, GHOST = 0x08, FIRE = 0x14, NORMAL = 0x00, POISON = 0x03;
const SCYTHER = 123, METAPOD = 11, GASTLY = 92, RATTATA = 19;
/** A rom that knows one leader and what their Pokémon are. */
const withLeader = (party, types) => fakeRom({
  species: { 155: 'CYNDAQUIL', 19: 'RATTATA', 123: 'SCYTHER',
             11: 'METAPOD', 92: 'GASTLY' },
  types,
  trainers: { BUGSY: { name: 'BUGSY', group: 3, party },
              MORTY: { name: 'MORTY', group: 4, party } },
});
const GYM = { at: 'Azalea Town', leader: 'BUGSY', legs: 2 };

test('the Gym hint says the level you are walking into', async (t) => {
  const r = describeOffers(state.read(worldRam(sym, {
    party: [{ species: CYNDAQUIL, level: 9, hp: 20, maxHp: 20,
              moves: [52, 0, 0, 0], pp: [25, 0, 0, 0] }],
    map: [3, 1],
  })), {
    rom: withLeader([{ level: 14, species: METAPOD }, { level: 16, species: SCYTHER }],
                    { [METAPOD]: [BUG, BUG], [SCYTHER]: [BUG, 0x02] }),
    gym: GYM,
  });
  t.contains(r.hint, 'BUGSY tops out at Lv16', `said it: ${r.hint}`);
  t.contains(r.hint, 'your best is Lv9', 'and what you have against it');
});

test('and says nothing when you are ahead and can hurt everything',
     async (t) => {
  // The good state. A line explaining that a job would work is the noise this
  // whole list exists to replace.
  const r = describeOffers(state.read(worldRam(sym, {
    party: [{ species: CYNDAQUIL, level: 20, hp: 20, maxHp: 20,
              moves: [52, 0, 0, 0], pp: [25, 0, 0, 0] }],
    map: [3, 1],
  })), {
    rom: withLeader([{ level: 14, species: METAPOD }],
                    { [METAPOD]: [BUG, BUG] }),
    gym: GYM,
  });
  t.false(r.hint.includes('tops out'), `quiet: ${r.hint}`);
  t.false(r.hint.includes('touch'), 'and nothing about touching');
});

test('a room nothing you carry can touch gets its own sentence', async (t) => {
  // A Normal-only Pokémon against a gym of Ghosts. Level is not the problem
  // and another level will not fix it, so the level sentence would be the
  // wrong advice as well as the less useful one.
  const r = describeOffers(state.read(worldRam(sym, {
    party: [{ species: RATTATA, level: 30, hp: 20, maxHp: 20,
              moves: [33, 0, 0, 0], pp: [35, 0, 0, 0] }],
    map: [3, 1],
  })), {
    rom: withLeader([{ level: 21, species: GASTLY }],
                    { [GASTLY]: [GHOST, POISON] }),
    gym: { ...GYM, leader: 'MORTY' },
  });
  t.contains(r.hint, 'nothing you carry can touch anything MORTY has',
             `said it: ${r.hint}`);
  t.false(r.hint.includes('tops out'), 'and not the level, which is not it');
});

test('one of theirs that nothing can touch is named', async (t) => {
  const r = describeOffers(state.read(worldRam(sym, {
    party: [{ species: RATTATA, level: 30, hp: 20, maxHp: 20,
              moves: [33, 0, 0, 0], pp: [35, 0, 0, 0] }],
    map: [3, 1],
  })), {
    rom: withLeader([{ level: 14, species: METAPOD }, { level: 21, species: GASTLY }],
                    { [METAPOD]: [BUG, BUG], [GASTLY]: [GHOST, POISON] }),
    gym: GYM,
  });
  t.contains(r.hint, 'nothing you carry can touch GASTLY Lv21',
             `named it: ${r.hint}`);
});

test('a cartridge that cannot say what is in there says nothing', async (t) => {
  // `fakeRom()`'s default has no trainer table, which is the same as a symbol
  // file that does not name one — and an absent warning is the honest answer.
  const r = offers({ party: [{ species: CYNDAQUIL, level: 5, hp: 8, maxHp: 20 }],
                     map: [3, 1] }, { gym: GYM });
  t.false(r.hint.includes('tops out'), `quiet: ${r.hint}`);
  t.true(r.rank.gym > 0 || r.offered.length >= 0, 'and the row is unaffected');
});

// --- the dex card -----------------------------------------------------------

// One particular Cyndaquil, as `monDetail` hands it over -- the species is
// what the ROM knows and this is what the save holds about *this* one.
const MY_CYNDAQUIL = {
  species: 155, level: 13, slot: 0, hp: 35, maxHp: 37,
  moves: [33, 43, 108, 52], pp: [35, 30, 20, 25],
  stats: { hp: 37, atk: 22, def: 18, spd: 25, satk: 23, sdef: 19 },
  statExp: { hp: 1200, atk: 900, def: 400, spd: 1600, spc: 100 },
  dvs: { atk: 10, def: 7, spd: 3, spc: 12, hp: 2 },
  happiness: 70, item: 0, caught: null,
};

const DEX_ROM = () => fakeRom({
  species: { 155: 'CYNDAQUIL', 156: 'QUILAVA', 197: 'UMBREON', 134: 'VAPOREON',
             186: 'POLITOED', 106: 'HITMONLEE' },
  items: { 24: 'WATER STONE', 82: "KING'S ROCK" },
  moves: { 108: { id: 108, name: 'SMOKESCREEN', power: 0, effect: 0, pp: 20, type: 0 },
           98: { id: 98, name: 'QUICK ATTACK', power: 40, effect: 0, pp: 30, type: 0 } },
  typeNames: { 0x14: 'FIRE', 0x16: 'GRASS' },
  landmarks: { 2: 'NEW BARK TOWN' },
  base: { 155: { id: 155, types: [0x14, 0x14],
                 stats: { hp: 39, atk: 52, def: 43, spd: 65, satk: 60, sdef: 50 },
                 growth: 'mediumSlow' } },
  evos: { 155: { evolves: [{ kind: 'level', into: 156, level: 14 }],
                 learns: [{ level: 1, move: 33 }, { level: 12, move: 52 },
                          { level: 19, move: 98 }, { level: 36, move: 43 }] } },
});

test('a dex card says what is coming, not just what is', async (t) => {
  const d = describeDex(MY_CYNDAQUIL, { rom: DEX_ROM(), engine: gen2 });
  t.eq(d.name, 'CYNDAQUIL', 'who it is');
  t.contains(d.next, 'QUICK ATTACK at Lv19',
             'the next move it learns, which is the grinding question');
  t.contains(d.next, '6 levels away', 'and how far off that is');
  t.eq(d.becomes, ['QUILAVA at Lv14 — 1 level away'],
       'and the same for what it turns into');
});

test('a single-typed Pokemon is not called FIRE / FIRE', async (t) => {
  // Gen 2 stores a single type in both slots, the same storage detail that
  // made `effectiveness` square its multipliers. A card that showed the
  // storage would read "FIRE / FIRE" for two thirds of the game.
  const d = describeDex(MY_CYNDAQUIL, { rom: DEX_ROM(), engine: gen2 });
  t.eq(d.types, ['FIRE'], 'one type, said once');
});

test('the two special stats show the same DV and the same counter', async (t) => {
  // Not a bug being rendered. Gen 2 rolls one Special DV and grows one Special
  // stat experience, and spends both on two stats -- so a card showing six
  // independent pairs would be showing two numbers twice and implying they can
  // differ.
  const d = describeDex(MY_CYNDAQUIL, { rom: DEX_ROM(), engine: gen2 });
  const by = Object.fromEntries(d.stats.map((s) => [s.key, s]));
  t.eq(by.satk.dv, by.sdef.dv, 'one nibble behind both');
  t.eq(by.satk.effort, by.sdef.effort, 'and one counter');
  t.eq(by.satk.dv, 12, 'which is the special nibble, not the attack one');
  t.eq(by.hp.dv, 2, 'and HP gets the derived one');
  t.eq(d.stats.length, 6, 'six rows even so, because six is what the game has');
});

test('the effort bar is drawn from the reachable ceiling, not the counter',
     async (t) => {
  // The counter runs to 65535 and what reaches the stat is its square root, so
  // a bar drawn from the raw number is nearly empty for a Pokemon that is
  // nearly done. 65025 is 255 squared, past which the root stops moving.
  const d = describeDex(MY_CYNDAQUIL, { rom: DEX_ROM(), engine: gen2 });
  const spd = d.stats.find((s) => s.key === 'spd');
  t.eq(spd.effort, 1600, 'the counter as the cartridge holds it');
  t.true(spd.effortPart > 0 && spd.effortPart < 0.1, 'and a fraction of the ceiling');
  const full = describeDex({ ...MY_CYNDAQUIL, statExp: { spd: 70000 } },
                           { rom: DEX_ROM(), engine: gen2 });
  t.eq(full.stats.find((s) => s.key === 'spd').effortPart, 1,
       'a counter past the useful ceiling is full, not over');
});

test('the four conditions with nothing to count down say so instead',
     async (t) => {
  // Only a level evolution has a distance. Inventing one for a stone or a
  // trade would be tidy and wrong.
  const rom = fakeRom({
    species: { 133: 'EEVEE', 134: 'VAPOREON', 197: 'UMBREON', 186: 'POLITOED' },
    items: { 24: 'WATER STONE', 82: "KING'S ROCK" },
    evos: { 133: { evolves: [
      { kind: 'item', into: 134, item: 24 },
      { kind: 'happiness', into: 197, when: 'night' },
      { kind: 'trade', into: 186, item: 82 },
    ], learns: [] } },
  });
  const d = describeDex({ ...MY_CYNDAQUIL, species: 133 }, { rom, engine: gen2 });
  t.eq(d.becomes, ['VAPOREON with a WATER STONE',
                   'UMBREON with friendship, at night',
                   "POLITOED if traded holding a KING'S ROCK"],
       'each says what it needs and stops');
});

test('a cartridge that cannot say what it becomes says that once, not six times',
     async (t) => {
  const rom = fakeRom({ species: { 155: 'CYNDAQUIL' } });
  const d = describeDex(MY_CYNDAQUIL, { rom, engine: gen2 });
  t.eq(d.next, null, 'nothing claimed about the next move');
  t.eq(d.becomes, [], 'nor about evolutions');
  t.contains(d.shy, 'does not say', 'one line at the bottom, and the stats stay');
  t.eq(d.stats.length, 6, 'because the party entry still knows those');
});

test('where it was caught is left out rather than guessed at', async (t) => {
  const rom = DEX_ROM();
  t.eq(describeDex(MY_CYNDAQUIL, { rom, engine: gen2 }).origin, null,
       'a starter was never caught, and that is not a gap to fill');
  const d = describeDex(
    { ...MY_CYNDAQUIL, caught: { level: 5, when: 'night', place: 2 } },
    { rom, engine: gen2 });
  t.eq(d.origin, 'caught at Lv5 in NEW BARK TOWN at night',
       'and where the save does say, the landmark is named');
});

test('an evolution already due does not count down to itself', async (t) => {
  // A Pokemon standing at exactly its evolution level -- which happens, because
  // Gen 2 evolves *after* the battle that levelled it and a fainted or
  // cancelled evolution leaves it there. "QUILAVA at Lv14 — 0 levels away" is
  // arithmetic pretending to be information.
  const d = describeDex({ ...MY_CYNDAQUIL, level: 14 },
                        { rom: DEX_ROM(), engine: gen2 });
  t.eq(d.becomes, ['QUILAVA at Lv14'], 'the fact, and no countdown');
  const early = describeDex({ ...MY_CYNDAQUIL, level: 13 },
                            { rom: DEX_ROM(), engine: gen2 });
  t.contains(early.becomes[0], '1 level away', 'one below, and it counts');
});

test('a stat-branch evolution counts down too, and stops when it is due',
     async (t) => {
  const rom = fakeRom({
    species: { 236: 'TYROGUE', 106: 'HITMONLEE' },
    evos: { 236: { evolves: [{ kind: 'stat', into: 106, level: 20,
                               compare: 'atkOverDef' }], learns: [] } },
  });
  const soon = describeDex({ ...MY_CYNDAQUIL, species: 236, level: 18 },
                           { rom, engine: gen2 });
  t.eq(soon.becomes, ['HITMONLEE at Lv20 if attack beats defence — 2 levels away'],
       'the condition and the distance');
  const due = describeDex({ ...MY_CYNDAQUIL, species: 236, level: 20 },
                          { rom, engine: gen2 });
  t.eq(due.becomes, ['HITMONLEE at Lv20 if attack beats defence'],
       'and no countdown to a level it is already standing on');
});

test('a card with no cartridge behind it is a smaller card, not a crash',
     async (t) => {
  // Every one of the ROM tables is optional in `romdata.js`, and the interface
  // has to survive the whole lot being absent -- which is also the state
  // before a ROM is picked.
  const d = describeDex(MY_CYNDAQUIL, { engine: gen2 });
  t.eq(d.name, '#155', 'the id, because nothing can name it');
  t.eq(d.types, [], 'no types claimed');
  t.eq(d.knows, [], 'no move names');
  t.eq(d.becomes, [], 'and nothing about what it becomes');
  t.eq(d.stats.length, 6, 'but the six stats are the save\'s, not the ROM\'s');
  t.eq(d.stats[0].value, 37, 'and they are still right');
  // Including where it was caught, which reaches for a landmark name -- the
  // one line on this card that asks the ROM a question about a *number* the
  // save gave it, so it is the one that throws if the guard is wrong.
  const caught = describeDex(
    { ...MY_CYNDAQUIL, caught: { level: 5, when: 'night', place: 2 } },
    { engine: gen2 });
  t.eq(caught.origin, 'caught at Lv5 at night',
       'the level and the hour, and no place it cannot name');
});

test('a stat the engine names and the interface does not keeps its own key',
     async (t) => {
  // The labels are a table in the interface and the stat list is the engine's,
  // so a cartridge that added a stat would have one the labels do not cover.
  // Showing the key is worse than showing a word and better than showing
  // nothing where a row should be.
  const odd = { ...gen2, statNames: [...gen2.statNames, 'luck'],
                statSource: { ...gen2.statSource, luck: 'spc' } };
  const d = describeDex(MY_CYNDAQUIL, { rom: DEX_ROM(), engine: odd });
  t.eq(d.stats.length, 7, 'the row is drawn');
  t.eq(d.stats[6].label, 'luck', 'labelled with the key it could not translate');
});

test('a cartridge that can say what it becomes says nothing extra about it',
     async (t) => {
  // The other side of the "says so once" test: the line at the bottom has to
  // be absent, not empty, when there is nothing missing.
  const d = describeDex(MY_CYNDAQUIL, { rom: DEX_ROM(), engine: gen2 });
  t.eq(d.shy, null, 'no apology on a card that has everything');
});

test('the dex total is three numbers because two of them mean nothing alone',
     async (t) => {
  t.eq(describeDexTotals({ caught: [1, 2], seen: [1, 2, 3] }, { engine: gen2 }),
       '2 caught of 251 · 3 seen', 'the cartridge says how many there are');
  t.eq(describeDexTotals(null, { engine: gen2 }),
       'this cartridge does not keep a Pokédex',
       'and a cartridge that keeps none is not a cartridge with none caught');
});

// --- the hour worth waiting for ---------------------------------------------

const HOURS = [
  { species: ['PIDGEY', 'SENTRET'], levels: { low: 2, high: 4 } },
  { species: ['PIDGEY', 'SENTRET'], levels: { low: 2, high: 4 } },
  { species: ['HOOTHOOT', 'RATTATA', 'ZUBAT'], levels: { low: 2, high: 4 } },
];

test('the hour worth waiting for is the one holding what you asked for',
     async (t) => {
  // The strong case, and the one the app has been able to *describe* since it
  // learned the clock takes chips away: pick HOOTHOOT at night, come back at
  // noon, and the chip goes with a line saying where it went. This is that
  // line turned into something pressable.
  const got = waitOffer(HOURS, 1, 'HOOTHOOT');
  t.eq(got.block, 2, 'the block that has it');
  t.contains(got.text, 'HOOTHOOT', 'named, because it is the reason to wait');
  t.contains(got.text, 'night', 'and when, as a label rather than a phrase — '
             + '"after dark" clipped on a row with two buttons on it');
});

test('a quarry that is here now does not make the row about it', async (t) => {
  // Waiting for a species that is in the grass in front of you would be an
  // offer to do nothing. The *general* reason to wait survives -- the night
  // still brings three this hour does not -- so the row stays and stops
  // claiming to be about PIDGEY.
  const got = waitOffer(HOURS, 1, 'PIDGEY');
  t.eq(got.block, 2, 'still the hour that brings more');
  t.false(got.text.includes('PIDGEY'), 'and not a wait for something already here');
});

test('with nothing chosen it offers the hour that pays best', async (t) => {
  // Three species after dark against none in the morning, so the wait is worth
  // making and worth making *for the night*.
  const got = waitOffer(HOURS, 0);
  t.eq(got.block, 2, 'the block with the most this one does not have');
  t.contains(got.text, '3 more', 'counted rather than listed');
});

test('one extra species is named and two are counted', async (t) => {
  const one = [{ species: ['PIDGEY'] }, { species: ['PIDGEY'] },
               { species: ['PIDGEY', 'HOOTHOOT'] }];
  t.contains(waitOffer(one, 0).text, 'HOOTHOOT',
             'a single name is more use than the number one');
});

test('grass that is the same all day is nothing to wait for', async (t) => {
  const same = [{ species: ['PIDGEY'] }, { species: ['PIDGEY'] },
                { species: ['PIDGEY'] }];
  t.eq(waitOffer(same, 0), null, 'no offer, so no row');
  t.eq(waitOffer(null, 0), null, 'and a cartridge with no table says nothing');
});

test('a quarry the cartridge has nowhere falls back to the general offer',
     async (t) => {
  // Asked for something this map does not have at any hour. The remembered
  // choice is from another route; the offer here is still a real one.
  const got = waitOffer(HOURS, 1, 'MAGIKARP');
  t.eq(got.block, 2, 'the hour that brings the most');
  t.contains(got.text, 'more', 'and it does not claim MAGIKARP is coming');
});

test('the Wait row is offered only where the hour is hiding something',
     async (t) => {
  const party = { party: [{ species: CYNDAQUIL, level: 8, hp: 20, maxHp: 20 }] };
  const same = [{ species: ['PIDGEY'] }, { species: ['PIDGEY'] },
                { species: ['PIDGEY'] }];
  t.false(look(party, { hours: same, hourNow: 1 }).wait.enabled,
          'grass that is the same all day has nothing to wait for');
  const r = look(party, { hours: HOURS, hourNow: 1, quarry: 'HOOTHOOT' });
  t.true(r.wait.enabled, 'and here it has');
  t.eq(r.wait.waitFor, 2, 'the block, not the word — the job takes a number');
  t.contains(r.wait.text, 'HOOTHOOT', 'named after the reason to press it');
});

test('Wait ranks last, because every other job passes the time too', async (t) => {
  // The fact that makes the row make sense: a grind runs the same frames
  // standing still would and comes back with levels. So waiting is only ever
  // worth pressing when there is nothing else to do here.
  const o = offers({ party: [{ species: CYNDAQUIL, level: 8, hp: 20, maxHp: 20 }],
                     tile: 0x14 },
                   { hours: HOURS, hourNow: 1, quarry: 'HOOTHOOT', target: 10 });
  t.true(o.offered.includes('wait'), 'it is on the list');
  t.eq(o.offered[o.offered.length - 1], 'wait', 'and it is the end of it');
  t.gte(o.rank.wait, o.rank.grind, 'below anything that gets something done');
});

test('and the runner will take it, once there is nothing else', async (t) => {
  // Not excluded the way Travel and Hunt are: it needs no choice and it ends
  // in the overworld, which is the whole of that rule. Asked of a list with
  // only Wait on it, because the claim under test is membership of the
  // exclusion list rather than the ranking, which the test above holds.
  const only = describeAuto({ offered: ['wait'], rank: { wait: 1 } },
                            { wait: { enabled: true, text: 'HOOTHOOT after dark' } });
  t.true(only.enabled, 'it will start it');
  t.eq(only.key, 'wait', 'rather than declining the way it declines Travel');
  const never = describeAuto({ offered: ['travel'], rank: { travel: 1 } },
                             { travel: { enabled: true, text: 'somewhere' } });
  t.false(never.enabled, 'which is the comparison that makes that mean anything');
});

// The cartridge's day, as `hoursOf` answers it: morning 4-9, day 10-17, and a
// night that wraps midnight, which is the one that makes the arithmetic
// interesting.
const DAYPARTS = {
  0: { from: 4, to: 9, hours: 6 },
  1: { from: 10, to: 17, hours: 8 },
  2: { from: 18, to: 3, hours: 10 },
};
const CLOCKROM = fakeRom({ hours: DAYPARTS });

test('the shift lines the earliest hour of this block onto the target',
     async (t) => {
  // The app knows which block it is in and not which hour, so this is the only
  // shift it can compute — and it is exactly right whenever the target is at
  // least as wide as where you are standing.
  t.eq(shiftTo(CLOCKROM, 1, 2), 8, 'day starts at 10, night at 18');
  t.eq(shiftTo(CLOCKROM, 0, 1), 6, 'morning at 4 to day at 10');
  t.eq(shiftTo(CLOCKROM, 2, 0), 10, 'and night at 18 round to morning at 4');
});

test('the same block is no shift at all', async (t) => {
  t.eq(shiftTo(CLOCKROM, 2, 2), 0, 'zero, which the row reads as nothing to skip');
});

test('a cartridge that will not say which hours are which loses the skip only',
     async (t) => {
  t.eq(shiftTo(fakeRom({}), 1, 2), null, 'no table, no shift');
  t.eq(shiftTo(null, 1, 2), null, 'and no rom either');
  const r = describeRows(state.read(worldRam(sym, {
    party: [{ species: CYNDAQUIL, level: 8, hp: 20, maxHp: 20 }],
  })), { rom: fakeRom({}), hours: HOURS, hourNow: 1, quarry: 'HOOTHOOT' });
  t.true(r.wait.enabled, 'the wait is still offered');
  t.eq(r.wait.skip, null, 'and only the second button goes');
});

test('the row carries the hours to move, not a name', async (t) => {
  const r = describeRows(state.read(worldRam(sym, {
    party: [{ species: CYNDAQUIL, level: 8, hp: 20, maxHp: 20 }],
  })), { rom: CLOCKROM, hours: HOURS, hourNow: 1, quarry: 'HOOTHOOT' });
  t.eq(r.wait.waitFor, 2, 'the block to wait for');
  t.eq(r.wait.skip, 8, 'and the hours that would get there in one edit');
});

test('what a wait costs is a range, because the hour is not known', async (t) => {
  // From anywhere in the day, 10:00 to 17:59, the next night is between one
  // hour and eight away. Both ends are computed rather than one and a guess,
  // because they come out the opposite way round to how it reads: the *latest*
  // hour this block could be is the *shortest* wait.
  const cost = waitCost(CLOCKROM, 1, 2);
  t.eq(cost.least, 1, 'from 17:00, one hour to night');
  t.eq(cost.most, 8, 'from 10:00, eight');
  const back = waitCost(CLOCKROM, 2, 0);
  t.eq(back.least, 1, 'from 03:00, one hour to morning');
  t.eq(back.most, 10, 'and from 18:00, the whole night');
});

test('the time it would take is measured off this device, not assumed',
     async (t) => {
  // The game counts its own time one frame at a time whatever speed those
  // frames arrive at, so an hour is 216,000 of them on any machine — which is
  // why the answer differs between a laptop and a phone and has to be measured.
  const fast = waitCost(CLOCKROM, 1, 2, 2200);   // ~37x, a laptop
  const slow = waitCost(CLOCKROM, 1, 2, 900);    // ~15x, a phone
  t.eq(Math.round(fast.seconds), Math.round(8 * 216000 / 2200), 'eight hours of frames');
  t.true(slow.seconds > fast.seconds * 2, 'and the slower device takes longer');
  t.eq(waitCost(CLOCKROM, 1, 2, null).seconds, undefined,
       'with nothing measured it says the hours and no minutes');
  t.eq(waitCost(fakeRom({}), 1, 2, 2200), null,
       'and a cartridge that will not say when night starts says nothing');
});

test('a span is said at the precision it deserves', async (t) => {
  t.eq(saySpan(9), '9s', 'seconds while it is seconds');
  t.eq(saySpan(240), '4m', 'then minutes');
  t.eq(saySpan(4800), '80m', 'and minutes for as long as they read easily');
  t.eq(saySpan(6000), '1h 40m', 'then hours, with the minutes padded');
  t.eq(saySpan(93 * 60), '1h 33m', 'just past the threshold');
  t.eq(saySpan(121 * 60), '2h 01m', 'and the padding, which keeps them lining up');
  t.eq(saySpan(0), '', 'nothing at all for nothing');
  t.eq(saySpan(-5), '', 'and for a negative, which is a bug upstream');
});

test('the button carries the cost, and says nothing before there is one',
     async (t) => {
  const world = { party: [{ species: CYNDAQUIL, level: 8, hp: 20, maxHp: 20 }] };
  const ctx = { rom: CLOCKROM, hours: HOURS, hourNow: 1, quarry: 'HOOTHOOT' };
  const cold = describeRows(state.read(worldRam(sym, world)), ctx);
  t.eq(cold.cost, undefined, 'no cost on the row object itself');
  t.eq(cold.wait.cost, '', 'and none on the button until something has been timed');
  t.eq(cold.wait.hours, 8, 'though the game hours are known either way');
  const warm = describeRows(state.read(worldRam(sym, world)), { ...ctx, rate: 2200 });
  t.eq(warm.wait.cost, '13m', 'and with a rate, what it would cost you');
});

test('the line above the dex says which list is under it', async (t) => {
  // The two lists have nothing in common to count, so the line is what tells
  // them apart at a glance — "24 caught of 251" against "every species".
  t.eq(describeDexTotals({ caught: [1, 2], seen: [1, 2, 3] }, { engine: gen2 }),
       '2 caught of 251 · 3 seen', 'what this game has');
  t.eq(describeDexTotals(null, { engine: gen2, mode: 'all' }),
       'every species · 251 in this cartridge',
       'and what the cartridge has, which needs no save at all');
});

test('a game not loaded yet is a different answer from a cartridge that '
     + 'cannot say', async (t) => {
  // The flags are bits in work RAM and before a game is loaded they are
  // whatever the boot left there. Reading them would put a confident number on
  // a screen, which is the failure this repository keeps writing down.
  t.eq(describeDexTotals(null, { engine: gen2 }),
       'this cartridge does not keep a Pokédex', 'never able to say');
  t.eq(describeDexTotals({ caught: [], seen: [] }, { engine: gen2, started: false }),
       'start a game to see what you have caught', 'cannot say yet');
  t.eq(describeDexTotals({ caught: [], seen: [] }, { engine: gen2, started: false,
                                                     mode: 'all' }),
       'every species · 251 in this cartridge',
       'and All is unaffected, because that half is the ROM\'s');
});

test('a species entry carries the whole learnset, a carried one does not',
     async (t) => {
  // Two different questions. A Pokémon you have gets `knows` and `next`,
  // because those are the two facts somebody grinding acts on. A species has
  // neither — and the moves it gets, and when, are most of what a Pokédex is.
  const species = describeDex({ species: 155, level: 0, moves: [], pp: [] },
                              { rom: DEX_ROM(), engine: gen2 });
  t.eq(species.learns.map((m) => m.level), [1, 12, 19, 36],
       'every level-up move, in level order');
  t.eq(species.learns[0].name, 'TACKLE', 'named, not numbered');
  t.eq(species.knows, [], 'and nothing it "knows", because nothing carries it');
  const carried = describeDex(MY_CYNDAQUIL, { rom: DEX_ROM(), engine: gen2 });
  t.eq(carried.knows.length, 4, 'where a real one knows its four');
});

test('the list is sorted, because one cartridge entry is not', async (t) => {
  // MUK's entry genuinely runs Lv45 SLUDGE in front of Lv23 MINIMIZE on this
  // cartridge — the game scans the whole list and does not care. A card that
  // printed it in that order would read as a decoding bug.
  const rom = fakeRom({
    species: { 89: 'MUK' },
    moves: { 124: { id: 124, name: 'SLUDGE', power: 65, effect: 0, pp: 20, type: 3 },
             107: { id: 107, name: 'MINIMIZE', power: 0, effect: 0, pp: 20, type: 0 } },
    evos: { 89: { evolves: [], learns: [{ level: 45, move: 124 },
                                        { level: 23, move: 107 }] } },
  });
  const d = describeDex({ species: 89, level: 0, moves: [], pp: [] },
                        { rom, engine: gen2 });
  t.eq(d.learns.map((m) => m.level), [23, 45], 'climbing, whatever the ROM says');
});

// --- finding a species by typing --------------------------------------------

const DEXNAMES = { 1: 'BULBASAUR', 16: 'PIDGEY', 17: 'PIDGEOTTO', 18: 'PIDGEOT',
                   29: 'NIDORAN♀', 32: 'NIDORAN♂', 155: 'CYNDAQUIL',
                   160: 'FERALIGATR', 161: 'SENTRET' };
const IDS = Object.keys(DEXNAMES).map(Number).sort((a, b) => a - b);
const named = (id) => DEXNAMES[id];

test('an empty query is not a filter', async (t) => {
  t.eq(findSpecies(IDS, '', named), IDS, 'everything, unchanged');
  t.eq(findSpecies(IDS, null, named), IDS, 'and nothing typed at all');
});

test('letters are a name and digits are a number', async (t) => {
  // One box, and the query itself decides which question it is — which is how
  // a person uses a Pokédex either way round.
  t.eq(findSpecies(IDS, 'pid', named), [16, 17, 18], 'three of them by name');
  t.eq(findSpecies(IDS, '16', named), [16, 160, 161],
       'and by number, matching on the prefix');
});

test('a number matches by prefix so the list narrows as you type', async (t) => {
  // Exact matching would jump to one entry and back on the next keystroke,
  // which reads as the box losing what you typed.
  t.eq(findSpecies(IDS, '1', named), [1, 16, 17, 18, 155, 160, 161],
       'everything beginning with a one');
  t.eq(findSpecies(IDS, '15', named), [155], 'and it closes in');
});

test('case and the accent cost nothing, and the two NIDORAN still cost one',
     async (t) => {
  // `normalise` folds case and é and deliberately does not fold ♀ and ♂ —
  // folding those makes the two NIDORAN the same name again, which is the bug
  // the charmap work existed to fix. So `nidoran` finding both is the right
  // answer to an ambiguous question rather than a failure to tell them apart.
  t.eq(findSpecies(IDS, 'CYNDAQUIL', named), [155], 'shouted');
  t.eq(findSpecies(IDS, 'cyndaquil', named), [155], 'and muttered');
  t.eq(findSpecies(IDS, 'nidoran', named), [29, 32], 'both of them');
  t.eq(findSpecies(IDS, 'nidoran♀', named), [29], 'and one of them, asked for');
});

test('a species with no name is skipped rather than throwing', async (t) => {
  // Every table in this app answers "" for a name it cannot read, and the
  // filter is downstream of all of them.
  t.eq(findSpecies([1, 2], 'bulba', (id) => (id === 1 ? 'BULBASAUR' : null)),
       [1], 'the one that has a name');
});

test('a query that matches nothing matches nothing', async (t) => {
  t.eq(findSpecies(IDS, 'mewtwo', named), [], 'not in this list');
  t.eq(findSpecies(IDS, '999', named), [], 'nor is that number');
});
