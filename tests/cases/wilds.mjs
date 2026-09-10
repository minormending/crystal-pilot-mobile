// The grass tables, hour by hour.
//
// Three readers share one scan of these bytes -- what appears, what levels it
// gives, and what the other hours hold -- and until now none of the three had a
// test, because they read a cartridge. They do not need one: they read through
// `gb.romByte`, so a table written out by hand is a patch of grass of any shape
// you like, including shapes the real Crystal has none of.
//
// The layout is the real one, from data/wild/johto_grass.asm: map group, map
// number, three encounter rates, then three blocks of seven (level, species)
// pairs -- morning, day, night -- and the table ends at $FF.
import { test } from '../harness.mjs';
import { RomData } from '../../gen2/romdata.js';

const NAMES_BANK = 1, NAMES_ADDR = 0x4000;
const GRASS_BANK = 4, GRASS_ADDR = 0x5000;
const NAME_LENGTH = 10, SLOTS = 7, BLOCKS = 3, HEADER = 5;

/** A species name as the cartridge stores it: A-Z from $80, "@" to end. */
function nameBytes(text) {
  const out = [...text].map((c) => 0x80 + c.charCodeAt(0) - 65);
  while (out.length < NAME_LENGTH) out.push(0x50);
  return out.slice(0, NAME_LENGTH);
}

/**
 * A cartridge holding one grass table.
 *
 * `species` is id -> name. `entries` is a list of
 * `{ group, number, blocks: [[[level, id], ...], ...] }`, and a block shorter
 * than seven slots is padded with (0, 0) the way a real half-filled block is.
 */
function cartridge(species, entries) {
  const rom = new Map();
  const put = (bank, addr, v) => rom.set(`${bank}:${addr}`, v & 0xff);

  for (const [id, name] of Object.entries(species)) {
    nameBytes(name).forEach((b, i) => put(NAMES_BANK, NAMES_ADDR + (id - 1) * NAME_LENGTH + i, b));
  }

  const entryBytes = HEADER + SLOTS * BLOCKS * 2;
  entries.forEach((e, n) => {
    const base = GRASS_ADDR + n * entryBytes;
    put(GRASS_BANK, base, e.group);
    put(GRASS_BANK, base + 1, e.number);
    for (let block = 0; block < BLOCKS; block++) {
      const slots = e.blocks[block] || [];
      for (let s = 0; s < SLOTS; s++) {
        const [level, id] = slots[s] || [0, 0];
        const at = base + HEADER + (block * SLOTS + s) * 2;
        put(GRASS_BANK, at, level);
        put(GRASS_BANK, at + 1, id);
      }
    }
  });
  put(GRASS_BANK, GRASS_ADDR + entries.length * entryBytes, 0xff);

  const gb = { romByte: (bank, addr) => rom.get(`${bank}:${addr}`) || 0 };
  const symbols = {
    has: (n) => ['PokemonNames', 'ItemNames', 'TestGrass'].includes(n),
    bank: (n) => (n === 'TestGrass' ? GRASS_BANK : NAMES_BANK),
    addr: (n) => (n === 'TestGrass' ? GRASS_ADDR : NAMES_ADDR),
  };
  return new RomData(symbols, gb, ['TestGrass']);
}

// Route 29's real shape: PIDGEY and SENTRET by day, HOOTHOOT after dark.
const ROUTE_29 = () => cartridge(
  { 16: 'PIDGEY', 19: 'RATTATA', 163: 'HOOTHOOT', 161: 'SENTRET' },
  [{
    group: 26, number: 1,
    blocks: [
      [[2, 161], [2, 16], [3, 19], [3, 161], [2, 16], [4, 161], [4, 16]],
      [[2, 161], [2, 16], [3, 19], [3, 161], [2, 16], [4, 161], [4, 16]],
      [[2, 163], [2, 19], [3, 163], [3, 19], [2, 163], [4, 163], [4, 19]],
    ],
  }],
);

test('the hour decides what is in the grass', async (t) => {
  const rd = ROUTE_29();
  t.eq(rd.wildOn(26, 1, 1), ['PIDGEY', 'SENTRET', 'RATTATA'],
       'by day, commonest first');
  t.eq(rd.wildOn(26, 1, 2), ['HOOTHOOT', 'RATTATA'], 'and after dark it swaps');
  // The union counts slots across all three blocks, so RATTATA -- one slot by
  // day and three at night -- outranks HOOTHOOT, which has four of one block.
  t.eq(rd.wildOn(26, 1), ['PIDGEY', 'SENTRET', 'RATTATA', 'HOOTHOOT'],
       'with no hour named it is the union, still commonest first');
});

test('a map the table does not list has no grass rather than empty grass', async (t) => {
  const rd = ROUTE_29();
  t.eq(rd.wildOn(24, 7), [], 'nothing appears');
  t.eq(rd.wildLevels(24, 7), null, 'and the levels are unknown, not zero');
  t.eq(rd.wildHours(24, 7), null, 'and there are no hours to compare');
});

test('a time of day past the last block is clamped, not read past', async (t) => {
  // A hack with fewer blocks, or a garbage wTimeOfDay, must not walk into the
  // next map's entry -- which is what an unclamped index does, silently.
  const rd = ROUTE_29();
  t.eq(rd.wildOn(26, 1, 9), rd.wildOn(26, 1, 2), 'above the top block reads the top one');
  t.eq(rd.wildOn(26, 1, -3), rd.wildOn(26, 1, 0), 'and below the first reads the first');
});

test('a half-filled block does not invent a species called #0', async (t) => {
  // The defect this test was written for. `wildLevels` skipped a slot with no
  // species and `wildOn` did not, so a block with three real slots and four
  // padding ones offered "#0" as a fourth thing to hunt -- pickable, never
  // findable, and enough to put Hunt on the offers list for a map that has
  // almost nothing in it.
  const rd = cartridge({ 16: 'PIDGEY' }, [{
    group: 26, number: 2,
    blocks: [[[3, 16], [3, 16], [4, 16]], [[3, 16]], [[5, 16]]],
  }]);
  t.eq(rd.wildOn(26, 2, 0), ['PIDGEY'], 'one species, not two');
  t.eq(rd.wildOn(26, 2), ['PIDGEY'], 'and the union is not four of them');
  t.eq(rd.wildLevels(26, 2, 0), { low: 3, high: 4 },
       'and the levels are unchanged, which is how the disagreement was spotted');
});

test('an entry with nothing in it at all reads as no grass', async (t) => {
  // Listed in the table, every slot padding. Before the fix this answered
  // "#0 lives here" and "the levels are unknown" at the same time.
  const rd = cartridge({ 16: 'PIDGEY' }, [{ group: 26, number: 3, blocks: [[], [], []] }]);
  t.eq(rd.wildOn(26, 3), [], 'nothing to hunt');
  t.eq(rd.wildLevels(26, 3), null, 'and no levels');
});

test('every hour comes back at once, indexed by wTimeOfDay', async (t) => {
  const hours = ROUTE_29().wildHours(26, 1);
  t.eq(hours.length, 3, 'one entry per block');
  t.eq(hours[1].species, ['PIDGEY', 'SENTRET', 'RATTATA'], 'day');
  t.eq(hours[2].species, ['HOOTHOOT', 'RATTATA'], 'night');
  t.eq(hours[2].levels, { low: 2, high: 4 }, 'with the levels that block gives');
});

test('the hours agree with the two readers that take an hour', async (t) => {
  // The three share one scan and one slot reader, and this is what that buys:
  // they cannot drift. Worth pinning, because the drift is exactly the defect
  // above.
  const rd = ROUTE_29();
  const hours = rd.wildHours(26, 1);
  for (let tod = 0; tod < 3; tod++) {
    t.eq(hours[tod].species, rd.wildOn(26, 1, tod), `hour ${tod}: same species`);
    t.eq(hours[tod].levels, rd.wildLevels(26, 1, tod), `hour ${tod}: same levels`);
  }
});


// --- a cartridge whose wild levels are not levels ---------------------------
//
// Polished Crystal scales its wild encounters to the badge case:
// `LEVEL_FROM_BADGES` is 178 and a slot writes `LEVEL_FROM_BADGES + 1` for one
// above whatever `wBadgeBaseLevel` currently is. 357 of its slots are written
// that way, so a reader that takes the byte at face value offers a Lv179
// Ditto on Route 47.

const BADGE_BASE_ADDR = 0xc769, WRAM_START = 0xc000;

/** The same fixture, with a badge-scaling profile and a work RAM to read. */
function scaled(base) {
  const rd = cartridge(
    { 132: 'DITTO' },
    [{ group: 26, number: 1,
       blocks: [[[178 + 1, 132], [178 - 3, 132], [12, 132]], [], []] }],
  );
  rd.e = { ...rd.e,
           encounter: { ...rd.e.encounter, levelFromBadges: 178 } };
  rd.badgeBase = BADGE_BASE_ADDR;
  if (base === null) return { rd, wram: null };
  const wram = new Uint8Array(0x2000);
  wram[BADGE_BASE_ADDR - WRAM_START] = base;
  return { rd, wram };
}

test('a level relative to the badge case is resolved against work RAM',
     async (t) => {
  // `AdjustLevelForBadges` subtracts the constant, adds the base and clamps
  // to 2..99. With three badges the base is 20 here, so `+1` is 21 and `-3`
  // is 17 -- and the literal 12 beside them is still 12, because a byte
  // inside the cap is a level and means itself.
  const { rd, wram } = scaled(20);
  t.eq(rd.wildLevels(26, 1, 0, wram), { low: 12, high: 21 },
       'the scaled pair resolved and the plain one left alone');
});

test('a badge-scaled level with no work RAM says nothing, not 179',
     async (t) => {
  // The sentinel is not wrong by a little. Null is what every reader here
  // already treats as "this slot says nothing about levels", and the Hunt row
  // reads it as a patch of grass it cannot price rather than one to write
  // off.
  const { rd } = scaled(null);
  t.eq(rd.wildLevels(26, 1, 0), { low: 12, high: 12 },
       'only the level that is a level');
  t.eq(rd.wildOn(26, 1, 0), ['DITTO'],
       'and what appears there is unaffected — a species is a species');
});

test('the clamp is the cartridge’s own, at both ends', async (t) => {
  // 2 at the bottom and 99 at the top, which is `MAX_LEVEL - 1` in its
  // source. A base of 1 would put `-3` below zero and a base of 99 would put
  // `+1` past the cap.
  t.eq(scaled(1).rd.wildLevels(26, 1, 0, scaled(1).wram).low, 2,
       'nothing under two');
  const high = scaled(99);
  t.eq(high.rd.wildLevels(26, 1, 0, high.wram).high, 99, 'and none over 99');
});

test('a cartridge that does not scale reads its levels as written',
     async (t) => {
  // Crystal's `levelFromBadges` is null, so 178 there would be a level of
  // 178 -- which is a bad read rather than a sentinel, and not this
  // reader's to fix.
  const rd = cartridge({ 132: 'DITTO' },
    [{ group: 26, number: 1, blocks: [[[7, 132]], [], []] }]);
  t.eq(rd.wildLevels(26, 1, 0), { low: 7, high: 7 }, 'as written');
});
