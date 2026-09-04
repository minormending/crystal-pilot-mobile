// What the interface says, and when a button works.
//
// This is the "why is that greyed out?" logic. It used to be inseparable from
// fifty-odd textContent assignments, which is why none of it was ever tested
// and why one row decided its own state by reading a disabled property back
// out of the DOM.
import { fakeRom, symbols, test, worldRam } from '../harness.mjs';
import { GameState } from '../../app/state.js';
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
  t.contains(joinFailure('malformed'), 'three words', 'a half-typed code');
  t.contains(joinFailure('not-found'), 'typo', 'the room is not there');
  t.contains(joinFailure('network'), 'try again', 'the network, not the code');
  // A reason from a newer kidsync than this build knows about.
  t.contains(joinFailure('rate-limited'), 'rate-limited',
             'an unknown reason still reaches the person');
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
