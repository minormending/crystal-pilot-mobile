// captureHere: the guard that stops the pilot knocking out the thing it was
// told to catch, and the reporting around it.
//
// The primitives are stubbed -- chip, throwBall, watchThrow -- because what is
// under test is the decision made between them, not the button pressing. Each
// stub records what it was asked to do, so a test can assert on the sequence.
import { FakeGameBoy, fakeRom, symbols, test, worldRam } from '../harness.mjs';
import { GameState } from '../../gen2/state.js';
import { Tasks } from '../../gen2/tasks.js';

const POKE_BALL = 5;

/** A pilot in a wild battle, with the primitives replaced by scripted ones. */
function inBattle({ enemyHp = 20, enemyMax = 20, party = 1, balls = 10,
                    // What is on the field. Separate from the party on purpose:
                    // once a lead can faint and be replaced, "our HP" and "slot
                    // one's HP" are two different facts.
                    active = { hp: 40, maxHp: 44 },
                    chip = async () => 'ok', throwBall = async () => true,
                    watchThrow = async () => 'gone' } = {}) {
  const sym = symbols();
  const state = new GameState(sym);
  const mons = [];
  for (let i = 0; i < party; i++) {
    mons.push({ species: 155, level: 14, hp: 40, maxHp: 44, moves: [33, 0, 0, 0], pp: [35, 0, 0, 0] });
  }
  const live = { hp: enemyHp };
  const gb = new FakeGameBoy();
  const tasks = new Tasks(gb, state, () => {}, fakeRom({}, {}));
  tasks.snap = async () => state.read(worldRam(sym, {
    battleMode: 1, party: mons, balls: balls > 0 ? [[POKE_BALL, balls]] : [],
    enemy: { species: 16, level: 3, hp: live.hp, maxHp: enemyMax },
    active, menuItems: 34, menuTop: 12, menu: [1, 1],
  }));
  tasks.log = [];
  tasks.chip = async () => { tasks.log.push('chip'); return chip(live); };
  tasks.throwBall = async () => { tasks.log.push('throw'); return throwBall(); };
  tasks.watchThrow = async () => watchThrow();
  tasks.closeMenus = async () => {};
  tasks.settleText = async () => {};
  return { tasks, live, sym, state, mons };
}

test('it refuses to swing when the biggest hit so far would finish the target', async (t) => {
  // The target has 13 of 14 HP, so it is well above the threshold and the
  // threshold alone would order a swing. A swing has already been seen to take
  // 15, which is more than it has. The guard must refuse.
  const { tasks } = inBattle({ enemyHp: 13, enemyMax: 14 });
  const memory = { biggestHit: 15 };
  const r = await tasks.captureHere(POKE_BALL, { weakenTo: 0.5, memory });
  t.eq(tasks.log.filter((x) => x === 'chip').length, 0, 'no swing was taken');
  t.gte(tasks.log.filter((x) => x === 'throw').length, 1, 'a ball was thrown instead');
  t.eq(r.chips, 0, 'and it reports no chips');
});

test('it does swing when the target has more HP than any hit has taken', async (t) => {
  const { tasks, live } = inBattle({
    enemyHp: 40, enemyMax: 40,
    chip: (l) => { l.hp -= 10; return 'ok'; },
  });
  const memory = { biggestHit: 5 };
  await tasks.captureHere(POKE_BALL, { weakenTo: 0.5, memory });
  t.gte(tasks.log.filter((x) => x === 'chip').length, 1, 'it weakened first');
  t.gte(memory.biggestHit, 10, 'and learned what that swing did');
});

test('a knockout is reported as one and teaches the guard', async (t) => {
  const { tasks } = inBattle({ enemyHp: 30, enemyMax: 40, chip: () => 'fainted' });
  const memory = { biggestHit: 0 };
  const r = await tasks.captureHere(POKE_BALL, { weakenTo: 0.5, memory });
  t.eq(r.outcome, 'knockedOut', 'the outcome names what happened');
  t.eq(r.thrown, 0, 'no ball was spent on it');
  t.gte(memory.biggestHit, 30, 'the knockout is itself a measurement');
});

test('our own attack ending the battle is a knockout, not a spent ball budget', async (t) => {
  // chip() checks inBattle before it reads the enemy's HP -- it has to, because
  // the struct reads zero once the battle is over -- so a knockout that beats
  // the poll comes back as 'ended'. Reporting that as a budget would be the
  // wrong reason, and the guard would learn nothing from it.
  const { tasks } = inBattle({ enemyHp: 30, enemyMax: 40, chip: () => 'ended' });
  const memory = { biggestHit: 0 };
  const r = await tasks.captureHere(POKE_BALL, { weakenTo: 0.5, memory });
  t.eq(r.outcome, 'knockedOut', 'lead still standing means the target went down');
  t.gte(memory.biggestHit, 30, 'and it still learns from it');
});

test('our own lead going down is reported as that, not as a knockout', async (t) => {
  const { tasks, mons } = inBattle({ enemyHp: 30, enemyMax: 40, chip: () => 'ended' });
  mons[0].hp = 0;                       // we were the ones who fainted
  const r = await tasks.captureHere(POKE_BALL, { weakenTo: 0.5, memory: { biggestHit: 0 } });
  t.eq(r.outcome, 'lost', 'a different situation, reported differently');
});

test('a knockout by the replacement is not a whiteout', async (t) => {
  // Gen 2 leads a battle with the first Pokemon that is not fainted, so a
  // catch begun with slot one already down -- which a grind can leave you in --
  // has a corpse at party[0] for the whole encounter. Asking that corpse
  // whether we were still standing read our own knockout as a whiteout, and
  // told you the party had fainted while two thirds of it was fine.
  const { tasks, mons } = inBattle({ party: 3, enemyHp: 30, enemyMax: 40,
                                     chip: () => 'ended' });
  mons[0].hp = 0;
  const memory = { biggestHit: 0 };
  const r = await tasks.captureHere(POKE_BALL, { weakenTo: 0.5, memory });
  t.eq(r.outcome, 'knockedOut', 'somebody is still standing, so we won it');
  t.gte(memory.biggestHit, 30, 'and the guard still learns from the swing');
});

test('a catch answers the party prompt instead of losing the thread', async (t) => {
  // The thing being caught gets turns too. When ours went down mid-catch, chip
  // spent its budget looking for a battle menu that had been replaced by
  // "Which POKeMON?", and this reported having lost track of the battle -- with
  // a healthy Pokemon in slot two and one line of input outstanding.
  const field = { hp: 0, maxHp: 44 };
  const { tasks, mons } = inBattle({ party: 2, enemyHp: 30, enemyMax: 40,
                                     active: field });
  mons[0].hp = 0;
  let sent = 0;
  // Answering it puts slot two out, so the field is no longer empty. The object
  // is shared with the snapshot, so mutating it is what the game would do.
  tasks.sendOut = async () => { sent++; field.hp = 25; return 'ok'; };
  const r = await tasks.captureHere(POKE_BALL, { weakenTo: 0, memory: { biggestHit: 0 } });
  t.eq(sent, 1, 'the prompt was answered');
  t.ne(r.outcome, 'stuck', 'so the catch carried on rather than losing the thread');
});

test('a field that never comes back is reported, not looped on', async (t) => {
  // Answering the prompt does not spend a ball, and this loop is bounded by
  // balls -- so a replacement that reads as fainted too would spin for ever.
  // Bounded by the party instead, because that is the most times anything can
  // go down before there is nobody left to send.
  const { tasks } = inBattle({ party: 3, enemyHp: 30, enemyMax: 40,
                               active: { hp: 0, maxHp: 44 } });
  let sent = 0;
  tasks.sendOut = async () => { sent++; return 'ok'; };   // never actually lands
  const r = await tasks.captureHere(POKE_BALL, { weakenTo: 0, memory: { biggestHit: 0 } });
  t.eq(r.outcome, 'stuck', 'it gives up rather than spinning');
  t.gte(sent, 1, 'having tried');
  t.true(sent <= 8, `and stopped trying — ${sent} attempts`);
});

test('a catch is reported with the ball count actually spent', async (t) => {
  let thrown = 0;
  const { tasks } = inBattle({
    enemyHp: 5, enemyMax: 40,
    throwBall: () => { thrown++; return true; },
    // 'broke free' is the one that keeps the loop going; 'gone' means it fled.
    watchThrow: () => (thrown >= 2 ? 'caught' : 'broke free'),
  });
  const r = await tasks.captureHere(POKE_BALL, { weakenTo: 0, memory: { biggestHit: 0 } });
  t.eq(r.outcome, 'caught', 'it caught it');
  t.eq(r.thrown, 2, 'after two balls, which is what it reports');
});

test('it refuses a trainer battle and a full party before spending anything', async (t) => {
  const sym = symbols();
  const state = new GameState(sym);
  const gb = new FakeGameBoy();
  const tasks = new Tasks(gb, state, () => {}, fakeRom());
  let threw = 0;
  tasks.throwBall = async () => { threw++; return true; };

  tasks.snap = async () => state.read(worldRam(sym, {
    battleMode: 2, party: [{}], balls: [[POKE_BALL, 5]],
    enemy: { hp: 20, maxHp: 20 },
  }));
  t.eq((await tasks.captureHere(POKE_BALL, {})).outcome, 'trainer',
       "a trainer's Pokemon cannot be caught");

  const six = Array.from({ length: 6 }, () => ({}));
  tasks.snap = async () => state.read(worldRam(sym, {
    battleMode: 1, party: six, balls: [[POKE_BALL, 5]],
    enemy: { hp: 20, maxHp: 20 },
  }));
  t.eq((await tasks.captureHere(POKE_BALL, {})).outcome, 'full', 'a full party');
  t.eq(threw, 0, 'and neither spent a ball finding out');
});

test('an empty pocket is refused before the battle is touched', async (t) => {
  const { tasks } = inBattle({ balls: 0 });
  const r = await tasks.captureHere(POKE_BALL, {});
  t.eq(r.outcome, 'noballs', 'no balls of that kind');
  t.eq(tasks.log.length, 0, 'nothing was attempted');
});
