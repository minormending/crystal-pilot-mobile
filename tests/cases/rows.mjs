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
         describeUndo } from '../../app/rows.js';

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
  for (const w of worlds) {
    for (const [name, row] of Object.entries(look(w))) {
      t.true(typeof row.text === 'string' && row.text.length > 0,
             `${name} always says something`);
    }
  }
});

test('catch offers the errand instead of itself when there are no balls', async (t) => {
  const world = { party: [{ species: CYNDAQUIL, level: 5, hp: 20, maxHp: 20 }] };
  const without = look(world, { huntWanted: 'SENTRET' });
  t.true(without.catch.needsBalls, 'no ball chosen means no balls');
  t.contains(without.catch.text, 'fetch them first', 'it points at the errand');
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
  const empty = offers({});
  t.contains(empty.hint, 'need a Pokémon', 'no party is worth saying');
  t.contains(empty.hint, 'pick something', 'so is the picker below');

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
