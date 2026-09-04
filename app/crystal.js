// Everything that is Pokemon Crystal rather than Pokemon Gen 2.
//
// Eleven map ids and a name for each, the tiles of a dozen doors and people, the
// x positions of three balls on Elm's table, and the scripted errands built out
// of them: the intro, the trip to Mr. Pokemon's for the egg, and the two places
// that will heal a party.
//
// It extends Journey rather than composing one, for now, because that is the
// change that moves nothing: every `this.travelTo(...)` inside these methods
// still means what it meant when they shared a file. What it buys immediately is
// the arrow -- a title may know about the engine, and the engine may not know
// about a title -- and this file is the only place in the app that names a
// Crystal map.
//
// A hack of the same base game replaces this file and keeps the other one.
import { Journey } from './journey.js';

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
// ElmsLab bg_events: the healing machine at (2, 1), read by facing it. It is
// gated only on EVENT_GOT_A_POKEMON_FROM_ELM, so it works from the moment you
// take a starter -- no Pokedex, and no walking to a Pokemon Center.
const ELM_HEAL_FROM = [2, 2];      // stand here, face up, and the machine is above



// What a leg beyond the first is worth in tiles, when weighing up two routes.
// A door is cheap and a route crossing is not, and only the leg we are standing
// on can actually be measured.
const LEG_COST = 25;


export class Crystal extends Journey {
  /** The eleven maps this pilot works in, by the names people use for them. */
  where(k) { return MAP_NAMES[k] || super.where(k); }


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
  /**
   * Heal at the computer in Elm's lab.
   *
   * Available from the moment you have a starter, which is the whole point:
   * the Pokemon Center in Cherrygrove is a town away, and for anything
   * happening on Route 29 or in New Bark this is next door. `HealParty` behind
   * a yes/no, the same as the nurse, so the presses are the same shape.
   */
  async healAtElm() {
    if (await this.mapKey() !== ELMS_LAB) {
      if (!await this.through(LAB_DOOR, ELMS_LAB)) return false;
    }
    await this.runScripts();
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.nav.walkTo(this.collision, ELM_HEAL_FROM, this.walkOpts);
      await this.nav.step('UP');
      await this.gb.press('A', 6, 12);
      await this.runScripts();          // "shall I heal them?" defaults to yes
      const s = await this.snap();
      if (s.party.length && s.party.every((m) => m.hp === m.maxHp)) break;
    }
    const s = await this.snap();
    const healed = s.party.length > 0 && s.party.every((m) => m.hp === m.maxHp);
    if (healed) this.say("healed at Elm's computer");
    await this.through(LAB_EXIT, NEW_BARK_TOWN);
    return healed;
  }

  /**
   * The nearer of the two places that will heal.
   *
   * Elm's lab is in New Bark, the Pokemon Center is in Cherrygrove, and Route
   * 29 runs between them -- so the answer flips depending on which end of that
   * route you are standing on, which is exactly the route the pilot spends its
   * time on.
   *
   * Counting legs alone gets this wrong, and wrong in the common case. By legs
   * the Center is one hop from Route 29 and the lab is two, so the Center wins
   * everywhere -- but a "hop" west means walking the whole sixty-tile width of
   * the route through grass, while the lab, from the eastern end where the
   * bootstrap leaves you, is six tiles and a door. So the cost is the tiles to
   * the edge we would actually leave by, plus a flat charge per further leg.
   */
  async nearestHeal(from) {
    const options = [
      { map: ELMS_LAB, heal: () => this.healAtElm() },
      { map: CHERRYGROVE_CITY, heal: () => this.heal() },
    ];
    const fallback = options[1];
    if (!this.world) return fallback;

    const wram = await this.settled();
    let best = null;
    for (const option of options) {
      if (from === option.map) return { ...option, cost: 0 };
      const route = this.world.route(from, option.map);
      if (route === null) continue;
      let cost = (route.length - 1) * LEG_COST;
      // How far to the edge this route leaves by. Only the first leg is
      // measurable from here -- the rest are charged flat.
      const first = route[0];
      if (wram && first && first.kind === 'edge') {
        const [w, h] = this.collision.mapSize();
        const at = this.collision.playerPos(wram);
        cost += { LEFT: at[0], RIGHT: w - 1 - at[0],
                  UP: at[1], DOWN: h - 1 - at[1] }[first.dir] ?? LEG_COST;
      }
      if (!best || cost < best.cost) best = { ...option, cost };
    }
    return best || fallback;
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

  /** Take a starter out of one of the three balls in Elm's lab. */
  /**
   * Hear Elm out, so the three balls become active.
   *
   * Split from picking one because choosing a starter is not the pilot's
   * business. It is the one decision in the opening that is actually a
   * decision, and a tool that plays the intro for you should hand it back
   * rather than answer it on your behalf.
   */
  async askElm() {
    await this.runScripts();                      // Elm greets you on the way in
    await this.nav.walkTo(this.collision, ELM_TALK_FROM, this.walkOpts);
    await this.nav.step('UP');
    await this.gb.press('A', 6, 12);
    await this.runScripts();
  }

  /** Stand in front of the balls, so the choice is one step away. */
  async waitAtTheTable() {
    await this.nav.walkTo(this.collision, [STARTER_BALL_X.totodile, 4],
                          this.walkOpts);
    await this.nav.step('UP');
  }

  async takeStarter(which) {
    const ballX = STARTER_BALL_X[which];
    if (ballX === undefined) {
      return `unknown starter ${which}`;
    }
    await this.askElm();

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
  /**
   * The legs from Elm's lab out to the grass.
   *
   * Separate because the pilot stops in between: with no starter named it hands
   * over at the table, and this is what finishes the job afterwards.
   */
  async toGrass() {
    const s = await this.snap();
    if (!s.party.length) {
      return { ok: false, party: [], message: 'pick a starter first' };
    }
    const legs = [
      ['back outside', async () =>
        await this.through(LAB_EXIT, NEW_BARK_TOWN)
          ? null : 'could not get out of the lab'],
      ['out to Route 29', async () =>
        await this.crossEdge('LEFT', ROUTE_29) ? null : 'could not reach Route 29'],
      ['finding grass', async () =>
        await this.findGrass() ? null : 'could not find a patch of grass'],
    ];
    return this.walkLegs(legs, async () => {
      const now = await this.snap();
      const lead = now.party[0];
      return { ok: true, party: now.party,
               message: lead
                 ? `ready on Route 29 with a Lv${lead.level} ${this.nameOf(lead)}`
                 : 'reached the grass, but with no Pokémon' };
    });
  }

  /**
   * Title screen to a starter in your hands.
   *
   * With no starter named it stops at the table and hands over: which of the
   * three you want is the one real decision in the opening, and answering it
   * for you is not the pilot's job. Name one and it plays straight through,
   * which is what the tests do.
   */
  async run(starter = null) {
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
    ];

    if (!starter) {
      legs.push(['hearing Elm out', async () => {
        await this.askElm();
        await this.waitAtTheTable();
        return null;
      }]);
      return this.walkLegs(legs, async () => ({
        ok: true, handover: true, party: [],
        message: 'your turn — pick a starter',
      }));
    }

    legs.push(
      [`taking ${starter}`, async () => this.takeStarter(starter)],
      ['back outside', async () =>
        await this.through(LAB_EXIT, NEW_BARK_TOWN)
          ? null : 'could not get out of the lab'],
      ['out to Route 29', async () =>
        await this.crossEdge('LEFT', ROUTE_29) ? null : 'could not reach Route 29'],
      ['finding grass', async () =>
        await this.findGrass() ? null : 'could not find a patch of grass'],
    );

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
        ? `ready on Route 29 with a Lv${lead.level} ${this.nameOf(lead)}`
        : 'reached the grass, but with no Pokémon',
    };
  }
}
