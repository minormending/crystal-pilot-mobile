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
};

// CherrygroveCity warp_events, and the nurse behind her counter.
const POKECENTER_DOOR = [29, 3];
const NURSE = [3, 1];
// Route31 object_events: a Poké Ball lying in the grass. It is the earliest
// ball in the game that does not need the Pokédex -- the Mart only stocks them
// once you have one, and Elm's aide only hands them over after the errand to
// Mr. Pokémon's, which brings a rival battle with it.
const ROUTE_31_BALL = [19, 15];

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

export class Bootstrap {
  constructor(gb, state, tasks, collision, nav, say = () => {}) {
    this.gb = gb;
    this.state = state;
    this.tasks = tasks;
    this.collision = collision;
    this.nav = nav;
    this.say = say;
    this.scriptModeAt = state.a.scriptMode;
  }

  async snap() { return this.state.read(await this.gb.readWram()); }
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
  async settled(tries = 4) {
    for (let i = 0; i < tries; i++) {
      const wram = await this.gb.readWram();
      if (this.collision.calibrate(wram)) return wram;
      await this.gb.run(20);
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
  async through(goal, expect, tries = 4) {
    for (let i = 0; i < tries; i++) {
      const from = await this.mapKey();
      if (from === expect) return true;
      const res = await this.nav.walkTo(this.collision, goal);
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
    const [w, h] = this.collision.mapSize();
    const pos = this.collision.playerPos(wram);
    const line = [];
    for (let i = 0; i < (direction === 'LEFT' || direction === 'RIGHT' ? h : w); i++) {
      if (direction === 'LEFT') line.push([0, i]);
      else if (direction === 'RIGHT') line.push([w - 1, i]);
      else if (direction === 'UP') line.push([i, 0]);
      else line.push([i, h - 1]);
    }
    // Walkable ones only, and *then* nearest first. Sorting the whole edge and
    // taking the first few tried eight walls in a row: New Bark Town's west
    // side only opens at rows 8, 9, 12 and 13, and the player leaves the lab at
    // row 3, so every candidate near them is fence.
    const across = direction === 'LEFT' || direction === 'RIGHT' ? 1 : 0;
    const open = line.filter(([x, y]) =>
      this.collision.walkable(x, y, { allowWarp: true }));
    open.sort((a, b) =>
      Math.abs(a[across] - pos[across]) - Math.abs(b[across] - pos[across]));

    const from = await this.mapKey();
    for (const tile of open.slice(0, 6)) {
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
        const res = await this.nav.walkTo(this.collision, tile, { maxSteps: 260 });
        // Walking to the edge can carry us over it, and that is the errand
        // done rather than a failure -- the walk reports it as a warp, which
        // an earlier version treated as a reason to give up on a crossing it
        // had just completed.
        if (await this.mapKey() !== from) return await this.mapKey() === expect;
        if (res.stopped === null) arrived = true;
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
    for (const tile of patches.slice(0, 6)) {
      const res = await this.nav.walkTo(this.collision, tile);
      if (res.stopped === null) return true;
    }
    return false;
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
  async heal() {
    if (await this.mapKey() !== CHERRYGROVE_CITY) return false;
    if (!await this.through(POKECENTER_DOOR, CHERRYGROVE_POKECENTER)) return false;
    await this.runScripts();
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.nav.walkTo(this.collision, [NURSE[0], NURSE[1] + 2]);
      await this.nav.walkTo(this.collision, [NURSE[0], NURSE[1] + 1]);
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
  async escapeBattle() {
    if (!(await this.snap()).inBattle) return true;
    return this.tasks.flee();
  }

  /** Stand next to an item ball and take it. */
  async pickUp(tile) {
    const below = [tile[0], tile[1] + 1];
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.escapeBattle();
      const res = await this.nav.walkTo(this.collision, below);
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
    await this.nav.walkTo(this.collision, ELM_TALK_FROM);
    await this.nav.step('UP');
    await this.gb.press('A', 6, 12);
    await this.runScripts();

    for (let attempt = 0; attempt < 3; attempt++) {
      await this.nav.walkTo(this.collision, [ballX, 4]);
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
