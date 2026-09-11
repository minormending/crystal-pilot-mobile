// Names and wild tables, read straight out of the cartridge.
//
// The desktop pilot parses these from the pokecrystal disassembly, which a
// phone does not have -- it has the ROM and the .sym and nothing else. But the
// same data is in the ROM, and the .sym says where, so the phone can read it
// first-hand instead of shipping a copy that could drift from the build.
//
// Checked against the disassembly: the species names come out BULBASAUR,
// CHARMANDER, CYNDAQUIL, and Route 29's tables match data/wild/johto_grass.asm
// entry for entry, night swap included.

// Pokemon names are a fixed-width table. Item names are not -- they are packed
// one after another, each ended by "@" -- and reading them at a fixed stride
// drifts a character further out with every entry: ULTRA BALL came back as
// "LTRA BALL", GREAT BALL as "AT BALL".
// The fallback, for a cartridge with no name table to measure one off. What
// this cartridge actually ends a name with is `terminator()`, and everything
// else about its alphabet -- the letter blocks, the ligature, the line
// breaks, the punctuation -- is `engine.alphabet`, so a hack that moved them
// says so in one place. Polished Crystal moved all of them.
const NAME_TERMINATOR = 0x50;
// The list ends at $FF. Not an engine field: a terminator is the shape of the
// table rather than a size in it, and a cartridge that used a different one
// would need a different scan, not a different number.
const TABLE_END = 0xff;
// Where a badge-scaled wild level's base is kept, and the floor its own
// arithmetic clamps to. The symbol is the test as well as the address: a
// cartridge that does not scale its levels does not have it.
const BADGE_BASE = 'wBadgeBaseLevel', LEVEL_FLOOR = 2;
// How far to scan the item table when asked for an id by name. Crystal has 250
// items; the scan stops early at the first entry with no name, which is what
// reading past the table gives. A bound rather than a count, so it is here
// rather than in the engine profile.
const ITEM_SCAN_LIMIT = 256;
// How far to walk for one packed name before giving up. A bound rather than a
// size: the longest item name in Crystal is "MYSTERYBERRY" at twelve and the
// longest move name "THUNDERSHOCK" at twelve, so this is slack, and its job is
// to stop a table with no terminator in it from running off the end of a bank.
const PACKED_NAME_MAX = 24;
// A landmark entry: an x and a y for the town map, then a pointer to the name.
// The name is terminated, so the length is a bound rather than a size --
// "CIANWOOD CITY" is the longest in Johto at thirteen.
const LANDMARK_BYTES = 4, LANDMARK_NAME = 2, LANDMARK_NAME_MAX = 24;

/**
 * Whether a byte could be part of a name -- a letter, a digit, a space, a
 * line break or one of the punctuation marks above.
 *
 * Used to tell a name table from bytes that merely decode into one. It says
 * nothing about *which* character: two cartridges can disagree about that and
 * still agree that $8d is a letter, which is all this is asked.
 *
 * Not exported: the only caller is `_nameRun` two hundred lines down, and an
 * export nothing outside the module reads is a wider surface for nothing.
 */
function isNameByte(b, a) {
  return (b >= a.upper[0] && b <= a.lower[1]) || b === a.space
    || a.breaks.includes(b) || b === a.ligature
    || a.punctuation[b] !== undefined
    || (b >= a.digits[0] && b <= a.digits[1] && b !== TABLE_END);
}

/** The game's own character encoding, as far as names use it. */
export function decodeText(bytes, end = NAME_TERMINATOR, alphabet = null) {
  const a = alphabet || gen2.alphabet;
  const breaks = new Set(a.breaks);
  let out = '';
  for (const b of bytes) {
    // "@" terminates -- $50 on Crystal, and whatever this cartridge measured
    // (see `terminator`). Crystal's is honoured either way, because a
    // cartridge that moved the terminator did not put a letter at $50.
    if (b === end || b === NAME_TERMINATOR) break;
    if (b === a.ligature) out += 'POKé';         // one byte, four letters
    else if (b === a.space) out += ' ';
    // A line break inside a *name* is a space. Landmark names are written to
    // fit a two-line sign -- "NEW BARK<line>TOWN" -- and reading the break as
    // an unknown byte put a question mark in the middle of half the towns in
    // Johto.
    else if (breaks.has(b)) out += ' ';
    else if (a.punctuation[b] !== undefined) out += a.punctuation[b];
    else if (b >= a.upper[0] && b <= a.upper[1]) {
      out += String.fromCharCode(65 + b - a.upper[0]);
    } else if (b >= a.lower[0] && b <= a.lower[1]) {
      out += String.fromCharCode(97 + b - a.lower[0]);
    } else if (b >= a.digits[0] && b <= a.digits[1]) {
      out += String.fromCharCode(48 + b - a.digits[0]);
    } else out += '?';
  }
  return out.trim();
}

/** Case and accent folded, so "POKé BALL" can be matched by typing it plainly. */
export function normalise(name) {
  return name.toLowerCase().replace(/é/g, 'e').replace(/\s+/g, ' ').trim();
}

import { gen2 } from './engine.js';
import { GameBoy } from '../gbcore/gb.js';

export class RomData {
  /**
   * `encounters` is the wild tables to read, named by the title.
   *
   * It used to be the pair pokecrystal ships, written here -- which is a fact
   * about a cartridge's regions sitting in the module that decodes them, and
   * exactly the kind of thing a hack changes. Whichever of the named tables the
   * symbol file actually has is used, so a cartridge with one region loses
   * nothing by saying it has two.
   */
  constructor(symbols, gb, encounters = [], engine = null) {
    this.gb = gb;
    this.e = engine || gen2;
    this.at = (name) => ({ bank: symbols.bank(name), addr: symbols.addr(name) });
    this.names = this.at('PokemonNames');
    this.items = this.at('ItemNames');
    this.grass = encounters
      .filter((n) => symbols.has(n))
      .map((n) => this.at(n));
    this._species = new Map();
    this._moves = new Map();
    this.moves = symbols.has('Moves') ? this.at('Moves') : null;
    // Optional the same way `Moves` is: without the chart the pilot ranks
    // moves by raw power, which is what it did before it could read one.
    this.chart = symbols.has('TypeMatchups') ? this.at('TypeMatchups') : null;
    // Optional for the same reason, and it answers the one question a party
    // entry cannot: Gen 2 does not store a Pokemon's types in the party
    // struct at all. They are copied out of here when it is sent out, which
    // is why `wBattleMonType1` exists and there is no `wPartyMon1Type1`.
    this.base = symbols.has('BaseData') ? this.at('BaseData') : null;
    // Where a badge-scaled wild level's base is kept. Optional, and the
    // symbol *is* the test: a cartridge that does not scale its wild levels
    // does not have this address at all. Resolved once here rather than
    // looked up per slot, the same as every other name in this constructor.
    this.badgeBase = symbols.has(BADGE_BASE)
      ? symbols.addr(BADGE_BASE) : null;
    // What every trainer in the game is carrying. Optional like the rest: a
    // cartridge whose symbol file does not name them keeps every job and
    // loses the ability to say what is waiting in a Gym.
    this.trainers = symbols.has('TrainerGroups') ? this.at('TrainerGroups') : null;
    this.trainerClasses = symbols.has('TrainerClassNames')
      ? this.at('TrainerClassNames') : null;
    this.moveNames = symbols.has('MoveNames') ? this.at('MoveNames') : null;
    // Optional, like the wild tables: a cartridge whose symbol file does not
    // name it keeps every map it was told about and loses the rest.
    this.landmarks = symbols.has('Landmarks') ? this.at('Landmarks') : null;
    // What a species turns into and what it learns doing it. Optional like
    // every other table here, and the thing it costs is bounded: without it a
    // dex entry says what the Pokemon *is* and cannot say what it will become.
    this.evos = symbols.has('EvosAttacksPointers')
      ? this.at('EvosAttacksPointers') : null;
    // The cartridge's own word for a type number. Optional, and the fallback
    // is the number -- which is what every reader in this app used until a dex
    // entry needed to be read by a person rather than by the ranker.
    this.typeNames = symbols.has('TypeNames') ? this.at('TypeNames') : null;
    // Which hours are morning, day and night. Optional like the rest, and the
    // thing it replaces is an assumption: every reader of `wTimeOfDay` in this
    // app knew there were three blocks and none of them knew where they
    // started, so anything wanting to say *night begins at 18:00* had to write
    // it down.
    this.times = symbols.has('TimesOfDay') ? this.at('TimesOfDay') : null;
    // The party icon. Four names for one picture, because Gen 2 keeps it in
    // four places -- a byte per species saying which icon, a pointer per icon,
    // the tiles, and the palette -- so it is all-or-nothing: a cartridge
    // missing any of the three graphics names has no icon to draw, and one
    // missing only the palette can still draw it in grey.
    this.icons = ['MonMenuIcons', 'IconPointers', 'Icons'].every(
      (n) => symbols.has(n))
      ? { menu: this.at('MonMenuIcons'), pointers: this.at('IconPointers'),
          gfx: this.at('Icons') }
      : null;
    this.monPalettes = symbols.has('PokemonPalettes')
      ? this.at('PokemonPalettes') : null;
  }

  /**
   * The two colours this cartridge paints a species in, as `#rrggbb`.
   *
   * **Indexed by `species`, not `species - 1`.** Every other per-species table
   * in this file is zero-based off the id; this one has a leading entry, so the
   * usual minus-one reads the previous species' palette -- which is not an
   * error anywhere, just the wrong colours. Measured rather than reasoned:
   * with the minus-one, Pikachu decodes purple.
   */
  speciesColours(id) {
    if (!this.monPalettes || !id || id < 1) return null;
    const { bank, addr } = this.monPalettes;
    const base = addr + id * 8;
    const word = (o) => this.gb.romByte(bank, base + o)
                        | (this.gb.romByte(bank, base + o + 1) << 8);
    // BGR555, five bits a channel, low bits first.
    const hex = (v) => '#' + [v & 31, (v >> 5) & 31, (v >> 10) & 31]
      .map((c) => Math.round(c * 255 / 31).toString(16).padStart(2, '0')).join('');
    return [hex(word(0)), hex(word(2))];
  }

  /**
   * A species' 16x16 party icon: 256 palette indices, and the colours for them.
   *
   * Two things here are not guessable from the table layout and both look like
   * working code when wrong. The tiles are in **row-major** order within a
   * frame -- top-left, top-right, bottom-left, bottom-right -- rather than the
   * column-major order a Game Boy 8x16 sprite uses. And an icon is eight tiles,
   * not four: two animation frames of 2x2, the second at `+64`.
   *
   * The shape is a *family* rather than a species. This cartridge maps 251
   * species onto 37 distinct icons, the most-used covering thirty of them and
   * only six species having one to themselves, so what tells a Chikorita from a
   * Bellsprout here is the palette rather than the outline.
   */
  speciesIcon(id, frame = 0) {
    if (!this.icons || !id || id < 1) return null;
    const iconId = this.gb.romByte(this.icons.menu.bank,
                                   this.icons.menu.addr + id - 1);
    const pa = this.icons.pointers.addr + iconId * 2;
    const addr = this.gb.romByte(this.icons.pointers.bank, pa)
                 | (this.gb.romByte(this.icons.pointers.bank, pa + 1) << 8);
    const bank = this.icons.gfx.bank;
    const pixels = new Uint8Array(256);
    const CELLS = [[0, 0], [1, 0], [0, 1], [1, 1]];
    for (let t = 0; t < CELLS.length; t++) {
      const tile = this._read(bank, addr + frame * 64 + t * 16, 16);
      const [tx, ty] = CELLS[t];
      for (let row = 0; row < 8; row++) {
        const lo = tile[row * 2];
        const hi = tile[row * 2 + 1];
        for (let col = 0; col < 8; col++) {
          const bit = 7 - col;
          pixels[(ty * 8 + row) * 16 + tx * 8 + col] =
            ((hi >> bit) & 1) * 2 + ((lo >> bit) & 1);
        }
      }
    }
    // Index 0 is the transparent one, then light, dark, black.
    const pal = this.speciesColours(id) || ['#b9b9c4', '#4a4a55'];
    return { pixels, colours: [null, pal[0], pal[1], '#000000'] };
  }

  _read(bank, addr, length) {
    const out = [];
    for (let i = 0; i < length; i++) out.push(this.gb.romByte(bank, addr + i));
    return out;
  }

  /** Species name for a Pokedex-order id (1-based), or "#id" if out of range. */
  speciesName(id) {
    if (!id || id > this.e.speciesCount) return `#${id}`;
    if (this._species.has(id)) return this._species.get(id);
    const { bank, addr } = this.names;
    const at = addr + (id - 1 + this._nameShift()) * this.e.nameLength;
    const name = decodeText(this._read(bank, at, this.e.nameLength),
                            this.terminator(), this.e.alphabet);
    this._species.set(id, name);
    return name;
  }

  /**
   * How many entries sit in front of species one -- 0 on Crystal, 1 here.
   *
   * Crystal's `PokemonNames` begins with BULBASAUR, so species `id` is entry
   * `id - 1`. **Polished Crystal begins with a placeholder** -- its source
   * writes `rawchar "?000?@@@@@"` -- so every name on it came back one
   * species early, and the placeholder itself came back as species one.
   *
   * A name starts with a letter, and that placeholder starts with `$9e`,
   * which is in neither case block. So the table says which shape it is,
   * and the test is narrow on purpose: it looks at the *first byte only* of
   * the first two entries, because "does this decode cleanly" would trip on
   * a hack whose first species has an apostrophe in it, and shifting a whole
   * name table by one is a much worse failure than one odd name.
   */
  _nameShift() {
    if (this._shift !== undefined) return this._shift;
    const { bank, addr } = this.names;
    const letter = (i) => {
      const b = this.gb.romByte(bank, addr + i * this.e.nameLength);
      return (b >= 0x80 && b <= 0x99) || (b >= 0xa0 && b <= 0xb9);
    };
    return (this._shift = !letter(0) && letter(1) ? 1 : 0);
  }


  /**
   * Item name for a 1-based item id.
   *
   * Walks the "@" terminators rather than striding: the table is packed, so
   * every entry after the first sits at an offset only the ones before it can
   * tell you.
   */
  itemName(id) {
    if (!id || id === 0xff) return '';
    if (this._itemCache && this._itemCache.has(id)) return this._itemCache.get(id);
    const name = this._packedName(this.items, id + this.e.itemBase);
    if (!this._itemCache) this._itemCache = new Map();
    this._itemCache.set(id, name);
    return name;
  }

  /**
   * One entry from a packed, terminated name table.
   *
   * Shared by the item names and the move names, which are the same shape --
   * and were briefly the same *code*, twice, which is the defect this closes.
   * Both walk the "@" terminators rather than striding, because a packed
   * table puts every entry after the first at an offset only the ones before
   * it can tell you: read at a fixed stride and ULTRA BALL comes back
   * "LTRA BALL".
   */
  _packedName({ bank, addr }, id) {
    // The cartridge's own terminator, measured off its name table -- walking
    // a packed table with the wrong one runs every entry into the next and
    // answers nothing. Polished Crystal ends a string with $53, and every
    // item and move name on it came back empty.
    const end = this.terminator();
    let at = addr;
    for (let n = 1; n < id; n++) {
      for (let guard = 0; guard < PACKED_NAME_MAX; guard++) {
        if (this.gb.romByte(bank, at++) === end) break;
      }
    }
    const bytes = [];
    let ended = false;
    for (let guard = 0; guard < PACKED_NAME_MAX; guard++) {
      const b = this.gb.romByte(bank, at + guard);
      if (b === end) { ended = true; break; }
      bytes.push(b);
    }
    // No terminator inside the bound, so that was not a name. The longest in
    // Crystal is twelve characters, so reaching twenty-four means the symbol
    // file is pointing somewhere that is not a name table -- and `decodeText`
    // will happily turn any bytes at all into a string of question marks,
    // which reads like an answer.
    return ended ? decodeText(bytes, end, this.e.alphabet) : '';
  }

  /**
   * A move's name, for saying which one was picked and why.
   *
   * Empty for a cartridge whose symbol file does not name the table -- the
   * pilot then says what it thought of the move without naming it, which is
   * less useful and not wrong.
   */
  moveName(id) {
    if (!id || !this.moveNames) return '';
    if (!this._moveNames) this._moveNames = new Map();
    if (this._moveNames.has(id)) return this._moveNames.get(id);
    const name = this._packedName(this.moveNames, id);
    this._moveNames.set(id, name);
    return name;
  }

  /**
   * A name behind a pointer, or '' when the bytes behind it are not one.
   *
   * The rule `_packedName` already had and these two readers did not: **a run
   * with no terminator inside its bound is not a name.** Without it a symbol
   * file aimed at a bank of zeroes comes back as twelve question marks, which
   * `decodeText` will happily produce from any bytes at all -- and a screen
   * saying `????????????` where a type should be reads like a decoding bug in
   * the charmap rather than like a table that could not be found.
   *
   * Found by a test asking `typeName` what a cartridge with no `TypeNames`
   * says. The same hole was in `landmarkName`, which is how one fix became
   * one helper: both are a pointer, a bound, and a terminator.
   */
  _terminatedName({ bank, addr }, ptr, max) {
    if (!ptr) return '';
    const bytes = [];
    const end = this.terminator();
    for (let i = 0; i < max; i++) {
      const b = this.gb.romByte(bank, ptr + i);
      if (b === end || b === NAME_TERMINATOR) {
        return decodeText(bytes, end, this.e.alphabet);
      }
      if (b === undefined) return '';
      bytes.push(b);
    }
    return '';
  }

  /**
   * A landmark's name, straight out of the cartridge.
   *
   * The one table that retires hand-written data rather than adding to it.
   * Until now a map was called whatever the title profile said, and everything
   * else was "map 26.1" -- ten names out of two hundred and fifty. Gen 2 knows
   * all of them: every map header carries a landmark id, and `Landmarks` is a
   * table of four-byte entries -- an x and a y for the town map, then a pointer
   * to the name.
   *
   * Measured against the maps this app already named: ids 1 to 6 read NEW BARK
   * TOWN, ROUTE 29, CHERRYGROVE CITY, ROUTE 30, ROUTE 31, VIOLET CITY, and 7 to
   * 12 carry on into SPROUT TOWER, ROUTE 32, RUINS OF ALPH, UNION CAVE, ROUTE
   * 33, AZALEA TOWN. Id 0 is SPECIAL, which is what an indoor map with no
   * landmark of its own gets.
   *
   * Empty for a cartridge whose symbol file does not name the table, which is
   * "cannot read" and lets the caller fall back to what it had.
   */
  landmarkName(id) {
    if (!this.landmarks || id === undefined || id === null) return '';
    if (this._landmarkCache && this._landmarkCache.has(id)) {
      return this._landmarkCache.get(id);
    }
    const { bank } = this.landmarks;
    const at = this.landmarks.addr + id * LANDMARK_BYTES;
    const ptr = this.gb.romByte(bank, at + LANDMARK_NAME)
      | (this.gb.romByte(bank, at + LANDMARK_NAME + 1) << 8);
    const name = this._terminatedName(this.landmarks, ptr, LANDMARK_NAME_MAX);
    if (!this._landmarkCache) this._landmarkCache = new Map();
    this._landmarkCache.set(id, name);
    return name;
  }

  /**
   * A move's numbers, straight out of the cartridge.
   *
   * Needed to weaken something before throwing a ball at it: the point is to
   * pick the *weakest* attack available, and without the power there is no way
   * to tell which that is -- so the pilot hit as hard as it could and kept
   * knocking out the Pokemon it was trying to catch.
   */
  move(id) {
    if (!id || !this.moves || id > this.e.moveCount) return null;
    if (this._moves.has(id)) return this._moves.get(id);
    const { bank, addr } = this.moves;
    const at = addr + (id - 1) * this.e.moveBytes;
    const info = {
      id,
      effect: this.gb.romByte(bank, at + this.e.moveField.effect),
      power: this.gb.romByte(bank, at + this.e.moveField.power),
      type: this.gb.romByte(bank, at + this.e.moveField.type),
      pp: this.gb.romByte(bank, at + this.e.moveField.pp),
    };
    this._moves.set(id, info);
    return info;
  }

  /**
   * The cartridge's own type chart, as a map from an attacking and defending
   * type to a multiplier in tenths.
   *
   * Read once and kept, because it is 110 triples and the answer never
   * changes. Null where the symbol file does not name the table, which is
   * "cannot say" and lets the caller fall back to raw power.
   *
   * The table only records the pairs that are *not* neutral, so a miss here is
   * a neutral matchup rather than a gap -- which is why this returns the map
   * and lets `matchup` decide what a miss means, instead of trying to fill in
   * 26 x 26 pairs it was never told about.
   */
  matchups() {
    if (this._matchups !== undefined) return this._matchups;
    if (!this.chart) return (this._matchups = null);
    const { matchupBytes, chartEnd, chartForesight, chartScan } = this.e.damage;
    const { bank, addr } = this.chart;
    const table = new Map();
    let at = addr;
    for (let guard = 0; guard < chartScan; guard++) {
      const attack = this.gb.romByte(bank, at);
      if (attack === undefined) break;
      if (attack === chartEnd) return (this._matchups = table);
      // One byte, not a triple. Reading it as a triple swallows the first
      // entry behind it and shifts every entry after that by two.
      if (attack === chartForesight) { at += 1; continue; }
      table.set((attack << 8) | this.gb.romByte(bank, at + 1),
                this.gb.romByte(bank, at + 2));
      at += matchupBytes;
    }
    // No terminator inside the bound, so whatever was read is not a table.
    // The distinction earns its keep the first time a symbol file points at
    // the wrong place: a bank of zeroes decodes into a chart with one row in
    // it -- NORMAL against NORMAL, immune -- and the pilot would rank every
    // move it owns at nothing rather than falling back to raw power.
    return (this._matchups = null);
  }

  /**
   * Every trainer in the cartridge, by name, read once and kept.
   *
   * `TrainerGroups` is a `dw` per trainer class; each class holds one or more
   * trainers, and each trainer is a terminated name, a **type** byte, that
   * many Pokemon, and `$ff`. The type byte is the only part that cannot be
   * guessed from the bytes -- it says whether a Pokemon is two bytes or
   * seven, level and species plus an optional item and optional four moves.
   *
   * **The class count is derived, not written down.** The pointer table ends
   * where its own first pointer lands, which is 67 classes on this cartridge
   * and needs no number here for one that has more. A class's trainers run
   * from its pointer to the *next* class's, which matters: read without that
   * bound, Falkner's class appears to contain every gym leader in Johto,
   * because nothing between two trainers says a class ended.
   *
   * Independently confirmed, which is the point of doing it this way at all:
   * classes 1 to 8 all come out `LEADER`, 9 is `RIVAL`, 11 is `ELITE FOUR` --
   * and the parties are the ones anyone who has played this game knows.
   *
   * Null where the symbol file does not name the table.
   */
  trainerIndex() {
    if (this._trainers !== undefined) return this._trainers;
    if (!this.trainers) return (this._trainers = null);
    const { bank, addr } = this.trainers;
    // How wide an entry is, derived rather than declared -- see `_pointerWidth`.
    const wide = this._pointerWidth(bank, addr);
    if (!wide) return (this._trainers = null);
    const word = (at) => this.gb.romByte(bank, at) | (this.gb.romByte(bank, at + 1) << 8);
    // The address is the *last two bytes* of an entry whatever its width, and
    // a three-byte entry puts the bank in front of it. Honoured rather than
    // ignored: a `dba` table exists so that it can cross banks, and on the
    // one cartridge measured every entry happens to name the table's own --
    // which is exactly the state in which an assumption survives being tested.
    const entry = (i) => {
      const at = addr + i * wide;
      return { bank: wide > 2 ? this.gb.romByte(bank, at) : bank,
               addr: word(at + wide - 2) };
    };
    // In-bank: the table ends where its own first pointer lands. Cross-bank:
    // that pointer is somewhere the table cannot see, so it is walked.
    const count = wide > 2 && this.gb.romByte(bank, addr) !== bank
      ? this._scanCount(bank, addr, wide)
      : (entry(0).addr - addr) / wide;
    // Built from the length rather than counted up to it: reading one
    // pointer too many puts the first trainer's *name* in the list as a
    // word, which is a plausible address and bounds the last class with
    // whatever it happens to be. There is no comparison here to get wrong
    // now, which is the better answer than a test for one.
    const ptr = Array.from({ length: count }, (_, i) => entry(i));
    // **What bounds a class is the next record, not the next class.** On
    // Crystal those are the same thing, because its groups are written in
    // order and this was `ptr[g + 1]`. Polished Crystal's are laid out
    // wherever the linker put them: Bugsy's group is *below* Falkner's in
    // the same bank, so the bound came out behind the start and his class
    // read as empty -- forty-two of them did.
    //
    // Only within a bank, because two addresses in different banks do not
    // compare. A class with nothing above it in its own bank is unbounded,
    // the way the last one always was, and reads until the bytes stop being
    // a trainer.
    const perBank = new Map();
    for (const e of ptr) {
      if (!perBank.has(e.bank)) perBank.set(e.bank, []);
      perBank.get(e.bank).push(e.addr);
    }
    for (const list of perBank.values()) list.sort((a, b) => a - b);
    const bounds = (g) => {
      const here = ptr[g];
      const next = perBank.get(here.bank).find((a) => a > here.addr);
      return next === undefined ? null : next;
    };
    const out = new Map();
    for (let g = 0; g < count; g++) {
      // The next class's pointer, or nothing for the last one -- which is
      // deliberately unbounded and reads until the bytes stop being a
      // trainer. Written as "is there a next pointer" rather than "is g+1
      // below the count" because the two are the same thing and only one of
      // them has an off-by-one to get wrong; `tools/mutate` widened the
      // comparison and nothing could fail either way, which is a survivor
      // that is really a spare decision.
      //
      // And only when the next class is in the *same* bank, because two
      // addresses in different banks do not compare -- a class whose
      // successor lives elsewhere is as unbounded as the last one, and
      // pretending otherwise would cut it short at an address that means
      // nothing to it.
      const stop = bounds(g);
      let at = ptr[g].addr;
      for (let guard = 0; guard < 64; guard++) {
        if (stop !== null && at >= stop) break;
        const read = this._trainerAt(ptr[g].bank, at);
        if (!read) break;
        // First definition wins, the same rule the symbol table uses: a name
        // shared by two trainers -- and dozens are -- is asked about by
        // whoever asks first, and answering with the last is no better.
        // Keyed **folded**, because a cartridge's capitalisation is its own
        // business: Crystal writes FALKNER and Polished Crystal writes
        // Falkner, and a caller asking for either should get the same
        // answer on either. The name is kept as the cartridge spells it, so
        // what gets shown is still the cartridge's word.
        const key = normalise(read.name);
        if (!out.has(key)) {
          out.set(key, { name: read.name, group: g + 1, party: read.party });
        }
        at = read.next;
      }
    }
    // Nothing decoded is *cannot read this table*, not "this cartridge has
    // no trainers". An empty map is an answer, and every caller believes it:
    // the Gym row would have said the room ahead is empty. Polished Crystal
    // is where that mattered -- 404 classes of nothing -- and null is what
    // the rest of the app is already written to handle.
    if (!out.size) return (this._trainers = null);
    return (this._trainers = out);
  }

  /**
   * How wide one entry of the trainer pointer table is, or null.
   *
   * **Derived, not declared**, and it is the same self-describing property the
   * class count uses: the entries sit immediately behind the pointers, so the
   * first pointer *is* the end of the table — and a width that is wrong makes
   * that arithmetic obviously wrong rather than subtly so.
   *
   * A candidate width passes three tests together. The first entry's address
   * must be past the table; the gap must divide by the width, since that gap
   * is a whole number of entries; and it must land in the same 16KB window as
   * the table, because a banked address that does not is not an address in
   * this bank. Measured on two cartridges, only one width passes on each:
   * Crystal's `dw` table at width two, pokecrystal16's `dba` table at three.
   *
   * The list's order is the tie-break if a cartridge ever satisfies both, and
   * two is first because it is the shape Gen 2 ships.
   */
  _pointerWidth(bank, addr) {
    for (const wide of this.e.trainerPointerBytes) {
      const at = addr + wide - 2;
      const first = this.gb.romByte(bank, at)
        | (this.gb.romByte(bank, at + 1) << 8);
      const gap = first - addr;
      // A bank byte that is not the table's own makes the gap meaningless:
      // the first entry is then somewhere else entirely and does not mark
      // where these pointers stop. Polished Crystal's table is `dba` into
      // banks $7d and $79, and the arithmetic that gives 67 classes on
      // pokecrystal16 gave 404 on it -- none of which held a trainer, since
      // that cartridge's party records are a different shape as well. So a
      // cross-bank table is refused rather than counted.
      const crossBank = wide > 2 && this.gb.romByte(bank, addr) !== bank;
      if (crossBank) {
        // The gap says nothing here, so the table is counted by walking it
        // -- see `_scanCount`. A width that walks nowhere is not the width.
        if (this._scanCount(bank, addr, wide) > 0) return wide;
        continue;
      }
      if (gap > 0 && gap % wide === 0
          && (first & 0xc000) === (addr & 0xc000)) {
        return wide;
      }
    }
    return null;
  }

  /**
   * How many entries a cross-bank pointer table has, by walking it.
   *
   * A `dba` table whose targets are in other banks cannot be measured the
   * way an in-bank one is: its first pointer is an address somewhere the
   * table cannot see, so the gap to it is not a number of entries. This
   * walks instead, and stops at the first triple that is not a pointer --
   * a bank past the end of the ROM, or an address in neither the banked
   * window nor work RAM.
   *
   * **Work RAM counts**, and that is not a loose end being tidied. Polished
   * Crystal's 123rd trainer class points at `$c90f`, which its symbol file
   * calls `wInverGroup` -- a party built at run time. A scan that insisted
   * on ROM stopped there and lost the twenty-six classes behind it.
   *
   * It can overshoot by one, and does on that cartridge: 149 walked against
   * 148 written, because the three bytes after the table happen to read as
   * an entry. That costs nothing. A class whose bytes are not a trainer
   * decodes to no trainers, which is what `_trainerAt` already answers, and
   * an empty class at the end of the list is one nobody can look up.
   */
  _scanCount(bank, addr, wide) {
    const banks = this.gb.romBanks || 0x80;
    for (let n = 0; n < 512; n++) {
      const at = addr + n * wide;
      const eb = this.gb.romByte(bank, at);
      const ea = this.gb.romByte(bank, at + wide - 2)
        | (this.gb.romByte(bank, at + wide - 1) << 8);
      const rom = (ea & 0xc000) === 0x4000;
      const ram = ea >= 0xc000 && ea <= 0xdfff;
      if (eb === undefined || eb >= banks || !(rom || ram)) return n;
    }
    return 512;
  }

  /**
   * One trainer's entry, or null when the bytes are not one.
   *
   * Separate so the two ways of failing are separate: a name that does not
   * terminate inside its bound, and a type byte the profile has never heard
   * of. Both mean "this is not a trainer", and reading on past either is how
   * a table of 541 entries becomes a table of nonsense.
   */
  _trainerAt(bank, at) {
    if (this.e.trainer && this.e.trainer.sized) {
      return this._sizedTrainerAt(bank, at);
    }
    const end = this.terminator();
    const bytes = [];
    let i = at;
    for (; i < at + this.e.trainerNameMax; i++) {
      const b = this.gb.romByte(bank, i);
      if (b === end) break;
      bytes.push(b);
    }
    if (this.gb.romByte(bank, i) !== end) return null;
    const kind = this.gb.romByte(bank, i + 1);
    const wide = this.e.trainerMonBytes[kind];
    if (!wide) return null;
    const party = [];
    let cur = i + 2;
    while (party.length <= this.e.maxParty) {
      const lead = this.gb.romByte(bank, cur);
      if (lead === this.e.trainerEnd || lead === undefined) break;
      party.push({ level: lead, species: this.gb.romByte(bank, cur + 1) });
      cur += wide;
    }
    if (this.gb.romByte(bank, cur) !== this.e.trainerEnd) return null;
    return { name: decodeText(bytes, end, this.e.alphabet), party, next: cur + 1 };
  }

  /**
   * One trainer from a record that says its own length, or null.
   *
   * Polished Crystal writes `db _tr_size` in front of every trainer -- the
   * bytes after that byte -- then the name, then a flags byte, then the
   * Pokemon. There is no `$ff` at the end; the size is the end.
   *
   * **Which means the party's width is not one number but six.** Each
   * Pokemon is a level and a `dp species, form`, and then one more byte for
   * each of item, EVs, DVs and personality that the flags claim, plus four
   * for the moves and a whole terminated string for a nickname. Falkner's
   * record says 39 and holds "Falkner", flags `$2b`, and three Pokemon of
   * ten bytes each -- 8 + 1 + 30, which is the arithmetic that proves the
   * reading rather than a comment claiming it.
   *
   * A record whose Pokemon do not fill it exactly is not a record. That is
   * the check the `$ff` used to be: reading at the wrong width overshoots or
   * undershoots the size byte, and either way this answers null instead of a
   * party of plausible nonsense.
   */
  _sizedTrainerAt(bank, at) {
    const spec = this.e.trainer;
    const end = this.terminator();
    const size = this.gb.romByte(bank, at);
    if (!size || size === undefined) return null;
    const stop = at + 1 + size;
    const bytes = [];
    let i = at + 1;
    for (; i < at + 1 + this.e.trainerNameMax && i < stop; i++) {
      const b = this.gb.romByte(bank, i);
      if (b === end) break;
      bytes.push(b);
    }
    if (this.gb.romByte(bank, i) !== end || !bytes.length) return null;
    const flags = this.gb.romByte(bank, i + 1);
    if (flags === undefined) return undefined === flags ? null : null;
    const party = [];
    let cur = i + 2;
    while (cur < stop && party.length <= this.e.maxParty) {
      const level = this.gb.romByte(bank, cur);
      const low = this.gb.romByte(bank, cur + 1);
      const form = this.gb.romByte(bank, cur + 2);
      if (level === undefined || low === undefined) return null;
      party.push({
        level,
        // The ninth bit of the species rides in the form byte, which is how
        // a cartridge with more than 255 of them fits one in a byte.
        species: low | ((form & spec.formSpeciesBit) ? 0x100 : 0),
      });
      cur += spec.monBase;
      // Then whichever optional fields the flags claim, **in the order the
      // cartridge writes them** -- one of which is a string.
      for (const [bit, size] of spec.monFields) {
        if (!(flags & (1 << bit))) continue;
        if (size === null) {
          let n = 0;
          while (cur < stop && this.gb.romByte(bank, cur) !== end
                 && n < this.e.trainerNameMax) { cur++; n++; }
          cur++;
        } else {
          cur += size;
        }
      }
    }
    if (cur !== stop || !party.length) return null;
    return { name: decodeText(bytes, end, this.e.alphabet), party, next: stop };
  }

  /** What one named trainer is carrying, or null. */
  trainer(name) {
    const index = this.trainerIndex();
    if (!index) return null;
    return index.get(normalise(name)) || null;
  }

  /** A trainer class's name, out of the packed table. */
  trainerClass(group) {
    if (!this.trainerClasses || !group) return '';
    if (!this._classes) this._classes = new Map();
    if (this._classes.has(group)) return this._classes.get(group);
    const out = this._packedName(this.trainerClasses, group);
    this._classes.set(group, out);
    return out;
  }

  /**
   * How a party of yours looks against a party of theirs.
   *
   * The question the Gym row could not answer: *is it worth walking there?*
   * Two facts decide it, and both are readable before the walk.
   *
   * `top` and `best` are the level either side tops out at, which is the
   * blunt one and the one that is usually the answer -- Bugsy's Scyther is
   * Lv16, and a Lv9 starter is not going to beat it however well it is
   * driven.
   *
   * `helpless` is the sharp one: the Pokemon of theirs that **nothing in your
   * party can take HP off at all.** That is the same reading `nothingLands`
   * does inside a battle, asked in front of the door instead of forty turns
   * in.
   *
   * Null where the chart cannot be read, because a warning nobody can price
   * is worse than none.
   */
  outlook(mine, theirs) {
    if (!this.matchups() || !mine || !theirs || !theirs.length) return null;
    const helpless = [];
    for (const them of theirs) {
      const types = this.speciesTypes(them.species);
      if (!types) return null;
      const lands = mine.some((m) => (m.moves || []).some((id, i) => {
        if (!id || !((m.pp || [])[i] > 0)) return false;
        const info = this.move(id);
        if (!info || info.power <= 0) return false;
        const eff = this.effectiveness(id, types);
        return eff === null || eff > 0;
      }));
      if (!lands) helpless.push(them);
    }
    const levels = (list) => list.reduce((n, m) => Math.max(n, m.level || 0), 0);
    return { top: levels(theirs), best: levels(mine.filter((m) => m.hp > 0)),
             helpless };
  }

  /**
   * Which of your party should be in front of that one, by slot.
   *
   * Gen 2 sends out slot one and asks nobody, so walking into a Gym with the
   * wrong Pokemon in front is a battle lost before the door closes -- and the
   * pilot has known what is in there since the pass before and could only
   * *say* so. This is the same reading turned into a slot number.
   *
   * Scored by adding up, for each of theirs, the hardest hit this Pokemon has
   * against it. Summed rather than "the best against their worst", because a
   * Gym is several battles in a row: the Pokemon that leads has to answer the
   * *room*, not the one Pokemon it is worst against.
   *
   * Null when there is nothing to do -- the best one is already leading, the
   * chart cannot be read, or nothing scores at all. Never a fainted slot: it
   * would be sent out and refused.
   */
  bestLead(mine, theirs) {
    if (!this.matchups() || !mine || !mine.length || !theirs || !theirs.length) {
      return null;
    }
    const types = theirs.map((m) => this.speciesTypes(m.species));
    if (types.some((t) => !t)) return null;
    let best = null, top = 0;
    for (let slot = 0; slot < mine.length; slot++) {
      const m = mine[slot];
      if (!m || !(m.hp > 0) || !m.moves) continue;
      const own = m.types || this.speciesTypes(m.species);
      let score = 0;
      for (const against of types) {
        let hardest = 0;
        for (let i = 0; i < m.moves.length; i++) {
          if (!m.moves[i] || !((m.pp || [])[i] > 0)) continue;
          const info = this.move(m.moves[i]);
          if (!info || info.power <= 0) continue;
          hardest = Math.max(hardest, this.hitPower(m.moves[i], against, own));
        }
        score += hardest;
      }
      // Strictly greater, so a tie leaves the earlier slot in front. Which
      // matters more than it looks: a switch costs four presses and a menu
      // walk, and a rule that reshuffles the party on every tie would spend
      // them every time the pilot looked at a Gym.
      if (score > top) { top = score; best = slot; }
    }
    // `best === 0` covers the "nothing scores" case too, and that is why
    // there is no test for a score of zero here: `score > top` starting from
    // zero means a slot only becomes `best` by scoring above it, so a null
    // `best` and a zero top are the same state. A third clause asking about
    // the top would be a branch that cannot be taken -- `tools/mutate`
    // widened it and nothing could fail either way.
    return best === null || best === 0 ? null : best;
  }

  /**
   * A species' own two types, out of the cartridge's base stats.
   *
   * The only way to know what a party member *is*: Gen 2 does not keep a
   * Pokemon's types in the party struct -- they are copied out of `BaseData`
   * when it is sent out, which is why work RAM has `wBattleMonType1` for the
   * one on the field and nothing at all for the five behind it. So a decision
   * about *which* Pokemon to send out has to come from the ROM.
   *
   * Null where the table cannot be read, which costs the same-type bonus and
   * nothing else.
   */
  speciesTypes(id) {
    const entry = this.baseStats(id);
    return entry ? entry.types : null;
  }

  /**
   * A species' whole base-stats entry, or null where it cannot be read.
   *
   * `speciesTypes` used to do this read itself and take two bytes out of it.
   * That was fine while the types were the only thing anybody wanted, and it
   * stopped being fine the moment a dex entry wanted the six stats sitting
   * immediately in front of them -- two readers of one 32-byte record, each
   * with its own copy of the id guard and its own cache, is the shape that
   * drifts. There is one reader now and `speciesTypes` asks it.
   *
   * The guard is the entry's own id, and it is the only one available: there
   * is no terminator here to run off the end of. A symbol file pointing
   * somewhere else reads zeroes, and `[0, 0]` is NORMAL/NORMAL -- a real type
   * pair, so a caller cannot tell it from an answer.
   */
  baseStats(id) {
    if (!this.base || !id || id > this.e.speciesCount) return null;
    if (!this._base) this._base = new Map();
    if (this._base.has(id)) return this._base.get(id);
    const f = this.e.baseField;
    const { bank, addr } = this.base;
    const entry = addr + (id - 1) * this.e.baseBytes;
    const at = (o) => this.gb.romByte(bank, entry + o);
    const miss = () => { this._base.set(id, null); return null; };
    const types = [at(f.types), at(f.types + 1)];
    if (types.some((t) => t === undefined)) return miss();
    // **The entry says which species it is, where there is a byte for it.**
    // Crystal writes the id in front of every entry, which is the cheapest
    // possible proof that the stride and the base agree. Polished Crystal
    // does not -- its entry begins with the stats -- so a profile that says
    // `id: null` is asking to be checked another way, and the other way is
    // that a species has non-zero base stats and types this cartridge can
    // name. A misaligned read lands in another entry's TM list, which is a
    // bitfield: zeroes where the stats should be, and type bytes past the
    // end of the type table.
    if (f.id === null || f.id === undefined) {
      const stats = this.e.statNames.map((k, i) => at(f.stats + i));
      if (stats.some((v) => !v)) return miss();
      if (types.some((t) => !this.typeName(t))) return miss();
    } else if (at(f.id) !== id) {
      return miss();
    }
    const growth = at(f.growth);
    const out = {
      id,
      types,
      // Named rather than positional, because six numbers in a row is exactly
      // the shape that gets read off by one -- which is how the types were
      // once read out of the special defence. `statNames` is the engine's list
      // and the only place the order is decided.
      stats: Object.fromEntries(
        this.e.statNames.map((k, i) => [k, at(f.stats + i)])),
      catchRate: at(f.catchRate),
      baseExp: at(f.baseExp),
      // Null where a cartridge packs it somewhere this cannot read it as a
      // byte: Polished Crystal puts the hatch cycles in a nibble beside the
      // gender ratio, and half a byte read as a whole one is a number.
      hatch: f.hatch === null || f.hatch === undefined ? null : at(f.hatch),
      // A key, not a curve. Which experience curve a species is on is a fact
      // about the cartridge; what to call it is the interface's business, and
      // an id the profile has no name for stays a number rather than becoming
      // a wrong word.
      growth: this.e.growthRates[growth] ?? growth,
    };
    this._base.set(id, out);
    return out;
  }

  /**
   * What a species turns into and what it learns, in one read.
   *
   * One method for both because they are one record: `EvosAttacksPointers` is
   * a `dw` per species into its own bank, and behind that pointer the
   * evolutions run first, ended by a zero, and the level-up moves follow
   * immediately. There is no way to read the second without walking the
   * first, so a `learnset()` that pretended otherwise would be walking the
   * evolutions anyway and throwing them away.
   *
   * An evolution comes back as a record naming its own kind:
   *
   *     { kind: 'level',     level: 14,  into: 156 }
   *     { kind: 'item',      item: 24,   into: 62 }
   *     { kind: 'trade',     item: 82,   into: 186 }   // item 0 means plain
   *     { kind: 'happiness', when: 'night', into: 197 }
   *     { kind: 'stat',      level: 20, compare: 'atkOverDef', into: 106 }
   *
   * Records rather than sentences, because five conditions in English is the
   * interface's problem and the numbers are the cartridge's.
   *
   * **The widths differ and only EVOLVE_STAT is four bytes.** TYROGUE is the
   * only species in the game that has one -- three of them, in fact -- and
   * reading them narrow shifts everything behind them, which decodes into a
   * learnset rather than into a failure.
   *
   * Null where the table cannot be read, which is a cartridge whose symbol
   * file does not name it. An empty pair of lists is a different answer and a
   * real one: plenty of species evolve into nothing and a few learn nothing.
   */
  evosAttacks(id) {
    if (!this.evos || !id || id > this.e.speciesCount) return null;
    if (!this._evos) this._evos = new Map();
    if (this._evos.has(id)) return this._evos.get(id);
    const { bank, addr } = this.evos;
    const spec = this.e.evo;
    const byte = (a) => this.gb.romByte(bank, a);
    const word = (a) => byte(a) | (byte(a + 1) << 8);
    const ptr = word(addr + (id - 1) * 2);
    // **The table ends where its own first pointer lands**, which is the same
    // trick `trainerIndex` uses and it is worth the two lines: the entries sit
    // immediately behind the pointers, so the first pointer *is* the end of
    // the table, and a pointer below it is one pointing back into the pointer
    // list rather than at a species.
    //
    // Getting the direction of that comparison wrong is not subtle and was not
    // caught by reading: written as "below the table" -- which is where the
    // trainer parties sit -- every one of the 251 species refused, because
    // here the data is *above* it. `tools/dex --verify` said so in one run.
    const first = word(addr);
    if (!(first > addr) || !(ptr >= first)) {
      this._evos.set(id, null);
      return null;
    }
    const kindOf = Object.fromEntries(
      Object.entries(spec.kind).map(([k, v]) => [v, k]));
    const nameOf = (table, v) =>
      Object.keys(table).find((k) => table[k] === v) ?? v;
    const evolves = [];
    let at = ptr;
    for (let guard = 0; guard < spec.maxEvos; guard++) {
      const tag = byte(at);
      if (tag === spec.end || tag === undefined) break;
      const wide = spec.bytes[tag];
      // A kind the profile has never heard of means this is not an evolution
      // run, and reading on past it is how a table becomes nonsense -- the
      // same refusal `_trainerAt` makes about an unknown party type byte.
      if (!wide) { this._evos.set(id, null); return null; }
      const into = byte(at + wide - spec.intoBack);
      const kind = kindOf[tag];
      const rec = { kind, into };
      if (kind === 'level' || kind === 'stat') rec.level = byte(at + 1);
      if (kind === 'item' || kind === 'trade') rec.item = byte(at + 1);
      if (kind === 'happiness') rec.when = nameOf(spec.when, byte(at + 1));
      if (kind === 'stat') rec.compare = nameOf(spec.compare, byte(at + 2));
      evolves.push(rec);
      at += wide;
    }
    at += 1;                                   // over the run's own terminator
    const learns = [];
    for (let guard = 0; guard < spec.maxLearn; guard++) {
      const level = byte(at);
      if (level === spec.end || level === undefined) break;
      learns.push({ level, move: byte(at + 1) });
      at += 2;
    }
    const out = { evolves, learns };
    this._evos.set(id, out);
    return out;
  }

  /**
   * Which hours belong to which third of the day, as one entry per hour.
   *
   * `GetTimeOfDay` walks pairs of *up to this hour* and *this block* and takes
   * the first whose hour is **greater** than the clock's -- so the table is
   * upper bounds, not starts, and reading it as starts shifts every boundary.
   * Decoded here into the plain thing every caller wants: hour 0 to 23, and
   * which block each one is.
   *
   * On this cartridge it comes out morning 4-9, day 10-17, night 18-3, which
   * is what everybody already believed and nobody had read.
   *
   * Null where the symbol file does not name the table -- and the app's answer
   * to that is to stop saying when a block begins, not to guess.
   */
  hourBlocks() {
    if (this._hours !== undefined) return this._hours;
    // A cartridge that keeps its hours in code rather than in a table says
    // so in its profile; see `engine.hours`. Checked for length, because a
    // list of the wrong size would silently call some hour undefined.
    const said = this.e.hours;
    if (said && said.length === this.e.hoursInDay) return (this._hours = said);
    if (!this.times) return (this._hours = null);
    const { bytes, end, scan } = this.e.timeTable;
    const { bank, addr } = this.times;
    const pairs = [];
    for (let i = 0; i < scan; i++) {
      const upTo = this.gb.romByte(bank, addr + i * bytes);
      const block = this.gb.romByte(bank, addr + i * bytes + 1);
      if (upTo === undefined) break;
      pairs.push({ upTo, block });
      if (upTo === end) break;
    }
    // A table with no terminator inside the bound is not this table, and a
    // single pair is what a bank of zeroes decodes into -- which would call
    // every hour of the day morning.
    if (!pairs.length || pairs[pairs.length - 1].upTo !== end) {
      return (this._hours = null);
    }
    const out = [];
    for (let hour = 0; hour < this.e.hoursInDay; hour++) {
      const hit = pairs.find((p) => p.upTo === end || hour < p.upTo);
      out.push(hit.block);
    }
    return (this._hours = out);
  }

  /**
   * The hours that are `block`, as `{ from, to }` inclusive, or null.
   *
   * `to` may be *below* `from`, and that is not a bug to normalise away: night
   * runs 18 to 3 and wraps midnight, which is the whole reason the app cannot
   * treat an hour range as an interval and has to ask this.
   */
  hoursOf(block) {
    const map = this.hourBlocks();
    if (!map) return null;
    const mine = map.map((b, hour) => (b === block ? hour : -1))
      .filter((h) => h >= 0);
    if (!mine.length) return null;
    // The run that wraps is the one whose predecessor is not also this block.
    const from = mine.find((h) => map[(h + map.length - 1) % map.length] !== block);
    const to = mine.find((h) => map[(h + 1) % map.length] !== block);
    return { from, to, hours: mine.length };
  }

  /**
   * The cartridge's own word for a type number, or '' where it cannot say.
   *
   * `TypeNames` is a `dw` per type id in the order of the type constants, so
   * the id is the index. Two gaps in that order are real and not a decoding
   * problem: Gen 2 leaves $0a-$13 unused between the physical types and the
   * special ones, and $06 is the unused BIRD type.
   *
   * Here rather than in `tools/types`, which had a decoder of its own with its
   * own partial charmap -- the second reader that agrees with the first until
   * it does not. The tool asks this now.
   */
  typeName(id) {
    if (!this.typeNames || id === undefined || id === null) return '';
    if (!this._typeNames) this._typeNames = new Map();
    if (this._typeNames.has(id)) return this._typeNames.get(id);
    const kind = this._typeNameKind();
    const name = kind ? this._typeNameAt(kind, id) : '';
    this._typeNames.set(id, name);
    return name;
  }

  /** Where entry `id` of `TypeNames` points, the way `kind` says it does. */
  _typeNameTarget(kind, id) {
    const { bank, addr } = this.typeNames;
    // `dr` is one byte from the entry's own address; `dw` is two bytes
    // holding an address. The origin differs as much as the width does,
    // which is why this is not a width like the trainer table's.
    const at = addr + id * (kind === 'dr' ? 1 : 2);
    return kind === 'dr'
      ? at + this.gb.romByte(bank, at)
      : this.gb.romByte(bank, at) | (this.gb.romByte(bank, at + 1) << 8);
  }

  /** One entry of `TypeNames`, read the way `kind` says it points. */
  _typeNameAt(kind, id) {
    return this._terminatedName(this.typeNames,
                                this._typeNameTarget(kind, id),
                                this.e.typeNameMax);
  }

  /**
   * How this cartridge's `TypeNames` points at its names, or null.
   *
   * **Derived, and the table proves itself.** A wrong reading of it does not
   * fail, it returns `????????????` for every type -- which is what Polished
   * Crystal gave for eleven ids until this existed, because it writes `dr`
   * where Crystal writes `dw`.
   *
   * The test is that the first two entries both decode to a terminated name
   * inside the bound, and that the second one starts after the first one
   * ends. One entry alone is not enough: a byte pair read as an address can
   * land on a name that belongs to something else, and one name is a
   * coincidence a table cannot be told apart from. Two consecutive ones in
   * the right order is the shape of a name table and nothing else's.
   */
  _typeNameKind() {
    if (this._typeKind !== undefined) return this._typeKind;
    this._typeKind = null;
    // No table to measure against, which is a state a cartridge is allowed
    // to be in -- every other name then reads with the profile's `$50`.
    if (!this.typeNames) return this._typeKind;
    for (const kind of this.e.typeNamePointers) {
      const run = this._nameRun(this._typeNameTarget(kind, 0),
                               this._typeNameTarget(kind, 1));
      if (run) {
        this._typeKind = kind;
        this._term = run.terminator;
        break;
      }
    }
    return this._typeKind;
  }

  /**
   * Two adjacent names, checked as a pair, and the byte that separates them.
   *
   * A name table lays its strings end to end, so the *second* entry starts
   * one byte after the first one's terminator -- which means the table says
   * what its terminator is, and nobody has to write it down. Polished
   * Crystal ends a string with **`$53`** where Crystal ends it with `$50`;
   * its whole charmap is shifted, and read with Crystal's terminator every
   * type name ran to its bound and came back empty.
   *
   * Checked as a pair because one name is a coincidence: a byte pair read as
   * an address lands on letters often enough. Two, in order, with only
   * letters between them and one byte left over, is the shape of a name
   * table and not much else's.
   */
  _nameRun(from, to) {
    const { bank } = this.typeNames;
    const len = to - from - 1;
    if (len <= 0 || len >= this.e.typeNameMax) return null;
    for (let i = 0; i < len; i++) {
      const b = this.gb.romByte(bank, from + i);
      if (b === undefined || !isNameByte(b, this.e.alphabet)) return null;
    }
    return { terminator: this.gb.romByte(bank, to - 1) };
  }

  /**
   * The byte this cartridge ends a name with.
   *
   * Measured off `TypeNames` and used for every name in the ROM, because a
   * cartridge has one alphabet: species, items, moves, landmarks and trainer
   * classes all end the same way. The profile's `$50` stands where there is
   * no such table to measure -- which is the state Crystal itself is
   * indistinguishable from, since `$50` is what it would measure.
   */
  terminator() {
    this._typeNameKind();
    return this._term === undefined ? NAME_TERMINATOR : this._term;
  }

  /**
   * What one attacking type does to one defending type, as a plain multiplier:
   * 2 for double, 0.5 for half, 0 for immune, 1 for neutral.
   *
   * Null means *cannot say* -- no chart, or a type nobody supplied -- and a
   * caller that reads that as neutral is claiming to know something it does
   * not. The distinction earns its keep in the same place every other null in
   * this app does: a pilot that cannot read the chart should rank moves the
   * way it used to, not rank them as if everything were neutral and then be
   * surprised.
   */
  matchup(attack, defend) {
    const table = this.matchups();
    if (!table) return null;
    if (attack === null || attack === undefined) return null;
    if (defend === null || defend === undefined) return null;
    // A row this cartridge keeps outside its chart, if it has any. Ahead of
    // the table because that is what it is for: the chart does not have the
    // row, so there is nothing here to disagree with.
    for (const [a, d, m] of this.e.damage.extra) {
      if (a === attack && d === defend) return m;
    }
    const unit = this.chartUnit();
    const found = table.get((attack << 8) | defend);
    const raw = found === undefined ? unit : found;
    return raw / unit;
  }

  /**
   * What byte value means *neutral* in this cartridge's chart, measured.
   *
   * Gen 2 writes the multiplier in tenths, so 05 is a half and 20 is a
   * double and neutral -- which is never written down, being the case the
   * table omits -- is 10. **Polished Crystal writes Q4 fixed point**: its
   * own constants are `NOT_VERY_EFFECTIVE EQU 0.5q4 ; $08` and
   * `SUPER_EFFECTIVE EQU 2.0q4 ; $20`, and read as tenths those became a
   * multiplier of 0.8 and one of 3.2. The bytes were right and the scale
   * was a number written in this file.
   *
   * So it is taken from the table instead, which describes itself: the two
   * non-zero values in a Gen 2-shaped chart are a half and a double, so the
   * smallest is half of neutral and the largest is twice it. Both are used
   * and they must agree -- the largest exactly four times the smallest --
   * because one of them alone cannot tell a half from a quarter.
   *
   * A chart that does not answer that shape keeps the profile's declared
   * value rather than a guess derived from it. That is the conservative
   * direction: the declared 10 is right for every cartridge that ships the
   * Gen 2 table, and a chart with three distinct multipliers in it is a
   * chart this reader was not written for either way.
   */
  chartUnit() {
    if (this._unit !== undefined) return this._unit;
    const declared = this.e.damage.neutral;
    const table = this.matchups();
    if (!table) return (this._unit = declared);
    const seen = [...new Set([...table.values()])].filter((v) => v > 0);
    if (!seen.length) return (this._unit = declared);
    const half = Math.min(...seen);
    const double = Math.max(...seen);
    if (double !== half * 4) return (this._unit = declared);
    return (this._unit = half * 2);
  }

  /**
   * What a move is worth against a defender carrying these types.
   *
   * Gen 2 stores a single-typed Pokemon as *both* of its types -- RATTATA is
   * NORMAL/NORMAL -- so multiplying once per slot squares every multiplier,
   * and a Ground move on a Ground/Ground DIGLETT came out at a quarter
   * instead of a half. The game applies each matching row once, whichever
   * slot matched it, so the types are deduplicated before they are multiplied.
   *
   * A defender with two different types collects both rows: FIRE on
   * MAGNEMITE, which is ELECTRIC/STEEL, is neutral against the ELECTRIC and
   * double against the STEEL, so double.
   */
  effectiveness(id, types) {
    const info = this.move(id);
    if (!info || !types || !types.length) return null;
    let out = 1;
    for (const t of new Set(types)) {
      // One unreadable type makes the whole answer unreadable, rather than
      // being skipped: half a matchup is a multiplier that looks like an
      // answer, and a Fire move priced against only the Grass half of a
      // Grass/Water Pokemon comes out double when it is neutral.
      const m = this.matchup(info.type, t);
      if (m === null) return null;
      out *= m;
    }
    return out;
  }

  /**
   * How hard a move will actually land, as a power the pilot can rank by.
   *
   * The number `power` alone is not that, and the gap is a lost battle: RAZOR
   * LEAF is 55 and TACKLE is 35, so ranking by power picks RAZOR LEAF against
   * every enemy -- including a Bug that takes half from it and full from
   * TACKLE, where the 35 is the harder hit. Against a Rock it is the other way
   * about by a factor of four.
   *
   * Two scalings, both out of the cartridge: the type chart, and the same-type
   * bonus for a move that shares a type with the Pokemon using it.
   *
   * The two scalings are independent, and only one of them needs the chart:
   * a cartridge whose symbol file does not name TypeMatchups still gets the
   * same-type bonus, because that asks nothing but the move's type and the
   * Pokemon's. What it loses is the matchup, and what it falls back to is
   * ranking by power -- which is the behaviour this replaced, so the pilot
   * survives a cartridge it cannot read the chart of.
   */
  hitPower(id, against = null, mine = null) {
    const info = this.move(id);
    if (!info) return 0;
    const eff = this.effectiveness(id, against);
    const stab = mine && mine.includes(info.type) ? this.e.damage.stab : 1;
    return info.power * (eff === null ? 1 : eff) * stab;
  }

  /**
   * Can this move be used at all against that defender?
   *
   * Separate from `hitPower` because zero is the one multiplier a caller may
   * want to act on rather than rank by: a Normal move on a GHOST is not a
   * weak hit, it is not a hit. False only when the chart says so; true where
   * it cannot be read, because "cannot tell" must not become "do not swing".
   */
  canHit(id, against = null) {
    const eff = this.effectiveness(id, against);
    return eff === null ? true : eff > 0;
  }

  /**
   * Can this move take HP off without deciding the battle by itself?
   *
   * Two exclusions, for opposite reasons.
   *
   * Status moves carry a power of zero. LEER and SMOKESCREEN would otherwise
   * rank as the gentlest attacks available and weaken nothing, forever.
   *
   * And eleven moves lie about their power. Gen 2 computes their damage rather
   * than scaling it, so it stores them at power 0 or 1 -- which puts every one
   * of them *ahead* of TACKLE when ranking ascending. Ask for the weakest
   * damaging move and you get GUILLOTINE. Checked against the ROM's own move
   * table, not just the disassembly's names.
   *
   * Note this is not the same as "fixed damage": EFFECT_STATIC_DAMAGE really
   * does store its damage as its power -- DRAGON_RAGE reads 40 and takes 40 --
   * so it ranks correctly and stays in.
   */
  isChipMove(id) {
    const m = this.move(id);
    if (!m || m.power <= 0) return false;
    return !this.e.lethalEffects.includes(m.effect);
  }


  /**
   * The id of an item, by folded name, or null.
   *
   * The mirror of `itemName`, and the one question the app had never needed to
   * ask: everything until now started from an id the game had already given it.
   * Buying starts from a *name* -- the title says "potion", and the pack walk
   * needs the number -- so the table is scanned once and cached.
   *
   * Bounded by the same `speciesCount`-style honesty as everything else here:
   * `itemName` walks terminators and answers '' past the end of the table, and
   * that empty answer is the stop.
   */
  itemIdOf(name) {
    const want = normalise(name || '');
    if (!want) return null;
    if (!this._itemIds) {
      this._itemIds = new Map();
      for (let id = 1; id <= ITEM_SCAN_LIMIT; id++) {
        const got = this.itemName(id);
        if (!got) break;
        const key = normalise(got);
        if (!this._itemIds.has(key)) this._itemIds.set(key, id);
      }
    }
    return this._itemIds.get(want) || null;
  }

  /**
   * The cheapest thing in a pocket that matches a list of names, or null.
   *
   * `names` is weakest-first and comes from the title, because an item id is
   * layout and an item name is content -- and content is what a hack changes.
   * `pocket` is `[id, quantity]` pairs as `state.items` reads them.
   *
   * A method on the decoder rather than a free function somewhere else, because
   * both halves of the work are already here: `itemName` and the `normalise`
   * fold that lets POKe and case cost nothing. It began as an export of
   * `journey.js` and moved when a second caller turned up in `battle.js` --
   * which would otherwise have had one gen2 module reaching sideways into
   * another for a question about the bag.
   *
   * Weakest first is the whole rule, and it is the same one the ball preference
   * follows: spend the cheapest thing that will do. A Full Restore on a Pokemon
   * missing four HP is the Master Ball at a Rattata.
   */
  cheapestOf(pocket, names) {
    if (!Array.isArray(names) || !names.length) return null;
    const carried = (pocket || []).filter(([, n]) => n > 0);
    for (const want of names) {
      for (const [id] of carried) {
        const name = this.itemName(id);
        if (name && normalise(name) === want) return { id, name };
      }
    }
    return null;
  }

  /**
   * The grass entry for a map, as `{ table, addr }`, or null.
   *
   * Three readers now want the same scan -- what appears, what levels it
   * gives, and what the other hours hold -- and the scan is the part with the
   * arithmetic in it: an entry is `headerBytes` plus two bytes per slot per
   * block, and getting that stride wrong reads a neighbouring map's block
   * without failing. One copy, so the three cannot disagree about where a map
   * is.
   */
  _grassAt(group, number) {
    const { blocks, slotsPerBlock, headerBytes, slotBytes } = this.e.encounter;
    const entryBytes = headerBytes + slotsPerBlock * blocks * slotBytes;
    for (const table of this.grass) {
      let addr = table.addr;
      // Scan the table; each map's block is a fixed size, ending at $FF.
      for (let guard = 0; guard < 512; guard++) {
        const g = this.gb.romByte(table.bank, addr);
        if (g === TABLE_END) break;
        if (g === group && this.gb.romByte(table.bank, addr + 1) === number) {
          return { table, addr };
        }
        addr += entryBytes;
      }
    }
    return null;
  }

  /**
   * The level a slot's byte means, or null where the cartridge will not say.
   *
   * **A level byte is not always a level.** Polished Crystal scales its wild
   * encounters to the badge case: `LEVEL_FROM_BADGES` is 178, a slot writes
   * `LEVEL_FROM_BADGES + 1` for one above the current base, and
   * `AdjustLevelForBadges` subtracts the constant, adds `wBadgeBaseLevel` and
   * clamps to 2..99. 357 of its slots are written that way, so read
   * literally, Route 47 offers a Lv179 Ditto — and the Hunt row would write
   * off a patch of grass the pilot could clear.
   *
   * The base lives in work RAM, so a caller with a snapshot gets a number and
   * a caller without one gets **null**, which every reader above already
   * treats as "this slot says nothing about levels". Null rather than the
   * sentinel, because 179 is not wrong by a little.
   */
  _levelOf(raw, wram) {
    const relative = this.e.encounter.levelFromBadges;
    if (!relative || raw <= this.e.levelMax) return raw;
    if (!wram || this.badgeBase === null) return null;
    const base = GameBoy.byteAt(wram, this.badgeBase);
    if (base === undefined) return null;
    // The cartridge's own clamp, in the cartridge's own order.
    return Math.max(LEVEL_FLOOR,
                    Math.min(this.e.levelMax - 1, base + raw - relative));
  }

  /**
   * One block of an entry as `[{ level, name }]`, padding dropped.
   *
   * A slot with no species is padding, and its level byte means nothing.
   * `wildLevels` knew that and `wildOn` did not, which is how a half-filled
   * block came to offer a species called `#0`: dropping it in one place is the
   * fix for both.
   */
  _slots({ table, addr }, block, wram = null) {
    const spec = this.e.encounter;
    const { slotsPerBlock, headerBytes, slotBytes } = spec;
    const out = [];
    for (let s = 0; s < slotsPerBlock; s++) {
      const at = addr + headerBytes + (block * slotsPerBlock + s) * slotBytes;
      const id = this.gb.romByte(table.bank, at + spec.species);
      if (!id) continue;
      out.push({ level: this._levelOf(
                   this.gb.romByte(table.bank, at + spec.level), wram),
                 name: this.speciesName(id) });
    }
    return out;
  }

  /** Which blocks a time of day asks for: one, clamped, or all of them. */
  _blocksFor(timeOfDay) {
    const { blocks, blockOf } = this.e.encounter;
    if (timeOfDay === null || timeOfDay === undefined) {
      return [...Array(blocks).keys()];
    }
    // A cartridge with more times of day than encounter blocks says which
    // shares which -- Polished Crystal has four times and three blocks, and
    // its evening draws from the day's.
    if (blockOf) {
      const which = blockOf[timeOfDay];
      if (which === undefined) return [];
      // One block or several: Polished Crystal's evening rolls the day's
      // table 60% of the time and the night's the other 40%, so what is in
      // the grass then is the union of the two and not either alone.
      return Array.isArray(which) ? which : [which];
    }
    return [Math.max(0, Math.min(blocks - 1, timeOfDay))];
  }

  /**
   * What appears in the grass on a map, commonest first.
   *
   * `timeOfDay` is wTimeOfDay: 0 morning, 1 day, 2 night. It matters -- Route
   * 29 trades PIDGEY and SENTRET for HOOTHOOT after dark, and offering a
   * species that cannot appear sends the pilot looking for something that was
   * never there.
   */
  wildOn(group, number, timeOfDay = null) {
    const entry = this._grassAt(group, number);
    if (!entry) return [];
    const counts = new Map();
    for (const block of this._blocksFor(timeOfDay)) {
      for (const { name } of this._slots(entry, block)) {
        counts.set(name, (counts.get(name) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name]) => name);
  }

  /**
   * What levels the grass here produces, as `{ low, high }` or null.
   *
   * The level has been sitting in front of `wildOn` and gone unread: a slot is
   * two bytes, level then species, and that method reaches past the first to
   * get at the second. Reading it costs one more byte per slot and answers a
   * question the app could not previously ask.
   *
   * Which matters because of what it prevents. Route 29 produces Lv2 to Lv4,
   * and a grind aimed at Lv20 standing on it wins nearly every battle for
   * almost no experience -- measured, 32 wins out of 35 battles for two levels,
   * and a knockout. The app offered Lv20 as a preset with nothing to say about
   * it. Now the row can.
   *
   * Null rather than a guess when the map has no table, because "no wild
   * Pokemon appear here" and "they are Lv2 to Lv4" are different answers and
   * only one of them is about levels. And null too where every slot's level
   * is relative to the badge case and no work RAM was handed in to resolve it
   * against -- see `_levelOf`.
   */
  wildLevels(group, number, timeOfDay = null, wram = null) {
    const entry = this._grassAt(group, number);
    if (!entry) return null;
    let low = Infinity, high = 0;
    for (const block of this._blocksFor(timeOfDay)) {
      for (const { level } of this._slots(entry, block, wram)) {
        if (!level) continue;
        if (level < low) low = level;
        if (level > high) high = level;
      }
    }
    return high ? { low, high } : null;
  }

  /**
   * Every hour of the same patch of grass: `[{ species, levels }]`, or null.
   *
   * Both readers above take a time of day and the app has only ever passed
   * them one -- the hour it is now -- so what the app knows about this grass is
   * a third of what the cartridge told it. The other two thirds answer a
   * question neither of them can: not "is this slow" but "would waiting fix
   * it", which is the cheapest answer there is, because it costs no walking.
   *
   * Indexed by wTimeOfDay, so `hours[2]` is after dark whatever the block
   * count -- a hack with two blocks gets two entries and nothing pretends
   * otherwise.
   */
  wildHours(group, number) {
    const entry = this._grassAt(group, number);
    if (!entry) return null;
    return this._blocksFor(null).map((block) => {
      const slots = this._slots(entry, block);
      const counts = new Map();
      let low = Infinity, high = 0;
      for (const { name, level } of slots) {
        counts.set(name, (counts.get(name) || 0) + 1);
        if (!level) continue;
        if (level < low) low = level;
        if (level > high) high = level;
      }
      return {
        species: [...counts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([name]) => name),
        levels: high ? { low, high } : null,
      };
    });
  }
}
