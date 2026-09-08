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
// And the landmark this map belongs to, which is what the game itself calls the
// place. Byte 5 of the nine, measured by grouping rather than guessed: Violet
// City, its Mart and its Center all read 6; Cherrygrove's three all read 3; and
// Elm's lab reads 1, which is New Bark Town's -- because Elm's lab is in New
// Bark Town. No other byte in the header groups that way.
const MAP_LANDMARK = 5;

// The tail of a map-attributes block: a bitmask, then one struct per connection
// in a fixed order, whatever subset of them is present.
const ATTR_SCRIPTS_BANK = 6, ATTR_EVENTS = 9;
const ATTR_CONNECTIONS = 11, ATTR_STRUCTS = 12;

// A map's event block: two filler bytes, a count, then five bytes per warp --
// y, x, which warp on the far side, and the group and number of the map it
// leads to. The block shares a bank with the map scripts.
const EVENTS_WARP_COUNT = 2, EVENTS_WARPS = 3, WARP_BYTES = 5;
const WARP_Y = 0, WARP_X = 1, WARP_GROUP = 3, WARP_NUMBER = 4;
// The rest of the event block, past the warps: a count and then that many
// fixed-size records, three times over. Every size measured against work RAM --
// the object list this parses out of the ROM matches `wMapObjects` entry for
// entry on Elm's lab, Cherrygrove's Center and Route 30, sprites and tiles and
// types alike, which is a stronger check than reading the macro would be.
const COORD_BYTES = 8, BG_BYTES = 5, OBJECT_BYTES = 13;
const OBJECT_SPRITE = 0, OBJECT_Y = 1, OBJECT_X = 2;
// Objects are stored with the same +4 origin work RAM uses.
const OBJECT_ORIGIN = 4;
// A sanity bound, like MAX_WARPS: a bad read should give up rather than walk
// off into the ROM.
const MAX_OBJECTS = 32;

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
    this.objectCache = new Map();
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

  /**
   * Which landmark this map belongs to, or null.
   *
   * The game's own idea of *where you are*: a landmark is a place with a name
   * on the town map, and every map header carries the id of the one it sits in.
   * Several maps share one -- a city, its Mart and its Center are all the city
   * -- which is exactly right for naming, and is why an offer list picks one
   * map per landmark rather than one per map.
   *
   * Null on a map the ROM does not have, the same as every other reader here:
   * a nonsense read is an absence rather than a crash.
   */
  landmarkOf(group, number) {
    try {
      const list = this._word(this.groups.bank, this.groups.addr + (group - 1) * 2);
      const header = list + (number - 1) * MAP_BYTES;
      return this.gb.romByte(this.groups.bank, header + MAP_LANDMARK);
    } catch (e) {
      return null;
    }
  }

  /**
   * What the ROM places on a map: `[{ sprite, x, y }]`.
   *
   * The same block `warps` walks, read further along. Which makes it the one
   * reader in this app that can look at a map **it is not standing on** --
   * `collision.placedObjects` reads work RAM, so it only ever knows about the
   * map that is loaded, and that is exactly the limitation this exists to lift:
   * a Pokemon Center is recognisable by the nurse behind her counter, and the
   * pilot needs to know which door has one behind it *before* it walks through.
   *
   * Cached per map, because the classification above it asks about every map
   * within a few legs and the answer cannot change: this is the cartridge, not
   * the game.
   */
  objectsOn(group, number) {
    const id = mapKey(group, number);
    if (this.objectCache.has(id)) return this.objectCache.get(id);
    const out = [];
    try {
      const attr = this._attributes(group, number);
      const bank = this.gb.romByte(attr.bank, attr.addr + ATTR_SCRIPTS_BANK);
      const events = this._word(attr.bank, attr.addr + ATTR_EVENTS);
      const rd = (i) => this.gb.romByte(bank, (events + i) & 0xffff);
      let at = EVENTS_WARP_COUNT;
      at += 1 + rd(at) * WARP_BYTES;              // warps
      at += 1 + rd(at) * COORD_BYTES;             // coord events
      at += 1 + rd(at) * BG_BYTES;                // bg events
      const count = rd(at++);
      for (let i = 0; i < Math.min(count, MAX_OBJECTS); i++) {
        const o = at + i * OBJECT_BYTES;
        out.push({
          sprite: rd(o + OBJECT_SPRITE),
          x: rd(o + OBJECT_X) - OBJECT_ORIGIN,
          y: rd(o + OBJECT_Y) - OBJECT_ORIGIN,
        });
      }
    } catch (e) {
      // Same as the other readers here: nonsense reads mean nothing placed,
      // not a crash.
    }
    this.objectCache.set(id, out);
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
   * The way from one map to another, or null if there is none.
   *
   * A route is a list of exits to take in order -- an edge to walk off, a warp
   * to stand on -- and the first one found by breadth is the shortest by legs.
   */
  route(from, to, { maxMaps = 400, avoid = null } = {}) {
    if (from === to) return [];
    return this.routesFrom(from, [to], { maxMaps, avoid }).get(to) || null;
  }

  /**
   * The name a leg goes by when it has to be refused.
   *
   * Two maps rather than a map and a direction, because that is what a caller
   * knows after a failure: it tried to get from here to there and could not.
   */
  static leg(from, to) { return `${from}>${to}`; }

  /**
   * Routes to several places at once, from one search.
   *
   * `route` used to hold the traversal itself, and asking it about ten
   * destinations meant ten breadth-first walks over the same graph. This is the
   * same walk, stopping when every place asked about has been found -- so one
   * target costs exactly what it did before, and ten cost one search instead of
   * ten. `route` is written in terms of it rather than beside it, because two
   * copies of a graph traversal is two things to keep in step.
   *
   * Answers a Map, so a caller can tell "not reachable" from "reachable at zero
   * cost": an absent key is the first, and this never returns a route to the
   * map you are standing on -- that is not a journey, and `travelTo` already
   * says "arrived" for it.
   */
  routesFrom(from, targets, { maxMaps = 400, avoid = null } = {}) {
    const want = new Set([...targets].filter((k) => k !== from));
    const found = new Map();
    if (!want.size) return found;
    const seen = new Set([from]);
    const queue = [[from, []]];
    let head = 0;
    while (head < queue.length && seen.size < maxMaps && found.size < want.size) {
      const [key, path] = queue[head++];
      for (const exit of this.exits(key)) {
        // A leg the caller has already failed to walk. **This is not a
        // theoretical case.** Route 29's connection struct says there is a map
        // north of it, and there is -- Route 46 -- but the pilot cannot get up
        // there, and naming Violet City made that the shortest route to it by
        // legs. The walk refused UP three times and `travelTo` gave up, on a
        // town that is perfectly reachable the ordinary way.
        //
        // So a search can be told to leave a leg out, and the caller that
        // failed to walk one tells it. Shortest-by-legs has no notion of a leg
        // being hard, and nothing in the connection data says so either.
        if (avoid && avoid.has(World.leg(key, exit.key))) continue;
        if (seen.has(exit.key)) continue;
        const next = path.concat(exit);
        if (want.has(exit.key)) found.set(exit.key, next);
        seen.add(exit.key);
        queue.push([exit.key, next]);
      }
    }
    return found;
  }
}
