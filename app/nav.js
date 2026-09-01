// Walking, one verified tile at a time.
//
// The desktop pilot's lesson ports directly: a step is not "press the button
// for N frames", it is "hold the button until the coordinate actually changes,
// then stop". Fixed-length presses go wrong in both directions -- too short and
// the press is spent turning, too long and you take a second step you did not
// plan for, into grass and into a battle.
//
// Two things had to be learned again here, because they showed up as a walk
// that ended somewhere plausible but wrong:
//
//   * The coordinates change when the game *commits* to a step, not when the
//     step finishes. Returning at that moment reports a tile the player has not
//     reached, and the next press lands mid-stride, where the game is still
//     holding the previous direction -- so each step performed the one before
//     it. Every step now waits for the player to come to rest.
//
//   * A path is a plan, and plans go stale. Following one blindly means a
//     single missed step puts every later step in the wrong place while the
//     walk still reports success. So the route is re-planned from where the
//     player actually is, every step, exactly as the desktop version does.
//
// Reads are deliberately tiny. A step polls the coordinates every couple of
// frames, and pulling a whole 8 KB snapshot that often would cost far more than
// the emulation it is watching.
import { CollisionMap, DELTA } from './collision.js';

export class Nav {
  constructor(gb, symbols) {
    this.gb = gb;
    this.a = {
      y: symbols.addr('wYCoord'),      // wXCoord is the byte after it
      battleMode: symbols.addr('wBattleMode'),
      mapGroup: symbols.addr('wMapGroup'),
      mapNumber: symbols.addr('wMapNumber'),
      offX: symbols.addr('wPlayerBGMapOffsetX'),
      offY: symbols.addr('wPlayerBGMapOffsetY'),
    };
  }

  /** [x, y], from the two adjacent coordinate bytes. */
  async pos() {
    const p = await this.gb.readBytes(this.a.y, 2);
    return [p[1], p[0]];
  }

  async inBattle() {
    return (await this.gb.readBytes(this.a.battleMode, 1))[0] !== 0;
  }

  /** Which map we are on, as one comparable value. */
  async mapKey() {
    const m = await this.gb.readBytes(this.a.mapGroup, 2);
    return m[0] * 256 + m[1];
  }

  /**
   * Wait out a warp, and report the map it lands on.
   *
   * A door, staircase, cave or warp panel fires the moment you step on it, but
   * the transition runs for a few frames after that -- so arriving on the tile
   * is not arriving on the new map, and reading the position straight away
   * names a tile on the map you have just left.
   */
  async awaitMapChange(from, timeout = 240) {
    for (let i = 0; i < timeout; i += 2) {
      await this.gb.run(2);
      const key = await this.mapKey();
      if (key !== from && key !== 0) {
        await this.gb.run(30);      // let the new map settle before reading
        return key;
      }
    }
    return null;
  }

  /**
   * Run frames until the player really has stopped, and report where.
   *
   * The coordinate is not enough on its own. It changes at the *end* of a
   * step, while the camera is still finishing its slide -- measured, settling
   * on the coordinate alone returned with the camera six pixels short of its
   * resting place. Anything that reads the screen at that moment, or works out
   * which tile a tap meant, is reading a world that is still moving.
   */
  async settle(stillFor = 6, timeout = 90) {
    let last = await this.restState();
    let still = 0;
    for (let i = 0; i < timeout; i += 2) {
      await this.gb.run(2);
      const now = await this.restState();
      if (now.join() === last.join()) {
        still += 2;
        if (still >= stillFor) return [now[0], now[1]];
      } else {
        still = 0;
        last = now;
      }
    }
    return [last[0], last[1]];
  }

  /** [x, y, cameraX, cameraY] -- everything that moves while a step plays out. */
  async restState() {
    const p = await this.gb.readBytes(this.a.y, 2);
    const o = await this.gb.readBytes(this.a.offX, 2);
    return [p[1], p[0], o[0], o[1]];
  }

  /**
   * Take one tile step. Yields early on a battle.
   *
   * Returns { moved | blocked | battle } and the settled position. "Blocked" is
   * an answer, not a failure: it is how a plan finds out that something the
   * collision map cannot see -- an NPC -- is standing in the way.
   */
  async step(dir, timeout = 60) {
    const before = await this.pos();
    let moved = false;
    this.gb.hold(dir);
    try {
      for (let i = 0; i < timeout; i++) {
        await this.gb.run(1);
        if (i % 2) continue;
        const now = await this.pos();
        if (now[0] !== before[0] || now[1] !== before[1]) { moved = true; break; }
        if (await this.inBattle()) return { battle: true, pos: now };
      }
    } finally {
      this.gb.release(dir);
    }
    const pos = await this.settle();
    if (await this.inBattle()) return { battle: true, pos };
    return moved ? { moved: true, pos } : { blocked: true, pos };
  }

  /**
   * Walk to a tile, re-planning every step.
   *
   * Returns { stopped, pos } where `stopped` is null on arrival, or one of
   * 'battle' | 'unreachable' | 'refused' | 'decode' | 'cancelled' | 'stuck' |
   * 'warped'.
   *
   * A goal is a tile on one particular map. Step onto a doorway or a staircase
   * and the map changes underneath, at which point those coordinates mean
   * somewhere else entirely -- so that ends the walk rather than carrying the
   * old destination onto the new map.
   */
  async walkTo(collision, goal, { maxSteps = 80, onStep = null,
                                  cancelled = () => false } = {}) {
    const avoid = new Set();
    const startedOn = await this.mapKey();
    let refusals = 0;
    for (let taken = 0; taken < maxSteps; taken++) {
      if (cancelled()) return { stopped: 'cancelled', pos: await this.pos() };
      if (await this.inBattle()) return { stopped: 'battle', pos: await this.pos() };

      const here = await this.mapKey();
      if (here !== startedOn) return { stopped: 'warped', pos: await this.pos() };

      // Re-checked every step rather than once: a warp mid-walk changes the map
      // and the tileset under us, and a decode that no longer matches the
      // game's own answer must stop rather than path through walls.
      //
      // Retried, though, because a miss is not always a wrong decode. Sampling
      // while the map is still loading catches the two halves disagreeing for a
      // few frames, and aborting on that would make the feature flaky for a
      // reason that fixes itself. Three strikes and it really is wrong.
      let wram = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        wram = await this.gb.readWram();
        if (collision.calibrate(wram)) break;
        wram = null;
        await this.gb.run(8);
      }
      if (wram === null) return { stopped: 'decode', pos: await this.pos() };
      const pos = collision.playerPos(wram);
      if (pos[0] === goal[0] && pos[1] === goal[1]) {
        // Standing on a doorway is not the same as having gone through it.
        if (CollisionMap.isWarp(collision.collisionAt(goal[0], goal[1]))) {
          const to = await this.awaitMapChange(startedOn);
          if (to !== null) {
            return { stopped: 'warped', pos: await this.pos(), map: to };
          }
        }
        return { stopped: null, pos };
      }

      const path = collision.pathTo(pos, goal, { avoid });
      if (!path || !path.length) return { stopped: 'unreachable', pos };

      const res = await this.step(path[0]);
      if (res.battle) return { stopped: 'battle', pos: res.pos };
      if (res.blocked) {
        // The collision map said that tile was walkable and the game refused
        // anyway. Once or twice that is someone standing on it, so it goes in
        // the avoid set and the route is planned around them. Every direction
        // refusing means the game is not taking input at all -- a script is
        // running, someone is talking -- and calling that "unreachable" would
        // blame the map for something it got right.
        refusals++;
        if (refusals >= 3) return { stopped: 'refused', pos: res.pos };
        const d = DELTA[path[0]];
        avoid.add((pos[0] + d[0]) + ',' + (pos[1] + d[1]));
        continue;
      }
      refusals = 0;
      if (onStep) onStep(taken + 1, res.pos);
    }
    return { stopped: 'stuck', pos: await this.pos() };
  }
}

export { DELTA };
