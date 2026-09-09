// What each row in the interface should say, and whether its button works.
//
// Pure: it takes the game state and the handful of choices the person has made,
// and returns text and flags. It touches no DOM, which is the point — this is
// where every "why is that button greyed out?" answer lives, and it was mixed
// in with fifty-odd textContent assignments in one 89-line function where none
// of it could be tested.
//
// main.js applies what comes back. That division is worth keeping: a wrong
// string here is a wrong string, but a wrong string tangled up with the DOM is
// a bug you can only find by loading a phone and squinting at it.

/**
 * `ctx` is everything outside the game that changes what a row says:
 *   rom               the cartridge tables, or null before a ROM is picked
 *   target            the level a grind is aimed at
 *   huntWanted        the species chosen below, or null
 *   ballId            the ball to throw, or null when there are none
 *   savedThisSession  whether this tab has committed a save
 *   healPlace         where healing would go, worked out once per refresh
 *   gym               the nearest unbeaten Gym as {at, leader, legs}, or null
 *   healShut          what the game said last time it turned the pilot back
 *                     from that place, or null -- see `Journey.shut`
 *   gated             roads out of here the game is keeping shut, and what
 *                     opens each: [{ where, needs, errand }] -- see
 *                     `Journey.gatesFrom`. An entry with an `errand` is one the
 *                     pilot can go and do.
 *   places            named maps reachable from here, [{ key, name, legs }]
 *   travelTo          the map key chosen to walk to, or null
 *   huntable          how many species appear here at this hour
 *   wilds             the levels the grass gives here, { low, high } or null
 *   bagHeal           the *name* of the cheapest thing in the bag that mends
 *                     HP, or null -- a string, because that is all the row
 *                     needs and `main.js` passes `pick.name`
 *   trainers          who is near enough to fight, [{ x, y, sprite }]
 *   trainersOnMap     how many the map places anywhere, near or not
 *   canBox            whether this cartridge has said what a boxed catch says
 */
// How much of the game's own line fits on the bar beside the pilot's. Measured
// against the narrowest layout this app supports rather than chosen: the bar is
// one line on a 320px phone.
const SAYING_MAX = 46;

export function describeRows(s, ctx = {}) {
  const { rom = null, target = 5, huntWanted = null, ballId = null,
          savedThisSession = false, healPlace = null, healShut = null,
          gated = [], canFetch = null,
          gym = null,
          places = [], travelTo = null, wilds = null, takeables = [],
          bagHeal = null, bagCure = null, marts = false, shopFor = null,
          trainers = [], trainersOnMap = 0, canBox = false,
          // The cartridge's own numbers. A party of six and a trainer battle of
          // 2 are Gen 2's, not this module's, and reading them from an import
          // meant the stock values reached here even when a title had changed
          // them -- the engine profile applied to half the app.
          engine = {} } = ctx;
  const maxParty = engine.maxParty || 6;
  const trainerBattle = engine.trainerBattle === undefined
    ? 2 : engine.trainerBattle;
  const name = (id) => (rom ? rom.speciesName(id) : null);

  const lead = s.party[0];
  const leadName = lead ? name(lead.species) : null;
  // Money, said the way the game says it. Read for the first time in
  // twenty-six passes: the app has asserted since the seventeenth that a
  // knockout costs half of it, and could not show the number.
  const money = `¥${(s.money || 0).toLocaleString('en')}`;
  const needsBalls = !ballId;
  const ballName = ballId && rom ? rom.itemName(ballId) : null;

  // **Every scripted trip the pilot could make, in one place.** Two sources
  // feed it: a gated road with a remedy, and the trip that fetches the first
  // Poké Balls. They used to live apart -- the ball errand as a second button
  // on the Catch row, put there deliberately in v165 so that the way out of
  // "no Poké Balls yet" sat in the row that says it.
  //
  // What that missed is the runner, which arrived two passes later and presses
  // a row's *own* button. So "Run the list" could never fetch the first balls:
  // Catch is not enabled without them, its secondary button was invisible to
  // the runner, and the sequence stopped one step before the thing that would
  // have unstuck it. A row that only a person can press is not on the list as
  // far as the runner is concerned.
  //
  // A road first, then the balls, because a road is worth more -- and in
  // practice they never both apply: the balls come from the opening errand and
  // the gate is four towns later.
  const errands = [];
  for (const g of gated || []) if (g.errand) errands.push(g);
  if (needsBalls && canFetch !== false) {
    errands.push({ needs: 'the first Poké Balls', errand: 'eggErrand' });
  }
  const errand = errands[0] || null;
  const foe = s.inBattle ? name(s.enemy.species) : null;
  const trainer = s.battleMode === trainerBattle;
  const hurt = s.party.filter((m) => m.hp < m.maxHp);
  // Fainted, separately from hurt. A Potion does nothing for a Pokémon at 0 HP
  // in Gen 2, so a party with one in it needs the walk whatever the bag holds.
  const down = s.party.filter((m) => m.hp === 0);
  // And what is wrong besides the HP. Worth its own line rather than folding
  // into "hurt", because a potion does not fix it and poison goes on doing
  // damage while you walk: a party that is *only* poisoned reads as perfectly
  // healthy on HP alone, which is what the app used to see.
  const ailing = s.party.filter((m) => m.hp > 0 && (m.status || []).length);
  // **When the walk is the only answer left.** The bag comes first and is free,
  // so a shut route matters only where the bag cannot help -- and a fainted
  // party is exactly that case, whatever the bag holds. Kept as its own name
  // because the heal row's text and its `enabled` both need it and they had
  // drifted apart before over `down.length`.
  const walkOnly = !bagHeal || down.length > 0;
  // Anyone who could actually be sent out. A duel is the one job that cannot
  // start without one: every other job either walks (and a fainted party still
  // walks) or refuses in a battle. `heal` reads `down` for the same party and
  // asks the opposite question of it.
  const fit = s.party.filter((m) => m.hp > 0);

  // Saving drives the START menu, and that menu does not open in a battle or
  // mid-script.
  const canSave = s.worldLoaded && !s.inBattle && !s.scriptRunning;
  // Anything that walks needs a world to walk in and no battle in the way.
  // These used to be looser -- grind was enabled on `lead` alone -- which was
  // survivable while every row was drawn and greyed out, and is not now that
  // the list only holds things that can run: an offer that refuses itself is
  // worse than no offer.
  const afoot = s.worldLoaded && !s.inBattle;
  // A full party is no longer a refusal: Gen 2 sends a caught Pokemon to the
  // box, measured with six carried. It is one only on a cartridge whose title
  // has not said what that message looks like, because with nothing to read a
  // boxed catch and a getaway are the same thing -- which is what `canBox` is.
  const canCatchHere = s.inBattle && !trainer && !!ballId
                       && (canBox || s.party.length < maxParty);
  // Indexed once, because the row asks about the chosen place twice and the
  // list is the journey's answer rather than something to search repeatedly.
  const byKey = new Map(places.map((pl) => [pl.key, pl]));

  return {
    grind: {
      // The range the grass gives, where the cartridge has one to give. It was
      // sitting unread in the encounter table the whole time -- a slot is two
      // bytes, level then species, and the species reader stepped over the
      // first of them. Worth saying because of what it explains: measured on
      // Route 29, which produces Lv2 to Lv3, a Lv15 Pokemon aimed at Lv20 won
      // thirty-two of thirty-five battles for two levels and a knockout. The
      // app offered Lv20 as a preset and had nothing to say about that.
      text: !lead ? 'no party yet'
        // No lead name: it is in the party summary directly above this list,
        // and printing it again in the one row that trains it was the same
        // word twice within an inch of itself.
        : wilds ? `→ Lv${target} · here Lv${range(wilds)}`
        : `${leadName} → Lv${target}`,
      enabled: !!lead && afoot,
      // The level presets are meaningless with nothing to level.
      levels: !!lead,
      // Every battle here is against something weaker than the thing being
      // trained. A fact about two numbers rather than a formula about
      // experience, which is why it is stated and not calculated.
      outlevelled: !!(lead && wilds && lead.level > wilds.high),
    },
    // **`needs` replaces an instruction with an affordance.** Three rows used to
    // read "pick something below", which is a sentence that exists only because
    // the control is somewhere else -- and it asks the person to do the linking.
    // The rows carry a tappable slot now, so the thing to press is in the row
    // that wants it and the sentence is gone. Same information, a third of the
    // reading, and one fewer thing to work out.
    hunt: {
      text: huntWanted ? `${huntWanted} · here now` : '',
      needs: huntWanted ? null : 'species',
      enabled: !!huntWanted && afoot,
    },
    // Catch owns its own prerequisite. The errand is a one-time thing -- run it
    // twice and it reports "already carrying 5 ball(s)" without moving -- so it
    // is Catch's empty state rather than a peer button.
    catch: {
      text: needsBalls
        ? 'no Poké Balls yet'
        : huntWanted ? `${huntWanted} · ${ballName}` : '',
      needs: needsBalls || huntWanted ? null : 'species',
      enabled: !!(ballId && huntWanted) && afoot,
      needsBalls,
    },
    save: {
      text: !s.worldLoaded ? 'start a game first'
        : s.inBattle ? 'finish the battle first'
        : s.scriptRunning ? 'wait for the screen to settle'
        : savedThisSession ? 'saved this session'
        : 'not saved yet',
      enabled: canSave,
    },
    // What the row is *for* -- another emulator -- is a thing somebody either
    // already knows or does not need; the icon is an arrow leaving and the
    // button says Download. So the line is spent on the one thing pressing it
    // cannot tell you in advance: whether the file will have this session in
    // it. It says "not this session" rather than "the older save", because a
    // battery nobody has saved to holds no save at all, and a row asserting an
    // older one exists would be wrong in exactly the way this repository keeps
    // getting caught by. Pressing it on an empty battery says so plainly.
    //
    // Sixteen characters because the first draft was twenty-nine, and a jstate
    // is one clipped line: `nothing from this session yet` reached the phone as
    // "nothing from this sessi…", which is a sentence that has lost the half
    // that mattered. Measured on the device, not counted in the editor.
    export: {
      text: savedThisSession ? 'up to date' : 'not this session',
    },
    // The three below act on the situation you are already in, so what they can
    // do is decided by the game rather than by anything picked on this page.
    battle: {
      text: !s.inBattle ? 'not in a battle'
        : `${trainer ? 'trainer' : 'wild'} ${foe} Lv${s.enemy.level}`,
      enabled: s.inBattle,
    },
    here: {
      text: !s.inBattle ? 'not in a battle'
        : trainer ? 'a trainer’s Pokémon cannot be caught'
        : s.party.length >= maxParty && !canBox ? 'the party is full'
        : needsBalls ? 'no Poké Balls yet'
        : `${foe} Lv${s.enemy.level} · ${ballName || 'a ball'}`,
      enabled: canCatchHere,
    },
    heal: {
      // What it will *do*, and the bag comes first because it is free. The walk
      // is priced in tiles -- 31 against 53 from the east end of Route 29 --
      // and a POTION already in the pocket costs none of them. Named rather
      // than counted: "one hurt · a POTION in the bag" says both what is wrong
      // and what will be spent on it.
      //
      // A fainted party is the exception and says so, because a Potion does
      // nothing for a Pokémon at 0 HP in Gen 2 -- so the walk is the answer
      // whatever the bag holds, and offering the bag would be a promise it
      // cannot keep.
      text: s.inBattle ? 'finish the battle first'
        : !s.party.length ? 'no party yet'
        : !hurt.length && !ailing.length ? 'everyone is at full health'
        // A party at full HP that is poisoned is not "at full health", and the
        // row said it was. Named rather than counted, because *which* thing is
        // wrong decides what will fix it.
        : !hurt.length
          ? `${ailWord(ailing)} · ${bagCure || healPlace || 'a Center'}`
        : bagHeal && !down.length
          ? `${hurt.length} hurt · ${bagHeal} in the bag`
        // **The walk is the only way left and the game has already refused
        // it.** `nearestHeal` skips a place the pilot was turned back from, so
        // reaching here with `healShut` set means *every* healer is written
        // off -- and *nearest is ROUTE 32* would be a promise this row knows
        // cannot be kept. Named with the words that closed it, because those
        // are what a person can act on: a badge opens these.
        : walkOnly && healShut
          ? `${hurt.length} hurt · ${healPlace || 'a Center'} — turned back: ${healShut}`
          // Not "N hurt": the party summary above says so, and this row's own
          // glyph is a heart. What only this row can tell you is *where*.
          : `${healPlace || 'a Center'}`,
      // A shut route does not disable the row while the bag can still answer,
      // and a fainted party is exactly when it cannot.
      enabled: afoot && (hurt.length > 0 || ailing.length > 0)
               && !(walkOnly && healShut),
      // Said so the row can be tested on the decision rather than the wording.
      fromBag: !!(bagHeal && !down.length),
      ailing: ailing.length,
    },
    // Walking somewhere else, which the pilot could always do and was never
    // asked to. `places` is what the journey says is reachable and named from
    // here; an empty list means this cartridge has no names, and the row is not
    // drawn at all -- the rule the scripted intro and the errand already follow.
    travel: {
      text: s.inBattle ? 'finish the battle first'
        : !places.length ? 'nowhere named to walk to'
        : travelTo && byKey.has(travelTo)
          ? `${byKey.get(travelTo).name} · ${legsWord(byKey.get(travelTo).legs)}`
          : '',
      needs: !s.inBattle && places.length && !(travelTo && byKey.has(travelTo))
        ? 'place' : null,
      enabled: afoot && !!travelTo && byKey.has(travelTo),
      places,
    },
    // Buying, where the cartridge has somewhere to buy from. The row says what
    // it will cost rather than what it will get, because the money is the thing
    // the person has a finite amount of -- and because a mart's stock is the one
    // thing in this app that cannot be read before arriving.
    shop: {
      text: s.inBattle ? 'finish the battle first'
        : !marts ? 'no mart within reach of here'
        // The one state in which the whole job is impossible rather than
        // merely pointless, and the row was offering it: **an empty party.**
        // Every mart is in a town, and the town the game starts you in is the
        // one it will not let you leave without a Pokémon -- Elm's aide stands
        // in the way and puts you back. So "Shop · 5 more potion" in the
        // bedroom of a new game is a two-minute walk into a roadblock, which
        // is the interface's first rule broken: nothing is drawn that cannot
        // be done.
        //
        // Nobody had pressed Shop from a bedroom, which is why nothing caught
        // it. Found by the runner, which presses whatever is at the front of
        // the list and does not know any better -- with no party and nothing
        // else on offer, Shop was the front.
        //
        // An empty party is also *only* ever this state: Gen 2 refuses to
        // deposit your last Pokémon, so the party is empty before the starter
        // and never again.
        : !s.party.length ? 'nothing to shop for without a Pokémon'
        // No money here: it is in the header, where it belongs. It is global
        // state -- a battle changes it -- and it was being printed in this row
        // and the Duel row both, which is the same number twice and clutter in
        // each. What this row is *for* is the thing it will buy.
        : shopFor || 'nothing named to buy',
      enabled: afoot && !!marts && !!shopFor && s.party.length > 0,
    },
    // A scripted trip that unlocks something, where the cartridge has one to
    // offer. The gate above says *what* the road wants; this is the row that
    // goes and gets it -- and it is generic on purpose, because the ball
    // errand is the same shape of thing and the next cartridge will have its
    // own. What it fetches is in the line rather than the name.
    errand: {
      text: s.inBattle ? 'finish the battle first'
        : !errand ? 'nothing to fetch'
        // The same state Shop was caught offering itself in, and caught the
        // same way -- by a mechanism with no judgement pressing the front of
        // the list. An errand is a walk to another town, and the game will not
        // let anybody leave the first one without a Pokémon.
        : !s.party.length ? 'nothing to fetch without a Pokémon'
        : errand.needs,
      enabled: afoot && !!errand && s.party.length > 0,
    },
    // Winning a badge, which is the one job whose result the game writes down
    // permanently -- so this row can say whether it has been done rather than
    // guessing from what the pilot remembers. A Gym that is beaten stops being
    // offered at all, because the badge says so.
    gym: {
      text: s.inBattle ? 'finish the battle first'
        : !gym ? 'no Gym this build knows about'
        : !fit.length ? 'nobody fit to send out'
        // Two facts, not three. `FALKNER · Violet City · one map away` measured
        // 33px past the end of a clipped one-line state on a 375px phone and
        // arrived as `FALKNER · Violet City · one map…`, so the fact it was
        // cut off was the one nothing else on the card says. Where the Gym is
        // stays -- that is what this row's Go acts on -- and the leg count
        // goes, because the Travel row above is already counting legs.
        : `${gym.leader || 'the leader'} · ${gym.legs ? gym.at : 'here'}`,
      enabled: afoot && !!gym && fit.length > 0,
    },
    // What the map is holding. Counted rather than named, because the app
    // cannot tell a ball somebody has already taken from one still lying there
    // -- measured: the object stays in work RAM after the ANTIDOTE is in the
    // bag -- so a promise of what you will get would be a promise it cannot
    // keep. The job says what actually arrived.
    take: {
      text: s.inBattle ? 'finish the battle first'
        : !takeables.length ? 'nothing lying about here'
        : takeWord(takeables),
      enabled: afoot && takeables.length > 0,
      count: takeables.length,
    },
    // Who on this map wants a battle. The count is the game's own answer and
    // not a guess: an object is a trainer because the byte the engine branches
    // on says so, and it is *here* because the game has spawned a struct for
    // it. So an empty list means an empty map, and the row says so rather than
    // offering a walk to somebody a flag is still hiding.
    //
    // A trainer pays and a wild Pokemon barely does, which is why this row
    // shows the money: it is the one job whose point is the number beside it,
    // and until the twenty-seventh pass nothing in this app could earn any.
    duel: {
      // "Nearby" is the honest word, and it is measured. Gen 2 only loads an
      // object when you are close enough to draw it: standing at the south end
      // of Route 30 the game had spawned nothing at all, and walking twenty
      // tiles north brought a ball, a wanderer and a trainer into being one
      // after another. So this count is who is *here*.
      //
      // The map's own total is not in this text, and that is a correction: it
      // was, and the row is hidden whenever it cannot run -- so the sentence
      // that told you to walk on could only ever appear when walking on was
      // unnecessary. It lives in the hint below, which is where the things
      // that would *add* to the list belong.
      text: s.inBattle ? 'finish the battle first'
        : !trainers.length ? 'nobody here wants a battle'
        : !fit.length ? 'nobody fit to send out'
        : `${countWord(trainers.length)} nearby`,
      enabled: afoot && trainers.length > 0 && fit.length > 0,
      // **Clear is offered where there is more than one to clear.** One trainer
      // in front of you is what Fight is for, and a second button that does the
      // same thing as the first is a choice nobody can make well. Counted off
      // the map's own list rather than who is spawned, because that is what the
      // job will work through -- Gen 2 only loads an object when you are close
      // enough to draw it, so "nearby" is a fact about where you stand and
      // "on this map" is a fact about the map.
      clearable: afoot && fit.length > 0 && (trainersOnMap || 0) > 1
                 && trainers.length > 0,
      count: trainers.length,
      onMap: trainersOnMap,
    },
  };
}

/** "one trainer", "three trainers". */
function countWord(n) {
  const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
                 'eight', 'nine', 'ten'];
  return `${words[n] || n} trainer${n === 1 ? '' : 's'}`;
}

/** "a ball and two trees", for what the map is holding. */
function takeWord(takeables) {
  const n = (what) => takeables.filter((t) => t.what === what).length;
  const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
                 'eight', 'nine', 'ten'];
  const say = (count, one, many) =>
    `${words[count] || count} ${count === 1 ? one : many}`;
  const parts = [];
  if (n('ball')) parts.push(say(n('ball'), 'item ball', 'item balls'));
  if (n('tree')) parts.push(say(n('tree'), 'fruit tree', 'fruit trees'));
  // A sprite the profile names that is neither -- a hack's own -- still counts.
  const rest = takeables.length - n('ball') - n('tree');
  if (rest) parts.push(say(rest, 'other thing', 'other things'));
  return parts.join(' and ');
}

/**
 * Somewhere reachable whose grass is worth more than the grass here.
 *
 * This is the two previous passes meeting. One of them read the level beside
 * every species, so the app knows Route 29 gives Lv2-3 and Route 30 gives
 * Lv4-5. The other built the list of named maps the graph can reach from where
 * you stand. Neither alone answers the question a grind actually raises, which
 * is *then where should I go instead*.
 *
 * "Better" is one fact about two numbers, deliberately, and not a model of
 * experience: a place is worth walking to when its grass tops out at or above
 * the level being trained, because that is the difference between a battle that
 * pays and one that does not. Among those, the fewest legs wins -- a Center
 * three maps away is not an improvement on a slow grind -- and a tie goes to
 * the higher ceiling.
 *
 * Null when nothing reachable is better, which is the common case late on and
 * has to read as silence rather than as a recommendation to stay put.
 */
export function betterGrind(places, level) {
  const worth = (places || []).filter(
    (pl) => pl.wilds && pl.wilds.high >= level);
  if (!worth.length) return null;
  return worth.reduce((best, pl) => {
    if (pl.legs !== best.legs) return pl.legs < best.legs ? pl : best;
    return pl.wilds.high > best.wilds.high ? pl : best;
  }, worth[0]);
}

/**
 * The three hours by name, indexed by wTimeOfDay.
 *
 * "After dark" rather than "at night" because the app is telling somebody when
 * to come back, and the boundary is what they need -- the clock in the game is
 * the real one, so this is advice about their evening.
 */
const HOURS = ['in the morning', 'during the day', 'after dark'];

/** What an hour is called, or null for an hour a cartridge does not have. */
function hourName(block) {
  return HOURS[block] || null;
}

/**
 * A better hour for the grass you are already standing on, or null.
 *
 * `wildHours` reads all three blocks of the encounter table; the app has only
 * ever asked about one of them, the hour it is now. This is what the other two
 * are for, and it outranks `betterGrind` for a reason that needs no model:
 * waiting costs no walking. Route 29 tops out at Lv4 by day and Lv4 after
 * dark, so it says nothing there -- but a patch whose night block is four
 * levels higher turns "walk three maps" into "come back this evening".
 *
 * The highest ceiling wins rather than the soonest hour, because the clock is
 * the real one and this app cannot see how far off either is. Null when no
 * other hour would pay, and null for the hour it already is -- advising
 * somebody to wait for now is worse than saying nothing.
 *
 * Which is also why not knowing the hour is a refusal rather than a free pass:
 * without it every block is a candidate, including the one you are standing in,
 * so the advice would sooner or later be "come back at a time that is now".
 *
 * An hour also has to beat *this* hour, and not only the lead. Measured on the
 * real cartridge, which is where this was caught: Crystal's three blocks carry
 * the same levels and swap only the species, so `wildHours(26, 1)` is Lv3-4
 * three times over -- and a rule that asked "does this hour pay the lead"
 * answered yes for the morning while standing in an identical afternoon. The
 * app's only caller had already established that here does not pay, so it was
 * right by a precondition it never stated. Stating it in here is the fix, and
 * the second caller is the reason.
 */
export function betterHour(hours, level, now) {
  if (!Array.isArray(hours) || typeof now !== 'number') return null;
  const here = hours[now] && hours[now].levels ? hours[now].levels.high : 0;
  let best = null;
  hours.forEach((hour, block) => {
    if (block === now || !hour || !hour.levels) return;
    if (hour.levels.high < level || hour.levels.high <= here) return;
    if (!best || hour.levels.high > best.wilds.high) {
      best = { block, name: hourName(block), wilds: hour.levels };
    }
  });
  return best;
}

/**
 * Which hour here holds a species that is not here now, or null.
 *
 * The list of things to hunt is rebuilt whenever the map or the hour changes,
 * and a quarry that no longer lives here is dropped -- silently, which is the
 * problem. Pick HOOTHOOT at night, come back at noon, and the chip is gone
 * with nothing said about why. It is not gone: it is six hours away.
 */
export function otherHour(hours, name, now) {
  if (!Array.isArray(hours) || !name) return null;
  for (let block = 0; block < hours.length; block++) {
    if (block === now || !hours[block]) continue;
    if (hours[block].species.includes(name)) {
      return { block, name: hourName(block) };
    }
  }
  return null;
}

/**
 * What the other hours add here, as a sentence, or ''.
 *
 * Said only where the species differ, because on most maps they do not and a
 * line saying "the same four, all day" is noise. Names them when there are few
 * enough to name.
 */
export function hoursLine(hours, now) {
  if (!Array.isArray(hours) || !hours[now]) return '';
  const mine = new Set(hours[now].species);
  const extra = [];
  hours.forEach((hour, block) => {
    if (block === now || !hour) return;
    for (const name of hour.species) {
      if (!mine.has(name) && !extra.some((e) => e.name === name)) {
        extra.push({ name, block });
      }
    }
  });
  if (!extra.length) return '';
  const words = extra.slice(0, 2).map((e) => `${e.name} ${hourName(e.block)}`);
  const rest = extra.length - words.length;
  return `also here: ${words.join(', ')}${rest ? ` and ${rest} more` : ''}`;
}

// What each status is called, by the key `statusOf` hands over. Words rather
// than the three-letter keys the cartridge thinks in, because this is the line
// somebody reads.
const AILMENTS = { psn: 'poisoned', par: 'paralysed', brn: 'burned',
                   frz: 'frozen', slp: 'asleep' };

/** "poisoned", or "2 poisoned", or "poisoned and asleep". */
function ailWord(ailing) {
  const kinds = [...new Set(ailing.flatMap((m) => m.status || []))]
    .map((k) => AILMENTS[k] || k);
  if (ailing.length > 1) return `${ailing.length} ${kinds.join(' and ')}`;
  return kinds.join(' and ') || 'unwell';
}

/** "2-3", or just "4" where the grass gives only one level. */
function range({ low, high }) {
  return low === high ? String(low) : `${low}\u2013${high}`;
}

/** "one map away", "three maps away" -- a cost somebody can feel. */
function legsWord(legs) {
  const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
                 'eight', 'nine', 'ten'];
  const n = words[legs] || String(legs);
  return `${n} map${legs === 1 ? '' : 's'} away`;
}

/**
 * What the pilot can do here, in the order you are most likely to want it.
 *
 * The same answers `describeRows` computes, inverted. Six rows that explain why
 * four of them are greyed out is the app scanning on your behalf and then
 * making you scan anyway -- and this app *reads the game's memory*, which is
 * the whole project, so it knows perfectly well that there is no battle, that
 * nobody is hurt and that there are no balls. It should offer what it can do,
 * and stay quiet about the rest.
 *
 * Every rule in the ranking is about the state rather than a preference. A
 * battle is modal, so its two actions come first and nothing else is startable
 * anyway. A fainted party is the thing that must be dealt with before any job
 * will finish, so healing rises above the jobs. Then the specific intent
 * already expressed by picking a species, then the general one, then healing
 * when it is merely tidy.
 */
export function describeOffers(s, ctx = {}) {
  const rows = describeRows(s, ctx);
  // Nothing is offered before there is a world: on the title screen every job
  // would refuse, and a hint about how to unlock them would be a hint about
  // pressing the button the loader is already showing.
  if (!s.worldLoaded) return { offered: [], rank: {}, hint: '' };

  const afoot = !s.inBattle;
  const fainted = s.party.some((m) => m.hp === 0);
  // Fight and Throw are not on this list. They answer the battle in front of
  // you rather than being sent off to do something, and they live beside the
  // pad while one is on -- opening a door over a battle to answer it was the
  // wrong shape for the only two actions that are ever modal.
  const order = [];
  if (fainted) order.push('heal');
  // Travel sits below the jobs and above nothing: it is the one offer that is
  // never urgent -- a place is still there in a minute -- and it is also the
  // only one somebody reaches for while *not* mid-task, so burying it would be
  // wrong too. Last of the five, drawn whenever there is somewhere to go.
  // Take sits above Travel and below the jobs, for the reason Travel is last:
  // it is never urgent, but unlike a place, a thing lying on the ground is
  // *here* -- and the whole of its cost is that you walked past it.
  // Shop sits last, below Travel. It is the only offer that is never about
  // where you are or what is wrong -- it is about what you will need next, and
  // that is the least urgent thing on the list.
  // Duel sits with the jobs that level things up, above Take and below Grind,
  // and the order between those two is a judgement about cost: grass is always
  // there and a trainer is beaten once, so a trainer here now is the more
  // perishable offer -- but a duel can also be lost, and grinding cannot.
  // Grind first, therefore, and Duel immediately after it.
  // Gym sits between Duel and Heal: it is the job that opens roads, so it is
  // worth more than tidying up and less than being able to fight at all.
  // **An errand outranks everything the pilot could do again tomorrow**, and
  // the first draft of this line said so in a comment while putting it below
  // Grind -- the prose and the order disagreeing, which is the failure this
  // repository has a whole tool for one directory over.
  //
  // The reason it goes high is not urgency, which is what the rest of this
  // ordering is about. It is that an errand is **finite and a
  // precondition**: run it once and it is gone, and until it is run the place
  // on the other side of the road cannot be reached at all. Grinding is
  // infinite and always available, so it can wait; a road cannot, because
  // nothing beyond it is on the list to be waited for.
  //
  // Below Hunt and Catch, because those are what somebody has already chosen
  // by picking a species, and above everything else bar a fainted party --
  // which is still first, since none of this can be done at all without
  // somebody able to fight.
  order.push('catch', 'hunt', 'errand', 'grind', 'duel', 'gym', 'heal', 'take',
             'travel', 'shop');

  const offered = [];
  for (const key of order) {
    if (offered.includes(key) || !rows[key]) continue;
    // Catch keeps its place when the only thing missing is the balls, because
    // the errand that fetches them lives in that row: hiding it would hide the
    // way out of the very state it describes. On a cartridge with no errand
    // there is no way out, so the row goes -- an offer whose only action does
    // not exist is worse than an absence, and the hint says what is missing.
    // **Catch no longer earns its place from needing balls.** That rule
    // existed because the errand that fetches them was a button on the Catch
    // row; it is a row of its own now, ranked high, and so the way out of "no
    // Poké Balls yet" is on the list either way -- said by the row that can
    // actually be pressed rather than by the one that cannot.
    let usable = rows[key].enabled;
    // A row also earns its place while it is *waiting on a choice that can be
    // made here*, and leaving that out was a dead end rather than an
    // untidiness. The picker below the list is drawn only when the row that
    // reads it is on the list -- so a row that appears only once a choice is
    // made can never be chosen for.
    //
    // Measured: with Poké Balls in the bag and no species picked, the rank was
    // `{grind:1}`, the species picker was hidden, and the hint underneath still
    // read "pick something below to hunt or catch". Nothing below. Hunt and
    // Catch were both unreachable for the rest of the session -- and that state
    // is exactly what running the ball errand leaves you in. Catch had a
    // version of this rule already, for the no-balls case, which is why the
    // no-balls path worked and the has-balls one did not.
    if (!usable && afoot) {
      if (key === 'hunt') usable = (ctx.huntable || 0) > 0;
      if (key === 'catch') usable = (ctx.huntable || 0) > 0 && !!ctx.ballId;
      if (key === 'travel') usable = rows.travel.places.length > 0;
    }
    if (usable) offered.push(key);
  }

  // The hint says what would add to the list, and only when there is something
  // to do about it. "Nobody is hurt" is not worth a line -- it is the good
  // state, and explaining the absence of an offer nobody wanted is the noise
  // this whole list replaces.
  const hint = [];
  // In a battle the list is empty by design, and an empty list with no
  // explanation reads as broken rather than as modal.
  if (s.inBattle) hint.push('Fight and Throw are by the pad while a battle is on');
  if (afoot && !s.party.length) hint.push('most jobs need a Pokémon with you');
  // Only worth saying where it is the thing standing in the way: with a target
  // picked, no balls, and no errand to fetch any, Catch has quietly left the
  // list and this is the sentence that explains it.
  if (afoot && ctx.huntWanted && ctx.canFetch === false && rows.catch.needsBalls) {
    hint.push('catching needs Poké Balls, and this build cannot fetch them');
  }
  // Only where there is in fact something below. The line used to be
  // unconditional on "no species chosen", which pointed at a picker that is
  // hidden whenever neither Hunt nor Catch is on the list -- see the ranking
  // above, which is where that is now fixed rather than papered over here.
  // **Gone, because the rows do it now.** This pointed at a picker somewhere
  // below; the Hunt and Catch rows carry a slot that scrolls straight to it, so
  // the sentence was describing a journey the person no longer has to make.
  // Kept as a comment rather than deleted silently: the *ranking* rule it was
  // paired with -- that a row waiting on a choice stays on the list, or the
  // picker can never be reached -- is still load-bearing and still tested.
  // Only where it is the thing in the way: trainers on the map, and nobody
  // able to answer them. Worth a line because the fix is a job that *is* on the
  // list -- Heal is above this one, offered by the same fainted party -- and
  // without the sentence the two offers read as unrelated.
  if (afoot && (ctx.trainers || []).length && !s.party.some((m) => m.hp > 0)) {
    hint.push('a trainer here would need somebody fit to send out');
  }
  // **The row that explains a shut route is hidden exactly when it applies.**
  // `enabled` is what puts a row on the list, and a route the game has refused
  // is precisely when Heal cannot run -- so the sentence written into the row
  // text is never read, which is the same trap the species picker fell into
  // eight passes ago and the reason that fix went here rather than there.
  //
  // Worth a line because there *is* something to do about it, and it is not a
  // button: a badge is what opens one of these, and the words the game used
  // are what point at which one.
  if (afoot && ctx.healShut && s.party.some((m) => m.hp < m.maxHp)) {
    hint.push(`every way to heal is shut — ${ctx.healShut}`);
  }
  // **A road the game is keeping shut, and the thing that opens it.** Without
  // this a gated destination is written off after one failed walk and then
  // simply stops being offered: Travel loses a place, says nothing, and the
  // person is left to work out that the app is not broken. Only where the app
  // can actually read the gate -- `gatesFrom` returns nothing on a cartridge
  // whose symbol file cannot say, because "I do not know" must not be dressed
  // up as "it is shut".
  for (const g of ctx.gated || []) {
    hint.push(`${g.where} wants ${g.needs}`);
  }
  // **What is behind the Gym door, before the walk rather than after it.**
  // The row can only say where the Gym is and who is in it; whether it is
  // worth going is two facts the cartridge has had all along -- the levels
  // waiting in there, and whether anything you carry can take HP off them.
  //
  // Only when there is something to say. A party that is ahead on level and
  // can hurt everything in the room is the good state, and a line explaining
  // that is the noise this list exists to replace.
  const gymRom = ctx.rom || null;
  if (afoot && ctx.gym && gymRom && gymRom.trainer && s.party.length) {
    const them = gymRom.trainer(ctx.gym.leader);
    const view = them ? gymRom.outlook(s.party, them.party) : null;
    if (view && view.helpless.length === them.party.length) {
      // The sharp one, and it is worth its own sentence: a party that cannot
      // touch *anything* in the room is not a party that needs another level.
      hint.push(`nothing you carry can touch anything ${them.name} has`);
    } else if (view && view.helpless.length) {
      const who = view.helpless
        .map((m) => `${gymRom.speciesName(m.species)} Lv${m.level}`);
      hint.push(`nothing you carry can touch ${who.join(' or ')}`);
    } else if (view && view.top > view.best) {
      hint.push(`${them.name} tops out at Lv${view.top} `
                + `and your best is Lv${view.best}`);
    }
  }
  // Nobody near, and somebody further on. This is the one hint that is purely
  // about distance, and it is here rather than in the row because the row is
  // hidden whenever it cannot run: the map's total is exactly the fact you
  // cannot see from the offer that is missing.
  if (afoot && !rows.duel.count && rows.duel.onMap) {
    hint.push(`${rows.duel.onMap} more trainer${rows.duel.onMap === 1 ? '' : 's'}`
              + ' further along this map');
  }
  // Advice rather than state, so it goes here and the range itself stays in the
  // row. Only where a grind is actually on offer: on a map with no grass the
  // range is unknown rather than unfavourable, and there is nothing to advise.
  if (afoot && rows.grind.outlevelled && offered.includes('grind')) {
    // And where to go instead, when the graph and the encounter tables between
    // them know of somewhere. Naming the place is the whole value: "this will be
    // slow" is a complaint, and "Route 30 gives Lv4-5, two maps away" is
    // something to do about it.
    // Waiting before walking. The grass under your feet at another hour is the
    // cheapest fix there is -- no route, no legs, nothing to go wrong -- so an
    // hour that pays outranks a map that pays, however near the map is.
    const lead = s.party[0];
    const hour = lead ? betterHour(ctx.hours, lead.level, ctx.hourNow) : null;
    if (hour) {
      hint.push(`slow here — this grass gives Lv${range(hour.wilds)} ${hour.name}`);
    } else {
      // Computed here rather than above, so the preference lives in exactly one
      // place. Guarding the *call* as well reads as thrift and is worse than
      // that: it makes the ordering true twice, and a mutation that inverts
      // either copy is cancelled by the other -- which is how this was found,
      // by a mutation that should have broken a test and did not.
      const better = lead ? betterGrind(ctx.places, lead.level) : null;
      hint.push(better
        ? `slow here — ${better.name} gives Lv${range(better.wilds)}, `
          + legsWord(better.legs)
        : 'grinding here will be slow — everything is below your lead');
    }
  }
  // **Gone for the same reason its sibling went**: the Travel row carries a
  // slot that says *Choose a place* and scrolls to the list. A hint saying
  // there is a place to choose, under a row already offering to choose it, is
  // the app talking to itself. The condition it was guarded by -- that the row
  // is drawn and waiting -- is now the condition that draws the slot.
  return {
    offered,
    rank: Object.fromEntries(offered.map((key, i) => [key, i + 1])),
    // Two clauses at most. A third is a paragraph, and this is a line.
    hint: hint.slice(0, 2).join(' · '),
  };
}

/**
 * Which job the pilot would start next if nobody chose one, and when to stop.
 *
 * The list above this row is already ranked, every refresh, from what the game
 * says -- which is the whole thesis of the app. Running the top of it and then
 * reading the list again is therefore not a new decision: it is the decision
 * the app has been making and showing all along, taken repeatedly. So there is
 * very little here, and that is the point.
 *
 * Two jobs are never taken on their own, and for two different reasons:
 *
 *   * **Travel** is a destination, and a destination is somebody's choice. The
 *     row carries a slot for picking one precisely because the app cannot.
 *   * **Hunt** ends *inside* a battle by design -- that is what it is for, to
 *     hand you one. A step that finishes somewhere the next step cannot start
 *     is not a step in a sequence.
 *
 * Catch is on the list, because it finishes the battle it starts, and its
 * species is a choice already made and remembered. A row still waiting on one
 * (`needs`) is skipped for the same reason Travel is.
 *
 * `changed` is the caller's evidence, not a claim: a signature of the things a
 * job could move -- where you are, the money, the badges, the party, the bag.
 * The loop that must end is the one where a job reports success and leaves the
 * world exactly as it was, which is a real state rather than a hypothetical:
 * "off to heal" with a full party heals nothing, says so cheerfully, and is
 * offered again a tenth of a second later.
 */
const AUTO_NEVER = ['travel', 'hunt'];

export function describeAuto(offers, rows, { last = null, changed = true } = {}) {
  const ready = (offers.offered || []).filter(
    (key) => !AUTO_NEVER.includes(key)
             && rows[key] && rows[key].enabled && !rows[key].needs);
  if (!ready.length) {
    return { key: null, enabled: false,
             text: 'nothing it can start on its own' };
  }
  // `offered` is in rank order, so the front of it is the row wearing the
  // accent -- the one a person would have pressed.
  const key = ready[0];
  const name = key[0].toUpperCase() + key.slice(1);
  if (key === last && !changed) {
    return { key: null, enabled: false,
             text: `${name} ran and changed nothing` };
  }
  // Only the first step is promised. What follows is decided after this one
  // has moved something, and saying otherwise would be a plan the app cannot
  // keep -- one heal changes which row leads.
  return { key, enabled: true, text: `starts with ${name}` };
}

/**
 * What the game itself is saying, as one line for the status bar.
 *
 * The bar already mirrors the *pilot's* newest line -- "heading left", "using
 * POTION" -- which says what the pilot is doing. This says what the **game** is
 * doing, which is a different thing and was invisible: a ninety-second job
 * showed a busy dot and the pilot's own commentary, and the screen it was
 * driving might have been asking a question nobody could see.
 *
 * The last two readable lines, because that is where Gen 2 puts its text box --
 * the menu rows sit above it, and when there is no text the bottom of a menu is
 * the next most useful thing. Whitespace collapses, because the screen is
 * twenty columns of padding.
 *
 * Hidden rather than blank when there is nothing to say. An overworld has an
 * empty tilemap, which is most of the time a walk is running, and a bar element
 * that is present-but-empty pushes the line it shares.
 */
export function describeSaying(lines, { max = SAYING_MAX } = {}) {
  // A run of spaces is kept as a separator rather than collapsed, because a
  // Gen 2 screen has *columns*: measured on the START menu, one tilemap row
  // carries "Save your" on the left and "EXIT" on the right, and collapsing the
  // gap between them reads as one sentence that says neither. Three spaces or
  // more is a gap somebody put there.
  const said = (lines || [])
    .map((l) => String(l).replace(/ {3,}/g, ' · ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!said.length) return { text: '', hidden: true };
  const text = said.slice(-2).join(' ');
  return {
    text: text.length > max ? `${text.slice(0, max - 1)}…` : text,
    hidden: false,
  };
}

/**
 * The party in one line: who leads, and whether anyone needs a Center.
 *
 * The party had a card of its own with a row and an HP bar per member -- six
 * rows for two facts a pilot acts on. Which one leads decides what a grind
 * levels, and whether anyone is hurt decides whether Heal is on the list, so
 * both belong at the top of the list that uses them rather than in a panel
 * below it. The bars are still there, one tap down, for when the summary is not
 * the answer.
 *
 * Fainted outranks hurt and is said instead of it: a fainted party is the state
 * that stops a job finishing, and "3 hurt" said of a party with one out cold
 * buries the part that matters.
 */
export function describeParty(s, ctx = {}) {
  const { rom = null } = ctx;
  const lead = s.party[0];
  if (!lead) return 'no party yet';
  const name = rom ? rom.speciesName(lead.species) : `#${lead.species}`;
  const bits = [`${name} Lv${lead.level}`, `${lead.hp}/${lead.maxHp}`];
  const rest = s.party.length - 1;
  if (rest > 0) bits.push(`+${rest} more`);
  const out = s.party.filter((m) => m.hp === 0).length;
  const hurt = s.party.filter((m) => m.hp > 0 && m.hp < m.maxHp).length;
  if (out) bits.push(`${out} fainted`);
  else if (hurt) bits.push(`${hurt} hurt`);
  return bits.join(' · ');
}

/** One slot's line: where it was, who was leading, and when. */
export function describeSlot(meta, tag = null) {
  if (!meta) return 'empty';
  // A save is written in the layout of the build that wrote it, so bytes from
  // another cartridge load and are then confidently wrong -- which is worse
  // than not loading. The handoff row has always said this about a save from
  // the room; a slot is the same bytes from the same person's other cartridge.
  // `tag` unknown on either side means an older slot, from before slots
  // recorded one, and those are believed as they always were.
  if (tag && meta.tag && meta.tag !== tag) return 'from a different ROM';
  const bits = [];
  if (meta.where) bits.push(meta.where);
  if (meta.lead) bits.push(meta.lead);
  if (meta.when) {
    const d = new Date(meta.when);
    bits.push(`${String(d.getHours()).padStart(2, '0')}`
      + `:${String(d.getMinutes()).padStart(2, '0')}`);
  }
  return bits.join(' · ') || 'kept';
}

/**
 * The undo row.
 *
 * Three states, not two, and the third is the one that matters: a job that
 * could not be undone reads differently from no job having run. They used to
 * share a sentence, so an undo point silently lost looked exactly like a fresh
 * session -- and you found out by reaching for it.
 */
export function describeUndo(point, refused) {
  if (point) {
    return { text: `back to before ${point.job} · ${describeSlot(point)}`,
             enabled: true };
  }
  if (refused) {
    return { text: `the last job could not be undone — ${refused}`,
             enabled: false };
  }
  return { text: 'nothing to undo yet', enabled: false };
}

/**
 * Which cartridge the pilot thinks it is driving, and how well it knows it.
 *
 * Silent for a game it has a full description of, because "this is Crystal" is
 * not news to somebody who just picked Crystal. It exists for the other case: a
 * cartridge nobody has described gets a profile that names no map and knows
 * nowhere to heal, and the app then behaves *correctly* in a way that looks
 * broken -- "map 26.1" in the header, no offer to start a game, no Heal. This
 * is the sentence that makes those a consequence rather than a mystery.
 *
 * `names` and `healers` are counted rather than trusted, because a profile with
 * no names is the generic one whatever it calls itself -- and a profile with
 * names and no healers is somebody's half-finished file, which is worth saying
 * differently because it is a file to go and finish.
 */
export function describeTitle(title) {
  if (!title) return { text: '', show: false };
  const names = Object.keys(title.names || {}).length;
  const healers = (title.healers || []).length;
  const scripted = typeof title.drive === 'function'
    && typeof title.drive.prototype.run === 'function';
  if (names && healers && scripted) return { text: '', show: false };
  if (!names) {
    return {
      show: true,
      text: 'no profile for this cartridge — maps are numbered, and the pilot '
            + 'cannot start a game or heal',
    };
  }
  const missing = [];
  if (!healers) missing.push('nowhere to heal');
  if (!scripted) missing.push('no scripted start');
  return {
    show: true,
    text: `${title.id} · ${names} map${names === 1 ? '' : 's'} named`
          + (missing.length ? ` · ${missing.join(', ')}` : ''),
  };
}

/**
 * What the Devices row says, and what its button offers.
 *
 * Here rather than in main.js for the same reason every other row's wording is
 * here: this is four states and a code, and the only way to be sure all four
 * read like sentences is to be able to run them.
 *
 * `status` is kidsync's: 'local' before a room exists, then 'connecting',
 * 'synced', 'offline' -- plus 'unavailable' from room.js, which is what an
 * offline first load looks like, when the Firebase SDK could not be fetched at
 * all. That one is deliberately not an error: sharing is a bonus layer.
 */
export function describeRoom({ status = 'local', code = null } = {}) {
  if (status === 'unavailable') {
    return { text: 'no connection — sharing needs one', button: null, joining: false };
  }
  if (!code) {
    return { text: 'not sharing', button: 'Share', joining: true };
  }
  if (status === 'connecting') {
    return { text: `connecting to ${code}`, button: 'Stop', joining: false };
  }
  if (status === 'offline') {
    return { text: `${code} — offline, will catch up`, button: 'Stop', joining: false };
  }
  return { text: `sharing as ${code}`, button: 'Stop', joining: false };
}

/**
 * Why a code did not join, as a sentence.
 *
 * kidsync answers with a reason rather than throwing, because a mistyped code
 * is a normal thing to do. The default is deliberately vague rather than
 * silent: a reason this build has never heard of should still say something.
 */
export function joinFailure(reason) {
  if (reason === 'malformed') return 'a code is five letters and numbers, like K7M2P';
  if (reason === 'not-found') return 'no room with that code — check for a typo, or press Share on the other device';
  if (reason === 'not-configured') return 'this build has no Firebase config, so it cannot share';
  if (reason === 'network') return 'could not reach the room — try again in a moment';
  return `could not join: ${reason}`;
}

/**
 * What the handoff row says, and whether taking over is on offer.
 *
 * The states are what one person with two devices actually meets, and the
 * wording of each is the whole feature: this row is the only place the app can
 * tell you that the game you want is on the other device.
 *
 * `seen` is baton's peek(); `rev` is the revision this device's own battery
 * corresponds to, so "in step" means the bytes here and the bytes there are
 * the same save rather than merely both existing.
 *
 * `urgent` is which of these five states earns a place on the status line. Two
 * do: the other device is ahead of this one, and the room is holding a save
 * from a different build. The other three are either nothing having happened
 * yet or everything being fine, and this row now lives on the one line that is
 * always on screen -- where "in step" every second of a session is exactly the
 * noise the rest of this interface was rewritten to remove.
 */
export function describeHandoff({ seen = null, rev = 0, tag = null } = {}) {
  if (!seen || seen.empty) {
    return { text: 'nothing shared yet — save the game to put it here',
             button: null, urgent: false };
  }
  if (tag && seen.tag && seen.tag !== tag) {
    // Addresses and save layout both come from the build, so bytes from
    // another ROM are not a save this cartridge would load.
    return { text: `${seen.by} shared a save from a different ROM`,
             button: null, urgent: true };
  }
  if (seen.rev > rev) {
    const where = seen.says ? ` · ${seen.says}` : '';
    return { text: `${seen.by} has the newer save${where}`,
             button: 'Take over', urgent: true };
  }
  if (seen.rev < rev) {
    return { text: 'this device has the newer save — save again to share it',
             button: null, urgent: false };
  }
  return { text: seen.says ? `in step · ${seen.says}` : 'in step',
           button: null, urgent: false };
}

/**
 * What the replaced-game row says.
 *
 * It exists only when a handoff has actually replaced something, because a row
 * reading "nothing was replaced" is a row explaining a mechanism nobody has
 * met yet. When it does exist it has to say enough to be worth pressing:
 * whose game went away, and where it was.
 */
export function describeReplaced(meta, tag = null) {
  if (!meta) return { text: '', enabled: false, show: false };
  // Shown but not offered when it belongs to another cartridge. Hiding it would
  // be worse: the row is the only record that a handoff took a game away, and
  // "your game is still here, on the other cartridge" is the useful sentence.
  const mine = !(tag && meta.tag && meta.tag !== tag);
  return { text: describeSlot(meta, tag), enabled: mine, show: true };
}

/**
 * What the screen-sharing row says, and what its button offers.
 *
 * Five states, and the two that matter most are the ones that are not about
 * this device: someone else is showing, and you are watching them. The others
 * only have to stay out of the way.
 *
 * `play` is whether a watching device may press the pad. It is this device's
 * own decision while hosting and the host's advertisement while watching, and
 * it is a *host*-side guarantee: a watcher that chose not to send would be
 * honour-system, and the joypad channel is the thing that has to say no.
 *
 * `input` is the live answer instead of the advertised one, `{ok, why}`, and it
 * exists because there are two ways a press goes nowhere: view-only, which is a
 * decision, and a pilot job holding the joypad, which ends by itself.
 */
export function describeScreen({ hosting = false, watching = false, host = null,
                                 viewer = null, asleep = false, play = true,
                                 input = null, game = true } = {}) {
  if (hosting) {
    const how = play ? 'they can play' : 'view only';
    // The second control is what the *other* mode would be, because a button
    // saying the state you are already in is a button that appears to do
    // nothing. Showing with nobody watching still offers it: the choice is
    // worth making before someone joins rather than after.
    const second = play ? 'View only' : 'Hand over';
    return viewer
      ? { text: `showing this screen to ${viewer} · ${how}`,
          button: 'Stop', second }
      : { text: `showing this screen${play ? '' : ', view only'}`
               + ' — press Watch on the other device',
          button: 'Stop', second };
  }
  if (watching) {
    const who = host || 'the other device';
    if (asleep) return { text: `${who} has its screen off`, button: 'Leave' };
    // Two different reasons the pad does nothing, and they are not the same
    // news: one is a decision on the other device, the other is temporary and
    // ends by itself. Silence was the third option and the worst -- the pad
    // looked live and every press went nowhere.
    if (input && !input.ok) {
      const why = input.why === 'busy' ? 'the pilot is driving' : 'view only';
      return { text: `watching ${who} · ${why}`, button: 'Leave' };
    }
    return { text: `watching ${who}`, button: 'Leave' };
  }
  // Whether pressing Watch gets a pad is worth knowing *before* pressing it,
  // and the note carries the answer, so there is no reason to make someone find
  // out by trying.
  if (host) {
    return { text: `${host} is showing its screen${play ? '' : ' · view only'}`,
             button: 'Watch' };
  }
  // A device with no game has nothing to show, and offering it anyway is not a
  // harmless button that does nothing. Pressing it captures the blank canvas,
  // announces this device as showing, and hands the other one a black
  // rectangle -- with the row on both devices insisting a screen is being
  // shared. That was reachable before there was a door for it and is the only
  // thing on offer after: a device that came to watch has, by definition, no
  // game, and 'Show' is the wrong verb for every one of them.
  if (!game) {
    return { text: 'waiting for your other device to show its screen',
             button: null };
  }
  return { text: 'not showing this screen', button: 'Show', second: 'View only' };
}

// --- the dex card -----------------------------------------------------------
// What one Pokémon is, said in words. Pure like everything else here: it takes
// a `monDetail` entry and the cartridge's tables and returns text and numbers,
// and `main.js` decides what a bar looks like.

// How the six stats are labelled, in the order `engine.statNames` has them.
// Labels rather than keys because "satk" is not a word, and the abbreviations
// are the game's own -- a Gen 2 stat screen says SPCL.ATK.
const STAT_LABELS = { hp: 'HP', atk: 'Atk', def: 'Def', spd: 'Speed',
                      satk: 'Sp.Atk', sdef: 'Sp.Def' };
// The engine profile's growth-rate keys, in English. A key the profile has no
// word for is a number, and it is shown as one rather than as a wrong word --
// which is the same bargain `romdata.baseStats` makes when it hands the key
// through unchanged.
const GROWTH_WORDS = {
  mediumFast: 'medium-fast', slightlyFast: 'slightly fast',
  slightlySlow: 'slightly slow', mediumSlow: 'medium-slow',
  fast: 'fast', slow: 'slow',
};

/** `12 · 7 · 3` — a level distance, said the way somebody grinding thinks. */
function away(levels) {
  if (levels <= 0) return 'now';
  return levels === 1 ? '1 level away' : `${levels} levels away`;
}

/**
 * One evolution as a phrase, with how far off it is when that can be said.
 *
 * Only two of the five kinds have a distance at all. A stone or a trade
 * happens when you do it, and friendship happens when it happens — so those
 * say what is needed and stop, rather than inventing a number to be tidy with.
 */
function evolutionPhrase(rec, mon, rom) {
  const into = rom.speciesName(rec.into);
  const item = () => rom.itemName(rec.item) || 'something';
  switch (rec.kind) {
    case 'level':
      return rec.level > mon.level
        ? `${into} at Lv${rec.level} — ${away(rec.level - mon.level)}`
        : `${into} at Lv${rec.level}`;
    case 'item':
      return `${into} with a ${item()}`;
    case 'trade':
      return rec.item ? `${into} if traded holding a ${item()}`
                      : `${into} if traded`;
    case 'happiness': {
      const when = { morningDay: ', in the morning or day', night: ', at night' };
      return `${into} with friendship${when[rec.when] || ''}`;
    }
    case 'stat': {
      const how = { atkOverDef: 'attack beats defence',
                    atkUnderDef: 'defence beats attack',
                    atkEqualsDef: 'they are equal' };
      const far = rec.level > mon.level ? ` — ${away(rec.level - mon.level)}` : '';
      return `${into} at Lv${rec.level} if ${how[rec.compare] || rec.compare}${far}`;
    }
    default:
      return into;
  }
}

/**
 * One party member, in full: what it is, what it is made of, and what is
 * coming.
 *
 * `mon` is a `monDetail` entry. Everything the cartridge cannot say comes back
 * null rather than as a hedge in a sentence, because the card leaves a row out
 * rather than printing "unknown" six times — a cartridge whose symbol file is
 * short of a table should look like a smaller card, not a broken one.
 *
 * **The two special stats deliberately show the same DV and the same
 * counter.** That is not a bug being rendered: Gen 2 rolls one Special DV and
 * grows one Special stat experience, and spends both on the two stats. Showing
 * six independent pairs would be showing two numbers twice and implying they
 * can differ. `engine.statSource` is where that is stated.
 */
export function describeDex(mon, ctx = {}) {
  const { rom = null, engine = {} } = ctx;
  if (!mon) return null;
  const name = rom ? rom.speciesName(mon.species) : `#${mon.species}`;
  const statNames = engine.statNames || [];
  const source = engine.statSource || {};
  const base = rom && rom.baseStats ? rom.baseStats(mon.species) : null;
  const ea = rom && rom.evosAttacks ? rom.evosAttacks(mon.species) : null;

  // Deduplicated, because Gen 2 stores a single-typed Pokemon as both of its
  // types -- the same reason `effectiveness` deduplicates before multiplying.
  // A card reading "FIRE / FIRE" is showing the storage rather than the answer.
  const types = base && rom.typeName
    ? [...new Set(base.types)].map((t) => rom.typeName(t) || `type ${t}`)
      .filter(Boolean)
    : [];

  const stats = statNames.map((key) => ({
    key,
    label: STAT_LABELS[key] || key,
    value: (mon.stats || {})[key] ?? null,
    base: base ? base.stats[key] : null,
    dv: (mon.dvs || {})[source[key]] ?? null,
    // Gen 2 spends the *square root* of this counter, so the counter itself is
    // a number nobody can read anything into: 1600 and 2500 look far apart and
    // are forty points and fifty. Both are given -- the raw counter because it
    // is what the cartridge holds, and a fraction of the *useful* ceiling
    // (255 squared, past which the square root stops moving) because that is
    // the one a bar can honestly be drawn from.
    effort: (mon.statExp || {})[source[key]] ?? null,
    effortPart: engine.statExpUseful
      ? Math.min(1, ((mon.statExp || {})[source[key]] || 0) / engine.statExpUseful)
      : null,
  }));

  const knows = (mon.moves || [])
    .map((id, i) => (id && rom
      ? { name: rom.moveName(id) || `move ${id}`, pp: (mon.pp || [])[i] ?? null }
      : null))
    .filter(Boolean);

  // The next thing it learns, and the next thing it becomes. Both are "after
  // this level", both are the question somebody grinding is actually asking,
  // and both are null where the cartridge will not say -- which reads as a
  // shorter card rather than as a claim that nothing is coming.
  const later = ea ? ea.learns.filter((m) => m.level > mon.level)
    .sort((a, b) => a.level - b.level) : [];
  const next = later.length
    ? `${rom.moveName(later[0].move) || `move ${later[0].move}`}`
      + ` at Lv${later[0].level} — ${away(later[0].level - mon.level)}`
    : null;
  const becomes = ea && ea.evolves.length
    ? ea.evolves.map((rec) => evolutionPhrase(rec, mon, rom)) : [];

  const bits = [];
  if (mon.happiness !== undefined) bits.push(`friendship ${mon.happiness}`);
  if (mon.item && rom) bits.push(`holding ${rom.itemName(mon.item) || 'something'}`);
  if (base) bits.push(`${GROWTH_WORDS[base.growth] || base.growth} growth`);

  return {
    name,
    level: mon.level,
    types,
    stats,
    knows,
    next,
    becomes,
    origin: describeOrigin(mon.caught, ctx),
    extra: bits.join(' · '),
    // Said once, at the bottom, rather than as a gap in every row above it.
    shy: ea ? null : 'this cartridge does not say what it learns or becomes',
  };
}

/**
 * Where a Pokemon came from, or null where the save does not hold it.
 *
 * Null is common and not a failure: a starter was never caught, and a save
 * brought in from Gold or Silver holds zeroes in this field.
 */
function describeOrigin(caught, ctx = {}) {
  const { rom = null } = ctx;
  if (!caught) return null;
  const place = rom && rom.landmarkName ? rom.landmarkName(caught.place) : '';
  const bits = [`caught at Lv${caught.level}`];
  if (place) bits.push(`in ${place}`);
  if (caught.when) bits.push(`at ${caught.when}`);
  return bits.join(' ');
}

/**
 * The one line above the caught list.
 *
 * Three numbers, and the third is the one that makes the other two mean
 * anything: "24 caught" says nothing without how many there are to catch, and
 * the count is the cartridge's rather than 251 written down here.
 */
export function describeDexTotals(dex, ctx = {}) {
  const { engine = {} } = ctx;
  if (!dex) return 'this cartridge does not keep a Pokédex';
  const total = engine.speciesCount || 0;
  const caught = (dex.caught || []).length;
  const seen = (dex.seen || []).length;
  // Seen is the wider list and includes everything caught, so saying both
  // without saying that reads as two competing totals.
  return `${caught} caught of ${total} · ${seen} seen`;
}
