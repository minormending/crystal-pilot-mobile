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
         describeUndo, describeSaying } from '../../app/rows.js';

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
  t.contains(r.heal.text, '1 hurt', 'counting only the hurt one');
  t.contains(r.heal.text, "Elm's computer", 'and naming the destination');

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

test('the catch row survives having no balls, because it holds the errand',
     async (t) => {
  const world = { party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }] };
  const o = offers(world, { huntWanted: 'SENTRET' });
  t.true(o.offered.includes('catch'), 'the way to get balls stays reachable');
  t.false(look(world, { huntWanted: 'SENTRET' }).catch.enabled,
          'even though catching itself would refuse');

  const fighting = offers({ ...world, battleMode: 1,
                            enemy: { species: PIDGEY, level: 3, hp: 15, maxHp: 15 } },
                          { huntWanted: 'SENTRET' });
  t.false(fighting.offered.includes('catch'),
          'but an errand that walks to a mart is not offered mid-battle');
});

test('the hint only names things there is something to do about', async (t) => {
  const empty = offers({}, { huntable: 4 });
  t.contains(empty.hint, 'need a Pokémon', 'no party is worth saying');
  t.contains(empty.hint, 'pick something', 'so is the picker below');

  // And not where there is nothing to pick. This used to be said unconditionally
  // whenever no species was chosen, which indoors -- Elm's lab, a Pokémon
  // Center, anywhere with no encounter table -- pointed at a picker holding
  // "nothing wild appears here" and asked somebody to choose from it.
  const indoors = offers({}, { huntable: 0 });
  t.false(indoors.hint.includes('pick something'),
          'nowhere with anything wild in it, so nothing to pick');
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

test('a cartridge that cannot fetch balls does not offer a catch it cannot run',
     async (t) => {
  const world = { party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }] };

  // With an errand, Catch stays on the list holding the way out of its own
  // empty state -- which is the rule the errand button was built on.
  const can = offers(world, { huntWanted: 'SENTRET' });
  t.true(can.offered.includes('catch'), 'the errand is reachable, so the row is');

  const cannot = offers(world, { huntWanted: 'SENTRET', canFetch: false });
  t.false(cannot.offered.includes('catch'),
          'no errand means no way out, so the row is not drawn');
  t.contains(cannot.hint, 'needs Poké Balls',
             'and the hint is what explains the absence');

  // Not said when it is not the thing in the way: with balls in hand, a title
  // without an errand has nothing to explain.
  const armed = offers(world, { huntWanted: 'SENTRET', ballId: POKE_BALL,
                                canFetch: false });
  t.true(armed.offered.includes('catch'), 'balls in the bag need no errand');
  t.eq(armed.hint, '', 'and nothing is missing, so nothing is said');
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

test('the hint offers a place only while one is worth picking', async (t) => {
  t.contains(offers(PARTY, { places: PLACES }).hint, 'a place to walk to',
             'asked when the row is drawn and waiting');
  t.false(offers(PARTY, { places: PLACES, travelTo: PLACES[0].key })
            .hint.includes('a place to walk to'),
          'and silent once one is chosen');
});

// --- what the grass here gives ----------------------------------------------

test('the grind row names the levels the grass actually gives', async (t) => {
  // Measured on the cartridge: Route 29 produces Lv2–3, Route 30 Lv4–5. The
  // level byte was sitting unread in the encounter table -- a slot is two bytes,
  // level then species, and the species reader stepped over the first.
  const party = { party: [{ hp: 40, maxHp: 40, species: CYNDAQUIL, level: 15 }] };
  t.contains(look(party, { target: 20, wilds: { low: 2, high: 3 } }).grind.text,
             'here: Lv2–3', 'a range reads as a range');
  t.contains(look(party, { target: 20, wilds: { low: 7, high: 7 } }).grind.text,
             'here: Lv7', 'and one level reads as one level');
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
  t.contains(without.heal.text, "nearest is Elm's lab", 'and the walk is named');
});

test('a fainted party is a Centre’s job whatever the bag holds', async (t) => {
  // A Potion does nothing for a Pokémon at 0 HP in Gen 2, so offering the bag
  // would be a promise the row cannot keep.
  const r = look({ party: [{ hp: 0, maxHp: 40, species: CYNDAQUIL, level: 5 }] },
                 { bagHeal: 'POTION', healPlace: 'Cherrygrove City' });
  t.false(r.heal.fromBag, 'the bag is not offered');
  t.contains(r.heal.text, 'nearest is Cherrygrove City', 'the walk is');
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
  t.contains(r.heal.text, 'nearest is', 'and only a Center answers it');
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
  t.contains(near.duel.text, '3,064', 'and what is at stake');
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
