// Everything that is Pokemon Crystal rather than Pokemon Gen 2.
//
// Ten map ids and a name for each, the tiles of a dozen doors and people, the
// x positions of three balls on Elm's table, and the scripted errands built out
// of them: the intro, the trip to Mr. Pokemon's for the egg, and the two places
// that will heal a party.
//
// The file has two halves and they are different in kind. `crystal` below is
// *data* -- the shape the engine reads, and the whole of what a second title
// would have to declare. The class is *procedure*: knowing that Elm's healing
// machine is read by facing it, or that the nurse's question defaults to yes,
// is not something a table can hold.
//
// It extends Journey rather than composing one, for now, because that is the
// change that moves nothing: every `this.travelTo(...)` inside these methods
// still means what it meant when they shared a file. What it buys immediately is
// the arrow -- a title may know about the engine, and the engine may not know
// about a title -- and this file is the only place in the app that names a
// Crystal map.
//
// A hack of the same base game replaces this file and keeps the other one.
import { Journey } from '../gen2/journey.js';

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
// CherrygroveCity warp_events again: the Mart is the door west of the Center.
// Measured by reading Cherrygrove's own warp list off the cartridge -- five
// doors, and this is the one that leads to a room with a clerk in it.
const CHERRYGROVE_MART = key(26, 4);

// Violet City and the two places in it the pilot can use, found by reading the
// cartridge rather than a walkthrough: group 10's maps were scanned for the
// nurse sprite standing at (3,1) behind her counter and for a clerk at (1,3),
// and Violet City's own warp list says which door leads to each.
//
//   10.5   Violet City, one leg west of Route 31
//   10.10  its Pokemon Center, through the door at (31,25)
//   10.6   its Mart, through the door at (9,17)
//
// Both interiors are the standard ones -- the same nurse tile and the same
// counter geometry as Cherrygrove's, which is what makes one procedure serve
// every Center in the game.
const VIOLET_CITY = key(10, 5);
const VIOLET_POKECENTER = key(10, 10);
const VIOLET_MART = key(10, 6);
const VIOLET_GYM = key(10, 7);

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
  [CHERRYGROVE_MART]: "Cherrygrove's Mart",
  [MR_POKEMONS_HOUSE]: "Mr. Pokémon's house",
  [VIOLET_CITY]: 'Violet City',
  [VIOLET_POKECENTER]: "Violet's Pokémon Center",
  [VIOLET_MART]: "Violet's Mart",
  [VIOLET_GYM]: "Violet's Gym",
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


/**
 * Everything about this cartridge that the engine has to be told.
 *
 * The shape `Journey` reads, and the whole of what a second title would have to
 * write: names for the maps it works in, the places that heal and the method
 * that reaches each, the maps it knows have grass, and what a leg is worth when
 * two routes are being priced against each other.
 *
 * The values come from the constants above rather than being repeated here,
 * because the scripts below use the same ones -- the object is the engine's
 * interface to this file, not a second copy of it.
 */
export const crystal = {
  id: 'crystal',
  names: MAP_NAMES,
  // Most general last: nearestHeal falls back to the final entry when there is
  // no map graph to price them with, and the Center is the answer that works
  // from anywhere the Pokedex has been earned.
  // A healer is now a *place*, not a procedure with a place baked into it.
  // `heal()` was Cherrygrove's: it checked it was standing on Cherrygrove City,
  // went through Cherrygrove's door to Cherrygrove's Center, and left via
  // Cherrygrove. Adding a second Center would have meant a second copy of all
  // of that, which is the thing this file exists to avoid -- so the coordinates
  // moved into the data and `healAtCenter` reads them.
  //
  // `inside` is the Center's own map, `door` the tile in `map` that leads to
  // it, and `nurse` where she stands. Every Center in the game shares the last
  // one, which is why it is here once per healer rather than once per file: a
  // hack that moved her changes the entry, not the procedure.
  healers: [
    { map: ELMS_LAB, reach: 'healAtElm' },
    { map: CHERRYGROVE_CITY, reach: 'healAtCenter',
      inside: CHERRYGROVE_POKECENTER, door: POKECENTER_DOOR, nurse: NURSE },
    { map: VIOLET_CITY, reach: 'healAtCenter',
      inside: VIOLET_POKECENTER, door: [31, 25], nurse: NURSE },
  ],
  // Where the badges are, and what each one opens. **Declared rather than
  // discovered, and that is a measured decision rather than a gap.** A sweep of
  // all 349 maps that carry objects found the gym guide's sprite -- 72 -- on
  // twenty-four of them, and only about sixteen are Gyms: the Radio Tower, the
  // Slowpoke Well and the Power Plant all have one too. Narrowing by where he
  // stands (three rows up from the bottom wall, beside the door) gets fourteen
  // Gyms and still lets in the Seafoam Islands and a Cerulean house, and misses
  // Saffron.
  //
  // Which is not narrow enough to walk into. The Centers and the Marts were
  // declared here for thirty passes before a signature good enough to trust
  // turned up -- 21 of 23 and 13 of 26, with the misses costing nothing -- and
  // this is the same bar, not yet met. See docs/CODE.md.
  //
  // `badge` is the bit `wJohtoBadges` sets when the leader loses. Measured:
  // Falkner sets bit 0. Which bit means which badge is a fact about the story,
  // so it belongs here; counting the bits is the engine's job.
  gyms: [
    { map: VIOLET_CITY, inside: VIOLET_GYM, door: [18, 17],
      leader: 'FALKNER', badge: 0, opens: 'the road south out of Violet' },
  ],
  grassyMaps: [ROUTE_29, ROUTE_30, ROUTE_31],
  // Where things can be bought, and how to get to the counter.
  //
  // `stand` and `face` rather than the clerk's own tile, because a mart counter
  // is a *wall*: measured in Cherrygrove, the clerk sits at (1,3) and the only
  // place you can talk to it from is (3,3) facing LEFT -- two tiles away, across
  // a corner. Which is why this is declared per mart rather than derived from
  // the clerk's position the way a healer's is.
  marts: [
    { map: CHERRYGROVE_MART, from: CHERRYGROVE_CITY, door: [23, 3],
      stand: [3, 3], face: 'LEFT' },
    // Violet's, and the same counter geometry: the clerk is at (1,3) here too,
    // read off the map's own object list, so the tile you can talk to it from
    // is the same one.
    { map: VIOLET_MART, from: VIOLET_CITY, door: [9, 17],
      stand: [3, 3], face: 'LEFT' },
  ],
  // What in the bag mends a Pokemon, weakest first, matched by folded name.
  //
  // Names rather than ids, and here rather than in the engine profile, for the
  // reason the encounter tables are here: an id is layout and a name is
  // content, and content is what a hack changes. Matched through `normalise`,
  // the same fold the ball preference uses, so POKe and case cost nothing.
  //
  // Weakest first because the pilot should spend the cheapest thing that will
  // do -- the same rule as never throwing a Master Ball at a Rattata. BERRY is
  // on the list and is first: it restores ten HP in Gen 2, it grows back on the
  // trees the Take row now finds, and it is the one healing item this game hands
  // you for free.
  heals: ['berry', 'potion', 'fresh water', 'soda pop', 'lemonade',
          'moomoo milk', 'super potion', 'hyper potion', 'max potion',
          'full restore'],
  // What cures what, by status key and item name, weakest first.
  //
  // Names and here, for the same reason `heals` is: an item id is layout and an
  // item name is content. The specific cure comes before the general one in
  // every list, so a FULL HEAL is not spent on a poisoning an ANTIDOTE would
  // have fixed -- the ball preference's rule again, in a third pocket.
  //
  // The berries are first where there is one, because Crystal grows them on the
  // trees the Take row finds: PSNCUREBERRY on Route 30, and BURNT BERRY,
  // ICE BERRY, PRZCUREBERRY and MINT BERRY elsewhere.
  cures: {
    psn: ['psncureberry', 'antidote', 'full heal', 'full restore'],
    par: ['przcureberry', 'parlyz heal', 'full heal', 'full restore'],
    brn: ['burnt berry', 'burn heal', 'full heal', 'full restore'],
    frz: ['ice berry', 'ice heal', 'full heal', 'full restore'],
    slp: ['mint berry', 'awakening', 'full heal', 'full restore'],
  },
  // What the game *says*, for the two or three moments a number cannot answer.
  //
  // Words, so they are content and belong here rather than in the engine
  // profile -- the same rule `heals` and `cures` follow. A hack in another
  // language changes these and nothing else about the feature.
  //
  // `boxed` is the one that earns its keep. **A full party does not stop a
  // catch**: measured with six carried, "Gotcha! PIDGEY was caught!", then the
  // nickname question, then "AAAAAAAAAA was sent to BILL's PC." -- the party
  // never moved off six and one ball left the bag. So a catch that goes to the
  // box looks exactly like one that got away, and this phrase is the only thing
  // that tells them apart. Matched folded to letters, on one line, so the
  // apostrophe glyph and the line break after "was" cost nothing.
  phrases: {
    boxed: 'sent to BILL',
  },

  // Every map, tile and door the scripts below walk to.
  //
  // They read these from the profile rather than closing over the constants,
  // and the reason is a second profile: a title that extends this one inherits
  // its procedures, and a script that reads a module constant ignores the
  // subclass's data entirely. The scripts looked partial and were secretly
  // total -- crystal-early declares two map names and `run()` still walked to
  // Crystal's New Bark, because that name was in the function rather than in
  // the description.
  places: {
    aideTile: AIDE_TILE,
    cherrygroveCity: CHERRYGROVE_CITY,
    cherrygrovePokecenter: CHERRYGROVE_POKECENTER,
    elmsLab: ELMS_LAB,
    elmHealFrom: ELM_HEAL_FROM,
    elmTalkFrom: ELM_TALK_FROM,
    frontDoor: FRONT_DOOR,
    labDoor: LAB_DOOR,
    labExit: LAB_EXIT,
    mrPokemon: MR_POKEMON,
    mrPokemonsHouse: MR_POKEMONS_HOUSE,
    mrPokemonDoor: MR_POKEMON_DOOR,
    mrPokemonExit: MR_POKEMON_EXIT,
    newBarkTown: NEW_BARK_TOWN,
    nurse: NURSE,
    playersHouse1f: PLAYERS_HOUSE_1F,
    pokecenterDoor: POKECENTER_DOOR,
    route29: ROUTE_29,
    route30: ROUTE_30,
    route31: ROUTE_31,
    violetCity: VIOLET_CITY,
    route31Ball: ROUTE_31_BALL,
    stairsDown: STAIRS_DOWN,
    starterBallX: STARTER_BALL_X,
  },
  // Which regions this cartridge has. romdata reads whichever of these the
  // symbol file knows about, so this is the one place a hack with different
  // regions has to say so.
  encounters: ['JohtoGrassWildMons', 'KantoGrassWildMons'],
  legCost: LEG_COST,
};

export class Crystal extends Journey {
  constructor(gb, state, tasks, collision, nav, say, world) {
    super(gb, state, tasks, collision, nav, say, world, crystal);
  }

  /**
   * Heal at the computer in Elm's lab.
   *
   * Available from the moment you have a starter, which is the whole point:
   * the Pokemon Center in Cherrygrove is a town away, and for anything
   * happening on Route 29 or in New Bark this is next door. `HealParty` behind
   * a yes/no, the same as the nurse, so the presses are the same shape.
   */
  async healAtElm() {
    const p = this.title.places;
    if (await this.mapKey() !== p.elmsLab) {
      if (!await this.through(p.labDoor, p.elmsLab)) return false;
    }
    await this.runScripts();
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.nav.walkTo(this.collision, p.elmHealFrom, this.walkOpts);
      await this.nav.step('UP');
      await this.gb.press('A', 6, 12);
      await this.runScripts();          // "shall I heal them?" defaults to yes
      const s = await this.snap();
      if (s.party.length && s.party.every((m) => m.hp === m.maxHp)) break;
    }
    const s = await this.snap();
    const healed = s.party.length > 0 && s.party.every((m) => m.hp === m.maxHp);
    if (healed) this.say("healed at Elm's computer");
    await this.through(p.labExit, p.newBarkTown);
    return healed;
  }



  /**
   * Heal at Cherrygrove's Pokémon Center.
   *
   * The nurse stands behind a counter, so the approach is from two tiles below
   * and then one -- the same way the desktop pilot does it, and the same way a
   * person would. Her question defaults to yes, which is the answer we want.
   */
  /**
   * Heal at a Pokémon Center, whichever one the entry names.
   *
   * This was `heal()`, and it was Cherrygrove's: the map it checked for, the
   * door it went through, the Center it expected and the town it left by were
   * all constants in the body. A second Center would have been a second copy of
   * all of it -- so the four became fields of the healer entry and the
   * procedure reads them. `nearestHeal` hands the entry in.
   *
   * The nurse is a *counter*, like a mart clerk: she stands at (3,1) with a
   * wall in front of her, so the approach is two tiles below and then one, and
   * the press goes UP into it. Walked in two steps rather than one because the
   * room is small and the first tile is often occupied by somebody waiting.
   *
   * Three attempts, and the party's HP is the evidence -- not the presses
   * landing. Her question defaults to yes, so `runScripts` answers it.
   */
  async healAtCenter(h) {
    if (!h || !h.inside || !h.door || !h.nurse) return false;
    if (await this.mapKey() !== h.map && await this.mapKey() !== h.inside) {
      return false;
    }
    if (await this.mapKey() !== h.inside) {
      if (!await this.through(h.door, h.inside)) return false;
    }
    await this.runScripts();
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.nav.walkTo(this.collision, [h.nurse[0], h.nurse[1] + 2],
                            this.walkOpts);
      await this.nav.walkTo(this.collision, [h.nurse[0], h.nurse[1] + 1],
                            this.walkOpts);
      await this.nav.step('UP');
      await this.gb.press('A', 6, 12);
      await this.runScripts();
      const s = await this.snap();
      if (s.party.length && s.party.every((m) => m.hp === m.maxHp)) break;
    }
    const healed = (await this.snap()).party.every((m) => m.hp === m.maxHp);
    if (healed) this.say(`healed at ${this.where(h.map)}`);
    await this.leaveVia(h.map);
    return healed;
  }

  async fetchBall() {
    const p = this.title.places;
    const legs = [
      ['west to Cherrygrove', async () =>
        await this.crossEdge('LEFT', p.cherrygroveCity) ? null : 'could not leave Route 29'],
      // `healNow` rather than a named Center: it prices every healer this
      // title declares and walks to the nearest, which is what the errand
      // wanted all along and could not ask for while `heal()` meant one town.
      ['healing up', async () => { await this.healNow(); return null; }],
      ['north to Route 30', async () =>
        await this.crossEdge('UP', p.route30) ? null : 'could not reach Route 30'],
      ['north to Route 31', async () =>
        await this.crossEdge('UP', p.route31) ? null : 'could not reach Route 31'],
      ['picking the ball up', async () => this.pickUp(p.route31Ball)],
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
    const p = this.title.places;
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
    const north = await this.travelTo(p.route30);
    if (!north.ok) return fail(`could not reach Route 30 (${north.message})`);
    trail.push('Route 30');

    this.say("to Mr. Pokémon's house");
    if (!await this.through(p.mrPokemonDoor, p.mrPokemonsHouse)) {
      return fail(`could not get in the door (in ${this.where(await this.mapKey())})`);
    }
    trail.push("Mr. Pokémon's house");

    // He hands the egg over across the counter, and Elm phones straight after,
    // so the text runs well past the point where the egg is already ours.
    this.say('collecting the egg');
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.nav.walkTo(this.collision, [p.mrPokemon[0], p.mrPokemon[1] + 1], this.walkOpts);
      await this.nav.step('UP');
      await this.gb.press('A', 6, 12);
      await this.runScripts();
      if (await this.mapKey() !== p.mrPokemonsHouse) break;   // shoved outside
      if (attempt === 0) continue;                            // Oak talks too
      break;
    }
    trail.push('egg');

    if (await this.mapKey() === p.mrPokemonsHouse) {
      this.say('back outside');
      if (!await this.through(p.mrPokemonExit, p.route30)) {
        return fail('could not leave the house');
      }
    }

    // The rival is waiting in Cherrygrove, on the coord_event at (33, 6) and
    // (33, 7) that fires walking east -- so heal first, on the way past.
    this.say('healing before the rival');
    if (await this.healUp()) trail.push('healed');

    this.say('home to New Bark');
    const home = await this.travelTo(p.newBarkTown);
    if (!home.ok) return fail(`could not get home (${home.message})`);
    trail.push('New Bark Town');

    this.say("into Elm's lab");
    if (!await this.through(p.labDoor, p.elmsLab)) {
      return fail(`could not get into the lab (in ${this.where(await this.mapKey())})`);
    }
    trail.push("Elm's lab");

    // The theft is discovered on the way in, which is a scene rather than
    // anything to steer, and then Elm takes the egg.
    await this.runScripts();
    this.say('handing the egg over');
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.nav.walkTo(this.collision, p.elmTalkFrom, this.walkOpts);
      await this.nav.step('UP');
      await this.gb.press('A', 6, 12);
      await this.runScripts();
    }

    // Nothing to talk to here: the aide comes over when you stand on his tile.
    this.say('collecting the balls');
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.nav.walkTo(this.collision, p.aideTile, this.walkOpts);
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
    const p = this.title.places;
    await this.runScripts();                      // Elm greets you on the way in
    await this.nav.walkTo(this.collision, p.elmTalkFrom, this.walkOpts);
    await this.nav.step('UP');
    await this.gb.press('A', 6, 12);
    await this.runScripts();
  }

  /** Stand in front of the balls, so the choice is one step away. */
  async waitAtTheTable() {
    const p = this.title.places;
    await this.nav.walkTo(this.collision, [p.starterBallX.totodile, 4],
                          this.walkOpts);
    await this.nav.step('UP');
  }

  async takeStarter(which) {
    const p = this.title.places;
    const ballX = p.starterBallX[which];
    if (ballX === undefined) {
      return `unknown starter ${which}`;
    }
    await this.askElm();

    for (let attempt = 0; attempt < 3; attempt++) {
      await this.nav.walkTo(this.collision, [ballX, 4], this.walkOpts);
      await this.nav.step('UP');
      await this.gb.press('A', 6, 12);
      // Two questions on the way out, and A is right for only one of them.
      // "Do you want CYNDAQUIL, the fire POKeMON?" wants yes, which is what
      // pressing through gives -- so the pressing runs until the Pokemon is
      // ours and stops there. "Give a nickname to the CYNDAQUIL you received?"
      // wants no, and B on it is the game's own name for the thing.
      //
      // For twenty-eight passes this was one `runScripts` that answered both,
      // walked into the naming screen and typed the letter under the cursor:
      // every starter this app took was called AAAAAAAAAA.
      await this.runUntilParty();
      await this.takeDefaultName();
      await this.runScripts();
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
    const p = this.title.places;
    const s = await this.snap();
    if (!s.party.length) {
      return { ok: false, party: [], message: 'pick a starter first' };
    }
    const legs = [
      ['back outside', async () =>
        await this.through(p.labExit, p.newBarkTown)
          ? null : 'could not get out of the lab'],
      ['out to Route 29', async () =>
        await this.crossEdge('LEFT', p.route29) ? null : 'could not reach Route 29'],
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
    const p = this.title.places;
    const legs = [
      ['starting a new game', async () => {
        if (await this.tasks.continueGame()) return null;
        return 'never reached the overworld — is this a Crystal ROM?';
      }],
      ['going downstairs', async () =>
        await this.through(p.stairsDown, p.playersHouse1f)
          ? null : 'could not find the stairs'],
      ['out of the house', async () =>
        await this.through(p.frontDoor, p.newBarkTown)
          ? null : 'could not get out of the house'],
      ["into Elm's lab", async () =>
        await this.through(p.labDoor, p.elmsLab) ? null : 'could not get into the lab'],
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
        await this.through(p.labExit, p.newBarkTown)
          ? null : 'could not get out of the lab'],
      ['out to Route 29', async () =>
        await this.crossEdge('LEFT', p.route29) ? null : 'could not reach Route 29'],
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
