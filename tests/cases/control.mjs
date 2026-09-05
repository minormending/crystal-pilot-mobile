// Stopping a job, and the one table that says what a capture outcome means.
import { FakeGameBoy, fakeRom, symbols, test, worldRam } from '../harness.mjs';
import { GameState } from '../../gen2/state.js';
import { Cancelled, TaskBase } from '../../gbcore/taskbase.js';
import { Tasks } from '../../gen2/tasks.js';
import { captureOutcome } from '../../gen2/jobs.js';

function pilot(opts = {}) {
  const sym = symbols();
  const state = new GameState(sym);
  const gb = new FakeGameBoy({ wram: worldRam(sym, opts.world || {}), ...opts });
  return { sym, state, gb, tasks: new Tasks(gb, state, () => {}, fakeRom()) };
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
