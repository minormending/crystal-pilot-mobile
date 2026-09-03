// What the interface says, and when a button works.
//
// This is the "why is that greyed out?" logic. It used to be inseparable from
// fifty-odd textContent assignments, which is why none of it was ever tested
// and why one row decided its own state by reading a disabled property back
// out of the DOM.
import { fakeRom, symbols, test, worldRam } from '../harness.mjs';
import { GameState } from '../../app/state.js';
import { describeRows, describeSlot, describeUndo } from '../../app/rows.js';

const sym = symbols();
const state = new GameState(sym);
const rom = fakeRom({}, {});
const CYNDAQUIL = 155, PIDGEY = 16, POKE_BALL = 5;

const look = (world, ctx = {}) =>
  describeRows(state.read(worldRam(sym, world)), { rom, ...ctx });

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
