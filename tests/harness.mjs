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

function same(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => same(x, b[i]));
  }
  return false;
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
  ['wScriptMode', 1], ['wXCoord', 1], ['wYCoord', 1], ['wPlayerTileCollision', 1],
  ['wMenuCursorX', 1], ['wMenuCursorY', 1], ['wBattleMenuCursorPosition', 1],
  ['wEnemyMonSpecies', 1], ['wEnemyMonLevel', 1], ['wEnemyMonHP', 2],
  ['wEnemyMonMaxHP', 2], ['wBattleMonHP', 2], ['wBattleMonMaxHP', 2],
  ['wNumBalls', 1], ['wBalls', 40], ['wCurPocket', 1], ['wCurItem', 1],
  ['wWindowStackSize', 1],
  // The map, so a CollisionMap can be built at all. wOverworldMapBlocks is the
  // real size -- a stride of mapWidth+6 over a tall map indexes a long way in.
  ['wOverworldMapBlocks', 0x510], ['wMapWidth', 1], ['wMapHeight', 1],
  ['wTilesetCollisionBank', 1], ['wTilesetCollisionAddress', 2],
  ['wMapObjects', 16 * 0x10],
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
export function worldRam(sym, {
  party = [], battleMode = 0, map = [24, 3], pos = [5, 5], mapStatus = 2,
  scriptMode = 0, tile = 0, menu = [0, 0], battleCursor = 0, windowStack = 0,
  enemy = null, active = null, balls = [], curPocket = 0, curItem = 0,
  menuItems = 0, menuTop = 0, menuRight = 0,
  // The map's size in *blocks*; a block is two tiles each way. `objects` are
  // MAPOBJECT entries, whose coordinates the cartridge stores four higher than
  // the map's own -- given here the way the game gives them, so a test that
  // says (8,15) is saying what the ROM says.
  mapBlocks = null, objects = [],
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
  w8(wram, sym.addr('wMenuDataItems'), menuItems);
  w8(wram, sym.addr('wMenuBorderTopCoord'), menuTop);
  w8(wram, sym.addr('wMenuBorderRightCoord'), menuRight);
  if (enemy) {
    w8(wram, sym.addr('wEnemyMonSpecies'), enemy.species ?? 16);
    w8(wram, sym.addr('wEnemyMonLevel'), enemy.level ?? 3);
    w16(wram, sym.addr('wEnemyMonHP'), enemy.hp ?? 20);
    w16(wram, sym.addr('wEnemyMonMaxHP'), enemy.maxHp ?? 20);
  }
  if (active) {
    w16(wram, sym.addr('wBattleMonHP'), active.hp ?? 20);
    w16(wram, sym.addr('wBattleMonMaxHP'), active.maxHp ?? 20);
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
  });
  w8(wram, sym.addr('wNumBalls'), balls.length);
  balls.forEach(([id, qty], i) => {
    w8(wram, sym.addr('wBalls') + i * 2, id);
    w8(wram, sym.addr('wBalls') + i * 2 + 1, qty);
  });
  w8(wram, sym.addr('wCurPocket'), curPocket);
  w8(wram, sym.addr('wCurItem'), curItem);
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
export function fakeRom({ moves = {}, species = {}, items = {} } = {}) {
  const MOVES = {
    33: { id: 33, name: 'TACKLE', power: 35, effect: 0, pp: 35 },
    43: { id: 43, name: 'LEER', power: 0, effect: 19, pp: 30 },
    52: { id: 52, name: 'EMBER', power: 40, effect: 4, pp: 25 },
    32: { id: 32, name: 'HORN DRILL', power: 1, effect: 38, pp: 5 },
    ...moves,
  };
  const UNGENTLE = new Set([38, 40, 87, 88, 89, 144]);
  return {
    move: (id) => MOVES[id] || null,
    isChipMove: (id) => {
      const m = MOVES[id];
      return !!m && m.power > 0 && !UNGENTLE.has(m.effect);
    },
    speciesName: (id) => species[id] || `SPECIES_${id}`,
    itemName: (id) => items[id] || `ITEM_${id}`,
  };
}

/**
 * The real RomData, reading a move table we supply.
 *
 * Worth the extra few lines over a hand-written stub: a stub of `isChipMove`
 * tests the stub. This drives the actual selection logic, byte layout and all,
 * so reverting the fix in romdata.js fails a test rather than passing one.
 */
export function romReading(moveTable) {
  const sym = symbols();
  const { bank, addr } = { bank: sym.bank('Moves'), addr: sym.addr('Moves') };
  const MOVE_BYTES = 7;
  const gb = {
    romByte(b, at) {
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
