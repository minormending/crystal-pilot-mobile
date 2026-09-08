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
 *   places            named maps reachable from here, [{ key, name, legs }]
 *   travelTo          the map key chosen to walk to, or null
 *   huntable          how many species appear here at this hour
 *   wilds             the levels the grass gives here, { low, high } or null
 */
export function describeRows(s, ctx = {}) {
  const { rom = null, target = 5, huntWanted = null, ballId = null,
          savedThisSession = false, healPlace = null,
          places = [], travelTo = null, wilds = null, takeables = [],
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
  const needsBalls = !ballId;
  const ballName = ballId && rom ? rom.itemName(ballId) : null;
  const foe = s.inBattle ? name(s.enemy.species) : null;
  const trainer = s.battleMode === trainerBattle;
  const hurt = s.party.filter((m) => m.hp < m.maxHp);

  // Saving drives the START menu, and that menu does not open in a battle or
  // mid-script.
  const canSave = s.worldLoaded && !s.inBattle && !s.scriptRunning;
  // Anything that walks needs a world to walk in and no battle in the way.
  // These used to be looser -- grind was enabled on `lead` alone -- which was
  // survivable while every row was drawn and greyed out, and is not now that
  // the list only holds things that can run: an offer that refuses itself is
  // worse than no offer.
  const afoot = s.worldLoaded && !s.inBattle;
  const canCatchHere = s.inBattle && !trainer && !!ballId
                       && s.party.length < maxParty;
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
        : wilds ? `${leadName} → Lv${target} · here: Lv${range(wilds)}`
        : `${leadName} → Lv${target}`,
      enabled: !!lead && afoot,
      // The level presets are meaningless with nothing to level.
      levels: !!lead,
      // Every battle here is against something weaker than the thing being
      // trained. A fact about two numbers rather than a formula about
      // experience, which is why it is stated and not calculated.
      outlevelled: !!(lead && wilds && lead.level > wilds.high),
    },
    hunt: {
      text: huntWanted ? `${huntWanted} · here now` : 'pick something below',
      enabled: !!huntWanted && afoot,
    },
    // Catch owns its own prerequisite. The errand is a one-time thing -- run it
    // twice and it reports "already carrying 5 ball(s)" without moving -- so it
    // is Catch's empty state rather than a peer button.
    catch: {
      text: needsBalls
        ? 'no Poké Balls yet — fetch them first'
        : huntWanted ? `${huntWanted} · ${ballName}` : 'pick something below',
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
    export: {
      text: savedThisSession
        ? 'ready — the battery has this session in it'
        : 'the battery save, for another emulator',
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
        : s.party.length >= maxParty ? 'the party is full'
        : needsBalls ? 'no Poké Balls yet'
        : `${foe} Lv${s.enemy.level} · ${ballName || 'a ball'}`,
      enabled: canCatchHere,
    },
    heal: {
      text: s.inBattle ? 'finish the battle first'
        : !s.party.length ? 'no party yet'
        : hurt.length
          ? `${hurt.length} hurt · nearest is ${healPlace || 'a Center'}`
          : 'everyone is at full health',
      enabled: afoot && hurt.length > 0,
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
          : 'pick a place below',
      enabled: afoot && !!travelTo && byKey.has(travelTo),
      places,
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
  };
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
  order.push('catch', 'hunt', 'grind', 'heal', 'take', 'travel');

  const offered = [];
  for (const key of order) {
    if (offered.includes(key) || !rows[key]) continue;
    // Catch keeps its place when the only thing missing is the balls, because
    // the errand that fetches them lives in that row: hiding it would hide the
    // way out of the very state it describes. On a cartridge with no errand
    // there is no way out, so the row goes -- an offer whose only action does
    // not exist is worse than an absence, and the hint says what is missing.
    let usable = rows[key].enabled
                 || (key === 'catch' && rows.catch.needsBalls && afoot
                     && ctx.canFetch !== false);
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
  if (afoot && !ctx.huntWanted && (ctx.huntable || 0) > 0) {
    hint.push('pick something below to hunt or catch');
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
  // Only when the row is drawn and waiting on a choice. A cartridge with no
  // named places has no row and no hint -- there is nothing to do about it from
  // here, and saying so would be nagging about a file somebody else has to
  // write.
  if (afoot && rows.travel.places.length && !ctx.travelTo) {
    hint.push('or a place to walk to');
  }
  return {
    offered,
    rank: Object.fromEntries(offered.map((key, i) => [key, i + 1])),
    // Two clauses at most. A third is a paragraph, and this is a line.
    hint: hint.slice(0, 2).join(' · '),
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
