// The test harness: a runner, some assertions, and a fake Game Boy.
//
// Everything here runs in Node with no ROM and no browser. That is not a
// limitation to work around, it is the point: the ROM is not in this repo and
// never will be, so a test that needs one cannot run on a clean checkout or in
// CI, and a test that cannot run there does not get run.
//
// What that leaves is still most of what goes wrong. The bugs this app has
// actually shipped were decisions made about a game state -- picking the wrong
// move, reporting a knockout as a getaway, giving up on a save too early,
// leaving the interface stuck after a throw. None of those need a real
// cartridge. They need a plausible work-RAM snapshot and a way to watch what
// the code does with it, which is what the fakes below provide.
import { writeFileSync } from 'node:fs';
import { RomData } from '../gen2/romdata.js';
import { Symbols } from '../gen2/symbols.js';
import { gen2 } from '../gen2/engine.js';

const GB_WRAM_START = 0xc000;
const WRAM_BYTES = 0x2000;
const SRAM_BYTES = 32768;

// --- the runner -------------------------------------------------------------
const cases = [];
export function test(name, fn) { cases.push({ name, fn }); }

export class Skipped extends Error {}
export class Failure extends Error {}

class Check {
  constructor() { this.notes = []; }

  note(msg) { this.notes.push(String(msg)); }
  skip(why) { throw new Skipped(why); }

  eq(got, want, what = '') {
    if (!same(got, want)) {
      throw new Failure(`${what || 'value'}: expected ${show(want)}, got ${show(got)}`);
    }
  }

  ne(got, unwanted, what = '') {
    if (same(got, unwanted)) {
      throw new Failure(`${what || 'value'}: expected anything but ${show(unwanted)}`);
    }
  }

  true(cond, what = '') {
    if (!cond) throw new Failure(what || 'expected true, got false');
  }

  false(cond, what = '') {
    if (cond) throw new Failure(what || 'expected false, got true');
  }

  gte(got, floor, what = '') {
    if (!(got >= floor)) {
      throw new Failure(`${what || 'value'}: expected >= ${show(floor)}, got ${show(got)}`);
    }
  }

  contains(haystack, needle, what = '') {
    if (!String(haystack).includes(needle)) {
      throw new Failure(`${what || 'value'}: ${show(needle)} not found in ${show(haystack)}`);
    }
  }

  async rejects(fn, what = '') {
    try {
      await fn();
    } catch (e) {
      return e;
    }
    throw new Failure(`${what || 'call'}: expected it to throw, nothing did`);
  }
}

/**
 * Deep equality, arrays and plain objects alike.
 *
 * Objects were compared by identity, which made `eq` unable to answer the
 * question it was asked and made `ne` unable to fail: two identical `{ low, high }`
 * were "different" every time, so a test asserting they differ passed while
 * proving nothing. And the report was the tell -- `expected {"low":2,"high":4},
 * got {"low":2,"high":4}`, the same text twice, because `show` could already
 * print what `same` could not read.
 *
 * Class instances stay on identity. Two `Map`s with the same contents are not
 * interchangeable to any code in this app, and walking their own enumerable
 * keys -- of which they have none -- would call every pair of Maps equal.
 */
function same(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((x, i) => same(x, b[i]));
  }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Object.getPrototypeOf(a) !== Object.prototype
      || Object.getPrototypeOf(b) !== Object.prototype) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length
         && keys.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
}

function show(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(show).join(', ')}]`;
  if (v && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * How long one test gets before the runner calls it a failure.
 *
 * A test that never returns cannot fail -- it hangs, and a hung suite reports
 * nothing at all. Not hypothetical: the bound on grind's heal loop was covered
 * by a test that, with the bound removed, span for ever instead of failing, so
 * the check meant to protect the bound would have wedged CI rather than naming
 * the bug.
 *
 * This catches the settling kind of hang -- an await on a promise nobody ever
 * resolves -- and names the test. It cannot catch a loop that awaits only
 * already-resolved promises: that starves the timer queue and this callback
 * never runs, which is why run-tests also watches from outside the process.
 * Every test here finishes in milliseconds; five seconds is a ceiling.
 */
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS) || 5000;
const INFLIGHT = process.env.TEST_INFLIGHT || null;

function withTimeout(work, ms) {
  let timer;
  const bell = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Failure(
      `did not finish within ${ms}ms -- a test that cannot finish cannot fail, `
      + 'so this would have hung the suite instead of reporting')), ms);
  });
  return Promise.race([work, bell]).finally(() => clearTimeout(timer));
}

export async function run(pattern = null, verbose = false) {
  let passed = 0, failed = 0, skipped = 0;
  const t0 = Date.now();
  for (const c of cases) {
    if (pattern && !c.name.toLowerCase().includes(pattern.toLowerCase())) continue;
    const t = new Check();
    // Written before the test starts, so a suite killed from outside can say
    // which test it died in. Synchronous on purpose: buffered, the name of the
    // one test that mattered is the one that never reaches the disk.
    if (INFLIGHT) {
      try { writeFileSync(INFLIGHT, c.name); } catch { /* only a lost name */ }
    }
    const started = Date.now();
    const secs = () => `(${((Date.now() - started) / 1000).toFixed(1)}s)`;
    try {
      await withTimeout(Promise.resolve(c.fn(t)), TIMEOUT_MS);
      passed++;
      console.log(`   ok   ${c.name}  ${secs()}`);
    } catch (e) {
      if (e instanceof Skipped) {
        skipped++;
        console.log(`   skip ${c.name} — ${e.message}  ${secs()}`);
      } else {
        failed++;
        console.log(`   FAIL ${c.name}  ${secs()}`);
        console.log(`          -> ${e.message}`);
        if (verbose && e.stack) console.log(e.stack.split('\n').slice(1, 4).join('\n'));
      }
    }
    if (verbose) for (const n of t.notes) console.log(`          . ${n}`);
  }
  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${passed} passed, ${failed} failed`
    + (skipped ? `, ${skipped} skipped` : '') + `  (${wall}s)`);
  return failed === 0 ? 0 : 1;
}

// --- a symbol table, without a build ----------------------------------------
// Addresses are assigned here rather than taken from a real .sym, and that is
// deliberate. state.js's job is to read whatever address the symbol table gives
// it; pinning the tests to one build's addresses would test the build instead,
// and would rot the day the ROM is rebuilt. The layout below only has to be
// self-consistent and non-overlapping.
const WRAM_NAMES = [
  ['wPartyCount', 1], ['wPartyMon1', 6 * 0x30],
  ['wBattleMode', 1], ['wMapGroup', 1], ['wMapNumber', 1], ['wMapStatus', 1],
  // **Y then X, because that is the cartridge's order** and `Nav.pos()` reads
  // both from one address: `wYCoord` at $dcb7 and `wXCoord` at $dcb8, checked
  // in the real symbol file. This fake allocated them the other way round, so
  // any test reading a position through the real `Nav` rather than through
  // `worldRam`'s named writes would have got the two transposed.
  ['wScriptMode', 1], ['wYCoord', 1], ['wXCoord', 1], ['wPlayerTileCollision', 1],
  // The two `Nav` needs to find the screen's scroll offset. Missing until now,
  // which is *why* nav.js had no tests: its constructor throws on a symbol
  // table without them, so no test could construct one and nobody noticed the
  // module was untested at all.
  ['wPlayerBGMapOffsetX', 1], ['wPlayerBGMapOffsetY', 1],
  ['wMenuCursorX', 1], ['wMenuCursorY', 1], ['wBattleMenuCursorPosition', 1],
  ['wEnemyMonSpecies', 1], ['wEnemyMonLevel', 1], ['wEnemyMonHP', 2],
  ['wEnemyMonMaxHP', 2], ['wBattleMonHP', 2], ['wBattleMonMaxHP', 2],
  // Both type slots on both sides. Gen 2 stores a single-typed Pokemon as
  // both of its types, so a fake that leaves slot two zero is claiming
  // NORMAL -- which is a real type and a wrong answer. `worldRam` writes both
  // from one value when a test gives it one.
  ['wEnemyMonType1', 1], ['wEnemyMonType2', 1],
  ['wBattleMonType1', 1], ['wBattleMonType2', 1],
  ['wNumBalls', 1], ['wBalls', 40], ['wNumItems', 1], ['wItems', 40],
  ['wMoney', 3],
  ['wCurPocket', 1], ['wCurItem', 1],
  ['wWindowStackSize', 1],
  // Two bytes of badge flags. Optional in `state.js`, and present here so the
  // *expiry* half of a written-off route can be tested: a badge is the thing
  // that opens one, so a cartridge that will not say has entries that never
  // expire, and that is a different behaviour worth being able to reach.
  ['wJohtoBadges', 1], ['wKantoBadges', 1],
  // The game's own record of what has happened, one bit per event. Sixteen
  // bytes is enough for every event this app reads and far short of the
  // cartridge's own table, which is the right trade for a fake: the addresses
  // are relative and only the ones a test sets are ever looked at.
  ['wEventFlags', 16],
  // The map, so a CollisionMap can be built at all. wOverworldMapBlocks is the
  // real size -- a stride of mapWidth+6 over a tall map indexes a long way in.
  ['wOverworldMapBlocks', 0x510], ['wMapWidth', 1], ['wMapHeight', 1],
  ['wTilesetCollisionBank', 1], ['wTilesetCollisionAddress', 2],
  ['wMapObjects', 16 * 0x10],
  // The tilemap: twenty by eighteen bytes of tile ids, which is where the words
  // on screen live.
  ['wTilemap', 20 * 18],
  // The live side of the same story: thirteen structs, the player's first.
  ['wObjectStructs', 13 * 0x28],
  // These four sit next to each other on purpose: state.js reads them as one
  // small window, and a layout that scattered them would not exercise that.
  ['wMenuDataItems', 1], ['wMenuBorderTopCoord', 1], ['wMenuBorderRightCoord', 1],
];

function buildSymText() {
  const lines = [];
  let at = GB_WRAM_START + 0x100;
  const put = (name, size) => {
    lines.push(`00:${at.toString(16).padStart(4, '0')} ${name}`);
    at += size;
  };
  for (const [name, size] of WRAM_NAMES) put(name, size);
  // wMenuCursorY has to be inside the menu window state.js builds, so it is
  // re-declared adjacent to the menu bytes. First definition wins in Symbols,
  // so this is only reached if the loop above did not already place it.
  // Save-validity markers live in SRAM bank 1, which is a different space.
  lines.push('10:5afb Moves');
  lines.push('0e:4000 PokemonNames');
  lines.push('0e:5000 ItemNames');
  lines.push('0d:4000 CollisionPermissionTable');
  // Where the real cartridge keeps them, because `tools/check-app types`
  // reads the same two names out of the same symbol file and a fake that
  // moved them would be testing a different cartridge.
  lines.push('0d:4bb1 TypeMatchups');
  lines.push('72:5f29 MoveNames');
  lines.push('01:a008 sCheckValue1');
  lines.push('01:ad0f sCheckValue2');
  return lines.join('\n') + '\n';
}

export function symbols() {
  return new Symbols(buildSymText());
}

// --- a Game Boy that is not there -------------------------------------------
export class FakeGameBoy {
  /**
   * `onPress` is the whole point: it is where a test says what the game does
   * when a button is pushed. Without it the machine is inert, which is right
   * for testing a refusal and useless for testing a sequence.
   */
  constructor({ wram = null, sram = null, onPress = null, onRun = null } = {}) {
    this.wram = wram || new Uint8Array(WRAM_BYTES);
    this.sram = sram || new Uint8Array(SRAM_BYTES);
    this.rom = new Uint8Array(16);
    this.presses = [];
    this.frames = 0;
    this.held = new Set();
    this.onPress = onPress;
    this.onRun = onRun;
  }

  async readWram() { return this.wram; }

  async readBytes(addr, len) {
    const at = addr - GB_WRAM_START;
    return this.wram.subarray(at, at + len);
  }

  romByte() { return 0; }

  async run(frames = 1) {
    this.frames += frames;
    if (this.onRun) await this.onRun(frames, this);
  }

  async press(buttons, frames = 6, gap = 6) {
    for (const b of [].concat(buttons)) this.presses.push(b);
    this.frames += frames + gap;
    if (this.onPress) await this.onPress([].concat(buttons)[0], this);
  }

  hold(b) { this.held.add(b); }
  release(b) { this.held.delete(b); }
  releaseAll() { this.held.clear(); }
  applyHeld() {}

  async batterySave() { return this.sram; }

  /** How many times a button was pushed, for asserting on a sequence. */
  count(button) { return this.presses.filter((p) => p === button).length; }
}

// --- building a game state --------------------------------------------------
const w8 = (wram, addr, v) => { wram[addr - GB_WRAM_START] = v & 0xff; };
const w16 = (wram, addr, v) => {
  wram[addr - GB_WRAM_START] = (v >> 8) & 0xff;      // big-endian, as Gen 2 does
  wram[addr - GB_WRAM_START + 1] = v & 0xff;
};

/**
 * A work-RAM snapshot describing a situation.
 *
 * Written in the language of the game rather than of addresses, so a test says
 * "in a wild battle against a 20 HP Pidgey with the battle menu up" and not
 * which byte that is.
 */
/**
 * Write text into the tilemap, the way the cartridge does.
 *
 * The inverse of `screen.js`, built from the same engine profile rather than
 * from a second table -- so a test that paints "PACK" and a reader that reads
 * "PACK" cannot drift apart, and a charmap that is wrong here is wrong there
 * too. Anything the charmap does not name is left as the blank tile, which is
 * what a graphic decodes to.
 */
export function paintScreen(wram, sym, lines, engine = gen2) {
  const cm = engine.charmap || {};
  const back = new Map();
  for (const [from, to, first] of cm.ranges || []) {
    for (let t = from; t <= to; t++) {
      back.set(String.fromCharCode(first.charCodeAt(0) + (t - from)), t);
    }
  }
  for (const [t, ch] of Object.entries(cm.singles || {})) back.set(ch, Number(t));
  const blank = back.get(' ') === undefined ? 0 : back.get(' ');
  const base = sym.addr('wTilemap') - GB_WRAM_START;
  for (let y = 0; y < 18; y++) {
    const line = (lines[y] || '').padEnd(20, ' ');
    for (let x = 0; x < 20; x++) {
      const ch = line[x];
      const tile = ch === '>' ? cm.cursor
        : back.has(ch) ? back.get(ch) : blank;
      wram[base + y * 20 + x] = tile === undefined ? blank : tile;
    }
  }
  return wram;
}

export function worldRam(sym, {
  party = [], battleMode = 0, map = [24, 3], pos = [5, 5], mapStatus = 2,
  scriptMode = 0, tile = 0, menu = [0, 0], battleCursor = 0, windowStack = 0,
  enemy = null, active = null, balls = [], items = [], money = 0,
  curPocket = 0, curItem = 0,
  menuItems = 0, menuTop = 0, menuRight = 0,
  // How many badges are in the case, as a count -- the bits are set from the
  // bottom up, because which bit is which badge is not something this app reads.
  badges = 0,
  // Which scripted events have happened, as a list of bit numbers. A list
  // rather than a count, because *which* event is the whole question here: a
  // gate names one bit and nothing else about the table matters.
  events = [],
  // The map's size in *blocks*; a block is two tiles each way. `objects` are
  // MAPOBJECT entries, whose coordinates the cartridge stores four higher than
  // the map's own -- given here the way the game gives them, so a test that
  // says (8,15) is saying what the ROM says.
  // `objects` are MAPOBJECT entries -- what the map *placed*, index 0 being the
  // player -- and `spawned` are the object structs, what the game has actually
  // loaded. They are separate arguments because on a cartridge they disagree:
  // a placement can have no struct (hidden by a flag, or too far away) and a
  // struct's coordinates move while its placement's never do. `placed` on a
  // spawned entry is the index into `objects` it points back at, which is how
  // the reader learns what a live object *is*.
  mapBlocks = null, objects = [], spawned = null,
  // `screen` is the words on screen, one string per row, painted into the
  // tilemap through the engine's own charmap -- so a test writes what a person
  // would read. A '>' becomes the cursor tile, which is how the arrow is drawn.
  screen = null,
} = {}) {
  const wram = new Uint8Array(WRAM_BYTES);
  w8(wram, sym.addr('wPartyCount'), party.length);
  party.forEach((mon, i) => {
    const base = sym.addr('wPartyMon1') + i * 0x30;
    w8(wram, base + 0x00, mon.species ?? 155);
    w8(wram, base + 0x1f, mon.level ?? 5);
    w16(wram, base + 0x22, mon.hp ?? 20);
    w16(wram, base + 0x24, mon.maxHp ?? 20);
    (mon.moves || []).forEach((m, k) => w8(wram, base + 0x02 + k, m));
    (mon.pp || []).forEach((p, k) => w8(wram, base + 0x17 + k, p));
    // The status byte, given as the raw byte the cartridge holds so a test can
    // say "asleep for three turns" and mean 3.
    w8(wram, base + 0x20, mon.statusByte ?? 0);
  });
  w8(wram, sym.addr('wBattleMode'), battleMode);
  w8(wram, sym.addr('wMapGroup'), map[0]);
  w8(wram, sym.addr('wMapNumber'), map[1]);
  w8(wram, sym.addr('wMapStatus'), mapStatus);
  w8(wram, sym.addr('wScriptMode'), scriptMode);
  w8(wram, sym.addr('wXCoord'), pos[0]);
  w8(wram, sym.addr('wYCoord'), pos[1]);
  w8(wram, sym.addr('wPlayerTileCollision'), tile);
  w8(wram, sym.addr('wMenuCursorX'), menu[0]);
  w8(wram, sym.addr('wMenuCursorY'), menu[1]);
  w8(wram, sym.addr('wBattleMenuCursorPosition'), battleCursor);
  w8(wram, sym.addr('wWindowStackSize'), windowStack);
  // Bits from the bottom of the two bytes, eight per byte.
  for (let i = 0; i < badges; i++) {
    const at = sym.addr('wJohtoBadges') + (i >> 3);
    wram[at - 0xc000] |= 1 << (i & 7);
  }
  for (const bit of events) {
    const at = sym.addr('wEventFlags') + (bit >> 3);
    wram[at - 0xc000] |= 1 << (bit & 7);
  }
  w8(wram, sym.addr('wMenuDataItems'), menuItems);
  w8(wram, sym.addr('wMenuBorderTopCoord'), menuTop);
  w8(wram, sym.addr('wMenuBorderRightCoord'), menuRight);
  // A `types` of one value writes both slots, the way the cartridge stores a
  // single-typed Pokemon; a pair writes the pair. Defaulting to NORMAL/NORMAL
  // rather than to zeroes is the same choice: zero *is* NORMAL, so there is
  // no "unset" to fake, and pretending otherwise would let a test pass on a
  // type the game cannot hold.
  const types = (given, fallback) => {
    const t = given === undefined || given === null ? fallback : given;
    const list = Array.isArray(t) ? t : [t, t];
    return [list[0], list.length > 1 ? list[1] : list[0]];
  };
  if (enemy) {
    w8(wram, sym.addr('wEnemyMonSpecies'), enemy.species ?? 16);
    w8(wram, sym.addr('wEnemyMonLevel'), enemy.level ?? 3);
    w16(wram, sym.addr('wEnemyMonHP'), enemy.hp ?? 20);
    w16(wram, sym.addr('wEnemyMonMaxHP'), enemy.maxHp ?? 20);
    const [t1, t2] = types(enemy.types, 0);
    w8(wram, sym.addr('wEnemyMonType1'), t1);
    w8(wram, sym.addr('wEnemyMonType2'), t2);
  }
  if (active) {
    w16(wram, sym.addr('wBattleMonHP'), active.hp ?? 20);
    w16(wram, sym.addr('wBattleMonMaxHP'), active.maxHp ?? 20);
    const [t1, t2] = types(active.types, 0);
    w8(wram, sym.addr('wBattleMonType1'), t1);
    w8(wram, sym.addr('wBattleMonType2'), t2);
  }
  if (mapBlocks) {
    w8(wram, sym.addr('wMapWidth'), mapBlocks[0]);
    w8(wram, sym.addr('wMapHeight'), mapBlocks[1]);
  }
  objects.forEach((o, i) => {
    const at = sym.addr('wMapObjects') + i * 0x10;
    w8(wram, at + 1, o.sprite ?? 1);
    w8(wram, at + 2, o.y ?? 0);
    w8(wram, at + 3, o.x ?? 0);
    // Colour in the high nibble, type in the low -- one byte the cartridge's
    // symbol file gives two names. The colour is arbitrary here and non-zero on
    // purpose, so a reader that forgets to mask reads a type nobody declared.
    w8(wram, at + 8, 0x90 | ((o.type ?? 0) & 0x0f));
  });
  // Struct 0 is the player's and is left empty: a sprite of zero is how the
  // game says a struct is unused, and every reader skips index 0 anyway.
  (spawned || []).forEach((o, i) => {
    const at = sym.addr('wObjectStructs') + (i + 1) * 0x28;
    w8(wram, at + 0, o.sprite ?? 1);
    w8(wram, at + 1, o.placed ?? 0);
    w8(wram, at + 0x10, o.x ?? 0);
    w8(wram, at + 0x11, o.y ?? 0);
  });
  w8(wram, sym.addr('wNumBalls'), balls.length);
  balls.forEach(([id, qty], i) => {
    w8(wram, sym.addr('wBalls') + i * 2, id);
    w8(wram, sym.addr('wBalls') + i * 2 + 1, qty);
  });
  // Three bytes, big-endian, plain binary -- the encoding measured on a new
  // game, where [0x00, 0x0b, 0xb8] reads 3000.
  w8(wram, sym.addr('wMoney'), (money >> 16) & 0xff);
  w8(wram, sym.addr('wMoney') + 1, (money >> 8) & 0xff);
  w8(wram, sym.addr('wMoney') + 2, money & 0xff);
  w8(wram, sym.addr('wNumItems'), items.length);
  items.forEach(([id, qty], i) => {
    w8(wram, sym.addr('wItems') + i * 2, id);
    w8(wram, sym.addr('wItems') + i * 2 + 1, qty);
  });
  w8(wram, sym.addr('wCurPocket'), curPocket);
  w8(wram, sym.addr('wCurItem'), curItem);
  if (screen) paintScreen(wram, sym, screen);
  return wram;
}

/** Write the cartridge's own "there is a save here" markers into a battery. */
export function markSaved(sram, sym, present = true) {
  const at = (name) => sym.bank(name) * 0x2000 + (sym.addr(name) - 0xa000);
  sram[at('sCheckValue1')] = present ? 99 : 0;
  sram[at('sCheckValue2')] = present ? 127 : 0;
  return sram;
}

// --- a cartridge's tables, without a cartridge ------------------------------
// The type numbers Gen 2 uses, as far as the fakes need them. Written here
// rather than in a test, because a move's type and a Pokemon's type have to
// come from the same numbering or every matchup in every test is a coincidence.
export const TYPE = {
  NORMAL: 0, FIGHTING: 1, FLYING: 2, POISON: 3, GROUND: 4, ROCK: 5, BUG: 7,
  GHOST: 8, STEEL: 9, FIRE: 0x14, WATER: 0x15, GRASS: 0x16, ELECTRIC: 0x17,
  PSYCHIC: 0x18, ICE: 0x19, DRAGON: 0x1a, DARK: 0x1b,
};

export function fakeRom({ moves = {}, species = {}, items = {}, chart = [],
                          landmarks = {} } = {}) {
  const MOVES = {
    33: { id: 33, name: 'TACKLE', power: 35, effect: 0, pp: 35, type: TYPE.NORMAL },
    43: { id: 43, name: 'LEER', power: 0, effect: 19, pp: 30, type: TYPE.NORMAL },
    52: { id: 52, name: 'EMBER', power: 40, effect: 4, pp: 25, type: TYPE.FIRE },
    32: { id: 32, name: 'HORN DRILL', power: 1, effect: 38, pp: 5, type: TYPE.NORMAL },
    75: { id: 75, name: 'RAZOR LEAF', power: 55, effect: 0, pp: 25, type: TYPE.GRASS },
    55: { id: 55, name: 'WATER GUN', power: 40, effect: 0, pp: 25, type: TYPE.WATER },
    ...moves,
  };
  const UNGENTLE = new Set([38, 40, 87, 88, 89, 144]);
  // Enough of the cartridge's chart to price the moves above, in the shape the
  // cartridge stores it: `[attacking, defending, tenths]`, and a pair that is
  // not here is neutral. Copied off the ROM, not remembered -- these are the
  // rows `tools/check-app types` asserts against the real table.
  const CHART = new Map([
    [TYPE.NORMAL, TYPE.ROCK, 5], [TYPE.NORMAL, TYPE.STEEL, 5],
    [TYPE.NORMAL, TYPE.GHOST, 0],
    [TYPE.FIRE, TYPE.GRASS, 20], [TYPE.FIRE, TYPE.BUG, 20],
    [TYPE.FIRE, TYPE.STEEL, 20], [TYPE.FIRE, TYPE.ICE, 20],
    [TYPE.FIRE, TYPE.WATER, 5], [TYPE.FIRE, TYPE.ROCK, 5],
    [TYPE.FIRE, TYPE.FIRE, 5], [TYPE.FIRE, TYPE.DRAGON, 5],
    [TYPE.WATER, TYPE.FIRE, 20], [TYPE.WATER, TYPE.ROCK, 20],
    [TYPE.WATER, TYPE.GROUND, 20], [TYPE.WATER, TYPE.WATER, 5],
    [TYPE.WATER, TYPE.GRASS, 5], [TYPE.WATER, TYPE.DRAGON, 5],
    [TYPE.GRASS, TYPE.WATER, 20], [TYPE.GRASS, TYPE.ROCK, 20],
    [TYPE.GRASS, TYPE.GROUND, 20], [TYPE.GRASS, TYPE.FIRE, 5],
    [TYPE.GRASS, TYPE.GRASS, 5], [TYPE.GRASS, TYPE.BUG, 5],
    [TYPE.GRASS, TYPE.FLYING, 5], [TYPE.GRASS, TYPE.POISON, 5],
    [TYPE.GRASS, TYPE.STEEL, 5], [TYPE.GRASS, TYPE.DRAGON, 5],
    [TYPE.ELECTRIC, TYPE.GROUND, 0], [TYPE.ELECTRIC, TYPE.WATER, 20],
    [TYPE.ELECTRIC, TYPE.FLYING, 20], [TYPE.ELECTRIC, TYPE.GRASS, 5],
    ...chart,
  ].map(([a, d, m]) => [(a << 8) | d, m]));
  return {
    move: (id) => MOVES[id] || null,
    moveName: (id) => (MOVES[id] ? MOVES[id].name : ''),
    isChipMove: (id) => {
      const m = MOVES[id];
      return !!m && m.power > 0 && !UNGENTLE.has(m.effect);
    },
    // The chart is a table, so it is faked; everything built on top of it is
    // the real method, borrowed. A stub of "how hard does this land" would
    // agree with itself about the multiplication, the deduplication of a
    // single-typed Pokemon's two slots, and the same-type bonus -- which are
    // the three things that can be wrong.
    e: gen2,
    matchups() { return CHART; },
    matchup: RomData.prototype.matchup,
    effectiveness: RomData.prototype.effectiveness,
    hitPower: RomData.prototype.hitPower,
    canHit: RomData.prototype.canHit,
    speciesName: (id) => species[id] || `SPECIES_${id}`,
    itemName: (id) => items[id] || `ITEM_${id}`,
    // What the cartridge calls a place. A table rather than the real reader,
    // because the reader needs a ROM and the callers only need the answer --
    // `landmarks: null` stands for a cartridge whose symbol file has no table.
    landmarks: landmarks,
    landmarkName(id) { return this.landmarks ? (this.landmarks[id] || '') : ''; },
    // The real method, borrowed rather than restated: a stub of "which item is
    // cheapest" would test the stub, and the fold it does on the way is the
    // part that can be wrong.
    cheapestOf: RomData.prototype.cheapestOf,
  };
}

/**
 * The real RomData, reading a move table we supply.
 *
 * Worth the extra few lines over a hand-written stub: a stub of `isChipMove`
 * tests the stub. This drives the actual selection logic, byte layout and all,
 * so reverting the fix in romdata.js fails a test rather than passing one.
 */
/**
 * A `gb` that answers `romByte` from a real collision permission table.
 *
 * Every collision test until now passed `{ romByte: () => 0 }`, which means
 * `permission()` answered LAND for every byte on the map -- so `isWall`,
 * `isWater`, and every rule built on them ran on each of those tests and was
 * checked by none of them. `tools/mutate` put the number on it: eighteen per
 * cent of `collision.js` mutations caught, in the module that decides where the
 * pilot may walk.
 *
 * `perms` maps a collision byte to its permission nybble; anything not named
 * reads LAND, which is what the old stub did for everything.
 */
export function collisionRom(perms = {}) {
  const sym = symbols();
  const bank = sym.bank('CollisionPermissionTable');
  const addr = sym.addr('CollisionPermissionTable');
  return {
    romByte(b, at) {
      if (b !== bank) return 0;
      const coll = at - addr;
      return perms[coll] ?? 0;
    },
  };
}

/**
 * A real `RomData` over tables we lay out ourselves.
 *
 * `chart` and `names` are handed over as *bytes*, not as a decoded structure,
 * and that is the whole value of them: the separator in the type chart is one
 * byte where every row is three, and a fake that handed over rows could not
 * be read wrongly. Reading $fe as a row eats the row behind it, which is a
 * mistake this made and a test can only catch from the bytes out.
 */
export function romReading(moveTable, { chart = null, names = null } = {}) {
  const sym = symbols();
  const { bank, addr } = { bank: sym.bank('Moves'), addr: sym.addr('Moves') };
  const chartAt = { bank: sym.bank('TypeMatchups'), addr: sym.addr('TypeMatchups') };
  const namesAt = { bank: sym.bank('MoveNames'), addr: sym.addr('MoveNames') };
  const MOVE_BYTES = 7;
  const gb = {
    romByte(b, at) {
      if (chart && b === chartAt.bank && at >= chartAt.addr
          && at < chartAt.addr + chart.length) {
        return chart[at - chartAt.addr];
      }
      if (names && b === namesAt.bank && at >= namesAt.addr
          && at < namesAt.addr + names.length) {
        return names[at - namesAt.addr];
      }
      if (b !== bank) return 0;
      const offset = at - addr;
      const id = Math.floor(offset / MOVE_BYTES) + 1;
      const field = offset % MOVE_BYTES;
      const m = moveTable[id];
      if (!m) return 0;
      // data/moves/moves.asm: animation, effect, power, type, accuracy, pp.
      if (field === 1) return m.effect ?? 0;
      if (field === 2) return m.power ?? 0;
      if (field === 3) return m.type ?? 0;
      if (field === 5) return m.pp ?? 0;
      return 0;
    },
  };
  return new RomData(sym, gb, ['JohtoGrassWildMons', 'KantoGrassWildMons']);
}
