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

// Party struct layout, verified against the disassembly:
// wPartyMon2 - wPartyMon1 == 0x30.
export const PARTY_STRUCT = 0x30;
export const MON = {
  species: 0x00, moves: 0x02, pp: 0x17, level: 0x1f,
  status: 0x20, hp: 0x22, maxHp: 0x24,
};
