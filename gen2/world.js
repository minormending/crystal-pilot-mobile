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

// The map header's shape is `engine.mapHeader` -- Polished Crystal's is
// seven bytes with no attributes bank where Crystal's is nine with one.
// And the landmark this map belongs to, which is what the game itself calls the
// place. Byte 5 of the nine, measured by grouping rather than guessed: Violet
// City, its Mart and its Center all read 6; Cherrygrove's three all read 3; and
// Elm's lab reads 1, which is New Bark Town's -- because Elm's lab is in New
// Bark Town. No other byte in the header groups that way.


// The tail of a map-attributes block: a bitmask, then one struct per connection
// in a fixed order, whatever subset of them is present.
// The map's own size, in blocks, at the front of its attributes block. Measured
// rather than read off the macro, against two maps whose tile dimensions were
// already known from work RAM: Route 32 reads 45 and 10 for a map that is 20 by
// 90 tiles, and Route 31 reads 9 and 20 for one that is 40 by 18. So height
// comes first, and a block is two tiles each way.
// The attributes block's shape is `engine.mapAttr` -- Polished Crystal's
// stops after the scripts and keeps its warps inside the script header.
const TILES_PER_BLOCK = 2;


// A map's event block: a count, then five bytes per warp -- y, x, which warp
// on the far side, and the group and number of the map it leads to -- and then
// three more counted lists. The block shares a bank with the map scripts.
// Where the warp count and the warps sit inside it is `engine.mapAttr`:
// Crystal's block opens with two filler bytes and Polished Crystal's begins on
// the count itself.
//
// **The strides of the four lists are `engine.mapEvents`, and they used to be
// constants here.** Every size was measured against work RAM -- the object
// list this parses out of the ROM matches `wMapObjects` entry for entry on
// Elm's lab, Cherrygrove's Center and Route 30, sprites and tiles and types
// alike, which is a stronger check than reading the macro would be. All of
// that was measured on Crystal, and Polished Crystal writes a five-byte coord
// event where Crystal writes eight. Nothing failed: `objectsOn` stepped past
// the triggers by the wrong amount, landed mid-record, and came back empty for
// New Bark Town, which has five people standing on it.
//
// Only the warp fields stay here, because a warp is the same five bytes on
// every cartridge this has met -- Polished still writes a map id as
// `db group, number` even with 488 maps to number.
const WARP_Y = 0, WARP_X = 1, WARP_GROUP = 3, WARP_NUMBER = 4;
// A sanity bound, like MAX_WARPS. **A count that reaches it means the read is
// wrong, not that the map is crowded**, and the difference is what the bound is
// for: truncating at thirty-two and returning them believes the first
// thirty-two bytes of nonsense, which is how a map past the end of the last
// group answered with thirty-two objects at plausible tiles. No real map in
// Crystal carries anything like this many.
const MAX_OBJECTS = 32;
// The same kind of bound, for the same reason: a count that reaches it says the
// read is wrong rather than that the map is busy. No map in Crystal has many.
const MAX_COORD_EVENTS = 16;

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
import { gen2 } from './engine.js';

export const mapKey = (group, number) => group * 256 + number;

export class World {
  constructor(symbols, gb, engine = null) {
    this.gb = gb;
    this.e = engine || gen2;
    this.h = this.e.mapHeader;
    this.groups = {
      bank: symbols.bank('MapGroupPointers'),
      addr: symbols.addr('MapGroupPointers'),
    };
    this.cache = new Map();
    this.warpCache = new Map();
    this.objectCache = new Map();
  }

  /**
   * The bank every attributes block lives in, on a cartridge that does not
   * say per map.
   *
   * Crystal repeats the bank in each map's header, so this is never asked of
   * it. Polished Crystal writes `dw \1_MapAttributes` and nothing else,
   * because all of its blocks are in one bank -- and which bank that is
   * appears nowhere in the data. The symbol file knows, and the symbol file
   * is exactly what a second device may not have.
   *
   * **So it is scored.** Every bank in the ROM is tried against every map
   * the cartridge has, and a map's block agrees if its height and width are
   * a real size and its connection mask has only the four direction bits.
   * A wrong bank is arbitrary bytes read as a size, and fails on nearly all
   * of six hundred maps; the right one passes nearly all of them. The best
   * is taken only if it clears the second best by a wide margin, and
   * otherwise this answers zero -- which reads as "no such bank" everywhere
   * a caller uses it, the same as any other unreadable map.
   */
  _attrBank() {
    if (this._bank !== undefined) return this._bank;
    const maps = [];
    for (let group = 1; group <= 26 && maps.length < 400; group++) {
      const n = this.mapCount(group);
      for (let number = 1; number <= (n || 0); number++) {
        const list = this._word(this.groups.bank,
                                this.groups.addr + (group - 1) * 2);
        const header = list + (number - 1) * this.h.bytes;
        maps.push(this._word(this.groups.bank, header + this.h.attrAddr));
      }
    }
    const banks = Math.ceil(this.gb.romBanks ? this.gb.romBanks : 0x80);
    const score = (bank) => {
      let n = 0;
      for (const addr of maps) {
        if ((addr & 0xc000) !== 0x4000) continue;
        const h = this.gb.romByte(bank, addr + this.e.mapAttr.height);
        const w = this.gb.romByte(bank, addr + this.e.mapAttr.width);
        const mask = this.gb.romByte(bank, addr + this.e.mapAttr.connections);
        if (h > 0 && h <= 64 && w > 0 && w <= 64 && (mask & 0xf0) === 0) n++;
      }
      return n;
    };
    let best = { bank: 0, n: -1 }, second = -1;
    for (let bank = 1; bank < banks; bank++) {
      const n = score(bank);
      if (n > best.n) { second = best.n; best = { bank, n }; }
      else if (n > second) second = n;
    }
    const enough = maps.length / 2;
    return (this._bank = best.n >= enough && best.n > second * 1.5
      ? best.bank : 0);
  }

  /**
   * Where this map's event block begins, in the scripts' bank.
   *
   * Crystal points at it from the attributes. **Polished Crystal has no
   * such pointer**: its warps are inside the map script header, behind a
   * count of scene scripts and a count of callbacks, so where they start
   * depends on how many of each this map has. `mapAttr.events` is null
   * there and `eventSkip` says the size of an entry in each list to step
   * over -- two bytes a scene script, three a callback.
   *
   * Measured against NewBarkTown, whose header reads `00 01 | 01 9f 40 |
   * 05 | 03 06 01 18 03 ...`: no scenes, one callback, five warps, and the
   * first of them `y 3, x 6, to 1, map 24.3`, which is
   * `warp_event 6, 3, ELMS_LAB, 1`.
   */
  /**
   * How many maps a search may visit before giving up.
   *
   * **A safety valve, not a distance.** It exists so a graph that turns out
   * to be nonsense cannot spin; it should never be the thing that decides an
   * answer. It was the constant 400, which is comfortably past Crystal's
   * 361 maps and *short of Polished Crystal's 488* -- so the far end of
   * Kanto was unreachable not because no route existed but because the
   * search stopped before it got there. Three Pokemon Centers, each one leg
   * from a town the same search reached.
   *
   * Counted off the cartridge instead, once, with slack: whatever the
   * groups say they hold, and never below the old number.
   */
  mapBudget() {
    if (this._budget === undefined) {
      let n = 0;
      for (let g = 1; g <= 26; g++) n += this.mapCount(g) || 0;
      this._budget = Math.max(400, n + 32);
    }
    return this._budget;
  }

  _eventsAt(attr) {
    const spec = this.e.mapAttr;
    if (spec.events !== null && spec.events !== undefined) {
      return this._word(attr.bank, attr.addr + spec.events);
    }
    const bank = this.gb.romByte(attr.bank, attr.addr + spec.scriptsBank);
    let at = this._word(attr.bank, attr.addr + spec.scriptsBank + 1);
    for (const size of spec.eventSkip || []) {
      at += 1 + this.gb.romByte(bank, at) * size;
    }
    return at;
  }

  _word(bank, addr) {
    return this.gb.romByte(bank, addr) | (this.gb.romByte(bank, addr + 1) << 8);
  }

  /**
   * How many maps a group has, or null where the cartridge will not say.
   *
   * **A map number the ROM does not have used to read as nonsense**, and this
   * file said so in a comment and shrugged: an empty neighbour list was the
   * honest answer while the only things asking were the graph's own exits, all
   * of which exist. Then `objectsOn` started being asked about whatever a warp
   * pointed at, and a sweep looking for the Gyms asked about *ranges* -- which
   * returned Violet's Gym under six different group numbers and put an object
   * at (141,72) on a map twenty tiles wide.
   *
   * `MapGroupPointers` carries no count, so the bound is the next group's
   * pointer: the lists sit one after another, and measured on Crystal the
   * twenty-six pointers ascend by 126, 63, 819, 81 ... 135 bytes, every one an
   * exact multiple of the nine-byte header.
   *
   * **Null wherever that reasoning does not hold, and permissive on null.** The
   * last group has nothing after it; a hack that padded between its lists would
   * give a step that is not a multiple of nine. Refusing a map that exists is
   * worse than reading one that does not -- the first breaks a cartridge this
   * app should support, and the second is caught by the coordinate check in
   * `objectsOn`, which is why both exist.
   */
  mapCount(group) {
    if (group < 1) return 0;
    if (this._counts === undefined) this._counts = new Map();
    if (this._counts.has(group)) return this._counts.get(group);
    let count = null;
    try {
      const at = (g) => this._word(this.groups.bank, this.groups.addr + (g - 1) * 2);
      const step = at(group + 1) - at(group);
      // `>= 0` rather than `> 0`, and the difference is a whole group: a step
      // of exactly nought is a group with no maps in it, and refusing every
      // number in one is right where staying permissive is not. Found by
      // `tools/mutate` surviving the change, which is the tool answering a
      // question sharper than the one it was asked.
      if (step >= 0 && step % this.h.bytes === 0) count = step / this.h.bytes;
    } catch (e) { /* unreadable is the same answer as unbounded */ }
    this._counts.set(group, count);
    return count;
  }

  /** Is this a map the cartridge says it has? Permissive where it will not say. */
  hasMap(group, number) {
    if (group < 1 || number < 1) return false;
    const count = this.mapCount(group);
    return count === null || number <= count;
  }

  /** Where a map's attributes live, via its group's table of map headers. */
  _attributes(group, number) {
    if (!this.hasMap(group, number)) {
      throw new Error(`no map ${group}.${number} on this cartridge`);
    }
    const list = this._word(this.groups.bank, this.groups.addr + (group - 1) * 2);
    const header = list + (number - 1) * this.h.bytes;
    return {
      // Null in the header means the cartridge keeps every attributes block
      // in one bank and does not repeat it per map -- found once, below.
      bank: this.h.attrBank === null ? this._attrBank()
        : this.gb.romByte(this.groups.bank, header + this.h.attrBank),
      addr: this._word(this.groups.bank, header + this.h.attrAddr),
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
      const mask = this.gb.romByte(attr.bank, attr.addr + this.e.mapAttr.connections);
      let at = attr.addr + this.e.mapAttr.structs;
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
      const bank = this.gb.romByte(attr.bank, attr.addr + this.e.mapAttr.scriptsBank);
      const events = this._eventsAt(attr);
      const count = this.gb.romByte(bank, events + this.e.mapAttr.warpCount);
      // Over the cap is a bad read, and an empty list is the honest answer to
      // one -- see MAX_OBJECTS.
      if (count > MAX_WARPS) throw new Error(`${count} warps is not a map`);
      for (let i = 0; i < count; i++) {
        const at = events + this.e.mapAttr.warps
          + i * this.e.mapEvents.warpBytes;
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
      const header = list + (number - 1) * this.h.bytes;
      return this.gb.romByte(this.groups.bank, header + this.h.landmark);
    } catch (e) {
      return null;
    }
  }

  /**
   * What the ROM places on a map: `[{ sprite, x, y, type }]`.
   *
   * `type` is the object's kind -- `engine.objectTypes` names them, and the
   * one that matters is that a person you *talk to* is a script and a person
   * who *sees you* is a trainer. A gym leader is the first, every trainer in
   * the room with them is the second, and nothing else in the ROM tells them
   * apart.
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
      const size = this.sizeOf(group, number);
      const bank = this.gb.romByte(attr.bank, attr.addr + this.e.mapAttr.scriptsBank);
      const events = this._eventsAt(attr);
      const rd = (i) => this.gb.romByte(bank, (events + i) & 0xffff);
      const ev = this.e.mapEvents, field = ev.object;
      let at = this.e.mapAttr.warpCount;
      at += 1 + rd(at) * ev.warpBytes;            // warps
      at += 1 + rd(at) * ev.coordBytes;           // coord events
      at += 1 + rd(at) * ev.bgBytes;              // bg events
      const count = rd(at++);
      if (count > MAX_OBJECTS) throw new Error(`${count} objects is not a map`);
      for (let i = 0; i < count; i++) {
        const o = at + i * ev.objectBytes;
        const x = rd(o + field.x) - field.origin;
        const y = rd(o + field.y) - field.origin;
        // **A tile off the map is not a tile**, which is the same rule
        // `placedObjects` follows over work RAM and for the same reason: a read
        // that has walked off the end of something gives plausible numbers, and
        // an empty list makes a caller do nothing where a list of wrong tiles
        // makes it do something wrong. This is what caught the sweep looking
        // for the Gyms -- an object at (141,72) on a map twenty tiles wide.
        if (size && (x < 0 || y < 0 || x >= size[0] || y >= size[1])) continue;
        out.push({ sprite: rd(o + field.sprite), x, y,
                   type: rd(o + field.type) & ev.typeMask,
                   // Where the object's script lives, so a caller with the
                   // symbol table can *name* it. Two more reads out of a
                   // record already in hand, and the difference between "an
                   // object stands here" and "this is
                   // `VioletGymFalknerScript`".
                   script: { bank, addr: rd(o + field.script)
                                         | rd(o + field.script + 1) << 8 } });
      }
    } catch (e) {
      // Same as the other readers here: nonsense reads mean nothing placed,
      // not a crash.
    }
    this.objectCache.set(id, out);
    return out;
  }

  /**
   * The tiles on a map that run a script when stepped on.
   *
   * **The thing that had been turning the pilot back for four passes, readable
   * at last.** Route 32 has two: scene 0 at (18,8) and scene 1 at (7,71). The
   * first is `Route32CooltrainerMStopsYouScene` -- a man who pushes the player
   * back north -- and until this reader existed the pilot could only find it by
   * walking into it, twice, and writing the road off.
   *
   * `scene` is which of the map's scenes the trigger belongs to. A map's scene
   * advances as its story does, so a trigger is live only while its scene is
   * current: Route 32's two are 0 and 1, and the one at the top stops firing
   * once the map has moved on. This reader reports them all and does not guess
   * which is live, because the scene lives in work RAM and this is the ROM.
   */
  coordEventsOn(group, number) {
    const id = mapKey(group, number);
    if (this.coordCache === undefined) this.coordCache = new Map();
    if (this.coordCache.has(id)) return this.coordCache.get(id);
    const out = [];
    try {
      const attr = this._attributes(group, number);
      const size = this.sizeOf(group, number);
      const bank = this.gb.romByte(attr.bank, attr.addr + this.e.mapAttr.scriptsBank);
      const events = this._eventsAt(attr);
      const rd = (i) => this.gb.romByte(bank, (events + i) & 0xffff);
      const ev = this.e.mapEvents, field = ev.coord;
      let at = this.e.mapAttr.warpCount;
      at += 1 + rd(at) * ev.warpBytes;            // past the warps
      const count = rd(at++);
      if (count > MAX_COORD_EVENTS) {
        throw new Error(`${count} coord events is not a map`);
      }
      for (let i = 0; i < count; i++) {
        const c = at + i * ev.coordBytes;
        const x = rd(c + field.x), y = rd(c + field.y);
        // The same rule the objects follow: a tile off the map is not a tile.
        if (size && (x >= size[0] || y >= size[1])) continue;
        out.push({ scene: rd(c + field.scene), x, y });
      }
    } catch (e) {
      // Nonsense reads mean no triggers, not a crash -- as everywhere here.
    }
    this.coordCache.set(id, out);
    return out;
  }

  /**
   * How big a map is, in tiles, without standing on it: `[w, h]` or null.
   *
   * `collision.mapSize()` answers the same question off work RAM, which means
   * only about the map that is loaded. This is the ROM's copy, so it can be
   * asked about a room the pilot has not walked into -- and it is what lets
   * `objectsOn` tell a real object list from a read that walked off the end of
   * a group.
   */
  sizeOf(group, number) {
    try {
      const attr = this._attributes(group, number);
      const h = this.gb.romByte(attr.bank, attr.addr + this.e.mapAttr.height);
      const w = this.gb.romByte(attr.bank, attr.addr + this.e.mapAttr.width);
      if (!w || !h) return null;
      return [w * TILES_PER_BLOCK, h * TILES_PER_BLOCK];
    } catch (e) {
      return null;
    }
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
  route(from, to, { maxMaps = null, avoid = null } = {}) {
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
  routesFrom(from, targets, { maxMaps = null, avoid = null } = {}) {
    const want = new Set([...targets].filter((k) => k !== from));
    const found = new Map();
    if (!want.size) return found;
    // **After the early return, not as a default argument.** Counting the
    // cartridge's maps reads the ROM, and "where am I" asks this for a
    // target it already has -- a hundred and four reads to answer nothing.
    const budget = maxMaps === null ? this.mapBudget() : maxMaps;
    const seen = new Set([from]);
    const queue = [[from, []]];
    let head = 0;
    while (head < queue.length && seen.size < budget && found.size < want.size) {
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
