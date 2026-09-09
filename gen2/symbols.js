// The symbol table, parsed from the pokecrystal build's .sym file.
//
// This is the part of the desktop pilot that ports unchanged and is worth the
// most: every address comes from the same file the ROM was assembled with, so
// nothing here is a magic number that can drift.
import { GB_WRAM_START, GB_WRAM_BYTES } from '../gbcore/gb.js';

const LINE = /^([0-9A-Fa-f]{2,3}):([0-9A-Fa-f]{4})\s+(\S+)\s*$/;

// pokecrystal names a variable for the memory it lives in: `w` and a capital is
// work RAM, `s` is SRAM, `h` is HRAM, and a bare capital is a ROM label. That
// convention is the only thing that says which of this app's reads go through a
// work-RAM snapshot, and it is worth relying on because the build enforces it --
// the sections are declared in the linker script, not chosen per symbol.
const WRAM_NAME = /^w[A-Z]/;

/** Is this an address the work-RAM snapshot actually covers? */
function inWram(addr) {
  return addr >= GB_WRAM_START && addr < GB_WRAM_START + GB_WRAM_BYTES;
}

export class Symbols {
  constructor(text) {
    this.map = new Map();
    for (const raw of text.split(/\r?\n/)) {
      const m = LINE.exec(raw.split(';')[0]);
      // First definition wins; later duplicates are aliases and locals.
      if (m && !this.map.has(m[3])) {
        this.map.set(m[3], { bank: parseInt(m[1], 16), addr: parseInt(m[2], 16) });
      }
    }
  }

  get size() { return this.map.size; }
  has(name) { return this.map.has(name); }

  addr(name) {
    const e = this.map.get(name);
    if (!e) throw new Error(`symbol not in this .sym file: ${name}`);
    return e.addr;
  }

  /** The ROM bank a symbol lives in -- needed to find it in the cartridge. */
  bank(name) {
    const e = this.map.get(name);
    if (!e) throw new Error(`symbol not in this .sym file: ${name}`);
    return e.bank;
  }

  /**
   * The same table, from the handful of names an app actually uses.
   *
   * A .sym is 1.8MB and this app looks up 45 symbols in it, so a second device
   * does not need the file -- it needs those 45 lines, which are about a
   * kilobyte and fit in a room with space to spare. Every method above works
   * the same way on one built like this; `size` is the only honest difference,
   * and it says 45 because that is how many symbols this table has.
   *
   * The digest is only ever usable against the ROM it was taken from -- these
   * are addresses in one build's memory map -- so whoever hands one over has
   * to say which cartridge it belongs to, and whoever takes it has to check.
   * That check is the caller's, because this class has never seen a ROM.
   */
  static fromDigest(map) {
    const s = Object.create(Symbols.prototype);
    s.map = new Map();
    for (const [name, at] of Object.entries(map || {})) {
      if (!Array.isArray(at) || at.length !== 2) continue;
      const [bank, addr] = at;
      if (!Number.isInteger(bank) || !Number.isInteger(addr)) continue;
      s.map.set(name, { bank, addr });
    }
    return s;
  }

  /** The digest of these names, for handing to a device with no .sym file. */
  digest(names) {
    const out = {};
    for (const name of names) {
      const e = this.map.get(name);
      if (e) out[name] = [e.bank, e.addr];
    }
    return out;
  }

  /**
   * Fail at load time, not mid-task, if the file is from another build.
   *
   * Two questions, and the second one is here because the first is not enough.
   *
   * *Are the names present?* Asked of the list handed in, which is deliberately
   * narrower than everything the app reads -- a hack that renamed its wild
   * tables should lose the species picker and keep the rest, so that gate stays
   * lenient.
   *
   * *Are the addresses somewhere this app can read them?* Asked of every
   * work-RAM symbol the table actually holds, and it is a different question
   * with a much worse failure. Every `w` read goes through one snapshot of
   * 0xC000-0xDFFF, and `GameBoy.byteAt` reaches into it by subtracting the base
   * -- so an address outside that window does not throw, it returns `undefined`.
   * Measured with `wBattleMode` moved into HRAM, which is a thing a hack can do
   * and which this file loaded without a word: `battleMode` read `undefined`,
   * `inBattle` was therefore `undefined !== 0`, and the pilot believed it was in
   * a battle it could never leave. Nothing downstream can diagnose that, because
   * by then the address is gone and only the rubbish it read is left.
   *
   * So placement is checked over the whole read-list rather than over `names`:
   * presence is the caller's question and may be answered leniently, but an
   * address that cannot be read is never usable, whoever asked for it.
   */
  require(names) {
    const missing = names.filter((n) => !this.map.has(n));
    if (missing.length) {
      throw new Error(
        `this .sym file is missing ${missing.length} expected symbol(s): ` +
        missing.slice(0, 4).join(', ') +
        ' — is it from a pokecrystal build?'
      );
    }
    const astray = SHARED_SYMBOLS.filter(
      (n) => WRAM_NAME.test(n) && this.map.has(n) && !inWram(this.map.get(n).addr));
    if (astray.length) {
      const show = astray.slice(0, 3).map(
        (n) => `${n} at $${this.map.get(n).addr.toString(16)}`);
      throw new Error(
        `${astray.length} symbol(s) this app reads are outside work RAM `
        + `($${GB_WRAM_START.toString(16)}-$`
        + `${(GB_WRAM_START + GB_WRAM_BYTES - 1).toString(16)}): `
        + `${show.join(', ')} — this app reads them from a snapshot of that `
        + 'window, so it cannot see them at all'
      );
    }
  }
}

/**
 * Every symbol this app reads, by name.
 *
 * It exists so a device with a ROM and no .sym can be handed the addresses
 * instead of the file: 45 lines is about a kilobyte, against 1.8MB, and it
 * fits in a room with space for a save beside it.
 *
 * Written down rather than discovered, because nothing at run time can know
 * which names the code is *going* to ask for. That makes it exactly the kind
 * of list that rots, so `tools/check-app` reads every `symbols.addr('...')` in
 * the app and fails if one is missing from here -- a symbol looked up but not
 * shared is a device that works with the file and breaks without it, which is
 * the sort of difference that only shows up on the second phone.
 */
export const SHARED_SYMBOLS = [
  'CollisionPermissionTable', 'ItemNames', 'JohtoGrassWildMons',
  'KantoGrassWildMons', 'Landmarks', 'MapGroupPointers',
  'Moves', 'PokemonNames', 'sCheckValue1', 'sCheckValue2', 'wBalls', 'wBattleMenuCursorPosition',
  'wBattleMode', 'wBattleMonHP', 'wBattleMonMaxHP', 'wCurItem', 'wCurPocket',
  'wEnemyMonHP', 'wEnemyMonLevel', 'wEnemyMonMaxHP', 'wEnemyMonSpecies',
  'wEventFlags',
  'wMapGroup', 'wMapHeight', 'wMapNumber', 'wMapObjects', 'wMapStatus',
  'wMapWidth', 'wMenuBorderRightCoord', 'wMenuBorderTopCoord',
  'wItems', 'wJohtoBadges',
  'wMenuCursorX', 'wMenuCursorY', 'wMenuDataItems', 'wMoney',
  'wNumBalls',
  'wNumItems',
  'wObjectStructs',
  'wOverworldMapBlocks', 'wPartyCount', 'wPartyMon1', 'wPlayerBGMapOffsetX',
  'wPlayerBGMapOffsetY', 'wPlayerTileCollision', 'wScriptMode',
  'wTilemap',
  'wTilesetCollisionAddress', 'wTilesetCollisionBank', 'wTimeOfDay',
  'wWindowStackSize', 'wXCoord', 'wYCoord',
];

/**
 * Which names travel to a device that has the ROM and no `.sym`.
 *
 * `SHARED_SYMBOLS` is the *app's* list -- everything it looks up, checked
 * one-directionally by `check-app`. A cartridge's wild tables are not the app's
 * to name: which regions exist is the title's, and Crystal's two happen to be
 * in the list because Crystal is the cartridge this was written against.
 *
 * A hack that renamed its encounter table would otherwise hand the other device
 * a digest holding two names it does not use and not the one it does -- and
 * that device would boot, walk and save with nothing to hunt, which is exactly
 * the second-phone failure the shared list exists to prevent.
 */
export function sharedNames(title = null) {
  const mine = (title && title.encounters) || [];
  return [...new Set([...SHARED_SYMBOLS, ...mine])];
}
