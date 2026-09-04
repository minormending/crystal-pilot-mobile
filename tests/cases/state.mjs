// state.js: turning a work-RAM snapshot into something the pilot can reason
// about. Cheap to test and worth testing, because everything downstream trusts
// it -- a misread here shows up much later as a bad decision.
import { FakeGameBoy, symbols, test, worldRam, markSaved } from '../harness.mjs';
import { GameState, MAX_PARTY, TRAINER_BATTLE } from '../../gen2/state.js';

test('a party is read back with levels, HP and moves intact', async (t) => {
  const sym = symbols();
  const s = new GameState(sym);
  const wram = worldRam(sym, {
    party: [
      { species: 155, level: 14, hp: 19, maxHp: 44, moves: [33, 43, 0, 0], pp: [35, 30, 0, 0] },
      { species: 16, level: 3, hp: 0, maxHp: 15 },
    ],
  });
  const read = s.read(wram);
  t.eq(read.party.length, 2, 'party size');
  t.eq(read.party[0].level, 14, 'lead level');
  t.eq(read.party[0].hp, 19, 'lead HP');
  t.eq(read.party[0].maxHp, 44, 'lead max HP');
  t.eq(read.party[0].moves, [33, 43, 0, 0], 'lead moves');
  t.eq(read.party[1].hp, 0, 'a fainted second');
});

test('PP is masked to its low six bits, so PP Ups do not read as extra PP', async (t) => {
  const sym = symbols();
  const s = new GameState(sym);
  // 0xC0 is two PP Ups with zero PP left. Reading the byte whole would say 192.
  const wram = worldRam(sym, { party: [{ moves: [33, 0, 0, 0], pp: [0xc0, 0, 0, 0] }] });
  t.eq(s.read(wram).party[0].pp[0], 0, 'PP with the PP Up bits stripped');
});

test('the world is only live when the map is being handled', async (t) => {
  const sym = symbols();
  const s = new GameState(sym);
  t.true(s.read(worldRam(sym, { mapStatus: 2, map: [24, 3] })).worldLoaded,
         'status 2 with a map is live');
  t.false(s.read(worldRam(sym, { mapStatus: 1, map: [24, 3] })).worldLoaded,
          'status 1 is the transient after a battle, not a live world');
  t.false(s.read(worldRam(sym, { mapStatus: 2, map: [0, 0] })).worldLoaded,
          'map 0 is not a place');
});

test('the ball pocket counts kinds, not balls', async (t) => {
  const sym = symbols();
  const s = new GameState(sym);
  // wNumBalls is how many *kinds* are carried; the quantity is the second byte.
  const read = s.read(worldRam(sym, { balls: [[5, 40], [4, 10]] }));
  t.eq(read.balls, [[5, 40], [4, 10]], 'both kinds with their quantities');
});

test('a battery with no save in it is not mistaken for one that has', async (t) => {
  const sym = symbols();
  const s = new GameState(sym);
  const blank = new Uint8Array(32768);
  t.false(s.saveIsPresent(blank), 'a blank battery');

  // The trap this replaced: a never-saved battery still has a few non-zero
  // bytes, so "any byte is set" calls a blank cartridge saved.
  const stray = new Uint8Array(32768);
  [3043, 3044, 3176].forEach((i) => { stray[i] = 0xff; });
  t.false(s.saveIsPresent(stray), 'stray non-zero bytes are not a save');

  t.true(s.saveIsPresent(markSaved(new Uint8Array(32768), sym)),
         'the cartridge markers are');
});

test('the shared constants are the ones the game uses', async (t) => {
  t.eq(TRAINER_BATTLE, 2, 'wBattleMode 2 is a trainer');
  t.eq(MAX_PARTY, 6, 'six party slots');
});
