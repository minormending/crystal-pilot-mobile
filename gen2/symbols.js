// The symbol table, parsed from the pokecrystal build's .sym file.
//
// This is the part of the desktop pilot that ports unchanged and is worth the
// most: every address comes from the same file the ROM was assembled with, so
// nothing here is a magic number that can drift.
const LINE = /^([0-9A-Fa-f]{2,3}):([0-9A-Fa-f]{4})\s+(\S+)\s*$/;

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

  /** Fail at load time, not mid-task, if the file is from another build. */
  require(names) {
    const missing = names.filter((n) => !this.map.has(n));
    if (missing.length) {
      throw new Error(
        `this .sym file is missing ${missing.length} expected symbol(s): ` +
        missing.slice(0, 4).join(', ') +
        ' — is it from a pokecrystal build?'
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
  'KantoGrassWildMons', 'MapGroupPointers',
  'Moves', 'PokemonNames', 'sCheckValue1', 'sCheckValue2', 'wBalls', 'wBattleMenuCursorPosition',
  'wBattleMode', 'wBattleMonHP', 'wBattleMonMaxHP', 'wCurItem', 'wCurPocket',
  'wEnemyMonHP', 'wEnemyMonLevel', 'wEnemyMonMaxHP', 'wEnemyMonSpecies',
  'wMapGroup', 'wMapHeight', 'wMapNumber', 'wMapObjects', 'wMapStatus',
  'wMapWidth', 'wMenuBorderRightCoord', 'wMenuBorderTopCoord',
  'wMenuCursorX', 'wMenuCursorY', 'wMenuDataItems', 'wNumBalls',
  'wOverworldMapBlocks', 'wPartyCount', 'wPartyMon1', 'wPlayerBGMapOffsetX',
  'wPlayerBGMapOffsetY', 'wPlayerTileCollision', 'wScriptMode',
  'wTilesetCollisionAddress', 'wTilesetCollisionBank', 'wTimeOfDay',
  'wWindowStackSize', 'wXCoord', 'wYCoord',
];
