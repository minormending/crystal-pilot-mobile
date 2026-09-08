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

test('a poisoned lead is worth healing before the HP looks bad', async (t) => {
  // Poison and a burn take HP off between battles and while *walking*, so a
  // lead carrying one loses ground on every step the grind takes. Left out of
  // the condition, it was only noticed once the ticking had brought the HP down
  // far enough to look like ordinary damage -- by which point a Center trip had
  // been earned that an ANTIDOTE would have saved.
  const reasons = [];
  const { tasks } = grinder([
    { species: CHIKORITA, level: 5, hp: 40, maxHp: 44, statusByte: 0x08 },
  ]);
  await tasks.grind(0, 10, { heal: async (why) => { reasons.push(why); return false; } });
  t.eq(reasons, ['hurt'], 'and it is the bag’s kind of problem, not a Centre’s');
});

test('a well lead at full health is not healed for nothing', async (t) => {
  const reasons = [];
  const { tasks } = grinder([
    { species: CHIKORITA, level: 5, hp: 44, maxHp: 44 },
    { species: CHIKORITA, level: 6, hp: 44, maxHp: 44 },
  ]);
  await tasks.grind(0, 6, { heal: async (why) => { reasons.push(why); return false; } });
  t.eq(reasons, [], 'nothing was asked for');
});


// --- running out of PP ------------------------------------------------------

test('running out of PP sends the grind to a Center, which restores it',
     async (t) => {
  // **Measured on Route 31, and it wasted a session.** Fifty battles on a
  // thirty-five-PP TACKLE, then a Lv2 CATERPIE at 1 HP in a *trainer* battle
  // the pilot could not finish -- no damaging move with PP, and no fleeing a
  // trainer. Every walk after that was pointless.
  //
  // A Pokémon Center restores PP as well as HP, so this is a trip the job
  // already knows how to make. It just had no reason to make it.
  const { tasks, said } = grinder(
    [{ level: 5 }, { level: 5 }, { level: 6 }],
    { outcomes: ['won', 'nopp', 'won', 'won'] });
  const trips = [];
  const r = await tasks.grind(0, 6, {
    heal: async (why) => { trips.push(why); return true; },
  });
  t.true(r.ok, `it carried on and finished: ${r.message}`);
  t.eq(trips, ['dry'], 'one trip, and for the reason a faint uses');
  t.contains(said.join(' '), 'out of PP', 'and it said so');
  t.contains(said.join(' '), 'a Center restores it', 'with why that helps');
});

test('with nowhere to heal, running out of PP is the end of the job',
     async (t) => {
  // The honest stop. Saying *out of PP on anything that does damage* is
  // something a person can act on; 'stuck' was not.
  const { tasks } = grinder([{ level: 5 }], { outcomes: ['nopp'] });
  const r = await tasks.grind(0, 9, {});
  t.false(r.ok, 'it stops');
  t.contains(r.message, 'out of PP', 'naming what ran out');
  t.contains(r.message, 'Lv5', 'and where it got to');
});

test('a trip to heal for PP is counted against the same budget as a faint',
     async (t) => {
  // Nothing advances while walking to a Center, so an unbounded version paces
  // for ever -- which is the reason the knockout trips are bounded, and this is
  // the same trip.
  const { tasks } = grinder([{ level: 5 }],
                            { outcomes: new Array(40).fill('nopp') });
  const r = await tasks.grind(0, 9, { heal: async () => true });
  t.false(r.ok, 'it gives up');
  t.contains(r.message, 'trips to heal', 'having spent the budget');
});

// --- the bounds that make it terminate --------------------------------------
//
// `tools/mutate` put gen2/jobs.js at 35% -- the weakest module in the
// repository, and the one people leave running. Every survivor below was a
// number or an operator in a *termination bound*: the heal-trip budget, the
// stuck-battle run, and the reset that makes it a run rather than a total.
// Nothing asserted any of them, so all three could be moved with the suite
// green.

test('a grind gives up after its twelfth trip to heal, and says so',
     async (t) => {
  // Every battle a knockout, and a heal that always works: the only thing that
  // can end this is the budget. Without it the job paces to a Center for ever,
  // which is what an unbounded version measurably did.
  const { tasks, said } = grinder(
    [{ species: CHIKORITA, level: 5 }],
    { outcomes: Array(40).fill('lost') });
  let heals = 0;
  const r = await tasks.grind(0, 20, { heal: async () => { heals += 1; return true; } });
  t.false(r.ok, 'it stops rather than going round again');
  t.eq(heals, 12, 'twelve trips, which is MAX_HEALS');
  t.contains(r.message, '12 trips', 'and the message says how many');
  t.contains(r.message, 'fainted', 'and why it was going');
  t.true(said.length > 0, 'having said so as it went');
});

test('a grind with no way to heal stops at the first knockout', async (t) => {
  // The same branch with `heal` absent, which is the case the row is allowed to
  // offer on a cartridge with nowhere to heal.
  const { tasks } = grinder([{ species: CHIKORITA, level: 5 }],
                            { outcomes: ['lost'] });
  const r = await tasks.grind(0, 20, {});
  t.false(r.ok, 'no trip to make');
  t.contains(r.message, 'fainted', 'and it says what happened');
  t.false(r.message.includes('trips'), 'without claiming to have tried any');
});

test('a heal that fails ends the grind rather than looping on it', async (t) => {
  const { tasks } = grinder([{ species: CHIKORITA, level: 5 }],
                            { outcomes: ['lost'] });
  const r = await tasks.grind(0, 20, { heal: async () => false });
  t.false(r.ok, 'it does not carry on');
  t.contains(r.message, 'healing did not work', 'saying which half failed');
});

test('five battles in a row going nowhere stops it', async (t) => {
  // A stall rather than bad luck. Grinding on just burns the battle budget
  // while nothing happens, and the person watching sees a busy dot.
  const { tasks } = grinder([{ species: CHIKORITA, level: 5 }],
                            { outcomes: Array(10).fill('stuck') });
  const r = await tasks.grind(0, 20, { heal: async () => true });
  t.false(r.ok, 'stopped');
  t.contains(r.message, '5 battles in a row', 'naming the run');
});

test('a run of stuck battles is consecutive, not cumulative', async (t) => {
  // The reset to zero is the whole difference, and it is the classic version of
  // this bug: four stalls, a battle that works, four more stalls is not a
  // stall. With the reset removed the job stops in the middle of a grind that
  // is going fine.
  const { tasks } = grinder(
    [{ species: CHIKORITA, level: 5 }],
    { outcomes: ['stuck', 'stuck', 'stuck', 'stuck', 'won',
                 'stuck', 'stuck', 'stuck', 'stuck', 'won',
                 ...Array(30).fill('won')] });
  const r = await tasks.grind(0, 6, { heal: async () => true,
                                      maxBattles: 40 });
  t.true(r.stats.battles > 9, 'it fought past both runs of four');
  t.false(String(r.message).includes('in a row'), 'without calling it a stall');
});
