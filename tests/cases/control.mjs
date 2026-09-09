// Stopping a job, and the one table that says what a capture outcome means.
import { FakeGameBoy, fakeRom, romReading, symbols, test, worldRam } from '../harness.mjs';
import { GameState } from '../../gen2/state.js';
import { Cancelled, TaskBase } from '../../gbcore/taskbase.js';
import { Tasks } from '../../gen2/tasks.js';
import { captureOutcome } from '../../gen2/jobs.js';

function pilot(opts = {}) {
  const sym = symbols();
  const state = new GameState(sym);
  const gb = new FakeGameBoy({ wram: worldRam(sym, opts.world || {}), ...opts });
  // `rom` is explicit for the tests that need the real move-table reader rather
  // than the stub: whether a move can win a battle is a power reading.
  const rom = opts.rom === undefined ? fakeRom() : opts.rom;
  return { sym, state, gb, tasks: new Tasks(gb, state, () => {}, rom) };
}

test('Stop lands inside a primitive, not after it finishes', async (t) => {
  // awaitQuiet polls 250 times waiting for the overworld to settle. Before the
  // checkpoint, a Stop pressed here did nothing until all 250 were done and
  // control returned to an outer loop.
  const { tasks, gb } = pilot({ world: { mapStatus: 1, scriptMode: 1, map: [24, 3] } });
  tasks.cancelled = true;
  const e = await t.rejects(() => tasks.awaitQuiet(), 'awaitQuiet with Stop pressed');
  t.true(e instanceof Cancelled, `it unwinds as Cancelled, got ${e && e.name}`);
  t.eq(gb.frames, 0, 'and it did not advance the machine even once');
});

test('Stop pressed mid-loop stops that loop, not the one after it', async (t) => {
  // Pressed after a few polls rather than before, which is the real case.
  const sym = symbols();
  const state = new GameState(sym);
  const gb = new FakeGameBoy({ wram: worldRam(sym, { mapStatus: 1, scriptMode: 1 }) });
  const tasks = new Tasks(gb, state, () => {}, fakeRom());
  gb.onRun = () => { if (gb.frames > 100) tasks.cancelled = true; };
  await t.rejects(() => tasks.awaitQuiet(), 'awaitQuiet');
  // 250 polls at SETTLE_FRAMES each would be thousands of frames.
  t.true(gb.frames < 400, `it gave up early, at ${gb.frames} frames`);
});

test('every button push and frame step goes through the checkpoint', async (t) => {
  // The point of routing them: cancellation is one decision rather than a check
  // in each of seventeen loops, every one of which could forget.
  const { tasks, gb } = pilot();
  tasks.cancelled = true;
  await t.rejects(() => tasks.step(10), 'step');
  await t.rejects(() => tasks.push('A'), 'push');
  t.eq(gb.presses.length, 0, 'nothing was pressed');
  t.eq(gb.frames, 0, 'nothing was advanced');
});

test('closeMenus and settleText can be stopped too', async (t) => {
  // settleText returns at once if the screen is already quiet, so give it a
  // window to dismiss -- otherwise the test passes without reaching the loop,
  // which is a test of nothing.
  const { tasks } = pilot({ world: { windowStack: 1 } });
  t.true((await tasks.snap()).windowOpen, 'there is something to settle');
  tasks.cancelled = true;
  await t.rejects(() => tasks.closeMenus(6), 'closeMenus');
  await t.rejects(() => tasks.settleText(40), 'settleText');
});

test('a Stop that is never pressed changes nothing', async (t) => {
  const { tasks, gb } = pilot();
  await tasks.step(5);
  await tasks.push('A', 4, 4);
  t.eq(gb.count('A'), 1, 'the press still happens');
  t.true(gb.frames > 0, 'and the frames still run');
});

// --- the outcome table ------------------------------------------------------
test('every outcome a capture can report has an entry', async (t) => {
  // The divergence this replaced: catchHere translated eleven codes and catch_
  // handled six, so adding one meant remembering both places.
  const codes = ['caught', 'nobattle', 'trainer', 'full', 'noballs', 'nopack',
                 'ranout', 'knockedOut', 'gone', 'lost', 'stuck', 'cancelled',
                 'budget'];
  const balls = (n) => `${n} ball${n === 1 ? '' : 's'}`;
  for (const code of codes) {
    const how = captureOutcome(code);
    const said = how.say({ name: 'PIDGEY', thrown: 1, level: 3 }, balls);
    t.true(typeof said === 'string' && said.length > 0, `${code} says something`);
    t.true(typeof how.stop === 'boolean', `${code} says whether a hunt stops`);
  }
});

test('only the outcomes worth continuing for let a hunt carry on', async (t) => {
  // A knockout or a getaway is bad luck with another one in the grass. Running
  // out of balls is not.
  t.false(captureOutcome('knockedOut').stop, 'a knockout: look for another');
  t.false(captureOutcome('gone').stop, 'it fled: look for another');
  t.true(captureOutcome('ranout').stop, 'out of balls: stop');
  t.true(captureOutcome('lost').stop, 'our lead fainted: stop');
  t.true(captureOutcome('caught').stop, 'caught it: stop');
});

test('an outcome nobody taught it still reports something honest', async (t) => {
  const how = captureOutcome('somethingNew');
  t.true(how.stop, 'an unknown outcome stops rather than looping');
  t.contains(how.say({}, () => ''), 'somethingNew', 'and names the code');
});

test('a grind that keeps needing a Center gives up rather than pacing', async (t) => {
  // The heal branch counts no battles, so nothing in that loop advances. It
  // terminates only because a Center restores PP as well as HP and healUp
  // verifies the HP half -- an assumption about the cartridge, in an app that
  // now runs cartridges nobody has seen. A Center that left PP alone walked
  // there and back for ever.
  const { tasks } = pilot();
  const mon = { species: 155, level: 5, hp: 44, maxHp: 44,
                moves: [33, 0, 0, 0], pp: [0, 0, 0, 0] };   // full HP, no PP
  tasks.snap = async () => ({ party: [mon], inBattle: false, worldLoaded: true });
  // The fake is bounded too, and deliberately: without the bound in jobs.js
  // this loop never returns, and a test that cannot return cannot fail -- it
  // hangs, and a hung suite reports nothing. Measured: with the bound removed
  // and no cap here, the run span for 60s and had to be killed. The cap is far
  // past MAX_HEALS, so only an unbounded loop ever reaches it.
  const RUNAWAY = 60;
  let trips = 0;
  const r = await tasks.grind(0, 20, { heal: async () => {
    if (++trips > RUNAWAY) {
      throw new Error(`heal called ${trips} times: the loop is not bounded`);
    }
    return true;
  } });
  t.false(r.ok, 'it stops');
  t.contains(r.message, 'kept needing it', 'and says why rather than sitting there');
  t.true(trips <= 13, `bounded at ${trips} trips`);
});

test('a knockout is healed and carried on from, not given up on', async (t) => {
  // Measured on the real cartridge three runs running: a grind on Route 29 past
  // about Lv12 fights wild Pokemon worth almost no experience, so a knockout
  // there is ordinary. Each run reported "the whole party fainted" and handed
  // back a dead party -- with twelve unused heals in hand, having been given a
  // way to heal.
  const { tasks } = pilot();
  // Full HP to start with, so the low-HP branch at the top of the loop stays
  // out of it and only the knockout path can heal.
  const mon = { species: 155, level: 12, hp: 40, maxHp: 40,
                moves: [33, 0, 0, 0], pp: [30, 0, 0, 0] };
  tasks.snap = async () => ({ party: [mon], inBattle: false, worldLoaded: true });
  tasks._findFight = async () => true;
  let fights = 0, trips = 0;
  tasks.fightBattle = async () => {
    fights++;
    if (fights <= 2) { mon.hp = 0; return 'lost'; }
    mon.level = 20;                       // the third battle gets there
    return 'won';
  };
  const r = await tasks.grind(0, 20, { heal: async () => {
    trips++; mon.hp = mon.maxHp; return true;
  } });
  t.eq(trips, 2, 'it healed after each knockout');
  t.eq(r.stats.knockouts, 2, 'and counted them, because they cost money');
  t.true(r.ok, 'and reached the target it was sent for');
});

test('a knockout with no way to heal still stops, and says so', async (t) => {
  const { tasks } = pilot();
  const mon = { species: 155, level: 12, hp: 40, maxHp: 40,
                moves: [33, 0, 0, 0], pp: [30, 0, 0, 0] };
  tasks.snap = async () => ({ party: [mon], inBattle: false, worldLoaded: true });
  tasks._findFight = async () => true;
  tasks.fightBattle = async () => 'lost';
  const r = await tasks.grind(0, 20, {});
  t.false(r.ok, 'nothing to be done');
  t.contains(r.message, 'whole party fainted', 'and it is named as the thing it is');
  t.false(r.message.includes('trips to heal'), 'without blaming a budget it never had');
});

test('knockouts share the heal budget, because it is the same trip', async (t) => {
  // The bound exists because healing counts no battles: nothing in that branch
  // advances, so an unbounded version paces to a Center for ever.
  const { tasks } = pilot();
  const mon = { species: 155, level: 12, hp: 40, maxHp: 40,
                moves: [33, 0, 0, 0], pp: [30, 0, 0, 0] };
  tasks.snap = async () => ({ party: [mon], inBattle: false, worldLoaded: true });
  tasks._findFight = async () => true;
  tasks.fightBattle = async () => 'lost';
  let trips = 0;
  const r = await tasks.grind(0, 20, { heal: async () => {
    if (++trips > 40) throw new Error(`heal called ${trips} times: not bounded`);
    return true;
  } });
  t.false(r.ok, 'it gives up eventually');
  t.true(trips <= 13, `bounded at ${trips} trips`);
  t.contains(r.message, 'trips to heal', 'and says the budget is what ran out');
});

test('a grind does not walk to a Center out of a battle it has not left', async (t) => {
  // fightBattle can come back 'stuck' with a battle still on screen, and the
  // heal branch sits above the one that fights -- so it preempted it, nav.step
  // yielded on the battle, and the grind reported that healing did not work.
  const { tasks } = pilot();
  const mon = { species: 155, level: 5, hp: 1, maxHp: 44,
                moves: [33, 0, 0, 0], pp: [35, 0, 0, 0] };
  tasks.snap = async () => ({ party: [mon], inBattle: true, worldLoaded: true });
  let trips = 0, fights = 0;
  tasks.fightBattle = async () => { fights++; return 'stuck'; };
  const r = await tasks.grind(0, 20, { heal: async () => { trips++; return true; } });
  t.eq(trips, 0, 'it never tried to walk out of the battle');
  t.gte(fights, 1, 'it fought instead');
  t.contains(r.message, 'went nowhere', 'and reports the stall it actually had');
});

test('out of PP means out of PP that can win a battle', async (t) => {
  // Measured on the cartridge: a Chikorita with Growl at 3 PP and everything
  // else dry read as fine by the old test -- "some move has PP" -- so the grind
  // kept fighting with a move that takes no HP off anything. Five battles going
  // nowhere and a party at 3 HP out of 36, when a trip to a Center would have
  // restored the lot.
  const rom = romReading({
    33: { id: 33, name: 'TACKLE', power: 35, effect: 0, pp: 35 },
    45: { id: 45, name: 'GROWL', power: 0, effect: 18, pp: 40 },
  });
  const { tasks } = pilot({ rom });
  // Full HP, so only the PP half of the heal test can be what fires.
  const mon = { species: 152, level: 13, hp: 36, maxHp: 36,
                moves: [33, 45, 0, 0], pp: [0, 3, 0, 0] };
  tasks.snap = async () => ({ party: [mon], inBattle: false, worldLoaded: true });
  tasks._findFight = async () => true;
  let fights = 0, trips = 0;
  tasks.fightBattle = async () => { fights++; return 'won'; };
  const r = await tasks.grind(0, 20, { heal: async () => {
    trips++; mon.pp = [35, 40, 0, 0]; mon.level = 20; return true;
  } });
  t.eq(trips, 1, 'it went to heal rather than swinging Growl at things');
  t.eq(fights, 0, 'and did not fight first');
  t.true(r.ok, 'then carried on');
});

test('a status move with PP is not mistaken for a way to win', async (t) => {
  // The other direction: something that *can* win keeps the grind fighting.
  const rom = romReading({
    33: { id: 33, name: 'TACKLE', power: 35, effect: 0, pp: 35 },
    45: { id: 45, name: 'GROWL', power: 0, effect: 18, pp: 40 },
  });
  const { tasks } = pilot({ rom });
  const mon = { species: 152, level: 13, hp: 36, maxHp: 36,
                moves: [33, 45, 0, 0], pp: [20, 3, 0, 0] };
  tasks.snap = async () => ({ party: [mon], inBattle: false, worldLoaded: true });
  tasks._findFight = async () => true;
  let fights = 0, trips = 0;
  tasks.fightBattle = async () => { fights++; mon.level = 20; return 'won'; };
  await tasks.grind(0, 20, { heal: async () => { trips++; return true; } });
  t.eq(trips, 0, 'Tackle has PP, so there is nothing to go to a Center for');
  t.eq(fights, 1, 'it fought');
});

test('an evolution is reported, not slipped past', async (t) => {
  // Measured: a Chikorita ground to Lv16 came back as #153 -- Bayleef -- and
  // nothing said so, while every line after it used the new name. Letting it
  // evolve is the policy; saying nothing about it was not a policy at all.
  const rom = { speciesName: (id) => ({ 152: 'CHIKORITA', 153: 'BAYLEEF' })[id]
                                     || `#${id}`,
                itemName: () => 'POKé BALL', move: () => ({ power: 40 }),
                isChipMove: () => true };
  const { tasks } = pilot({ rom });
  const said = [];
  tasks.say = (m) => said.push(m);
  const mon = { species: 152, level: 15, hp: 40, maxHp: 40,
                moves: [33, 0, 0, 0], pp: [30, 0, 0, 0] };
  tasks.snap = async () => ({ party: [mon], inBattle: false, worldLoaded: true });
  tasks._findFight = async () => true;
  let fights = 0;
  tasks.fightBattle = async () => {
    fights++;
    if (fights === 1) { mon.level = 16; mon.species = 153; }
    else mon.level = 20;
    return 'won';
  };
  const r = await tasks.grind(0, 20, {});
  t.true(said.some((m) => m === 'CHIKORITA evolved into BAYLEEF'),
         'named both ends of it, in the log where it happened');
  t.eq(r.stats.evolved, 1, 'and counted');
  t.true(r.ok, 'and carried on to the target');
});

test('a cartridge whose species cannot be named still reports the change',
     async (t) => {
  const { tasks } = pilot({ rom: null });
  const said = [];
  tasks.say = (m) => said.push(m);
  const mon = { species: 152, level: 15, hp: 40, maxHp: 40,
                moves: [33, 0, 0, 0], pp: [30, 0, 0, 0] };
  tasks.snap = async () => ({ party: [mon], inBattle: false, worldLoaded: true });
  tasks._findFight = async () => true;
  tasks.fightBattle = async () => { mon.species = 153; mon.level = 20; return 'won'; };
  await tasks.grind(0, 20, {});
  t.true(said.some((m) => m === '#152 evolved into #153'),
         'the numbers, which is all a nameless cartridge has');
});

test('a species that does not change is not announced every battle', async (t) => {
  const { tasks } = pilot();
  const said = [];
  tasks.say = (m) => said.push(m);
  const mon = { species: 155, level: 15, hp: 40, maxHp: 40,
                moves: [33, 0, 0, 0], pp: [30, 0, 0, 0] };
  tasks.snap = async () => ({ party: [mon], inBattle: false, worldLoaded: true });
  tasks._findFight = async () => true;
  let fights = 0;
  tasks.fightBattle = async () => { if (++fights >= 3) mon.level = 20; return 'won'; };
  const r = await tasks.grind(0, 20, {});
  t.false(said.some((m) => /evolved/.test(m)), 'nothing evolved, so nothing is said');
  t.eq(r.stats.evolved, 0, 'and the count stays at zero');
});

// --- the method the Stop button actually calls -------------------------------
//
// Every test above sets `tasks.cancelled = true` by hand, which is the state a
// Stop produces and not the thing a Stop *does*. So `cancel()` -- the one line
// the button is wired to -- had nothing asserting it, and `tools/mutate` proved
// it: setting `this.cancelled = false` in there passed the whole suite. Stop
// would have been a button that did nothing, with eighteen tests about
// stopping.
//
// The same shape as the ring fake that never called `escapeBattle` and the
// healer fake with one map: a test that reaches around the thing it is testing
// cannot fail.

test('the method the Stop button calls is the one that stops a task',
     async (t) => {
  const { tasks } = pilot({ world: { mapStatus: 1, scriptMode: 1, map: [24, 3] } });
  t.false(tasks.cancelled, 'nothing pressed yet');
  tasks.cancel();
  t.true(tasks.cancelled, 'and the press lands');
  const e = await t.rejects(() => tasks.awaitQuiet(), 'a primitive refuses now');
  t.true(e instanceof Cancelled, 'unwinding as Cancelled');
});

test('a window that asks a question is declined, not pressed through',
     async (t) => {
  // `keepDefaultName` presses A through a text box and B at a *question*, and
  // which of the two a window is decides between answering something nobody
  // asked and getting stuck in it. Both halves of that condition could be
  // flipped with the suite green.
  //
  // This is the same rule that cost a wallet ¥2900: A answers a question and B
  // declines it, and a job has no business answering anything.
  const sym = symbols();
  const state = new GameState(sym);
  // A screen with YES and NO on it, which is what a question looks like.
  state.screen = () => ({ says: (w) => w === 'YES' || w === 'NO' });
  const gb = new FakeGameBoy({ wram: worldRam(sym, { windowStack: 1 }) });
  const tasks = new Tasks(gb, state, () => {}, fakeRom());
  const pressed = [];
  tasks.push = async (btn) => { pressed.push(btn); };
  tasks.step = async () => {};
  t.true(await tasks.keepDefaultName(), 'it answers the question');
  t.eq(pressed, ['B'], 'by declining it');
});

test('a window with no question in it is pressed through', async (t) => {
  const sym = symbols();
  const state = new GameState(sym);
  // On screen, but no YES and no NO: an ordinary text box.
  state.screen = () => ({ says: () => false });
  const gb = new FakeGameBoy({ wram: worldRam(sym, { windowStack: 1 }) });
  const tasks = new Tasks(gb, state, () => {}, fakeRom());
  const pressed = [];
  tasks.push = async (btn) => { pressed.push(btn); };
  tasks.step = async () => {};
  t.false(await tasks.keepDefaultName(2), 'it never finds a question');
  t.true(pressed.every((p) => p === 'A'), 'having pressed on through with A');
  t.true(pressed.length > 0, 'rather than doing nothing');
});

test('with no screen reader at all, an open window is taken as the question',
     async (t) => {
  // `!sc` is the lenient half: a cartridge whose symbol file has no tilemap
  // cannot be asked what the window says, and the window being open is then
  // the best evidence there is. Worth pinning because it is the branch a hack
  // takes, and the one nobody runs.
  const sym = symbols();
  const state = new GameState(sym);
  state.screen = null;
  const gb = new FakeGameBoy({ wram: worldRam(sym, { windowStack: 1 }) });
  const tasks = new Tasks(gb, state, () => {}, fakeRom());
  const pressed = [];
  tasks.push = async (btn) => { pressed.push(btn); };
  tasks.step = async () => {};
  t.true(await tasks.keepDefaultName(), 'the open window is the question');
  t.eq(pressed, ['B'], 'and it declines');
});

// --- getting out of a conversation, and out of its text -------------------
//
// `closeConversation` and `settleText` are the two primitives every job leans
// on to clear the screen, and neither had a behavioural test — only that they
// could be cancelled. Both of their exit conditions could be inverted with
// the suite green.

/** A pilot whose screen state is a script the test writes. */
function talking(states) {
  const sym = symbols();
  const state = new GameState(sym);
  const gb = new FakeGameBoy({ wram: worldRam(sym, {}) });
  const tasks = new Tasks(gb, state, () => {}, fakeRom());
  const pressed = [];
  let i = 0;
  tasks.step = async () => {};
  tasks.pump = async () => {};
  tasks.push = async (b) => { pressed.push(b); };
  tasks.snap = async () => {
    const at = states[Math.min(i++, states.length - 1)];
    return { ...state.read(worldRam(sym, {})), inBattle: false, ...at };
  };
  return { tasks, pressed };
}

test('a conversation already over is not pressed at', async (t) => {
  const { tasks, pressed } = talking([{ windowOpen: false, scriptRunning: false }]);
  t.true(await tasks.closeConversation(), 'it was already clear');
  t.eq(pressed, [], 'and nothing was pressed');
});

test('a box the game is holding up is closed with B', async (t) => {
  // B rather than A, and that is the whole rule: A answers a question and B
  // declines it, and a job has no business answering anything. The same rule
  // that cost a wallet ¥2900.
  const { tasks, pressed } = talking([
    { windowOpen: true, scriptRunning: true },
    { windowOpen: true, scriptRunning: true },
    { windowOpen: false, scriptRunning: false },
  ]);
  t.true(await tasks.closeConversation(), 'it got clear');
  t.eq(pressed, ['B', 'B'], 'twice, and with B');
});

test('a closed box with the script still running is not the end of it',
     async (t) => {
  // Measured at a mart counter: the boxes closed, `wScriptMode` stayed
  // non-zero, and the clerk's confirmation was back a moment later. Which is
  // why this asks about the *script* as well as the window — and why
  // `closeMenus`, which only asks about the window, is the wrong answer here.
  const { tasks, pressed } = talking([
    { windowOpen: false, scriptRunning: true },
    { windowOpen: false, scriptRunning: true },
    { windowOpen: false, scriptRunning: false },
  ]);
  t.true(await tasks.closeConversation(), 'it waited the script out');
  t.eq(pressed.length, 2, 'pressing while it ran');
});

test('a conversation that will not end is reported, not pressed for ever',
     async (t) => {
  const { tasks, pressed } = talking([{ windowOpen: true, scriptRunning: true }]);
  t.false(await tasks.closeConversation(4), 'it says so');
  t.eq(pressed.length, 4, 'having pressed its bound and stopped');
});

test('settling text presses A, and stops when the world is quiet', async (t) => {
  // A rather than B here, and deliberately: this is for text the pilot has
  // *already* decided to get through, where B in some boxes means "back out"
  // and leaves the script where it was.
  const { tasks, pressed } = talking([
    { windowOpen: true, scriptRunning: false },
    { windowOpen: true, scriptRunning: false },
    { windowOpen: false, scriptRunning: false },
  ]);
  await tasks.settleText(40);
  t.eq(pressed, ['A', 'A'], 'two taps, then quiet');
});

test('and it does not mistake a battle for a quiet world', async (t) => {
  // The third clause. A battle has no window and no script running, so a
  // reader that asked only those two would return at once — and the text this
  // is called to clear is the text a battle is showing.
  const { tasks, pressed } = talking([
    { windowOpen: false, scriptRunning: false, inBattle: true },
  ]);
  await tasks.settleText(3);
  t.eq(pressed, ['A', 'A', 'A'], 'it kept pressing through the battle');
});

test('a script with no box up is still something to press through', async (t) => {
  const { tasks, pressed } = talking([
    { windowOpen: false, scriptRunning: true },
  ]);
  await tasks.settleText(2);
  t.eq(pressed, ['A', 'A'], 'the script is the thing running');
});

test('a box that clears on the last press is not reported as stuck', async (t) => {
  // The loop looks *before* it presses, so the press that finally worked has
  // no iteration left to notice it. The answer is a fresh read afterwards —
  // without it, a conversation that ended on the last allowed press is
  // reported as one that would not close, and the caller goes looking for a
  // screen that is no longer there.
  const { tasks, pressed } = talking([
    { windowOpen: true, scriptRunning: true },
    { windowOpen: true, scriptRunning: true },
    { windowOpen: false, scriptRunning: false },
  ]);
  t.true(await tasks.closeConversation(2), 'the last press did it');
  t.eq(pressed.length, 2, 'having spent exactly its bound');
});
