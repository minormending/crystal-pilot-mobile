// grind: what it says while it works, and what it says when it stops.
//
// The job had no test in twenty-one versions, which is awkward for the one
// people leave running. It needs no cartridge: what it does between battles is
// read a snapshot and decide, so a scripted sequence of snapshots is a grind of
// any shape -- including the shapes that took a real afternoon to produce, like
// a Chikorita evolving on the level that ended the job.
import { fakeRom, symbols, test, worldRam } from '../harness.mjs';
import { GameState } from '../../gen2/state.js';
import { Tasks } from '../../gen2/tasks.js';
import { FakeGameBoy } from '../harness.mjs';

const CHIKORITA = 152, BAYLEEF = 153;
const NAMES = { 152: 'CHIKORITA', 153: 'BAYLEEF' };

/**
 * A pilot whose party is whatever the script says, battle by battle.
 *
 * `script` is one party state per *battle fought*, not per snapshot -- which is
 * how a real grind behaves, and getting that wrong the first time is why these
 * tests were briefly wrong about how many battles a three-level climb takes.
 * The last entry repeats once the script runs out. Fighting and finding a fight
 * are stubbed, since neither is what these tests are about, and every `say` is
 * kept so the *order* of what it told you can be asserted on.
 */
function grinder(script, { outcomes = [] } = {}) {
  const sym = symbols();
  const state = new GameState(sym);
  const said = [];
  const gb = new FakeGameBoy();
  const tasks = new Tasks(gb, state, (m) => said.push(m), fakeRom({ species: NAMES }));
  let fought = 0;
  tasks.snap = async () => {
    const mon = script[Math.min(fought, script.length - 1)];
    return state.read(worldRam(sym, { party: [{ moves: [33, 0, 0, 0], pp: [35, 0, 0, 0],
                                                hp: 40, maxHp: 44, ...mon }] }));
  };
  tasks._findFight = async () => true;
  tasks.fightBattle = async () => outcomes[fought++] || 'won';
  return { tasks, said };
}

test('a grind that reaches the level says so, and counts what it did',
     async (t) => {
  const { tasks, said } = grinder([
    { species: CHIKORITA, level: 5 },
    { species: CHIKORITA, level: 6 },
    { species: CHIKORITA, level: 7 },
  ]);
  const r = await tasks.grind(0, 7, { heal: async () => true });
  t.true(r.ok, 'it got there');
  t.contains(r.message, 'Lv7', 'and says where it got to');
  t.eq(r.stats.levels, 2, 'two levels gained');
  t.eq(r.stats.battles, 2, 'in two battles');
  t.eq(r.stats.won, 2, 'both won');
  t.contains(said.join(' | '), 'grinding slot 1 from Lv5 to Lv7', 'said what it set out to do');
});

test('an evolution on the level that ends the job is still reported',
     async (t) => {
  // The defect. The check read the snapshot taken at the *top* of the
  // iteration -- the party as it was before the battle that did the evolving --
  // so it reported a battle late, and the level break sits above it. An
  // evolution in the battle that reached the target was therefore never
  // reported at all, which is the likeliest battle for one: the last.
  const { tasks, said } = grinder([
    { species: CHIKORITA, level: 15 },
    { species: BAYLEEF, level: 16 },
  ]);
  const r = await tasks.grind(0, 16, { heal: async () => true });
  t.true(r.ok, 'it reached Lv16');
  t.eq(r.stats.evolved, 1, 'and it counted the evolution');
  t.contains(said.join(' | '), 'CHIKORITA evolved into BAYLEEF', 'by name, both ways');
});

test('an evolution mid-grind is reported when it happens, not a battle later',
     async (t) => {
  const { tasks, said } = grinder([
    { species: CHIKORITA, level: 15 },
    { species: BAYLEEF, level: 16 },
    { species: BAYLEEF, level: 17 },
  ]);
  await tasks.grind(0, 17, { heal: async () => true });
  const log = said.join(' | ');
  const evolved = said.findIndex((m) => m.includes('evolved'));
  const second = said.findIndex((m) => m.includes('battle 2'));
  t.true(evolved >= 0, 'it was said');
  t.true(evolved < second, 'before the battle that followed it, not after');
  t.eq((log.match(/evolved/g) || []).length, 1, 'and said once, not once per battle');
});

test('a grind already at the level does nothing and says nothing happened',
     async (t) => {
  const { tasks } = grinder([{ species: CHIKORITA, level: 20 }]);
  const r = await tasks.grind(0, 15, {});
  t.true(r.ok, 'not a failure');
  t.contains(r.message, 'already Lv20', 'it says why there was nothing to do');
  t.eq(r.stats.battles, 0, 'and fought nothing');
});

test('an empty party slot is refused rather than fought over', async (t) => {
  const { tasks } = grinder([{ species: CHIKORITA, level: 5 }]);
  const r = await tasks.grind(3, 10, {});
  t.false(r.ok, 'refused');
  t.contains(r.message, 'slot 4 is empty', 'and it counts slots the way a person does');
});

test('a knockout heals and carries on, and is counted', async (t) => {
  // Three grinds in a row once reported a knockout and handed back a dead
  // party, each with twelve unused heals in hand.
  let heals = 0;
  const { tasks, said } = grinder([
    { species: CHIKORITA, level: 10 },
    { species: CHIKORITA, level: 10 },
    { species: CHIKORITA, level: 11 },
  ], { outcomes: ['lost', 'won'] });
  const r = await tasks.grind(0, 11, { heal: async () => { heals++; return true; } });
  t.eq(heals, 1, 'it went to heal');
  t.eq(r.stats.knockouts, 1, 'and counted the knockout');
  t.contains(said.join(' | '), 'healing and carrying on', 'and said so at the time');
});

test('a knockout with no way to heal stops, and says which it was', async (t) => {
  const { tasks } = grinder([
    { species: CHIKORITA, level: 10 },
    { species: CHIKORITA, level: 10 },
  ], { outcomes: ['lost'] });
  const r = await tasks.grind(0, 15, {});
  t.false(r.ok, 'it stopped');
  t.contains(r.message, 'fainted at Lv10', 'and named the state it stopped in');
});

test('an evolution in the last battle the budget allowed is still reported',
     async (t) => {
  // The other way the loop ends: not a break but its own condition, which
  // exits without taking another snapshot. So the last battle's evolution is
  // first visible on the closing read, and only a check there can see it.
  const { tasks, said } = grinder([
    { species: CHIKORITA, level: 15 },
    { species: BAYLEEF, level: 16 },
  ]);
  const r = await tasks.grind(0, 20, { maxBattles: 1, heal: async () => true });
  t.false(r.ok, 'it did not reach Lv20');
  t.contains(r.message, 'stopped at Lv16', 'and says where it stopped');
  t.eq(r.stats.evolved, 1, 'and the evolution was still counted');
  t.contains(said.join(' | '), 'evolved into BAYLEEF', 'and still said');
});

test('a cancelled grind reports the evolution it saw before stopping',
     async (t) => {
  const { tasks, said } = grinder([
    { species: CHIKORITA, level: 15 },
    { species: BAYLEEF, level: 16 },
  ]);
  const real = tasks.fightBattle;
  tasks.fightBattle = async () => { const o = await real(); tasks.cancelled = true; return o; };
  const r = await tasks.grind(0, 20, { heal: async () => true });
  t.eq(r.stats.evolved, 1, 'counted on the way out');
  t.contains(said.join(' | '), 'evolved into BAYLEEF', 'and named');
});

test('the grind says why it needs healing, because the ways differ', async (t) => {
  // Measured, and this loop's own comment had already predicted it: a heal that
  // mends HP out of the pocket answers "hurt" and cannot answer "dry", because
  // nothing but a Center restores PP. Handing it a bag heal for everything
  // spent all twelve trips at Lv8 on a Pokémon at full health with no move left
  // that could win -- a loop with no exit.
  const reasons = [];
  const { tasks } = grinder([
    { species: CHIKORITA, level: 5, hp: 40, maxHp: 44, pp: [0, 0, 0, 0] },
  ]);
  const r = await tasks.grind(0, 10, { heal: async (why) => { reasons.push(why); return false; } });
  t.false(r.ok, 'it stopped');
  t.eq(reasons, ['dry'], 'and asked for the kind of heal that restores PP');
});

test('merely hurt asks for the cheaper kind', async (t) => {
  const reasons = [];
  const { tasks } = grinder([
    { species: CHIKORITA, level: 5, hp: 4, maxHp: 44 },
  ]);
  await tasks.grind(0, 10, { heal: async (why) => { reasons.push(why); return false; } });
  t.eq(reasons, ['hurt'], 'so the caller may reach for the bag');
});

test('a knockout always asks for a Centre', async (t) => {
  // A potion does nothing for a Pokémon at 0 HP in Gen 2.
  const reasons = [];
  const { tasks } = grinder([
    { species: CHIKORITA, level: 10 },
    { species: CHIKORITA, level: 10 },
  ], { outcomes: ['lost'] });
  await tasks.grind(0, 15, { heal: async (why) => { reasons.push(why); return false; } });
  t.eq(reasons, ['dry'], 'whatever the bag holds');
});
