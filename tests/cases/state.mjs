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

test('one of the two markers is not a save, and neither is a short battery',
     async (t) => {
  // The game validates a save with *two* magic bytes at two addresses, and
  // the whole point of there being two is that both have to be right. A
  // check that took either one would call a half-written battery a save --
  // and the thing downstream of this answer is whether the pilot overwrites
  // somebody's game.
  const sym = symbols();
  const s = new GameState(sym);
  const at = (name) => sym.bank(name) * 0x2000 + (sym.addr(name) - 0xa000);
  const one = new Uint8Array(32768);
  one[at('sCheckValue1')] = 99;
  t.false(s.saveIsPresent(one), 'the first marker alone');
  const two = new Uint8Array(32768);
  two[at('sCheckValue2')] = 127;
  t.false(s.saveIsPresent(two), 'the second marker alone');
  const wrong = markSaved(new Uint8Array(32768), sym);
  wrong[at('sCheckValue2')] = 126;
  t.false(s.saveIsPresent(wrong), 'and the right pair of addresses, off by one');

  // A battery too short to hold the bank the markers live in cannot be read
  // at all, and reading past the end gives `undefined` -- which compares
  // unequal to everything and would answer "no save" by accident rather than
  // on purpose. Both markers sit above one bank, so one bank is the bound.
  t.false(s.saveIsPresent(new Uint8Array(0x2000 - 1)), 'a battery under a bank');
  t.false(s.saveIsPresent(markSaved(new Uint8Array(0x2000), sym).slice(0, 0x2000)),
          'and one exactly a bank long, which does not reach the markers');
  t.false(s.saveIsPresent(null), 'nor no battery at all');
});

test('the intro name menu is told apart by all three of its numbers', async (t) => {
  // Five items, a right border at 10, and a top border at 0. It is asked
  // after every press during the intro, so a check that any one of those
  // three satisfies would answer yes to some other box mid-intro and start
  // typing a name into it.
  const sym = symbols();
  const s = new GameState(sym);
  const win = (items, right, top) => {
    const w = new Uint8Array(s.menuWindow.len);
    w[s.a.menuItems - s.menuWindow.addr] = items;
    w[s.a.menuRight - s.menuWindow.addr] = right;
    w[s.a.menuTop - s.menuWindow.addr] = top;
    return w;
  };
  const { items, right } = s.e.nameMenu;
  t.true(s.nameMenuUp(win(items, right, 0)), 'all three, and it is the name menu');
  t.false(s.nameMenuUp(win(items + 1, right, 0)), 'one item more is not');
  t.false(s.nameMenuUp(win(items, right + 1, 0)), 'nor a wider box');
  t.false(s.nameMenuUp(win(items, right, 1)), 'nor one a row further down');
  t.false(s.nameMenuUp(win(0, 0, 0)), 'nor nothing drawn at all');
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

test('badges are counted as bits, across both bytes', async (t) => {
  // A count rather than a set, because the only question this app asks of a
  // badge is *has anything changed since a route turned me back* -- and that is
  // answerable without a table saying which badge opens which route, which is
  // a thing no cartridge writes down.
  //
  // Bits, not bytes: eight Johto badges live in one byte, so anything counting
  // bytes reads a full case as one and never expires a write-off again.
  const sym = symbols();
  const state = new GameState(sym);
  const read = (badges) => state.read(worldRam(sym, { badges })).badges;
  t.eq(read(0), 0, 'a new game has none');
  t.eq(read(1), 1, 'Falkner');
  t.eq(read(3), 3, 'three of them, still inside the first byte');
  t.eq(read(8), 8, 'all of Johto, which fills that byte exactly');
  t.eq(read(9), 9, 'and the ninth is in the next one');
});

test('which badge is in the case, bit by bit and across both bytes',
     async (t) => {
  // **Driven through the real reader**, because the module that consumes this
  // stubs it -- and the pass before found out what a stub is worth: it agrees
  // with whoever wrote it. Sixteen of the seventeen mutations of these two
  // lines survived while the only test was over a fake.
  //
  // Which bit means which badge is a fact about the story and belongs to a
  // title; counting is this file's job. Measured on Crystal: Falkner sets bit
  // 0 of `wJohtoBadges`.
  const sym = symbols();
  const state = new GameState(sym);
  const at = sym.addr('wJohtoBadges') - 0xc000;
  const withBytes = (johto, kanto = 0) => {
    const wram = worldRam(sym, {});
    wram[at] = johto;
    wram[at + 1] = kanto;
    return wram;
  };

  const one = withBytes(0b00000001);
  t.true(state.hasBadge(one, 0), 'Falkner is bit 0');
  t.false(state.hasBadge(one, 1), 'and the second badge is not in yet');
  t.false(state.hasBadge(one, 7), 'nor the eighth');

  const eighth = withBytes(0b10000000);
  t.true(state.hasBadge(eighth, 7), 'the eighth is the top bit of the first byte');
  t.false(state.hasBadge(eighth, 0), 'and the first is not set by it');

  // The second byte, which is what the `>> 3` is for: bit 8 is the low bit of
  // `wKantoBadges`, not the ninth bit of the first byte.
  const kanto = withBytes(0, 0b00000101);
  t.true(state.hasBadge(kanto, 8), 'bit 8 is the next byte along');
  t.false(state.hasBadge(kanto, 9), 'bit 9 is not set');
  t.true(state.hasBadge(kanto, 10), 'and bit 10 is');
  t.false(state.hasBadge(kanto, 0), 'while the first byte is empty');

  t.eq(state.hasBadge(one, null), null, 'no bit asked about is no answer');
  t.eq(state.hasBadge(one, undefined), null, 'and neither is none');
});

test('a cartridge whose symbol file has no badges says so, and not zero',
     async (t) => {
  // Null and none are different answers and are kept apart on purpose: one
  // means the pilot cannot tell, and a write-off that can never expire is the
  // safe reading of that. Zero means a new game, where the next badge will.
  const sym = symbols();
  // The same shape the tilemap's absence is tested with: a symbol table that
  // answers `has` with no rather than one that throws on `addr`.
  const bare = { has: (n) => n !== 'wJohtoBadges' && sym.has(n),
                 addr: (n) => sym.addr(n), bank: (n) => sym.bank(n) };
  t.eq(new GameState(bare).read(worldRam(sym, { badges: 4 })).badges, null,
       'it cannot say, which is not the same as none');
  t.eq(new GameState(sym).read(worldRam(sym, { badges: 4 })).badges, 4,
       'and one where the name is there');
});

test('an engine profile with fewer money bytes reads fewer', async (t) => {
  // The field exists so a hack that widened or narrowed the wallet says so
  // rather than being read at Crystal's width.
  const sym = symbols();
  const two = new GameState(sym, { ...new GameState(sym).e, moneyBytes: 2 });
  const s = two.read(worldRam(sym, { money: 0x0bb8 }));
  t.eq(s.money, 0x000b, 'the top two of the three');
});

// --- the game's own record of what has happened -----------------------------
//
// Every scripted gate in Gen 2 is a script reading one bit of `wEventFlags`,
// which makes this the address that turns "something turned me back" into a
// question with an answer. Read out of the cartridge: the man on Route 32
// checks event $2d before letting anyone south out of Violet, and the only
// script in the ROM that sets $2d is Elm's aide in Violet's Pokémon Center,
// asking you to take the Egg.

test('an event that has happened reads as true, and its neighbours do not',
     async (t) => {
  const sym = symbols();
  const state = new GameState(sym);
  const s = worldRam(sym, { events: [0x2d] });
  t.true(state.hasEvent(s, 0x2d), 'the bit that was set');
  t.false(state.hasEvent(s, 0x2c), 'the one below it');
  t.false(state.hasEvent(s, 0x2e), 'the one above it');
  t.false(state.hasEvent(s, 0x5d), 'and one in another byte');
});

test('events are numbered across the bytes, low bit of the first byte first',
     async (t) => {
  // The same numbering `hasBadge` uses, and the same numbering the game's own
  // EventFlagAction walks. Bit 8 is the low bit of the *second* byte, which is
  // the arithmetic worth pinning: an off-by-one here reads a neighbouring
  // event and answers confidently about the wrong gate.
  const sym = symbols();
  const state = new GameState(sym);
  const s = worldRam(sym, { events: [0, 8, 15] });
  t.true(state.hasEvent(s, 0), 'the first bit of the first byte');
  t.true(state.hasEvent(s, 8), 'the first bit of the second');
  t.true(state.hasEvent(s, 15), 'the last bit of the second');
  t.false(state.hasEvent(s, 7), 'the last bit of the first is not set');
  t.false(state.hasEvent(s, 16), 'nor the first of the third');
});

test('a cartridge that will not say answers null, not false', async (t) => {
  // The distinction the whole feature rests on. A gate the app cannot read must
  // never be reported as a gate that is closed: that turns "I do not know" into
  // a confident wrong answer, which is this repository's most expensive class
  // of bug.
  const sym = symbols();
  const blind = new GameState({ ...sym, has: (n) => n !== 'wEventFlags',
                                addr: sym.addr, bank: sym.bank });
  const s = worldRam(sym, { events: [0x2d] });
  t.eq(blind.hasEvent(s, 0x2d), null, 'no wEventFlags, no answer');
  const state = new GameState(sym);
  t.eq(state.hasEvent(s, null), null, 'and no bit asked about is no answer');
  t.eq(state.hasEvent(s, undefined), null, 'either way of not asking');
});
