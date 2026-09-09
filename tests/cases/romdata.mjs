// The cartridge's own character encoding.
//
// Every byte sequence here was read out of a real Crystal ROM rather than
// copied from a table, because copying a table hopefully is how the gaps got
// there. `decodeText` is exported for exactly this and had no test until the
// gaps were measured.
import { fakeRom, romReading, test } from '../harness.mjs';
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

// --- what the cartridge calls a place ---------------------------------------

test('a landmark name comes out of the cartridge, line break and all',
     async (t) => {
  // The one table that retires hand-written data rather than adding to it.
  // A landmark name is written to fit a two-line sign, and the break inside it
  // is $1f -- read off "NEW BARK TOWN", whose bytes are
  // 8d 84 96 7f 81 80 91 8a 1f 93 8e 96 8d 50, so the break sits exactly where
  // the sign wraps. Reading it as an unknown byte put a question mark in the
  // middle of half the towns in Johto.
  t.eq(decodeText([0x8d, 0x84, 0x96, 0x7f, 0x81, 0x80, 0x91, 0x8a,
                   0x1f, 0x93, 0x8e, 0x96, 0x8d, 0x50]),
       'NEW BARK TOWN', 'one place, two lines');
  t.eq(decodeText([0x91, 0x8e, 0x94, 0x93, 0x84, 0x7f, 0xf8, 0xff, 0x50]),
       'ROUTE 29', 'and one that needs no break');
});

test('the ordinary line breaks are spaces in a name too', async (t) => {
  // Because a name is text, and one of them will turn up in a hack.
  t.eq(decodeText([0x80, 0x4e, 0x81, 0x50]), 'A B', 'the text break');
  t.eq(decodeText([0x80, 0x4f, 0x81, 0x50]), 'A B', 'and the paragraph one');
});

test('a cartridge with no landmark table names nothing, rather than guessing',
     async (t) => {
  // "Cannot read" so the caller falls back to what it had, which is the title's
  // own names and then the map's numbers.
  const rom = fakeRom({}, {});
  rom.landmarks = null;
  t.eq(rom.landmarkName(1), '', 'silence');
});

// --- the type chart ---------------------------------------------------------
//
// Every byte below was read off a real Crystal ROM at TypeMatchups, and the
// awkward part is why it is written as bytes: $fe is a *one-byte* separator
// where every row is three, so a fake that handed over decoded rows could not
// be read wrongly, and reading $fe as a row is exactly the mistake this made.

const N = 0x00, ROCK = 0x05, BUG = 0x07, GHOST = 0x08, STEEL = 0x09;
const FIRE = 0x14, WATER = 0x15, GRASS = 0x16, ELECTRIC = 0x17, GROUND = 0x04;
// The head of the real table, then its tail: the $fe separator, the two rows
// Foresight cancels, and the $ff that ends it.
const CHART = [
  N, ROCK, 5,
  N, STEEL, 5,
  FIRE, FIRE, 5,
  FIRE, WATER, 5,
  FIRE, GRASS, 20,
  FIRE, BUG, 20,
  WATER, FIRE, 20,
  WATER, WATER, 5,
  WATER, GRASS, 5,
  GRASS, WATER, 20,
  GRASS, GRASS, 5,
  GRASS, BUG, 5,
  ELECTRIC, GROUND, 0,
  0xfe,
  N, GHOST, 0,
  1, GHOST, 0,
  0xff,
];
const TYPED = {
  33: { power: 35, type: N, pp: 35 },                 // TACKLE
  52: { power: 40, type: FIRE, pp: 25 },              // EMBER
  75: { power: 55, type: GRASS, pp: 25 },             // RAZOR LEAF
  84: { power: 40, type: ELECTRIC, pp: 30 },          // THUNDERSHOCK
  43: { power: 0, type: N, effect: 19, pp: 30 },      // LEER
};
/** A real RomData reading that chart, from bytes. */
const charted = (chart = CHART) => romReading(TYPED, { chart });

test('the chart comes out of the bytes as the cartridge stores it', async (t) => {
  const rom = charted();
  t.eq(rom.matchup(FIRE, GRASS), 2, 'fire on grass doubles');
  t.eq(rom.matchup(FIRE, WATER), 0.5, 'and halves on water');
  t.eq(rom.matchup(ELECTRIC, GROUND), 0, 'electric cannot touch ground at all');
  t.eq(rom.matchup(FIRE, N), 1,
       'a pair the table never mentions is neutral, not missing');
});

test('the one-byte separator does not eat the row behind it', async (t) => {
  // The row straight after $fe is NORMAL on GHOST. Read $fe as a row and that
  // row is swallowed whole -- so a Normal move would come out neutral on a
  // Ghost, which is the one matchup in the game that stops a battle dead.
  const rom = charted();
  t.eq(rom.matchup(N, GHOST), 0, 'normal cannot touch a ghost');
  t.eq(rom.matchup(1, GHOST), 0, 'nor can fighting');
});

test('a chart that does not end where a table ends is not a table', async (t) => {
  // A bank of zeroes decodes into one row -- NORMAL on NORMAL, immune -- and
  // a pilot reading that ranks every move it owns at nothing. "Cannot say" is
  // the honest answer and raw power is the fallback.
  t.eq(charted([0, 0, 0]).matchups(), null, 'no terminator, no chart');
  t.eq(charted([0, 0, 0]).matchup(FIRE, GRASS), null, 'so no answer either');
  const none = charted();
  none.chart = null;
  none._matchups = undefined;
  t.eq(none.matchups(), null, 'and a symbol file that never named it is the same');
});

test('a single-typed Pokemon is not hit twice for it', async (t) => {
  // Gen 2 stores RATTATA as NORMAL/NORMAL, so multiplying once per slot
  // squares every multiplier: a Grass move on a Water/Water POLIWAG came out
  // at four rather than two.
  const rom = charted();
  t.eq(rom.effectiveness(75, [WATER, WATER]), 2, 'grass on water, once');
  t.eq(rom.effectiveness(52, [WATER, WATER]), 0.5, 'and fire on water, once');
});

test('a Pokemon with two types collects both rows', async (t) => {
  const rom = charted();
  t.eq(rom.effectiveness(52, [GRASS, BUG]), 4, 'fire doubles twice');
  t.eq(rom.effectiveness(75, [WATER, GRASS]), 1,
       'grass doubles on the water and halves on the grass');
});

test('types nobody supplied are cannot-say, not neutral', async (t) => {
  const rom = charted();
  t.eq(rom.effectiveness(75, null), null, 'no types, no answer');
  t.eq(rom.effectiveness(75, []), null, 'nor an empty pair');
  t.eq(rom.effectiveness(999, [WATER]), null, 'nor a move the table has not got');
});

test('how hard a move lands is its power scaled by both bonuses', async (t) => {
  const rom = charted();
  // RAZOR LEAF on a Bug: 55, halved, and no same-type bonus for a Fire mon.
  t.eq(rom.hitPower(75, [BUG, BUG], [FIRE, FIRE]), 27.5, 'halved');
  // The same move for a Grass mon against Water: doubled and then some.
  t.eq(rom.hitPower(75, [WATER, WATER], [GRASS, GRASS]), 55 * 2 * 1.5,
       'doubled, with the same-type bonus on top');
  t.eq(rom.hitPower(33, [GHOST, GHOST], [N, N]), 0, 'and nothing is nothing');
});

test('the two scalings are independent, and only one needs the chart',
     async (t) => {
  // A cartridge with no chart in its symbol file loses the matchup and keeps
  // the same-type bonus, because that bonus needs nothing but the move's type
  // and the Pokemon's -- both of which are readable without a chart. Ranking
  // by raw power is the behaviour this replaced, and this is that plus the
  // half it can still be sure of.
  const rom = charted([0, 0, 0]);
  t.eq(rom.hitPower(75, [WATER, WATER], [GRASS, GRASS]), 55 * 1.5,
       'no matchup, but the bonus stands');
  t.eq(rom.hitPower(75, [WATER, WATER], [FIRE, FIRE]), 55,
       'and with neither, the power is the power');
  t.eq(rom.hitPower(999, [WATER]), 0, 'a move that is not there is worth nothing');
});

test('whether a move can land at all is a different question', async (t) => {
  const rom = charted();
  t.false(rom.canHit(33, [GHOST, GHOST]), 'a normal move on a ghost cannot');
  t.true(rom.canHit(52, [GHOST, GHOST]), 'a fire one can');
  t.true(rom.canHit(33, null), 'and "cannot tell" must not become "do not swing"');
  t.true(charted([0, 0, 0]).canHit(33, [GHOST, GHOST]),
         'nor may an unreadable chart shut anything down');
});

test('a move can say its own name, which is what a log needs', async (t) => {
  // Packed and terminated, the same shape as the item names -- and read by
  // the same walk, which is the point: two copies of that walk was the defect.
  const packed = (...words) => {
    const out = [];
    for (const w of words) {
      for (const c of w) out.push(0x80 + c.charCodeAt(0) - 65);
      out.push(0x50);
    }
    return out;
  };
  const rom = romReading(TYPED, { chart: CHART, names: packed('POUND', 'KARATE') });
  t.eq(rom.moveName(1), 'POUND', 'the first entry');
  t.eq(rom.moveName(2), 'KARATE', 'and the one only the first can locate');
  const none = charted();
  none.moveNames = null;
  t.eq(none.moveName(1), '', 'a cartridge that will not say, says nothing');
});
