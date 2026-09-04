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
import { MAX_PARTY, TRAINER_BATTLE } from './state.js';

/**
 * `ctx` is everything outside the game that changes what a row says:
 *   rom               the cartridge tables, or null before a ROM is picked
 *   target            the level a grind is aimed at
 *   huntWanted        the species chosen below, or null
 *   ballId            the ball to throw, or null when there are none
 *   savedThisSession  whether this tab has committed a save
 *   healPlace         where healing would go, worked out once per refresh
 */
export function describeRows(s, ctx = {}) {
  const { rom = null, target = 5, huntWanted = null, ballId = null,
          savedThisSession = false, healPlace = null } = ctx;
  const name = (id) => (rom ? rom.speciesName(id) : null);

  const lead = s.party[0];
  const leadName = lead ? name(lead.species) : null;
  const needsBalls = !ballId;
  const ballName = ballId && rom ? rom.itemName(ballId) : null;
  const foe = s.inBattle ? name(s.enemy.species) : null;
  const trainer = s.battleMode === TRAINER_BATTLE;
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
                       && s.party.length < MAX_PARTY;

  return {
    grind: {
      text: lead ? `${leadName} → Lv${target}` : 'no party yet',
      enabled: !!lead && afoot,
      // The level presets are meaningless with nothing to level.
      levels: !!lead,
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
        : s.party.length >= MAX_PARTY ? 'the party is full'
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
  };
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
  order.push('catch', 'hunt', 'grind', 'heal');

  const offered = [];
  for (const key of order) {
    if (offered.includes(key) || !rows[key]) continue;
    // Catch keeps its place when the only thing missing is the balls, because
    // the errand that fetches them lives in that row: hiding it would hide the
    // way out of the very state it describes.
    const usable = rows[key].enabled
                   || (key === 'catch' && rows.catch.needsBalls && afoot);
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
  if (afoot && !ctx.huntWanted) hint.push('pick something below to hunt or catch');
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
export function describeSlot(meta) {
  if (!meta) return 'empty';
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
  if (reason === 'malformed') return 'that is not a full code — three words and three numbers';
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
export function describeReplaced(meta) {
  if (!meta) return { text: '', enabled: false, show: false };
  return { text: describeSlot(meta), enabled: true, show: true };
}

/**
 * What the screen-sharing row says, and what its button offers.
 *
 * Five states, and the two that matter most are the ones that are not about
 * this device: someone else is showing, and you are watching them. The others
 * only have to stay out of the way.
 */
export function describeScreen({ hosting = false, watching = false, host = null,
                                 viewer = null, asleep = false } = {}) {
  if (hosting) {
    return viewer
      ? { text: `showing this screen to ${viewer}`, button: 'Stop' }
      : { text: 'showing this screen — press Watch on the other device',
          button: 'Stop' };
  }
  if (watching) {
    return asleep
      ? { text: `${host || 'the other device'} has its screen off`, button: 'Leave' }
      : { text: `watching ${host || 'the other device'}`, button: 'Leave' };
  }
  if (host) return { text: `${host} is showing its screen`, button: 'Watch' };
  return { text: 'not showing this screen', button: 'Show' };
}
