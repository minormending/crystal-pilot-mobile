// Waiting for the hour, and the three different pieces of news that can end it.
//
// The job exists because a third of Johto's grass is behind the time of day.
// Whether waiting is *quick* is a fact about the emulator that no test here can
// settle -- a fake clock moves when the fake says it does -- so what these
// assert is the half that is this code's: that it stops when the hour arrives,
// that it tells a clock which will not move apart from a game which is not
// running, and that neither of those is reported as the other.
import { blindTo, FakeGameBoy, fakeRom, markSaved, symbols, test,
         worldRam } from '../harness.mjs';
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

// --- the clock in the save --------------------------------------------------
// Gen 2's clock is the hardware clock plus an offset the game keeps in the
// save, which is what makes the time of day editable at all. These hold the
// arithmetic and the refusals; whether an *edited* save loads is a question
// only a real cartridge can answer.

const sym = symbols();
const gs = new GameState(sym);

/** A battery with a clock offset in it, sealed the way the game seals one. */
function battery({ day = 2, hour = 21, minute = 30, second = 5 } = {}) {
  const sram = new Uint8Array(32768);
  markSaved(sram, sym);
  const at = (name) => gs.savedAt(sym.addr(name));
  sram[at('wStartDay')] = day;
  sram[at('wStartHour')] = hour;
  sram[at('wStartMinute')] = minute;
  sram[at('wStartSecond')] = second;
  gs.sealSave(sram);
  return sram;
}

test('a saved field is where work RAM had it, offset by the block', async (t) => {
  // Measured on a real cartridge: wMoney at $d84e lands on flat 9180 and reads
  // 3000 on a new game. The fake puts the block at the real addresses, so the
  // arithmetic here is the arithmetic there.
  const at = gs.savedAt(sym.addr('wStartHour'));
  t.eq(at, 8201 + (sym.addr('wStartHour') - sym.addr('wPlayerData')),
       'sGameData plus the distance from wPlayerData');
  t.true(at >= 8201 && at < 11139, 'and inside the saved block');
});

test('an address outside the saved block has no place in a battery',
     async (t) => {
  // Most of work RAM is not saved, so this bound is doing real work: without
  // it a caller would get an offset into whatever is next in the file and
  // write there.
  t.eq(gs.savedAt(sym.addr('wPlayerData') - 1), -1, 'before the block');
  t.eq(gs.savedAt(sym.addr('wPlayerData') + 100000), -1, 'and past the end');
});

test('the checksum is the sum of the block, and nothing cleverer', async (t) => {
  // Asserted as a sum of bytes the test put there rather than against the
  // reader's own answer, because "it agrees with itself" is what a wrong
  // checksum also does.
  const sram = new Uint8Array(32768);
  sram[8201] = 7; sram[9000] = 200; sram[11138] = 3;
  t.eq(gs.checksum(sram), 210, 'the three bytes, added');
  sram[11139] = 99;
  t.eq(gs.checksum(sram), 210, 'and nothing from past the end of the block');
});

test('sealing writes the sum little-endian, where the game looks for it',
     async (t) => {
  const sram = new Uint8Array(32768);
  sram[8201] = 0xff; sram[8202] = 0xff;   // 510, which needs both bytes
  t.true(gs.sealSave(sram), 'sealed');
  t.eq(sram[11533], 510 & 0xff, 'low byte first');
  t.eq(sram[11534], 510 >> 8, 'then the high one');
  t.eq(gs.storedChecksum(sram), gs.checksum(sram), 'and they agree');
});

test('moving the clock forward wraps the hour and carries the day', async (t) => {
  // The game's own arithmetic: DSTChecks.SetClockForward increments the hour,
  // wraps at 24, and carries one into the day. Doing that eight times is this.
  const out = gs.advanceClock(battery({ day: 2, hour: 21 }), 8);
  const at = (name) => gs.savedAt(sym.addr(name));
  t.eq(out[at('wStartHour')], 5, '21 and eight more is 5 the next day');
  t.eq(out[at('wStartDay')], 3, 'and the day went with it');
});

test('and moving it back borrows one', async (t) => {
  // `Math.trunc` would round -1/24 to zero here and leave the day behind,
  // which is a clock that goes back an hour and forward a day.
  const at = (name) => gs.savedAt(sym.addr(name));
  const out = gs.advanceClock(battery({ day: 2, hour: 3 }), -8);
  t.eq(out[at('wStartHour')], 19, 'three back eight is nineteen');
  t.eq(out[at('wStartDay')], 1, 'the day before');
});

test('a shift inside the day leaves the day alone', async (t) => {
  const at = (name) => gs.savedAt(sym.addr(name));
  const out = gs.advanceClock(battery({ day: 2, hour: 10 }), 5);
  t.eq(out[at('wStartHour')], 15, 'ten and five');
  t.eq(out[at('wStartDay')], 2, 'same day');
});

test('an edited battery is re-sealed, and the original is untouched',
     async (t) => {
  // A save whose bytes and checksum disagree is one the game refuses outright,
  // so an edit that forgot to re-seal would look like a corrupted cartridge.
  const before = battery({ hour: 21 });
  const was = gs.storedChecksum(before);
  const out = gs.advanceClock(before, 8);
  t.eq(gs.storedChecksum(out), gs.checksum(out), 'the copy is sealed');
  t.ne(gs.storedChecksum(out), was, 'with a different sum, because bytes moved');
  t.eq(gs.storedChecksum(before), was,
       'and the battery handed in was not written to at all');
});

test('the minutes and the seconds are not touched', async (t) => {
  // Whole hours only. The block boundaries are on the hour, so anything finer
  // is a change nobody asked for in a field the game also reads.
  const at = (name) => gs.savedAt(sym.addr(name));
  const out = gs.advanceClock(battery({ minute: 30, second: 5 }), 8);
  t.eq(out[at('wStartMinute')], 30, 'minutes');
  t.eq(out[at('wStartSecond')], 5, 'and seconds');
});

test('a cartridge that keeps its clock elsewhere is not edited by guesswork',
     async (t) => {
  const blind = new GameState(blindTo(sym, 'wStartHour'));
  t.eq(blind.advanceClock(battery(), 8), null,
       'null, rather than writing to where it would have been');
  const noBlock = new GameState(blindTo(sym, 'sGameData'));
  t.eq(noBlock.advanceClock(battery(), 8), null, 'and with no saved block either');
});
