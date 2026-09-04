// One battle: choosing an action, choosing a move, throwing, and watching.
//
// Everything here works on the situation in front of it and reports what
// happened. Deciding whether a battle was worth having is jobs.js's problem.
import { SETTLE_FRAMES } from '../gbcore/taskbase.js';
const FIGHT = 1;   // wBattleMenuCursorPosition: 1 FIGHT 2 PKMN 3 PACK 4 RUN
const PACK = 3;
const RUN = 4;
const BALL_POCKET = 1;   // wCurPocket: 0 ITEM, 1 BALL, 2 KEY ITEM, 3 TM/HM
// wCurItem while the cursor sits on CANCEL.
const CANCEL_ITEM = 0xff;
// Party slots to try when sending out a replacement.
const MAX_SEND_TRIES = 6;
// The party screen ignores the short presses the battle menu takes.
const PARTY_HOLD = 12, PARTY_GAP = 24, PARTY_SETTLE = 40;
// What the drawn battle menu measures, telling it from the pack over the top of
// it: wMenuDataItems and wMenuBorderTopCoord.
const BATTLE_MENU_ITEMS = 34, BATTLE_MENU_TOP = 12;

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
export function menuIsLive(s) {
  const [x, y] = s.menu;
  if (s.menuItems !== BATTLE_MENU_ITEMS || s.menuTop !== BATTLE_MENU_TOP) {
    return false;
  }
  return x >= 1 && x <= 2 && y >= 1 && y <= 2;
}


export function withBattle(Base) {
  // Named, so a stack trace says which of these a frame came from.
  return class WithBattle extends Base {
  /** Kept as a static so external callers and tests can reach it. */
  static menuIsLive(s) {
    return menuIsLive(s);
  }

  /** Walk back and forth until a wild battle starts. */
  async paceUntilBattle(maxSteps = 400) {
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
      await this.push('A', 4, 6);   // push through text
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

  /** Play out one wild battle. -> 'won' | 'lost' | 'ended' | 'stuck' */
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

  async fightBattle(maxTurns = 40) {
    for (let turn = 0; turn < maxTurns && !this.cancelled; turn++) {
      await this.pump();
      // Before anything else, because a fainted lead means the game is waiting
      // on the party screen and awaitBattleMenu would spend 150 presses finding
      // out that no battle menu is coming.
      const pre = await this.snap();
      // maxHp as well as hp, because "no HP" and "no Pokemon on the field yet"
      // read identically otherwise: at "Wild PIDGEY appeared!" the battle mon is
      // not loaded and both are zero, so keying off hp alone fired at the start
      // of every battle and reported five stuck battles in four tenths of a
      // second, having sent nothing out.
      if (pre.inBattle && pre.party.length &&
          pre.active.maxHp > 0 && pre.active.hp === 0) {
        const how = await this.sendOut();
        if (how === 'lost') return 'lost';
        if (how === 'ended') return this._outcome();
        if (how === 'stuck') return 'stuck';
        continue;
      }
      const menu = await this.awaitBattleMenu();
      if (menu === null) return this._outcome();
      if (menu.party.length && menu.party.every((m) => m.hp === 0)) return 'lost';
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
        const picked =
          await this.chooseMove(inMoves.party[0] || { moves: [], pp: [] });
        if (picked === null) continue;      // could not aim; take the turn again
      }
      // Turn resolution is text; press through it until the battle ends or the
      // menu comes back.
      for (let i = 0; i < 120; i++) {
        const s = await this.snap();
        if (!s.inBattle) return this._outcome();
        if (i > 3 && menuIsLive(s)) break;
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
    const mon = menu.party[0];
    if (!mon) return 'nomove';

    // Weakest first, and only moves that take HP off at all -- ranking LEER as
    // gentle would weaken nothing and spend the turn.
    const power = (i) => {
      const info = this.rom && this.rom.move(mon.moves[i]);
      return info ? info.power : 0;
    };
    const canChip = (i) =>
      mon.moves[i] && mon.pp[i] > 0 &&
      (!this.rom || this.rom.isChipMove(mon.moves[i]));
    if (!mon.moves.some((_, i) => canChip(i))) return 'nomove';

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

    const picked = await this.chooseMove(inMoves.party[0] || mon, (usable) => {
      const chippers = usable.filter(canChip);
      const pool = chippers.length ? chippers : usable;
      return pool.reduce((best, i) => (power(i) < power(best) ? i : best), pool[0]);
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
    if ((s.curItem === 0 || s.curItem === 0xff) && s.curPocket > 3) {
      await this.closeMenus();          // the pack never opened
      return false;
    }
    // wCurItem is written a frame or so after wCurPocket, so reading straight
    // after a press gives the item the *previous* pocket was showing. Acting on
    // that stale value is what broke this: the pack was already sitting on the
    // ball, the stale read said otherwise, and the cursor was walked off the end
    // of a one-item list.
    const settled = async () => { await this.step(SETTLE_FRAMES); return this.snap(); };

    for (let i = 0; i < 10 && s.curPocket !== BALL_POCKET; i++) {
      await this.push('RIGHT', 4, 8);
      s = await settled();
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
      await this.push('DOWN', 4, 8);
      s = await settled();
    }
    if (s.curItem !== ballId) { await this.closeMenus(); return false; }
    await this.push('A', 6, 10);
    await this.step(40);              // USE / QUIT, cursor starts on USE
    await this.push('A', 6, 10);
    await this.step(40);
    return true;
  }

  /**
   * Watch a thrown ball. -> 'caught' | 'broke free' | 'gone' | 'stuck'
   *
   * Never taps A on spec. A stray press while the battle menu is up picks
   * FIGHT, which leaves the pack a step out of line, and the next throw then
   * spends a ball the count never sees -- the desktop pilot shipped exactly
   * that bug, reporting two balls while three left the bag.
   */
  async watchThrow(partyBefore) {
    for (let i = 0; i < 140; i++) {
      const s = await this.snap();
      if (!s.inBattle) {
        if (s.party.length > partyBefore) {
          await this.declineNickname();
          await this.settleText();
          return 'caught';
        }
        return 'gone';
      }
      // The menu coming back means it broke out and the turn is ours again.
      if (i > 3 && menuIsLive(s)) return 'broke free';
      if (s.windowOpen && s.menu[1] >= 1 && s.party.length > partyBefore) {
        await this.declineNickname();
        await this.settleText();
        return 'caught';
      }
      await this.push('A', 4, 6);
      await this.pump();
    }
    return 'stuck';
  }
  };
}
