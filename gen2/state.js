// Typed reads of the game, from one work-RAM snapshot per poll.
import { GameBoy } from '../gbcore/gb.js';
import { gen2 } from './engine.js';
import { arrowAt, fold, screenSays, screenText, selectedLine } from './screen.js';

const b = GameBoy.byteAt, w = GameBoy.wordAt;

// How many kinds of thing one pocket is believed to hold. A bound against a
// garbage count byte walking a reader through work RAM, not a claim about the
// cartridge -- so it lives here rather than in the engine profile, which says
// in its own header that this app's caution is not a fact about the machine.
const POCKET_KINDS = 20;

/**
 * The status byte as a list of keys: `['psn']`, `['slp']`, `[]`.
 *
 * A list rather than one value because the byte is a set of flags and Gen 2 can
 * hold more than one at once -- burned and paralysed together, for instance.
 * **Sleep is a counter, not a flag**: the low three bits hold how many turns are
 * left, so it is a mask, and `byte & 0x04` is false of a Pokemon asleep for
 * three more turns. Which is the sort of thing that reads as working until it
 * does not.
 *
 * Keys rather than words, because what to call it is the interface's business
 * and which item cures it is the title's, and neither of those is this file's.
 */
export function statusOf(byte, engine = gen2) {
  const bits = engine.statusBits || {};
  const out = [];
  for (const [key, mask] of Object.entries(bits)) {
    if (byte & mask) out.push(key);
  }
  return out;
}

/**
 * The two DV bytes as four numbers and the fifth that is not stored.
 *
 * Gen 2's "IVs". Four nibbles across two bytes -- attack and defence in the
 * first, speed and special in the second -- and **the HP DV is not written
 * down anywhere.** It is assembled from the low bit of each of the other four,
 * most significant first, which is why a reader that expects five nibbles
 * finds four and a reader that expects four stats reports a Pokemon with no
 * HP potential at all.
 *
 * Beside `statusOf` because it is the same kind of thing: a pure decode of one
 * packed field, with the layout coming out of the engine profile so a cartridge
 * that ordered its nibbles differently changes one list rather than this code.
 *
 * **The nibble order is the disassembly's, not a measurement.** What can be
 * said from the cartridge is that the field is two bytes at 0x15, which the
 * symbol file settles. Which nibble is which needs a party entry whose stats
 * are known, and none has been read here yet -- so this is the same kind of
 * gap as `statusBits`, written down rather than glossed.
 */
export function dvsOf(word, engine = gen2, bytes = 2) {
  const names = engine.dvNames || [];
  // Wider than Gen 2's two bytes means a nibble per stat and nothing
  // derived. Polished Crystal writes three -- `MON_HP_ATK_DV`,
  // `MON_DEF_SPE_DV`, `MON_SAT_SDF_DV` -- so HP has a DV of its own there,
  // and assembling one out of low bits would invent a number the game does
  // not use. Which case applies is the *width* of the field, and the symbol
  // file says what that is; see `monLayout`.
  if (bytes > 2) {
    const wide = engine.statNames || [];
    const out = {};
    wide.forEach((key, i) => {
      const byte = (word >> ((bytes - 1 - (i >> 1)) * 8)) & 0xff;
      out[key] = i % 2 === 0 ? byte >> 4 : byte & 0x0f;
    });
    return out;
  }
  const out = {};
  names.forEach((key, i) => {
    // Nibble `i`, counting down from the top of the word, so the list's order
    // is the layout and there is no second place to state it.
    out[key] = (word >> ((names.length - 1 - i) * 4)) & 0x0f;
  });
  out.hp = names.reduce((n, key) => (n << 1) | (out[key] & 1), 0);
  return out;
}

/**
 * Where each field of a party entry is, asked of the symbol file.
 *
 * `engine.mon` says where Crystal keeps them, and for eleven passes that was
 * the only answer. **Polished Crystal moves five of them**: six one-byte EVs
 * where Crystal has five 16-bit counters, so DVs land at 0x11 instead of
 * 0x15, and PP, happiness and caught data each shift down with them. Read at
 * Crystal's offsets its dex card showed a Pokemon's gender byte as its DVs.
 *
 * But nothing had to be written down for it, because **the symbol file names
 * every field** -- `wPartyMon1DVs` is in both, and subtracting `wPartyMon1`
 * gives 0x15 on one cartridge and 0x11 on the other. The profile becomes the
 * fallback for a name a cartridge does not use rather than the source.
 *
 * The *widths* come from the same place and matter as much as the offsets: a
 * DV field of two bytes is Gen 2's four nibbles with HP assembled from their
 * low bits, and one of three is a nibble per stat with HP stored like any
 * other. `wPartyMon1Personality` is read for no other reason -- it is what
 * sits between the DVs and the PP on the cartridge that needed this, and
 * without it the DV field measures five bytes wide.
 *
 * Every name here travels in `SHARED_SYMBOLS`, which is not incidental: a
 * layout derived from the `.sym` and defaulted from the profile would
 * otherwise give a phone with the file one dex card and a phone with a
 * digest another.
 */
const MON_FIELDS = {
  species: ['wPartyMon1Species'],
  item: ['wPartyMon1Item'],
  moves: ['wPartyMon1Moves'],
  exp: ['wPartyMon1Exp'],
  statExp: ['wPartyMon1StatExp', 'wPartyMon1EVs'],
  dvs: ['wPartyMon1DVs'],
  personality: ['wPartyMon1Personality'],
  pp: ['wPartyMon1PP'],
  happiness: ['wPartyMon1Happiness'],
  caught: ['wPartyMon1CaughtData'],
  level: ['wPartyMon1Level'],
  status: ['wPartyMon1Status'],
  hp: ['wPartyMon1HP'],
  maxHp: ['wPartyMon1MaxHP'],
  stats: ['wPartyMon1Stats', 'wPartyMon1Attack'],
};

export function monLayout(symbols, engine = gen2) {
  const out = { ...engine.mon };
  const stride = engine.partyStride;
  if (symbols.has('wPartyMon1')) {
    const base = symbols.addr('wPartyMon1');
    for (const [field, names] of Object.entries(MON_FIELDS)) {
      if (!symbols.hasAny(...names)) continue;
      const at = symbols.pick(...names) - base;
      // A layout that does not fit inside one entry is not this entry's
      // layout, and a symbol file pointing somewhere else is the way that
      // happens. The profile's number is wrong on such a cartridge too, but
      // it is wrong in a way somebody has read.
      if (at >= 0 && at < stride) out[field] = at;
    }
  }
  // Each field runs to the next one along. Read off the offsets rather than
  // stated, so the two lists cannot disagree.
  const marks = [...new Set(Object.values(out).filter((n) => Number.isInteger(n)))]
    .sort((a, b) => a - b);
  const widthOf = (at) => {
    const next = marks.find((m) => m > at);
    return (next === undefined ? stride : next) - at;
  };
  out.dvBytes = widthOf(out.dvs);
  out.statExpBytes = widthOf(out.statExp);
  return out;
}

// Collision values that roll for a wild encounter (COLL_LONG_GRASS $14,
// COLL_TALL_GRASS $18, and the two unused mirrors the engine still treats
// as grass).
// Exported because the pilot needs the same answer from the other side: this
// module asks "is the player standing on grass" of a snapshot, and a walk asks
// "is that tile grass" of the collision map. Those are one engine fact, and it
// was written down twice -- here and in bootstrap.js -- with nothing to notice
// if the two copies ever disagreed.


// The intro's NAME menu, from ChrisNameMenuHeader in data/player_names.asm:
// five items (NEW NAME plus four presets) drawn in the top-left ten columns.
// Matched on the menu's own shape rather than on the cursor, because the
// cursor still holds whatever the gender prompt left there until this menu is
// actually drawn.
// Cursor 1 is NEW NAME, which opens the letter grid. 2 and below are the names
// the game ships: CHRIS/MAT/ALLAN/JON, or KRIS/AMANDA/JUANA/JODI.

// wBattleMode: 0 none, 1 a wild Pokemon, 2 a trainer. Exported because both
// tasks.js and bootstrap.js need it -- you cannot run from a trainer, and a
// trainer's Pokemon cannot be caught -- and a magic 2 stated in two places is
// exactly the kind of thing that drifts.

// Six. The cap the game enforces, and the reason a catch refuses a full party
// rather than sending it to a box. Which the game does do -- measured, with
// six carried a caught Pokemon goes to BILL's PC and the party does not grow
// -- and the app now reads the message that says so; see `watchThrow`.

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

export class GameState {
  /**
   * `engine` is the machine's own numbers -- see engine.js. The stock Gen 2
   * profile by default; a title supplies its own only if its cartridge changed
   * one of them, which a hack that moved the maps has not.
   */
  constructor(symbols, engine = null) {
    this.s = symbols;
    this.e = engine || gen2;
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
      battleCursor: symbols.pick('wBattleMenuCursorPosition',
                                 'wBattleMenuCursorBuffer'),
      enemySpecies: symbols.addr('wEnemyMonSpecies'),
      enemyLevel: symbols.addr('wEnemyMonLevel'),
      enemyHp: symbols.addr('wEnemyMonHP'),
      enemyMaxHp: symbols.addr('wEnemyMonMaxHP'),
      // What the enemy *is*, so the pilot can price a move against it. Both
      // slots: Gen 2 stores a single-typed Pokemon as both of its types, so
      // slot two is never empty and never means "no second type".
      enemyType1: symbols.addr('wEnemyMonType1'),
      enemyType2: symbols.addr('wEnemyMonType2'),
      battleMonHp: symbols.addr('wBattleMonHP'),
      battleMonMaxHp: symbols.addr('wBattleMonMaxHP'),
      // The types of the Pokemon on the field rather than the party entry's,
      // because those are the ones the same-type bonus is paid on and a
      // battle can change them.
      battleMonType1: symbols.addr('wBattleMonType1'),
      battleMonType2: symbols.addr('wBattleMonType2'),
      menuItems: symbols.addr('wMenuDataItems'),
      numBalls: symbols.addr('wNumBalls'),
      balls: symbols.addr('wBalls'),
      numItems: symbols.addr('wNumItems'),
      items: symbols.addr('wItems'),
      money: symbols.addr('wMoney'),
      // Optional, like `wMapObjects` is in the collision decode: a cartridge
      // whose symbol file does not name the tilemap keeps every feature that
      // drives a box by its shape, and loses only the ones that read its words.
      tilemap: symbols.has('wTilemap') ? symbols.addr('wTilemap') : null,
      // Optional for the same reason, and it costs less than the tilemap does:
      // without it a route the pilot was turned back from stays written off for
      // the rest of the session instead of being re-tried once a badge is won.
      badges: symbols.has('wJohtoBadges') ? symbols.addr('wJohtoBadges') : null,
      // The game's own record of what has happened. Every scripted gate in Gen
      // 2 is a bit in here, so this is the address that turns "something turned
      // me back" into a question with an answer.
      events: symbols.has('wEventFlags') ? symbols.addr('wEventFlags') : null,
      // The game's own playtime, which is the only clock in this machine the
      // pilot can watch move. Optional like the badges: a cartridge whose
      // symbol file does not name it loses the wait job's honesty and nothing
      // else.
      playHours: symbols.has('wGameTimeHours')
        ? symbols.addr('wGameTimeHours') : null,
      playMinutes: symbols.has('wGameTimeMinutes')
        ? symbols.addr('wGameTimeMinutes') : null,
      playSeconds: symbols.has('wGameTimeSeconds')
        ? symbols.addr('wGameTimeSeconds') : null,
      // The game's own record of what has been seen and what has been caught,
      // one bit per species. Optional like the badges: a cartridge whose symbol
      // file does not name them keeps every job and loses the dex list.
      // Which third of the day it is, as the game itself decides it. Read here
      // rather than in `main.js`, which had the address and reached past this
      // class for it -- the one work-RAM byte in the app that was not coming
      // through the reader whose whole job is work-RAM bytes.
      timeOfDay: symbols.has('wTimeOfDay') ? symbols.addr('wTimeOfDay') : null,
      caught: symbols.has('wPokedexCaught') ? symbols.addr('wPokedexCaught') : null,
      seen: symbols.has('wPokedexSeen') ? symbols.addr('wPokedexSeen') : null,
      curPocket: symbols.addr('wCurPocket'),
      curItem: symbols.addr('wCurItem'),
      windowStack: symbols.addr('wWindowStackSize'),
      menuTop: symbols.addr('wMenuBorderTopCoord'),
      menuRight: symbols.addr('wMenuBorderRightCoord'),
      // The box's left column, which is the one number that tells the
      // pilot's battle menu from the Bug-Catching Contest's. Adjacent to the
      // other two by construction -- the game writes all four border coords
      // when it draws a box -- so it costs nothing to read.
      menuLeft: symbols.addr('wMenuBorderLeftCoord'),
    };
    // Where the fields of a party entry are, asked of the same symbol file
    // the addresses came from rather than taken from the profile. See
    // `monLayout`: Polished Crystal moves five of them.
    this.mon = monLayout(symbols, this.e);
    // One small window covering every byte the name-menu check needs, so that
    // check can run after every press without a snapshot behind it.
    const watched = [this.a.menuItems, this.a.menuTop, this.a.menuRight,
                     this.a.menuLeft, this.a.menuY];
    this.menuWindow = {
      addr: Math.min(...watched),
      len: Math.max(...watched) - Math.min(...watched) + 1,
    };
  }

  /** Is the intro's NAME menu on screen? `win` comes from menuWindow. */
  nameMenuUp(win) {
    const at = (addr) => win[addr - this.menuWindow.addr];
    return at(this.a.menuItems) === this.e.nameMenu.items
      && at(this.a.menuRight) === this.e.nameMenu.right
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
    const { start, bankBytes } = this.e.sram;
    // No battery at all, and that is the whole of what can be asked here.
    // There used to be a length test beside it -- `sram.length < bankBytes`
    // -- and it never once decided anything: an offset that lands past the
    // end of the array is caught below, by the same comparison that catches
    // one landing before the start, so any answer the length test could give
    // was already given. `tools/mutate` is what proved it, by widening the
    // `<` to `<=` and finding nothing that failed either way.
    if (!sram) return false;
    const at = (name) => {
      if (!this.s.has(name)) return -1;
      return this.s.bank(name) * bankBytes + (this.s.addr(name) - start);
    };
    const one = at('sCheckValue1'), two = at('sCheckValue2');
    if (one < 0 || two < 0 || one >= sram.length || two >= sram.length) {
      return false;
    }
    const [one_, two_] = this.e.saveCheck;
    return sram[one] === one_ && sram[two] === two_;
  }

  /** The flat offset of an SRAM symbol inside a battery, or -1. */
  _sramAt(name) {
    const { start, bankBytes } = this.e.sram;
    if (!this.s.has(name)) return -1;
    return this.s.bank(name) * bankBytes + (this.s.addr(name) - start);
  }

  /**
   * Where a work-RAM address's saved copy sits in a battery, or -1.
   *
   * **A save is a photograph of work RAM, laid out the same way.** `sGameData`
   * holds what `wPlayerData` onwards held at the moment of saving, byte for
   * byte, so any saved field is at `sGameData + (wAddr - wPlayerData)` -- which
   * was measured rather than assumed: `wMoney` at $d84e lands on flat 9180 and
   * reads 3000 on a new game, matching live work RAM.
   *
   * Bounded by `sGameDataEnd`, so an address outside the saved block answers
   * -1 rather than an offset into whatever is next in the file. Most of work
   * RAM is *not* saved, so that bound is doing real work.
   */
  savedAt(wAddr) {
    const from = this._sramAt('sGameData');
    const to = this._sramAt('sGameDataEnd');
    if (from < 0 || to < 0 || !this.s.has('wPlayerData')) return -1;
    const at = from + (wAddr - this.s.addr('wPlayerData'));
    return at >= from && at < to ? at : -1;
  }

  /**
   * The checksum the saved block's bytes make: a 16-bit sum, little-endian.
   *
   * Measured against a real cartridge rather than derived: over flat
   * [8201, 11139) the sum came to 58439 and the two bytes at 11533 held 58439.
   * Both ends of that come out of the symbol file here -- `sGameData`,
   * `sGameDataEnd` and `sChecksum` -- so a build that moved the block moves
   * this with it.
   *
   * Null where the cartridge does not name them, which is *cannot check* and
   * has to stay distinct from *does not match*: one of those is a reason to
   * refuse to write and the other is a reason to refuse to trust.
   */
  checksum(sram) {
    const from = this._sramAt('sGameData');
    const to = this._sramAt('sGameDataEnd');
    if (from < 0 || to < 0 || !sram || to > sram.length) return null;
    let sum = 0;
    for (let at = from; at < to; at++) sum = (sum + sram[at]) & 0xffff;
    return sum;
  }

  /** The checksum the battery claims, or null. */
  storedChecksum(sram) {
    const at = this._sramAt('sChecksum');
    if (at < 0 || !sram || at + 1 >= sram.length) return null;
    return sram[at] | (sram[at + 1] << 8);
  }

  /**
   * Write the checksum the bytes make, in place. Answers false where it cannot.
   *
   * Called after an edit and never before one: a battery whose bytes and
   * checksum disagree is one the game refuses outright, which is the right
   * failure and not one to leave lying around.
   */
  sealSave(sram) {
    const at = this._sramAt('sChecksum');
    const sum = this.checksum(sram);
    if (at < 0 || sum === null || at + 1 >= sram.length) return false;
    sram[at] = sum & 0xff;
    sram[at + 1] = (sum >> 8) & 0xff;
    return true;
  }

  /**
   * Move the in-game clock forward by whole hours, in a copy of the battery.
   *
   * **Gen 2's clock is the hardware clock plus an offset the game keeps in the
   * save**, and that is what makes this possible at all: `FixTime` adds
   * `wStartHour` to the RTC's hours and carries into `wCurDay`, so the four
   * `wStart` bytes are how the game sets a time it cannot write to the
   * cartridge. All four are inside the saved block.
   *
   * The arithmetic is the game's own. `DSTChecks.SetClockForward` moves the
   * clock an hour by incrementing `wStartHour`, wrapping at 24 and carrying one
   * into `wStartDay` -- and doing that `n` times is exactly the division below,
   * which is why it is written as a division and not as a loop.
   *
   * The day is *not* wrapped at seven going forward. The game does not wrap it
   * either, and it is right not to: crossing midnight really is another day,
   * and `wCurDay` is a byte the game itself lets run.
   *
   * Answers a new array, never the one handed in -- an in-place edit of a
   * battery somebody still holds a reference to is the kind of thing that
   * turns a refused write into a corrupted one. Null where the save cannot be
   * read or the clock is not in it.
   */
  advanceClock(sram, hours) {
    const { clock, hoursInDay } = this.e;
    if (!sram || !Number.isInteger(hours)) return null;
    const hourAt = this.s.has(clock.startHour)
      ? this.savedAt(this.s.addr(clock.startHour)) : -1;
    const dayAt = this.s.has(clock.startDay)
      ? this.savedAt(this.s.addr(clock.startDay)) : -1;
    if (hourAt < 0 || dayAt < 0) return null;
    const out = new Uint8Array(sram);
    const moved = out[hourAt] + hours;
    // Floor, not truncate: a negative shift borrows a day rather than losing
    // one, and `Math.trunc` would round -1/24 to zero and leave the day behind.
    out[dayAt] = (out[dayAt] + Math.floor(moved / hoursInDay)) & 0xff;
    out[hourAt] = ((moved % hoursInDay) + hoursInDay) % hoursInDay;
    if (!this.sealSave(out)) return null;
    return out;
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
      onGrass: this.e.grassTiles.includes(b(wram, a.tile)),
      menu: [b(wram, a.menuX), b(wram, a.menuY)],
      battleCursor: b(wram, a.battleCursor),
      enemy: {
        species: b(wram, a.enemySpecies),
        level: b(wram, a.enemyLevel),
        hp: w(wram, a.enemyHp),
        maxHp: w(wram, a.enemyMaxHp),
        types: [b(wram, a.enemyType1), b(wram, a.enemyType2)],
      },
      active: {
        hp: w(wram, a.battleMonHp),
        maxHp: w(wram, a.battleMonMaxHp),
        types: [b(wram, a.battleMonType1), b(wram, a.battleMonType2)],
      },
      party: this.party(wram),
      balls: this.balls(wram),
      items: this.items(wram),
      money: this.money(wram),
      curPocket: b(wram, a.curPocket),
      curItem: b(wram, a.curItem),
      windowOpen: b(wram, a.windowStack) > 0,
      // Which menu is drawn, not just where its cursor is. The battle menu and
      // the pack both park the cursor at (1, 1), so the cursor alone cannot
      // tell them apart -- and mistaking one for the other is what made a
      // thrown ball look like a Pokemon breaking free. Measured: the battle
      // menu is 34 items with its box at row 12, the pack is 5 at row 1.
      menuItems: b(wram, a.menuItems),
      menuLeft: b(wram, a.menuLeft),
      menuTop: b(wram, a.menuTop),
      badges: this.badgeCount(wram),
      // Which third of the day it is. In the snapshot rather than fetched on
      // the side, which is where it was: `main.js` held the address and made
      // its own `readBytes` call for this one byte, twice per refresh -- a
      // second trip into the core for something the snapshot in its hand
      // already contained, and the only work-RAM read in the app that did not
      // come through this class.
      timeOfDay: this.timeOfDay(wram),
    };
  }

  /**
   * How many badges are in the case, or null on a cartridge that will not say.
   *
   * A count rather than a set, because the only question this app asks of a
   * badge is *has something changed since a route turned me back* -- and the
   * count answers that for every badge without a table mapping badges to
   * routes, which is a thing no cartridge writes down.
   *
   * Null and zero are different answers and are kept apart: a cartridge with no
   * `wJohtoBadges` in its symbol file cannot say, and a new game says none.
   */
  /**
   * Is a particular badge in the case?
   *
   * `bit` is an index across the badge bytes, low bit of the first byte first,
   * and *which* bit is *which* badge is a fact about a cartridge's story --
   * so a title declares it and this only counts. Measured on Crystal: beating
   * Falkner sets bit 0 of `wJohtoBadges`.
   *
   * Null where the cartridge will not say, kept apart from false the same way
   * `badgeCount` keeps null apart from nought: one means *cannot tell* and the
   * other means *no*.
   */
  hasBadge(wram, bit) {
    if (this.a.badges === null || bit === null || bit === undefined) return null;
    const byte = b(wram, this.a.badges + (bit >> 3));
    return (byte & (1 << (bit & 7))) !== 0;
  }

  /**
   * Has a particular scripted thing happened yet?
   *
   * **This is the address that turns a locked road into a question.** Gen 2
   * keeps one bit per event in `wEventFlags`, and every gate in the game is a
   * script reading one of them -- so a route that turns the pilot back is not
   * mysterious, it is a bit that is zero. Read out of the cartridge:
   *
   *   * the man on Route 32 checks event `$2d` before he will let anyone south
   *     out of Violet, and gives a MIRACLE SEED when it is set;
   *   * the only script in the ROM that sets `$2d` is
   *     `VioletPokecenter1F_ElmsAideScript.AskTakeEgg` -- Elm's aide, in the
   *     Violet City Pokémon Center, asking you to take the Egg.
   *
   * Which *bit* means *what* is a fact about a cartridge's story, so a title
   * declares it and this only reads. The numbering is the same as
   * `hasBadge`: an index across the bytes, low bit of the first byte first,
   * which is how the game's own `EventFlagAction` walks them.
   *
   * Null where the cartridge will not say, kept apart from false for the reason
   * `badgeCount` keeps null apart from nought: one means *cannot tell*, the
   * other means *not yet*. A gate the app cannot read must not be reported as a
   * gate that is closed -- that would turn "I do not know" into a confident
   * wrong answer, which is this repository's most expensive class of bug.
   */
  hasEvent(wram, bit) {
    if (this.a.events === null || bit === null || bit === undefined) return null;
    const byte = b(wram, this.a.events + (bit >> 3));
    if (byte === undefined) return null;
    return (byte & (1 << (bit & 7))) !== 0;
  }

  badgeCount(wram) {
    if (this.a.badges === null) return null;
    let n = 0;
    for (let i = 0; i < this.e.badgeBytes; i++) {
      let byte = b(wram, this.a.badges + i);
      while (byte) { n += byte & 1; byte >>= 1; }
    }
    return n;
  }

  /**
   * What is in the wallet.
   *
   * Three bytes, big-endian, plain binary -- measured, not inferred: a new game
   * reads `[0x00, 0x0b, 0xb8]`, which is 3000, and 3000 is what Crystal starts
   * you with. The bytes next door hold the *mart's prices* as BCD, so this is
   * one of those places where the obvious generalisation is wrong.
   *
   * Read for the first time in twenty-six passes, and the app has been
   * asserting what it costs the whole time: every knockout takes half of it,
   * and the grind has counted knockouts since the seventeenth pass without ever
   * saying what one was worth.
   */
  /**
   * What the screen is saying, as words.
   *
   * A thin door onto `screen.js`, which holds the decoding: this class already
   * carries the address and the engine profile, so putting the door here means
   * nothing else has to be handed either. Callers get `null` where the symbol
   * file does not name the tilemap, which is "cannot read" rather than "says
   * nothing" -- the same distinction `liveObjects` makes.
   */
  screen(wram) {
    if (this.a.tilemap === null) return null;
    const at = this.a.tilemap, e = this.e;
    return {
      lines: () => screenText(wram, at, e),
      selected: () => selectedLine(wram, at, e),
      arrow: () => arrowAt(wram, at, e),
      says: (phrase) => screenSays(wram, at, phrase, e),
      // The line the arrow is on, asked about by name. Which is the question a
      // menu actually raises -- "is the thing I want the thing selected?" --
      // and the one the row *number* could only ever approximate.
      selectedSays: (phrase) => {
        const want = fold(phrase);
        return !!want && fold(selectedLine(wram, at, e)).includes(want);
      },
    };
  }

  money(wram) {
    let out = 0;
    for (let i = 0; i < this.e.moneyBytes; i++) {
      out = (out << 8) | b(wram, this.a.money + i);
    }
    return out;
  }

  /**
   * One pocket of the bag, as [id, quantity] pairs.
   *
   * The count byte counts the *kinds* carried, not how many of them: the
   * quantity is the second byte of each entry. `POCKET_KINDS` is a sanity bound
   * rather than a fact about the cartridge -- a garbage count must not send this
   * walking through work RAM -- which is why it is here and not in the engine
   * profile, next to that profile's own note about what it refuses to hold.
   */
  _pocket(wram, countAt, listAt) {
    const n = Math.min(b(wram, countAt), POCKET_KINDS);
    const out = [];
    for (let i = 0; i < n; i++) {
      const id = b(wram, listAt + i * 2);
      if (id === 0 || id === 0xff) break;
      out.push([id, b(wram, listAt + i * 2 + 1)]);
    }
    return out;
  }

  /** The BALL pocket, as [id, quantity] pairs. */
  balls(wram) {
    return this._pocket(wram, this.a.numBalls, this.a.balls);
  }

  /**
   * The ITEM pocket, the same shape.
   *
   * Read for the first time in twenty-two versions, and the pocket next door
   * had been read since the beginning. What it costs not to have it: `pickUp`
   * decided whether it had picked something up by looking at the *balls*, so
   * taking a BERRY off a tree on Route 30 reported "the ball would not go in
   * the bag" with the berry visibly in the pocket. Measured twice, on two
   * trees, before this existed.
   */
  items(wram) {
    return this._pocket(wram, this.a.numItems, this.a.items);
  }

  /** How many Pokemon the party holds, bounded by what the game allows. */
  partyCount(wram) {
    return Math.min(b(wram, this.a.partyCount), this.e.maxParty);
  }

  party(wram) {
    const n = this.partyCount(wram);
    const out = [];
    for (let i = 0; i < n; i++) out.push(this._mon(wram, i));
    return out;
  }

  /**
   * The four fields the pilot flies on, plus who it is.
   *
   * Everything else in the 0x30-byte entry is read by `monDetail` instead, and
   * the split is deliberate rather than tidy: this runs six times per poll for
   * the whole life of a session, and the pilot acts on the species, the level,
   * the HP and the moves. The DVs and the five stat-experience counters have
   * never changed a decision it makes; they are read when somebody opens a
   * card, which is when they are being looked at.
   */
  _mon(wram, slot) {
    const { partyStride } = this.e;
    const mon = this.mon;
    const base = this.a.partyMon1 + slot * partyStride;
    return {
      slot,
      species: b(wram, base + mon.species),
      level: b(wram, base + mon.level),
      hp: w(wram, base + mon.hp),
      maxHp: w(wram, base + mon.maxHp),
      moves: [0, 1, 2, 3].map((k) => b(wram, base + mon.moves + k)),
      // Low 6 bits are current PP; the top two are PP Up count.
      pp: [0, 1, 2, 3].map((k) => b(wram, base + mon.pp + k) & 0x3f),
      // What is wrong with it besides its HP. The byte was in the engine
      // profile for ten passes with nothing reading it -- see `statusOf`.
      status: statusOf(b(wram, base + mon.status), this.e),
    };
  }

  /**
   * One party member, all of it -- the rest of the entry the pilot never looks
   * at and a person reading a dex card does.
   *
   * Three lists of three different lengths come out of here, and the lengths
   * are Gen 2's rather than a choice: **six** stats the game has already
   * worked out, **five** stat-experience counters because Special is one
   * counter spent on two stats, and **four** DV nibbles because the HP DV is
   * derived rather than stored. `engine.js` says which five and which four and
   * in what order; nothing here decides it.
   *
   * Null for a slot the party does not hold, which is a different answer from
   * a slot holding a fainted Pokemon.
   */
  monDetail(wram, slot) {
    if (!(slot >= 0) || slot >= this.partyCount(wram)) return null;
    const { partyStride, statExpNames, statNames } = this.e;
    const mon = this.mon;
    const base = this.a.partyMon1 + slot * partyStride;
    // The six the game stores: maxHp is the first of them and already read, so
    // the other five run from `mon.stats`.
    const stats = { hp: w(wram, base + mon.maxHp) };
    statNames.slice(1).forEach((key, i) => {
      stats[key] = w(wram, base + mon.stats + i * 2);
    });
    return {
      ...this._mon(wram, slot),
      item: b(wram, base + mon.item),
      // Three bytes, big-endian, the same shape as the money.
      exp: (b(wram, base + mon.exp) << 16) | (b(wram, base + mon.exp + 1) << 8)
        | b(wram, base + mon.exp + 2),
      stats,
      // Five 16-bit counters on Crystal, and on Polished Crystal six single
      // bytes -- one per stat, Special no longer shared. The field's own
      // width says which, and the names follow from that: a counter per
      // stat is named by `statNames`, and Gen 2's shared pair by
      // `statExpNames`.
      statExp: this._effortAt(wram, base),
      dvs: dvsOf(this._packed(wram, base + mon.dvs, mon.dvBytes),
                 this.e, mon.dvBytes),
      happiness: b(wram, base + mon.happiness),
      caught: this._caughtAt(wram, base),
    };
  }

  /**
   * A packed field of `bytes` bytes as one number, most significant first.
   *
   * The DV field is two bytes on Crystal and three on Polished Crystal, and
   * `dvsOf` wants it as a single number either way -- there is one place that
   * knows how wide it is, and it is the layout, not the decoder.
   */
  _packed(wram, at, bytes) {
    let out = 0;
    for (let i = 0; i < bytes; i++) out = (out << 8) | b(wram, at + i);
    return out;
  }

  /**
   * The effort a Pokemon has accumulated, however this cartridge counts it.
   *
   * Gen 2 keeps **five 16-bit counters** and spends the Special one on two
   * stats, which is why the list is `statExpNames` and not `statNames`.
   * Polished Crystal keeps **one byte per stat**, six of them, Special split
   * the way every generation after Gen 2 splits it. The field's width settles
   * which, and the width came from the symbol file: ten bytes is five words,
   * six is six bytes.
   *
   * A width that is neither is answered as neither -- an empty object rather
   * than a column of plausible numbers off a layout nobody has read.
   */
  _effortAt(wram, base) {
    const { statExpNames, statNames } = this.e;
    const mon = this.mon;
    const at = base + mon.statExp;
    if (mon.statExpBytes === statExpNames.length * 2) {
      return Object.fromEntries(statExpNames.map(
        (key, i) => [key, w(wram, at + i * 2)]));
    }
    if (mon.statExpBytes === statNames.length) {
      return Object.fromEntries(statNames.map(
        (key, i) => [key, b(wram, at + i)]));
    }
    return {};
  }

  /**
   * Where and when a Pokemon was caught, or null where the save does not say.
   *
   * Null is a real state and not only caution about a decode that has never
   * been held to a live cartridge: a save carried in from Gold or Silver holds
   * zeroes here, and a starter handed over by a professor was never caught at
   * all. So a level outside 1..100 is answered as *does not say* rather than
   * printed, which is what an unverified reading has to earn.
   */
  _caughtAt(wram, base) {
    const { caughtData, caughtTimes } = this.e;
    const mon = this.mon;
    const first = b(wram, base + mon.caught);
    const second = b(wram, base + mon.caught + 1);
    // **The mask is the upper bound, so there is not a second one here.** Six
    // bits hold 0 to 63 and Gen 2 clamps a catch above that, so a `<= 100`
    // beside this would be a comparison with no path to being false --
    // `tools/mutate` widened it to `< 100` and nothing could fail either way,
    // which is the tell. Zero is the only value that means *does not say*.
    const level = first & caughtData.levelMask;
    if (level === 0) return null;
    return {
      level,
      when: caughtTimes[first >> caughtData.timeShift] || null,
      place: second & caughtData.placeMask,
    };
  }

  /**
   * How long this save has been played, in seconds, or null.
   *
   * The counter behind the save screen's `TIME 1:23`, and the reason this app
   * reads it is narrower than it looks: **it is the only clock here that is
   * known to move when the pilot runs the machine.** `wTimeOfDay` comes from
   * the cartridge's real-time clock and changes at a boundary hours apart;
   * this ticks every frame the game is not paused. So a job that waits for an
   * hour can tell *the game is running and the clock is not* from *nothing is
   * running at all*, which are two different pieces of bad news.
   *
   * Seconds rather than the four fields it is made of, because every caller
   * wants an elapsed time and none of them wants to do the arithmetic twice.
   * The frame counter is deliberately dropped: it is sub-second, it wraps
   * sixty times a second, and no decision here is that fine.
   *
   * The hours are two bytes read big-endian, which is the convention every
   * other 16-bit field in this game uses -- HP, max HP, the enemy's both --
   * and those were measured. This one is not: 999 hours is the cap and no save
   * here has ever been near enough to it for the high byte to be non-zero, so
   * the byte order is inherited rather than checked. It matters only to a
   * wait that runs past an hour, which is why it is said here.
   */
  playtime(wram) {
    if (this.a.playHours === null) return null;
    return w(wram, this.a.playHours) * 3600
      + b(wram, this.a.playMinutes) * 60
      + b(wram, this.a.playSeconds);
  }

  /** Which third of the day the game says it is, or null. */
  timeOfDay(wram) {
    return this.a.timeOfDay === null ? null : b(wram, this.a.timeOfDay);
  }

  /**
   * What the Pokedex has seen and what it has caught, as two lists of species
   * ids, or null on a cartridge that will not say.
   *
   * Not part of `read()`, and that is the same call `screen()` makes: this is
   * two 32-byte bit arrays walked 251 times each, asked when somebody opens
   * the dex rather than eight times a second for the whole session.
   *
   * **The length is derived from `speciesCount`, not written down.** The two
   * arrays are adjacent in work RAM -- `wEndPokedexCaught` and `wPokedexSeen`
   * are the same address -- so a reader that rounded 251 up to a comfortable
   * 256 bits would report the first five species of *seen* as caught.
   */
  dex(wram) {
    if (this.a.caught === null && this.a.seen === null) return null;
    const count = this.e.speciesCount;
    const list = (at) => {
      if (at === null) return null;
      const out = [];
      for (let id = 1; id <= count; id++) {
        const bit = id - 1;
        if (b(wram, at + (bit >> 3)) & (1 << (bit & 7))) out.push(id);
      }
      return out;
    };
    return { caught: list(this.a.caught), seen: list(this.a.seen) };
  }
}
