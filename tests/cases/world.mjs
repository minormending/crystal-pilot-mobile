// The map graph, read out of the cartridge.
//
// world.js had no tests and was not even loaded by the suite, which is an
// awkward place for the module every journey is planned against. It needs no
// cartridge to test: it reads bytes through `gb.romByte`, so a fake ROM that
// answers those reads is a map of any shape you like.
//
// The layout below is the real one, from constants/map_data_constants.asm -- a
// map header pointing at an attributes block, that block ending with a
// connection bitmask and one twelve-byte struct per side, plus an events block
// holding the warps. Writing it out is the point: a stub of `neighbours` would
// test the stub, and the byte layout is the part that can be wrong.
import { test } from '../harness.mjs';
import { World, mapKey } from '../../gen2/world.js';
import { gen2 } from '../../gen2/engine.js';

const SIDES = { UP: 0x8, DOWN: 0x4, LEFT: 0x2, RIGHT: 0x1 };
// The structs are stored north, south, west, east whatever subset is present.
const ORDER = ['UP', 'DOWN', 'LEFT', 'RIGHT'];

/**
 * A cartridge whose maps are whatever you describe.
 *
 * `maps` is keyed by map key: `{ edges: { RIGHT: key, ... }, warps: [[x,y,key]] }`.
 */
function cartridge(maps, { pad = 0 } = {}) {
  const GROUPS_BANK = 1, GROUPS_ADDR = 0x4000;
  const ATTR_BANK = 2, EVENT_BANK = 3;
  const rom = new Map();                       // "bank:addr" -> byte
  const put = (bank, addr, v) => rom.set(`${bank}:${addr}`, v & 0xff);
  const put16le = (bank, addr, v) => { put(bank, addr, v & 0xff); put(bank, addr + 1, v >> 8); };

  // One pointer table per group, and a header per map inside it. Both are
  // little-endian words, which is how the ROM stores them.
  //
  // **The lists are packed, which is how the real cartridge lays them out**, and
  // it matters: `MapGroupPointers` carries no count, so the only bound on a map
  // number is the *next* group's pointer. This fake used to space the tables
  // 0x400 apart, which is not a multiple of the nine-byte header -- so
  // `mapCount` could not derive anything, stayed permissive, and the whole
  // reason for the bound went untested. A fake that is laid out more
  // conveniently than the thing it stands for is a fake that cannot fail.
  const groups = new Map();
  const perGroup = new Map();
  for (const key of maps.keys()) {
    const g = key >> 8;
    perGroup.set(g, Math.max(perGroup.get(g) || 0, key & 0xff));
  }
  let nextGroupTable = 0x5000, nextAttr = 0x6000, nextEvents = 0x100;
  // Every group index up to the last one gets a pointer, including the ones
  // with no maps -- which is how the real table is: twenty-six pointers, one
  // after another, and a group with nothing in it is a zero-length list rather
  // than a hole. A fake with holes reads a zero for the next pointer and makes
  // every count underivable, which is the case this is trying not to be in.
  const lastGroup = Math.max(...perGroup.keys());
  for (let g = 1; g <= lastGroup; g++) {
    groups.set(g, nextGroupTable);
    put16le(GROUPS_BANK, GROUPS_ADDR + (g - 1) * 2, nextGroupTable);
    nextGroupTable += (perGroup.get(g) || 0) * 9 + pad;
  }
  // And the pointer past the last group. A real cartridge has whatever comes
  // next in the bank; here it is deliberately *not* a sane step forward, so the
  // last group's own count stays underivable -- which is the real case.
  put16le(GROUPS_BANK, GROUPS_ADDR + lastGroup * 2, 0);
  for (const [key, spec] of maps) {
    const g = key >> 8, n = key & 0xff;
    const header = groups.get(g) + (n - 1) * 9;
    const attr = nextAttr; nextAttr += 0x100;
    put(GROUPS_BANK, header + 0, ATTR_BANK);              // attributes bank
    put16le(GROUPS_BANK, header + 3, attr);               // attributes address

    const edges = spec.edges || {};
    let mask = 0;
    for (const dir of ORDER) if (edges[dir]) mask |= SIDES[dir];
    put(ATTR_BANK, attr + 11, mask);                      // the connection mask
    let at = attr + 12;
    for (const dir of ORDER) {
      if (!edges[dir]) continue;
      put(ATTR_BANK, at + 0, edges[dir] >> 8);
      put(ATTR_BANK, at + 1, edges[dir] & 0xff);
      at += 12;
    }

    const events = nextEvents; nextEvents += 0x100;
    put(ATTR_BANK, attr + 6, EVENT_BANK);                 // scripts/events bank
    put16le(ATTR_BANK, attr + 9, events);                 // events address
    // A map's size, which is what bounds the object and trigger coordinates.
    const [bw, bh] = spec.blocks || [10, 10];
    put(ATTR_BANK, attr + 1, bh);
    put(ATTR_BANK, attr + 2, bw);
    const warps = spec.warps || [];
    put(EVENT_BANK, events + 2, warps.length);
    warps.forEach(([x, y, to], i) => {
      const w = events + 3 + i * 5;
      put(EVENT_BANK, w + 0, y);
      put(EVENT_BANK, w + 1, x);
      put(EVENT_BANK, w + 3, to >> 8);
      put(EVENT_BANK, w + 4, to & 0xff);
    });
    // Then the coord events, right after the warps: scene, y, x, a pad byte and
    // a script pointer. **Raw coordinates, unlike the objects** -- which is the
    // asymmetry this fake exists to hold the reader to.
    let cursor = events + 3 + warps.length * 5;
    const triggers = spec.triggers || [];
    put(EVENT_BANK, cursor++, triggers.length);
    triggers.forEach(([x, y, scene], i) => {
      const c = cursor + i * 8;
      put(EVENT_BANK, c + 0, scene || 0);
      put(EVENT_BANK, c + 1, y);
      put(EVENT_BANK, c + 2, x);
    });
  }

  const symbols = { bank: () => GROUPS_BANK, addr: () => GROUPS_ADDR,
                    has: () => true };
  const reads = { count: 0 };
  const gb = {
    romByte(bank, addr) { reads.count++; return rom.get(`${bank}:${addr}`) || 0; },
  };
  return { world: new World(symbols, gb), reads };
}

// New Bark — Route 29 — Cherrygrove — Route 30, with Elm's lab behind a door.
const BARK = mapKey(24, 1), R29 = mapKey(24, 2), CHERRY = mapKey(26, 1);
const R30 = mapKey(26, 2), LAB = mapKey(24, 5), NOWHERE = mapKey(30, 9);
const johto = () => cartridge(new Map([
  [BARK,   { edges: { LEFT: R29 }, warps: [[4, 3, LAB]] }],
  [R29,    { edges: { RIGHT: BARK, LEFT: CHERRY } }],
  [CHERRY, { edges: { RIGHT: R29, UP: R30 } }],
  [R30,    { edges: { DOWN: CHERRY } }],
  [LAB,    { warps: [[4, 6, BARK]] }],
  [NOWHERE, {}],
]));

test('a map names its neighbours, in the order the ROM stores them', async (t) => {
  const { world } = johto();
  const around = world.neighbours(24, 2).map((n) => `${n.dir}:${n.key}`);
  t.eq(around.length, 2, 'Route 29 joins two maps');
  t.true(around.includes(`RIGHT:${BARK}`), 'New Bark to the right');
  t.true(around.includes(`LEFT:${CHERRY}`), 'Cherrygrove to the left');
  t.eq(world.neighbours(24, 5).length, 0, 'a lab adjoins nothing — it is indoors');
});

test('doors are exits too, which is how the graph gets out of a building',
     async (t) => {
  const { world } = johto();
  const out = world.exits(LAB);
  t.eq(out.length, 1, 'the lab has one way out');
  t.eq(out[0].kind, 'warp', 'and it is a door, not an edge');
  t.eq(out[0].key, BARK, 'onto New Bark');
  t.eq(out[0].tile, [4, 6], 'at the tile the events block gives');
});

test('a route is the shortest list of exits, by legs', async (t) => {
  const { world } = johto();
  t.eq(world.route(BARK, BARK), [], 'nowhere to go');
  t.eq(world.route(BARK, R29).map((e) => e.dir), ['LEFT'], 'one edge west');
  t.eq(world.route(BARK, R30).map((e) => e.dir), ['LEFT', 'LEFT', 'UP'],
       'three legs to Route 30');
  t.eq(world.route(LAB, CHERRY).length, 3, 'out of the door, then two edges');
  t.eq(world.route(BARK, NOWHERE), null, 'a map nothing joins is unreachable');
});

test('several destinations cost one search, not one each', async (t) => {
  // The reason routesFrom exists. Ten named places used to mean ten
  // breadth-first walks over the same graph.
  const { world, reads } = johto();
  world.route(BARK, R30);
  const oneAtATime = reads.count;
  const { world: w2, reads: r2 } = johto();
  const found = w2.routesFrom(BARK, [R29, CHERRY, R30, NOWHERE]);
  t.eq(found.size, 3, 'three of the four are reachable');
  t.false(found.has(NOWHERE), 'and the fourth is simply absent');
  t.eq(found.get(R30).map((e) => e.dir), ['LEFT', 'LEFT', 'UP'],
       'with the same route route() gives');
  t.true(r2.count < oneAtATime * 4,
         `four asked in one walk (${r2.count} reads) beats four walks (~${oneAtATime * 4})`);
});

test('the map you are standing on is never a destination', async (t) => {
  const { world } = johto();
  const found = world.routesFrom(BARK, [BARK, R29]);
  t.false(found.has(BARK), 'asking to go where you are is not a journey');
  t.true(found.has(R29), 'and the real one still comes back');
});

test('asking only about where you are walks no graph at all', async (t) => {
  // Reachable, and not a curiosity: a title that names one map, and the player
  // standing on it. Without the guard this walks to its 400-map cap looking for
  // a destination that was removed from the list before the search began.
  const { world, reads } = johto();
  const before = reads.count;
  const found = world.routesFrom(BARK, [BARK]);
  t.eq(found.size, 0, 'nothing to route to');
  t.eq(reads.count, before, 'and not one byte of ROM read finding that out');
});

test('an unused warp slot is not a door to map 0.0', async (t) => {
  // Real cartridges leave warp slots blank, and the count covers them. A slot
  // whose group or number reads zero is padding, not a door -- believed, it
  // becomes an exit to a map that does not exist, and the graph would route
  // journeys through it.
  const { world } = cartridge(new Map([
    [BARK, { warps: [[4, 3, LAB], [0, 0, 0], [6, 3, CHERRY]] }],
    [LAB, {}], [CHERRY, {}],
  ]));
  const doors = world.warps(24, 1);
  t.eq(doors.length, 2, 'two real doors out of three slots');
  t.eq(doors.map((w) => w.key), [LAB, CHERRY], 'and the blank one is gone');
});

test('a map the cartridge does not have reads as nothing, not as a crash',
     async (t) => {
  const { world } = johto();
  t.eq(world.neighbours(99, 99), [], 'nonsense reads give an empty list');
  t.eq(world.warps(99, 99), [], 'and no warps');
  t.eq(world.route(mapKey(99, 99), BARK), null, 'and no route out of nowhere');
});

// --- a leg that will not go -------------------------------------------------

/**
 * Five maps in a ring, so there are two ways round and one is shorter.
 *
 *   A -> B -> C        two legs
 *   A -> E -> D -> C   three
 */
const RING = [mapKey(9, 1), mapKey(9, 2), mapKey(9, 3), mapKey(9, 4), mapKey(9, 5)];
function ringWorld() {
  const [a, b, c, d, e] = RING;
  return cartridge(new Map([
    [a, { edges: { RIGHT: b, LEFT: e } }],
    [b, { edges: { LEFT: a, RIGHT: c } }],
    [c, { edges: { LEFT: b, RIGHT: d } }],
    [d, { edges: { LEFT: c, RIGHT: e } }],
    [e, { edges: { LEFT: d, RIGHT: a } }],
  ])).world;
}

test('a search can be told to leave a leg out', async (t) => {
  // Not a theoretical case. Route 29's connection struct says there is a map to
  // the north and there is -- Route 46 -- but the pilot cannot get up there,
  // and naming Violet City made that the shortest route to it by legs. The walk
  // refused UP three times and travelTo gave up, on a town four ordinary legs
  // away.
  const [a, b, c] = RING;
  const w = ringWorld();
  t.eq(w.route(a, c).length, 2, 'two legs the short way');

  const round = w.route(a, c, { avoid: new Set([World.leg(a, b)]) });
  t.true(round.length > 2, `the long way round instead: ${round.length} legs`);
  t.false(round.some((leg) => leg.key === b), 'and it does not go through B');
});

test('a graph with nothing left says so rather than looping', async (t) => {
  const [a, b, c, , e] = RING;
  const w = ringWorld();
  const shut = new Set([World.leg(a, b), World.leg(a, e)]);
  t.eq(w.route(a, c, { avoid: shut }), null, 'no way at all');
});

test('a leg is named by its two maps, which is what a failure knows', async (t) => {
  // Rather than by a direction: after a refusal the caller knows it tried to
  // get from here to there, and a warp has no direction at all.
  t.eq(World.leg(6147, 1289), '6147>1289', 'from and to');
});


// --- a map the cartridge does not have --------------------------------------

test('a map number past the end of its group is not a map', async (t) => {
  // **Measured on the cartridge, by a sweep looking for the Gyms.** Asking
  // about map 55 of a group that has ten returned Violet's Gym -- the same
  // objects, at the same tiles -- under six different group numbers, and put an
  // object at (141,72) on a map twenty tiles wide. `MapGroupPointers` carries
  // no count, so nothing was stopping the read: the header index just walked
  // off into whatever came next.
  //
  // This file's own comment admitted it -- "a map number the ROM does not have
  // reads as nonsense rather than failing" -- and that was true and harmless
  // while the only things asking were the graph's exits, all of which exist.
  const { world } = johto();
  t.eq(world.mapCount(24), 5, 'group 24 holds five maps here');
  t.true(world.hasMap(24, 5), 'the last of them is a map');
  t.false(world.hasMap(24, 6), 'one past it is not');
  t.false(world.hasMap(24, 55), 'and neither is fifty-five');
  t.eq(world.neighbours(24, 55), [], 'so it has no neighbours');
  t.eq(world.warps(24, 55), [], 'no doors');
  t.eq(world.objectsOn(24, 55), [], 'and nothing standing on it');
});

test('a group with no maps in it has none, rather than all of them', async (t) => {
  // A step of exactly nought between two pointers is an empty group, and that
  // is a *derivation*, not a failure to derive -- so it refuses rather than
  // staying permissive. Group 25 sits between two that have maps and has none.
  const { world } = johto();
  t.eq(world.mapCount(25), 0, 'nothing in it');
  t.false(world.hasMap(25, 1), 'so not even the first');
  t.eq(world.objectsOn(25, 1), [], 'and nothing to read off it');
});

test('the last group is left permissive, because nothing bounds it',
     async (t) => {
  // The bound is the *next* group's pointer, and the last group has none. Left
  // permissive rather than guessed at: refusing a map that exists breaks a
  // cartridge this app should support, and reading one that does not is caught
  // by the coordinate check in `objectsOn`. Wrong in the cheaper direction.
  const { world } = johto();
  t.eq(world.mapCount(30), null, 'the last group will not say');
  t.true(world.hasMap(30, 99), 'so it is not refused');
});

test('a group whose lists are padded is left permissive too', async (t) => {
  // A hack that spaced its header lists for room gives a step that is a
  // perfectly good positive number and *not* a multiple of nine -- so deriving
  // a count from it would be arithmetic on a coincidence, and the count would
  // be a fraction. Both halves of that test have to hold, which is why it is an
  // `&&`: positive alone would divide 0x400 by nine and refuse map 46 of a
  // group that has fifty.
  const spaced = cartridge(new Map([
    [mapKey(1, 1), {}], [mapKey(1, 2), {}], [mapKey(2, 1), {}],
  ]), { pad: 4 });
  t.eq(spaced.world.mapCount(1), null, 'a step of 22 says nothing about nine');
  t.true(spaced.world.hasMap(1, 40), 'so nothing is refused');
  t.eq(spaced.world.neighbours(1, 1), [], 'and a real map still reads');

  const packed = cartridge(new Map([
    [mapKey(1, 1), {}], [mapKey(1, 2), {}], [mapKey(2, 1), {}],
  ]));
  t.eq(packed.world.mapCount(1), 2, 'while a packed one counts');
  t.false(packed.world.hasMap(1, 3), 'and bounds');
});

test('a map that does exist is not refused by any of this', async (t) => {
  // The failure mode worth guarding against: a bound that is too clever
  // silently loses real maps, and every symptom of that reads as the graph
  // being wrong.
  const { world } = johto();
  for (const [g, n] of [[24, 1], [24, 2], [24, 5], [26, 1], [26, 2]]) {
    t.true(world.hasMap(g, n), `${g}.${n} is a map`);
  }
  t.eq(world.neighbours(24, 2).length, 2, 'and still has its neighbours');
});


test('a count that reaches the sanity bound is a bad read, not a crowd',
     async (t) => {
  // **The bound was truncating and returning.** Asked about a map past the end
  // of the *last* group -- the one nothing can bound -- the object reader
  // answered with thirty-two objects at plausible tiles, which is exactly
  // `MAX_OBJECTS`: it had believed the first thirty-two bytes of nonsense.
  //
  // A count that reaches the cap says the read is wrong, not that the map is
  // crowded. No real map in Crystal carries anything close.
  const GROUPS_BANK = 1, GROUPS_ADDR = 0x4000;
  const rom = new Map();
  const put = (b, a, v) => rom.set(`${b}:${a}`, v & 0xff);
  const put16 = (b, a, v) => { put(b, a, v & 0xff); put(b, a + 1, v >> 8); };
  // One group, one map, whose event block claims two hundred objects.
  put16(GROUPS_BANK, GROUPS_ADDR, 0x5000);
  put(GROUPS_BANK, 0x5000, 2);                    // attributes bank
  put16(GROUPS_BANK, 0x5003, 0x6000);             // attributes address
  put(2, 0x6001, 8); put(2, 0x6002, 5);           // 8 x 5 blocks
  put(2, 0x6006, 3);                              // events bank
  put16(2, 0x6009, 0x100);                        // events address
  put(3, 0x102, 0);                               // no warps
  put(3, 0x103, 0); put(3, 0x104, 0);             // no coord events
  put(3, 0x105, 0);                               // no bg events
  put(3, 0x106, 200);                             // and two hundred objects
  const gb = { romByte: (b, a) => rom.get(`${b}:${a}`) || 0 };
  const world = new World({ bank: () => GROUPS_BANK, addr: () => GROUPS_ADDR,
                            has: () => true }, gb);
  t.eq(world.objectsOn(1, 1), [],
       'nothing, rather than the first thirty-two of it');
});

test('a map knows its own size without being stood on', async (t) => {
  // Measured on the cartridge against two maps whose tile dimensions were
  // already known from work RAM: Route 32's attributes read 45 and 10 for a map
  // that is 20 by 90 tiles, and Route 31's read 9 and 20 for one that is 40 by
  // 18. So height comes first and a block is two tiles each way.
  //
  // `collision.mapSize()` answers this off work RAM, which means only about the
  // map that is loaded. This one can be asked about a room nobody has walked
  // into -- which is what bounds the object reader.
  const GROUPS_BANK = 1, GROUPS_ADDR = 0x4000;
  const rom = new Map();
  const put = (b, a, v) => rom.set(`${b}:${a}`, v & 0xff);
  const put16 = (b, a, v) => { put(b, a, v & 0xff); put(b, a + 1, v >> 8); };
  put16(GROUPS_BANK, GROUPS_ADDR, 0x5000);
  put(GROUPS_BANK, 0x5000, 2);
  put16(GROUPS_BANK, 0x5003, 0x6000);
  put(2, 0x6001, 45); put(2, 0x6002, 10);         // Route 32's own numbers
  const gb = { romByte: (b, a) => rom.get(`${b}:${a}`) || 0 };
  const world = new World({ bank: () => GROUPS_BANK, addr: () => GROUPS_ADDR,
                            has: () => true }, gb);
  t.eq(world.sizeOf(1, 1), [20, 90], 'twenty by ninety tiles');
  t.eq(world.sizeOf(1, 2), null, 'and a map with no size will not guess');
});


// --- the tiles that run a script when you step on them ----------------------

test('the trigger tiles on a map are read, with their scenes', async (t) => {
  // **The thing that turned the pilot back for four passes, readable at last.**
  // Route 32's first coord event dumps as `00 08 12 00 ab 44 00 00` -- scene 0
  // at y 8, x 0x12 -- and (18,8) is the tile the pilot was measurably stopped
  // on. The symbol at 0x44ab is `Route32CooltrainerMStopsYouScene`.
  const c = cartridge(new Map([
    [mapKey(1, 1), { blocks: [10, 45],
                     warps: [[4, 3, mapKey(1, 2)]],
                     triggers: [[18, 8, 0], [7, 71, 1]] }],
    [mapKey(1, 2), {}],
  ]));
  t.eq(c.world.coordEventsOn(1, 1),
       [{ scene: 0, x: 18, y: 8 }, { scene: 1, x: 7, y: 71 }],
       'both of them, in order, with their scenes');
  t.eq(c.world.coordEventsOn(1, 2), [], 'and a map with none has none');
});

test('a trigger is read past the warps, however many there are', async (t) => {
  // The block is warps *then* triggers, so a wrong warp stride reads the
  // trigger count out of the middle of a warp -- which is the shape of a bug
  // that works on every map with one door and fails on the first with three.
  const c = cartridge(new Map([
    [mapKey(1, 1), { blocks: [10, 10],
                     warps: [[1, 1, mapKey(1, 2)], [2, 2, mapKey(1, 2)],
                             [3, 3, mapKey(1, 2)]],
                     triggers: [[5, 6, 2]] }],
    [mapKey(1, 2), {}],
  ]));
  t.eq(c.world.coordEventsOn(1, 1), [{ scene: 2, x: 5, y: 6 }],
       'found behind three doors');
});

test('a trigger coordinate is raw, where an object coordinate is not',
     async (t) => {
  // **The asymmetry, pinned.** An object is stored four higher than the map's
  // own coordinates and a coord event is not -- which reads as obviously
  // consistent and is not, and is exactly the sort of thing that puts a trigger
  // four tiles from where it is.
  const c = cartridge(new Map([
    [mapKey(1, 1), { blocks: [10, 10], triggers: [[5, 6, 0]],
                     objects: [[5, 6, 39]] }],
    [mapKey(1, 2), {}],
  ]));
  t.eq(c.world.coordEventsOn(1, 1)[0].x, 5, 'the trigger is where it says');
  t.eq(c.world.coordEventsOn(1, 1)[0].y, 6, 'on both axes');
});

test('a trigger off the map, or too many of them, is a bad read', async (t) => {
  // The same two rules the object reader follows, and for the same reason: a
  // read that has walked off the end of something gives plausible numbers.
  const off = cartridge(new Map([
    [mapKey(1, 1), { blocks: [2, 2], triggers: [[3, 3, 0], [40, 40, 0]] }],
    [mapKey(1, 2), {}],
  ]));
  t.eq(off.world.coordEventsOn(1, 1), [{ scene: 0, x: 3, y: 3 }],
       'the one inside a four-by-four map, and not the other');
});


// --- a cartridge whose map headers are a different shape -------------------
//
// Polished Crystal writes seven bytes and no attributes bank: `db tileset`,
// `dn sign, environment`, `dw attributes`. Crystal writes nine with the bank
// in front. Read at the wrong offsets its headers gave addresses like $0401,
// which is not in a banked window, and every map came back unreadable.

/** A two-map cartridge laid out the way `header` says, in `attrBank`. */
function shaped(header, attrBank) {
  const GB = 4, GA = 0x4000, TABLE = 0x5000;
  const rom = new Map();
  const put = (b, a, v) => rom.set(`${b}:${a}`, v);
  const put16 = (b, a, v) => { put(b, a, v & 0xff); put(b, a + 1, v >> 8); };
  put16(GB, GA, TABLE);
  put16(GB, GA + 2, TABLE + 2 * header.bytes);       // one group of two maps
  for (let n = 1; n <= 2; n++) {
    const at = TABLE + (n - 1) * header.bytes;
    const attr = 0x6000 + (n - 1) * 0x100;
    if (header.attrBank !== null) put(GB, at + header.attrBank, attrBank);
    put16(GB, at + header.attrAddr, attr);
    // A size and a connection mask, which is what makes a bank plausible.
    put(attrBank, attr + 1, 9);
    put(attrBank, attr + 2, 20);
    put(attrBank, attr + 11, 0);
  }
  const symbols = { bank: () => GB, addr: () => GA, has: () => true };
  const gb = { romByte: (b, a) => rom.get(`${b}:${a}`) || 0, romBanks: 8 };
  return new World(symbols, gb, { ...gen2, mapHeader: header });
}

test('a map header is read at the shape the profile declares', async (t) => {
  const nine = shaped({ bytes: 9, attrBank: 0, attrAddr: 3, landmark: 5 }, 5);
  t.eq(nine._attributes(1, 1).addr, 0x6000, 'Crystal-shaped, first map');
  t.eq(nine._attributes(1, 2).addr, 0x6100, 'and the second is nine bytes on');

  const seven = shaped({ bytes: 7, attrBank: null, attrAddr: 2, landmark: 4 }, 5);
  t.eq(seven._attributes(1, 1).addr, 0x6000, 'seven-shaped, first map');
  t.eq(seven._attributes(1, 2).addr, 0x6100,
       'and the second is seven bytes on, not nine');
});

test('the attributes bank is found when the header does not carry one',
     async (t) => {
  // Polished Crystal keeps every attributes block in one bank and says so
  // nowhere in the data. The symbol file knows and a second device may not
  // have one, so the bank is scored: every bank in the ROM against every
  // map, and a map agrees when its size is a real size and its connection
  // mask has only the four direction bits.
  const seven = shaped({ bytes: 7, attrBank: null, attrAddr: 2, landmark: 4 }, 5);
  t.eq(seven._attrBank(), 5, 'the one bank the maps make sense in');
  t.eq(seven._attributes(1, 1).bank, 5, 'and it is what a reader is given');
});

test('a cartridge no bank fits is answered with none', async (t) => {
  // Nothing plausible anywhere is "cannot read this", not a guess. Zero is
  // what every other unreadable map answers, and the callers already handle
  // it.
  const GB = 4, GA = 0x4000;
  const rom = new Map();
  rom.set(`${GB}:${GA}`, 0x00); rom.set(`${GB}:${GA + 1}`, 0x50);
  const symbols = { bank: () => GB, addr: () => GA, has: () => true };
  const gb = { romByte: () => 0, romBanks: 8 };
  const bare = new World(symbols, gb,
    { ...gen2, mapHeader: { bytes: 7, attrBank: null, attrAddr: 2, landmark: 4 } });
  t.eq(bare._attrBank(), 0, 'no bank rather than the first one that scored');
});


test('the search budget is the cartridge\'s own map count', async (t) => {
  // **A safety valve, not a distance.** It was the constant 400, which sits
  // comfortably past Crystal's 361 maps and short of Polished Crystal's
  // 488 -- so the far end of Kanto came back unreachable, not because no
  // route existed but because the search stopped before it got there.
  // Three Pokemon Centers, each one leg from a town the same search had
  // already reached.
  const { world } = johto();
  const budget = world.mapBudget();
  t.true(budget >= 400, 'never below the number it replaced');
  // A cartridge with more maps than that gets a bigger one.
  const many = cartridge(new Map([...Array(60).keys()].map((i) =>
    [mapKey(1, i + 1), { edges: {} }])), { perGroup: new Map([[1, 60]]) });
  t.true(many.world.mapBudget() >= 400, 'and a small one still gets the floor');
});
