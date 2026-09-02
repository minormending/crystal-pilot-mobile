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
import { GameBoy } from './gb.js';

const b = GameBoy.byteAt;

// data/collision/collision_permissions.asm, via CollisionPermissionTable.
const LAND = 0x00, WATER = 0x01, WALL = 0x0f;
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

export const DIRS = ['UP', 'DOWN', 'LEFT', 'RIGHT'];
export const DELTA = {
  UP: [0, -1], DOWN: [0, 1], LEFT: [-1, 0], RIGHT: [1, 0],
};

// The offsets the desktop version tries when the derived one does not
// reproduce the game's own answer. (4, 4) is the one the map layout implies.
// wMapObjects: sixteen 16-byte entries, coordinates offset by four.
const MAP_OBJECT_COUNT = 16, MAP_OBJECT_BYTES = 0x10;
const MAP_OBJECT_SPRITE = 1, MAP_OBJECT_Y = 2, MAP_OBJECT_X = 3;
const MAP_OBJECT_ORIGIN = 4;

const CANDIDATE_OFFSETS = [[4, 4], [0, 0], [4, 0], [0, 4], [2, 2], [6, 6], [5, 5], [3, 3]];

export class CollisionMap {
  constructor(symbols, gb) {
    this.gb = gb;
    this.a = {
      blocks: symbols.addr('wOverworldMapBlocks'),
      mapWidth: symbols.addr('wMapWidth'),
      mapHeight: symbols.addr('wMapHeight'),
      tilesetBank: symbols.addr('wTilesetCollisionBank'),
      tilesetAddr: symbols.addr('wTilesetCollisionAddress'),
      playerTile: symbols.addr('wPlayerTileCollision'),
      x: symbols.addr('wXCoord'),
      y: symbols.addr('wYCoord'),
      objects: symbols.has('wMapObjects') ? symbols.addr('wMapObjects') : null,
    };
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
   * Tiles that people and props are standing on.
   *
   * The collision map is terrain only, so an NPC reads as open floor and the
   * planner walks into them. That is not a theoretical problem: Route 30 opens
   * with Youngster Joey and two Rattata sprites filling the one-tile corridor
   * north, and every plan routed straight through them.
   *
   * The list is what the map placed, not what is on screen -- an object whose
   * event flag has hidden it is still an entry -- so these are treated as tiles
   * to prefer avoiding rather than walls, and the caller drops them if that is
   * the only way through. Index 0 is the player and is skipped. Coordinates are
   * stored four higher than the map's own, which is checked against the player.
   */
  occupied(wram = this.wram) {
    const taken = new Set();
    if (this.a.objects === null) return taken;
    for (let i = 1; i < MAP_OBJECT_COUNT; i++) {
      const at = this.a.objects + i * MAP_OBJECT_BYTES;
      if (!b(wram, at + MAP_OBJECT_SPRITE)) continue;
      taken.add((b(wram, at + MAP_OBJECT_X) - MAP_OBJECT_ORIGIN) + ',' +
                (b(wram, at + MAP_OBJECT_Y) - MAP_OBJECT_ORIGIN));
    }
    return taken;
  }

  // --- calibration -----------------------------------------------------------
  /**
   * Confirm the decode by reproducing wPlayerTileCollision.
   *
   * If the derived offset does not match the game's own value, try the others
   * rather than pathfinding against garbage.
   */
  calibrate(wram) {
    this.use(wram);
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

  /** Re-check the decode against the tile the player is standing on now. */
  verify(wram) {
    this.use(wram);
    const px = b(wram, this.a.x), py = b(wram, this.a.y);
    return this.collisionAt(px, py) === b(wram, this.a.playerTile);
  }

  // --- classification --------------------------------------------------------
  isWall(coll) { return this.permission(coll) === WALL; }
  isWater(coll) { return this.permission(coll) === WATER; }
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
