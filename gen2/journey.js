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
import { World } from './world.js';

// How many times a pickup starts over -- each one escapes whatever is on screen
// and re-reads the map before choosing a side again -- and how many empty
// presses are enough to believe there is nothing there. Six, because a walk
// across a route is interrupted several times: the number is this app's patience
// rather than a fact about the cartridge, which is why it is here and not in the
// engine profile.
const PICKUP_TRIES = 6, EMPTY_PRESSES = 2;
// How many healing items one Pokemon is worth before giving up on it. A Potion
// is 20 HP and a Pokemon at Lv30 has more than 60, so one is often not enough;
// four is where this stops asking and lets the walk to a Center answer instead.
const BAG_HEALS_PER_MON = 4;
// Steps for a walk that crosses a map. Route 30 is fifty-four tiles top to bottom.
const LONG_WALK_STEPS = 260;

// How far out to look for places worth offering. The graph reaches hundreds of
// maps, and a list of two hundred rows is not an offer -- six legs is about as
// far as any job walks in one press.
const OFFER_LEGS = 6, OFFER_MOST = 24;

// How far to look through doors for a Center or a Mart. Shorter than the offer
// list's reach: a walk to heal is a detour from whatever the pilot was doing,
// and three legs is about as far as that is worth going.
const DISCOVER_LEGS = 3;

// How many wild encounters one walk to a door will fight or flee before giving
// up. Generous, because each one costs an escape and the walk carries on from
// where it stopped: Route 32 is ninety tiles of grass and the Center's door is
// ninety-six steps from its north end.
const THROUGH_BATTLES = 40;

// How many times a walk will be turned back by somebody talking before it
// concludes that the way is *shut* rather than busy. Two, because one is an
// ordinary greeting and the second is a pattern.
const THROUGH_TURNS = 2;

// How many refused legs one walk will write off before giving up. The `avoid`
// set already terminates over a finite graph; this is the bound for a graph
// nobody has seen, and it is generous because a refusal costs one crossing
// attempt rather than a walk.
const MAX_REFUSALS = 20;

// What `pickUp` answers with when it did not come away with anything. Named,
// because `takeHere` has to tell them apart: the first is what an item ball
// somebody already took looks like -- the object stays in work RAM once the
// item is in the bag -- and the second is a walk that failed.
// A duel: how many times to try reaching somebody, how long to press through
// their opening text, and how many turns to give the fight.
//
// The taps are the reason this is not one press: a trainer talked to answers
// with a box and then an exclamation mark and then walks over, and a trainer
// who spots you does all of that without being asked. Either way the battle
// arrives several boxes after the button -- so this presses, then waits for
// what it expected, which is the one lesson every menu in this app learned the
// hard way.
const DUEL_TRIES = 6, DUEL_START_TAPS = 40, DUEL_TURNS = 60;

// Rounds `clearHere` allows beyond the number of trainers the map placed. Not
// nought, because a trainer can decline once and answer the next time -- and
// not large, because every wasted round is a walk across a map.
const CLEAR_SLACK = 3;

// Reaching the nickname question: how many presses to spend getting there, and
// how long to let the screen settle between them. The text ahead of it is two
// pages, so a handful is plenty -- and each poll is cheap because it is a read
// rather than a press.
const NAME_TRIES = 12, NAME_SETTLE = 20;

const NOTHING_THERE = 'nothing there to take';
const OUT_OF_REACH = 'could not get to it';

/**
 * The whole bag as `id -> quantity`, both pockets.
 *
 * Both, because what you pick up off a map lands in either one and the app had
 * only ever read the balls -- which is how "the ball would not go in the bag"
 * came to be said about a berry that had.
 */
function bagCount(s) {
  const out = new Map();
  for (const [id, n] of [...(s.items || []), ...(s.balls || [])]) {
    out.set(id, (out.get(id) || 0) + n);
  }
  return out;
}

/** Which ids went up between two readings of the bag. */
function arrived(before, after) {
  const got = [];
  for (const [id, n] of after) if (n > (before.get(id) || 0)) got.push(id);
  return got;
}

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

  /**
   * Legs the game itself has refused, and what it said while refusing.
   *
   * **A route can be shut, and no map data says so.** Route 32's Pokemon Center
   * is real, its door is real, and the ninety-six-step path to it is real; a man
   * two tiles south of Violet turns the player back until Falkner is beaten, and
   * that rule lives in a script. The pass before this one taught the walk to
   * *quote* him. This is the pilot doing something about it: a leg that turned
   * it back is written off, so the next question -- where is the nearest place I
   * can heal? -- gets an answer it can act on instead of the same wall again.
   *
   * Keyed by leg rather than by destination, because *shut from here* is what
   * was measured. The same Center may well be open from the south.
   *
   * Written off is not forgotten: each entry remembers the badge count at the
   * time, and a badge is precisely the thing that opens one of these. Win one
   * and every write-off is re-opened, because the pilot has no idea which badge
   * opened which route and guessing would be worse than asking again.
   */
  get shut() {
    if (!this._shut) this._shut = new Map();
    return this._shut;
  }

  /** Write off a leg, with the words that closed it and the badges then held. */
  shutLeg(from, to, said, badges) {
    this.shut.set(World.leg(from, to), { said, badges });
  }

  /**
   * Throw away every write-off that a badge since has earned another try.
   *
   * **Its own sweep rather than a side effect of asking.** The predicate used
   * to delete the entry it was asked about, which made a question that reads
   * pure into a write -- and one caller iterates `shut` while asking, so it was
   * deleting from a Map it was walking. Safe in JavaScript today and exactly
   * the kind of thing that stops being safe when somebody adds a second loop.
   *
   * `badges` is null on a cartridge whose symbol file will not say, and then
   * nothing ever expires -- the safe way round. Believing a stale write-off
   * costs one walk that would have worked; forgetting a real one costs the same
   * walk over and over.
   */
  reopen(badges) {
    // No early return for a null count, and that is deliberate rather than an
    // omission. `null > 0` and `undefined > 0` are both false, so the
    // comparison below already refuses to expire anything when the cartridge
    // cannot say -- and `tools/mutate` proved the guard was unreachable by
    // surviving every mutation of it. A line nothing can distinguish is a
    // second way to say one thing, which is what the checks here exist to stop.
    let gone = 0;
    for (const [leg, at] of [...this.shut]) {
      if (at.badges !== null && at.badges !== undefined && badges > at.badges) {
        this.shut.delete(leg);
        gone++;
      }
    }
    return gone;
  }

  /**
   * Is this leg one the game has refused?
   *
   * A question, and only a question: call `reopen` first if the badges may have
   * changed since. Two steps rather than one because the sweep is per *session*
   * and this is asked per *place* -- folding them together meant a list of six
   * healers swept six times, and a predicate that wrote.
   */
  isShut(from, to) {
    return this.shut.has(World.leg(from, to));
  }

  /**
   * The room a place's door leads into, or null where it has no door.
   *
   * **The two lists of places name their two maps the opposite way round**, and
   * this exists because guessing at the field names got it wrong twice in one
   * afternoon:
   *
   *     healers   { map: the town,  inside: the room }
   *     marts     { from: the town, map: the room }
   *
   * So `place.map` is a town in one list and a room in the other, and the only
   * reliable tell is which *other* field the entry carries. Named here rather
   * than fixed in the profiles because both shapes are declared data somebody
   * may already have written, and a reader that copes is cheaper than a
   * migration -- but the asymmetry is a wart, and this comment is where it is
   * admitted rather than worked around silently.
   */
  static doorTo(place) {
    if (place.inside !== undefined) return place.inside;
    if (place.from !== undefined) return place.map;
    return null;
  }

  /**
   * Is the way from here into this *place* shut?
   *
   * **The leg a place is reached by is not the leg it sits on**, and getting
   * that wrong is how the first version of this feature came to do nothing at
   * all on a real cartridge. Route 32 is 2561 and its Pokemon Center is 2573;
   * `healAtCenter` walks `through(door, inside)`, so the leg written off is
   * `2561>2573`. The filter was asking about `2561>2561`, which nothing writes.
   *
   * It read correctly, it passed a test, and the test passed because the fake
   * healer had been written to match the mistake: one map, no `inside`. Which
   * is the whole argument for driving a feature against the cartridge before
   * believing it.
   *
   * Two questions, because a place has two ways of being out of reach: the road
   * to the town, and the door once you are standing in it.
   */
  shutBetween(from, place, mapOf = (p) => p.map) {
    const outside = mapOf(place);
    const door = Journey.doorTo(place);
    if (door !== null && this.isShut(outside, door)) return true;
    return this.isShut(from, outside);
  }

  /**
   * Did the party get knocked out between these two snapshots?
   *
   * **Money is the evidence, and it is the only evidence there is.** A whiteout
   * in Gen 2 heals the party, moves the player to the last Pokemon Center and
   * takes half the wallet -- so afterwards the HP is *full*, the map is a place
   * you might well have been walking to anyway, and every other reading looks
   * like success.
   *
   * Which is not hypothetical. Measured: `healNow` was asked to mend a lead at
   * 9 of 24, the walk to Violet met something it could not run from, the party
   * fainted, and the job reported **healed one Pokémon at Violet City** with
   * half the money gone. It was not wrong about the HP. It was wrong about what
   * had happened, and the only trace was a wallet that had gone from 3136 to
   * 1568.
   *
   * A job that spends money has to ask this before it spends any, because a
   * purchase looks the same from here. `restock` does its own accounting.
   */
  knockedOut(before, after) {
    return !!(before && after && (after.money || 0) < (before.money || 0));
  }

  /**
   * What the screen is saying, or '' when this cartridge cannot say.
   *
   * A cartridge whose symbol file does not name the tilemap has no words to
   * read, and neither has a Journey driving nothing but a graph -- so both
   * answer the same way, and every caller can append the result
   * unconditionally. Which is the point: the two places that ask *did somebody
   * just say no* should not each carry their own guard.
   */
  async wordsOnScreen(lines = 2) {
    if (!this.tasks || !this.tasks.screenSaid) return '';
    return await this.tasks.screenSaid(lines) || '';
  }

  /** What closed this leg, for a row that has to explain itself. */
  shutSaid(from, to) {
    const at = this.shut.get(World.leg(from, to));
    return at ? at.said : null;
  }

  /** The option bag every walk in here takes, so Stop reaches inside them. */
  get walkOpts() { return { cancelled: () => this.stopped }; }

  /**
   * Walking across a map rather than across a room.
   *
   * `walkTo` defaults to eighty steps, which is a plan inside a building. Every
   * leg of a journey needs more, and the number was written out at four call
   * sites -- so the fifth, the approach to something lying on the ground, was
   * given the default by omission and would have run out of steps on a route.
   * Running out reads as the tile refusing rather than as the walk being cut
   * short, which is the sort of wrong answer that gets believed.
   */
  get longWalk() { return { maxSteps: LONG_WALK_STEPS, ...this.walkOpts }; }
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
    const named = this.title.names && this.title.names[k];
    if (named) return named;
    // Then the cartridge's own name for the place. Every map header carries a
    // landmark id and `Landmarks` is a table of names, so the game knows what
    // to call all two hundred and fifty of its maps -- and until this pass the
    // app used the ten a title had written down and said "map 26.1" for the
    // rest. The title still wins, because a hand-written name can be *better*:
    // "Elm's lab" against the cartridge's "NEW BARK TOWN", which is the town
    // the lab is in.
    const own = this.landmarkName(k);
    return own || `map ${k >> 8}.${k & 0xff}`;
  }

  /**
   * What the cartridge calls the landmark a map sits in, or ''.
   *
   * Two readers, in the two modules that own the halves: the world graph reads
   * the map header, because it already parses one, and romdata reads the name
   * table, because it already decodes the game's text. Nothing here knows how
   * either is laid out.
   */
  landmarkName(k) {
    const rom = this.tasks && this.tasks.rom;
    if (!rom || !rom.landmarkName) return '';
    // A graph that cannot read a map header is one this cannot ask. Guarded
    // rather than assumed, because half the world stubs in this app answer one
    // question and not the others -- and a name is the one thing every log line
    // asks for, so a throw here would take a whole job down.
    if (!this.world || typeof this.world.landmarkOf !== 'function') return '';
    const id = this.world.landmarkOf(k >> 8, k & 0xff);
    if (!id) return '';                 // 0 is SPECIAL, which names nothing
    return rom.landmarkName(id);
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
  /**
   * Press through a script, and stop the moment the party grows.
   *
   * Half of the fix for a starter's name, and the half that decides *which*
   * question is being answered. Gen 2 asks two on the way out of the lab and A
   * is right for only one of them: "Do you want CYNDAQUIL, the fire POKeMON?"
   * wants yes, and "Give a nickname to the CYNDAQUIL you received?" wants no.
   * The party growing is the line between them -- the Pokemon is ours, so the
   * next box is the one that must not be pressed through. `watchThrow` has used
   * that same signal to decline the same box since catching worked.
   */
  async runUntilParty(maxTaps = 400, settle = 45) {
    const before = (await this.snap()).party.length;
    for (let i = 0; i < maxTaps; i++) {
      if (this.stopped) return false;
      // Before the press, not after: the whole point is that the press which
      // would follow is the one the next question receives.
      if ((await this.snap()).party.length > before) return true;
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
   * Take the game's own name for a Pokemon it has just handed over.
   *
   * The other half, and the whole of it is one button. **B on the nickname
   * question is the default species name** -- measured, by pausing a new game
   * on that box and pressing it: `wPartyMon1Nickname` went from ten 'A's to
   * `82 98 8d 83 80 90 94 88 8b 50` — CYNDAQUIL.
   *
   * Getting *to* the box is the part five earlier attempts got wrong, and the
   * trace says why. When the party grows the question's text has barely begun
   * -- the screen reads `G` -- and it then **stops and waits for a button**
   * with `wWindowStackSize` reading zero. One press finishes it and draws the
   * choice, which is up and stable from that frame on. So an A press issued
   * the instant the party grows only hurries the text, and a look taken
   * straight afterwards sees no box and gives up; that is exactly what
   * `declineNickname` did, twelve runs in a row.
   *
   * Which makes this a loop rather than a sequence: press A, look, and press B
   * the moment a choice is on screen. Every A lands on text and every B lands
   * on the box, whatever the timing.
   *
   * The box is identified by both halves where the screen can be read -- a
   * window open *and* YES and NO on it -- because a window open on its own is
   * also true of the text that precedes it on some boxes. A cartridge whose
   * tilemap cannot be read falls back to the window alone, which is what this
   * had before there was anything better.
   */
  async takeDefaultName(tries = NAME_TRIES) {
    const kept = await this.tasks.keepDefaultName(tries);
    if (kept) this.say('keeping the name the game gave it');
    return kept;
  }

  async runScripts(maxTaps = 400, settle = 45) {
    // **This presses A, and A answers questions.** Which is deliberate -- the
    // intro's gender prompt and the ball's "do you want this one?" are both
    // answered here, and both want yes -- and it is a hazard everywhere else,
    // because the game puts questions up that yes is the wrong answer to.
    //
    // Measured, at a cost: left standing at a mart counter with "1 POKé BALL
    // will be ¥200. OK?" on screen, this bought one every time a job ran, and
    // the wallet went 3000 to 100. The callers that walk close a conversation
    // with B before reaching here -- see `through` -- and any new caller that
    // might run with a menu open should do the same rather than press into it.
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
    // **A battle is not a try.** It is progress-neutral and not a failure: the
    // walk got partway and something jumped out, and asking again from where it
    // stopped converges. Counting it made the budget a function of the grass
    // rather than of the door -- measured the pass discovered places can be far
    // away, the Pokemon Center on Route 32 is ninety-six steps down a
    // ninety-tile route, and eight tries never got near it. `travelTo` learned
    // the same thing about a refused leg one pass earlier.
    let fought = 0, turned = 0;
    this.turnedBack = null;
    for (let i = 0; i < tries && fought < THROUGH_BATTLES;) {
      if (this.stopped) return false;
      const from = await this.mapKey();
      if (from === expect) return true;
      // A window in the way is not a door that will not open, and until this
      // pass every caller was told it was. Measured: left standing at a mart
      // counter with the clerk's confirmation up, `travelTo` reported *could
      // not get through to Cherrygrove City* eight times over -- and the
      // `runScripts` below pressed A into that box on every one of them, which
      // is how a wallet went from 3000 to 100 in Poké Balls nobody asked for.
      //
      // Backed out with B rather than pressed through with A, which is the
      // whole point: A answers a question and B declines it, and a walk has no
      // business answering anything.
      if ((await this.snap()).windowOpen) {
        this.say('closing what is on screen first');
        await this.tasks.closeConversation();
      }
      // A doorway is not always across a room. Mr. Pokémon's is at the top of
      // Route 30 and the walk to it starts fifty tiles south, through grass --
      // so the budget is a route's, not a room's, and whatever jumps out on the
      // way is dealt with rather than counted as the door being unreachable.
      await this.escapeBattle();
      const res = await this.nav.walkTo(this.collision, goal, this.longWalk);
      if (res.stopped === 'battle') { fought++; continue; }
      i++;
      if (await this.mapKey() === expect) return true;
      if (res.stopped === 'refused') {
        // **A refusal with words on the screen is somebody talking**, and the
        // words are usually the reason. `walkTo` reports `refused` when every
        // direction is blocked, which is what a running script looks like from
        // the outside -- and the pilot used to answer that by pressing A and
        // walking at the same tile eight times over.
        //
        // Measured on Route 32, where the first Pokémon Center the pilot ever
        // *found* rather than was told about turned out to be behind a story
        // gate: walk two tiles south of Violet and a man says "Wait up! What's
        // the hurry? Have you gone to the POKéMON GYM?" and puts you back where
        // you started. The door is real, the ninety-six-step path to it is
        // real, and the game will not let anyone down that route without
        // Falkner's badge. Eight identical attempts and *could not heal* is the
        // worst possible answer to that: it blames the pilot's own walking for
        // a rule of the game, and the screen said so in words the whole time.
        const said = await this.wordsOnScreen();
        await this.runScripts();
        if (said) {
          this.turnedBack = said;
          if (++turned >= THROUGH_TURNS) {
            // Written off, so the *next* question gets a usable answer rather
            // than this same wall. See `shut`.
            this.shutLeg(from, expect, said, (await this.snap()).badges);
            this.say(`turned back: ${said}`);
            return false;
          }
        }
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
    this.turnedBack = null;
    // **Somebody saying no, counted rather than repeated.** A refusal out here
    // is usually a phone call or a passer-by, which is why the loops below
    // answer one by running the scripts and asking again. A *gate* answers the
    // same way and never stops: measured driving at Route 32's southern
    // connection with no badge, the pilot ground away for over two and a half
    // minutes -- twelve staged advances and then thirty attempts per opening,
    // each walking the length of a ninety-tile route -- and the job looked hung.
    //
    // So the words are read before `runScripts` presses them away, and the
    // second time the same thing happens this gives up and says who did it.
    // `through` learned this one pass earlier at the doorways; this is the same
    // rule at the edges, and `travelTo` reads `turnedBack` from either.
    let turned = 0;
    const refused = async () => {
      const said = await this.wordsOnScreen();
      await this.runScripts();
      if (!said) return false;
      this.turnedBack = said;
      return ++turned >= THROUGH_TURNS;
    };

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
      const res = await this.nav.walkTo(this.collision, goal, this.longWalk);
      if (await this.mapKey() !== from) return await this.mapKey() === expect;
      // "Refused" means the game stopped taking walking input, which out here
      // is almost always somebody talking: Elm phones the moment you leave
      // Mr. Pokémon's, and treating that as terrain ended the walk home.
      if (res.stopped === 'refused') {
        if (await refused()) return false;
        continue;
      }
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
        const res = await this.nav.walkTo(this.collision, tile, this.longWalk);
        // Walking to the edge can carry us over it, and that is the errand
        // done rather than a failure -- the walk reports it as a warp, which
        // an earlier version treated as a reason to give up on a crossing it
        // had just completed.
        if (await this.mapKey() !== from) return await this.mapKey() === expect;
        if (res.stopped === null) arrived = true;
        else if (res.stopped === 'refused') { if (await refused()) return false; }
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
    // Legs this walk has tried and could not take. **A route is shortest by
    // legs and knows nothing about a leg being hard**, and the two are not the
    // same thing: Route 29's connection struct says there is a map to the north
    // and there is -- Route 46 -- but the pilot cannot get up there, and naming
    // Violet City made that the shortest way to it. The walk refused UP three
    // times and this gave up, on a town that is four ordinary legs away.
    //
    // So a leg that will not go is written down and the route asked again
    // without it. Only ever grows, so this terminates: every failure removes an
    // edge from a finite graph, and when none is left the answer is honestly
    // that there is no way.
    // Held for the whole walk, because a knockout on the way is invisible from
    // the far end: full HP at a Center is what arriving looks like.
    const started = await this.snap();
    const avoid = new Set();
    // **Seeded with what earlier walks already learned.** A leg the game itself
    // refused -- a guard, a gate, a man who wants a badge first -- is refused
    // again on the next press, and re-discovering that costs a walk across a
    // route every time. `shut` only holds legs where something *said* no, and it
    // re-opens every one of them the moment a badge is won, so this is a head
    // start rather than a permanent belief.
    // Swept once, up front, rather than asked leg by leg -- which also means
    // the keys can be copied straight across instead of being parsed back into
    // a pair of map numbers and rebuilt.
    this.reopen((await this.snap()).badges);
    for (const leg of this.shut.keys()) avoid.add(leg);
    // **A refused leg is not a leg walked**, and counting it as one is how the
    // first walk to a landmark-only place failed: DARK CAVE is two legs from
    // Route 29 through Route 46, the pilot cannot get up there, and every
    // refusal spent one of the twelve until the budget ran out in Cherrygrove
    // with *too many legs*. So the budget counts arrivals and the refusals get
    // their own -- bounded because `avoid` only grows over a finite graph, and
    // capped as well so a graph nobody has seen cannot spin.
    let walked = 0, refused = 0;
    for (let step = 0; walked < maxLegs && refused < MAX_REFUSALS; step++) {
      if (this.stopped) return { ok: false, message: 'stopped' };
      const here = await this.mapKey();
      if (here === target) return this._arrived(started);
      const route = this.world.route(here, target, { avoid });
      if (route === null) {
        return {
          ok: false,
          message: avoid.size
            ? `no way from ${this.where(here)} to ${this.where(target)} that `
              + `this can walk (${avoid.size} leg(s) refused)`
            : `no way from ${this.where(here)} to ${this.where(target)}`,
        };
      }
      if (!route.length) return this._arrived(started);
      const next = route[0];
      if (next.kind === 'warp') {
        this.say(`through to ${this.where(next.key)}`);
        const before = here;
        if (!await this.through(next.tile, next.key)) {
          if (this.stopped) return { ok: false, message: 'stopped' };
          // Say what is actually in the way. A door that will not open and a
          // conversation that will not end are different things to go and look
          // at, and for eight tries this reported the first when it was the
          // second.
          const stuck = (await this.snap()).windowOpen
            ? ' — something is still on screen' : '';
          if (stuck) {
            return { ok: false,
                     message: `could not get through to ${this.where(next.key)}${stuck}` };
          }
          // A door that will not open is a leg to route around, the same as an
          // edge that will not cross.
          this.say(`no way through to ${this.where(next.key)} — trying another way`);
          avoid.add(World.leg(before, next.key));
          refused++;
          continue;
        }
        walked++;
        continue;
      }
      this.say(`heading ${next.dir.toLowerCase()}`);
      // A crossing can fail for reasons that pass: somebody is mid-conversation,
      // something jumped out at the wrong moment, a script took the controls.
      // Measured, the same leg failed on one run and worked on the next, so one
      // refusal is not an answer -- it is worth asking again from wherever we
      // ended up.
      let crossed = false;
      // **The words come from whoever was standing there, not from the screen
      // afterwards.** A gate script finishes: the man says his piece, moves the
      // player back and stops running -- so by the time the retries are done,
      // `runScripts` has pressed the whole conversation away and the tilemap is
      // blank. The first version of this asked here and found nothing, which is
      // a mechanism that reads correctly and does nothing at all.
      //
      // Both walks report it the same way instead: `crossEdge` and `through`
      // each read the screen on the refusal itself and leave the words in
      // `turnedBack`, so this has one thing to look at whichever kind of leg it
      // was -- and a gate stops the crossing early rather than being ground at
      // for two and a half minutes.
      let said = '';
      for (let go = 0; go < 3 && !crossed; go++) {
        if (go) {
          await this.escapeBattle();
          await this.runScripts();
          this.say(`trying ${next.dir.toLowerCase()} again`);
        }
        crossed = await this.crossEdge(next.dir, next.key);
        if (!crossed && !said) said = this.turnedBack || '';
        if (said) break;                      // somebody said no; asking again
        if (!crossed && await this.mapKey() !== here) break;   // somewhere new
      }
      if (!crossed && await this.mapKey() === here) {
        // Asked to stop is not the same as could not get there, and saying the
        // second when the user pressed the first blames the map for a decision
        // they made.
        if (this.stopped) return { ok: false, message: 'stopped' };
        // The same rule the doorways follow: an edge that will not go *while
        // something is on the screen* is somebody saying no, not a wall, and
        // the words are the reason. Written off so the next press asks for a
        // route without this leg in it rather than walking here again.
        if (said) {
          this.shutLeg(here, next.key, said, (await this.snap()).badges);
          this.say(`turned back: ${said}`);
        } else {
          this.say(`${next.dir.toLowerCase()} will not go — trying another way`);
        }
        avoid.add(World.leg(here, next.key));
        refused++;
        continue;
      }
      walked++;
    }
    // Arriving on the last leg of the budget is arriving. The check at the top
    // of the loop is the only one there was, so a walk that spent its whole
    // budget getting there reported *too many legs* from the doorstep -- found
    // by giving one exactly the legs it needed.
    if (await this.mapKey() === target) return this._arrived(started);
    return { ok: false, message: refused >= MAX_REFUSALS
      ? `gave up after ${refused} legs that would not go`
      : 'too many legs' };
  }

  /**
   * The places worth offering to walk to, from wherever we are.
   *
   * `travelTo` has been able to do this since the third step and nothing ever
   * asked it to: the interface could walk you across the map you were standing
   * on and no further, while the machinery for crossing the whole of Johto sat
   * behind Heal and the ball errand.
   *
   * Two decisions make the list worth showing, and both are about what this
   * layer can honestly know.
   *
   * **Only places the title has named.** The graph reaches everything walkable,
   * which on a real cartridge is hundreds of maps -- a list of `map 26.4` for
   * two hundred rows is not an offer, it is a data dump. A title's `names` are
   * exactly the places somebody chose to write down, so they are exactly the
   * ones worth a button. A cartridge nobody has described gets no list, and the
   * row is not drawn: the same rule the scripted intro and the errand follow.
   *
   * **Only places the graph says are reachable**, asked in one search rather
   * than one per candidate -- see `World.routesFrom`. Offering a walk that
   * cannot happen is worse than not offering it, and the answer changes as you
   * move: from inside a building the only route out is the door, and from the
   * far side of a one-way ledge there may be none.
   *
   * Sorted by legs, so the nearest is first and the button that leads is the
   * one somebody probably wants. Ties keep the order the title wrote them in,
   * which is the author's own idea of importance.
   */
  placesFrom(here, { maxLegs = OFFER_LEGS } = {}) {
    if (!this.world) return [];
    const named = (this.title && this.title.names) || {};
    const keys = Object.keys(named).map(Number).filter((k) => Number.isFinite(k));
    const out = [];
    // Not the place we are standing in. `routesFrom` already excludes *this
    // map*, and that is not the same thing: measured from Route 29, a gate one
    // leg away carries Route 29's own landmark, so the list offered to walk to
    // "ROUTE 29" from Route 29.
    const hereName = this.landmarkName(here);
    // Two ways of already having it, and both are needed. By **key**, because a
    // map the title named would otherwise be offered a second time under its
    // landmark -- Elm's lab, then NEW BARK TOWN, which is the town it is in. By
    // **name**, folded, because several maps share a landmark and because a
    // title's "New Bark Town" and a cartridge's "NEW BARK TOWN" are one place.
    const fold = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const seen = new Set(hereName ? [fold(hereName)] : []);
    const taken = new Set([here]);
    const add = (key, name, legs) => {
      if (!name || taken.has(key) || seen.has(fold(name))) return;
      taken.add(key);
      seen.add(fold(name));
      out.push({ key, name, legs });
    };

    // The title's own names first, because a hand-written one can be better
    // than the cartridge's: "Elm's lab" against "NEW BARK TOWN", which is the
    // town the lab is in.
    // **Not through a leg the game has refused.** The rule this whole list
    // follows is that offering a walk which cannot happen is worse than not
    // offering it -- and until the pilot could learn about a gate, every leg the
    // graph knew about was one it could take. Now some are not, so a place whose
    // only route runs through a shut leg comes off the list rather than being
    // offered with a leg count that is a fiction.
    //
    // Not swept for expiry here, because this is the one synchronous member of
    // the family and the count lives in work RAM. It does not need to be: the
    // interface asks `nearestHeal` on every refresh and that sweeps, so by the
    // time these rows are painted a badge just won has already re-opened them.
    const avoid = this.shut.size ? new Set(this.shut.keys()) : null;
    const found = this.world.routesFrom(here, keys, { avoid });
    for (const k of keys) {
      if (found.has(k)) add(k, named[k], found.get(k).length);
    }

    // Then everything else the cartridge names, **one entry per landmark**.
    // Several maps share one -- a city, its Mart and its Center are all the
    // city -- so this walks outward and takes the first map that reaches each
    // new place, which is both the nearest and the one you would name.
    //
    // Bounded by legs rather than by maps, because the graph reaches hundreds:
    // a list of two hundred rows is not an offer, it is a data dump. Six legs
    // is about as far as any job walks in one press.
    for (const { key, legs } of this._within(here, maxLegs, avoid)) {
      const own = this.landmarkName(key);
      if (own) add(key, own, legs);
    }
    // Nearest first, and then a bound on the length. The graph reaches
    // hundreds of maps and forty rows is what six legs from Route 29 gives --
    // which is a data dump by this file's own standard, and the file already
    // says so about two hundred rows of `map 26.4`. The nearest two dozen is
    // an offer; the rest is a map of Johto.
    return out.sort((a, b) => a.legs - b.legs).slice(0, OFFER_MOST);
  }

  /**
   * Places the *cartridge* shows near here, in the shape a title declares.
   *
   * The last thing in this app that had to be written out by hand. A title said
   * where the Centers and the Marts were, so the pilot could heal in the two
   * towns somebody had described and nowhere else -- and the cartridge has
   * always known: a Pokemon Center is the room with the nurse behind her
   * counter, and every town's warp list says which door leads to one.
   *
   * So this walks outward, looks through every door within reach, and reports
   * what it finds in exactly the shape `healers` and `marts` use -- which is
   * what lets `healAtCenter` and `restock` drive a discovered place without
   * knowing it was discovered.
   *
   * The signature is the engine profile's, measured across the whole ROM: of
   * twenty-three maps carrying the nurse sprite, twenty-one have her at (3,1);
   * of twenty-six carrying a clerk, thirteen have him at (1,3). Narrow on
   * purpose -- a wrong match walks the pilot into a stranger's front room.
   *
   * Nothing is claimed about a cartridge whose profile has no signatures, which
   * is the generic one: it keeps whatever the title declared and discovers
   * nothing, the same rule the takeable sprites follow.
   */
  discover(kind, here, { maxLegs = DISCOVER_LEGS } = {}) {
    const sign = ((this.state.e.places || {})[kind]) || null;
    if (!sign || !this.world || typeof this.world.objectsOn !== 'function') {
      return [];
    }
    const isOne = (key) => this.world
      .objectsOn(key >> 8, key & 0xff)
      .some((o) => o.sprite === sign.sprite
                   && o.x === sign.at[0] && o.y === sign.at[1]);
    const out = [];
    const seen = new Set();
    // Here first, then outward: the door in the town you are standing in is
    // the one worth finding.
    const from = [{ key: here, legs: 0 }, ...this._within(here, maxLegs)];
    for (const { key } of from) {
      for (const w of this.world.warps(key >> 8, key & 0xff)) {
        if (seen.has(w.key) || !isOne(w.key)) continue;
        seen.add(w.key);
        out.push(kind === 'center'
          ? { map: key, reach: 'healAtCenter', inside: w.key,
              door: [w.x, w.y], nurse: sign.nurse, found: true }
          : { map: w.key, from: key, door: [w.x, w.y],
              stand: [sign.at[0] + sign.reach.dx, sign.at[1] + sign.reach.dy],
              face: sign.reach.face, found: true });
      }
    }
    return out;
  }

  /**
   * Everywhere that can heal: what the title declared, then what was found.
   *
   * The title's first, because a hand-written entry can be better -- Elm's
   * computer is a healer no signature will ever recognise, and it is the only
   * one available before the Pokedex.
   */
  async healerList(here) {
    const declared = (this.title.healers || []);
    const known = new Set(declared.map((h) => h.inside || h.map));
    const found = this.discover('center', here)
      .filter((h) => !known.has(h.inside));
    return declared.concat(found);
  }

  /** Everywhere that sells: the same rule. */
  martList(here) {
    const declared = (this.title.marts || []);
    const known = new Set(declared.map((m) => m.map));
    return declared.concat(this.discover('mart', here)
      .filter((m) => !known.has(m.map)));
  }

  /** Every map within `maxLegs` of here, nearest first. */
  _within(here, maxLegs, avoid = null) {
    const out = [];
    // A graph that cannot list exits is one this cannot walk outward from --
    // which a title with names still uses, so an absence here is not a reason
    // to offer nothing at all.
    if (!this.world || typeof this.world.exits !== 'function') return out;
    const seen = new Set([here]);
    let edge = [here];
    for (let legs = 1; legs <= maxLegs && edge.length; legs++) {
      const next = [];
      for (const key of edge) {
        for (const exit of this.world.exits(key)) {
          // A leg the game itself refuses is not a leg, and a place reachable
          // only through one is not reachable. Same set `travelTo` walks with.
          if (avoid && avoid.has(World.leg(key, exit.key))) continue;
          if (seen.has(exit.key)) continue;
          seen.add(exit.key);
          out.push({ key: exit.key, legs });
          next.push(exit.key);
        }
      }
      edge = next;
    }
    return out;
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

    // The bag first, because it is free. `nearestHeal` prices two Centers in
    // tiles and picks the nearer -- measured at 31 against 53 from the east end
    // of Route 29 -- and a POTION already in the pocket costs none of them. A
    // grind is handed a budget of twelve trips to a Center for exactly this
    // reason, and until now it spent them while carrying the answer.
    const fromBag = await this.healFromBag(before);
    if (fromBag.ok) {
      return {
        ok: true,
        stats: { ...fromBag.stats,
                 seconds: ((Date.now() - started) / 1000).toFixed(1) },
        message: fromBag.message,
      };
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
      // **Name the gate when there was one.** "could not heal (stopped in
      // ROUTE 32)" blames the walk for a rule of the game: the Center there is
      // real and the route to it is shut until Falkner's badge, and the man who
      // shuts it says so out loud. `through` keeps his words, so the failure a
      // person reads can be the reason rather than the symptom.
      const gate = this.turnedBack;
      return { ok: false, stats: { ...stats, ...(gate ? { turnedBack: gate } : {}) },
               message: gate
                 ? `turned back on the way to ${stats.at} — ${gate}`
                 : `could not heal (stopped in ${this.where(await this.mapKey())})` };
    }
    // **A whiteout is not a heal, and every other reading says it is.** The
    // party comes back at full HP at the last Center, which is exactly what a
    // successful walk to a Center looks like -- so the wallet is the only thing
    // that can tell them apart. Measured at 9 of 24 on Route 31: the walk met
    // something it could not run from, the party fainted, and this said
    // *healed one Pokémon at Violet City* with half the money gone.
    if (this.knockedOut(before, after)) {
      return {
        ok: false,
        stats: { ...stats, knockedOut: true },
        message: `knocked out on the way — the party is mended and it cost `
                 + `half the money (¥${before.money - after.money})`,
      };
    }
    return { ok: true, stats,
             message: `healed ${hurt.length === 1 ? 'one Pokémon' : `${hurt.length} Pokémon`}`
                      + ` at ${stats.at}` };
  }

  /**
   * Mend whoever is hurt out of the bag, as far as the bag goes.
   *
   * Reports `ok` only when somebody's HP actually went up, so a caller can fall
   * through to the walk on any other answer -- no healing items, an item the
   * pack would not open for, a Pokemon the game refused. **Fainted is one of
   * those**: a Potion does nothing for a Pokemon at 0 HP in Gen 2, and the
   * whole reason a grind walks to a Center is the knockout, so the bag is not
   * offered as an answer to it.
   *
   * The hurt are mended worst-first, because a party of two at 3/40 and 38/40
   * has one member the next battle will lose and one it will not.
   */
  async healFromBag(seen = null) {
    const s = seen || await this.snap();
    const rom = this.tasks && this.tasks.rom;
    if (!rom) return { ok: false, stats: {}, message: 'no cartridge to read' };

    // Status first, and *before* the HP check rather than after it. Poison
    // ticks a Pokemon while you walk, so a journey or a grind with a poisoned
    // lead bleeds HP per step -- and a potion spent before the antidote is a
    // potion spent into a leak.
    //
    // Before, because a party at *full HP* that is poisoned has nothing to mend
    // and everything to cure: putting this after the `hurt` check meant the one
    // party the status reader exists for was the one that returned early.
    const cured = await this.cureFromBag(s);

    const heals = (this.title && this.title.heals) || null;
    const hurt = !heals ? [] : s.party
      .map((m, slot) => ({ ...m, slot }))
      // Fainted is a Center's job. Everything else is worth a Potion.
      .filter((m) => m.hp > 0 && m.hp < m.maxHp)
      .sort((a, b) => a.hp / Math.max(1, a.maxHp) - b.hp / Math.max(1, b.maxHp));
    if (!hurt.length) {
      return {
        ok: cured.length > 0,
        stats: { mended: 0, cured: cured.join(', ') },
        message: cured.length
          ? `cured ${cured.length === 1 ? 'one Pokémon' : `${cured.length} Pokémon`}`
            + ` out of the bag (${cured.join(', ')})`
          : 'nothing the bag can mend',
      };
    }

    let mended = 0, spent = [];
    // The pocket is read once and then kept, decremented as things are spent.
    //
    // Which is the opposite of what this repository says about the ball count,
    // and deliberately: *count them out of the bag rather than trusting a
    // tally* is the right rule when the bag is current, and the ITEM pocket has
    // been measured not to be. A BERRY used on a Cyndaquil at 5/22 took it to
    // 15/22 and `wItems` still listed the berry on the next read -- so this
    // loop picked the same berry again, walked past it in a pack that no longer
    // had it, gave up on that reading, and never reached the POTION. The
    // Pokemon was left at 15 of 22 with two potions in the bag.
    //
    // A local tally can only be wrong in one direction here -- it forgets an
    // item sooner than the game does -- and the next press of Heal reads the
    // pocket fresh.
    const pocket = new Map(s.items.map(([id, n]) => [id, n]));
    const asEntries = () => [...pocket.entries()].filter(([, n]) => n > 0);
    for (const mon of hurt) {
      if (this.stopped) break;
      for (let go = 0; go < BAG_HEALS_PER_MON; go++) {
        const now = await this.snap();
        const mine = now.party[mon.slot];
        if (!mine || mine.hp >= mine.maxHp) break;
        const pick = rom.cheapestOf(asEntries(), heals);
        if (!pick) break;
        this.say(`using ${pick.name} on ${this.nameOf(mine)}`);
        const used = await this.tasks.useItemOn(pick.id, mon.slot);
        if (!used.ok) {
          this.say(`${pick.name}: ${used.message}`);
          // Dropped from this loop's view entirely, not decremented. A use that
          // failed is a *kind* of item this attempt cannot get at -- the pack
          // would not open, or the walk to it overshot -- and asking again with
          // the same id is how one failure becomes four. The next kind is worth
          // a try; the same one is not.
          pocket.set(pick.id, 0);
          continue;
        }
        // Spent, so one fewer for the next Pokemon in the list.
        pocket.set(pick.id, (pocket.get(pick.id) || 1) - 1);
        spent.push(pick.name);
      }
      const after = (await this.snap()).party[mon.slot];
      if (after && after.hp > mon.hp) mended++;
    }
    const at = await this.snap();
    const did = mended + cured.length;
    return {
      ok: did > 0,
      stats: { mended, cured: cured.join(', '), spent: spent.join(', '),
               party: at.party.map((m) => `${m.hp}/${m.maxHp}`).join(' ') },
      message: did > 0
        ? `mended ${did === 1 ? 'one Pokémon' : `${did} Pokémon`} out of the bag`
          + (spent.concat(cured).length ? ` (${spent.concat(cured).join(', ')})` : '')
        : 'nothing in the bag helped',
    };
  }

  /**
   * Cure what is wrong with the party besides its HP, out of the bag.
   *
   * `cures` is the title's map of status key to item names, weakest first. The
   * specific cure comes before the general one, so a FULL HEAL is not spent on
   * a poisoning an ANTIDOTE would have fixed.
   *
   * Answers with the names it spent, so a caller can say what it did. Sleep is
   * on the list and is the one that will time out on its own -- but not while
   * you are walking, and a Pokemon asleep at the front of a grind loses every
   * turn it is asleep for.
   */
  async cureFromBag(seen = null) {
    const s = seen || await this.snap();
    const cures = (this.title && this.title.cures) || null;
    const rom = this.tasks && this.tasks.rom;
    if (!cures || !rom) return [];
    const pocket = new Map(s.items.map(([id, n]) => [id, n]));
    const spent = [];
    for (const mon of s.party) {
      if (this.stopped) break;
      // Fainted has no status worth curing: the faint is the problem, and only
      // a Center answers it.
      if (!mon.hp || !mon.status || !mon.status.length) continue;
      for (const key of mon.status) {
        const names = cures[key];
        if (!names) continue;
        const pick = rom.cheapestOf(
          [...pocket.entries()].filter(([, n]) => n > 0), names);
        if (!pick) continue;
        this.say(`${this.nameOf(mon)} is ${key} — using ${pick.name}`);
        const used = await this.tasks.useItemOn(pick.id, mon.slot);
        // The pocket is read once and kept, for the reason `healFromBag` gives:
        // it lags a use, so re-reading it picks the same spent item again.
        pocket.set(pick.id, used.ok ? (pocket.get(pick.id) || 1) - 1 : 0);
        if (used.ok) spent.push(pick.name);
        else this.say(`${pick.name}: ${used.message}`);
      }
    }
    return spent;
  }

  /**
   * Go to a mart and buy `want` of the cheapest thing on `names`, or fewer.
   *
   * The walk is the same machinery every other errand uses -- travel to the
   * town, `through` the door, walk to the tile the profile says the counter can
   * be reached from -- and the buying is `buyFromClerk`. What is here rather
   * than there is the *deciding*: which mart, which item, and how many are
   * already in the bag.
   *
   * Answers with what it spent, because that is the evidence the purchase
   * happened and because it is the number somebody wants: a knockout in Gen 2
   * takes half of it, which this app has asserted since the seventeenth pass
   * and could not read until now.
   */
  async restock(names, want = 5) {
    const marts = this.martList(await this.mapKey());
    const rom = this.tasks && this.tasks.rom;
    if (!marts.length) {
      // "Nowhere it can find", not "nowhere it was told about": the pilot looks
      // through every door within three legs now, so an empty list means there
      // is no counter near rather than no counter described.
      return { ok: false, stats: {},
               message: 'no mart within reach of here' };
    }
    if (!rom || !Array.isArray(names) || !names.length) {
      return { ok: false, stats: {}, message: 'nothing named to buy' };
    }
    const before = await this.snap();
    if (before.inBattle) return { ok: false, stats: {}, message: 'finish the battle first' };

    // The cheapest name the *mart* might stock, chosen from the list rather
    // than from the bag: this is the one decision in the app that is about what
    // is *not* carried.
    const wanted = names[0];
    const here = await this.mapKey();
    // The nearest, not the first. Measured: standing in Violet City with a Mart
    // across the street, `marts[0]` walked the pilot back to Cherrygrove for a
    // potion -- the same defect `heal()` had, in the other feature that keeps a
    // list of places, and fixed by the two of them sharing one cost model.
    const mart = (await this.nearestPlace(marts, here, (m) => m.from || m.map))
      .place;

    if (here !== mart.map) {
      if (mart.from && here !== mart.from) {
        const there = await this.travelTo(mart.from);
        if (!there.ok) {
          return { ok: false, stats: {}, message: `could not reach ${this.where(mart.from)}` };
        }
      }
      if (!await this.through(mart.door, mart.map)) {
        return { ok: false, stats: {},
                 message: `could not get into ${this.where(mart.map)}` };
      }
    }

    if (!await this.settled()) {
      return { ok: false, stats: {}, message: 'the shop never settled' };
    }
    const walk = await this.nav.walkTo(this.collision, mart.stand, this.longWalk);
    if (walk.stopped !== null) {
      return { ok: false, stats: {}, message: 'could not get to the counter' };
    }
    await this.nav.step(mart.face);
    await this.gb.press('A', 6, 12);

    // The id is looked up *after* arriving, because a mart's stock is the only
    // place the app cares about an item it does not already hold -- and
    // `cheapestOf` reads the bag. So this asks the item table for the id of the
    // name, which is what the pack walk needs.
    const id = rom.itemIdOf ? rom.itemIdOf(wanted) : null;
    if (!id) {
      await this.tasks.closeMenus();
      return { ok: false, stats: {},
               message: `this cartridge has no item called ${wanted}` };
    }
    // Both pockets, because a Poké Ball is not in the ITEM one. `want` means
    // *have this many*, and reading only `items` made it mean *buy this many*
    // for every ball -- which is the one thing anybody would ask this to fetch.
    // Latent until something asked: the shipped caller buys heals, and heals
    // are items.
    const held = (pocket) => (pocket.find(([i]) => i === id) || [0, 0])[1];
    const already = held(before.items) + held(before.balls);
    const buy = Math.max(0, want - already);
    if (!buy) {
      await this.tasks.closeMenus();
      return { ok: true, stats: { bought: 0 },
               message: `already carrying ${already}` };
    }
    const got = await this.tasks.buyFromClerk(id, buy);
    // Belt and braces: `buyFromClerk` ends by leaving the conversation, and a
    // job that walks away from a counter with one open is the defect this pass
    // spent a wallet finding.
    await this.tasks.closeConversation();
    const after = await this.snap();
    return {
      ok: got.ok,
      stats: { bought: got.bought, spent: got.spent, money: after.money },
      message: got.ok
        ? `${got.message} — ${after.money} left`
        : got.message,
    };
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
      // A trainer battle met on the way is still worth a potion: the whole
      // reason this walks rather than flees is that a trainer cannot be run
      // from, so losing it costs the trip it was in the middle of.
      const how = await this.tasks.fightBattle(
        undefined, { heals: (this.title && this.title.heals) || null });
      this.say(how === 'won' ? 'won a trainer battle' : `trainer battle: ${how}`);
      return how === 'won';
    }
    return this.tasks.flee();
  }

  /**
   * Stand next to something on the map and take what it is holding.
   *
   * Two things were wrong with this and both were invisible on the one tile it
   * was ever asked about. It stood on the tile *below* and pressed UP, which
   * works for Route 31's ball and is not a rule about anything: on Route 30 the
   * item ball at (8,35) has a wall under it, so the walk failed, and the code
   * then pressed A wherever it had stopped -- a dead `continue` inside a
   * condition that had already excluded the case it tested for. And it decided
   * whether it had succeeded by looking at the *balls*, so a BERRY off a tree
   * reported "the ball would not go in the bag" with the berry in the pocket.
   *
   * Now: approach from whichever neighbour is walkable, face the thing, and
   * answer with what actually arrived. Approaching from above and facing DOWN is
   * what put that ANTIDOTE in the bag.
   */
  async pickUp(tile, { tries = PICKUP_TRIES } = {}) {
    let pressed = 0;
    for (let attempt = 0; attempt < tries; attempt++) {
      await this.escapeBattle();
      const before = bagCount(await this.snap());
      const from = await this._approach(tile);
      if (!from) continue;
      await this.nav.step(from.face);
      await this.gb.press('A', 6, 12);
      await this.runScripts();
      const got = arrived(before, bagCount(await this.snap()));
      if (got.length) return null;
      // Reached it and it gave nothing. One more go, because a press can land
      // while the last box is still closing -- and then stop, because a ball
      // somebody has already taken will go on giving nothing however long this
      // stands there asking.
      if (++pressed >= EMPTY_PRESSES) break;
    }
    // Two different answers, and the caller needs them apart: a ball already
    // taken is an ordinary outcome and a tile nothing can reach is not.
    return pressed ? NOTHING_THERE : OUT_OF_REACH;
  }

  /**
   * Walk to a tile beside `tile` and report which way to face from it.
   *
   * Every side is tried, nearest first, because which one is open is a fact
   * about the map rather than a convention -- and the one that is open is
   * sometimes the only one.
   */
  async _approach(tile) {
    const wram = await this.settled();
    if (!wram) return null;
    const at = this.collision.playerPos(wram);
    const sides = [
      { from: [tile[0], tile[1] + 1], face: 'UP' },
      { from: [tile[0], tile[1] - 1], face: 'DOWN' },
      { from: [tile[0] - 1, tile[1]], face: 'RIGHT' },
      { from: [tile[0] + 1, tile[1]], face: 'LEFT' },
    ].filter((s) => this.collision.walkable(s.from[0], s.from[1]))
     .sort((a, b) => Math.abs(a.from[0] - at[0]) + Math.abs(a.from[1] - at[1])
                     - Math.abs(b.from[0] - at[0]) - Math.abs(b.from[1] - at[1]));
    for (const side of sides) {
      // The same budget every other leg uses: a thing lying on a route is
      // routinely further off than a plan inside a room -- Route 29's ball and
      // its fruit tree are thirty-five tiles apart before any detour.
      const res = await this.nav.walkTo(this.collision, side.from, this.longWalk);
      if (res.stopped === null) return side;
      // A battle on the way is not this side refusing, and on a route it is the
      // ordinary case rather than the exception: measured, the first press of
      // Take on Route 29 -- thirty-five tiles of grass between the two things it
      // wanted -- came back having picked up neither. Each walk gets partway
      // before something jumps out, so asking again from where it stopped
      // converges. Asking again is `pickUp`'s loop, which escapes the battle
      // first and re-reads the map; a second retry in here would be the same
      // thing done worse, and it was there for one commit before the mutation
      // that should have broken a test and did not said so.
      if (res.stopped === 'battle') return null;
    }
    return null;
  }

  /**
   * Take everything this map is holding, and say what arrived.
   *
   * The list is `collision.takeables` -- item balls and fruit trees, by the
   * sprite ids the engine profile carries -- nearest first. A ball somebody has
   * already taken is still in that list, so this cannot know in advance what is
   * left; it presses A and reports the bag, which is the only thing that
   * actually answers the question.
   */
  async takeHere() {
    const wram = await this.settled();
    if (!wram) return { ok: false, got: [], message: 'the map never settled' };
    const here = this.collision.takeables(wram);
    if (!here.length) return { ok: false, got: [], message: 'nothing lying about here' };
    const at = this.collision.playerPos(wram);
    const order = [...here].sort(
      (a, b) => Math.abs(a.x - at[0]) + Math.abs(a.y - at[1])
                - Math.abs(b.x - at[0]) - Math.abs(b.y - at[1]));
    const got = [];
    let missed = 0;
    for (const thing of order) {
      if (this.stopped) break;
      const before = bagCount(await this.snap());
      const failed = await this.pickUp([thing.x, thing.y]);
      const took = arrived(before, bagCount(await this.snap()));
      for (const name of took) {
        this.say(`picked up ${this.itemName(name)}`);
        got.push(name);
      }
      // Only a walk that never landed its press counts as missed. An
      // empty-handed press is not that: a ball somebody has already taken gives
      // nothing and refuses nothing.
      if (failed === OUT_OF_REACH) missed++;
    }
    // Three outcomes, and only one of them is a failure. Getting nothing from a
    // ball that has already been taken is the ordinary case -- the object stays
    // in work RAM once the item is in the bag, so the row goes on offering it --
    // and painting that red says something went wrong when nothing did.
    if (got.length) {
      return { ok: true, got, missed,
               message: `picked up ${got.map((n) => this.itemName(n)).join(', ')}` };
    }
    if (missed) {
      return { ok: false, got, missed,
               message: `could not get to ${missed} of ${order.length} here` };
    }
    return { ok: true, got, missed,
             message: `nothing left to take here — tried ${order.length}` };
  }

  /**
   * Fight a trainer standing on this map, and say what it paid.
   *
   * The trainers come from `collision.trainers`, which is both arrays at once:
   * the game's own type byte for what an object is, and the live struct for
   * whether it is here. That join is the whole of why this can be offered
   * honestly -- a new save's Route 30 *places* three trainers and has spawned
   * none of them, so a list read off the placements would have offered three
   * walks to nobody.
   *
   * Re-read every attempt, and that is the difference from `takeHere`: a ball
   * and a tree stay where the map put them, and a person does not. Measured on
   * Route 30, a wanderer moved a tile while nothing else happened.
   *
   * Money is what says it went well. A trainer pays when they lose and a wild
   * Pokemon never does, so the prize is the one number that distinguishes a won
   * duel from every other way a battle can end -- the same rule as the shop,
   * where money is the evidence of a purchase.
   */
  async duelHere({ tries = DUEL_TRIES, spent = null } = {}) {
    let reached = 0;
    // Trainers that have been stood in front of and would not fight. Measured,
    // and it is the difference between this working and not: standing at (3,28)
    // on Route 30 there were two trainers in range -- the one at (2,28) already
    // beaten, and the one at (5,23) not -- and every attempt went to the nearer
    // one, so all six were spent on somebody who was never going to answer and
    // the one who would was never approached.
    //
    // Keyed by tile rather than by identity because a tile is all there is: the
    // structs carry no id that survives a walk out of range and back. A trainer
    // who moves after refusing therefore gets asked once more, which is the
    // safe way for this to be wrong.
    // Handed in by a caller that is fighting more than one, because Gen 2
    // leaves a beaten trainer on the map for ever -- same sprite, same type
    // byte, same sight range -- so a second call with a fresh set walks back to
    // the one it just beat and spends every attempt asking again.
    spent = spent || new Set();
    for (let attempt = 0; attempt < tries; attempt++) {
      if (this.stopped) return { ok: false, outcome: 'stopped', message: 'stopped' };
      // Above the walk rather than below it, because this is how most duels
      // actually begin: a trainer with a sight range opens the battle itself
      // the moment you cross their line, which on the way to one of them is
      // the ordinary case and not a surprise.
      const s = await this.snap();
      if (s.inBattle && s.battleMode === this.state.e.trainerBattle) {
        return this._fightDuel(s);
      }
      // Anything else in the way is not what was asked for, and is run from
      // for the reason `escapeBattle` runs from it: a Pidgey met on the way to
      // a trainer is a delay, not the job.
      if (s.inBattle) await this.tasks.flee();
      const wram = await this.settled();
      if (!wram) continue;
      const here = this.collision.trainers(wram)
        .filter((o) => !spent.has(o.x + ',' + o.y));
      if (!here.length) {
        return { ok: false, won: false, prize: 0,
          outcome: reached ? 'beaten' : 'none',
          message: reached
          ? 'stood in front of them and no battle started — already beaten?'
          : 'nobody near enough to fight' };
      }
      const at = this.collision.playerPos(wram);
      const [pick] = [...here].sort(
        (a, b) => Math.abs(a.x - at[0]) + Math.abs(a.y - at[1])
                  - Math.abs(b.x - at[0]) - Math.abs(b.y - at[1]));
      const from = await this._approach([pick.x, pick.y]);
      if (!from) continue;
      reached++;
      await this.nav.step(from.face);
      const met = await this._awaitDuel();
      if (met) {
        // **Written down before the battle, not only after a refusal.** A
        // trainer who has been fought is as spent as one who declined -- Gen 2
        // leaves both standing there with the same sight range -- and marking
        // only the refusals meant a caller working through a map came back to
        // the one it had just beaten every round. Found by `clearHere`'s own
        // test: three trainers, six wins, and every approach to the same tile.
        spent.add(pick.x + ',' + pick.y);
        return this._fightDuel(met);
      }
      // Reached, asked, and nothing came of it. Written down before the next
      // attempt so the one after this tries somebody else.
      spent.add(pick.x + ',' + pick.y);
    }
    // Two answers, kept apart because only one of them is about the map: a
    // trainer nothing can walk to is a route problem, and a trainer standing
    // in front of you who will not fight has already been beaten -- Gen 2
    // leaves them on the map for ever once they have lost, with the same type
    // byte and the same sight range as one who has not, measured by beating
    // one and reading both.
    return { ok: false, won: false, prize: 0,
      outcome: reached ? 'beaten' : 'unreachable',
      message: reached
      ? await this.tasks.saying(
        'stood in front of them and no battle started — already beaten?')
      : 'could not get to anyone here' };
  }

  /**
   * Fight everybody on this map, one after another.
   *
   * **The primitive a Gym needs.** The pilot has been stopped on Route 32 for
   * three passes by a man who wants Falkner beaten first, and beating Falkner
   * means walking into a building and fighting everyone in it. `duelHere`
   * fights *one*; this is the loop, and the loop is where all the awkwardness
   * lives. It is useful on its own long before there is a Gym feature: Route 32
   * carries eight trainers, and clearing a route is how a party gets levels
   * without standing in grass.
   *
   * Four rules, each of which is a way the naive loop goes wrong:
   *
   * **One spent set for the whole job.** Gen 2 leaves a beaten trainer on the
   * map for ever, with the same sprite and the same sight range, so a loop that
   * called `duelHere` afresh each time would walk back to the one it had just
   * beaten and spend every attempt asking. Handed down, so the loop makes
   * progress.
   *
   * **The bag between rounds, and only the bag.** A walk to a Center in the
   * middle of this is a walk *out* of the map the job is about, and the pilot
   * would come back to fight the next one at whatever HP the trip left it. So
   * whoever is hurt is mended out of the pocket, which costs no steps, and
   * anything the bag cannot fix stops the job with the Heal row saying what it
   * would do about it.
   *
   * **A loss ends it.** Losing wipes the party and hands back control at the
   * last Center, which is not this map -- so the next round would be fought
   * from the wrong place by nobody fit. Reported as what it is rather than
   * retried.
   *
   * **Bounded by who the map *placed*, not by who is spawned.** Gen 2 only
   * loads an object when you are close enough to draw it, so the count of live
   * trainers is a fact about where you are standing: measured arriving on Route
   * 31 at its western edge, `trainers()` answered **nought** with four of them
   * further along the route. Bounding on that gives a budget of the slack alone
   * and a job that stops before it starts, so the bound comes off the
   * placements -- which never move and are all there whether drawn or not.
   *
   * A map whose list cannot be read gets the slack alone, which is the safe way
   * for the bound to be wrong, and the sweep is not *claimed* as a sweep in
   * that case: a count nobody could take is not a clear map.
   */
  async clearHere({ slack = CLEAR_SLACK } = {}) {
    const spent = new Set();
    const stats = { fought: 0, won: 0, prize: 0 };
    const wram = await this.settled();
    const trainerType = (this.state.e.objectTypes || {}).trainer;
    const list = wram && trainerType !== undefined
      ? this.collision.placedObjects(wram)
          .filter((o) => o.index !== 0 && o.type === trainerType)
      : [];
    const placed = list.length;
    const rounds = placed + slack;
    let stoppedBy = null;
    for (let round = 0; round < rounds; round++) {
      if (this.stopped) { stoppedBy = 'stopped'; break; }
      // Mended before the next one rather than after the last, because the
      // reason to mend is the battle that has not happened yet.
      const before = await this.snap();
      if (before.party.some((m) => m.hp === 0)) {
        stoppedBy = 'fainted';
        break;
      }
      if (before.party.some((m) => m.hp < m.maxHp)) await this.healFromBag(before);
      const r = await this.duelHere({ spent });
      if (r.outcome === 'won') {
        stats.fought++;
        stats.won++;
        stats.prize += r.prize || 0;
        this.say(r.message);
        continue;
      }
      if (r.outcome === 'lost' || r.outcome === 'fled') {
        stats.fought++;
        stoppedBy = r.outcome;
        break;
      }
      if (r.outcome === 'stopped') { stoppedBy = 'stopped'; break; }
      // **Nobody spawned is not nobody here.** Gen 2 loads an object only when
      // you are close enough to draw it, so on a route the honest answer to
      // *fight everyone* starts with a walk: arriving on Route 31 at its
      // western edge, `duelHere` said "nobody near enough to fight" with a
      // trainer placed seventeen tiles east. The placements say where they are
      // whether drawn or not, so this closes the distance and asks again --
      // which is the whole difference between a job that clears a route and one
      // that only works if you were already standing next to somebody.
      // **'beaten' is about the ones it can see, not about the map.** Measured
      // on Route 30: the pilot walked up to the trainer at (1,7), found them
      // already beaten -- Gen 2 leaves them standing there -- and stopped, with
      // two more placed at (2,28) and (5,23) that had never been drawn. So an
      // empty *view* and an exhausted view are the same question to this loop:
      // is there anybody further along the map, and can I get to them?
      if ((r.outcome === 'none' || r.outcome === 'beaten')
          && await this._closeOnTrainer(list, spent)) {
        continue;
      }
      // 'none', 'beaten' and 'unreachable' otherwise all mean the same thing to
      // this loop: nobody left it can get to. Kept apart in the message
      // because they are different things to go and look at.
      //
      // No `|| 'none'` fallback: every path out of `duelHere` names an outcome,
      // and `tools/mutate` proved the fallback unreachable by surviving.
      stoppedBy = r.outcome;
      break;
    }
    const cleared = stoppedBy === 'none' || stoppedBy === 'beaten';
    return {
      ok: stats.won > 0 || cleared,
      stats: { ...stats, at: this.where(await this.mapKey()) },
      message: this._clearedMessage(stats, stoppedBy, placed),
    };
  }

  /**
   * Walk at the nearest trainer the map placed but the game has not drawn.
   *
   * True when it got somewhere new, so the caller can ask again. A placement is
   * a tile that is very often occupied -- by the trainer standing on it -- so
   * this aims at the tiles *around* it and settles for whichever is reachable,
   * which is the same thing `_approach` does for a spawned one.
   */
  async _closeOnTrainer(list, spent) {
    const wram = await this.settled();
    if (!wram || !list.length) return false;
    const at = this.collision.playerPos(wram);
    const far = list
      .filter((o) => !spent.has(o.x + ',' + o.y))
      .filter((o) => Math.abs(o.x - at[0]) + Math.abs(o.y - at[1]) > 1)
      .sort((a, b) => Math.abs(a.x - at[0]) + Math.abs(a.y - at[1])
                      - Math.abs(b.x - at[0]) - Math.abs(b.y - at[1]));
    for (const who of far) {
      for (const [dx, dy] of [[0, 1], [0, -1], [-1, 0], [1, 0], [0, 0]]) {
        const goal = [who.x + dx, who.y + dy];
        if (!this.collision.walkable(goal[0], goal[1])) continue;
        if (goal[0] === at[0] && goal[1] === at[1]) continue;
        this.say(`walking up to whoever is at ${who.x},${who.y}`);
        const res = await this.nav.walkTo(this.collision, goal, this.longWalk);
        // A battle on the way is the errand arriving early: a trainer with a
        // sight range opens one the moment the walk crosses their line, which
        // is how most of these actually begin.
        if (res.stopped === 'battle') return true;
        const now = this.collision.playerPos(await this.settled() || wram);
        if (now[0] !== at[0] || now[1] !== at[1]) return true;
      }
      // Could not get anywhere near this one; do not ask about them again.
      spent.add(who.x + ',' + who.y);
    }
    return false;
  }

  /** What `clearHere` has to say for itself. */
  _clearedMessage(stats, stoppedBy, placed) {
    const beat = stats.won === 1 ? 'beat one trainer'
      : `beat ${stats.won} trainers`;
    const money = stats.prize ? `, ¥${stats.prize}` : '';
    if (stoppedBy === 'fainted') {
      return stats.won
        ? `${beat}${money} — stopping, nobody fit to send out`
        : 'nobody fit to send out';
    }
    if (stoppedBy === 'lost' || stoppedBy === 'fled') {
      return stats.won ? `${beat}${money} — then lost one`
                       : `lost the ${stats.fought === 1 ? 'first' : 'last'} one`;
    }
    if (stoppedBy === 'stopped') {
      return stats.won ? `${beat}${money} — stopped` : 'stopped';
    }
    if (stoppedBy === 'unreachable') {
      return stats.won ? `${beat}${money} — cannot get to anyone else`
                       : 'could not get to anyone here';
    }
    if (!stats.won) {
      // Two different things, and the difference is what to do next: an empty
      // map is an empty map, and a map of people who have already lost to you
      // is a map you have finished with.
      return stoppedBy === 'beaten'
        ? 'everyone here has already been beaten'
        : 'nobody here wants a battle';
    }
    // Cleared. Worth saying against the map's own total, because "beat three"
    // and "beat the three that were here" are different claims.
    return placed && stats.won >= placed
      ? `${beat}${money} — everyone on this map`
      : `${beat}${money}`;
  }

  /** Press until the battle the trainer owes us turns up. */
  async _awaitDuel(taps = DUEL_START_TAPS) {
    for (let i = 0; i < taps; i++) {
      const s = await this.snap();
      if (s.inBattle) return s;
      await this.gb.press('A', 6, 12);
    }
    return null;
  }

  /** Fight the trainer battle that is on, and price it. */
  async _fightDuel(before) {
    const how = await this.tasks.fightBattle(
      DUEL_TURNS, { heals: (this.title && this.title.heals) || null });
    const after = await this.snap();
    const prize = Math.max(0, (after.money || 0) - (before.money || 0));
    const lead = after.party[0], was = before.party[0];
    // The lead only. Which Pokemon gained what is the party card's business,
    // and a line that lists six is not a line.
    const grew = lead && was && lead.level > was.level
      ? ` — Lv${was.level} to Lv${lead.level}` : '';
    // **`outcome` rather than the message.** A caller fighting several of these
    // has to tell a loss from an empty map, and the only difference used to be
    // the wording -- so re-wording a sentence would have quietly changed what
    // the caller above it did. `fightBattle`'s own answer is passed straight
    // out, which is the one place that already knows.
    if (how !== 'won') {
      return { ok: false, won: false, prize, outcome: how,
               message: `the battle ${how}` };
    }
    return { ok: true, won: true, prize, outcome: 'won',
             message: prize ? `won the battle, ¥${prize}${grew}`
                            : `won the battle${grew}` };
  }

  /** An item id as a name, where there is a ROM to ask. */
  itemName(id) {
    const name = this.tasks && this.tasks.rom ? this.tasks.rom.itemName(id) : '';
    return name || `item ${id}`;
  }

  /**
   * Arrived -- and whether anything was lost getting here.
   *
   * A walk that whites out on the way still often reaches its target, because a
   * whiteout puts the player at a Center and the walk carries on from there. So
   * `arrived` on its own is true and misleading, and the wallet is the only
   * thing that says which kind of arrival it was.
   */
  async _arrived(started) {
    const now = await this.snap();
    if (!this.knockedOut(started, now)) return { ok: true, message: 'arrived' };
    return { ok: true, knockedOut: true,
             message: `arrived — but knocked out on the way, which cost `
                      + `¥${started.money - now.money}` };
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
  /**
   * The cheapest place on a list, in tiles, from where we are.
   *
   * Extracted from `nearestHeal` the pass a second list needed it, and the
   * extraction *was* the bug fix: `restock` used `marts[0]`, so standing in
   * Violet City with a Mart across the street the pilot walked back to
   * Cherrygrove for a potion. A list with one entry hard-coded is the same
   * defect `heal()` had, in the other feature that has a list of places.
   *
   * Priced in **tiles**, not legs, because a leg is not a unit of anything: a
   * route crossing is fifty tiles and a door is one. So a further leg costs the
   * title's `legCost` and the *first* one costs the real distance to the edge
   * it leaves by, which is the only leg this can actually measure.
   *
   * The last entry is the fallback, deliberately: a title lists its places
   * most-general last, and with no map graph to price the alternatives the
   * general answer is the safe one.
   *
   * Returns `{ place, cost }`, because the cost is worth saying: the interface
   * names the Center it would walk to *before* the button is pressed, so the
   * choice is visible rather than discovered in the log afterwards.
   */
  async nearestPlace(list, from, mapOf = (p) => p.map) {
    const places = list || [];
    if (!places.length) return null;
    const last = places[places.length - 1];
    if (!this.world) return { place: last, cost: undefined };

    const legCost = this.title.legCost || 25;
    const wram = await this.settled();
    // **The cheapest place is not the nearest one if the game will not let you
    // in.** Standing on Route 32, the Center on Route 32 costs nothing and is
    // shut; Violet City is one leg north and open. Asked before the distance,
    // because a zero-cost answer used to short-circuit the whole search.
    if (wram && this.state) this.reopen(this.state.badgeCount(wram));
    const shutLegs = this.shut.size ? new Set(this.shut.keys()) : null;
    const open = places.filter((p) => !this.shutBetween(from, p, mapOf));
    // Everything is shut, so there is nothing better to say than the last one
    // and no cost -- the same answer this gives when it has no graph to ask.
    if (!open.length) return { place: last, cost: undefined };
    let best = null, bestCost = Infinity;
    for (const p of open) {
      const there = mapOf(p);
      if (from === there) return { place: p, cost: 0 };
      // **And not through a shut leg on the way.** A door being open says
      // nothing about the road to it: an edge refused mid-route makes the place
      // beyond it unreachable, and `route` already knows how to be asked that.
      const route = this.world.route(from, there, { avoid: shutLegs });
      if (route === null) continue;
      let cost = (route.length - 1) * legCost;
      const first = route[0];
      if (wram && first && first.kind === 'edge') {
        const [w, h] = this.collision.mapSize();
        const at = this.collision.playerPos(wram);
        cost += { LEFT: at[0], RIGHT: w - 1 - at[0],
                  UP: at[1], DOWN: h - 1 - at[1] }[first.dir] ?? legCost;
      }
      if (cost < bestCost) { best = p; bestCost = cost; }
    }
    return best ? { place: best, cost: bestCost }
                : { place: open[open.length - 1], cost: undefined };
  }

  async nearestHeal(from) {
    const healers = await this.healerList(from);
    if (!healers.length) return null;
    const picked = await this.nearestPlace(healers, from);
    if (!picked || !picked.place) return null;
    const h = picked.place;
    // The entry is handed to the procedure, which is what lets one procedure
    // serve several places: `healAtCenter` reads the door and the nurse off it
    // rather than closing over one town's constants. A procedure that wants no
    // argument simply ignores it.
    // **`shut` is the difference between "nearest" and "only one left".** When
    // every healer is written off, the pick is the last one named at no
    // priceable cost -- and a row that says *nearest is ROUTE 32* about a route
    // the pilot has already been turned back from is making a promise it knows
    // it cannot keep.
    const door = Journey.doorTo(h);
    return { map: h.map, heal: () => this[h.reach](h), cost: picked.cost,
             shut: (door !== null && this.shutSaid(h.map, door))
                   || this.shutSaid(from, h.map) };
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
