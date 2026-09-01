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
const PKMN_NAME_LENGTH = 10;
const NAME_TERMINATOR = 0x50;
// The charmap's one ligature that shows up in item names.
const POKE_LIGATURE = 0x54;
// A grass table is: map group, map number, three encounter rates, then three
// blocks of seven (level, species) -- morning, day, night. The list ends at $FF.
const GRASS_SLOTS_PER_TIME = 7;
const GRASS_BLOCKS = 3;
const GRASS_ENTRY_BYTES = 5 + GRASS_SLOTS_PER_TIME * GRASS_BLOCKS * 2;
const TABLE_END = 0xff;

/** The game's own character encoding, as far as names use it. */
export function decodeText(bytes) {
  let out = '';
  for (const b of bytes) {
    if (b === NAME_TERMINATOR) break;            // "@" terminates
    if (b === POKE_LIGATURE) out += 'POKé';      // one byte, four letters
    else if (b === 0x7f) out += ' ';
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

export class RomData {
  constructor(symbols, gb) {
    this.gb = gb;
    this.at = (name) => ({ bank: symbols.bank(name), addr: symbols.addr(name) });
    this.names = this.at('PokemonNames');
    this.items = this.at('ItemNames');
    this.grass = ['JohtoGrassWildMons', 'KantoGrassWildMons']
      .filter((n) => symbols.has(n))
      .map((n) => this.at(n));
    this._species = new Map();
  }

  _read(bank, addr, length) {
    const out = [];
    for (let i = 0; i < length; i++) out.push(this.gb.romByte(bank, addr + i));
    return out;
  }

  /** Species name for a Pokedex-order id (1-based), or "#id" if out of range. */
  speciesName(id) {
    if (!id || id > 251) return `#${id}`;
    if (this._species.has(id)) return this._species.get(id);
    const { bank, addr } = this.names;
    const name = decodeText(
      this._read(bank, addr + (id - 1) * PKMN_NAME_LENGTH, PKMN_NAME_LENGTH));
    this._species.set(id, name);
    return name;
  }

  /** Every species id that has a name, as name -> id, for looking one up. */
  speciesIndex() {
    if (!this._index) {
      this._index = new Map();
      for (let id = 1; id <= 251; id++) this._index.set(this.speciesName(id), id);
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
    for (const table of this.grass) {
      let addr = table.addr;
      // Scan the table; each map's block is a fixed size, ending at $FF.
      for (let guard = 0; guard < 512; guard++) {
        const g = this.gb.romByte(table.bank, addr);
        if (g === TABLE_END) break;
        const n = this.gb.romByte(table.bank, addr + 1);
        if (g === group && n === number) {
          const counts = new Map();
          const blocks = timeOfDay === null
            ? [0, 1, 2] : [Math.max(0, Math.min(2, timeOfDay))];
          for (const block of blocks) {
            for (let s = 0; s < GRASS_SLOTS_PER_TIME; s++) {
              const slot = block * GRASS_SLOTS_PER_TIME + s;
              const id = this.gb.romByte(table.bank, addr + 5 + slot * 2 + 1);
              const name = this.speciesName(id);
              counts.set(name, (counts.get(name) || 0) + 1);
            }
          }
          return [...counts.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([name]) => name);
        }
        addr += GRASS_ENTRY_BYTES;
      }
    }
    return [];
  }
}
