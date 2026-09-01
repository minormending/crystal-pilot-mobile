// Typed reads of the game, from one work-RAM snapshot per poll.
import { GameBoy } from './gb.js';
import { MON, PARTY_STRUCT } from './symbols.js';

const b = GameBoy.byteAt, w = GameBoy.wordAt;

// Collision values that roll for a wild encounter (COLL_LONG_GRASS $14,
// COLL_TALL_GRASS $18, and the two unused mirrors the engine still treats
// as grass).
const GRASS = new Set([0x10, 0x14, 0x18, 0x1c]);

// The intro's NAME menu, from ChrisNameMenuHeader in data/player_names.asm:
// five items (NEW NAME plus four presets) drawn in the top-left ten columns.
// Matched on the menu's own shape rather than on the cursor, because the
// cursor still holds whatever the gender prompt left there until this menu is
// actually drawn.
const NAME_MENU_ITEMS = 5;
const NAME_MENU_RIGHT = 10;
// Cursor 1 is NEW NAME, which opens the letter grid. 2 and below are the names
// the game ships: CHRIS/MAT/ALLAN/JON, or KRIS/AMANDA/JUANA/JODI.
export const NAME_MENU_FIRST_PRESET = 2;

export class GameState {
  constructor(symbols) {
    this.s = symbols;
    // Resolved once. Reading the map every poll is what keeps this cheap.
    this.a = {
      partyCount: symbols.addr('wPartyCount'),
      partyMon1: symbols.addr('wPartyMon1'),
      battleMode: symbols.addr('wBattleMode'),
      mapGroup: symbols.addr('wMapGroup'),
      mapNumber: symbols.addr('wMapNumber'),
      mapStatus: symbols.addr('wMapStatus'),
      scriptMode: symbols.addr('wScriptMode'),
      x: symbols.addr('wXCoord'),
      y: symbols.addr('wYCoord'),
      tile: symbols.addr('wPlayerTileCollision'),
      menuX: symbols.addr('wMenuCursorX'),
      menuY: symbols.addr('wMenuCursorY'),
      battleCursor: symbols.addr('wBattleMenuCursorPosition'),
      enemySpecies: symbols.addr('wEnemyMonSpecies'),
      enemyLevel: symbols.addr('wEnemyMonLevel'),
      enemyHp: symbols.addr('wEnemyMonHP'),
      enemyMaxHp: symbols.addr('wEnemyMonMaxHP'),
      battleMonHp: symbols.addr('wBattleMonHP'),
      battleMonMaxHp: symbols.addr('wBattleMonMaxHP'),
      menuItems: symbols.addr('wMenuDataItems'),
      menuTop: symbols.addr('wMenuBorderTopCoord'),
      menuRight: symbols.addr('wMenuBorderRightCoord'),
    };
    // One small window covering every byte the name-menu check needs, so that
    // check can run after every press without a snapshot behind it.
    const watched = [this.a.menuItems, this.a.menuTop, this.a.menuRight,
                     this.a.menuY];
    this.menuWindow = {
      addr: Math.min(...watched),
      len: Math.max(...watched) - Math.min(...watched) + 1,
    };
  }

  /** Is the intro's NAME menu on screen? `win` comes from menuWindow. */
  nameMenuUp(win) {
    const at = (addr) => win[addr - this.menuWindow.addr];
    return at(this.a.menuItems) === NAME_MENU_ITEMS
      && at(this.a.menuRight) === NAME_MENU_RIGHT
      && at(this.a.menuTop) === 0;
  }

  /** The live menu cursor, read from the same small window. */
  menuCursorY(win) {
    return win[this.a.menuY - this.menuWindow.addr];
  }

  read(wram) {
    const a = this.a;
    return {
      wram,
      inBattle: b(wram, a.battleMode) !== 0,
      battleMode: b(wram, a.battleMode),
      map: [b(wram, a.mapGroup), b(wram, a.mapNumber)],
      // wMapStatus 2 == MAPSTATUS_HANDLE: a map is loaded and being handled.
      // Party data is restored before the map is, so this is the only honest
      // "the world is live" signal.
      worldLoaded: b(wram, a.mapStatus) === 2 && b(wram, a.mapGroup) !== 0,
      scriptRunning: b(wram, a.scriptMode) !== 0,
      pos: [b(wram, a.x), b(wram, a.y)],
      onGrass: GRASS.has(b(wram, a.tile)),
      menu: [b(wram, a.menuX), b(wram, a.menuY)],
      battleCursor: b(wram, a.battleCursor),
      enemy: {
        species: b(wram, a.enemySpecies),
        level: b(wram, a.enemyLevel),
        hp: w(wram, a.enemyHp),
        maxHp: w(wram, a.enemyMaxHp),
      },
      active: {
        hp: w(wram, a.battleMonHp),
        maxHp: w(wram, a.battleMonMaxHp),
      },
      party: this.party(wram),
    };
  }

  party(wram) {
    const n = Math.min(b(wram, this.a.partyCount), 6);
    const out = [];
    for (let i = 0; i < n; i++) {
      const base = this.a.partyMon1 + i * PARTY_STRUCT;
      out.push({
        slot: i,
        species: b(wram, base + MON.species),
        level: b(wram, base + MON.level),
        hp: w(wram, base + MON.hp),
        maxHp: w(wram, base + MON.maxHp),
        moves: [0, 1, 2, 3].map((k) => b(wram, base + MON.moves + k)),
        // Low 6 bits are current PP; the top two are PP Up count.
        pp: [0, 1, 2, 3].map((k) => b(wram, base + MON.pp + k) & 0x3f),
      });
    }
    return out;
  }
}
