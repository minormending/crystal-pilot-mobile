// state.js: turning a work-RAM snapshot into something the pilot can reason
// about. Cheap to test and worth testing, because everything downstream trusts
// it -- a misread here shows up much later as a bad decision.
import { FakeGameBoy, symbols, test, worldRam, markSaved } from '../harness.mjs';
import { GameState, statusOf } from '../../gen2/state.js';
import { gen2 } from '../../gen2/engine.js';

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
  // On the profile now, not exported from this module. They were module-level
  // constants computed from the stock profile at import time, which meant a
  // title that changed one had it honoured in `party()` and nowhere else.
  t.eq(gen2.trainerBattle, 2, 'wBattleMode 2 is a trainer');
  t.eq(gen2.maxParty, 6, 'six party slots');
});

// --- what is wrong besides the HP -------------------------------------------

test('the status byte reads as a list of keys', async (t) => {
  // Declared in the engine profile since it was written, and read by nothing
  // for ten passes. What that cost: poison ticks a Pokémon while you *walk*,
  // so a grind or a journey with a poisoned lead bleeds HP per step -- and the
  // walk to a Center could kill the thing it was going to heal, with the app
  // reporting only that the party was hurt.
  t.eq(statusOf(0x00), [], 'a well Pokémon');
  t.eq(statusOf(0x08), ['psn'], 'poisoned');
  t.eq(statusOf(0x40), ['par'], 'paralysed');
  t.eq(statusOf(0x10), ['brn'], 'burned');
  t.eq(statusOf(0x20), ['frz'], 'frozen');
});

test('sleep is a counter, not a flag', async (t) => {
  // The low three bits hold how many turns are left, so `byte & 0x04` is false
  // of a Pokémon asleep for three more turns -- which is the sort of thing that
  // reads as working until it does not.
  t.eq(statusOf(0x03), ['slp'], 'asleep for three more turns');
  t.eq(statusOf(0x01), ['slp'], 'and for one');
  t.eq(statusOf(0x07), ['slp'], 'and for seven, which is the whole mask');
});

test('two things can be wrong at once', async (t) => {
  t.eq(statusOf(0x50).sort(), ['brn', 'par'], 'burned and paralysed');
});

test('a cartridge whose profile names no status bits reports none', async (t) => {
  t.eq(statusOf(0xff, { statusBits: {} }), [], 'nothing declared, nothing read');
});

test('the party reader carries it', async (t) => {
  const sym = symbols();
  const state = new GameState(sym);
  const s = state.read(worldRam(sym, { party: [
    { hp: 20, maxHp: 20, statusByte: 0x08 },
    { hp: 12, maxHp: 20, statusByte: 0x00 },
  ] }));
  t.eq(s.party[0].status, ['psn'], 'the poisoned one');
  t.eq(s.party[1].status, [], 'and the well one');
  t.eq(s.party[0].hp, 20, 'at full HP, which is the case the app used to miss');
});

// --- the wallet --------------------------------------------------------------

test('money is three bytes, big-endian, plain binary', async (t) => {
  // Measured on a new game rather than inferred: [0x00, 0x0b, 0xb8] reads 3000,
  // and 3000 is what Crystal starts you with. Worth pinning because the bytes
  // next door are *not* the same encoding -- `wMartItem1BCD` and its siblings
  // hold the mart's prices as BCD, so the obvious generalisation is wrong.
  const sym = symbols();
  const state = new GameState(sym);
  const read = (money) => state.read(worldRam(sym, { money })).money;
  t.eq(read(3000), 3000, 'a new game');
  t.eq(read(0), 0, 'and a broke one');
  t.eq(read(999999), 999999, 'up to the cap the game enforces');
  t.eq(read(300), 300, 'and the price of a potion');
});

test('an engine profile with fewer money bytes reads fewer', async (t) => {
  // The field exists so a hack that widened or narrowed the wallet says so
  // rather than being read at Crystal's width.
  const sym = symbols();
  const two = new GameState(sym, { ...new GameState(sym).e, moneyBytes: 2 });
  const s = two.read(worldRam(sym, { money: 0x0bb8 }));
  t.eq(s.money, 0x000b, 'the top two of the three');
});
