// The things a person actually asks for: grind, hunt, catch, battle, heal.
//
// These are the only methods the interface calls. Each one loops over the
// battle primitives, decides when to stop, and returns { ok, message, stats }
// -- the shape the interface renders without knowing what happened.
import { MAX_PARTY, TRAINER_BATTLE } from './state.js';
import { SETTLE_FRAMES } from './taskbase.js';
// Consecutive unresolved battles that mean the pilot has lost the thread.
const MAX_STUCK_BATTLES = 5;
// Swings at one target before giving up on weakening it any further.
const MAX_CHIPS = 8;

/**
 * What each capture outcome means, in one place.
 *
 * captureHere reports an outcome code; two callers used to translate it -- a
 * switch in catchHere and an if-chain in catch_ -- and they had drifted: the
 * chain handled six of the eleven codes and fell through for the rest. Adding
 * an outcome meant remembering both, which was already got wrong once.
 *
 * `stop` is the one thing the two callers legitimately disagree about: a
 * knockout ends a single catch, and is only bad luck to a hunt that can go and
 * find another one.
 */
const CAPTURE_OUTCOMES = {
  caught:     { ok: true,  stop: true,
                say: (r, balls) => `caught ${r.name}${r.level ? ` Lv${r.level}` : ''} `
                                   + `with ${balls(r.thrown)}` },
  nobattle:   { stop: true, say: () => 'not in a battle' },
  trainer:    { stop: true,
                say: () => "that is a trainer's Pok\u00e9mon \u2014 it cannot be caught" },
  full:       { stop: true,
                say: () => 'the party is full \u2014 a caught Pok\u00e9mon would go to the '
                           + 'PC, which this does not handle. Free a slot first.' },
  noballs:    { stop: true, say: () => 'no balls of that kind in the bag' },
  nopack:     { stop: true, say: () => 'could not reach the ball in the pack' },
  ranout:     { stop: true,
                say: (r, balls) => `used ${balls(r.thrown)} and then had none left` },
  knockedOut: { stop: false, say: (r) => `knocked the ${r.name} out` },
  gone:       { stop: false, say: (r) => `the ${r.name} got away` },
  lost:       { stop: true,
                say: (r) => `your lead fainted before the ${r.name} could be caught` },
  stuck:      { stop: true, say: () => 'lost track of the battle' },
  cancelled:  { stop: true, say: () => 'stopped' },
  budget:     { stop: true,
                say: (r, balls) => `used ${balls(r.thrown)} without catching it` },
};

/** The outcome's entry, or a safe stand-in for a code nobody has taught it. */
export function captureOutcome(code) {
  return CAPTURE_OUTCOMES[code]
    || { stop: true, say: () => `the catch ended unexpectedly (${code})` };
}

export function withJobs(Base) {
  // Named, so a stack trace says which of these a frame came from.
  return class WithJobs extends Base {
  /**
   * Walk the grass until a species turns up, fleeing everything else.
   *
   * The battle is left running when it finds one, so the choice of what to do
   * with it is yours -- which is the whole point of hunting rather than
   * catching.
   */
  async hunt(want, { maxEncounters = 200, regrass = null } = {}) {
    const started = Date.now();
    const stats = { encounters: 0, fled: 0 };
    const seen = new Map();
    this.say(`looking for ${want}`);

    while (stats.encounters < maxEncounters && !this.cancelled) {
      let s = await this.snap();
      if (!s.inBattle) {
        if (!await this._findFight(regrass)) {
          return { ok: false, seen, stats,
                   message: 'no wild Pokemon appeared — are you standing in grass?' };
        }
        // The species is not readable the instant the battle flag flips; give
        // the encounter a moment to load before believing what it says.
        await this.step(40);
        s = await this.snap();
      }
      stats.encounters++;
      const name = this.rom.speciesName(s.enemy.species);
      seen.set(name, (seen.get(name) || 0) + 1);
      if (name === want) {
        stats.found = name;
        stats.level = s.enemy.level;
        stats.seconds = ((Date.now() - started) / 1000).toFixed(1);
        return { ok: true, seen, stats,
                 message: `found ${name} Lv${s.enemy.level} after ` +
                          `${stats.encounters} encounter(s)` };
      }
      this.say(`${name} — not the one, running`);
      if (!await this.flee()) {
        return { ok: false, seen, stats, message: `could not run from a ${name}` };
      }
      stats.fled++;
    }
    stats.seconds = ((Date.now() - started) / 1000).toFixed(1);
    return { ok: false, seen, stats,
             message: this.cancelled
               ? `stopped after ${stats.encounters} encounter(s)`
               : `saw ${stats.encounters} encounters without finding ${want}` };
  }

  /**
   * Find a species and throw balls at it.
   *
   * Balls are counted out of the bag rather than trusted to a tally, because
   * the two coming apart is the failure worth catching: a throw that goes
   * astray still costs a ball.
   */
  /**
   * Catch the wild Pokemon already in front of you.
   *
   * The battle-facing half of `catch_`, split out because it is also a command
   * on its own: you walked into an encounter yourself and want this one caught,
   * rather than asking the pilot to go and find a species.
   *
   * `memory` carries the biggest hit landed so far. Kept outside this call on
   * purpose when hunting -- the one swing that cannot be guarded is the first
   * one, so a knockout is itself a measurement that every later target
   * benefits from.
   */
  async captureHere(ballId, { maxBalls = 40, weakenTo = 0.34,
                              memory = null } = {}) {
    const mem = memory || { biggestHit: 0 };
    const ballsOf = (snap) => {
      const e = snap.balls.find(([id]) => id === ballId);
      return e ? e[1] : 0;
    };
    const ballName = this.rom.itemName(ballId);

    let s = await this.snap();
    if (!s.inBattle) return { outcome: 'nobattle' };
    if (s.battleMode === TRAINER_BATTLE) return { outcome: 'trainer' };
    if (s.party.length >= MAX_PARTY) return { outcome: 'full' };
    if (ballsOf(s) <= 0) return { outcome: 'noballs', ballName };

    const name = this.rom.speciesName(s.enemy.species);
    const partyBefore = s.party.length;
    let weakening = weakenTo > 0;
    let thrown = 0, chips = 0;

    while (thrown < maxBalls && !this.cancelled) {
      const snap = await this.snap();
      if (!snap.inBattle) break;

      // Soften it up first. A ball's odds turn on how much HP is left, so
      // throwing at something untouched is mostly throwing balls away.
      const enemyMax = Math.max(1, snap.enemy.maxHp);
      if (weakening && snap.enemy.hp / enemyMax > weakenTo) {
        // Never swing when the biggest hit seen so far could finish it. The
        // threshold alone is not a safe stopping point -- against a low-level
        // wild Pokemon one hit can carry it from above the line to zero, and a
        // fainted Pokemon cannot be caught by anything.
        if (snap.enemy.hp <= mem.biggestHit) {
          weakening = false;
          this.say('any more would knock it out — throwing now');
        } else {
          // Bounded, because weakening does not spend a ball: without this a
          // move that keeps missing would loop here for good, the ball budget
          // never moving because no ball was ever thrown.
          if (chips >= MAX_CHIPS) {
            weakening = false;
            this.say('weakening is getting nowhere — throwing');
            continue;
          }
          chips++;
          const hpBefore = snap.enemy.hp;
          const how = await this.chip();
          if (how === 'fainted') {
            // It had hpBefore left and we took all of it, so that is the floor
            // on what one swing does.
            mem.biggestHit = Math.max(mem.biggestHit, hpBefore);
            return { outcome: 'knockedOut', name, thrown, chips };
          }
          if (how === 'ended') {
            // Our own swing ended the battle. chip() checks inBattle before it
            // checks the enemy's HP -- it has to, because the enemy struct
            // reads zero once the battle is over -- so a knockout that beats
            // the poll arrives here rather than as 'fainted', and reporting it
            // as a spent ball budget would be doubly wrong: the wrong reason,
            // and the guard learns nothing from the one measurement worth
            // having. Our own party still answers after the battle ends.
            const after = await this.snap();
            const lead = after.party[0];
            if (lead && lead.hp > 0) {
              mem.biggestHit = Math.max(mem.biggestHit, hpBefore);
              return { outcome: 'knockedOut', name, thrown, chips };
            }
            // It was our lead that went down. Say so: falling through to the
            // budget report would tell you the balls ran out, which is both
            // untrue and the wrong thing to go and fix.
            return { outcome: 'lost', name, thrown, chips };
          }
          if (how === 'ok') {
            const now = await this.snap();
            mem.biggestHit = Math.max(mem.biggestHit, hpBefore - now.enemy.hp);
            continue;
          }
          // No usable attack, or the fight got away from us: stop trying to
          // weaken and take the odds as they are rather than stalling.
          //
          // Backing out first matters. A chip that ended badly can leave the
          // move menu open, and menuIsLive cannot tell that from the battle
          // menu -- they share the same box -- so the pack was opened from
          // inside the move list and the throw could not find a ball.
          weakening = false;
          await this.closeMenus(2);
          await this.step(SETTLE_FRAMES);
          this.say(how === 'nomove'
            ? 'nothing gentle enough to weaken it with' : 'throwing as it is');
        }
      }

      if (!await this.throwBall(ballId)) {
        // The bag is not readable mid-battle -- wBalls only settles once the
        // battle ends -- so "no ball in the pocket" is how running out shows up
        // here, rather than the count above catching it.
        return { outcome: thrown ? 'ranout' : 'nopack', name, thrown, chips,
                 ballName };
      }
      const how = await this.watchThrow(partyBefore);
      thrown++;
      if (how === 'caught') {
        const after = await this.snap();
        const slot = after.party.length - 1;
        return { outcome: 'caught', name, thrown, chips, ballName,
                 level: after.party[slot] ? after.party[slot].level : null };
      }
      if (how === 'gone') return { outcome: 'gone', name, thrown, chips };
      if (how === 'stuck') return { outcome: 'stuck', name, thrown, chips };
    }
    if (this.cancelled) return { outcome: 'cancelled', name, thrown, chips };
    return { outcome: 'budget', name, thrown, chips, ballName };
  }

  /**
   * Catch the wild Pokemon in front of you, as a task in its own right.
   *
   * Reports in the same shape as every other task, and refuses politely rather
   * than flailing: a trainer's Pokemon cannot be caught, a full party would
   * send the catch to a box this does not handle, and with no balls there is
   * nothing to throw.
   */
  async catchHere(ballId, { maxBalls = 40, weakenTo = 0.34 } = {}) {
    const started = Date.now();
    const r = await this.captureHere(ballId, { maxBalls, weakenTo });
    const stats = { thrown: r.thrown || 0, chips: r.chips || 0,
                    seconds: ((Date.now() - started) / 1000).toFixed(1) };
    const balls = (n) => `${n} ${r.ballName}${n === 1 ? '' : 's'}`;
    const how = captureOutcome(r.outcome);
    return { ok: !!how.ok, stats, message: how.say(r, balls) };
  }

  /**
   * Play out the battle you are already in, wild or trainer.
   *
   * fightBattle does the work; this is the guard and the reporting around it.
   * Distinct from a grind, which goes looking for battles -- here you walked
   * into one yourself.
   */
  async battleHere({ maxTurns = 40 } = {}) {
    const started = Date.now();
    const before = await this.snap();
    if (!before.inBattle) {
      return { ok: false, stats: {}, message: 'not in a battle' };
    }
    const kind = before.battleMode === TRAINER_BATTLE ? 'trainer' : 'wild';
    const foe = this.rom ? this.rom.speciesName(before.enemy.species) : 'it';
    this.say(`fighting the ${kind} ${foe}`);

    const how = await this.fightBattle(maxTurns);
    const after = await this.snap();
    const stats = {
      kind,
      outcome: how,
      seconds: ((Date.now() - started) / 1000).toFixed(1),
    };
    const lead = after.party[0];
    if (lead) stats.lead = `${lead.hp}/${lead.maxHp}`;
    if (how === 'won') {
      return { ok: true, stats, message: `won the ${kind} battle` };
    }
    if (how === 'lost') {
      return { ok: false, stats, message: 'the whole party fainted' };
    }
    return { ok: false, stats, message: `the ${kind} battle went nowhere` };
  }

  async catch_(want, ballId, { maxEncounters = 200, maxBalls = 40,
                              regrass = null, weakenTo = 0.34 } = {}) {
    const stats = { encounters: 0, fled: 0, thrown: 0 };
    const started = Date.now();
    let s = await this.snap();
    if (s.party.length >= MAX_PARTY) {
      return { ok: false, stats, message:
        'the party is full — a caught Pokemon would go to the PC, '
        + 'which this does not handle. Free a slot first.' };
    }
    const ballsOf = (snap) => {
      const e = snap.balls.find(([id]) => id === ballId);
      return e ? e[1] : 0;
    };
    if (ballsOf(s) <= 0) {
      return { ok: false, stats, message: 'no balls of that kind in the bag' };
    }
    const ballName = this.rom.itemName(ballId);
    this.say(`after ${want} with ${ballName}s`);

    // How hard we hit, learned once and remembered for the rest of the hunt.
    // Kept out here on purpose: the first swing at the first target is the one
    // that cannot be guarded, and a Lv2 RATTATA has so little HP that the
    // gentlest move still knocks it out. Measured, that is exactly what
    // happened -- so the knockout teaches the pilot its own damage, and every
    // target after it whose HP is already inside that range gets thrown at
    // rather than hit.
    const memory = { biggestHit: 0 };

    while (stats.encounters < maxEncounters && !this.cancelled) {
      s = await this.snap();
      if (!s.inBattle) {
        if (!await this._findFight(regrass)) {
          return { ok: false, stats,
                   message: 'no wild Pokemon appeared — are you standing in grass?' };
        }
        await this.step(40);
        s = await this.snap();
      }
      stats.encounters++;
      const name = this.rom.speciesName(s.enemy.species);
      if (name !== want) {
        this.say(`${name} — not the one, running`);
        if (!await this.flee()) {
          return { ok: false, stats, message: `could not run from a ${name}` };
        }
        stats.fled++;
        continue;
      }

      this.say(`found ${name} Lv${s.enemy.level} — weakening it`);
      const r = await this.captureHere(ballId, {
        maxBalls: maxBalls - stats.thrown, weakenTo, memory });
      stats.thrown += r.thrown || 0;
      if (r.chips) stats.chips = (stats.chips || 0) + r.chips;

      const balls = (n) => `${n} ${ballName}${n === 1 ? '' : 's'}`;
      const how = captureOutcome(r.outcome);
      if (r.outcome === 'caught') {
        stats.spent = stats.thrown;
        stats.seconds = ((Date.now() - started) / 1000).toFixed(1);
        return { ok: true, stats, message: how.say({ ...r, name }, balls) };
      }
      if (!how.stop) {
        // Bad luck rather than a reason to give up: there is another one in the
        // grass. The table decides which outcomes those are, so a hunt and a
        // single catch cannot disagree about it by accident.
        if (r.outcome === 'knockedOut') {
          stats.knockedOut = (stats.knockedOut || 0) + 1;
        }
        this.say(`${how.say({ ...r, name }, balls)} \u2014 looking for another`);
        await this.settleText();
        continue;
      }
      if (r.outcome === 'lost') {
        // Unlike a grind this has no heal hook, so carrying on would walk into
        // the next encounter with a fainted lead and spend the rest of the
        // budget answering party screens.
        return { ok: false, stats,
                 message: 'your lead fainted while weakening \u2014 heal and retry' };
      }
      if (r.outcome !== 'budget') {
        return { ok: false, stats, message: how.say({ ...r, name }, balls) };
      }
      if (stats.thrown >= maxBalls) {
        return { ok: false, stats,
                 message: `used ${stats.thrown} balls without catching it` };
      }
    }
    stats.seconds = ((Date.now() - started) / 1000).toFixed(1);
    return { ok: false, stats, message: this.cancelled
      ? `stopped after ${stats.encounters} encounter(s)`
      : `saw ${stats.encounters} encounters without catching ${want}` };
  }

  /**
   * Grind one party member to a level.
   *
   * Deliberately smaller than the desktop task: no Pokemon Center trips, no
   * evolution or learn-move policy. It exists to show the loop runs on a phone,
   * and it stops rather than pretending when HP runs low.
   */
  async grind(slot, toLevel, { maxBattles = 200, healBelow = 0.25,
                              heal = null, regrass = null } = {}) {
    const started = Date.now();
    const stats = { battles: 0, won: 0, levels: 0 };
    let stuckRun = 0;
    let s = await this.snap();
    const mon0 = s.party[slot];
    if (!mon0) return { ok: false, message: `party slot ${slot + 1} is empty`, stats };
    const startLevel = mon0.level;
    if (mon0.level >= toLevel) {
      return { ok: true, message: `already Lv${mon0.level}`, stats };
    }
    this.say(`grinding slot ${slot + 1} from Lv${mon0.level} to Lv${toLevel}`);

    while (stats.battles < maxBattles && !this.cancelled) {
      s = await this.snap();
      const mon = s.party[slot];
      if (!mon) break;
      if (mon.level >= toLevel) break;
      // Out of PP is as much a reason to go to a Center as low HP: the game
      // forces Struggle, which hurts the thing being trained, and a grind that
      // fought on took eighty-odd turns of getting nowhere. A Center restores
      // PP along with health.
      const dry = mon.pp && mon.moves &&
        !mon.pp.some((pp, i) => mon.moves[i] && pp > 0);
      if (dry) this.say('out of PP');
      if (dry || mon.hp / Math.max(1, mon.maxHp) < healBelow) {
        // Where the Pokemon Center is, and how to get there, is map knowledge
        // this file deliberately does not have -- the caller passes in a way to
        // heal, or the grind stops rather than training something to death.
        const healed = heal ? await heal() : false;
        if (!healed) {
          return {
            ok: false,
            message: `stopped at Lv${mon.level}: ${mon.hp}/${mon.maxHp} HP and ` +
                     (heal ? 'healing did not work' : 'no way to heal was given'),
            stats: { ...stats, levels: mon.level - startLevel },
          };
        }
        continue;
      }
      if (!s.inBattle && !await this._findFight(regrass)) {
        return {
          ok: false,
          message: 'no wild Pokemon appeared — are you standing in grass?',
          stats,
        };
      }
      const outcome = await this.fightBattle();
      stats.battles++;
      if (outcome === 'won') stats.won++;
      if (outcome === 'lost') break;
      this.say(`battle ${stats.battles}: ${outcome}`);
      // Battles that end without resolving mean the pilot is not driving the
      // fight any more -- something is on screen it does not understand. A few
      // in a row is a stall, not bad luck, and grinding on just burns the
      // battle budget while nothing happens.
      stuckRun = outcome === 'stuck' ? stuckRun + 1 : 0;
      if (stuckRun >= MAX_STUCK_BATTLES) {
        return {
          ok: false,
          message: `stopped: ${stuckRun} battles in a row went nowhere`,
          stats: { ...stats, levels: mon.level - startLevel },
        };
      }
    }

    s = await this.snap();
    const mon = s.party[slot];
    stats.levels = mon ? mon.level - startLevel : 0;
    stats.seconds = ((Date.now() - started) / 1000).toFixed(1);
    const reached = mon && mon.level >= toLevel;
    return {
      ok: !!reached,
      message: reached
        ? `reached Lv${mon.level} (from Lv${startLevel})`
        : `stopped at Lv${mon ? mon.level : '?'} (wanted Lv${toLevel})`,
      stats,
    };
  }
  };
}
