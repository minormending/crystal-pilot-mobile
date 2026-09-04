// Typed reads of the game, from one work-RAM snapshot per poll.
import { GameBoy } from '../gbcore/gb.js';
import { gen2 } from './engine.js';

const b = GameBoy.byteAt, w = GameBoy.wordAt;

// Collision values that roll for a wild encounter (COLL_LONG_GRASS $14,
// COLL_TALL_GRASS $18, and the two unused mirrors the engine still treats
// as grass).
// Exported because the pilot needs the same answer from the other side: this
// module asks "is the player standing on grass" of a snapshot, and a walk asks
// "is that tile grass" of the collision map. Those are one engine fact, and it
// was written down twice -- here and in bootstrap.js -- with nothing to notice
// if the two copies ever disagreed.
export const GRASS_TILES = new Set(gen2.grassTiles);

// The intro's NAME menu, from ChrisNameMenuHeader in data/player_names.asm:
// five items (NEW NAME plus four presets) drawn in the top-left ten columns.
// Matched on the menu's own shape rather than on the cursor, because the
// cursor still holds whatever the gender prompt left there until this menu is
// actually drawn.
const NAME_MENU_ITEMS = gen2.nameMenu.items;
const NAME_MENU_RIGHT = gen2.nameMenu.right;
// Cursor 1 is NEW NAME, which opens the letter grid. 2 and below are the names
// the game ships: CHRIS/MAT/ALLAN/JON, or KRIS/AMANDA/JUANA/JODI.
export const NAME_MENU_FIRST_PRESET = gen2.nameMenu.firstPreset;

// wBattleMode: 0 none, 1 a wild Pokemon, 2 a trainer. Exported because both
// tasks.js and bootstrap.js need it -- you cannot run from a trainer, and a
// trainer's Pokemon cannot be caught -- and a magic 2 stated in two places is
// exactly the kind of thing that drifts.
export const TRAINER_BATTLE = gen2.trainerBattle;

// Six. The cap the game enforces, and the reason a catch refuses a full party
// rather than sending it to a box this does not handle.
export const MAX_PARTY = gen2.maxParty;

// Where the cartridge's save data lives, and how the game knows it is real.
//
// Crystal validates a save by two magic bytes: SAVE_CHECK_VALUE_1 (99) at
// sCheckValue1 and SAVE_CHECK_VALUE_2 (127) at sCheckValue2. If either is
// wrong the game reports no save file, which makes them exactly the right test
// -- it is the game's own, from engine/menus/save.asm, rather than a guess
// about how much of the battery looks used.
//
// Counting non-zero bytes does NOT work, which is worth stating because it is
// the obvious thing to reach for and it is wrong: a battery that has never
// been saved to still reads five non-zero bytes here, so "any non-zero byte
// means there is a save" calls a blank cartridge saved.
const SRAM_START = gen2.sram.start;
const SRAM_BANK_BYTES = gen2.sram.bankBytes;
const SAVE_CHECK_VALUE_1 = gen2.saveCheck[0];
const SAVE_CHECK_VALUE_2 = gen2.saveCheck[1];

export class GameState {
  /**
   * `engine` is the machine's own numbers -- see engine.js. The stock Gen 2
   * profile by default; a title supplies its own only if its cartridge changed
   * one of them, which a hack that moved the maps has not.
   */
  constructor(symbols, engine = gen2) {
    this.s = symbols;
    this.e = engine;
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
      numBalls: symbols.addr('wNumBalls'),
      balls: symbols.addr('wBalls'),
      curPocket: symbols.addr('wCurPocket'),
      curItem: symbols.addr('wCurItem'),
      windowStack: symbols.addr('wWindowStackSize'),
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

  /**
   * Does this battery save hold a game the cartridge would load?
   *
   * `sram` is the 32KB from GameBoy.batterySave(). Offsets come out of the
   * symbol file rather than being written down here, the same as every other
   * address in this app -- an SRAM symbol carries a bank, so the offset into
   * the flat block is bank * 0x2000 + (addr - 0xA000).
   */
  saveIsPresent(sram) {
    if (!sram || sram.length < SRAM_BANK_BYTES) return false;
    const at = (name) => {
      if (!this.s.has(name)) return -1;
      return this.s.bank(name) * SRAM_BANK_BYTES + (this.s.addr(name) - SRAM_START);
    };
    const one = at('sCheckValue1'), two = at('sCheckValue2');
    if (one < 0 || two < 0 || one >= sram.length || two >= sram.length) {
      return false;
    }
    return sram[one] === SAVE_CHECK_VALUE_1 && sram[two] === SAVE_CHECK_VALUE_2;
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
      onGrass: GRASS_TILES.has(b(wram, a.tile)),
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
      balls: this.balls(wram),
      curPocket: b(wram, a.curPocket),
      curItem: b(wram, a.curItem),
      windowOpen: b(wram, a.windowStack) > 0,
      // Which menu is drawn, not just where its cursor is. The battle menu and
      // the pack both park the cursor at (1, 1), so the cursor alone cannot
      // tell them apart -- and mistaking one for the other is what made a
      // thrown ball look like a Pokemon breaking free. Measured: the battle
      // menu is 34 items with its box at row 12, the pack is 5 at row 1.
      menuItems: b(wram, a.menuItems),
      menuTop: b(wram, a.menuTop),
    };
  }

  /**
   * The BALL pocket, as [id, quantity] pairs.
   *
   * wNumBalls counts the *kinds* of ball carried, not how many balls: the
   * quantity is the second byte of each entry.
   */
  balls(wram) {
    const n = Math.min(b(wram, this.a.numBalls), 20);
    const out = [];
    for (let i = 0; i < n; i++) {
      const id = b(wram, this.a.balls + i * 2);
      if (id === 0 || id === 0xff) break;
      out.push([id, b(wram, this.a.balls + i * 2 + 1)]);
    }
    return out;
  }

  party(wram) {
    const { partyStride, mon, maxParty } = this.e;
    const n = Math.min(b(wram, this.a.partyCount), maxParty);
    const out = [];
    for (let i = 0; i < n; i++) {
      const base = this.a.partyMon1 + i * partyStride;
      out.push({
        slot: i,
        species: b(wram, base + mon.species),
        level: b(wram, base + mon.level),
        hp: w(wram, base + mon.hp),
        maxHp: w(wram, base + mon.maxHp),
        moves: [0, 1, 2, 3].map((k) => b(wram, base + mon.moves + k)),
        // Low 6 bits are current PP; the top two are PP Up count.
        pp: [0, 1, 2, 3].map((k) => b(wram, base + mon.pp + k) & 0x3f),
      });
    }
    return out;
  }
}
