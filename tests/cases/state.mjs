// state.js: turning a work-RAM snapshot into something the pilot can reason
// about. Cheap to test and worth testing, because everything downstream trusts
// it -- a misread here shows up much later as a bad decision.
import { FakeGameBoy, blindTo, markSaved, symbols, test, worldRam } from '../harness.mjs';
import { dvsOf, GameState, statusOf } from '../../gen2/state.js';
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
  const bare = blindTo(sym, 'wJohtoBadges');
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
  const blind = new GameState(blindTo(sym, 'wEventFlags'));
  const s = worldRam(sym, { events: [0x2d] });
  t.eq(blind.hasEvent(s, 0x2d), null, 'no wEventFlags, no answer');
  const state = new GameState(sym);
  t.eq(state.hasEvent(s, null), null, 'and no bit asked about is no answer');
  t.eq(state.hasEvent(s, undefined), null, 'either way of not asking');
});

// --- the rest of the party entry, and the two bit arrays --------------------

test('the four DV nibbles come out of the two bytes in the right order',
     async (t) => {
  // Handed over as the raw word, not as four numbers, so the fake does not
  // hold a second copy of the packing and agree with a reader that unpacks it
  // the same wrong way. $A73C is attack 10, defence 7, speed 3, special 12.
  const got = dvsOf(0xa73c);
  t.eq(got.atk, 10, 'the high nibble of the first byte');
  t.eq(got.def, 7, 'and the low one');
  t.eq(got.spd, 3, 'the high nibble of the second');
  t.eq(got.spc, 12, 'and its low one');
});

test('the HP DV is not stored anywhere and is assembled from the other four',
     async (t) => {
  // The one thing about DVs a reader cannot get by reading. Low bit of attack,
  // defence, speed, special, most significant first.
  t.eq(dvsOf(0x0000).hp, 0, 'all even is nothing');
  t.eq(dvsOf(0xffff).hp, 15, 'all odd is perfect');
  // atk 1 (odd), def 0 (even), spd 1 (odd), spc 0 (even) -> 1010 = 10
  t.eq(dvsOf(0x1010).hp, 10, 'and the bits keep their places');
  t.eq(dvsOf(0x0001).hp, 1, 'special is the least significant of the four');
  t.eq(dvsOf(0x1000).hp, 8, 'and attack the most');
});

test('a party entry says what a stat screen says', async (t) => {
  const sym = symbols();
  const state = new GameState(sym);
  const wram = worldRam(sym, {
    party: [{ species: 155, level: 13, hp: 35, maxHp: 37,
              stats: { atk: 22, def: 18, spd: 25, satk: 23, sdef: 19 },
              statExp: { hp: 1200, atk: 900, def: 400, spd: 1600, spc: 100 },
              dvWord: 0xa73c, happiness: 70, item: 73, exp: 1234 }],
  });
  const mon = state.monDetail(wram, 0);
  t.eq(mon.stats, { hp: 37, atk: 22, def: 18, spd: 25, satk: 23, sdef: 19 },
       'six stats, and HP is the max the party list already reads');
  t.eq(mon.statExp,
       { hp: 1200, atk: 900, def: 400, spd: 1600, spc: 100 },
       'five counters, because Special is one spent on two stats');
  t.eq(Object.keys(mon.dvs).length, 5, 'four nibbles and the derived HP');
  t.eq(mon.dvs.spc, 12, 'read from the word, not from a second layout');
  t.eq(mon.happiness, 70, 'happiness');
  t.eq(mon.item, 73, 'what it is holding');
  t.eq(mon.exp, 1234, 'and three big-endian bytes of experience');
  t.eq(mon.species, 155, 'with everything the party list already gave');
  t.eq(mon.hp, 35, 'including the HP the pilot flies on');
});

test('a slot the party does not hold is null, not an entry of zeroes',
     async (t) => {
  const sym = symbols();
  const state = new GameState(sym);
  const wram = worldRam(sym, { party: [{ species: 155, level: 5 }] });
  t.ne(state.monDetail(wram, 0), null, 'the one that is there');
  t.eq(state.monDetail(wram, 1), null, 'and the five that are not');
  t.eq(state.monDetail(wram, -1), null, 'nor before the first');
});

test('every move and every PP keeps its own slot', async (t) => {
  // Four indices written out four times, which is four chances to type the
  // same number twice. `tools/mutate` swapped them one at a time and nothing
  // failed, because every test until now gave a party member the same value
  // in every slot -- so the reader could have collapsed all four onto one and
  // passed.
  const sym = symbols();
  const state = new GameState(sym);
  const wram = worldRam(sym, {
    party: [{ species: 155, level: 5, moves: [33, 43, 108, 52],
              pp: [35, 30, 20, 25] }],
  });
  t.eq(state.party(wram)[0].moves, [33, 43, 108, 52], 'in the order they are in');
  t.eq(state.party(wram)[0].pp, [35, 30, 20, 25], 'and the PP beside them');
  t.eq(state.monDetail(wram, 0).moves, [33, 43, 108, 52],
       'and the deep read is the same read');
});

test('experience is three bytes, and the top one is not decoration',
     async (t) => {
  // 1234 fits in two, so a reader that dropped the top byte answered right for
  // every test there was. A Lv40 Pokemon on a slow curve is past a million.
  const sym = symbols();
  const state = new GameState(sym);
  const wram = worldRam(sym, { party: [{ species: 155, level: 40, exp: 1250000 }] });
  t.eq(state.monDetail(wram, 0).exp, 1250000, 'all three, big-endian');
});

test('a caught record the save does not hold is null rather than Lv0',
     async (t) => {
  const sym = symbols();
  const state = new GameState(sym);
  const wram = worldRam(sym, {
    party: [{ species: 155, level: 5 },
            { species: 16, level: 3, caughtBytes: [0xc5, 0x02] }],
  });
  t.eq(state.monDetail(wram, 0).caught, null,
       'zeroes are what a starter and a Gold save both hold');
  const got = state.monDetail(wram, 1).caught;
  t.eq(got.level, 5, 'the low six bits are the level it was caught at');
  t.eq(got.when, 'night', 'the top two are the time of day');
  t.eq(got.place, 2, 'and the second byte is the landmark');
});

test('the caught level is believed at both ends of its range and nowhere else',
     async (t) => {
  // Six bits hold 0 to 63, and the field is shared with a time-of-day in the
  // top two -- so the bound is doing real work rather than being tidy. Lv0 is
  // the save that does not say; anything else in range is a level.
  const sym = symbols();
  const state = new GameState(sym);
  const at = (byte) => {
    const wram = worldRam(sym, {
      party: [{ species: 155, level: 5, caughtBytes: [byte, 0] }],
    });
    return state.monDetail(wram, 0).caught;
  };
  t.eq(at(0), null, 'zero is not a level');
  t.eq(at(1).level, 1, 'one is');
  t.eq(at(63).level, 63, 'and so is the highest six bits can hold');
  // And 63 is genuinely the top: the two bits above it are the time of day, so
  // a byte of 0x45 is Lv5 in the morning and not a Pokemon caught at 69. There
  // is no upper bound in the code because the mask is one -- a `<= 100` there
  // would be a comparison with no path to being false.
  t.eq(at(0x45), { level: 5, when: 'morning', place: 0 },
       'the bits above the level are a different field entirely');
  t.eq(at(0x40), null, 'and a level of zero under them is still no record');
});

test('a time of day the record does not give is null, not a missing key',
     async (t) => {
  // The top two bits are 0 for "unknown", which the profile names as a null
  // entry rather than leaving off the end of the list -- so the reader answers
  // the same shape whether the save says or not.
  const sym = symbols();
  const state = new GameState(sym);
  const wram = worldRam(sym, {
    party: [{ species: 155, level: 5, caughtBytes: [0x05, 0] }],
  });
  const got = state.monDetail(wram, 0).caught;
  t.eq(got.when, null, 'null, and the level beside it is still read');
  t.eq(got.level, 5, 'which is the point of not refusing the whole record');
});

test('the Pokedex bit arrays are two lists of species, bounded by the count',
     async (t) => {
  const sym = symbols();
  const state = new GameState(sym);
  const wram = worldRam(sym, { caught: [1, 16, 155], seen: [1, 16, 155, 19] });
  const dex = state.dex(wram);
  t.eq(dex.caught, [1, 16, 155], 'species ids, in order, one bit each');
  t.eq(dex.seen, [1, 16, 155, 19].sort((a, b) => a - b),
       'and seen is the wider of the two');
});

test('the caught array stops at the last species, not at the last byte',
     async (t) => {
  // The two arrays are adjacent in work RAM -- wEndPokedexCaught and
  // wPokedexSeen are the same address on the cartridge -- so a reader that
  // rounded 251 bits up to a comfortable 256 would report the first five
  // species of *seen* as caught. Nothing in the bytes says where to stop; the
  // bound comes from the engine's species count.
  const sym = symbols();
  const state = new GameState(sym);
  const wram = worldRam(sym, { caught: [251], seen: [1, 2, 3, 4, 5] });
  const dex = state.dex(wram);
  t.eq(dex.caught, [251], 'the last species is in, and nothing next door is');
  t.eq(dex.seen, [1, 2, 3, 4, 5], 'which is itself read correctly');
});

test('and it starts at the first species, not at the byte before it',
     async (t) => {
  // The other end of the same arithmetic. Species ids are 1-based and the bits
  // are 0-based, so a loop starting at 0 asks for bit -1 -- which is the top
  // bit of the byte *in front of* the array, and reads as a species 0 nobody
  // has. wEventFlags ends immediately before it in the fake, as it does on the
  // cartridge, so setting its last bit is what makes that visible.
  const sym = symbols();
  const state = new GameState(sym);
  const wram = worldRam(sym, { events: [127], caught: [1, 2] });
  t.eq(state.dex(wram).caught, [1, 2], 'no species zero, whatever is behind it');
});

test('a cartridge that keeps one of the two arrays answers with the one it has',
     async (t) => {
  // `caught` and `seen` are named separately in the symbol file and a hack
  // could carry either alone. Refusing both because one is missing would lose
  // a list that is sitting right there.
  const sym = symbols();
  const half = new GameState(blindTo(sym, 'wPokedexCaught'));
  const dex = half.dex(worldRam(sym, { caught: [1], seen: [1, 16] }));
  t.eq(dex.caught, null, 'cannot say, which is not "none"');
  t.eq(dex.seen, [1, 16], 'and the half it can read is read');
});

test('a cartridge with no Pokedex flags says nothing rather than "none caught"',
     async (t) => {
  const sym = symbols();
  const blind = new GameState(blindTo(sym, 'wPokedexCaught', 'wPokedexSeen'));
  t.eq(blind.dex(worldRam(sym, { caught: [1] })), null,
       'null, which is a different answer from an empty dex');
});
