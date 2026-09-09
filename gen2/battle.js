// One battle: choosing an action, choosing a move, throwing, and watching.
//
// Everything here works on the situation in front of it and reports what
// happened. Deciding whether a battle was worth having is jobs.js's problem.
import { gen2 } from './engine.js';
import { SETTLE_FRAMES } from '../gbcore/taskbase.js';
// wBattleMenuCursorPosition: 1 FIGHT 2 PKMN 3 PACK 4 RUN, and wCurPocket:
// 0 ITEM, 1 BALL, 2 KEY ITEM, 3 TM/HM. From the engine profile, which is where
// the machine's own numbers live.
const FIGHT = gen2.battleAction.fight;
const PACK = gen2.battleAction.pack;
const RUN = gen2.battleAction.run;
const BALL_POCKET = gen2.ballPocket;
// wCurItem while the cursor sits on CANCEL.
const CANCEL_ITEM = 0xff;
// Party slots to try when sending out a replacement.
const MAX_SEND_TRIES = 6;
// How long a pack box takes to draw, and how many presses the result of using
// an item is worth. Both are this app's patience rather than facts about the
// cartridge, which is why they are here and not in the engine profile.
const SETTLE_PACK = 50, ITEM_RESULT_TAPS = 10;
// When the thing on the field is worth a potion, and how many one battle gets.
// A fight that needs four is a fight that should have been run from.
const HEAL_IN_BATTLE_BELOW = 0.34, MAX_BATTLE_POTIONS = 3;
// How many times the PACK press is worth repeating when the turn's text eats it.
const PACK_OPEN_TRIES = 4;
// The party screen ignores the short presses the battle menu takes.
const PARTY_HOLD = 12, PARTY_GAP = 24, PARTY_SETTLE = 40;
// How long to press through a whiteout before giving up on it. The sequence is
// several boxes -- the last Pokemon faints, "you have no Pokemon left", the
// screen fades, the money is docked -- and it is text the whole way, so this is
// generous: standing in it is harmless and returning while it runs is not.
const WHITEOUT_TAPS = 200;
// What the drawn battle menu measures, telling it from the pack over the top of
// it: wMenuDataItems and wMenuBorderTopCoord.
// How often the wait for the battle menu presses B instead of A. Every fourth,
// which is often enough to leave a submenu within a few frames and rare enough
// that a long text scene is still driven mostly by A.
const BACK_OUT_EVERY = 4;
const BATTLE_MENU_ITEMS = gen2.battleMenu.items,
      BATTLE_MENU_TOP = gen2.battleMenu.top;
// Those two and BALL_POCKET above are read from the *stock* profile at import
// time, which is the shape the first audit pass fixed in state.js and did not
// fix here: a title that moved its battle menu or its ball pocket would have
// the override honoured nowhere in this file. Written down rather than left as
// a surprise. The new reader below takes its numbers off the instance --
// `this.state.e` is the engine the title actually chose -- which is the pattern
// the other two should follow when somebody has a cartridge that needs it.

/**
 * Is the battle menu up and waiting for a choice?
 *
 * A module function, not only a static. Six call sites in this file used to say
 * `menuIsLive(...)`, and after the class was split into mixins the name
 * `Tasks` lives in tasks.js and is not in scope here -- so every one of them
 * was a ReferenceError the moment it ran. It reached the deployed app and broke
 * grinding, because nothing that could see it was looking: `node --check` cannot
 * spot an unbound name, and the tests exercised the static directly rather than
 * any of its callers.
 */
/**
 * Is the box asking whether to delete a move to make room for a new one?
 *
 * The one decision the battle loop can be handed that it must not answer with
 * A. Everything else during turn resolution is text, and A advances text; this
 * is a YES/NO box with YES under the cursor, so an A takes YES, the move list
 * opens, and the next A deletes whatever is at the top of it.
 *
 * Measured rather than reasoned about -- see `engine.learnMove`. A Chikorita
 * ground from Lv5 on Route 29 reached Lv15 with four moves and came out of the
 * battle holding [POISONPOWDER, GROWL, RAZOR LEAF, REFLECT] where it had gone
 * in holding [TACKLE, GROWL, RAZOR LEAF, REFLECT]. Tackle was not chosen away;
 * it was at the top of the list when a stray A landed.
 *
 * It has since been seen firing, and firing was not enough: it went round the
 * two questions four times and the move was replaced anyway. See
 * `declineNewMove`, which is where that half lives.
 */
export function learnMoveBox(s, engine) {
  const box = engine && engine.learnMove;
  if (!box || !s.windowOpen) return false;
  return s.inBattle && s.menuItems === box.items && s.menuTop === box.top;
}

export function menuIsLive(s) {
  const [x, y] = s.menu;
  if (s.menuItems !== BATTLE_MENU_ITEMS || s.menuTop !== BATTLE_MENU_TOP) {
    return false;
  }
  return x >= 1 && x <= 2 && y >= 1 && y <= 2;
}

/**
 * Which party member is actually standing on the field.
 *
 * `active` carries hp and maxHp and nothing else -- there is no move list on it
 * -- so the moves have to come from the party entry for the same Pokemon. That
 * was `party[0]`, which is right exactly while the lead is the one standing,
 * and wrong from the moment sendOut puts a replacement in. sendOut was added
 * later, for the party of more than one that first met the "Which POKeMON?"
 * prompt, and the two places that read a move list were never told.
 *
 * What goes wrong is not a wrong-looking row, it is a wrong move: an index
 * chosen from the fainted lead's list means a different entry on the list the
 * game has actually drawn. In a fight the cursor cannot reach a fourth move on
 * a two-move replacement, so chooseMove backs out and the turn is retried until
 * the ceiling -- forty turns of nothing, reported as stuck. In a catch it is
 * worse: chip ranks the *gentlest* move by that same wrong list, so the
 * replacement can be handed a knockout, and a fainted target cannot be caught,
 * which is the single thing chip exists to prevent.
 *
 * Matched on HP rather than by slot index, because there is no "which slot is
 * out" in the snapshot -- wCurBattleMon would mean another name on the shared
 * symbol list, and every device taking a digest would need it. Gen 2 keeps the
 * battle mon's HP and its party entry's in step, so the pair identifies it.
 *
 * Several can match -- two untouched slots of the same species read alike --
 * and the first of *those* is still the right answer, because every one of them
 * is consistent with what is on the field. This used to demand a unique match
 * and fall back to "the first one standing" when it did not get one, which is
 * worse in the case that actually arises: a healthy lead at 30/30 with the
 * replacement out at 20/25 alongside another 20/25 sent the caller to the lead,
 * whose HP plainly is not the battle mon's. Surfaced by mutation testing --
 * loosening the `=== 1` broke no test, which is how it came up for re-reading.
 *
 * The fallback is for no match at all: the battle mon not loaded yet, or a read
 * caught mid-update. Then the first one standing is the slot sendOut would have
 * chosen anyway.
 */
export function onField(s) {
  const party = (s && s.party) || [];
  const act = (s && s.active) || {};
  if (act.maxHp > 0) {
    const same = party.filter((m) => m.maxHp === act.maxHp && m.hp === act.hp);
    if (same.length) return same[0];
  }
  return party.find((m) => m.hp > 0) || party[0] || null;
}


export function withBattle(Base) {
  // Named, so a stack trace says which of these a frame came from.
  return class WithBattle extends Base {
  /** Kept as a static so external callers and tests can reach it. */
  static menuIsLive(s) {
    return menuIsLive(s);
  }

  /**
   * Walk back and forth until a wild battle starts.
   *
   * It refuses to start with a window open, and that guard is the whole reason
   * this docstring is longer than the function. A directional press with a menu
   * on screen moves a *cursor*, and this presses four hundred of them: the pass
   * before last, a menu left open by a `closeMenus` that never checked turned
   * this into four hundred presses against the START menu, after which the
   * grind reported "no wild Pokemon appeared -- are you standing in grass?"
   * from a tile of tall grass. The reading was confident and the diagnosis was
   * wrong, and one line here would have said so.
   *
   * `closeMenus` verifies now, so this should never fire. That is exactly when
   * a guard is worth having: it is the difference between a bug that reports
   * itself and a bug that blames the map.
   */
  async paceUntilBattle(maxSteps = 400) {
    if ((await this.snap()).windowOpen) {
      this.say('a menu is open — not pacing into it');
      return null;
    }
    let dir = 'LEFT';
    for (let i = 0; i < maxSteps && !this.cancelled; i++) {
      await this.push(dir, 10, 4);
      await this.pump();
      const s = await this.snap();
      if (s.inBattle) return s;
      if (i % 2 === 1) dir = dir === 'LEFT' ? 'RIGHT' : 'LEFT';
    }
    return null;
  }

  /**
   * Wait until the battle menu is genuinely up.
   *
   * The cursor variables keep their previous value between turns, so a settle
   * comes first -- otherwise "cursor is non-zero" reads as ready while the menu
   * is still drawing, and the presses land on battle text instead.
   *
   * The budget is generous because the opening of a battle is long: measured
   * from a fresh encounter, it takes 48 presses to get through the animation
   * and "Wild SENTRET appeared!" before the menu is there to be read. The old
   * ceiling of 40 fell just short of that, so every first turn gave up -- which
   * is why fleeing reported it could not run from things it had never asked to
   * run from, and a grind never got as far as choosing a move. The loop returns
   * the moment the menu is live, so a high ceiling costs nothing.
   */
  async awaitBattleMenu(tries = 150) {
    await this.step(40);
    for (let i = 0; i < tries; i++) {
      const s = await this.snap();
      if (!s.inBattle) return null;
      if (menuIsLive(s)) return s;
      // **A answers a question and B declines it, and this has no business
      // answering anything.** It pressed A only, described as pushing through
      // text -- which is right for text and wrong for a *submenu*, where A is
      // a selection. Measured on Route 31: Cyndaquil out of PP on its only
      // damaging move, the move menu open with `TYPE/NORMAL` and `0/35` on
      // screen, and A re-selecting the move the game had just refused. The
      // panel redrew, the cursor stayed at nought, and 150 tries later this
      // answered 'stuck' -- forever, because every walk asks again.
      //
      // So it alternates. B advances text in Gen 2 as well as A does, and it
      // is the only one of the two that can get *out* of a box; A stays in
      // because the loop has been driven by it for thirty passes and the
      // prompts it does answer are not worth rediscovering. Neither a text box
      // nor a submenu is a dead end now.
      await this.push(i % BACK_OUT_EVERY === BACK_OUT_EVERY - 1 ? 'B' : 'A', 4, 6);
    }
    return null;
  }

  /** Drive the 2x2 battle menu to `action` by reading the live cursor. */
  async chooseAction(action) {
    const wantX = ((action - 1) % 2) + 1;
    const wantY = Math.floor((action - 1) / 2) + 1;
    for (let i = 0; i < 8; i++) {
      const s = await this.snap();
      const [x, y] = s.menu;
      if (x === wantX && y === wantY) break;
      if (x !== wantX) await this.push(wantX > x ? 'RIGHT' : 'LEFT', 4, 6);
      else if (y !== wantY) await this.push(wantY > y ? 'DOWN' : 'UP', 4, 6);
    }
    await this.push('A', 6, 10);
  }

  /** Pick a move with PP left. The move menu is a wrapping vertical list. */
  /**
   * Turn down a new move, which takes two answers rather than one.
   *
   * The first version of this pressed NO and stopped, and it was wrong in a way
   * only the cartridge shows. Gen 2 asks twice: *delete an older move to make
   * room?* and then, when you say no, *give up on learning it?* -- and the
   * second one wants **YES**. Say no to both and they loop, because no to the
   * second is "carry on learning it" and puts the first back on screen.
   *
   * Measured, grinding a Chikorita to Lv15: four declines in a row, the cursor
   * walking 1, 2, 1, 2, 1 -- and then `[POISONPOWDER, GROWL, RAZOR LEAF,
   * REFLECT]`, because once the loop had gone round enough times a stray A from
   * the turn-resolution presses landed on the delete prompt. The guard fired
   * every time and changed nothing.
   *
   * So the answers are asymmetric, and the order matters: NO closes the door,
   * YES accepts closing it. Both boxes carry the same signature -- they are one
   * widget asked twice -- so this cannot tell them apart by looking, and does
   * not try. It relies on the sequence instead: `answerNo` returns true only
   * after it has pressed A on the NO row, so a box still up after that is the
   * second question and not the first.
   */
  async declineNewMove() {
    this.say('declining a new move — the four it has are kept');
    if (!await this.answerNo()) return false;
    await this.step(SETTLE_FRAMES);
    // Bounded, because everything in this file is: a box that will not go away
    // is a stall to report rather than a thing to press at for ever.
    for (let i = 0; i < 3; i++) {
      const s = await this.snap();
      if (!learnMoveBox(s, this.state && this.state.e)) return true;
      await this.answerYes();
      await this.step(SETTLE_FRAMES);
    }
    return false;
  }

  /**
   * The hardest-hitting move that can actually be used, by slot index.
   *
   * The mirror of what `chip` does, and it existed only in that direction: the
   * catch path reads the move table to find the *gentlest* attack, because
   * knocking out the thing you are catching wastes the ball. Winning a battle
   * wants the opposite, and had nothing -- `chooseMove` fell back to
   * `usable[0]`, which is slot order, and slot order is not a strategy.
   *
   * Measured, grinding a Chikorita on Route 29. Its slots are Tackle, Growl,
   * Razor Leaf, Reflect. Sixty-four battles in, Tackle's PP was gone, so slot
   * order handed back **Growl** -- a move that lowers Attack and takes no HP off
   * anything -- while Razor Leaf sat in slot three at 25 PP. The battle could
   * not end, `fightBattle` returned 'stuck' forty turns later, five of those in
   * a row tripped the stall detector, and the grind gave up at 3 HP out of 36
   * holding a 55-power move it had never tried.
   *
   * Falls back to `usable[0]` when nothing does damage, which is the honest
   * answer: with only status moves left there is no winning move to prefer, and
   * `grind` treats that as a reason to go and heal.
   */
  /**
   * Has this Pokemon any move left that could actually end a battle?
   *
   * **A different thing from having PP**, and the difference is a battle that
   * cannot be won. Measured on Route 31: Cyndaquil at Lv11 with TACKLE on 0 of
   * 35, LEER and SMOKESCREEN with plenty, and a Lv2 CATERPIE at 1 HP in a
   * *trainer* battle -- which cannot be fled. Forty turns of lowering the
   * Caterpie's defence later, `fightBattle` reported 'stuck', which is true and
   * says nothing a person can act on.
   *
   * Answers null where there is no ROM to price the moves with, so a caller can
   * tell "no" from "cannot say".
   */
  canStillWin(mon) {
    if (!this.rom || !mon || !mon.moves) return null;
    for (let i = 0; i < mon.moves.length; i++) {
      if (!mon.moves[i] || !(mon.pp[i] > 0)) continue;
      const info = this.rom.move(mon.moves[i]);
      if (info && info.power > 0) return true;
    }
    return false;
  }

  strongest(usable, mon, against = null, mine = null) {
    const power = (i) => {
      const info = this.rom && this.rom.move(mon.moves[i]);
      return info ? info.power : 0;
    };
    // What the move is worth *here*: its power scaled by the type chart and
    // the same-type bonus. Ranking by the raw number picked RAZOR LEAF's 55
    // over TACKLE's 35 against a Bug that takes half from one and full from
    // the other -- so the bigger number was the smaller hit.
    const hit = (i) => (this.rom
      ? this.rom.hitPower(mon.moves[i], against, mine)
      : 0);
    // The *set* is still chosen by raw power, and deliberately: a damaging
    // move is a damaging move, and the chart only says which of them to
    // swing. Filtering on the scaled number would empty the pool against
    // something immune to everything carried, and hand back slot order --
    // which is how a grind ended up choosing GROWL.
    const hitters = usable.filter((i) => power(i) > 0);
    if (!hitters.length) return usable[0];
    return hitters.reduce((best, i) => (hit(i) > hit(best) ? i : best),
                          hitters[0]);
  }

  /**
   * The move that was picked, and what the chart thought of it.
   *
   * Said only when there is something to say -- a neutral hit is the ordinary
   * case and naming it every turn buries the log. Empty without a ROM to
   * price the move with.
   */
  movePicked(id, against = null) {
    if (!this.rom || !id) return '';
    const eff = this.rom.effectiveness(id, against);
    if (eff === null || eff === 1) return '';
    const name = this.rom.moveName(id) || `move ${id}`;
    if (eff === 0) return `${name} — no effect on this one`;
    return `${name} — ${eff > 1 ? 'super effective' : 'not very effective'}`;
  }

  async chooseMove(mon, prefer = null) {
    const usable = [];
    for (let i = 0; i < mon.moves.length; i++) {
      if (mon.moves[i] && mon.pp[i] > 0) usable.push(i);
    }
    // `prefer` picks among the moves that can actually be used -- weakening
    // wants the gentlest one rather than the first one.
    const idx = usable.length
      ? (prefer ? prefer(usable, mon) : usable[0])
      : -1;
    if (idx < 0) {                 // everything is out of PP: the game forces Struggle
      await this.push('A', 6, 10);
      return -1;
    }
    const target = idx + 1;
    for (let i = 0; i < 6; i++) {
      const s = await this.snap();
      if (s.menu[1] === target) break;
      await this.push('DOWN', 4, 6);
    }
    // Confirm only if the cursor really is on the move we meant. Pressing A
    // regardless picks whatever is highlighted, and when that is a move with no
    // PP the game says so and puts the menu straight back -- which reads as a
    // fresh turn, so it was chosen again, forever. Eighty-four "battles" in one
    // grind were that same refusal.
    if ((await this.snap()).menu[1] !== target) {
      await this.push('B', 4, 8);
      return null;
    }
    await this.push('A', 6, 10);
    return idx;
  }

  /** Play out one wild battle. -> 'won' | 'lost' | 'ended' | 'stuck' | 'nopp' */
  /**
   * How a battle that has ended actually ended.
   *
   * "Not in battle any more" is not the same as "won": whiting out ends the
   * battle too, and reading it as a win let a grind report five straight
   * victories while the party sat at 0 HP.
   */
  async _outcome() {
    await this.step(20);                      // let the last HP write land
    const s = await this.snap();
    if (s.inBattle) return 'stuck';
    if (s.party.length && s.party.every((m) => m.hp === 0)) return 'lost';
    return 'won';
  }

  /**
   * Answer the party screen after the Pokemon on the field faints.
   *
   * Gen 2 does not offer a choice about this: the lead goes down, the game asks
   * "Which POKéMON?" and waits, and nothing else happens until something is
   * sent out. With a party of one it never came up -- the battle simply ended --
   * so nothing here knew the screen existed, and the first time a bigger party
   * lost its lead the pilot sat in front of that prompt indefinitely, reporting
   * a stuck battle every time it tried again.
   *
   * Returns 'ok' | 'lost' | 'ended' | 'stuck'.
   */
  async sendOut() {
    const s = await this.snap();
    const next = s.party.findIndex((m) => m.hp > 0);
    if (next < 0) return 'lost';        // nothing left standing; it is a whiteout
    this.say(`slot 1 is down — sending out slot ${next + 1}`);

    // This screen's cursor could not be found in memory. wMenuCursorY stays
    // pinned at 1 on it, wPartyMenuCursor and wCurPartyMon never move, and
    // diffing all 8 KB of work RAM across a press turns up 87 changed bytes
    // with no index among them -- the arrow is drawn from sprite data. So this
    // does not read the cursor at all: it steps down to the slot it wants,
    // confirms, and checks whether something is actually on the field.
    //
    // Which is the better test anyway. Choosing a fainted Pokemon is refused
    // with "There's no will to battle!", and no reading of a cursor would have
    // predicted that -- whereas wBattleMonHP going above zero says the switch
    // happened. A refusal costs one press and the next slot down is tried.
    // Held longer than anywhere else, because this screen wants it. At the five
    // frames the battle menu is driven with, every direction was swallowed and
    // every confirm therefore landed on the fainted lead -- which the game
    // refuses, so the pilot sat in front of "There's no will to battle!" being
    // told no. At twelve it moves.
    // Settle between every press. This is the other half of why it did not
    // work: the screen arrives with "CYNDAQUIL fainted!" still running, and a
    // direction sent into that is dropped -- so the confirm landed on the
    // fainted lead. Pressed by hand with a pause between each one it worked
    // first time, which is what pointed at the gap rather than the buttons.
    const nudge = async (button, hold = PARTY_HOLD) => {
      await this.push(button, hold, PARTY_GAP);
      await this.step(PARTY_SETTLE);
    };

    await nudge('B', 6);                 // clear whatever text is still up
    for (let i = 0; i < next; i++) await nudge('DOWN');

    for (let attempt = 0; attempt < MAX_SEND_TRIES; attempt++) {
      await nudge('A', 8);
      for (let i = 0; i < 60; i++) {
        const now = await this.snap();
        if (!now.inBattle) return 'ended';
        if (now.active.maxHp > 0 && now.active.hp > 0) return 'ok';
        if (i > 2 && menuIsLive(now)) return 'ok';
        await this.push('A', 4, 6);
        await this.pump();
      }
      // Nothing came out, so that slot was refused. Clear the message, step
      // down one and try the next.
      await nudge('B', 6);
      await nudge('DOWN');
    }
    return 'stuck';
  }

  /**
   * If the Pokemon on the field has fainted, put the next one out.
   *
   * Gen 2 does not offer a choice about this -- it asks "Which POKeMON?" and
   * waits -- so any loop that drives a battle has to answer it or sit there.
   * fightBattle answered it from the day sendOut was written and nothing else
   * did, which is the whole of this: flee spent its 150 presses looking for a
   * battle menu that was never coming and reported it could not run, and a
   * catch reported it had lost track of the battle, both with healthy Pokemon
   * in the party and the game waiting on one line of input.
   *
   * Returns null when there was nothing to answer, so a caller can tell "no
   * faint" from sendOut's own outcomes.
   */
  async coverFaint(s) {
    if (!s || !s.inBattle || !s.party.length) return null;
    // maxHp as well as hp: at "Wild PIDGEY appeared!" the battle mon is not
    // loaded and both read zero, so hp alone fires at the start of every
    // battle -- which is how this was got wrong the first time.
    if (!(s.active.maxHp > 0 && s.active.hp === 0)) return null;
    return this.sendOut();
  }

  /**
   * Fight it out, and reach for the bag before the thing on the field faints.
   *
   * `heals` is the title's list of healing item names -- passed in rather than
   * read here, because an item name is content and this file is the engine.
   * Without it the behaviour is exactly what it was for twenty-three passes:
   * FIGHT every turn until something drops.
   *
   * Which is what it cost. A knockout in Gen 2 takes half your money and puts
   * you back at a Center, and the grind's answer to one has always been to heal
   * up and carry on -- *after* the fact. The pilot was carrying potions through
   * every one of them, because nothing in this loop had ever opened the pack.
   *
   * Bounded per battle, and low, on purpose: a fight that needs four potions is
   * a fight that should have been run from, and spending the bag on it is worse
   * than losing it.
   */
  /**
   * Press through a whiteout, and only then call the battle lost.
   *
   * `lost` used to be returned the moment the party read as wiped, with the
   * battle still on screen and not a button pressed -- so a caller that asks
   * "are we in a battle?" was told yes, fought it again, read the same wiped
   * party and lost again. Measured on the egg errand, which passes exactly one
   * trainer: the log said "trainer battle: lost" **seven times**. One loss,
   * reported seven ways, because every retry re-entered a battle nobody had
   * left.
   *
   * So the word now means what a caller needs it to mean: we lost, and the
   * battle is over. Bounded, and it returns 'lost' either way -- a whiteout
   * this could not sit through is still a whiteout, and reporting 'stuck'
   * would trade a true answer for a vaguer one.
   */
  async _whiteOut() {
    for (let i = 0; i < WHITEOUT_TAPS; i++) {
      if (!(await this.snap()).inBattle) break;
      await this.push('A', 4, 6);
      await this.pump();
    }
    return 'lost';
  }

  async fightBattle(maxTurns = 40, { heals = null } = {}) {
    let potions = 0;
    for (let turn = 0; turn < maxTurns && !this.cancelled; turn++) {
      await this.pump();
      // Before anything else, because a fainted lead means the game is waiting
      // on the party screen and awaitBattleMenu would spend 150 presses finding
      // out that no battle menu is coming.
      const pre = await this.snap();
      const covered = await this.coverFaint(pre);
      if (covered) {
        if (covered === 'lost') return this._whiteOut();
        if (covered === 'ended') return this._outcome();
        if (covered === 'stuck') return 'stuck';
        continue;
      }
      const menu = await this.awaitBattleMenu();
      if (menu === null) return this._outcome();
      if (menu.party.length && menu.party.every((m) => m.hp === 0)) {
        return this._whiteOut();
      }
      // **Nothing left that can end this.** Asked here rather than after forty
      // turns, because forty turns of lowering a Caterpie's defence is time
      // nobody gets back and 'stuck' is not a thing a person can act on.
      // Measured: Cyndaquil at Lv11 with TACKLE on 0 of 35, LEER and
      // SMOKESCREEN full, and a Lv2 CATERPIE at 1 HP in a trainer battle -- so
      // no fleeing either. `nopp` says the one useful thing: the answer is
      // Ethers, or a Center, or a different Pokemon.
      if (this.canStillWin(onField(menu)) === false) return 'nopp';
      // Before the swing, not after the faint. `coverFaint` above is the
      // recovery; this is the avoidance, and it is cheaper by a Center.
      if (heals && potions < MAX_BATTLE_POTIONS && this.rom) {
        const mon = onField(menu);
        const low = mon && mon.maxHp > 0 && mon.hp > 0
                    && mon.hp / mon.maxHp <= HEAL_IN_BATTLE_BELOW;
        const pick = low ? this.rom.cheapestOf(menu.items, heals) : null;
        if (pick) {
          potions++;
          this.say(`${mon.hp}/${mon.maxHp} — using ${pick.name}`);
          const used = await this.useItemInBattle(pick.id);
          this.say(used.ok ? `${pick.name}: ${used.message}`
                           : `${pick.name} did nothing: ${used.message}`);
          // Using an item *is* the turn, so the enemy has moved and the next
          // pass round the loop starts from a fresh menu. Nothing is swung
          // this turn either way -- including when the item failed, because
          // pressing on from an unknown box is how a pilot picks TOSS.
          continue;
        }
      }
      await this.chooseAction(FIGHT);
      await this.step(30);
      let inMoves = await this.snap();
      // No move menu means something is still on screen -- most often the
      // message refusing the move just picked. Back out and look again rather
      // than pressing A into it, which only re-picks the refused move.
      if (inMoves.inBattle && inMoves.menu[1] < 1) {
        await this.push('B', 4, 8);
        await this.step(30);
        inMoves = await this.snap();
      }
      if (inMoves.inBattle && inMoves.menu[1] >= 1) {
        const against = inMoves.enemy && inMoves.enemy.types;
        const mine = inMoves.active && inMoves.active.types;
        const attacker = onField(inMoves) || { moves: [], pp: [] };
        const picked = await this.chooseMove(
          attacker, (usable, mon) => this.strongest(usable, mon, against, mine));
        if (picked === null) continue;      // could not aim; take the turn again
        if (picked >= 0) {
          const said = this.movePicked(attacker.moves[picked], against);
          if (said) this.say(said);
        }
      }
      // Turn resolution is text; press through it until the battle ends or the
      // menu comes back.
      for (let i = 0; i < 120; i++) {
        const s = await this.snap();
        if (!s.inBattle) return this._outcome();
        if (i > 3 && menuIsLive(s)) break;
        // One thing in here is a question rather than text, and A is the wrong
        // answer to it. Declining is the policy, and it is a policy rather than
        // an omission: the pilot cannot know which of four moves you value, a
        // declined move can be taught by hand afterwards and a deleted one
        // cannot, and `chip` reasons about this very move list to pick the
        // gentlest attack when catching something -- so a set that changes
        // underneath it breaks the one piece of reasoning this app does about
        // moves.
        if (learnMoveBox(s, this.state && this.state.e)) {
          await this.declineNewMove();
          continue;
        }
        await this.push('A', 4, 6);
        await this.pump();
      }
    }
    return 'stuck';
  }

  /**
   * Find something to fight, walking back to grass if we have drifted off it.
   *
   * Pacing for an encounter walks about, and after a few battles the player is
   * no longer standing where the grass is -- so the next pace finds nothing and
   * the whole grind stops after five battles reporting that there is no grass,
   * from the middle of a route covered in it. Where grass *is* is map knowledge
   * this file does not carry, so the caller passes a way back to it.
   */
  async _findFight(regrass) {
    if (await this.paceUntilBattle()) return true;
    if (!regrass) return false;
    this.say('wandered off the grass — going back');
    if (!await regrass()) return false;
    return this.paceUntilBattle();
  }

  /**
   * Take one swing at the enemy with the gentlest attack available.
   *
   * A Poke Ball's odds depend on how much HP is left, so throwing at something
   * untouched wastes balls -- measured, three full-health targets in a row ate
   * five balls between them and none was caught. The fix is the game's own
   * tactic: hit it a bit first.
   *
   * The gentlest attack, not the first one, which is why romdata reads the move
   * table at all. Leading with whatever happens to be in slot one knocks out
   * the thing being caught, and a fainted Pokemon cannot be caught by anything.
   *
   * Returns 'ok' | 'fainted' | 'nomove' | 'ended' | 'stuck'.
   */
  async chip() {
    const menu = await this.awaitBattleMenu();
    if (menu === null) return (await this.snap()).inBattle ? 'stuck' : 'ended';
    const mon = onField(menu);
    if (!mon) return 'nomove';

    // Weakest first, and only moves that take HP off at all -- ranking LEER as
    // gentle would weaken nothing and spend the turn.
    //
    // Weakest by what the move actually does to *this* target, not by the
    // number in the table: the same reading that stopped `strongest` picking
    // the bigger number over the harder hit stops this one picking the
    // smaller number over the softer hit. And a move the target is immune to
    // is the gentlest thing imaginable and weakens it forever, so it is out
    // of the pool rather than at the front of it.
    const canChip = (m, i) =>
      m.moves[i] && m.pp[i] > 0 &&
      (!this.rom || this.rom.isChipMove(m.moves[i]));
    if (!mon.moves.some((_, i) => canChip(mon, i))) return 'nomove';

    await this.chooseAction(FIGHT);
    await this.step(30);
    let inMoves = await this.snap();
    if (inMoves.inBattle && inMoves.menu[1] < 1) {
      await this.push('B', 4, 8);
      await this.step(30);
      inMoves = await this.snap();
    }
    if (!inMoves.inBattle) return 'ended';
    if (inMoves.menu[1] < 1) return 'stuck';

    const against = inMoves.enemy && inMoves.enemy.types;
    const mine = inMoves.active && inMoves.active.types;
    const picked = await this.chooseMove(onField(inMoves) || mon, (usable, m) => {
      const hit = (i) => (this.rom ? this.rom.hitPower(m.moves[i], against, mine) : 0);
      const chippers = usable.filter((i) => canChip(m, i));
      const lands = chippers.filter(
        (i) => !this.rom || this.rom.canHit(m.moves[i], against));
      const pool = lands.length ? lands : (chippers.length ? chippers : usable);
      return pool.reduce((best, i) => (hit(i) < hit(best) ? i : best), pool[0]);
    });
    if (picked === null) return 'stuck';

    // Let the turn play out, stopping the moment the menu is ours again.
    for (let i = 0; i < 120; i++) {
      const now = await this.snap();
      if (!now.inBattle) return 'ended';
      if (now.enemy.hp === 0) return 'fainted';
      if (i > 3 && menuIsLive(now)) return 'ok';
      await this.push('A', 4, 6);
      await this.pump();
    }
    return 'stuck';
  }

  /**
   * Leave a wild battle.
   *
   * Running can fail -- the game says so and the turn passes -- so this asks
   * again rather than assuming one attempt worked. It never fights: a hunt that
   * knocked out everything it met would spend the party's HP on Pokemon it did
   * not want.
   */
  async flee(maxTurns = 8) {
    for (let turn = 0; turn < maxTurns && !this.cancelled; turn++) {
      // Running can fail, and a wild Pokemon that gets a turn can knock ours
      // out -- so the prompt is as reachable from here as from a fight. Without
      // this, hunting stopped on "could not run from a PIDGEY" while the game
      // sat waiting to be told which Pokemon to send out.
      const covered = await this.coverFaint(await this.snap());
      if (covered === 'lost') return false;      // nothing left to run with
      if (covered === 'ended') return true;
      if (covered === 'stuck') return !(await this.snap()).inBattle;
      const menu = await this.awaitBattleMenu();
      if (menu === null) return !(await this.snap()).inBattle;
      await this.chooseAction(RUN);
      for (let i = 0; i < 90; i++) {
        const s = await this.snap();
        if (!s.inBattle) return true;
        if (i > 3 && menuIsLive(s)) break;   // it refused; ask again
        await this.push('A', 4, 6);
        await this.pump();
      }
    }
    return !(await this.snap()).inBattle;
  }

  /**
   * From the battle menu: PACK, the BALL pocket, the ball, USE.
   *
   * Pocket and item are driven by reading wCurPocket and wCurItem rather than
   * by counting presses. The pack remembers where it was left, and the pocket
   * switch swallows presses while it animates -- counting either of those wrong
   * leaves the menu somewhere unexpected, and the next blind press throws a
   * ball nobody asked for. Selecting a ball opens a USE/QUIT box, so the throw
   * takes a second confirm.
   */
  /**
   * Press once, and wait for the pack to actually move.
   *
   * The same lesson nav.step learned about walking, arriving late in the one
   * place that had not had it: a step is not "press, then wait a fixed number
   * of frames", because the pocket switch swallows presses while it animates
   * and wCurItem is written a frame or so after wCurPocket. Waiting a set 20
   * frames and re-reading gives a value that has not caught up yet, so the loop
   * presses again -- and two presses landing for one observed change walk
   * straight past the pocket being aimed at.
   *
   * Measured, on a catch that failed with five Poke Balls in the bag: it left
   * the pack reading pocket 2 with item 5, and those two cannot both be current
   * -- pocket 2 is the key items, whose first entry reads 255. A mismatched
   * pair is the fingerprint of exactly this.
   *
   * Bounded, and it hands back whatever it has if nothing moves, so a press the
   * game genuinely ignored costs a re-read rather than a hang.
   */
  async _packMoved(button, of, tries = 10) {
    const before = of(await this.snap());
    await this.push(button, 4, 8);
    for (let i = 0; i < tries; i++) {
      await this.step(SETTLE_FRAMES);
      const now = await this.snap();
      if (of(now) !== before) return now;
    }
    return this.snap();
  }

  async throwBall(ballId) {
    // The menu has to be up first. Called straight after an encounter, the
    // screen is still running the "wild SENTRET appeared" text, and pressing
    // into that just advances it -- the pack never opens, and the throw was
    // reported as not being able to find the ball. flee() has always waited;
    // this did not.
    if (await this.awaitBattleMenu() === null) return false;
    await this.chooseAction(PACK);
    await this.step(60);
    let s = await this.snap();
    // The pack never opened -- read off the menu the game is *actually* drawing.
    // This used to ask whether wCurPocket was above 3, which measured on the
    // real cartridge cannot happen: the four pockets read 0 to 3 and the value
    // never leaves that range, so the guard could not fire. The battle menu's
    // own signature is what tells the two apart, and menuIsLive already knows
    // it -- the pack measures five items at row one, the battle menu
    // thirty-four at twelve.
    if (menuIsLive(s)) {
      await this.closeMenus();
      return false;
    }
    // wCurItem is written a frame or so after wCurPocket, so reading straight
    // after a press gives the item the *previous* pocket was showing. Acting on
    // that stale value is what broke this: the pack was already sitting on the
    // ball, the stale read said otherwise, and the cursor was walked off the end
    // of a one-item list.
    const settled = async () => { await this.step(SETTLE_FRAMES); return this.snap(); };

    for (let i = 0; i < 10 && s.curPocket !== BALL_POCKET; i++) {
      s = await this._packMoved('RIGHT', (x) => x.curPocket);
    }
    if (s.curPocket !== BALL_POCKET) { await this.closeMenus(); return false; }

    // DOWN past the last item lands on CANCEL and *stays* there -- the list does
    // not wrap -- so an overshoot has to be walked back rather than pressed
    // through. The pocket opens on its first item, so usually nothing to do.
    for (let i = 0; i < 12 && s.curItem !== ballId; i++) {
      if (s.curItem === CANCEL_ITEM) {
        await this.push('UP', 4, 8);
        s = await settled();
        if (s.curItem === ballId) break;
        await this.closeMenus();
        return false;
      }
      s = await this._packMoved('DOWN', (x) => x.curItem);
    }
    if (s.curItem !== ballId) { await this.closeMenus(); return false; }
    await this.push('A', 6, 10);
    await this.step(40);              // USE / QUIT, cursor starts on USE
    await this.push('A', 6, 10);
    await this.step(40);
    return true;
  }

  /**
   * Open the pack from the battle menu, and ask again if the press was eaten.
   *
   * Measured, and it cost a knockout: three attempts in one battle came back
   * *the pack never opened* -- which was an accurate reading and a wrong
   * conclusion. The pack itself opens in under twenty frames, measured
   * separately; what happens is that the A press lands while the turn's text is
   * still running and is swallowed, leaving the battle menu drawn. Giving up on
   * that spends one of three chances the battle gets, and three of them spent
   * the lot: the Pokemon fought on at 4 of 18 and fainted.
   *
   * So: press, look, press again -- the discipline `_packMoved` already applies
   * one level down. Returns the snapshot with the pack on screen, or null.
   */
  async _openBattlePack(tries = PACK_OPEN_TRIES) {
    for (let i = 0; i < tries; i++) {
      await this.chooseAction(PACK);
      await this.step(SETTLE_PACK);
      const s = await this.snap();
      if (!s.inBattle) return null;
      if (!menuIsLive(s)) return s;
    }
    return null;
  }

  /**
   * Back out of the pack, leaving the battle menu up.
   *
   * Not `closeMenus`, and that is the point: it presses B until *no window is
   * open*, and in a battle the battle menu is a window that B will not close.
   * So it can only ever exhaust its budget and report failure -- which is
   * honest and useless. The resting state in a battle is the battle menu, so
   * that is what this presses toward.
   */
  async _backToBattleMenu(tries = 6) {
    for (let i = 0; i < tries; i++) {
      const s = await this.snap();
      if (!s.inBattle || menuIsLive(s)) return true;
      await this.push('B', 5, 10);
      await this.step(SETTLE_FRAMES);
    }
    return menuIsLive(await this.snap());
  }

  /**
   * Use a healing item on whoever is on the field, without leaving the battle.
   *
   * The same pack `throwBall` drives, a different pocket, and one box fewer:
   * in a battle there is no *which Pokemon* -- it applies to the one that is
   * out. Measured on a Cyndaquil at 9 of 21: PACK draws 5/1, the item draws
   * USE/QUIT at 2/7, confirming draws 2/0, and **the HP moves on the press
   * after that** while the pocket is not written back until the box closes.
   *
   * So HP is the evidence, again, and for the reason the field version records:
   * the pocket lags what it is evidence of. The answer is `{ ok, gained }`
   * where `ok` means the thing on the field has more HP than it did.
   */
  async useItemInBattle(itemId) {
    const e = this.state.e;
    const menu = await this.awaitBattleMenu();
    if (menu === null) return { ok: false, gained: 0, message: 'no battle menu' };
    const was = onField(menu);
    if (!was) return { ok: false, gained: 0, message: 'nothing on the field' };
    const had = ((menu.items || []).find(([id]) => id === itemId) || [0, 0])[1];
    if (!had) return { ok: false, gained: 0, message: 'that is not in the bag' };

    let s = await this._openBattlePack();
    if (!s) {
      await this._backToBattleMenu();
      return { ok: false, gained: 0,
               message: await this.saying('the pack never opened') };
    }
    for (let i = 0; i < 8 && s.curPocket !== e.itemPocket; i++) {
      s = await this._packMoved('RIGHT', (x) => x.curPocket);
    }
    if (s.curPocket !== e.itemPocket) {
      await this._backToBattleMenu();
      return { ok: false, gained: 0,
               message: await this.saying('could not reach the ITEMS pocket') };
    }
    for (let i = 0; i < 24 && s.curItem !== itemId; i++) {
      if (s.curItem === CANCEL_ITEM) {
        await this.push('UP', 4, 8);
        await this.step(SETTLE_FRAMES);
        s = await this.snap();
        if (s.curItem === itemId) break;
        await this._backToBattleMenu();
        return { ok: false, gained: 0, message: 'walked past it in the pack' };
      }
      s = await this._packMoved('DOWN', (x) => x.curItem);
    }
    if (s.curItem !== itemId) {
      await this._backToBattleMenu();
      return { ok: false, gained: 0, message: 'could not find it in the pack' };
    }

    await this.push('A', 6, 10);
    await this.step(SETTLE_PACK);
    if (!this._isBox(await this.snap(), e.battlePack && e.battlePack.use)) {
      await this._backToBattleMenu();
      return { ok: false, gained: 0,
               message: await this.saying('the USE box never appeared') };
    }
    await this.push('A', 6, 10);
    await this.step(SETTLE_PACK);
    // From here it is the result being written and read out: press through it
    // until the field shows more HP or the box goes away. Not `settleText`,
    // which would tap on into whatever is drawn next -- the lesson the field
    // version of this learned the hard way.
    for (let i = 0; i < ITEM_RESULT_TAPS; i++) {
      const now = await this.snap();
      if (!now.inBattle) break;
      const mon = onField(now);
      if (mon && mon.hp > was.hp) break;
      if (!now.windowOpen) break;
      await this.push('A', 4, 8);
      await this.pump();
    }
    const after = await this.snap();
    const mon = onField(after);
    const gained = mon ? mon.hp - was.hp : 0;
    return {
      ok: gained > 0,
      gained,
      message: gained > 0 ? `+${gained} HP` : 'nothing changed on the field',
    };
  }

  /**
   * Watch a thrown ball. -> 'caught' | 'broke free' | 'gone' | 'stuck'
   *
   * Never taps A on spec. A stray press while the battle menu is up picks
   * FIGHT, which leaves the pack a step out of line, and the next throw then
   * spends a ball the count never sees -- the desktop pilot shipped exactly
   * that bug, reporting two balls while three left the bag.
   */
  async watchThrow(partyBefore, boxed = null) {
    // **A full party does not stop a catch**, and the party is then the wrong
    // thing to watch. Measured with six carried: "Gotcha! PIDGEY was caught!",
    // then the nickname question, then "AAAAAAAAAA was sent to BILL's PC." --
    // the party never moved off six and one ball left the bag. So a catch that
    // goes to the box looked exactly like one that got away.
    //
    // The screen is the evidence, and the phrase is the *title's* to say --
    // content, like `heals` and `cures`, because it is words. A cartridge that
    // has not said it keeps the old refusal, which is honest: with nothing to
    // read, a boxed catch and a getaway are the same thing from here.
    const wentToBox = async () => {
      if (!boxed) return false;
      const sc = this.state.screen && this.state.screen(await this.gb.readWram());
      return !!sc && sc.says(boxed);
    };
    // Whichever way it lands, the same question follows -- and B on it keeps
    // the name the game gave. `declineNickname` used to be called here and
    // could only be reached when the party grew, so a full-party catch went
    // unanswered and every one of them would have been named AAAAAAAAAA.
    const took = async () => {
      await this.keepDefaultName();
      await this.settleText();
      return 'caught';
    };
    for (let i = 0; i < 140; i++) {
      const s = await this.snap();
      if (s.party.length > partyBefore || await wentToBox()) return took();
      if (!s.inBattle) return 'gone';
      // The menu coming back means it broke out and the turn is ours again.
      if (i > 3 && menuIsLive(s)) return 'broke free';
      await this.push('A', 4, 6);
      await this.pump();
    }
    return 'stuck';
  }
  };
}
