// Waiting for the hour, and the three different pieces of news that can end it.
//
// The job exists because a third of Johto's grass is behind the time of day.
// Whether waiting is *quick* is a fact about the emulator that no test here can
// settle -- a fake clock moves when the fake says it does -- so what these
// assert is the half that is this code's: that it stops when the hour arrives,
// that it tells a clock which will not move apart from a game which is not
// running, and that neither of those is reported as the other.
import { FakeGameBoy, fakeRom, symbols, test, worldRam } from '../harness.mjs';
import { GameState } from '../../gen2/state.js';
import { Tasks } from '../../gen2/tasks.js';
import { gen2 } from '../../gen2/engine.js';

const MORNING = 0, DAY = 1, NIGHT = 2;

/**
 * A pilot standing in a world whose clock is whatever the script says.
 *
 * `hour` and `world` are functions of the frames run so far, which is the only
 * honest shape for this: the job's whole method is *run frames and look again*,
 * so a fake that answered the same thing every time could not tell a job that
 * waits from one that returns immediately.
 *
 * `playing` is the other half. The game's playtime counter ticks once a frame
 * while it runs, and it is what separates "the clock will not move" from
 * "nothing is moving" -- so a fake that always advanced it could not produce
 * the second.
 */
function waiter({ hour = () => DAY, playing = true, world = () => ({}) } = {}) {
  const sym = symbols();
  const state = new GameState(sym);
  const said = [];
  const gb = new FakeGameBoy();
  const tasks = new Tasks(gb, state, (m) => said.push(m), fakeRom());
  let frames = 0;
  tasks.step = async (n = 1) => { frames += n; };
  tasks.snap = async () => state.read(worldRam(sym, {
    timeOfDay: hour(frames),
    playSeconds: playing ? Math.floor(frames / 60) : 0,
    ...world(frames),
  }));
  return { tasks, said, frames: () => frames };
}

test('a wait stops the moment the hour arrives', async (t) => {
  const { tasks, frames } = waiter({ hour: (f) => (f >= 7200 ? NIGHT : DAY) });
  const r = await tasks.waitForHour(NIGHT, { maxGameHours: 1 });
  t.true(r.ok, 'it got there');
  t.contains(r.message, 'night', 'and says which hour it is');
  t.eq(frames(), 7200, 'stopping at the look that found it, not at the bound');
});

test('an hour it is already in costs nothing', async (t) => {
  const { tasks, frames } = waiter({ hour: () => NIGHT });
  const r = await tasks.waitForHour(NIGHT);
  t.true(r.ok, 'ok');
  t.contains(r.message, 'already', 'and says so rather than pretending to work');
  t.eq(frames(), 0, 'no frames run at all');
});

test('a clock that will not move is not the same news as a game that is not '
     + 'running', async (t) => {
  // The distinction the whole job is shaped around. Both end at the bound and
  // both report failure, and the remedies could not be further apart: one is
  // "come back this evening" and the other is "something is stuck".
  const stuck = waiter({ hour: () => DAY, playing: true });
  const frozen = await stuck.tasks.waitForHour(NIGHT, { maxGameHours: 1 });
  t.false(frozen.ok, 'the hour never came');
  t.contains(frozen.message, 'does not follow the pilot',
             'the clock is the real one');

  const dead = waiter({ hour: () => DAY, playing: false });
  const nothing = await dead.tasks.waitForHour(NIGHT, { maxGameHours: 1 });
  t.false(nothing.ok, 'also failed');
  t.contains(nothing.message, 'did not advance at all',
             'and blames the game rather than the clock');
  t.ne(frozen.message, nothing.message, 'which are two different sentences');
});

test('the bound is spent in game hours, not in looks', async (t) => {
  // A bound in iterations would mean the wait got shorter every time the chunk
  // got bigger, which is a patience that depends on an implementation detail.
  const { tasks, frames } = waiter({ hour: () => DAY });
  await tasks.waitForHour(NIGHT, { maxGameHours: 2 });
  t.eq(frames(), 2 * 3600 * 60, 'two game hours of frames, and then it stops');
});

test('an hour on the way is said, because it is the evidence', async (t) => {
  // Reaching a *different* hour proves the clock is moving, which is the thing
  // in doubt -- so it is worth a line even though it is not the hour asked for.
  const { tasks, said } = waiter({
    hour: (f) => (f >= 3600 ? DAY : MORNING),
  });
  await tasks.waitForHour(NIGHT, { maxGameHours: 1 });
  t.true(said.some((m) => m.includes('it is day now')),
         'it said the clock moved');
});

test('a wait refuses the two states it cannot stand still in', async (t) => {
  const battling = waiter({ world: () => ({ battleMode: 1, enemy: { species: 16 } }) });
  t.contains((await battling.tasks.waitForHour(NIGHT)).message,
             'finish the battle', 'a battle is not standing still');
  const titled = waiter({ world: () => ({ mapStatus: 0 }) });
  t.contains((await titled.tasks.waitForHour(NIGHT)).message,
             'start a game first', 'and neither is the title screen');
});

test('something that starts while it waits ends the wait', async (t) => {
  // Standing in the overworld doing nothing is the whole method, so anything
  // that stops being true of that has stopped the job -- and saying "still
  // morning" through a battle would be a job describing a world it is no
  // longer in.
  const { tasks } = waiter({
    hour: () => DAY,
    world: (f) => (f >= 7200 ? { battleMode: 1, enemy: { species: 16 } } : {}),
  });
  const r = await tasks.waitForHour(NIGHT, { maxGameHours: 1 });
  t.false(r.ok, 'not a success');
  t.contains(r.message, 'interrupted', 'and it says what happened');
});

test('Stop between looks ends it where it is', async (t) => {
  const w = waiter({ hour: () => DAY });
  // Set from a progress line, which is the one moment the loop is between a
  // step and the check at the top -- the path a Stop pressed during `step`
  // does not take, because that one throws out of the job entirely.
  w.tasks.onProgress = () => { w.tasks.cancelled = true; };
  const r = await w.tasks.waitForHour(NIGHT, { maxGameHours: 1 });
  t.false(r.ok, 'stopped is not success');
  t.contains(r.message, 'stopped', 'and it says so rather than blaming a clock');
});

test('a cartridge that cannot say what time it is does not wait for one',
     async (t) => {
  const { tasks } = waiter();
  tasks.state.a.timeOfDay = null;
  const r = await tasks.waitForHour(NIGHT);
  t.false(r.ok, 'refused');
  t.contains(r.message, 'does not say what time it is',
             'which is a different answer from "it is not night"');
});

test('the blocks are named once, by the engine', async (t) => {
  // Two lists of the three thirds of a day would be the same fact twice, and
  // the encounter table is indexed by them -- so the names and the block count
  // have to agree or one of them is describing a different cartridge.
  t.eq(gen2.timeNames.length, gen2.encounter.blocks,
       'as many names as there are blocks');
  t.eq(gen2.timeNames[NIGHT], 'night', 'and in wTimeOfDay order');
});
