// Start a brand-new game and play it as far as grass with a Pokemon in tow.
//
// Everything else here needs a party: a grind has nothing to train, a hunt has
// nothing to run from, a catch has nothing to throw at. A fresh ROM has none of
// that, so without this the loops could only be reasoned about, never watched.
//
// The route is the same one the desktop pilot walks, and the coordinates come
// from the same maps -- but each leg is checked rather than assumed. Every warp
// says which map it expects to land on and stops with a plain description if it
// lands somewhere else, because a bootstrap that quietly drifts off course ends
// up mashing A at a wall.
import { CollisionMap } from './collision.js';

const key = (group, number) => group * 256 + number;

// New Bark Town's maps, from constants/map_constants.asm.
const PLAYERS_HOUSE_2F = key(24, 7);
const PLAYERS_HOUSE_1F = key(24, 6);
const NEW_BARK_TOWN = key(24, 4);
const ELMS_LAB = key(24, 5);
const ROUTE_29 = key(24, 3);
const CHERRYGROVE_CITY = key(26, 3);
const CHERRYGROVE_POKECENTER = key(26, 5);
const ROUTE_30 = key(26, 1);
const ROUTE_31 = key(26, 2);
const MR_POKEMONS_HOUSE = key(26, 10);

const MAP_NAMES = {
  [PLAYERS_HOUSE_2F]: 'your bedroom',
  [PLAYERS_HOUSE_1F]: 'downstairs',
  [NEW_BARK_TOWN]: 'New Bark Town',
  [ELMS_LAB]: "Elm's lab",
  [ROUTE_29]: 'Route 29',
  [CHERRYGROVE_CITY]: 'Cherrygrove City',
  [CHERRYGROVE_POKECENTER]: "Cherrygrove's Pokémon Center",
  [ROUTE_30]: 'Route 30',
  [ROUTE_31]: 'Route 31',
  [MR_POKEMONS_HOUSE]: "Mr. Pokémon's house",
};

// CherrygroveCity warp_events, and the nurse behind her counter.
const POKECENTER_DOOR = [29, 3];
const NURSE = [3, 1];
// Route31 object_events: a Poké Ball lying in the grass. It is the earliest
// ball in the game that does not need the Pokédex -- the Mart only stocks them
// once you have one, and Elm's aide only hands them over after the errand to
// Mr. Pokémon's, which brings a rival battle with it.
const ROUTE_31_BALL = [19, 15];

// Route30 warp_events: the door to Mr. Pokémon's house, up the east side --
// which matters, because the west side is sealed this early (see eggErrand).
const MR_POKEMON_DOOR = [17, 5];
// MrPokemonsHouse: he stands at (3, 5) and the way out is the pair at y=7.
const MR_POKEMON = [3, 5];
const MR_POKEMON_EXIT = [3, 7];
// ElmsLab coord_events: the aide walks over and hands the balls across when you
// step on either of these. There is nobody to talk to -- standing there is the
// whole trigger.
const AIDE_TILE = [4, 8];

// Warp tiles, from the object_events of each map.
const STAIRS_DOWN = [7, 0];        // PlayersHouse2F
const FRONT_DOOR = [6, 7];         // PlayersHouse1F, out to the town
const LAB_DOOR = [6, 3];           // NewBarkTown, into the lab
const LAB_EXIT = [4, 11];          // ElmsLab, back out to the town

// ElmsLab object_events: the three balls sit in a row at y=4.
const STARTER_BALL_X = { cyndaquil: 6, totodile: 7, chikorita: 8 };
const ELM_TALK_FROM = [5, 3];      // stand here, face up, and Elm is above

// Encounter tiles, the same values CheckGrassCollision uses.
const GRASS = new Set([0x10, 0x14, 0x18, 0x1c]);

// wBattleMode: 1 is a wild Pokemon, 2 is a trainer.
const TRAINER_BATTLE = 2;

export class Bootstrap {
  constructor(gb, state, tasks, collision, nav, say = () => {}, world = null) {
    this.gb = gb;
    this.state = state;
    this.tasks = tasks;
    this.collision = collision;
    this.nav = nav;
    this.world = world;
    this.say = say;
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

  where(k) { return MAP_NAMES[k] || `map ${k >> 8}.${k & 0xff}`; }

  /**
   * A work-RAM snapshot the collision decode agrees with, or null.
   *
   * Retried, because the first read after stepping through a door catches the
   * map still loading and the decode disagreeing with the game for a few
   * frames. Giving up on that reading is how crossing to Route 29 failed
   * without the pilot taking a single step: it asked immediately after coming
   * out of the lab, got a no, and returned.
   */
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
    if (this.stopped) return;
    for (let i = 0; i < maxTaps; i++) {
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
    const wram = await this.settled();
    if (!wram) return false;
    const [w, h] = this.collision.mapSize();
    const pos = this.collision.playerPos(wram);
    const patches = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (GRASS.has(this.collision.collisionAt(x, y))) patches.push([x, y]);
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
    return GRASS.has(this.collision.collisionAt(at[0], at[1]));
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

  /**
   * Heal at Cherrygrove's Pokémon Center.
   *
   * The nurse stands behind a counter, so the approach is from two tiles below
   * and then one -- the same way the desktop pilot does it, and the same way a
   * person would. Her question defaults to yes, which is the answer we want.
   */
  /**
   * Heal wherever we happen to be standing, by walking to the nearest Center we
   * know about.
   *
   * This is the shape a grind wants: it notices the party is low and needs
   * somebody who knows where a Pokemon Center *is*, which is map knowledge
   * tasks.js deliberately does not carry.
   */
  async healUp() {
    const from = await this.mapKey();
    if (from !== CHERRYGROVE_CITY) {
      const there = await this.travelTo(CHERRYGROVE_CITY);
      if (!there.ok) return false;
    }
    const healed = await this.heal();
    // And come back. Healing used to end standing in Cherrygrove, which has no
    // grass in it, so a grind that healed itself resumed in a town and stopped
    // on the next breath saying it could not find any wild Pokemon -- with a
    // full-health party, one map away from the route it had been working.
    if (healed && from !== CHERRYGROVE_CITY && await this.mapKey() !== from) {
      await this.travelTo(from);
    }
    return healed;
  }

  /**
   * Get back to somewhere encounters actually happen.
   *
   * Pacing for a battle wanders, and on Route 29 it wanders far enough to cross
   * into Cherrygrove -- so "look for grass here" is not enough on its own, since
   * here may be a town. Falls back to the route the pilot knows is grass.
   */
  async backToGrass() {
    if (await this.onGrass()) return true;
    if (await this.findGrass()) return true;
    const here = await this.mapKey();
    for (const map of [ROUTE_29, ROUTE_30]) {
      if (map === here) continue;
      const there = await this.travelTo(map);
      if (there.ok && await this.findGrass()) return true;
    }
    return false;
  }

  async heal() {
    if (await this.mapKey() !== CHERRYGROVE_CITY) return false;
    if (!await this.through(POKECENTER_DOOR, CHERRYGROVE_POKECENTER)) return false;
    await this.runScripts();
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.nav.walkTo(this.collision, [NURSE[0], NURSE[1] + 2], this.walkOpts);
      await this.nav.walkTo(this.collision, [NURSE[0], NURSE[1] + 1], this.walkOpts);
      await this.nav.step('UP');
      await this.gb.press('A', 6, 12);
      await this.runScripts();
      const s = await this.snap();
      if (s.party.every((m) => m.hp === m.maxHp)) break;
    }
    const healed = (await this.snap()).party.every((m) => m.hp === m.maxHp);
    await this.leaveVia(CHERRYGROVE_CITY);
    return healed;
  }

  /**
   * Walk from Route 29 to the Poké Ball lying on Route 31, and pick it up.
   *
   * Wild encounters interrupt constantly on the way, so each leg runs from
   * whatever it meets and carries on. Healing happens in Cherrygrove because
   * fleeing is not free -- it can fail, and a fainted party ends the trip.
   */
  async fetchBall() {
    const legs = [
      ['west to Cherrygrove', async () =>
        await this.crossEdge('LEFT', CHERRYGROVE_CITY) ? null : 'could not leave Route 29'],
      ['healing up', async () => { await this.heal(); return null; }],
      ['north to Route 30', async () =>
        await this.crossEdge('UP', ROUTE_30) ? null : 'could not reach Route 30'],
      ['north to Route 31', async () =>
        await this.crossEdge('UP', ROUTE_31) ? null : 'could not reach Route 31'],
      ['picking the ball up', async () => this.pickUp(ROUTE_31_BALL)],
    ];
    for (const [what, leg] of legs) {
      this.say(what);
      await this.escapeBattle();
      const failed = await leg();
      if (failed) {
        return { ok: false, message:
          `${failed} (stopped in ${this.where(await this.mapKey())})` };
      }
    }
    const s = await this.snap();
    const balls = s.balls.reduce((n, [, q]) => n + q, 0);
    return { ok: balls > 0, balls: s.balls,
             message: balls > 0
               ? `picked up ${balls} Poké Ball${balls === 1 ? '' : 's'}`
               : 'reached the ball but the bag is still empty' };
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
    if (s.battleMode === TRAINER_BATTLE) {
      const how = await this.tasks.fightBattle();
      this.say(how === 'won' ? 'won a trainer battle' : `trainer battle: ${how}`);
      return how === 'won';
    }
    return this.tasks.flee();
  }

  /**
   * Fetch the Mystery Egg from Mr. Pokémon and bring it back to Elm.
   *
   * This exists to get Poké Balls, which the game will not otherwise part with:
   * the Mart wants a Pokédex, and the only free ball on the ground is on
   * Route 31, on the far side of a road that is closed. Route 30's one-tile
   * corridor north is filled by Youngster Joey and two Rattata sprites, all
   * three conditional on EVENT_ROUTE_30_BATTLE -- which is *clear* on a new
   * game, so the objects are there until it gets set. It is a deliberate
   * roadblock, and returning the egg is what lifts it.
   *
   * The errand pays for itself either way: ElmsLab ends it with
   * `giveitem POKE_BALL, 5`, so there is no reason to walk to Route 31 at all.
   *
   * Mr. Pokémon's house is at Route 30 (17, 5) -- on the *east* side, the half
   * the roadblock does not touch.
   *
   * The hard part is the way home. Cherrygrove has a coord_event at (33, 6) and
   * (33, 7) that starts the rival battle as you walk east through it, and you
   * cannot run from a trainer -- see escapeBattle, which fights when wBattleMode
   * says trainer.
   */
  async eggErrand() {
    const trail = [];
    // Every way this can end early routes through here, so a stop is reported as
    // a stop wherever it happened rather than as whichever leg it interrupted.
    const fail = (message) =>
      ({ ok: false, trail, message: this.stopped ? 'stopped' : message });
    const ballCount = async () => {
      const s = await this.snap();
      return s.balls.reduce((n, [, q]) => n + q, 0);
    };

    // Run it twice and the second go walked the whole errand again -- forty
    // seconds to Mr. Pokémon's and back -- then reported success because there
    // were balls in the bag. There were: the same five from the first go. The
    // aide hands his over once, so having any at all means this has nothing
    // left to do, and "got" has to mean gained rather than found.
    const before = await ballCount();
    if (before > 0) {
      return { ok: true, trail, message: `already carrying ${before} ball(s)` };
    }

    // Cherrygrove is on the way and has the only Pokemon Center for miles, so
    // both legs of the errand start from full HP rather than hoping.
    this.say('healing before setting off');
    if (await this.healUp()) trail.push('healed');

    if (this.stopped) return fail('stopped');
    this.say('out to Route 30');
    const north = await this.travelTo(ROUTE_30);
    if (!north.ok) return fail(`could not reach Route 30 (${north.message})`);
    trail.push('Route 30');

    this.say("to Mr. Pokémon's house");
    if (!await this.through(MR_POKEMON_DOOR, MR_POKEMONS_HOUSE)) {
      return fail(`could not get in the door (in ${this.where(await this.mapKey())})`);
    }
    trail.push("Mr. Pokémon's house");

    // He hands the egg over across the counter, and Elm phones straight after,
    // so the text runs well past the point where the egg is already ours.
    this.say('collecting the egg');
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.nav.walkTo(this.collision, [MR_POKEMON[0], MR_POKEMON[1] + 1], this.walkOpts);
      await this.nav.step('UP');
      await this.gb.press('A', 6, 12);
      await this.runScripts();
      if (await this.mapKey() !== MR_POKEMONS_HOUSE) break;   // shoved outside
      if (attempt === 0) continue;                            // Oak talks too
      break;
    }
    trail.push('egg');

    if (await this.mapKey() === MR_POKEMONS_HOUSE) {
      this.say('back outside');
      if (!await this.through(MR_POKEMON_EXIT, ROUTE_30)) {
        return fail('could not leave the house');
      }
    }

    // The rival is waiting in Cherrygrove, on the coord_event at (33, 6) and
    // (33, 7) that fires walking east -- so heal first, on the way past.
    this.say('healing before the rival');
    if (await this.healUp()) trail.push('healed');

    this.say('home to New Bark');
    const home = await this.travelTo(NEW_BARK_TOWN);
    if (!home.ok) return fail(`could not get home (${home.message})`);
    trail.push('New Bark Town');

    this.say("into Elm's lab");
    if (!await this.through(LAB_DOOR, ELMS_LAB)) {
      return fail(`could not get into the lab (in ${this.where(await this.mapKey())})`);
    }
    trail.push("Elm's lab");

    // The theft is discovered on the way in, which is a scene rather than
    // anything to steer, and then Elm takes the egg.
    await this.runScripts();
    this.say('handing the egg over');
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.nav.walkTo(this.collision, ELM_TALK_FROM, this.walkOpts);
      await this.nav.step('UP');
      await this.gb.press('A', 6, 12);
      await this.runScripts();
    }

    // Nothing to talk to here: the aide comes over when you stand on his tile.
    this.say('collecting the balls');
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.nav.walkTo(this.collision, AIDE_TILE, this.walkOpts);
      await this.runScripts();
      const s = await this.snap();
      const balls = s.balls.filter(([, n]) => n > 0);
      if (balls.reduce((n, [, q]) => n + q, 0) > before) {
        const what = balls
          .map(([id, n]) => `${this.tasks.rom ? this.tasks.rom.itemName(id) : id} x${n}`)
          .join(', ');
        trail.push(what);
        return { ok: true, message: `got ${what}`, trail };
      }
      // Stepping off and back on is what re-arms the coord_event.
      await this.nav.step('DOWN');
    }
    return fail('the aide never handed the balls over');
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

  /** Take a starter out of one of the three balls in Elm's lab. */
  async takeStarter(which) {
    const ballX = STARTER_BALL_X[which];
    if (ballX === undefined) {
      return `unknown starter ${which}`;
    }
    await this.runScripts();                      // Elm greets you on the way in
    // Talk to Elm first, the way the story expects, so the balls become active.
    await this.nav.walkTo(this.collision, ELM_TALK_FROM, this.walkOpts);
    await this.nav.step('UP');
    await this.gb.press('A', 6, 12);
    await this.runScripts();

    for (let attempt = 0; attempt < 3; attempt++) {
      await this.nav.walkTo(this.collision, [ballX, 4], this.walkOpts);
      await this.nav.step('UP');
      await this.gb.press('A', 6, 12);
      await this.runScripts();
      // "Do you want this one?" defaults to yes, which is what we want here --
      // unlike the nickname box that follows it.
      await this.tasks.declineNickname();
      await this.runScripts();
      const s = await this.snap();
      if (s.party.length > 0) return null;
      this.say(`starter: attempt ${attempt + 1} did not take`);
    }
    return 'could not pick up a starter in the lab';
  }

  /**
   * Title screen to standing in the grass with a Pokemon.
   *
   * Returns { ok, message, party }.
   */
  async run(starter = 'cyndaquil') {
    const legs = [
      ['starting a new game', async () => {
        if (await this.tasks.continueGame()) return null;
        return 'never reached the overworld — is this a Crystal ROM?';
      }],
      ['going downstairs', async () =>
        await this.through(STAIRS_DOWN, PLAYERS_HOUSE_1F)
          ? null : 'could not find the stairs'],
      ['out of the house', async () =>
        await this.through(FRONT_DOOR, NEW_BARK_TOWN)
          ? null : 'could not get out of the house'],
      ["into Elm's lab", async () =>
        await this.through(LAB_DOOR, ELMS_LAB) ? null : 'could not get into the lab'],
      [`taking ${starter}`, async () => this.takeStarter(starter)],
      ['back outside', async () =>
        await this.through(LAB_EXIT, NEW_BARK_TOWN)
          ? null : 'could not get out of the lab'],
      ['out to Route 29', async () =>
        await this.crossEdge('LEFT', ROUTE_29) ? null : 'could not reach Route 29'],
      ['finding grass', async () =>
        await this.findGrass() ? null : 'could not find a patch of grass'],
    ];

    for (const [what, leg] of legs) {
      this.say(what);
      const failed = await leg();
      if (failed) {
        const s = await this.snap();
        return { ok: false, party: s.party,
                 message: `${failed} (stopped in ${this.where(await this.mapKey())})` };
      }
    }
    const s = await this.snap();
    const lead = s.party[0];
    return {
      ok: true,
      party: s.party,
      message: lead
        ? `ready on Route 29 with a Lv${lead.level} starter`
        : 'reached the grass, but with no Pokemon',
    };
  }
}

export { CollisionMap };
