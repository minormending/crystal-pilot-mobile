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
const NAME_TERMINATOR = 0x50;
// The charmap's one ligature that shows up in item names.
const POKE_LIGATURE = 0x54;
// The rest of charmap.asm that turns up in a name. Without these, every byte
// here decoded as "?" -- and five of them are in species names, which is not a
// cosmetic problem: NIDORAN-female and NIDORAN-male both came back "NIDORAN?",
// so the species picker drew two identical chips and hunting for one of them
// stopped at the other. Route 35 and Route 36 both carry the pair.
//
// Measured out of the cartridge rather than copied hopefully: 0xe0 in
// FARFETCH'D and KING'S ROCK, 0xe3 in HO-OH, 0xe8 in MR.MIME, GUARD SPEC.,
// EXP.SHARE and S.S.TICKET, 0xef and 0xf5 in the two NIDORAN. The others are
// here because they are in the same block of the charmap and a name that uses
// one would have had the same silent fate.
const PUNCTUATION = {
  0xe0: "'", 0xe3: '-', 0xe6: '?', 0xe7: '!', 0xe8: '.',
  0xe9: '&', 0xea: 'é', 0xef: '\u2642', 0xf1: '×', 0xf3: '/',
  0xf4: ',', 0xf5: '\u2640',
};
// The list ends at $FF. Not an engine field: a terminator is the shape of the
// table rather than a size in it, and a cartridge that used a different one
// would need a different scan, not a different number.
const TABLE_END = 0xff;
// The bytes Gen 2 uses to break a line, which inside a *name* mean a space: a
// landmark name is written to fit a two-line sign. $1f is the one landmark
// names use -- read off "NEW BARK TOWN", whose bytes are
// `8d 84 96 7f 81 80 91 8a 1f 93 8e 96 8d 50`, so the break sits exactly where
// the sign wraps. $4e and $4f are the ones ordinary text uses; they are here
// because a name is text and one of them will turn up in a hack.
const LINE_BREAKS = new Set([0x1f, 0x4e, 0x4f]);
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

/** The game's own character encoding, as far as names use it. */
export function decodeText(bytes) {
  let out = '';
  for (const b of bytes) {
    if (b === NAME_TERMINATOR) break;            // "@" terminates
    if (b === POKE_LIGATURE) out += 'POKé';      // one byte, four letters
    else if (b === 0x7f) out += ' ';
    // A line break inside a *name* is a space. Landmark names are written to
    // fit a two-line sign -- "NEW BARK<line>TOWN" -- and reading the break as
    // an unknown byte put a question mark in the middle of half the towns in
    // Johto.
    else if (LINE_BREAKS.has(b)) out += ' ';
    else if (PUNCTUATION[b] !== undefined) out += PUNCTUATION[b];
    else if (b >= 0x80 && b <= 0x99) out += String.fromCharCode(65 + b - 0x80);
    else if (b >= 0xa0 && b <= 0xb9) out += String.fromCharCode(97 + b - 0xa0);
    else if (b >= 0xf6 && b <= 0xff) out += String.fromCharCode(48 + b - 0xf6);
    else out += '?';
  }
  return out.trim();
}

/** Case and accent folded, so "POKé BALL" can be matched by typing it plainly. */
export function normalise(name) {
  return name.toLowerCase().replace(/é/g, 'e').replace(/\s+/g, ' ').trim();
}

import { gen2 } from './engine.js';

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
    this.moveNames = symbols.has('MoveNames') ? this.at('MoveNames') : null;
    // Optional, like the wild tables: a cartridge whose symbol file does not
    // name it keeps every map it was told about and loses the rest.
    this.landmarks = symbols.has('Landmarks') ? this.at('Landmarks') : null;
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
    const name = decodeText(
      this._read(bank, addr + (id - 1) * this.e.nameLength, this.e.nameLength));
    this._species.set(id, name);
    return name;
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
    const name = this._packedName(this.items, id);
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
    let at = addr;
    for (let n = 1; n < id; n++) {
      for (let guard = 0; guard < PACKED_NAME_MAX; guard++) {
        if (this.gb.romByte(bank, at++) === NAME_TERMINATOR) break;
      }
    }
    const bytes = [];
    let ended = false;
    for (let guard = 0; guard < PACKED_NAME_MAX; guard++) {
      const b = this.gb.romByte(bank, at + guard);
      if (b === NAME_TERMINATOR) { ended = true; break; }
      bytes.push(b);
    }
    // No terminator inside the bound, so that was not a name. The longest in
    // Crystal is twelve characters, so reaching twenty-four means the symbol
    // file is pointing somewhere that is not a name table -- and `decodeText`
    // will happily turn any bytes at all into a string of question marks,
    // which reads like an answer.
    return ended ? decodeText(bytes) : '';
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
    const { bank, addr } = this.landmarks;
    const at = addr + id * LANDMARK_BYTES;
    const ptr = this.gb.romByte(bank, at + LANDMARK_NAME)
      | (this.gb.romByte(bank, at + LANDMARK_NAME + 1) << 8);
    const name = decodeText(this._read(bank, ptr, LANDMARK_NAME_MAX));
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
    const found = table.get((attack << 8) | defend);
    const tenths = found === undefined ? this.e.damage.neutral : found;
    return tenths / this.e.damage.neutral;
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
    const { blocks, slotsPerBlock, headerBytes } = this.e.encounter;
    const entryBytes = headerBytes + slotsPerBlock * blocks * 2;
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
   * One block of an entry as `[{ level, name }]`, padding dropped.
   *
   * A slot with no species is padding, and its level byte means nothing.
   * `wildLevels` knew that and `wildOn` did not, which is how a half-filled
   * block came to offer a species called `#0`: dropping it in one place is the
   * fix for both.
   */
  _slots({ table, addr }, block) {
    const { slotsPerBlock, headerBytes } = this.e.encounter;
    const out = [];
    for (let s = 0; s < slotsPerBlock; s++) {
      const at = addr + headerBytes + (block * slotsPerBlock + s) * 2;
      const id = this.gb.romByte(table.bank, at + 1);
      if (!id) continue;
      out.push({ level: this.gb.romByte(table.bank, at), name: this.speciesName(id) });
    }
    return out;
  }

  /** Which blocks a time of day asks for: one, clamped, or all of them. */
  _blocksFor(timeOfDay) {
    const { blocks } = this.e.encounter;
    if (timeOfDay === null || timeOfDay === undefined) {
      return [...Array(blocks).keys()];
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
   * only one of them is about levels.
   */
  wildLevels(group, number, timeOfDay = null) {
    const entry = this._grassAt(group, number);
    if (!entry) return null;
    let low = Infinity, high = 0;
    for (const block of this._blocksFor(timeOfDay)) {
      for (const { level } of this._slots(entry, block)) {
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
