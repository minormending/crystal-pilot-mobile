// When the game is allowed to make a noise.
//
// `audibleNow` is the whole rule and it is pure, so it is tested here rather
// than inferred from the four listeners that feed it. The conditions are not
// variations on caution: each one is a different reason for silence, and the
// tests are named after the reasons.
import { test } from '../harness.mjs';
import { audibleNow, GameBoy } from '../../gbcore/gb.js';

test('silent until somebody asks for sound', async (t) => {
  t.false(audibleNow({ sound: false, speed: 1 }), 'off is off');
  t.true(audibleNow({ sound: true, speed: 1 }), 'and on at ordinary speed is on');
  t.false(audibleNow(), 'a call with nothing said means silence');
});

test('fast-forward is silent, because the APU makes samples per frame', async (t) => {
  // Sixteen times the frames is sixteen times the samples a second, which is
  // not the game sped up, it is the game rendered wrong. Every emulator with a
  // fast-forward key does this.
  for (const speed of [2, 4, 8, 16]) {
    t.false(audibleNow({ sound: true, speed }), `${speed}× is muted`);
  }
  t.true(audibleNow({ sound: true, speed: 1 }), 'and 1× is not');
});

test('a job is silent, and for the same reason without a number on it', async (t) => {
  // A task drives frames as fast as the device manages and consults no speed
  // setting -- that is what a job is for -- so there is no multiplier to check,
  // only the fact that one is running.
  t.false(audibleNow({ sound: true, speed: 1, running: true }), 'a job mutes');
  t.true(audibleNow({ sound: true, speed: 1, running: false }), 'and ends the mute');
});

test('a watching device is silent, because the game is not on it', async (t) => {
  // No cartridge here: the picture arrives over WebRTC and the sound belongs to
  // the machine that has the game.
  t.false(audibleNow({ sound: true, speed: 1, watching: true }), 'watching is silent');
});

test('setAudible answers rather than throwing on a core with no audio', async (t) => {
  // It reaches the library rather than the wasm, and a half-built core answers
  // nothing. Silence is the safe direction, so a caller who only asked for
  // sound is told no instead of being thrown at.
  const gb = new GameBoy();
  t.eq(await gb.setAudible(true), false, 'no core at all is a no');
  t.true(gb.audible, 'though the wish is remembered');

  gb.core = {};                                   // a core without the method
  t.eq(await gb.setAudible(true), false, 'a core missing _getAudioChannels is a no');

  gb.core = { async _getAudioChannels() { throw new Error('nope'); } };
  t.eq(await gb.setAudible(true), false, 'and one that throws is a no');

  let muted = null;
  gb.core = { async _getAudioChannels() {
    return { master: { mute() { muted = true; }, unmute() { muted = false; } } };
  } };
  t.eq(await gb.setAudible(true), true, 'a working core unmutes');
  t.eq(muted, false, 'by unmuting the master channel');
  await gb.setAudible(false);
  t.eq(muted, true, 'and mutes it again');
  t.false(gb.audible, 'with the flag following');
});

test('resumeAudio needs a core and never throws at its caller', async (t) => {
  const gb = new GameBoy();
  t.eq(await gb.resumeAudio(), false, 'no core is a no');
  gb.core = {};
  t.eq(await gb.resumeAudio(), false, 'a core without the method is a no');
  gb.core = { async resumeAudioContext() { throw new Error('suspended'); } };
  t.eq(await gb.resumeAudio(), false, 'a refusal is a no rather than a throw');
  let resumed = false;
  gb.core = { async resumeAudioContext() { resumed = true; } };
  t.eq(await gb.resumeAudio(), true, 'and a gesture resumes it');
  t.true(resumed, 'through the library');
});
