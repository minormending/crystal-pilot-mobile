// Stopping a job, and the one table that says what a capture outcome means.
import { FakeGameBoy, fakeRom, symbols, test, worldRam } from '../harness.mjs';
import { GameState } from '../../app/state.js';
import { Cancelled, TaskBase } from '../../app/taskbase.js';
import { Tasks } from '../../app/tasks.js';
import { captureOutcome } from '../../app/jobs.js';

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
