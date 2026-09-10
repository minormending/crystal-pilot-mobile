// The cartridge's own character encoding.
//
// Every byte sequence here was read out of a real Crystal ROM rather than
// copied from a table, because copying a table hopefully is how the gaps got
// there. `decodeText` is exported for exactly this and had no test until the
// gaps were measured.
import { fakeRom, romReading, symbols, test } from '../harness.mjs';
import { decodeText, normalise, RomData } from '../../gen2/romdata.js';
import { gen2 } from '../../gen2/engine.js';

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
  // Stores power 1 and ends battles, which is why every reader here asks
  // whether the power is above *zero* rather than above one.
  32: { power: 1, type: N, effect: 38, pp: 5 },       // HORN DRILL
  // Big and Normal, which makes it the specialist in the test below: huge
  // against anything the chart is quiet about and nothing at all against a
  // Ghost.
  63: { power: 150, type: N, pp: 5 },                 // HYPER BEAM
};
/** A real RomData reading that chart, from bytes. */
const charted = (chart = CHART) => romReading(TYPED, { chart });

test('what neutral means is measured off the chart, not written here',
     async (t) => {
  // Gen 2 writes the multiplier in tenths -- 05 and 20, so neutral is 10.
  // **Polished Crystal writes Q4 fixed point**, `0.5q4` is $08 and `2.0q4`
  // is $20, and read as tenths those came out 0.8 and 3.2: the bytes right
  // and the scale a number in this repository. The two values in the table
  // describe the scale between them, so it is taken from there.
  const q4 = [
    N, ROCK, 0x08,
    FIRE, GRASS, 0x20,
    FIRE, WATER, 0x08,
    ELECTRIC, GROUND, 0,
    0xff,
  ];
  const rom = charted(q4);
  t.eq(rom.matchup(FIRE, GRASS), 2, 'a double is a double on either scale');
  t.eq(rom.matchup(N, ROCK), 0.5, 'and a half is a half, not four fifths');
  t.eq(rom.matchup(ELECTRIC, GROUND), 0, 'nothing is still nothing');
  t.eq(rom.matchup(FIRE, N), 1, 'and the pairs it omits are neutral');
  t.eq(charted().chartUnit(), 10, 'the tenths chart is unmoved');
  t.eq(rom.chartUnit(), 16, 'and this one measures sixteen');
  // The smallest scale a Gen 2-shaped chart can be written on: a half of 1
  // and a double of 4. It is here because the zeroes are dropped by asking
  // for *above zero*, and "above one" reads the same on every chart but
  // this one -- where it would throw the half away and leave a table with a
  // single multiplier in it, which measures nothing.
  t.eq(charted([N, ROCK, 1, FIRE, GRASS, 4, 0xff]).chartUnit(), 2,
       'a half of one is a multiplier, not an absence');
});

test('a chart on no scale this reader knows keeps the declared one',
     async (t) => {
  // The measurement uses *both* values and requires them to agree -- the
  // largest exactly four times the smallest -- because one alone cannot
  // tell a half from a quarter. A table that does not answer that shape is
  // not a Gen 2 chart, and guessing a scale off it would be worse than the
  // profile's own number, which is right for every cartridge that ships the
  // real table.
  const odd = charted([N, ROCK, 7, FIRE, GRASS, 9, 0xff]);
  t.eq(odd.chartUnit(), 10, 'the declared unit, not a derived one');
});

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

test('a type nobody can price makes the whole answer unreadable', async (t) => {
  // Not skipped, which is the tempting alternative and is worse than saying
  // nothing: half a matchup is a multiplier that reads like an answer. A Fire
  // move priced against only the Grass half of a Grass/Water Pokémon comes
  // out double when it is neutral.
  const rom = charted();
  t.eq(rom.matchup(null, WATER), null, 'no attacking type, no answer');
  t.eq(rom.matchup(FIRE, null), null, 'and none without a defender either');
  t.eq(rom.matchup(FIRE, undefined), null, 'a slot that was never written is the same');
  t.eq(rom.effectiveness(52, [GRASS, null]), null,
       'so one unreadable slot takes the pair with it');
});

test('twenty-four bytes with no terminator in them is not a name', async (t) => {
  // `decodeText` will turn any bytes at all into a string, so a symbol file
  // pointing somewhere that is not a name table would otherwise hand back a
  // row of question marks -- which reads like an answer. The longest name on
  // this cartridge is twelve characters.
  const letters = (n) => Array.from({ length: n }, () => 0x80);
  t.eq(romReading(TYPED, { names: letters(40) }).moveName(1), '',
       'no terminator, no name');
  t.eq(romReading(TYPED, { names: [...letters(24), 0x50] }).moveName(1), '',
       'and the bound is the bound: the twenty-fifth byte is not consulted');
  t.eq(romReading(TYPED, { names: [...letters(3), 0x50] }).moveName(1), 'AAA',
       'while a name that does terminate comes back whole');
});

test('a species knows its own types, six stats along', async (t) => {
  // The only way to know what a party member *is*: Gen 2 does not keep a
  // Pokémon's types in the party struct, they are copied out of BaseData when
  // it is sent out — which is why work RAM has `wBattleMonType1` for the one
  // on the field and nothing at all for the five behind it.
  //
  // Six stats in front of the types, not five. Counting five reads the
  // special defence as the first type, which is a plausible type number, so
  // it prints rather than fails: CHIKORITA came out as "type 65/GRASS".
  const rom = romReading(TYPED, {
    chart: CHART, species: { 152: [GRASS, GRASS], 155: [FIRE, FIRE], 81: [ELECTRIC, STEEL] },
  });
  t.eq(rom.speciesTypes(152), [GRASS, GRASS], 'a single-typed one, in both slots');
  t.eq(rom.speciesTypes(155), [FIRE, FIRE], 'and the next entry along, at its own stride');
  t.eq(rom.speciesTypes(81), [ELECTRIC, STEEL], 'and a genuinely dual-typed one');
  t.ne(rom.speciesTypes(152)[0], 67,
       'not the special defence, which is what counting five stats reads');
});

test('a cartridge with no base stats to read says so', async (t) => {
  // Which costs the same-type bonus for a Pokémon on the bench and nothing
  // else — the chart still prices every move.
  const rom = charted();
  t.eq(rom.speciesTypes(152), null, 'no table, no answer');
  t.eq(rom.speciesTypes(0), null, 'nor for a species id of nothing');
  t.eq(rom.speciesTypes(9999), null, 'nor past the end of the Pokédex');
});

test('an entry that is not whose it should be is not an entry', async (t) => {
  // There is no terminator here to run off the end of, so the entry's own id
  // in byte zero is the only guard available — and it is needed, because a
  // symbol file pointing somewhere else reads zeroes and `[0, 0]` is
  // NORMAL/NORMAL. A real type pair, and a wrong answer that looks like one.
  const rom = charted();          // has BaseData in the table, zeroes behind it
  t.eq(rom.speciesTypes(152), null, 'a bank of zeroes is not the Pokédex');
  const real = romReading(TYPED, { chart: CHART, species: { 152: [GRASS, GRASS] } });
  t.eq(real.speciesTypes(152), [GRASS, GRASS], 'and a real entry still reads');
  t.eq(real.speciesTypes(153), null, 'while its neighbour, which is not there, does not');
});

// --- what a trainer is carrying --------------------------------------------
//
// Laid out as *bytes* at the real address, so the pointers in the fixture are
// real pointers and the reader's "the table ends where its own first pointer
// lands" arithmetic is the thing under test. Handing over a decoded class
// list could not be read wrongly.

const TRAINER_BASE = 0x5999;
/**
 * A pointer table and the classes behind it.
 *
 * `classes` is a list of lists of `[name, type, [[level, species], ...]]`.
 * The bytes come out in the cartridge's own shape: a `dw` per class, then a
 * terminated name, a type byte, the Pokémon, and `$ff`.
 */
function trainerBytes(classes, { wide = 2, bank = 0x0e } = {}) {
  const enc = (t) => [...t].map((c) => (c === ' ' ? 0x7f : 0x80 + c.charCodeAt(0) - 65));
  const bodies = classes.map((trainers) => {
    const out = [];
    for (const [name, kind, party] of trainers) {
      out.push(...enc(name), 0x50, kind);
      for (const [level, species] of party) {
        out.push(level, species);
        // The padding the type byte promises: type 1 is six bytes a Pokémon,
        // so four move bytes follow. A fixture that left them out would make
        // the stride untestable.
        if (kind === 1) out.push(33, 0, 0, 0);
        if (kind === 2) out.push(0);
        if (kind === 3) out.push(0, 33, 0, 0, 0);
      }
      out.push(0xff);
    }
    return out;
  });
  // `wide` is the entry size, and three is what rgbds `dba` emits: a bank byte
  // and then the address. Built as bytes rather than described, because the
  // width is the thing under test and a fixture that declared it could not be
  // read at the wrong one.
  const head = classes.length * wide;
  const bytes = [];
  let at = TRAINER_BASE + head;
  for (const body of bodies) {
    if (wide > 2) bytes.push(bank);
    bytes.push(at & 0xff, at >> 8);
    at += body.length;
  }
  for (const body of bodies) bytes.push(...body);
  return bytes;
}

const LEADERS = [
  [['FALKNER', 1, [[7, 16], [9, 17]]]],
  [['WHITNEY', 1, [[18, 35], [20, 241]]]],
  [['BUGSY', 1, [[14, 11], [14, 14], [16, 123]]]],
];
const CLASS_NAMES = (() => {
  const out = [];
  // Class 1's name is the *first* entry, not the second: the cartridge
  // numbers classes from one and packs their names from the start, so there
  // is no filler entry to skip. Written with one here at first, which is how
  // this fixture came to disagree with the real cartridge -- where
  // `trainerClass(1)` reads LEADER, as Falkner's class should.
  for (const n of ['LEADER', 'LEADER', 'LEADER']) {
    for (const c of n) out.push(c === '-' ? 0xe3 : 0x80 + c.charCodeAt(0) - 65);
    out.push(0x50);
  }
  return out;
})();
const withTrainers = (classes = LEADERS) => romReading(TYPED, {
  chart: CHART, trainers: trainerBytes(classes), classes: CLASS_NAMES,
  species: { 16: [N, 0x02], 17: [N, 0x02], 11: [BUG, BUG],
             14: [BUG, 0x03], 123: [BUG, 0x02], 35: [N, N], 241: [N, N] },
});

test('a trainer comes out of the cartridge with the party they have',
     async (t) => {
  const rom = withTrainers();
  const falkner = rom.trainer('FALKNER');
  t.eq(falkner.party.map((m) => [m.level, m.species]), [[7, 16], [9, 17]],
       'PIDGEY Lv7 and PIDGEOTTO Lv9, which is what he has');
  t.eq(rom.trainer('BUGSY').party.length, 3, 'and Bugsy has three');
  t.eq(rom.trainer('BUGSY').party[2].level, 16, 'the Scyther being the Lv16');
});

test('a class runs from its pointer to the next one, not to the end',
     async (t) => {
  // Nothing between two trainers says a class ended. Read without the next
  // pointer as a bound, Falkner's class appears to contain every gym leader
  // in Johto — which is how the first draft of this read it.
  const rom = withTrainers();
  t.eq(rom.trainer('FALKNER').group, 1, 'Falkner is class one');
  t.eq(rom.trainer('WHITNEY').group, 2, 'Whitney is her own class');
  t.eq(rom.trainer('BUGSY').group, 3, 'and Bugsy is his');
  t.eq(rom.trainerClass(1), 'LEADER', 'and the class has a name');
});

test('the class count is derived from where the first pointer lands',
     async (t) => {
  // No number written down: the pointer table ends where its own first entry
  // points, so a cartridge with more classes needs nothing changed here.
  t.eq(withTrainers().trainerIndex().size, 3, 'three classes, three trainers');
  t.eq(withTrainers([...LEADERS, [['SILVER', 1, [[5, 158]]]]])
       .trainerIndex().size, 4, 'and a fourth is read without being told');
});

test('a type byte nobody has heard of is not a trainer', async (t) => {
  // The one part of this that cannot be guessed from the bytes: the type byte
  // says how *wide* a Pokémon is. Read it wrongly and the party is nonsense
  // at a plausible length, so an unknown value stops the read rather than
  // picking a stride.
  const rom = withTrainers([[['MYSTERY', 9, [[5, 16]]]]]);
  t.eq(rom.trainerIndex(), null, 'nothing was read, and that is not an index');
  t.eq(rom.trainer('MYSTERY'), null, 'and it says so');
});

test('a name with no terminator inside its bound is not a trainer', async (t) => {
  const rom = romReading(TYPED, {
    chart: CHART, classes: CLASS_NAMES,
    trainers: [0x9b, 0x59, ...Array.from({ length: 40 }, () => 0x80)],
  });
  t.eq(rom.trainerIndex(), null, 'a bank of letters is not a table');
});

test('a pointer table whose first pointer is not past it is not one',
     async (t) => {
  // A bank of zeroes, or a symbol file pointing at data. The count comes from
  // subtracting the table's own address, so a first pointer at or below it
  // gives a count of zero or a negative one — and a negative count read as a
  // loop bound is a table of nothing that looks like a table.
  t.eq(romReading(TYPED, { chart: CHART, trainers: [0, 0, 0, 0] })
       .trainerIndex(), null, 'zeroes');
  const none = withTrainers();
  none.trainers = null;
  none._trainers = undefined;
  t.eq(none.trainerIndex(), null, 'and no symbol at all is the same');
});

test('two trainers with the same name are answered by the first', async (t) => {
  // Dozens share a name on the real cartridge — every JOEY, every MIKEY. The
  // rule is the symbol table's: first definition wins, because answering with
  // the last is no better and answering with both is not an answer.
  const rom = withTrainers([[['JOEY', 1, [[4, 19]]]], [['JOEY', 1, [[9, 19]]]]]);
  t.eq(rom.trainer('JOEY').party[0].level, 4, 'the first one');
  t.eq(rom.trainerIndex().size, 1, 'and the name appears once');
});

test('the outlook is two facts about a door you have not opened yet',
     async (t) => {
  // The level you are up against, and whether anything you carry can take HP
  // off what is in there. Both readable before the walk, which is the point:
  // a Gym row could say where the Gym was and who was in it, and not whether
  // it was worth going.
  const rom = withTrainers();
  const mine = [{ species: 155, level: 9, hp: 20, maxHp: 20,
                  moves: [52, 0, 0, 0], pp: [25, 0, 0, 0] }];
  const view = rom.outlook(mine, rom.trainer('BUGSY').party);
  t.eq(view.top, 16, 'Bugsy tops out at Lv16');
  t.eq(view.best, 9, 'and a Lv9 starter is seven short');
  t.eq(view.helpless, [], 'but Ember can hurt everything in the room');
});

test('and it names the ones nothing can touch', async (t) => {
  // The sharp half. A whole party of Ghosts is the case it was written for —
  // a Normal-only Pokémon level-for-level with Morty cannot take a single
  // point off him, and no amount of levelling changes that.
  const ghosts = [[['MORTY', 1, [[21, 92], [25, 94]]]]];
  const rom = romReading(TYPED, {
    chart: CHART, trainers: trainerBytes(ghosts), classes: CLASS_NAMES,
    species: { 92: [GHOST, 0x03], 94: [GHOST, 0x03] },
  });
  const normalOnly = [{ species: 19, level: 25, hp: 20, maxHp: 20,
                        moves: [33, 0, 0, 0], pp: [35, 0, 0, 0] }];
  const view = rom.outlook(normalOnly, rom.trainer('MORTY').party);
  t.eq(view.best, 25, 'level for level');
  t.eq(view.helpless.length, 2, 'and helpless against both');

  const withFire = [...normalOnly,
                    { species: 155, level: 5, hp: 20, maxHp: 20,
                      moves: [52, 0, 0, 0], pp: [25, 0, 0, 0] }];
  t.eq(rom.outlook(withFire, rom.trainer('MORTY').party).helpless, [],
       'one Ember anywhere in the party is enough');
});

test('a fainted Pokémon is not your best level', async (t) => {
  // `best` is what you can send out, not what you own. A knocked-out Lv30 in
  // slot one is not an answer to anything.
  const rom = withTrainers();
  const mine = [{ species: 155, level: 30, hp: 0, maxHp: 40,
                  moves: [52, 0, 0, 0], pp: [25, 0, 0, 0] },
                { species: 155, level: 8, hp: 20, maxHp: 20,
                  moves: [52, 0, 0, 0], pp: [25, 0, 0, 0] }];
  t.eq(rom.outlook(mine, rom.trainer('BUGSY').party).best, 8,
       'the one still standing');
});

test('an outlook nobody can price is not an outlook', async (t) => {
  // A warning nobody can price is worse than none, so every way of not being
  // able to read one answers null rather than guessing.
  const rom = withTrainers();
  const mine = [{ species: 155, level: 9, hp: 20, maxHp: 20,
                  moves: [52, 0, 0, 0], pp: [25, 0, 0, 0] }];
  t.eq(rom.outlook(mine, []), null, 'nobody to look at');
  t.eq(rom.outlook(mine, null), null, 'nor no party at all');
  t.eq(rom.outlook(null, rom.trainer('BUGSY').party), null, 'nor without yours');
  // A species the base-stat table cannot answer for: no types, no matchup.
  const blind = romReading(TYPED, {
    chart: CHART, trainers: trainerBytes(LEADERS), classes: CLASS_NAMES });
  t.eq(blind.outlook(mine, blind.trainer('BUGSY').party), null,
       'and not without knowing what they are');
});

test('two trainers in one class are read one after the other', async (t) => {
  // The `$ff` that ends a party is **one** byte. Step two and the next
  // trainer's name starts one byte in, which decodes to something and
  // terminates somewhere — a table of plausible nonsense rather than an
  // error.
  const rom = withTrainers([[['JOEY', 1, [[4, 19]]], ['MIKEY', 1, [[6, 16]]]]]);
  t.eq(rom.trainerIndex().size, 2, 'both of them');
  t.eq(rom.trainer('MIKEY').party[0].level, 6, 'and the second is itself');
  t.eq(rom.trainer('MIKEY').group, 1, 'in the same class as the first');
});

test('a class is bounded by the next pointer, and the last one by the bytes',
     async (t) => {
  // Two failures with one shape. Read one pointer too many and the last
  // class gets a bound out of whatever follows the table; read one too few
  // and the second-to-last class runs into the last.
  const rom = withTrainers([[['JOEY', 1, [[4, 19]]]],
                            [['MIKEY', 1, [[6, 16]]]],
                            [['SILVER', 1, [[5, 158]]]]]);
  t.eq(rom.trainer('JOEY').group, 1, 'the first');
  t.eq(rom.trainer('MIKEY').group, 2, 'the middle one');
  t.eq(rom.trainer('SILVER').group, 3, 'and the last');
  t.eq(rom.trainerIndex().size, 3, 'three, not one class holding three');
});

test('a name that runs to its bound without terminating is not a name',
     async (t) => {
  // Fourteen bytes, which is a bound rather than a size: the longest class
  // name on this cartridge is twelve characters and a trainer's own is
  // shorter. Reaching the bound means the bytes are not a name table.
  const long = 'A'.repeat(20);
  const rom = withTrainers([[[long, 1, [[4, 19]]]]]);
  t.eq(rom.trainerIndex(), null, 'nothing was read');
});

test('a move with no PP left cannot hurt anything', async (t) => {
  // `outlook` asks the same question `nothingLands` does, and it has to ask
  // it the same way: a spent move is not an answer. Read as "at or above
  // zero" and a party of empty movesets looks able to fight a gym.
  const rom = withTrainers();
  const spent = [{ species: 155, level: 20, hp: 20, maxHp: 20,
                   moves: [52, 0, 0, 0], pp: [0, 0, 0, 0] }];
  t.eq(rom.outlook(spent, rom.trainer('BUGSY').party).helpless.length, 3,
       'nothing it carries can be used, so nothing it carries can land');
});

test('a Pokémon on one hit point is still your best level', async (t) => {
  // `best` is what you can send out. One hit point is still standing, and
  // reading the bound as above one hides the only Pokémon you have.
  const rom = withTrainers();
  const nearly = [{ species: 155, level: 12, hp: 1, maxHp: 20,
                    moves: [52, 0, 0, 0], pp: [25, 0, 0, 0] }];
  t.eq(rom.outlook(nearly, rom.trainer('BUGSY').party).best, 12,
       'twelve, not zero');
});

test('a move that computes its damage still counts as a way to hurt them',
     async (t) => {
  // HORN DRILL stores power 1 and ends battles, so `outlook` asks whether the
  // power is above zero for the same reason every other reader here does.
  const rom = romReading(TYPED, {
    chart: CHART, trainers: trainerBytes(LEADERS), classes: CLASS_NAMES,
    species: { 11: [BUG, BUG], 14: [BUG, 0x03], 123: [BUG, 0x02] },
  });
  const drill = [{ species: 31, level: 20, hp: 20, maxHp: 20,
                   moves: [32, 0, 0, 0], pp: [5, 0, 0, 0] }];
  t.eq(rom.outlook(drill, rom.trainer('BUGSY').party).helpless, [],
       'a power-1 move is a way to hurt them');
});

test('the last species in the Pokédex has types like every other', async (t) => {
  // 251 is CELEBI, and the bound is *above* the count rather than at it —
  // read the other way and the last entry in every table this app touches is
  // unreadable.
  const rom = romReading(TYPED, { chart: CHART, species: { 251: [0x18, GRASS] } });
  t.eq(rom.speciesTypes(251), [0x18, GRASS], 'CELEBI is PSYCHIC/GRASS');
  t.eq(rom.speciesTypes(252), null, 'and 252 is nothing');
});

test('fourteen bytes is a name and fifteen is not', async (t) => {
  // A bound, not a size. The longest class name on this cartridge is twelve
  // characters and a trainer's own is shorter, so the boundary is slack — and
  // it is the boundary that says "these bytes are not a name table" when a
  // symbol file points somewhere else.
  t.eq(withTrainers([[['A'.repeat(14), 1, [[4, 19]]]]]).trainerIndex().size, 1,
       'fourteen is inside it');
  t.eq(withTrainers([[['A'.repeat(15), 1, [[4, 19]]]]]).trainerIndex(), null,
       'and fifteen is past it');
});

// --- which of yours should be in front ------------------------------------

test('the one that answers the room leads, not the one already there',
     async (t) => {
  // Gen 2 sends out slot one and asks nobody, so the party's order decides
  // the first battle. Bugsy's room is three Bugs; a Fire move doubles on all
  // three and a Grass one is halved on all three.
  const rom = withTrainers();
  const party = [
    { species: 152, level: 12, hp: 20, maxHp: 24,
      moves: [75, 0, 0, 0], pp: [25, 0, 0, 0] },       // GRASS, halved
    { species: 155, level: 10, hp: 20, maxHp: 22,
      moves: [52, 0, 0, 0], pp: [25, 0, 0, 0] },       // FIRE, doubled
  ];
  t.eq(rom.bestLead(party, rom.trainer('BUGSY').party), 1,
       'the Cyndaquil, two levels behind and hitting four times as hard');
});

test('and nothing is moved when the right one is already leading', async (t) => {
  // Null rather than 0. A caller that acted on "slot 0" would walk the party
  // menu to swap the front Pokémon with itself, which is four presses and a
  // screen to buy nothing.
  const rom = withTrainers();
  const party = [
    { species: 155, level: 10, hp: 20, maxHp: 22,
      moves: [52, 0, 0, 0], pp: [25, 0, 0, 0] },
    { species: 152, level: 12, hp: 20, maxHp: 24,
      moves: [75, 0, 0, 0], pp: [25, 0, 0, 0] },
  ];
  t.eq(rom.bestLead(party, rom.trainer('BUGSY').party), null, 'already right');
});

test('the room is scored as a whole, not by its worst member', async (t) => {
  // A Gym is several battles in a row, so the Pokémon that leads has to
  // answer the *room*. Scored the other way — best against their hardest —
  // a specialist that beats one and loses to two would lead.
  const three = [[['BUGSY', 1, [[14, 11], [14, 14], [16, 123]]]]];
  const rom = romReading(TYPED, {
    chart: CHART, trainers: trainerBytes(three), classes: CLASS_NAMES,
    species: { 11: [BUG, BUG], 14: [BUG, 0x03], 123: [BUG, 0x02],
               152: [GRASS, GRASS], 155: [FIRE, FIRE], 19: [N, N] },
  });
  const party = [
    { species: 19, level: 20, hp: 20, maxHp: 20,
      moves: [33, 0, 0, 0], pp: [35, 0, 0, 0] },       // neutral on all three
    { species: 155, level: 6, hp: 20, maxHp: 22,
      moves: [52, 0, 0, 0], pp: [25, 0, 0, 0] },       // doubled on all three
  ];
  t.eq(rom.bestLead(party, rom.trainer('BUGSY').party), 1, 'the Fire one');
});

test('a fainted Pokémon is never sent to the front', async (t) => {
  // It would be sent out and refused with "There's no will to battle!", which
  // is a turn spent being told no.
  const rom = withTrainers();
  const party = [
    { species: 152, level: 12, hp: 20, maxHp: 24,
      moves: [75, 0, 0, 0], pp: [25, 0, 0, 0] },
    { species: 155, level: 10, hp: 0, maxHp: 22,
      moves: [52, 0, 0, 0], pp: [25, 0, 0, 0] },
  ];
  t.eq(rom.bestLead(party, rom.trainer('BUGSY').party), null,
       'the one that would answer it is down');
});

test('a party with nothing that can hurt them is not reordered', async (t) => {
  // Moving a Pokémon that cannot touch the room in front of one that also
  // cannot is four presses for nothing, and the hint already says the useful
  // thing about that situation.
  const ghosts = [[['MORTY', 1, [[21, 92]]]]];
  const rom = romReading(TYPED, {
    chart: CHART, trainers: trainerBytes(ghosts), classes: CLASS_NAMES,
    species: { 92: [GHOST, 0x03], 19: [N, N] },
  });
  const party = [
    { species: 19, level: 5, hp: 20, maxHp: 20,
      moves: [33, 0, 0, 0], pp: [35, 0, 0, 0] },
    { species: 19, level: 40, hp: 20, maxHp: 20,
      moves: [33, 0, 0, 0], pp: [35, 0, 0, 0] },
  ];
  t.eq(rom.bestLead(party, rom.trainer('MORTY').party), null,
       'neither of them lands, so neither is worth the walk');
});

test('a tie leaves the party alone', async (t) => {
  // Strictly greater, and it matters: a rule that reshuffled on every tie
  // would spend four presses and a menu walk every time the pilot looked at
  // a Gym.
  const rom = withTrainers();
  const twin = { species: 155, level: 10, hp: 20, maxHp: 22,
                 moves: [52, 0, 0, 0], pp: [25, 0, 0, 0] };
  t.eq(rom.bestLead([{ ...twin }, { ...twin }], rom.trainer('BUGSY').party),
       null, 'the one in front stays in front');
});

test('an unreadable cartridge picks nobody', async (t) => {
  const rom = withTrainers();
  const party = [{ species: 152, level: 12, hp: 20, maxHp: 24,
                   moves: [75, 0, 0, 0], pp: [25, 0, 0, 0] }];
  t.eq(rom.bestLead(party, []), null, 'nobody to answer');
  t.eq(rom.bestLead([], rom.trainer('BUGSY').party), null, 'nobody to send');
  t.eq(rom.bestLead(null, rom.trainer('BUGSY').party), null, 'and no party');
  const blind = romReading(TYPED, {
    chart: CHART, trainers: trainerBytes(LEADERS), classes: CLASS_NAMES });
  t.eq(blind.bestLead(party, blind.trainer('BUGSY').party), null,
       'nor without knowing what they are');
});

test('a Pokémon on one hit point can still be sent to the front', async (t) => {
  // One hit point is still standing, and the alternative reading hides the
  // only Pokémon that can answer the room.
  const rom = withTrainers();
  const party = [
    { species: 152, level: 12, hp: 20, maxHp: 24,
      moves: [75, 0, 0, 0], pp: [25, 0, 0, 0] },       // halved on Bugs
    { species: 155, level: 10, hp: 1, maxHp: 22,
      moves: [52, 0, 0, 0], pp: [25, 0, 0, 0] },       // doubled on Bugs
  ];
  t.eq(rom.bestLead(party, rom.trainer('BUGSY').party), 1,
       'a Pokémon at 1 of 22 is still the answer');
});

test('summing the room and taking its hardest hit are different answers',
     async (t) => {
  // A Gym is several battles in a row, so the score has to be the *room*.
  // Slot one here is a specialist: 150 against the one thing the chart is
  // quiet about, and nothing at all against the two Ghosts. Slot two answers
  // all three moderately. Summed, slot two wins; ranked by hardest single
  // hit, slot one does — and slot one is already in front, so the two rules
  // give opposite instructions.
  // The Grass one **last**, deliberately: a score that kept only the newest
  // number instead of adding them up would be the hit against whoever is at
  // the end of the list, and with the Grass one first that happens to give
  // the same answer as summing. The order is what makes the test able to
  // fail.
  const mixed = [[['MORTY', 1, [[21, 92], [21, 94], [20, 152]]]]];
  const rom = romReading(TYPED, {
    chart: CHART, trainers: trainerBytes(mixed), classes: CLASS_NAMES,
    species: { 152: [GRASS, GRASS], 92: [GHOST, GHOST], 94: [GHOST, GHOST],
               19: [0x02, 0x02], 155: [0x02, 0x02] },
  });
  const party = [
    { species: 19, level: 30, hp: 20, maxHp: 20,
      moves: [63, 0, 0, 0], pp: [5, 0, 0, 0] },        // 150, and 0 on a Ghost
    { species: 155, level: 10, hp: 20, maxHp: 22,
      moves: [52, 0, 0, 0], pp: [25, 0, 0, 0] },       // 40, doubling on Grass
  ];
  t.eq(rom.bestLead(party, rom.trainer('MORTY').party), 1,
       'the one that can hurt all three, not the one that flattens one');
});

// --- what a species turns into, and what it learns on the way ---------------
// Laid out as *bytes*, pointer table and all, for the reason the type chart is:
// the one mistake this table invites is reading a record at the wrong width,
// and a fake that handed over decoded evolutions could not make it.

/**
 * An `EvosAttacks` region: a `dw` per species, then the records behind them.
 *
 * The pointers are built so the first one lands exactly where the table ends,
 * because that is the property the reader uses to tell a pointer from a
 * pointer-shaped byte, and a fake that did not have it would make the guard
 * untestable.
 */
function evosRegion(entries, sym) {
  const base = sym.addr('EvosAttacksPointers');
  const head = gen2.speciesCount * 2;
  const body = [], ptrs = [];
  for (let id = 1; id <= gen2.speciesCount; id++) {
    ptrs.push(base + head + body.length);
    const e = entries[id] || {};
    for (const rec of e.evolves || []) body.push(...rec);
    body.push(0);
    for (const [level, move] of e.learns || []) body.push(level, move);
    body.push(0);
  }
  const out = [];
  for (const p of ptrs) out.push(p & 0xff, (p >> 8) & 0xff);
  return out.concat(body);
}

/** A `TypeNames` region: a `dw` per type id, then terminated names. */
function typeNameRegion(names, sym) {
  const base = sym.addr('TypeNames');
  const ids = Object.keys(names).map(Number);
  const head = (Math.max(...ids) + 1) * 2;
  const body = [], ptrs = [];
  for (let id = 0; id <= Math.max(...ids); id++) {
    ptrs.push(base + head + body.length);
    for (const ch of names[id] || '') body.push(0x80 + ch.charCodeAt(0) - 65);
    body.push(0x50);
  }
  const out = [];
  for (const p of ptrs) out.push(p & 0xff, (p >> 8) & 0xff);
  return out.concat(body);
}

/** A `BaseData` region wide enough to hold `n` entries. */
function baseRegion(entries, n = 260) {
  const out = new Array(n * gen2.baseBytes).fill(0);
  for (const [id, e] of Object.entries(entries)) {
    const at = (Number(id) - 1) * gen2.baseBytes;
    const f = gen2.baseField;
    out[at + f.id] = Number(id);
    (e.stats || []).forEach((v, i) => { out[at + f.stats + i] = v; });
    out[at + f.types] = (e.types || [0, 0])[0];
    out[at + f.types + 1] = (e.types || [0, 0])[1];
    out[at + f.catchRate] = e.catchRate ?? 0;
    out[at + f.baseExp] = e.baseExp ?? 0;
    out[at + f.hatch] = e.hatch ?? 0;
    out[at + f.growth] = e.growth ?? 0;
  }
  return out;
}

const EVO = gen2.evo.kind;

test('an evolution and a learnset come out of one run of bytes', async (t) => {
  const sym = symbols();
  // CYNDAQUIL as the cartridge has it: one level evolution, then the moves.
  const rom = romReading({}, {
    evos: evosRegion({
      155: { evolves: [[EVO.level, 14, 156]],
             learns: [[1, 33], [6, 108], [12, 52], [19, 98]] },
    }, sym),
  });
  const got = rom.evosAttacks(155);
  t.eq(got.evolves, [{ kind: 'level', into: 156, level: 14 }],
       'the evolution, with the species it becomes');
  t.eq(got.learns.length, 4, 'and every move behind it');
  t.eq(got.learns[0], { level: 1, move: 33 }, 'the first pair');
  t.eq(got.learns[3], { level: 19, move: 98 }, 'and the last');
});

test('EVOLVE_STAT is four bytes, and the learnset behind it proves it',
     async (t) => {
  const sym = symbols();
  // TYROGUE's three branches, which are the only four-byte records in the
  // game. Read at three bytes they still decode -- into nonsense -- so the
  // assertion that matters is the *learnset*, which is what the shift eats.
  const rom = romReading({}, {
    evos: evosRegion({
      236: {
        evolves: [[EVO.stat, 20, gen2.evo.compare.atkUnderDef, 107],
                  [EVO.stat, 20, gen2.evo.compare.atkOverDef, 106],
                  [EVO.stat, 20, gen2.evo.compare.atkEqualsDef, 237]],
        learns: [[1, 33]],
      },
    }, sym),
  });
  const got = rom.evosAttacks(236);
  t.eq(got.evolves.length, 3, 'three branches');
  t.eq(got.evolves[0], { kind: 'stat', into: 107, level: 20,
                         compare: 'atkUnderDef' }, 'each with its comparison');
  t.eq(got.evolves[2].compare, 'atkEqualsDef', 'and they are not all the same');
  t.eq(got.learns, [{ level: 1, move: 33 }],
       'and TACKLE is still behind them, which a three-byte read loses');
});

test('the other four conditions each keep their own parameter', async (t) => {
  const sym = symbols();
  const rom = romReading({}, {
    evos: evosRegion({
      133: { evolves: [[EVO.item, 24, 134],
                       [EVO.happiness, gen2.evo.when.night, 197],
                       [EVO.trade, 82, 186],
                       [EVO.trade, 0, 93]] },
    }, sym),
  });
  const [stone, friend, held, plain] = rom.evosAttacks(133).evolves;
  t.eq(stone, { kind: 'item', into: 134, item: 24 }, 'a stone names the stone');
  t.eq(friend, { kind: 'happiness', into: 197, when: 'night' },
       'friendship names the time of day');
  t.eq(held, { kind: 'trade', into: 186, item: 82 }, 'a trade names what it holds');
  t.eq(plain.item, 0, 'and a plain trade holds nothing, which is not "no item"');
});

test('a species that evolves into nothing is not the same as one that cannot '
     + 'be read', async (t) => {
  const sym = symbols();
  const rom = romReading({}, {
    evos: evosRegion({ 154: { learns: [[1, 33]] } }, sym),
  });
  const got = rom.evosAttacks(154);
  t.eq(got.evolves, [], 'an empty list is a real answer');
  t.eq(got.learns.length, 1, 'and the moves behind it still read');
  t.eq(rom.evosAttacks(300), null, 'a species the cartridge does not have is null');
});

test('a pointer that lands inside the pointer table is not a pointer',
     async (t) => {
  const sym = symbols();
  const bytes = evosRegion({ 3: { learns: [[1, 33]] } }, sym);
  // Aim species three back at the table itself, which is the shape a symbol
  // file pointing somewhere else produces -- and the shape that used to be
  // the *only* accepted one, because the comparison was written the way the
  // trainer table wants it and this table keeps its data the other side.
  bytes[4] = sym.addr('EvosAttacksPointers') & 0xff;
  bytes[5] = (sym.addr('EvosAttacksPointers') >> 8) & 0xff;
  const rom = romReading({}, { evos: bytes });
  t.eq(rom.evosAttacks(3), null, 'refused rather than decoded');
  t.ne(rom.evosAttacks(2), null, 'and its neighbours are unharmed');
});

test('a first pointer that is not past the table condemns the whole table',
     async (t) => {
  const sym = symbols();
  const bytes = evosRegion({ 1: { learns: [[1, 33]] } }, sym);
  bytes[0] = 0; bytes[1] = 0;
  const rom = romReading({}, { evos: bytes });
  // Deliberately all-or-nothing, and the same rule `trainerIndex` follows: the
  // table's end is derived from its first pointer, so a first pointer that is
  // not one means there is no table here to read -- not one species missing.
  t.eq(rom.evosAttacks(1), null, 'the species whose pointer is wrong');
  t.eq(rom.evosAttacks(2), null, 'and every other one, because the end is gone');
});

test('a record kind the profile has never heard of stops the read', async (t) => {
  const sym = symbols();
  const rom = romReading({}, {
    evos: evosRegion({ 1: { evolves: [[9, 1, 2]], learns: [[1, 33]] } }, sym),
  });
  t.eq(rom.evosAttacks(1), null,
       'nine is not a kind, so this is not an evolution run');
});

test('a cartridge with no evolution table says so rather than guessing',
     async (t) => {
  const rom = romReading({}, {});
  t.eq(rom.evosAttacks(155), null, 'null, and no exception on the way');
});

test('the species range is asked about at both ends', async (t) => {
  const sym = symbols();
  const rom = romReading({}, {
    evos: evosRegion({ 1: { learns: [[1, 33]] },
                       [gen2.speciesCount]: { learns: [[1, 33]] } }, sym),
  });
  t.eq(rom.evosAttacks(0), null, 'there is no species zero to ask about');
  t.ne(rom.evosAttacks(1), null, 'the first is in');
  t.ne(rom.evosAttacks(gen2.speciesCount), null, 'and so is the last');
  t.eq(rom.evosAttacks(gen2.speciesCount + 1), null, 'one past it is not');
});

test('a run with no terminator stops rather than reading the bank', async (t) => {
  // The guards are a bound, not a size. A species whose pointer is right and
  // whose data is not -- a hack mid-edit, a symbol file one build stale -- must
  // give up somewhere, and "somewhere" has to be short of walking out of the
  // bank and into whatever is next.
  const sym = symbols();
  const bytes = evosRegion({ 1: { learns: [[1, 33]] } }, sym);
  // Overwrite the terminators behind species one with more pairs, so the
  // learnset never ends.
  const head = gen2.speciesCount * 2;
  for (let i = head; i < bytes.length; i++) bytes[i] = i % 2 ? 33 : 5;
  const rom = romReading({}, { evos: bytes });
  const got = rom.evosAttacks(1);
  t.eq(got.learns.length, gen2.evo.maxLearn,
       'it stops at the bound rather than running on');
  t.lte(got.learns.length, 64, 'which is a bound, and a small one');
});

test('an entry that could not be read stays unreadable when asked twice',
     async (t) => {
  // The refusal is cached like an answer, and a cache holding `undefined`
  // where it meant `null` answers the second caller differently from the
  // first -- which is the shape of bug that only shows on a redraw.
  const sym = symbols();
  const rom = romReading({}, {
    evos: evosRegion({ 1: { evolves: [[9, 1, 2]] } }, sym),
  });
  t.eq(rom.evosAttacks(1), null, 'the first time');
  t.eq(rom.evosAttacks(1), null, 'and the same the second');
});

test('a base-stats entry is six named stats and a growth rate', async (t) => {
  const sym = symbols();
  const rom = romReading({}, {
    base: baseRegion({
      155: { stats: [39, 52, 43, 65, 60, 50], types: [0x14, 0x14],
             catchRate: 45, baseExp: 65, hatch: 20, growth: 3 },
    }),
  });
  const got = rom.baseStats(155);
  t.eq(got.stats, { hp: 39, atk: 52, def: 43, spd: 65, satk: 60, sdef: 50 },
       'named, so a reader cannot take the fifth for the sixth');
  t.eq(got.growth, 'mediumSlow', 'the curve as a key, not a number');
  t.eq(got.catchRate, 45, 'the catch rate');
  t.eq(got.types, [0x14, 0x14], 'and the types, which is what this used to be');
  t.eq(rom.speciesTypes(155), [0x14, 0x14],
       'and speciesTypes still answers, through the same read');
});

test('a growth rate the profile has no name for stays a number', async (t) => {
  const rom = romReading({}, { base: baseRegion({ 1: { stats: [1, 1, 1, 1, 1, 1],
                                                       growth: 40 } }) });
  t.eq(rom.baseStats(1).growth, 40, 'rather than becoming a wrong word');
});

test('an entry that does not carry its own id is not an entry', async (t) => {
  const bytes = baseRegion({ 1: { stats: [1, 2, 3, 4, 5, 6] } });
  bytes[gen2.baseField.id] = 7;
  const rom = romReading({}, { base: bytes });
  t.eq(rom.baseStats(1), null, 'the only guard this table has');
  t.eq(rom.speciesTypes(1), null, 'and it reaches the caller that had it before');
});

test('a type says its own name, out of the cartridge', async (t) => {
  const sym = symbols();
  const rom = romReading({}, {
    typeNames: typeNameRegion({ 0: 'NORMAL', 1: 'FIGHTING', 20: 'FIRE' }, sym),
  });
  t.eq(rom.typeName(0), 'NORMAL', 'id zero is a real id, not an absence');
  t.eq(rom.typeName(20), 'FIRE', 'and the special types are the same table');
  t.eq(rom.typeName(1), 'FIGHTING', 'the longest one still fits');
});

test('a relative name table is read as one, without being told', async (t) => {
  // Polished Crystal writes `TypeNames` as `dr`, which assembles as
  // `db X - @`: one byte per entry, an offset from that entry's *own*
  // address. Read as Crystal's `dw` it gives an address in the wrong part of
  // the bank and every name comes back empty -- which is what it did.
  const names = ['NORMAL', 'FIGHTING', 'FLYING'];
  const enc = (t2) => [...t2].map((c) => 0x80 + c.charCodeAt(0) - 65);
  // Entries first, then the strings behind them, and each entry holds the
  // distance from itself to its own string.
  const bytes = [];
  let at = names.length;
  for (let i = 0; i < names.length; i++) {
    bytes.push(at - i);
    at += names[i].length + 1;
  }
  for (const n of names) bytes.push(...enc(n), 0x50);
  const rom = romReading({}, { typeNames: bytes });
  t.eq(rom.typeName(0), 'NORMAL', 'the first');
  t.eq(rom.typeName(1), 'FIGHTING', 'the second, from its own origin');
  t.eq(rom.typeName(2), 'FLYING', 'and the third');
});

test('the terminator is measured off the table, not written here', async (t) => {
  // Polished Crystal ends a string with $53 where Crystal ends it with $50 --
  // its whole charmap is shifted. A name table lays its strings end to end,
  // so the second entry starts one byte past the first one's terminator, and
  // the table says what that byte is.
  const addr = symbols().addr('TypeNames');
  const enc = (t2) => [...t2].map((c) => 0x80 + c.charCodeAt(0) - 65);
  const first = addr + 4, second = first + 7;
  const bytes = [first & 0xff, first >> 8, second & 0xff, second >> 8,
                 ...enc('NORMAL'), 0x53, ...enc('FIGHTING'), 0x53];
  const rom = romReading({}, { typeNames: bytes });
  t.eq(rom.terminator(), 0x53, 'measured, not assumed');
  t.eq(rom.typeName(0), 'NORMAL', 'and the name ends where it ends');
  t.eq(rom.typeName(1), 'FIGHTING', 'both of them');
});

test('a cartridge that will not name its types says nothing, not "type 20"',
     async (t) => {
  const rom = romReading({}, {});
  t.eq(rom.typeName(20), '', 'empty, so the caller decides what to show instead');
});

test('a type nobody asked about is not type zero', async (t) => {
  // `typeName(0)` is NORMAL and `typeName(null)` is a caller with nothing to
  // ask -- and zero is falsy, so the guard has to name null and undefined
  // rather than testing the id for truth.
  const sym = symbols();
  // Two names, because one is not a table: the reader proves the shape by
  // reading entry 0 and entry 1 as a pair, which is also how it measures the
  // terminator. A single-entry fixture tests a cartridge that cannot exist.
  const rom = romReading({}, {
    typeNames: typeNameRegion({ 0: 'NORMAL', 1: 'FIGHTING' }, sym) });
  t.eq(rom.typeName(0), 'NORMAL', 'zero is a real type id');
  t.eq(rom.typeName(null), '', 'null is not');
  t.eq(rom.typeName(undefined), '', 'nor is nothing at all');
});

// --- which hours are which --------------------------------------------------

test('the day is read as upper bounds, not as starts', async (t) => {
  // `GetTimeOfDay` walks pairs and takes the first whose hour is *greater*
  // than the clock's. Read as starts the same bytes still decode -- into a day
  // shifted by a whole block, which looks exactly as plausible.
  const rom = romReading({}, {
    times: [4, 2, 10, 0, 18, 1, 24, 2, 0xff, 0],
  });
  const map = rom.hourBlocks();
  t.eq(map.length, 24, 'one entry per hour');
  t.eq(map[3], 2, '03:00 is still night');
  t.eq(map[4], 0, 'and morning starts at four, not at five');
  t.eq(map[9], 0, 'through nine');
  t.eq(map[10], 1, 'day at ten');
  t.eq(map[17], 1, 'through seventeen');
  t.eq(map[18], 2, 'and night at eighteen');
});

test('the block that wraps midnight is answered as one that wraps', async (t) => {
  // Night runs 18 to 3, so its range is not an interval -- and a reader that
  // sorted the hours and took the ends would report it as 0 to 23.
  const rom = romReading({}, { times: [4, 2, 10, 0, 18, 1, 24, 2, 0xff, 0] });
  const night = rom.hoursOf(2);
  t.eq(night.from, 18, 'it begins in the evening');
  t.eq(night.to, 3, 'and ends before dawn');
  t.eq(night.hours, 10, 'ten hours of it');
  const morning = rom.hoursOf(0);
  t.eq(morning, { from: 4, to: 9, hours: 6 }, 'and a block that does not wrap');
});

test('a table with no terminator is not a table', async (t) => {
  // A bank of zeroes decodes into one pair -- "everything up to hour zero is
  // morning" -- which would call the whole day morning rather than failing.
  const rom = romReading({}, { times: [4, 2, 10, 0, 18, 1] });
  t.eq(rom.hourBlocks(), null, 'refused');
  t.eq(rom.hoursOf(0), null, 'and nothing built on it answers either');
  t.eq(romReading({}, {}).hourBlocks(), null,
       'as with a cartridge that does not name the table');
});

test('a three-byte pointer table is read at three bytes, without being told',
     async (t) => {
  // pokecrystal16 writes `TrainerGroups` as `dba` -- a bank byte then the
  // address -- because its trainer data outgrew one bank. Read at two bytes
  // the same table decodes: 503 classes instead of 67, names like
  // "ser? ATTACK.", and every class boundary lost. So the width is derived
  // from the table the same way its length is, and this holds that.
  const rom = romReading(TYPED, {
    chart: CHART, trainers: trainerBytes(LEADERS, { wide: 3 }),
    classes: CLASS_NAMES,
    species: { 16: [N, 0x02], 17: [N, 0x02], 11: [BUG, BUG],
               14: [BUG, 0x03], 123: [BUG, 0x02], 35: [N, N], 241: [N, N] },
  });
  const falkner = rom.trainer('FALKNER');
  t.ne(falkner, null, 'found at all');
  t.eq(falkner.group, 1, 'in the first class, not the five-hundredth');
  t.eq(falkner.party.map((m) => [m.level, m.species]), [[7, 16], [9, 17]],
       'with the party he has');
  t.eq(rom.trainer('BUGSY').group, 3, 'and the class boundaries still hold');
});

test('the width is derived, so the two-byte table still reads at two',
     async (t) => {
  // The other half: a derivation that always answered three would have made
  // the test above pass and every real Crystal cartridge fail.
  const rom = withTrainers();
  t.eq(rom.trainer('FALKNER').group, 1, 'vanilla, unchanged');
  t.eq(rom.trainerIndex().size, 3, 'three trainers over three classes');
});

test('a three-byte table pointing into another bank is refused', async (t) => {
  // Polished Crystal's `TrainerGroups` is `dba` too, and its entries name
  // banks $7d and $79 -- so its first pointer is not the end of the table,
  // it is an address in a bank the table cannot see. The arithmetic that
  // gives 67 classes on pokecrystal16 gave 404 on it. A pointer whose bank
  // is not the table's own cannot bound the table, so the width is refused
  // rather than used to count.
  const rom = romReading(TYPED, {
    chart: CHART, trainers: trainerBytes(LEADERS, { wide: 3, bank: 0x7d }),
    classes: CLASS_NAMES,
  });
  t.eq(rom.trainerIndex(), null, 'refused rather than miscounted');
});

test('one unreadable class does not throw away the ones that read',
     async (t) => {
  // The other side of "nothing decoded is not an index": a single class the
  // reader cannot make sense of is skipped, and the three behind it are
  // still answers. Written because the null is easy to widen by accident
  // into "any failure loses the table".
  const rom = romReading(TYPED, {
    chart: CHART, classes: CLASS_NAMES,
    trainers: trainerBytes([...LEADERS, [['MYSTERY', 9, [[5, 16]]]]]),
    species: { 16: [N, 0x02], 17: [N, 0x02], 11: [BUG, BUG], 14: [BUG, 0x03],
               123: [BUG, 0x02], 35: [N, N], 241: [N, N] },
  });
  t.eq(rom.trainerIndex().size, 3, 'the three that decode');
  t.eq(rom.trainer('FALKNER').group, 1, 'and they are the right three');
  t.eq(rom.trainer('MYSTERY'), null, 'the fourth is not among them');
});

test('a table whose first pointer fits no width at all is not a table',
     async (t) => {
  // Neither two nor three divides into a gap of one, and nothing lands in the
  // bank window -- which is what a symbol file aimed somewhere else gives.
  const rom = romReading(TYPED, { trainers: [0x01, 0x00, 0x00, 0x00, 0x00] });
  t.eq(rom.trainerIndex(), null, 'refused rather than decoded');
  t.eq(rom.trainer('FALKNER'), null, 'and nothing is found through it');
});
