// The live collision map, so movement can be planned instead of guessed.
//
// Ported from the desktop pilot, and the reasoning ports with it. Gen 2 keeps
// the loaded map's blocks in wOverworldMapBlocks and each tileset's
// per-quadrant collision values in ROM at wTilesetCollisionAddress. Together
// they give the collision byte for any tile on the current map, which turns
// walking somewhere from trial and error into a breadth-first search.
//
// The indexing comes from GetBlockLocation in home/map.asm, and is then
// *verified against the game itself*: wPlayerTileCollision is the collision of
// the tile the player is standing on, so the decode can check its own answer
// rather than being trusted. Getting this wrong does not throw -- it silently
// paths through walls -- so the check is the whole point.
//
// Two things the browser has to do differently from the desktop version. The
// permission table is read out of the cartridge rather than parsed from the
// disassembly, because a phone has the ROM and the .sym and nothing else. And
// every read comes from one work-RAM snapshot taken per plan, since crossing
// into the emulator per byte would make a search of a few hundred tiles slow
// enough to feel broken.
import { GameBoy } from '../gbcore/gb.js';
import { gen2, kindsOf } from './engine.js';

const b = GameBoy.byteAt;

// What the permission table's answers *mean* is `engine.permissions` -- a
// wall is $0f on Crystal and 2 on Polished Crystal.
// High-nybble groups from constants/collision_constants.asm.
const WARP_LO = 0x70, WARP_HI = 0x7f;
const LEDGE_LO = 0xa0, LEDGE_HI = 0xbf;

// Most warps fire the moment you step on them. Warp *carpets* do not: they are
// the directional ones in CheckDirectionalWarp, and you have to press the way
// the carpet points. Standing on one and pressing anything else simply walks
// you off it -- which is what made the front door of the house look like a wall
// that could be reached but never opened.
const WARP_PUSH = { 0x70: 'DOWN', 0x76: 'LEFT', 0x78: 'UP', 0x7e: 'RIGHT' };

// A ledge can be stood on; it is *leaving* it in the hop direction that jumps
// two tiles and cannot be undone. Index is `collision & 7`, from .ledge_table
// in engine/overworld/player_movement.asm.
const LEDGE_HOPS = {
  0: ['RIGHT'], 1: ['LEFT'], 2: ['UP'], 3: ['DOWN'],
  4: ['DOWN', 'RIGHT'], 5: ['DOWN', 'LEFT'],
  6: ['UP', 'RIGHT'], 7: ['UP', 'LEFT'],
};

const DIRS = ['UP', 'DOWN', 'LEFT', 'RIGHT'];
export const DELTA = {
  UP: [0, -1], DOWN: [0, 1], LEFT: [-1, 0], RIGHT: [1, 0],
};

// The offsets the desktop version tries when the derived one does not
// reproduce the game's own answer. (4, 4) is the one the map layout implies.
//
// wMapObjects: sixteen 16-byte entries, coordinates offset by four. Every
// offset here is cross-checked against the cartridge's own symbol file, which
// names each field of the struct -- wMap1ObjectSprite is one past wMap1Object,
// wMap1ObjectType is eight past it, and wMap2Object is sixteen past. They are
// written out rather than looked up because a .sym need only carry the labels
// the app asks for by name, and this is layout: the same numbers for every
// cartridge built from the same engine.
// The strides and field offsets of both object arrays are
// `engine.mapObjects` and `engine.objectStructs` -- Polished Crystal's are
// 14 and 34 bytes where Crystal's are 16 and 40.

// wObjectStructs: thirteen 40-byte structs, the player's first, one per object
// the game has actually *spawned*. Same +4 origin, and the proof is the player:
// struct 0's MapX/MapY minus four is exactly wXCoord/wYCoord, measured on
// Route 30 with the player at (2,27) and the struct reading (6,31).
//
// `PLACED` is the link back to wMapObjects -- wObject1MapObjectIndex -- and it
// is what makes the two arrays answerable together: the struct says where
// something *is*, and the entry it points at says what it *is*.


const CANDIDATE_OFFSETS = [[4, 4], [0, 0], [4, 0], [0, 4], [2, 2], [6, 6], [5, 5], [3, 3]];

// The name a cartridge gives the collision table it unpacked into work RAM.
// Its *bank* comes from the symbol file, so this is a name and not an
// address -- see the constructor.
const UNPACKED_COLLISION = 'wDecompressedCollisions';

export class CollisionMap {
  constructor(symbols, gb, engine = null) {
    this.gb = gb;
    this.e = engine || gen2;
    this.a = {
      blocks: symbols.addr('wOverworldMapBlocks'),
      mapWidth: symbols.addr('wMapWidth'),
      mapHeight: symbols.addr('wMapHeight'),
      // Crystal gives the collision data its own bank byte; Polished
      // Crystal's tileset struct has one `wTilesetDataBank` in front of the
      // blocks, the collision and the attributes together.
      tilesetBank: symbols.pick('wTilesetCollisionBank', 'wTilesetDataBank'),
      tilesetAddr: symbols.addr('wTilesetCollisionAddress'),
      playerTile: symbols.addr('wPlayerTileCollision'),
      x: symbols.addr('wXCoord'),
      y: symbols.addr('wYCoord'),
      objects: symbols.has('wMapObjects') ? symbols.addr('wMapObjects') : null,
      // Optional for the same reason `objects` is: a cartridge whose symbol
      // file does not name it still walks, on the placement array alone.
      structs: symbols.has('wObjectStructs')
        ? symbols.addr('wObjectStructs') : null,
    };
    // **Where the tileset's collision table actually is.** Crystal keeps it
    // in the ROM and points at it with `wTilesetCollisionAddress`, so that
    // pointer is the answer. Polished Crystal LZ-compresses the same table
    // -- `lab_collision.bin.lzp`, 79 bytes for 248 -- and unpacks it at map
    // load into `wDecompressedCollisions`, a work-RAM bank it does not keep
    // mapped. Following its ROM pointer reads the compressed bytes, and the
    // walkable grid came out an alternating checkerboard.
    //
    // **Derived, not declared**: a cartridge that names the buffer has one,
    // and one that does not is reading from the ROM. Nothing in a profile
    // says which, and the bank is the symbol file's rather than a number
    // that is true of one release.
    this.unpacked = symbols.has(UNPACKED_COLLISION)
      ? { bank: symbols.bank(UNPACKED_COLLISION),
          addr: symbols.addr(UNPACKED_COLLISION) }
      : null;
    this.unpackedBytes = null;
    this.permTable = symbols.addr('CollisionPermissionTable');
    this.permBank = symbols.bank('CollisionPermissionTable');
    this.off = [4, 4];
    this.calibrated = false;
    this.wram = null;
  }

  /** Point the decode at a work-RAM snapshot. Everything below reads from it. */
  use(wram) { this.wram = wram; return this; }

  /** Where the player is, read from the same snapshot as the map. */
  playerPos(wram = this.wram) {
    return [b(wram, this.a.x), b(wram, this.a.y)];
  }

  // --- raw reads -------------------------------------------------------------
  get stride() { return b(this.wram, this.a.mapWidth) + 6; }

  mapSize() {
    return [b(this.wram, this.a.mapWidth) * 2, b(this.wram, this.a.mapHeight) * 2];
  }

  blockAt(tx, ty, off = this.off) {
    const xo = tx + off[0], yo = ty + off[1];
    const idx = 1 + this.stride * (1 + (yo >> 1)) + (xo >> 1);
    return b(this.wram, this.a.blocks + idx);
  }

  collisionAt(tx, ty, off = this.off) {
    const block = this.blockAt(tx, ty, off);
    const quadrant = ((ty + off[1]) & 1) * 2 + ((tx + off[0]) & 1);
    const at = block * 4 + quadrant;
    // The unpacked table when this cartridge has one, and it is indexed from
    // its own start rather than through the ROM pointer -- the pointer names
    // where the *compressed* copy is.
    if (this.unpackedBytes) return this.unpackedBytes[at] ?? 0;
    const bank = b(this.wram, this.a.tilesetBank);
    const addr = GameBoy.wordLeAt(this.wram, this.a.tilesetAddr);
    return this.gb.romByte(bank, (addr + block * 4 + quadrant) & 0xffff);
  }

  /** CollisionPermissionTable: collision value -> permission byte. */
  permission(coll) {
    return this.gb.romByte(this.permBank,
                           (this.permTable + (coll & 0xff)) & 0xffff) & 0x0f;
  }

  /**
   * What the map *placed* here: `[{ index, sprite, type, x, y }]`.
   *
   * wMapObjects is the map's own object list, read once for the three readers
   * below. It is the map's plan rather than the game's present tense, and both
   * halves of that matter:
   *
   *   - The coordinates never move. Measured on Route 30: the player's own
   *     entry reads (7,53), the tile the map put them on, while they stand at
   *     (2,27); and the wanderer placed at (7,30) was live at (8,30). So these
   *     are *placements*, for everyone, not just for index 0.
   *   - An object hidden by its event flag is still an entry. Route 30 carries
   *     a trainer at (2,28) that a new game has never seen, because the flag
   *     that reveals it is unset.
   *
   * Which makes it the right answer for a thing that cannot move and the wrong
   * one for a person -- see `takeables` and `occupied`, which is the whole
   * reason this is one walk with three callers rather than three walks.
   *
   * Index 0 is the player. It is kept here, because the index is what a struct
   * points back at, and dropped by each caller that would be confused by it.
   *
   * Tiles outside the map are dropped. Index 0 cannot be used to check the
   * origin -- it holds a placement, not a position -- so the bounds of the map
   * are the only check available, and that is also the right way to fail: on a
   * cartridge that stored objects at a different origin an empty list means
   * the planner walks into people and recovers, where a list of in-bounds but
   * *wrong* tiles can seal a one-tile corridor.
   */
  placedObjects(wram = this.wram) {
    const out = [];
    if (this.a.objects === null) return out;
    const w = b(wram, this.a.mapWidth) * 2, h = b(wram, this.a.mapHeight) * 2;
    const mo = this.e.mapObjects;
    for (let i = 0; i < mo.count; i++) {
      const at = this.a.objects + i * mo.bytes;
      const sprite = b(wram, at + mo.sprite);
      if (!sprite) continue;
      const x = b(wram, at + mo.x) - mo.origin;
      const y = b(wram, at + mo.y) - mo.origin;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      out.push({ index: i, sprite, type: b(wram, at + mo.type) & 0x0f,
                 x, y });
    }
    return out;
  }

  /**
   * What is actually on the map right now: `[{ index, sprite, type, x, y }]`.
   *
   * wObjectStructs, one entry per object the game has spawned, joined back to
   * its placement for the `type` byte. Two things are true of it that are not
   * true of the placement array, and they are the two things that were wrong
   * with reading only the placements:
   *
   *   - The coordinates are live. A wanderer reads where it is standing.
   *   - An object the game has not spawned is simply absent -- whether because
   *     its event flag hides it or because it is too far away to matter.
   *
   * Thirteen structs against sixteen placements, so being off the list is
   * ordinary rather than exceptional: Route 30 places twelve objects and spawns
   * five of them.
   *
   * Index 0 is the player's struct and is skipped: the tile the player is
   * standing on is not an obstacle to the player.
   *
   * Returns null, not an empty list, when the symbol file does not name the
   * array -- the callers need "cannot tell" apart from "nothing there", because
   * one of them falls back to the placements and the other must not claim a map
   * has no trainers when it has not looked.
   */
  liveObjects(wram = this.wram) {
    if (this.a.structs === null || this.a.objects === null) return null;
    const out = [];
    const w = b(wram, this.a.mapWidth) * 2, h = b(wram, this.a.mapHeight) * 2;
    const mo = this.e.mapObjects, st = this.e.objectStructs;
    for (let i = 1; i < st.count; i++) {
      const at = this.a.structs + i * st.bytes;
      const sprite = b(wram, at + st.sprite);
      if (!sprite) continue;
      const index = b(wram, at + st.placed);
      const x = b(wram, at + st.x) - mo.origin;
      const y = b(wram, at + st.y) - mo.origin;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      // The type comes from the placement it points at, because a struct does
      // not carry one. A struct pointing outside the array is not trusted for
      // its type and is still trusted for its tile: something is standing
      // there whatever it turns out to be.
      const type = index < mo.count
        ? b(wram, this.a.objects + index * mo.bytes + mo.type)
          & 0x0f
        : null;
      out.push({ index, sprite, type, x, y });
    }
    return out;
  }

  /**
   * Tiles that people and props are standing on.
   *
   * The collision map is terrain only, so an NPC reads as open floor and the
   * planner walks into them. That is not a theoretical problem: Route 30 opens
   * with a Youngster and two Rattata sprites filling the one-tile corridor
   * north, and every plan routed straight through them.
   *
   * Read from the *live* structs, and that is a correction rather than a
   * refinement. On the placements this was wrong in both directions at once,
   * measured on one screen of Route 30: it marked (7,30), which nobody was
   * standing on, and left (8,30) open, where the wanderer actually was; and it
   * marked (2,28) and (1,7) for two objects a new game has never spawned. Both
   * mistakes cost the same thing, because `avoid` can seal a corridor -- see
   * `nav.walkTo`, whose second attempt drops this whole set for exactly that
   * reason, and in dropping it gives up the entries that were right along with
   * the ones that were not.
   *
   * Falls back to the placements where the structs cannot be read at all. That
   * is the old behaviour, kept deliberately: stale tiles beat no tiles, because
   * walking into somebody costs a refused step and the fallback in `walkTo`
   * recovers from a sealed corridor.
   */
  occupied(wram = this.wram) {
    const taken = new Set();
    const live = this.liveObjects(wram);
    const from = live || this.placedObjects(wram).filter((o) => o.index !== 0);
    for (const o of from) taken.add(o.x + ',' + o.y);
    return taken;
  }

  /**
   * Things on this map you can take something from: `[{ x, y, what }]`.
   *
   * Read from the *placements*, and unlike `occupied` that is the right array
   * rather than the old one: a ball and a tree do not move, and the game only
   * spawns what is near enough to draw. Measured on Route 30 with the player at
   * the north end, the ball at (8,35) and both fruit trees had no live struct
   * at all -- so reading the structs here would have made Take see only what
   * you were already standing next to.
   *
   * Two ways of recognising one, and they agreed on every object of Route 30:
   * the sprite ids the engine profile carries, and the game's own type byte.
   * The type is the better test where a cartridge has one -- it is what the
   * engine itself branches on when you press A -- and it only knows about
   * balls, so the sprite table is what finds a fruit tree. A ball is therefore
   * found either way and a tree only by its sprite.
   *
   * **A ball that has already been taken is still in this list**, and that is
   * measured rather than assumed: taking the ANTIDOTE at (8,35) on Route 30
   * left its object exactly where it was in work RAM. So this answers *what the
   * map placed here*, and the only honest way to find out whether anything is
   * left is to go and press A -- which is why the job that uses it reports what
   * arrived in the bag rather than what it expected to.
   */
  takeables(wram = this.wram) {
    const kinds = new Map((this.e.takeable || []).map((t) => [t.sprite, t.what]));
    // A list, like every other kind -- see `kindsOf`. One number here on both
    // cartridges, and asked the same way so a third with two of them needs no
    // change but its profile.
    const ball = kindsOf(this.e, 'itemball');
    if (!kinds.size && !ball.size) return [];
    const out = [];
    for (const o of this.placedObjects(wram)) {
      if (o.index === 0) continue;
      const what = kinds.get(o.sprite) || (ball.has(o.type) ? 'ball' : null);
      if (!what) continue;
      out.push({ x: o.x, y: o.y, what });
    }
    return out;
  }

  /**
   * The trainers standing on this map: `[{ x, y, sprite }]`.
   *
   * Both arrays at once, because either alone gives a wrong answer. The
   * placement says what an object *is* -- the type byte the game branches on,
   * 2 for a trainer -- and the struct says whether it is here and where. A
   * trainer whose event flag has not fired yet is a placement with no struct,
   * and offering to walk to it is offering to walk to nobody: measured on a new
   * save, Route 30 places three trainers and has spawned exactly none of them,
   * one hidden by its flag and two too far north to be loaded.
   *
   * Which is why this returns an empty list rather than falling back to the
   * placements the way `occupied` does. The fallback there is a hint that can
   * be wrong at the cost of a re-plan; here it would be an offer to fight
   * somebody who is not there.
   */
  trainers(wram = this.wram) {
    const want = kindsOf(this.e, 'trainer');
    if (!want.size) return [];
    const live = this.liveObjects(wram);
    if (!live) return [];
    return live.filter((o) => want.has(o.type))
      .map((o) => ({ x: o.x, y: o.y, sprite: o.sprite }));
  }

  // --- calibration -----------------------------------------------------------
  /**
   * Confirm the decode by reproducing wPlayerTileCollision.
   *
   * If the derived offset does not match the game's own value, try the others
   * rather than pathfinding against garbage.
   */
  async calibrate(wram) {
    this.use(wram);
    // Re-read every time rather than once: the table is per *tileset*, and
    // the tileset changes with the map. 4KB off the core's own memory.
    if (this.unpacked) {
      this.unpackedBytes = await this.gb.readWramBank(this.unpacked.bank);
    }
    const px = b(wram, this.a.x), py = b(wram, this.a.y);
    const truth = b(wram, this.a.playerTile);
    for (const off of CANDIDATE_OFFSETS) {
      try {
        if (this.collisionAt(px, py, off) === truth) {
          this.off = off;
          this.calibrated = true;
          return true;
        }
      } catch (e) { /* a bad offset can read out of the snapshot; try the next */ }
    }
    this.calibrated = false;
    return false;
  }


  // --- classification --------------------------------------------------------
  isWall(coll) { return this.permission(coll) === this.e.permissions.wall; }
  isWater(coll) { return this.permission(coll) === this.e.permissions.water; }
  static isLedge(coll) { return coll >= LEDGE_LO && coll <= LEDGE_HI; }
  static isWarp(coll) { return coll >= WARP_LO && coll <= WARP_HI; }

  /** The direction a warp carpet has to be pressed, or null if it just fires. */
  static pushFor(coll) { return WARP_PUSH[coll] || null; }

  /** Directions that would hop a ledge from this tile (empty if none). */
  hopDirs(tx, ty) {
    const coll = this.collisionAt(tx, ty);
    if (!CollisionMap.isLedge(coll)) return [];
    return LEDGE_HOPS[coll & 7] || [];
  }

  /**
   * Can the player stand on this tile?
   *
   * Ledge tiles are standable -- what is one-way is hopping *off* one, which
   * the search handles by refusing that move rather than refusing the tile.
   * Excluding ledges outright made whole sections of routes look unreachable.
   */
  walkable(tx, ty, { allowWarp = false, allowLedge = true } = {}) {
    const [w, h] = this.mapSize();
    if (tx < 0 || ty < 0 || tx >= w || ty >= h) return false;
    const coll = this.collisionAt(tx, ty);
    if (this.isWall(coll) || this.isWater(coll)) return false;
    if (CollisionMap.isLedge(coll) && !allowLedge) return false;
    if (CollisionMap.isWarp(coll) && !allowWarp) return false;
    return true;
  }

  /**
   * The reachable tile that lies furthest in a direction.
   *
   * Walking straight at the edge of a route does not work: Route 30 is
   * fifty-four tiles top to bottom, winding, and fenced with ledges, so the
   * opening at the far end is not reachable in one plan from the near end. But
   * *something* further along always is, so the crossing advances to the best
   * tile it can actually reach and asks again from there.
   */
  furthestToward(start, direction, { maxNodes = 20000 } = {}) {
    const better = {
      UP: (a, b) => a[1] < b[1], DOWN: (a, b) => a[1] > b[1],
      LEFT: (a, b) => a[0] < b[0], RIGHT: (a, b) => a[0] > b[0],
    }[direction];
    if (!better) return null;

    const key = (p) => p[0] + ',' + p[1];
    const seen = new Set([key(start)]);
    const queue = [start];
    let head = 0, nodes = 0, best = start;
    while (head < queue.length && nodes < maxNodes) {
      const pos = queue[head++];
      nodes++;
      if (better(pos, best)) best = pos;
      const hops = this.hopDirs(pos[0], pos[1]);
      for (const d of DIRS) {
        if (hops.includes(d)) continue;
        const next = [pos[0] + DELTA[d][0], pos[1] + DELTA[d][1]];
        const k = key(next);
        if (seen.has(k)) continue;
        if (!this.walkable(next[0], next[1])) continue;
        seen.add(k);
        queue.push(next);
      }
    }
    return best;
  }

  // --- pathfinding -----------------------------------------------------------
  /**
   * Breadth-first path as a list of directions, or null if there is no way.
   *
   * Paths never include a ledge hop: it moves two tiles and cannot be
   * reversed, so a route that used one could not be walked back.
   */
  pathTo(start, goal, { maxNodes = 20000, allowWarpGoal = true, avoid = null } = {}) {
    const key = (p) => p[0] + ',' + p[1];
    const isGoal = (p) => p[0] === goal[0] && p[1] === goal[1];
    if (isGoal(start)) return [];

    const seen = new Set([key(start)]);
    const queue = [[start, []]];
    let head = 0, nodes = 0;
    while (head < queue.length && nodes < maxNodes) {
      const [pos, path] = queue[head++];
      nodes++;
      const hops = this.hopDirs(pos[0], pos[1]);
      for (const d of DIRS) {
        if (hops.includes(d)) continue;
        const next = [pos[0] + DELTA[d][0], pos[1] + DELTA[d][1]];
        const k = key(next);
        if (seen.has(k)) continue;
        const goalHere = isGoal(next);
        // A tile that refused a step: the collision map knows the terrain but
        // not that someone is standing on it.
        if (avoid && avoid.has(k) && !goalHere) continue;
        if (!this.walkable(next[0], next[1],
                           { allowWarp: goalHere && allowWarpGoal })) continue;
        seen.add(k);
        if (goalHere) return path.concat(d);
        queue.push([next, path.concat(d)]);
      }
    }
    return null;
  }
}
