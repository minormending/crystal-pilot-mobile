// A cartridge whose engine is not the stock one.
//
// Step five of the ROM-hack work is only real if a changed number is actually
// followed, so these tests hand the readers a profile that disagrees with
// Crystal in three ways -- a wider party entry, an eleventh character in a
// name, and four encounter slots instead of seven -- and check that what comes
// back is read at the new layout rather than the old one.
import { FakeGameBoy, symbols, test, worldRam } from '../harness.mjs';
import { gen2 } from '../../gen2/engine.js';
import { GameState } from '../../gen2/state.js';
import { RomData } from '../../gen2/romdata.js';
import { describeRows } from '../../app/rows.js';

const sym = symbols();
const WRAM_BYTES = 0x2000, GB_WRAM_START = 0xc000;

/** Work RAM with a party laid out at whatever stride the caller says. */
function ramWithParty(party, stride, mon) {
  const wram = new Uint8Array(WRAM_BYTES);
  const put = (addr, v) => { wram[addr - GB_WRAM_START] = v; };
  const put16 = (addr, v) => { put(addr, v >> 8); put(addr + 1, v & 0xff); };
  put(sym.addr('wPartyCount'), party.length);
  put(sym.addr('wMapStatus'), 2);
  put(sym.addr('wMapGroup'), 24);
  party.forEach((m, i) => {
    const base = sym.addr('wPartyMon1') + i * stride;
    put(base + mon.species, m.species);
    put(base + mon.level, m.level);
    put16(base + mon.hp, m.hp);
    put16(base + mon.maxHp, m.maxHp);
  });
  return wram;
}

test('a party is read at the stride the engine profile declares', async (t) => {
  const party = [{ species: 155, level: 5, hp: 20, maxHp: 20 },
                 { species: 16, level: 9, hp: 3, maxHp: 24 }];
  const wide = { ...gen2, partyStride: 0x40 };

  // Laid out at 0x40 and read with the stock 0x30: the second entry is read
  // from the middle of the first, which is the failure this guards.
  const stock = new GameState(sym).read(ramWithParty(party, 0x40, gen2.mon));
  t.false(stock.party[1].level === 9,
          'the stock stride cannot read a wider entry');

  const said = new GameState(sym, wide).read(ramWithParty(party, 0x40, gen2.mon));
  t.eq(said.party.length, 2, 'both entries are found');
  t.eq(said.party[1].level, 9, 'and the second is where the profile says');
  t.eq(said.party[1].hp, 3, 'with its HP intact');
});

test('a profile may move the fields inside an entry too', async (t) => {
  const moved = { ...gen2, mon: { ...gen2.mon, level: 0x25, hp: 0x28, maxHp: 0x2a } };
  const wram = ramWithParty([{ species: 155, level: 41, hp: 7, maxHp: 60 }],
                            gen2.partyStride, moved.mon);
  const said = new GameState(sym, moved).read(wram);
  t.eq(said.party[0].level, 41, 'the level is read from its new offset');
  t.eq(said.party[0].maxHp, 60, 'and so is the rest of the entry');
});

test('a cap the cartridge changed is the cap that is read', async (t) => {
  const eight = { ...gen2, maxParty: 8 };
  const party = Array.from({ length: 8 }, (_, i) =>
    ({ species: 10 + i, level: 5, hp: 1, maxHp: 1 }));
  const wram = ramWithParty(party, gen2.partyStride, gen2.mon);
  t.eq(new GameState(sym).read(wram).party.length, 6,
       'the stock profile stops at six, because the game does');
  t.eq(new GameState(sym, eight).read(wram).party.length, 8,
       'and a cartridge that raised it is believed');
});

/**
 * A ROM whose only content is a species-name table at the given stride.
 *
 * Addressed from where the symbol table says PokemonNames is, rather than from
 * zero: the reader asks for (bank, absolute address), and a fake that indexes
 * from zero answers every read with a terminator and every name with '?'.
 */
function romWithNames(names, stride) {
  const base = sym.addr('PokemonNames');
  const bytes = [];
  for (const n of names) {
    for (let i = 0; i < stride; i++) {
      // The game's own charmap: A-Z is 0x80..0x99, and '@' (0x50) terminates.
      bytes.push(i < n.length ? 0x80 + n.charCodeAt(i) - 65 : 0x50);
    }
  }
  const gb = new FakeGameBoy();
  gb.romByte = (bank, addr) => bytes[addr - base] ?? 0x50;
  return gb;
}

test('a name is read at the width the engine profile declares', async (t) => {
  const names = ['ABCDEFGHIJK', 'LMNOP'];
  const eleven = { ...gen2, nameLength: 11 };
  const gb = romWithNames(names, 11);

  const stock = new RomData(sym, gb, [], gen2);
  t.false(stock.speciesName(2) === 'LMNOP',
          'ten characters into an eleven-wide table drifts, as it always did');

  const said = new RomData(sym, gb, [], eleven);
  t.eq(said.speciesName(1), 'ABCDEFGHIJK', 'the first name comes back whole');
  t.eq(said.speciesName(2), 'LMNOP', 'and the second is where the stride says');
});

test('a move id past the count the profile declares is not read at all',
     async (t) => {
  const gb = new FakeGameBoy();
  gb.romByte = () => 1;
  const has = (engine, id) =>
    new RomData(sym, gb, [], engine).move(id) !== null;
  t.true(has(gen2, 251), 'Crystal has 251 moves');
  t.false(has(gen2, 252), 'and reading past them would be reading the next table');
  t.true(has({ ...gen2, moveCount: 300 }, 252),
         'a cartridge that added moves says so, and they are read');
});

test('a cartridge that added species is read to its own count', async (t) => {
  const gb = new FakeGameBoy();
  // A name table wide enough to answer for id 300, in the game's own charmap.
  gb.romByte = (bank, addr) => 0x80 + (addr % 26);
  const named = (engine, id) => new RomData(sym, gb, [], engine).speciesName(id);

  t.eq(named(gen2, 300), '#300',
       'past 251 the stock profile refuses rather than reading the next table');
  t.false(named({ ...gen2, speciesCount: 300 }, 300).startsWith('#'),
          'and a cartridge with more of them has them read');

  // The bound was written as a literal in two places and is now one field --
  // which this test is the reason for: it was found by the name test failing
  // for a species id the profile had no say over.
  t.eq(named(gen2, 251).startsWith('#'), false, 'Crystal still reads its last');
});

test('a changed number reaches the whole app, not just the reader',
     async (t) => {
  // The half-applied bug this closes: `maxParty` and `trainerBattle` were
  // module-level constants computed from the stock profile when state.js was
  // imported, so a title that raised the party cap had it honoured in
  // `party()` -- and nowhere that decides anything.
  const eight = { ...gen2, maxParty: 8 };
  const seven = Array.from({ length: 7 }, () => ({ hp: 5, maxHp: 5 }));
  const world = { party: seven, battleMode: 1, enemy: { species: 16, level: 3, hp: 9, maxHp: 9 } };
  const s = new GameState(sym, eight).read(worldRam(sym, world));

  t.eq(s.party.length, 7, 'the reader follows the profile, as it always did');
  const said = describeRows(s, { engine: eight, ballId: 5, rom: null });
  t.true(said.here.enabled,
         'and so does the row that refuses a catch when the party is full');
  t.eq(describeRows(s, { engine: gen2, ballId: 5, rom: null }).here.enabled, false,
       'which the stock cap would have refused at seven');
});

test('a cartridge that renumbered its battle modes is read that way',
     async (t) => {
  const odd = { ...gen2, trainerBattle: 3 };
  const world = { battleMode: 3, party: [{ hp: 5, maxHp: 5 }],
                  enemy: { species: 16, level: 3, hp: 9, maxHp: 9 } };
  const s = new GameState(sym, odd).read(worldRam(sym, world));
  t.contains(describeRows(s, { engine: odd, ballId: 5, rom: null }).here.text,
             'trainer', 'mode 3 is the trainer battle this cartridge declares');
  t.false(describeRows(s, { engine: gen2, ballId: 5, rom: null }).here.text
            .includes('trainer'),
          'and the stock profile reads the same bytes as a wild one');
});
