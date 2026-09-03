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
  const canCatchHere = s.inBattle && !trainer && !!ballId
                       && s.party.length < MAX_PARTY;

  return {
    grind: {
      text: lead ? `${leadName} → Lv${target}` : 'no party yet',
      enabled: !!lead,
      // The level presets are meaningless with nothing to level.
      levels: !!lead,
    },
    hunt: {
      text: huntWanted ? `${huntWanted} · here now` : 'pick something below',
      enabled: !!huntWanted,
    },
    // Catch owns its own prerequisite. The errand is a one-time thing -- run it
    // twice and it reports "already carrying 5 ball(s)" without moving -- so it
    // is Catch's empty state rather than a peer button.
    catch: {
      text: needsBalls
        ? 'no Poké Balls yet — fetch them first'
        : huntWanted ? `${huntWanted} · ${ballName}` : 'pick something below',
      enabled: !!(ballId && huntWanted),
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
      enabled: !s.inBattle && hurt.length > 0,
    },
  };
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
