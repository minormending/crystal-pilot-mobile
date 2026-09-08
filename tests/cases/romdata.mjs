// The cartridge's own character encoding.
//
// Every byte sequence here was read out of a real Crystal ROM rather than
// copied from a table, because copying a table hopefully is how the gaps got
// there. `decodeText` is exported for exactly this and had no test until the
// gaps were measured.
import { fakeRom, test } from '../harness.mjs';
import { decodeText, normalise, RomData } from '../../gen2/romdata.js';

test('the two NIDORAN are two different names', async (t) => {
  // The one that matters. Both came back "NIDORAN?", so the species picker drew
  // two identical chips and hunting for one of them stopped at the other --
  // Route 35 and Route 36 both carry the pair.
  const female = decodeText([0x8d, 0x88, 0x83, 0x8e, 0x91, 0x80, 0x8d, 0xf5, 0x50]);
  const male = decodeText([0x8d, 0x88, 0x83, 0x8e, 0x91, 0x80, 0x8d, 0xef, 0x50]);
  t.eq(female, 'NIDORAN♀', 'the female sign is a character, not a shrug');
  t.eq(male, 'NIDORAN♂', 'and so is the male one');
  t.ne(female, male, 'which is the whole point: they are pickable apart');
});

test('the punctuation in a species name survives it', async (t) => {
  t.eq(decodeText([0x85, 0x80, 0x91, 0x85, 0x84, 0x93, 0x82, 0x87, 0xe0, 0x83]),
       "FARFETCH'D", 'apostrophe');
  t.eq(decodeText([0x8c, 0x91, 0xe8, 0x8c, 0x88, 0x8c, 0x84, 0x50]),
       'MR.MIME', 'full stop');
  t.eq(decodeText([0x87, 0x8e, 0xe3, 0x8e, 0x87, 0x50]), 'HO-OH', 'hyphen');
});

test('and in an item name, which is where it was first noticed', async (t) => {
  t.eq(decodeText([0x8a, 0x88, 0x8d, 0x86, 0xe0, 0x92, 0x7f, 0x91, 0x8e, 0x82, 0x8a]),
       "KING'S ROCK", 'a name with both punctuation and a space');
  t.eq(decodeText([0x84, 0x97, 0x8f, 0xe8, 0x92, 0x87, 0x80, 0x91, 0x84]),
       'EXP.SHARE', 'and one with no space at all');
});

test('the letters, digits and the ligature are unchanged', async (t) => {
  // The parts that already worked, pinned so a charmap edit cannot quietly
  // move them: A-Z at 0x80, a-z at 0xa0, 0-9 at 0xf6, and POKé in one byte.
  t.eq(decodeText([0x80, 0x99, 0xa0, 0xb9]), 'AZaz', 'both letter ranges');
  t.eq(decodeText([0xf6, 0xff]), '09', 'the digits');
  t.eq(decodeText([0x54, 0x7f, 0x81, 0x80, 0x8b, 0x8b]), 'POKé BALL', 'the ligature');
  t.eq(decodeText([0x80, 0x50, 0x81]), 'A', '"@" ends the name');
  t.eq(decodeText([0x01]), '?', 'and a byte nothing claims is still a shrug');
});

test('folding a name for matching keeps what tells two apart', async (t) => {
  // é folds because someone typing "poke ball" means POKé BALL. The gender
  // signs must not, or the fold would undo the fix above.
  t.eq(normalise('POKé BALL'), 'poke ball', 'the accent goes');
  t.ne(normalise('NIDORAN♀'), normalise('NIDORAN♂'),
       'the signs stay, because they are the difference');
});

// --- the cheapest thing in the bag that matches a list ----------------------

const ITEMS = { 18: 'POTION', 154: 'BERRY', 26: 'FULL RESTORE', 19: 'SUPER POTION',
                5: 'POKé BALL', 12: 'ANTIDOTE', 30: 'FRESH WATER' };
const STOCK = ['berry', 'potion', 'super potion', 'full restore'];
/** A RomData whose item names are those, or one with no names at all. */
const rd = (names) => (names === null ? { cheapestOf: () => null }
  : Object.assign(Object.create(RomData.prototype),
                  { itemName: (id) => ITEMS[id] || '' }));
test('the cheapest thing that will do is the one picked', async (t) => {
  // The same rule as never throwing a Master Ball at a Rattata. A Full Restore
  // on a Pokémon missing four HP is that, in the other pocket.
  const rom = fakeRom({ items: ITEMS });
  t.eq(rd(rom).cheapestOf([[26, 1], [18, 2]], STOCK).name, 'POTION',
       'a potion before a full restore');
  t.eq(rd(rom).cheapestOf([[26, 1], [18, 2], [154, 5]], STOCK).name, 'BERRY',
       'and a berry before either, being free and regrowing');
  t.eq(rd(rom).cheapestOf([[26, 1]], STOCK).name, 'FULL RESTORE',
       'but the expensive one when it is all there is');
});

test('a bag with nothing that heals answers nothing', async (t) => {
  const rom = fakeRom({ items: { 5: 'POKé BALL', 12: 'ANTIDOTE' } });
  t.eq(rd(rom).cheapestOf([[5, 3], [12, 1]], STOCK), null, 'balls and cures are not heals');
  t.eq(rd(rom).cheapestOf([[18, 0]], STOCK), null, 'nor is a zero quantity');
  t.eq(rd(rom).cheapestOf([], STOCK), null, 'nor an empty pocket');
});

test('a cartridge whose title lists no healing items answers nothing',
     async (t) => {
  // The honest position for a hack that renamed POTION: lose this, keep
  // everything else, and get it back when somebody writes the name down.
  const rom = fakeRom({ items: ITEMS });
  t.eq(rd(rom).cheapestOf([[18, 1]], null), null, 'no list, no answer');
  t.eq(rd(rom).cheapestOf([[18, 1]], []), null, 'and an empty list is the same');
  t.eq(rd().cheapestOf([[999, 1]], STOCK), null,
       'nor an id the item table has no name for');
});

test('the name is folded, so case and the accent cost nothing', async (t) => {
  const rom = fakeRom({ items: { 30: 'FRESH WATER', 5: 'POKé BALL' } });
  t.eq(rom.cheapestOf([[30, 1]], ['fresh water']).name, 'FRESH WATER',
       'matched through the same fold the ball preference uses');
  t.eq(rom.cheapestOf([[5, 3]], ['poke ball']).name, 'POKé BALL',
       'and the accent folds the way it does for a ball');
});


// --- an item's id, from its name ---------------------------------------------

/** A RomData over a packed, "@"-terminated item table. */
function itemTable(names) {
  const bytes = [];
  for (const n of names) {
    for (const ch of n) {
      if (ch === ' ') bytes.push(0x7f);
      else bytes.push(0x80 + ch.charCodeAt(0) - 65);
    }
    bytes.push(0x50);
  }
  // Past the end: a zero, which `decodeText` turns into '' via the terminator
  // check falling through to nothing readable.
  bytes.push(0x50);
  const gb = { romByte: (bank, addr) => bytes[addr] ?? 0x50 };
  const symbols = { has: () => true, bank: () => 0, addr: () => 0 };
  return new RomData(symbols, gb, []);
}

test('an item id is found by folded name', async (t) => {
  // The mirror of `itemName`, and the one question the app had never needed to
  // ask: everything until now started from an id the game had already given it.
  // Buying starts from a name -- the title says "potion" and the stock walk
  // needs the number.
  const rd = itemTable(['MASTER BALL', 'ULTRA BALL', 'POTION']);
  t.eq(rd.itemIdOf('potion'), 3, 'the third entry');
  t.eq(rd.itemIdOf('POTION'), 3, 'case folds');
  t.eq(rd.itemIdOf('master ball'), 1, 'and the first');
});

test('a name the table does not have is null rather than a guess', async (t) => {
  const rd = itemTable(['POTION']);
  t.eq(rd.itemIdOf('full restore'), null, 'not stocked here');
  t.eq(rd.itemIdOf(''), null, 'nor is nothing a name');
  t.eq(rd.itemIdOf(null), null, 'nor is null');
});

test('the scan stops at the end of the table rather than reading past it',
     async (t) => {
  // `itemName` answers '' past the end, and that empty answer is the stop. A
  // scan that carried on would map whatever table follows onto item ids -- the
  // same failure `speciesCount` exists to prevent one field over.
  const rd = itemTable(['POTION', 'ANTIDOTE']);
  t.eq(rd.itemIdOf('potion'), 1, 'the real entries are found');
  t.eq(rd.itemIdOf('antidote'), 2, 'both of them');
  // Ask twice: the second call reads the cache, and a cache built by a runaway
  // scan would be enormous rather than two entries.
  t.eq(rd.itemIdOf('antidote'), 2, 'and the cache agrees');
  t.eq(rd._itemIds.size, 2, 'two entries, not two hundred and fifty-six');
});
