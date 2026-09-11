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

  /**
   * The address of whichever of these names this cartridge uses.
   *
   * One thing, several words for it. Polished Crystal keeps the battle
   * menu's selection in `wBattleMenuCursorBuffer` and Crystal keeps it in
   * `wBattleMenuCursorPosition`; both hold 1 FIGHT, 2 PKMN, 3 PACK, 4 RUN,
   * and asking for one name threw on arrival and took the whole app with it
   * -- `GameState`'s constructor reads it, so a cartridge that had renamed
   * one variable could not be opened at all.
   *
   * The order is the order of preference, and the first *present* name wins
   * rather than the first that resolves to something: a name that is not in
   * the file is not an address, and there is nothing to prefer about it.
   *
   * Failing names all of them, because "symbol not in this .sym file:
   * wBattleMenuCursorPosition" sends whoever reads it looking for a symbol
   * that was never going to be there.
   */
  pick(...names) {
    for (const name of names) if (this.map.has(name)) return this.addr(name);
    throw new Error(`no symbol in this .sym file for any of: ${names.join(', ')}`);
  }

  /** Whether any of these names is one this cartridge uses. */
  hasAny(...names) { return names.some((n) => this.map.has(n)); }

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
    // An entry may be **several names for one thing**, the way `pick` takes
    // them: Polished Crystal calls the collision bank `wTilesetDataBank`,
    // and this gate turned that cartridge away at the door with "missing 1
    // expected symbol" long after every reader behind it had learned the
    // other name. Found by booting it, which is the only thing that could
    // have found it.
    const missing = names
      .map((n) => (Array.isArray(n) ? n : [n]))
      .filter((group) => !group.some((n) => this.map.has(n)))
      .map((group) => group.join(' or '));
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
 * instead of the file: 104 lines is about a kilobyte, against 1.8MB, and it
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
  'BaseData',
  'CollisionPermissionTable', 'ItemNames', 'JohtoGrassWildMons',
  'KantoGrassWildMons', 'Landmarks', 'MapGroupPointers',
  'MoveNames', 'Moves', 'PokemonNames', 'sCheckValue1', 'sCheckValue2', 'wBalls', 'wBattleMenuCursorPosition', 'wBattleMenuCursorBuffer',
  'wBattleMode', 'wBattleMonHP', 'wBattleMonMaxHP', 'wCurItem', 'wCurPocket',
  'TrainerClassNames', 'TrainerGroups', 'TypeMatchups', 'TypeNames',
  // Which hours are morning, day and night. Optional, and it is what turns
  // "wait for the hour" into "move the clock to it" -- so a second device
  // without it keeps the wait and loses the skip.
  'TimesOfDay',
  // What a species turns into and what it learns doing it, and the
  // cartridge's own word for a type number. Both feed the dex card, both
  // are optional in `romdata.js`, and both have to travel: a second phone
  // with a digest and no .sym reads the ROM through these addresses, so a
  // name missing here is a dex that works on one device and not the other.
  'EvosAttacksPointers',
  // The party icon, and the two colours the game paints it in. Four names for
  // one picture, because Gen 2 keeps it in four places: a byte per species
  // saying which icon, a pointer per icon, the tiles themselves, and the
  // palette. All four are optional in `romdata.js` and all four have to
  // travel for the same reason `EvosAttacksPointers` does -- a second phone
  // with a digest and no .sym reads the ROM through these addresses, so a
  // name missing here is a lens that is empty on one device and not the other.
  'MonMenuIcons', 'IconPointers', 'Icons', 'PokemonPalettes',
  'wBattleMonType1', 'wBattleMonType2',
  'wEnemyMonHP', 'wEnemyMonLevel', 'wEnemyMonMaxHP', 'wEnemyMonSpecies',
  'wEnemyMonType1', 'wEnemyMonType2',
  'wEventFlags',
  // The game's own playtime. Optional in `state.js` and shared because a
  // device with a digest and no .sym has to be able to tell a clock that
  // will not move from a game that is not running.
  'wGameTimeHours', 'wGameTimeMinutes', 'wGameTimeSeconds',
  // The saved block, its checksum, and the four bytes of clock offset
  // inside it. A device editing a battery needs every one of them, and
  // the SRAM names travel the same way the work-RAM ones do.
  'sGameData', 'sGameDataEnd', 'sChecksum', 'wPlayerData',
  'wStartDay', 'wStartHour', 'wStartMinute', 'wStartSecond',
  'wMapGroup', 'wMapHeight', 'wMapNumber', 'wMapObjects', 'wMapStatus',
  'wMapWidth', 'wMenuBorderLeftCoord', 'wMenuBorderRightCoord',
  'wMenuBorderTopCoord',
  'wItems', 'wJohtoBadges',
  // Where a badge-scaled wild level's base is kept. Only a cartridge
  // that scales them has it -- `digest()` skips a name a cartridge does
  // not use -- and without it in the digest a second device reads the
  // sentinel and offers a Lv179 Ditto.
  'wBadgeBaseLevel',
  'wMenuCursorX', 'wMenuCursorY', 'wMenuDataItems', 'wMoney',
  'wNumBalls',
  'wNumItems',
  'wObjectStructs',
  'wOverworldMapBlocks', 'wPartyCount', 'wPartyMon1', 'wPlayerBGMapOffsetX',
  // Every field of a party entry, because where they are is the cartridge's
  // to say and not this app's -- see `monLayout` in state.js. Polished
  // Crystal moves five of them, and a layout read off the .sym on one device
  // and defaulted from the profile on another is two different dex cards.
  // `digest()` skips a name a cartridge does not use, so the pairs here cost
  // a build that has only one of them nothing.
  'wPartyMon1Species', 'wPartyMon1Item', 'wPartyMon1Moves', 'wPartyMon1Exp',
  'wPartyMon1StatExp', 'wPartyMon1EVs', 'wPartyMon1DVs',
  'wPartyMon1Personality', 'wPartyMon1PP', 'wPartyMon1Happiness',
  'wPartyMon1CaughtData', 'wPartyMon1Level', 'wPartyMon1Status',
  'wPartyMon1HP', 'wPartyMon1MaxHP', 'wPartyMon1Stats', 'wPartyMon1Attack',
  // The game's own record of what has been seen and caught, one bit per
  // species. Optional in `state.js` and shared for the same reason the ROM
  // tables above are: a device with a digest and no .sym reads work RAM
  // through these addresses too.
  'wPokedexCaught', 'wPokedexSeen',
  'wPlayerBGMapOffsetY', 'wPlayerTileCollision', 'wScriptMode',
  'wTilemap',
  'wTilesetCollisionAddress', 'wTilesetCollisionBank', 'wTilesetDataBank',
  // The table a cartridge unpacked into work RAM, where it has one. Shared
  // because a device with a digest and no .sym reads the collision map
  // through it -- and without it that device would silently fall back to a
  // ROM pointer at compressed bytes.
  'wDecompressedCollisions',
  'wTimeOfDay',
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
