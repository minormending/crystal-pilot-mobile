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

const SIDES = { UP: 0x8, DOWN: 0x4, LEFT: 0x2, RIGHT: 0x1 };
// The structs are stored north, south, west, east whatever subset is present.
const ORDER = ['UP', 'DOWN', 'LEFT', 'RIGHT'];

/**
 * A cartridge whose maps are whatever you describe.
 *
 * `maps` is keyed by map key: `{ edges: { RIGHT: key, ... }, warps: [[x,y,key]] }`.
 */
function cartridge(maps) {
  const GROUPS_BANK = 1, GROUPS_ADDR = 0x4000;
  const ATTR_BANK = 2, EVENT_BANK = 3;
  const rom = new Map();                       // "bank:addr" -> byte
  const put = (bank, addr, v) => rom.set(`${bank}:${addr}`, v & 0xff);
  const put16le = (bank, addr, v) => { put(bank, addr, v & 0xff); put(bank, addr + 1, v >> 8); };

  // One pointer table per group, and a header per map inside it. Both are
  // little-endian words, which is how the ROM stores them.
  const groups = new Map();
  let nextGroupTable = 0x5000, nextAttr = 0x6000, nextEvents = 0x100;
  for (const key of maps.keys()) {
    const g = key >> 8;
    if (!groups.has(g)) {
      groups.set(g, nextGroupTable);
      put16le(GROUPS_BANK, GROUPS_ADDR + (g - 1) * 2, nextGroupTable);
      nextGroupTable += 0x400;
    }
  }
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
    const warps = spec.warps || [];
    put(EVENT_BANK, events + 2, warps.length);
    warps.forEach(([x, y, to], i) => {
      const w = events + 3 + i * 5;
      put(EVENT_BANK, w + 0, y);
      put(EVENT_BANK, w + 1, x);
      put(EVENT_BANK, w + 3, to >> 8);
      put(EVENT_BANK, w + 4, to & 0xff);
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

test('a map the cartridge does not have reads as nothing, not as a crash',
     async (t) => {
  const { world } = johto();
  t.eq(world.neighbours(99, 99), [], 'nonsense reads give an empty list');
  t.eq(world.warps(99, 99), [], 'and no warps');
  t.eq(world.route(mapKey(99, 99), BARK), null, 'and no route out of nowhere');
});
