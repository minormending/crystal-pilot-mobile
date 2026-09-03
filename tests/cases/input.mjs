// The joypad, which is the one part of gb.js worth testing without a Game Boy:
// what the core is told is held, and when.
//
// The real GameBoy class with a stub core rather than the harness's FakeGameBoy,
// because the thing under test *is* GameBoy's own bookkeeping. `document` is
// stubbed for the same reason run() consults it -- a hidden page steps frames
// directly, which is exactly the path a test wants: no animation frames.
import { test } from '../harness.mjs';
import { GameBoy } from '../../app/gb.js';

function machine() {
  if (typeof globalThis.document === 'undefined') {
    globalThis.document = { hidden: true };
  }
  const gb = new GameBoy();
  const sent = [];
  gb.core = {
    setJoypadState(state) { sent.push({ ...state }); },
    async _runWasmExport() {},
    async _runNumberOfFrames() {},
  };
  gb.ready = true;
  return { gb, sent, last: () => sent[sent.length - 1] };
}

test('holding and releasing tells the core exactly what is down', async (t) => {
  const { gb, last } = machine();
  gb.hold('RIGHT');
  t.eq(last().RIGHT, true, 'the direction goes down');
  gb.hold('A');
  t.eq([last().RIGHT, last().A], [true, true], 'and both stay down together');
  gb.release('RIGHT');
  t.eq([!!last().RIGHT, last().A], [false, true], 'releasing one leaves the other');
  gb.releaseAll();
  t.eq(Object.keys(last()).length, 0, 'and letting go clears the lot');
});

test('a press puts back whatever was already being held', async (t) => {
  // Only a task could press when press() was written, and a task runs with the
  // player's input locked out, so clearing the joypad outright was harmless.
  // Presses arrive from a watching device now: one press during a held
  // direction would drop it, while `held` went on claiming it was down and the
  // pad on both devices lit a button that was not pressed.
  const { gb, last } = machine();
  gb.hold('RIGHT');
  await gb.press('A');
  t.true(gb.held.has('RIGHT'), 'the app still knows the direction is held');
  t.eq(last().RIGHT, true, 'and so does the core');
  t.false(!!last().A, 'while the pressed button has been let go');
});

test('a press with nothing held leaves nothing held', async (t) => {
  const { gb, last } = machine();
  await gb.press('START');
  t.eq(Object.keys(last()).length, 0, 'the joypad ends empty');
  t.eq(gb.held.size, 0, 'and so does the set');
});
