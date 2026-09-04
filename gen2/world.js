// Which map adjoins which, read out of the cartridge.
//
// The desktop pilot builds this by parsing the disassembly's attributes.asm. A
// phone has no disassembly, so this reads the same data from the ROM: every map
// header points at a map-attributes block, and that block ends with a bitmask
// of which sides connect plus one twelve-byte struct per connection naming the
// map on the other side.
//
// Nothing is loaded up front. There is no table of how many maps each group
// holds -- the disassembly knows that from constants the ROM does not carry --
// so walking every map is not possible. It is also not needed: connections name
// their neighbours, so starting from wherever the player is and following them
// outward reaches everything that can be walked to, and only that.
//
// Checked against the disassembly: from Route 29 this produces Cherrygrove to
// the west and New Bark to the east, and Cherrygrove -> Route 30 -> Route 31,
// matching data/maps/attributes.asm.

// The map header, from constants/map_data_constants.asm.
const MAP_BYTES = 9;
const MAP_ATTRIBUTES_BANK = 0, MAP_ATTRIBUTES = 3;

// The tail of a map-attributes block: a bitmask, then one struct per connection
// in a fixed order, whatever subset of them is present.
const ATTR_SCRIPTS_BANK = 6, ATTR_EVENTS = 9;
const ATTR_CONNECTIONS = 11, ATTR_STRUCTS = 12;

// A map's event block: two filler bytes, a count, then five bytes per warp --
// y, x, which warp on the far side, and the group and number of the map it
// leads to. The block shares a bank with the map scripts.
const EVENTS_WARP_COUNT = 2, EVENTS_WARPS = 3, WARP_BYTES = 5;
const WARP_Y = 0, WARP_X = 1, WARP_GROUP = 3, WARP_NUMBER = 4;
const CONNECTION_BYTES = 12;
const CONNECTED_GROUP = 0, CONNECTED_NUMBER = 1;

// A sanity bound: a bad read should give up, not walk off into the ROM.
const MAX_WARPS = 32;

// shift_const EAST, WEST, SOUTH, NORTH -- so east is bit 0. The structs are
// stored north, south, west, east regardless.
const SIDES = [
  { bit: 0x8, dir: 'UP' },
  { bit: 0x4, dir: 'DOWN' },
  { bit: 0x2, dir: 'LEFT' },
  { bit: 0x1, dir: 'RIGHT' },
];

/** One number for a (group, number) pair, matching Nav.mapKey(). */
export const mapKey = (group, number) => group * 256 + number;

export class World {
  constructor(symbols, gb) {
    this.gb = gb;
    this.groups = {
      bank: symbols.bank('MapGroupPointers'),
      addr: symbols.addr('MapGroupPointers'),
    };
    this.cache = new Map();
    this.warpCache = new Map();
  }

  _word(bank, addr) {
    return this.gb.romByte(bank, addr) | (this.gb.romByte(bank, addr + 1) << 8);
  }

  /** Where a map's attributes live, via its group's table of map headers. */
  _attributes(group, number) {
    const list = this._word(this.groups.bank, this.groups.addr + (group - 1) * 2);
    const header = list + (number - 1) * MAP_BYTES;
    return {
      bank: this.gb.romByte(this.groups.bank, header + MAP_ATTRIBUTES_BANK),
      addr: this._word(this.groups.bank, header + MAP_ATTRIBUTES),
    };
  }

  /**
   * The maps adjoining this one, as [{ dir, key }].
   *
   * Only edge connections -- walking off the side of a route. Doors and stairs
   * are warps, which live in the map's event data and are handled by the tasks
   * that know which door they want.
   */
  neighbours(group, number) {
    const key = mapKey(group, number);
    if (this.cache.has(key)) return this.cache.get(key);

    const out = [];
    try {
      const attr = this._attributes(group, number);
      const mask = this.gb.romByte(attr.bank, attr.addr + ATTR_CONNECTIONS);
      let at = attr.addr + ATTR_STRUCTS;
      for (const side of SIDES) {
        if (!(mask & side.bit)) continue;
        const g = this.gb.romByte(attr.bank, at + CONNECTED_GROUP);
        const n = this.gb.romByte(attr.bank, at + CONNECTED_NUMBER);
        if (g && n) out.push({ dir: side.dir, key: mapKey(g, n) });
        at += CONNECTION_BYTES;
      }
    } catch (e) {
      // A map number the ROM does not have reads as nonsense rather than
      // failing. An empty neighbour list is the honest answer.
    }
    this.cache.set(key, out);
    return out;
  }

  /**
   * The doors, stairs and cave mouths on a map, as [{ x, y, key }].
   *
   * Indoor maps have no edge connections at all -- a bedroom does not adjoin a
   * route -- so without these the graph cannot get out of a building, which is
   * exactly where the player wakes up after whiting out.
   */
  warps(group, number) {
    const id = mapKey(group, number);
    if (this.warpCache.has(id)) return this.warpCache.get(id);

    const out = [];
    try {
      const attr = this._attributes(group, number);
      const bank = this.gb.romByte(attr.bank, attr.addr + ATTR_SCRIPTS_BANK);
      const events = this._word(attr.bank, attr.addr + ATTR_EVENTS);
      const count = this.gb.romByte(bank, events + EVENTS_WARP_COUNT);
      for (let i = 0; i < Math.min(count, MAX_WARPS); i++) {
        const at = events + EVENTS_WARPS + i * WARP_BYTES;
        const g = this.gb.romByte(bank, at + WARP_GROUP);
        const n = this.gb.romByte(bank, at + WARP_NUMBER);
        if (!g || !n) continue;
        out.push({
          x: this.gb.romByte(bank, at + WARP_X),
          y: this.gb.romByte(bank, at + WARP_Y),
          key: mapKey(g, n),
        });
      }
    } catch (e) {
      // Same as neighbours(): nonsense reads mean no warps, not a crash.
    }
    this.warpCache.set(id, out);
    return out;
  }

  /** Every way off this map, edges and doors alike. */
  exits(key) {
    const group = key >> 8, number = key & 0xff;
    const out = this.neighbours(group, number)
      .map((n) => ({ kind: 'edge', dir: n.dir, key: n.key }));
    for (const w of this.warps(group, number)) {
      out.push({ kind: 'warp', tile: [w.x, w.y], key: w.key });
    }
    return out;
  }

  /**
   * Directions to walk from one map to another, or null if they do not join up
   * by edges alone.
   *
   * Breadth-first over the connections, expanded as it goes.
   */
  route(from, to, { maxMaps = 400 } = {}) {
    if (from === to) return [];
    const seen = new Set([from]);
    const queue = [[from, []]];
    let head = 0;
    while (head < queue.length && seen.size < maxMaps) {
      const [key, path] = queue[head++];
      for (const exit of this.exits(key)) {
        if (seen.has(exit.key)) continue;
        const next = path.concat(exit);
        if (exit.key === to) return next;
        seen.add(exit.key);
        queue.push([exit.key, next]);
      }
    }
    return null;
  }
}
