// Getting somewhere, on any Gen 2 map.
//
// Walking, crossing, routing, waiting for the game to stop talking, and going
// to heal. None of it knows a single fact about Crystal: the map graph comes out
// of the cartridge (see world.js), the collision map comes out of work RAM, and
// the two things a title alone can answer -- what a map is called, and where
// there is somebody who heals -- are methods here that return the honest
// nothing and are overridden by a title that knows better.
//
// This was the first half of bootstrap.js. The second half is crystal.js, and
// the reason for the split is that a ROM hack of the same base game changes
// almost nothing in this file and almost everything in that one.
//
// Every leg is checked rather than assumed. Each warp says which map it expects
// to land on and stops with a plain description if it lands somewhere else,
// because a walk that quietly drifts off course ends up mashing A at a wall.
import { CollisionMap } from './collision.js';

export class Journey {
  /**
   * `title` is everything about one cartridge that this layer cannot work out.
   *
   * Four fields, and each exists because a method below asked a question only
   * the cartridge can answer:
   *
   *   names       { mapKey: 'Route 29' }        what to call a map
   *   healers     [{ map, reach }]              somewhere a party can be healed
   *   grassyMaps  [mapKey]                      where encounters are, if not here
   *   legCost     tiles                         what a leg beyond the first is worth
   *
   * `reach` names a method on the instance, because *how* to be healed is a
   * procedure -- face a machine, or drive a nurse's menu -- and procedures
   * belong with the title that knows them, while the coordinates they use are
   * data. A title that declares none of this still walks; it just says
   * "map 26.1" and cannot heal, which is the truth about a cartridge nobody has
   * described.
   */
  constructor(gb, state, tasks, collision, nav, say = () => {}, world = null,
              title = {}) {
    this.gb = gb;
    this.state = state;
    this.tasks = tasks;
    this.collision = collision;
    this.nav = nav;
    this.world = world;
    this.say = say;
    this.title = title;
    this.scriptModeAt = state.a.scriptMode;
  }

  async snap() { return this.state.read(await this.gb.readWram()); }

  /**
   * Has the user asked us to stop?
   *
   * The Stop button sets the flag on `tasks`, and nothing in here used to read
   * it -- so pressing Stop during a bootstrap or the errand did nothing at all
   * and you watched it walk to Cherrygrove and back with no way out. Every loop
   * long enough to want interrupting checks this, and every walk is handed it so
   * it stops between steps rather than at the end of the leg.
   */
  get stopped() { return !!(this.tasks && this.tasks.cancelled); }

  /** The option bag every walk in here takes, so Stop reaches inside them. */
  get walkOpts() { return { cancelled: () => this.stopped }; }
  async mapKey() { return this.nav.mapKey(); }

  /**
   * What to call a map.
   *
   * The numbers, because numbers are all this layer has: a map group and a map
   * number are in every cartridge and the names are in none of them. A title
   * that knows its own maps overrides this, and one that does not still gets
   * sentences that name a place rather than saying "there".
   */
  where(k) {
    return (this.title.names && this.title.names[k])
           || `map ${k >> 8}.${k & 0xff}`;
  }

  /**
   * A work-RAM snapshot the map can actually be planned against.
   *
   * Calibration checks the decode against one tile -- the one the player is
   * standing on -- and one tile is not enough to pin an offset down. Step out of
   * a door and the player is still *on* the warp mid-transition: the real offset
   * does not match there, and one of the fallbacks can match by luck, latching a
   * decode that is wrong for the whole rest of the map.
   *
   * That is not a hypothetical. It is what made crossings flaky: crossEdge picks
   * its candidate exits once, from this snapshot, and taken during those few
   * frames the edge it measured was somebody else's map. Every attempt then
   * walked at tiles that had never been openings, and the crossing failed
   * without ever being wrong about anything it could see.
   *
   * So the answer has to hold still: the same offset, for the same player tile,
   * twice in a row, a few frames apart.
   */
  async settled(tries = 8) {
    let last = null;
    for (let i = 0; i < tries; i++) {
      const wram = await this.gb.readWram();
      if (this.collision.calibrate(wram)) {
        const at = this.collision.playerPos(wram);
        const seen = `${this.collision.off}|${at}`;
        if (last === seen) return wram;
        last = seen;
      } else {
        last = null;
      }
      await this.gb.run(16);
    }
    return null;
  }

  /** wScriptMode: 0 when the game is idle, non-zero while a script runs. */
  async scriptRunning() {
    return (await this.gb.readBytes(this.scriptModeAt, 1))[0] !== 0;
  }

  /**
   * Play out whatever the game wants to say, and wait for it to finish.
   *
   * Mom's scene downstairs is the one that sets the budget: it locks you where
   * you stand, walks her over, hands you the Pokegear and asks about daylight
   * saving, and takes about 190 taps to get through. Between its phases there
   * is no textbox at all, so anything that stops when the text clears sets off
   * again while the script still holds the controls.
   *
   * The end is confirmed rather than taken on the first reading, because a
   * script briefly drops to idle between chained segments.
   *
   * An earlier version asked "do I have the player back?" by opening the start
   * menu -- which was self-defeating twice over: opening a menu sets
   * wScriptMode itself, and the A taps that followed went into the menu it had
   * just opened.
   */
  async runScripts(maxTaps = 400, settle = 45) {
    for (let i = 0; i < maxTaps; i++) {
      // Inside the loop, not only on the way in. This is the longest loop in
      // the file by its own account -- Mom's scene is about 190 taps -- and it
      // presses through this.gb rather than through TaskBase.push, so it gets
      // none of the cancellation that every other pressing loop is given for
      // free. Checked once at the top, Stop was ignored for the rest of a scene
      // it was pressed in the middle of, which is the one place it is most
      // likely to be pressed.
      if (this.stopped) return false;
      if (!await this.scriptRunning()) {
        await this.gb.run(settle);
        if (!await this.scriptRunning()) return true;
      }
      await this.gb.press('A', 4, 8);
      await this.tasks.pump();
    }
    return !await this.scriptRunning();
  }

  /**
   * Walk onto a warp tile and come out on the map it should lead to.
   *
   * Retried, because the first attempt often gets interrupted: someone stops
   * you on the way -- Mom does, on the way out of the house -- and the walk
   * ends early with the text still up.
   */
  async through(goal, expect, tries = 8) {
    for (let i = 0; i < tries; i++) {
      if (this.stopped) return false;
      const from = await this.mapKey();
      if (from === expect) return true;
      // A doorway is not always across a room. Mr. Pokémon's is at the top of
      // Route 30 and the walk to it starts fifty tiles south, through grass --
      // so the budget is a route's, not a room's, and whatever jumps out on the
      // way is dealt with rather than counted as the door being unreachable.
      await this.escapeBattle();
      const res = await this.nav.walkTo(this.collision, goal, { maxSteps: 260, ...this.walkOpts });
      if (res.stopped === 'battle') continue;
      if (await this.mapKey() === expect) return true;
      if (res.stopped === 'refused' || res.stopped === 'battle') {
        await this.runScripts();
        continue;
      }
      if (res.stopped === null) {
        // On the tile but still here, so this is a warp carpet: it wants the
        // direction it points, and the collision value says which. Guessing
        // instead just walks off the tile -- the first press in the wrong
        // direction takes you with it, and the rest are pressed from next door.
        const wram = await this.settled();
        if (wram) {
          const push = CollisionMap.pushFor(
            this.collision.collisionAt(goal[0], goal[1]));
          if (push) {
            await this.nav.step(push);
            if (await this.mapKey() === expect) return true;
          }
        }
      }
      await this.runScripts();
    }
    return await this.mapKey() === expect;
  }

  /** Walk off one side of the map onto whatever is next door. */
  async crossEdge(direction, expect, tries = 40) {
    const wram = await this.settled();
    if (!wram) return false;
    const from = await this.mapKey();

    // First, get as far along the map as is actually reachable. On a long route
    // the opening is not in reach of one plan from the far end, so this closes
    // the distance in stages before the edge tiles are worth trying at all.
    for (let push = 0; push < 12; push++) {
      if (this.stopped) return false;
      await this.escapeBattle();
      const w2 = await this.settled();
      if (!w2) break;
      const at = this.collision.playerPos(w2);
      const goal = this.collision.furthestToward(at, direction);
      if (!goal || (goal[0] === at[0] && goal[1] === at[1])) break;
      const res = await this.nav.walkTo(this.collision, goal, { maxSteps: 260, ...this.walkOpts });
      if (await this.mapKey() !== from) return await this.mapKey() === expect;
      // "Refused" means the game stopped taking walking input, which out here
      // is almost always somebody talking: Elm phones the moment you leave
      // Mr. Pokémon's, and treating that as terrain ended the walk home.
      if (res.stopped === 'refused') { await this.runScripts(); continue; }
      if (res.stopped !== null && res.stopped !== 'battle') break;
      // Nudge off the far edge: the last tile in the direction is usually the
      // one the connection is behind.
      for (let i = 0; i < 3; i++) {
        await this.escapeBattle();
        const step = await this.nav.step(direction);
        if (await this.mapKey() !== from) return await this.mapKey() === expect;
        if (step.blocked) break;
      }
    }

    // The candidates are worked out *here*, after the advance, rather than on the
    // way in. Coming through a door the decode has not settled yet, and an edge
    // measured then belongs to whatever map was still loaded -- so the list was
    // wrong for the rest of the crossing, and every attempt walked at a tile
    // that had never been an opening.
    const fresh = await this.settled();
    if (!fresh) return false;
    const [w, h] = this.collision.mapSize();
    const line = [];
    for (let i = 0; i < (direction === 'LEFT' || direction === 'RIGHT' ? h : w); i++) {
      if (direction === 'LEFT') line.push([0, i]);
      else if (direction === 'RIGHT') line.push([w - 1, i]);
      else if (direction === 'UP') line.push([i, 0]);
      else line.push([i, h - 1]);
    }
    // Walkable ones only, and *then* ordered by where the opening usually is.
    // Filtering after sorting tried eight walls in a row: New Bark Town's west
    // side only opens at rows 8, 9, 12 and 13, and the player leaves the lab at
    // row 3, so every candidate near them is fence.
    //
    // Centre-out rather than nearest-to-player, the way the desktop pilot does
    // it: a route's connection sits inland of its corners, and the tile beside
    // you is often walkable but cut off from the opening by a ledge.
    const across = direction === 'LEFT' || direction === 'RIGHT' ? 1 : 0;
    const open = line.filter(([x, y]) =>
      this.collision.walkable(x, y, { allowWarp: true }));
    const middle = ((across === 1 ? h : w) - 1) / 2;
    open.sort((a, b) =>
      Math.abs(a[across] - middle) - Math.abs(b[across] - middle));

    for (const tile of open) {
      if (this.stopped) return false;
      // Crossing a route means walking its whole width through grass, and
      // something jumps out every few steps. A wild battle is not a navigation
      // failure -- nothing is lost by it -- so it is run from and the walk
      // picks up where it left off, rather than counting against the plan.
      let arrived = false;
      for (let attempt = 0; attempt < 30 && !arrived; attempt++) {
        await this.escapeBattle();
        // Routes are long -- Route 30 is fifty-four tiles top to bottom -- and
        // the default step budget is sized for a room, so it runs out halfway
        // up with nothing to show for it.
        const res = await this.nav.walkTo(this.collision, tile, { maxSteps: 260, ...this.walkOpts });
        // Walking to the edge can carry us over it, and that is the errand
        // done rather than a failure -- the walk reports it as a warp, which
        // an earlier version treated as a reason to give up on a crossing it
        // had just completed.
        if (await this.mapKey() !== from) return await this.mapKey() === expect;
        if (res.stopped === null) arrived = true;
        else if (res.stopped === 'refused') await this.runScripts();
        else if (res.stopped !== 'battle') break;
      }
      if (!arrived) continue;
      for (let i = 0; i < tries; i++) {
        await this.escapeBattle();
        const res = await this.nav.step(direction);
        if (await this.mapKey() !== from) return await this.mapKey() === expect;
        if (res.blocked) break;
      }
    }
    return false;
  }

  /**
   * Walk from wherever we are to another map, following the world graph.
   *
   * Each leg is one edge crossing, and the route is re-asked from the map we
   * actually landed on rather than followed from a plan made at the start: a
   * crossing can put us somewhere unexpected, and re-asking costs nothing
   * because the graph is already in memory.
   */
  async travelTo(target, { maxLegs = 12 } = {}) {
    if (!this.world) return { ok: false, message: 'no world graph' };
    for (let leg = 0; leg < maxLegs; leg++) {
      if (this.stopped) return { ok: false, message: 'stopped' };
      const here = await this.mapKey();
      if (here === target) return { ok: true, message: 'arrived' };
      const route = this.world.route(here, target);
      if (route === null) {
        return {
          ok: false,
          message: `no way from ${this.where(here)} to ${this.where(target)}`,
        };
      }
      if (!route.length) return { ok: true, message: 'arrived' };
      const next = route[0];
      if (next.kind === 'warp') {
        this.say(`through to ${this.where(next.key)}`);
        if (!await this.through(next.tile, next.key)) {
          if (this.stopped) return { ok: false, message: 'stopped' };
          return { ok: false, message: `could not get through to ${this.where(next.key)}` };
        }
        continue;
      }
      this.say(`heading ${next.dir.toLowerCase()}`);
      // A crossing can fail for reasons that pass: somebody is mid-conversation,
      // something jumped out at the wrong moment, a script took the controls.
      // Measured, the same leg failed on one run and worked on the next, so one
      // refusal is not an answer -- it is worth asking again from wherever we
      // ended up.
      let crossed = false;
      for (let go = 0; go < 3 && !crossed; go++) {
        if (go) {
          await this.escapeBattle();
          await this.runScripts();
          this.say(`trying ${next.dir.toLowerCase()} again`);
        }
        crossed = await this.crossEdge(next.dir, next.key);
        if (!crossed && await this.mapKey() !== here) break;   // somewhere new
      }
      if (!crossed && await this.mapKey() === here) {
        // Asked to stop is not the same as could not get there, and saying the
        // second when the user pressed the first blames the map for a decision
        // they made.
        if (this.stopped) return { ok: false, message: 'stopped' };
        return {
          ok: false,
          message: `could not leave ${this.where(here)} going ${next.dir}`,
        };
      }
    }
    return { ok: false, message: 'too many legs' };
  }

  /** Stand on a tile that rolls for wild encounters. */
  async findGrass() {
    const grass = this.state.e.grassTiles;
    const wram = await this.settled();
    if (!wram) return false;
    const [w, h] = this.collision.mapSize();
    const pos = this.collision.playerPos(wram);
    const patches = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (grass.includes(this.collision.collisionAt(x, y))) patches.push([x, y]);
      }
    }
    if (!patches.length) return false;
    patches.sort((a, b) =>
      Math.abs(a[0] - pos[0]) + Math.abs(a[1] - pos[1])
      - Math.abs(b[0] - pos[0]) - Math.abs(b[1] - pos[1]));
    // Walking to grass walks *through* grass, so something jumps out on the way
    // more often than not. That is not a failure to find it -- an earlier
    // version counted it as one, ran out of candidates, and reported success
    // from wherever it had been stopped, several tiles short of any grass at
    // all. Each patch gets a few goes, and the answer is checked against the
    // tile actually stood on rather than against the walk's own opinion.
    for (const tile of patches.slice(0, 8)) {
      for (let attempt = 0; attempt < 4; attempt++) {
        await this.escapeBattle();
        const res = await this.nav.walkTo(this.collision, tile, this.walkOpts);
        if (res.stopped === null) return this.onGrass();
        if (res.stopped === 'refused') { await this.runScripts(); continue; }
        if (res.stopped !== 'battle') break;
      }
    }
    return this.onGrass();
  }

  /** Is the tile underfoot one that rolls for encounters? */
  async onGrass() {
    const wram = await this.settled();
    if (!wram) return false;
    const at = this.collision.playerPos(wram);
    return this.state.e.grassTiles
      .includes(this.collision.collisionAt(at[0], at[1]));
  }

  /** Find a way off this map and take it. */
  async leaveVia(expect) {
    const wram = await this.settled();
    if (!wram) return false;
    const [w, h] = this.collision.mapSize();
    const pos = this.collision.playerPos(wram);
    const warps = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (CollisionMap.isWarp(this.collision.collisionAt(x, y))) warps.push([x, y]);
      }
    }
    warps.sort((a, b) =>
      Math.abs(a[0] - pos[0]) + Math.abs(a[1] - pos[1])
      - Math.abs(b[0] - pos[0]) - Math.abs(b[1] - pos[1]));
    for (const tile of warps.slice(0, 4)) {
      if (await this.through(tile, expect)) return true;
    }
    return false;
  }

  async healUp() {
    const from = await this.mapKey();
    const where = await this.nearestHeal(from);
    if (!where) return false;
    if (from !== where.map) {
      const there = await this.travelTo(where.map);
      if (!there.ok) return false;
    }
    const healed = await where.heal();
    // And come back. Healing used to end standing in Cherrygrove, which has no
    // grass in it, so a grind that healed itself resumed in a town and stopped
    // on the next breath saying it could not find any wild Pokemon -- with a
    // full-health party, one map away from the route it had been working.
    if (healed && await this.mapKey() !== from) {
      await this.travelTo(from);
    }
    return healed;
  }

  /**
   * Go to the nearest place that will heal, then come back — as a task.
   *
   * healUp already does the work, including choosing between Elm's computer and
   * the Pokemon Center by distance rather than by leg count. This is the guard
   * and the reporting around it, so it reports like every other task.
   *
   * Refuses in a battle, because walking is not an option there and the honest
   * answer is to say so rather than to press buttons hopefully.
   */
  async healNow() {
    const started = Date.now();
    const before = await this.snap();
    if (before.inBattle) {
      return { ok: false, stats: {}, message: 'finish the battle first' };
    }
    if (!before.party.length) {
      return { ok: false, stats: {}, message: 'no party to heal' };
    }
    const hurt = before.party.filter((m) => m.hp < m.maxHp);
    if (!hurt.length) {
      return { ok: true, stats: { already: true },
               message: 'the party is already at full health' };
    }

    const from = await this.mapKey();
    const where = await this.nearestHeal(from);
    // A cartridge nobody has told the pilot about has no healer, and saying so
    // beats walking hopefully. Crystal always answers with one of two.
    if (!where) {
      return { ok: false, stats: {},
               message: 'nowhere to heal that this build knows about' };
    }
    this.say(`healing at ${this.where(where.map)}`);
    const healed = await this.healUp();
    const after = await this.snap();
    const stats = {
      at: this.where(where.map),
      seconds: ((Date.now() - started) / 1000).toFixed(1),
      party: after.party.map((m) => `${m.hp}/${m.maxHp}`).join(' '),
    };
    if (!healed) {
      return { ok: false, stats,
               message: `could not heal (stopped in ${this.where(await this.mapKey())})` };
    }
    return { ok: true, stats,
             message: `healed ${hurt.length === 1 ? 'one Pokémon' : `${hurt.length} Pokémon`}`
                      + ` at ${stats.at}` };
  }

  /** Run from anything that jumped us on the way. */
  /**
   * Get out of whatever battle we are in, whichever way that map allows.
   *
   * You cannot run from a trainer -- the game refuses every turn and the turn
   * passes anyway, so a pilot that only knows how to flee stands there losing
   * HP until something faints. wBattleMode says which kind this is: 1 wild,
   * 2 trainer. Wild ones are still run from, because a walk that stopped to win
   * every encounter would spend the party on Pokemon it never wanted.
   */
  async escapeBattle() {
    const s = await this.snap();
    if (!s.inBattle) return true;
    if (s.battleMode === this.state.e.trainerBattle) {
      const how = await this.tasks.fightBattle();
      this.say(how === 'won' ? 'won a trainer battle' : `trainer battle: ${how}`);
      return how === 'won';
    }
    return this.tasks.flee();
  }

  /** Stand next to an item ball and take it. */
  async pickUp(tile) {
    const below = [tile[0], tile[1] + 1];
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.escapeBattle();
      const res = await this.nav.walkTo(this.collision, below, this.walkOpts);
      if (res.stopped !== null && res.stopped !== 'battle') {
        if (res.stopped === 'battle') continue;
      }
      await this.nav.step('UP');
      await this.gb.press('A', 6, 12);
      await this.runScripts();
      const s = await this.snap();
      if (s.balls.length) return null;
    }
    return 'the ball would not go in the bag';
  }

  /** Run a list of named legs, stopping at the first one that fails. */
  async walkLegs(legs, done) {
    for (const [what, leg] of legs) {
      this.say(what);
      const failed = await leg();
      if (failed) {
        const s = await this.snap();
        return { ok: false, party: s.party,
                 message: `${failed} (stopped in ${this.where(await this.mapKey())})` };
      }
    }
    return done();
  }

  nameOf(mon) {
    return this.tasks.rom ? this.tasks.rom.speciesName(mon.species) : 'starter';
  }

  /**
   * The cheapest place that will heal the party, and how to ask it to.
   *
   * `{ map, heal, cost }` or null. Which places exist is the title's; which is
   * nearest is arithmetic, and the arithmetic is the interesting part.
   *
   * Counting legs of the map graph gets it wrong, and wrong in the common case.
   * By legs, a Center one hop west beats a lab two hops east everywhere -- but a
   * hop west can mean walking the whole sixty-tile width of a route through
   * grass, while the lab is six tiles and a door. So the cost is the tiles to
   * the edge this route would actually leave by, plus a flat charge for each
   * further leg. Only the first leg is measurable from here; the rest are
   * charged at `legCost` because their entry points are not known until the
   * player is standing on them.
   */
  async nearestHeal(from) {
    const healers = this.title.healers || [];
    if (!healers.length) return null;
    const reach = (h) => ({ map: h.map, heal: () => this[h.reach]() });
    // The last one is the fallback, deliberately: a title lists its healers
    // most-general last, and with no map graph to price the alternatives the
    // general answer is the safe one.
    const fallback = reach(healers[healers.length - 1]);
    if (!this.world) return fallback;

    const legCost = this.title.legCost || 25;
    const wram = await this.settled();
    let best = null;
    for (const h of healers) {
      if (from === h.map) return { ...reach(h), cost: 0 };
      const route = this.world.route(from, h.map);
      if (route === null) continue;
      let cost = (route.length - 1) * legCost;
      const first = route[0];
      if (wram && first && first.kind === 'edge') {
        const [w, hh] = this.collision.mapSize();
        const at = this.collision.playerPos(wram);
        cost += { LEFT: at[0], RIGHT: w - 1 - at[0],
                  UP: at[1], DOWN: hh - 1 - at[1] }[first.dir] ?? legCost;
      }
      if (!best || cost < best.cost) best = { ...reach(h), cost };
    }
    return best || fallback;
  }

  /**
   * Get back to somewhere encounters actually happen.
   *
   * Pacing for a battle wanders, and it can wander off the route entirely --
   * so "look for grass here" is not enough on its own, since here may be a
   * town. The maps to fall back to are the title's, because which ones have
   * grass in them is not something this layer can see from where it is
   * standing.
   */
  async backToGrass() {
    if (await this.onGrass()) return true;
    if (await this.findGrass()) return true;
    const here = await this.mapKey();
    for (const map of this.title.grassyMaps || []) {
      if (map === here) continue;
      const there = await this.travelTo(map);
      if (there.ok && await this.findGrass()) return true;
    }
    return false;
  }
}
