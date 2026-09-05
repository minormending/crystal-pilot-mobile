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

/** The game's own character encoding, as far as names use it. */
export function decodeText(bytes) {
  let out = '';
  for (const b of bytes) {
    if (b === NAME_TERMINATOR) break;            // "@" terminates
    if (b === POKE_LIGATURE) out += 'POKé';      // one byte, four letters
    else if (b === 0x7f) out += ' ';
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

  /** Every species id that has a name, as name -> id, for looking one up. */
  speciesIndex() {
    if (!this._index) {
      this._index = new Map();
      for (let id = 1; id <= this.e.speciesCount; id++) {
        this._index.set(this.speciesName(id), id);
      }
    }
    return this._index;
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
    const { bank, addr } = this.items;
    let at = addr;
    for (let n = 1; n < id; n++) {
      for (let guard = 0; guard < 24; guard++) {
        if (this.gb.romByte(bank, at++) === NAME_TERMINATOR) break;
      }
    }
    const bytes = [];
    for (let guard = 0; guard < 24; guard++) {
      const b = this.gb.romByte(bank, at + guard);
      if (b === NAME_TERMINATOR) break;
      bytes.push(b);
    }
    const name = decodeText(bytes);
    if (!this._itemCache) this._itemCache = new Map();
    this._itemCache.set(id, name);
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

  /** Normalised name -> id, so a ball can be found by what it is called. */
  itemIndex(limit = 60) {
    if (!this._itemIndex) {
      this._itemIndex = new Map();
      for (let id = 1; id <= limit; id++) {
        this._itemIndex.set(normalise(this.itemName(id)), id);
      }
    }
    return this._itemIndex;
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
    const { blocks: blockCount, slotsPerBlock, headerBytes } = this.e.encounter;
    const entryBytes = headerBytes + slotsPerBlock * blockCount * 2;
    for (const table of this.grass) {
      let addr = table.addr;
      // Scan the table; each map's block is a fixed size, ending at $FF.
      for (let guard = 0; guard < 512; guard++) {
        const g = this.gb.romByte(table.bank, addr);
        if (g === TABLE_END) break;
        const n = this.gb.romByte(table.bank, addr + 1);
        if (g === group && n === number) {
          const counts = new Map();
          const all = [...Array(blockCount).keys()];
          const blocks = timeOfDay === null
            ? all : [Math.max(0, Math.min(blockCount - 1, timeOfDay))];
          for (const block of blocks) {
            for (let s = 0; s < slotsPerBlock; s++) {
              const slot = block * slotsPerBlock + s;
              const id = this.gb.romByte(table.bank,
                                         addr + headerBytes + slot * 2 + 1);
              const name = this.speciesName(id);
              counts.set(name, (counts.get(name) || 0) + 1);
            }
          }
          return [...counts.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([name]) => name);
        }
        addr += entryBytes;
      }
    }
    return [];
  }
}
