// Tasks, driven by polling instead of CPU hooks.
//
// This is the one part of the desktop pilot that could not be ported directly.
// There, the game's own routines announced what it wanted -- a hook on
// BattleMenu fired the moment the battle menu opened. No browser core offers
// breakpoints, so the same questions are answered by watching memory:
//
//   "is the battle menu up?"   the drawn menu measures 34 items with its box at
//                              row 12, and the cursor is within its 2x2. Not
//                              wBattleMenuCursorPosition -- see menuIsLive for
//                              why that looked right and was not
//   "is the move menu up?"     wMenuCursorY is 1..4 while in a battle
//   "is a script running?"     wScriptMode != 0
//   "is the world live?"       wMapStatus == 2
//
// The lesson that survives from the desktop version: read the live cursor and
// step toward the target. Gen 2 menus wrap, so counting presses from an assumed
// starting position silently picks the wrong thing.

import { NAME_MENU_FIRST_PRESET, TRAINER_BATTLE, MAX_PARTY }
  from './state.js';

const FIGHT = 1;   // wBattleMenuCursorPosition: 1 FIGHT 2 PKMN 3 PACK 4 RUN
const PACK = 3;
const RUN = 4;
const BALL_POCKET = 1;   // wCurPocket: 0 ITEM, 1 BALL, 2 KEY ITEM, 3 TM/HM
// wCurItem while the cursor sits on CANCEL.
const CANCEL_ITEM = 0xff;
// Consecutive unresolved battles that mean the pilot has lost the thread.
const MAX_STUCK_BATTLES = 5;
// Swings at one target before giving up on weakening it any further.
const MAX_CHIPS = 8;
// Party slots to try when sending out a replacement.
const MAX_SEND_TRIES = 6;
// Times to try the whole START -> SAVE -> YES flow before giving up.
const SAVE_ATTEMPTS = 3;
// Frames for the save prompt to appear after SAVE is chosen.
const SAVE_PROMPT_FRAMES = 40;
// Polls waiting for the confirm box to become interactive.
const SAVE_CONFIRM_TRIES = 60;
// Polls waiting for the START menu's cursor to appear.
const MENU_OPEN_TRIES = 25;
// The party screen ignores the short presses the battle menu takes.
const PARTY_HOLD = 12, PARTY_GAP = 24, PARTY_SETTLE = 40;
// What the drawn battle menu measures, telling it from the pack over the top of
// it: wMenuDataItems and wMenuBorderTopCoord.
const BATTLE_MENU_ITEMS = 34, BATTLE_MENU_TOP = 12;
// Long enough for the pack to write wCurItem for the pocket now showing.
const SETTLE_FRAMES = 20;

export class Tasks {
  constructor(gb, state, onProgress = () => {}, rom = null) {
    this.gb = gb;
    this.state = state;
    this.rom = rom;
    this.onProgress = onProgress;
    this.cancelled = false;
    this.ticks = 0;
    this.named = false;
  }

  cancel() { this.cancelled = true; }

  /**
   * Hand the browser a slot.
   *
   * The task loops are `await`-heavy but never actually yield to the event
   * loop -- the emulator calls resolve immediately -- so a running task pins
   * the main thread. The page then cannot repaint or handle a tap, which means
   * the Stop button is unclickable and Android decides the tab has hung.
   * Yielding periodically costs a few ms per hundred frames and buys back a
   * responsive page.
   *
   * A MessageChannel rather than setTimeout(0): browsers clamp timers in a
   * backgrounded tab to roughly one per second, which would turn a yield every
   * sixteen presses into a grind that takes hours once you switch apps. Message
   * events are not clamped that way.
   */
  async pump() {
    if (++this.ticks % 16) return;
    await new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
      ch.port2.postMessage(0);
    });
  }

  async snap() {
    return this.state.read(await this.gb.readWram());
  }

  /**
   * Is the battle menu up and waiting for a choice?
   *
   * Both halves of the cursor have to be in range. Checking only the column
   * mistakes the text after a run attempt for a fresh menu: the cursor keeps
   * the column RUN was chosen on and the confirm slot clears itself, so it
   * reads as (2, 3) -- a column that looks right above a row that cannot be.
   * Fleeing gave up on that misreading and reported it could not run from a
   * SENTRET it had in fact escaped.
   *
   * What must *not* be in here is wBattleMenuCursorPosition. It holds the action
   * last chosen, not whether the menu is waiting: it is 0 until the first choice
   * of a battle and keeps that choice afterwards. Requiring it to be 0 therefore
   * matched only the opening turn and was false for every turn after -- so
   * awaitBattleMenu spent 150 presses and returned null, flee could not tell a
   * refusal from an escape, and watchThrow could not see a Pokemon break free.
   * Measured at a menu that was plainly live and taking input, it read 3.
   *
   * That is also why a throw could burn five balls and catch nothing: the break
   * free went unnoticed, the presses meant to clear text re-opened the pack, and
   * the last one left the pilot sitting in an empty ball pocket on CANCEL.
   *
   * The cursor is not enough on its own either, because the pack parks it at
   * (1, 1) too -- so a ball in mid-air read as a fresh menu, and the throw was
   * abandoned before the game had finished saying "used the POKé BALL". Which
   * menu is actually drawn settles it: measured, the battle menu is 34 items
   * with its box at row 12, while the pack is 5 items at row 1 and the pack
   * mid-throw is 2 at row 0. The move menu shares the battle menu's box, and
   * that is fine -- both mean the game is waiting on us.
   */
  static menuIsLive(s) {
    const [x, y] = s.menu;
    if (s.menuItems !== BATTLE_MENU_ITEMS || s.menuTop !== BATTLE_MENU_TOP) {
      return false;
    }
    return x >= 1 && x <= 2 && y >= 1 && y <= 2;
  }

  say(msg) { this.onProgress(msg); }

  /**
   * Advance to a live, controllable overworld -- title screen through to a map.
   *
   * Only ever run for an automated test. A person starting a new game should
   * see their own intro and pick their own name; see main.js.
   */
  async continueGame(maxFrames = 20000) {
    await this.gb.run(2500);
    let spent = 2500;
    // Two different checks at two different rates. "Has the world loaded?"
    // needs a whole snapshot, which is expensive, and being a few presses late
    // costs nothing -- so it runs every tenth press. "Is the NAME menu up?"
    // reads a handful of bytes and must run every press: that menu blocks on a
    // choice, and one stray A takes NEW NAME and drops us in the letter grid.
    for (let i = 0; spent < maxFrames; i++) {
      if (await this.takeNameMenu()) continue;
      await this.gb.press('A', 5, 8);
      await this.pump();
      spent += 13;
      if (i % 10 !== 0) continue;
      const s = await this.snap();
      if (s.worldLoaded) {
        await this.gb.run(30);
        return true;
      }
    }
    return false;
  }

  /**
   * Pick one of the game's own names if the NAME menu is up.
   *
   * Mashing A through this menu takes NEW NAME, and then mashing A through the
   * letter grid that follows spells AAAAA. The presets below NEW NAME are
   * stored directly with no naming screen at all.
   *
   * Once only. The menu's shape is read out of wMenuData, and nothing clears
   * that when a menu closes -- so after the name is chosen the signature still
   * matches, and without the latch the intro loop sits here re-picking a name
   * that has already been picked, forever.
   */
  async takeNameMenu() {
    if (this.named) return false;
    const win = await this.gb.readBytes(
      this.state.menuWindow.addr, this.state.menuWindow.len);
    if (!this.state.nameMenuUp(win)) return false;
    for (let i = 0; i < 12; i++) {
      const now = await this.gb.readBytes(
        this.state.menuWindow.addr, this.state.menuWindow.len);
      const cur = this.state.menuCursorY(now);
      if (cur === NAME_MENU_FIRST_PRESET) {
        await this.gb.press('A', 6, 20);
        this.named = true;
        this.say('picked one of the game\'s own names');
        return true;
      }
      await this.gb.press(cur < NAME_MENU_FIRST_PRESET ? 'DOWN' : 'UP', 4, 6);
    }
    return false;
  }

  /** Walk back and forth until a wild battle starts. */
  async paceUntilBattle(maxSteps = 400) {
    let dir = 'LEFT';
    for (let i = 0; i < maxSteps && !this.cancelled; i++) {
      await this.gb.press(dir, 10, 4);
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
    await this.gb.run(40);
    for (let i = 0; i < tries; i++) {
      const s = await this.snap();
      if (!s.inBattle) return null;
      if (Tasks.menuIsLive(s)) return s;
      await this.gb.press('A', 4, 6);   // push through text
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
      if (x !== wantX) await this.gb.press(wantX > x ? 'RIGHT' : 'LEFT', 4, 6);
      else if (y !== wantY) await this.gb.press(wantY > y ? 'DOWN' : 'UP', 4, 6);
    }
    await this.gb.press('A', 6, 10);
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
      await this.gb.press('A', 6, 10);
      return -1;
    }
    const target = idx + 1;
    for (let i = 0; i < 6; i++) {
      const s = await this.snap();
      if (s.menu[1] === target) break;
      await this.gb.press('DOWN', 4, 6);
    }
    // Confirm only if the cursor really is on the move we meant. Pressing A
    // regardless picks whatever is highlighted, and when that is a move with no
    // PP the game says so and puts the menu straight back -- which reads as a
    // fresh turn, so it was chosen again, forever. Eighty-four "battles" in one
    // grind were that same refusal.
    if ((await this.snap()).menu[1] !== target) {
      await this.gb.press('B', 4, 8);
      return null;
    }
    await this.gb.press('A', 6, 10);
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
    await this.gb.run(20);                      // let the last HP write land
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
      await this.gb.press(button, hold, PARTY_GAP);
      await this.gb.run(PARTY_SETTLE);
    };

    await nudge('B', 6);                 // clear whatever text is still up
    for (let i = 0; i < next; i++) await nudge('DOWN');

    for (let attempt = 0; attempt < MAX_SEND_TRIES; attempt++) {
      await nudge('A', 8);
      for (let i = 0; i < 60; i++) {
        const now = await this.snap();
        if (!now.inBattle) return 'ended';
        if (now.active.maxHp > 0 && now.active.hp > 0) return 'ok';
        if (i > 2 && Tasks.menuIsLive(now)) return 'ok';
        await this.gb.press('A', 4, 6);
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
      await this.gb.run(30);
      let inMoves = await this.snap();
      // No move menu means something is still on screen -- most often the
      // message refusing the move just picked. Back out and look again rather
      // than pressing A into it, which only re-picks the refused move.
      if (inMoves.inBattle && inMoves.menu[1] < 1) {
        await this.gb.press('B', 4, 8);
        await this.gb.run(30);
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
        if (i > 3 && Tasks.menuIsLive(s)) break;
        await this.gb.press('A', 4, 6);
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
    await this.gb.run(30);
    let inMoves = await this.snap();
    if (inMoves.inBattle && inMoves.menu[1] < 1) {
      await this.gb.press('B', 4, 8);
      await this.gb.run(30);
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
      if (i > 3 && Tasks.menuIsLive(now)) return 'ok';
      await this.gb.press('A', 4, 6);
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
        if (i > 3 && Tasks.menuIsLive(s)) break;   // it refused; ask again
        await this.gb.press('A', 4, 6);
        await this.pump();
      }
    }
    return !(await this.snap()).inBattle;
  }

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
        await this.gb.run(40);
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
    await this.gb.run(60);
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
    const settled = async () => { await this.gb.run(SETTLE_FRAMES); return this.snap(); };

    for (let i = 0; i < 10 && s.curPocket !== BALL_POCKET; i++) {
      await this.gb.press('RIGHT', 4, 8);
      s = await settled();
    }
    if (s.curPocket !== BALL_POCKET) { await this.closeMenus(); return false; }

    // DOWN past the last item lands on CANCEL and *stays* there -- the list does
    // not wrap -- so an overshoot has to be walked back rather than pressed
    // through. The pocket opens on its first item, so usually nothing to do.
    for (let i = 0; i < 12 && s.curItem !== ballId; i++) {
      if (s.curItem === CANCEL_ITEM) {
        await this.gb.press('UP', 4, 8);
        s = await settled();
        if (s.curItem === ballId) break;
        await this.closeMenus();
        return false;
      }
      await this.gb.press('DOWN', 4, 8);
      s = await settled();
    }
    if (s.curItem !== ballId) { await this.closeMenus(); return false; }
    await this.gb.press('A', 6, 10);
    await this.gb.run(40);              // USE / QUIT, cursor starts on USE
    await this.gb.press('A', 6, 10);
    await this.gb.run(40);
    return true;
  }

  async closeMenus(times = 4) {
    for (let i = 0; i < times; i++) await this.gb.press('B', 5, 10);
  }

  /**
   * Answer a "give it a nickname?" box with NO.
   *
   * It defaults to YES, and saying yes opens the letter grid -- where anything
   * that can only press A spells AAAAA. Driven against the live cursor: the box
   * is not interactive the instant it appears, so a blind DOWN gets swallowed
   * and the A behind it answers yes, which is the exact failure being avoided.
   */
  async declineNickname(tries = 14) {
    await this.gb.run(24);
    for (let i = 0; i < tries; i++) {
      const s = await this.snap();
      if (!s.windowOpen) return false;
      const row = s.menu[1];
      if (row === 2) { await this.gb.press('A', 6, 10); return true; }
      if (row === 0) { await this.gb.run(6); continue; }
      await this.gb.press('DOWN', 4, 6);
    }
    return false;
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
      if (i > 3 && Tasks.menuIsLive(s)) return 'broke free';
      if (s.windowOpen && s.menu[1] >= 1 && s.party.length > partyBefore) {
        await this.declineNickname();
        await this.settleText();
        return 'caught';
      }
      await this.gb.press('A', 4, 6);
      await this.pump();
    }
    return 'stuck';
  }

  /** Tap through whatever text is left until the game stops asking. */
  async settleText(taps = 40) {
    for (let i = 0; i < taps; i++) {
      const s = await this.snap();
      if (!s.inBattle && !s.windowOpen && !s.scriptRunning) return;
      await this.gb.press('A', 4, 8);
      await this.pump();
    }
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
          await this.gb.run(SETTLE_FRAMES);
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
    switch (r.outcome) {
      case 'caught':
        return { ok: true, stats,
                 message: `caught ${r.name}${r.level ? ` Lv${r.level}` : ''} `
                          + `with ${balls(r.thrown)}` };
      case 'nobattle':
        return { ok: false, stats, message: 'not in a battle' };
      case 'trainer':
        return { ok: false, stats,
                 message: "that is a trainer's Pokémon — it cannot be caught" };
      case 'full':
        return { ok: false, stats, message:
          'the party is full — a caught Pokémon would go to the PC, '
          + 'which this does not handle. Free a slot first.' };
      case 'noballs':
        return { ok: false, stats, message: 'no balls of that kind in the bag' };
      case 'nopack':
        return { ok: false, stats,
                 message: 'could not reach the ball in the pack' };
      case 'ranout':
        return { ok: false, stats,
                 message: `used ${balls(r.thrown)} and then had none left` };
      case 'knockedOut':
        return { ok: false, stats, message: `knocked the ${r.name} out` };
      case 'gone':
        return { ok: false, stats, message: `the ${r.name} got away` };
      case 'lost':
        return { ok: false, stats,
                 message: `your lead fainted before the ${r.name} could be caught` };
      case 'stuck':
        return { ok: false, stats, message: 'lost track of the battle' };
      case 'cancelled':
        return { ok: false, stats, message: 'stopped' };
      default:
        return { ok: false, stats,
                 message: `used ${balls(r.thrown)} without catching it` };
    }
  }

  /**
   * Save the game, the way a person does: START -> SAVE -> YES.
   *
   * Driven through the real menu rather than by writing SRAM, because writing
   * is not possible here -- the core hands back copies -- and because a save
   * the game did not make itself would be a save the game does not trust.
   *
   * Success is taken from the battery changing, not from the presses landing.
   * The desktop pilot can watch its SaveGameData hook fire; there are no hooks
   * in a browser, so the evidence here is the bytes: 32KB of cartridge RAM
   * before and after, and a save that commits always moves them, if only the
   * play-time counter and the checksums. That is a stronger claim than the hook
   * anyway -- it is the thing we actually want to be true.
   */
  async saveGame() {
    const started = Date.now();
    const before = await this.gb.batterySave();
    const digest = (bytes) => {
      let h = 0;
      for (let i = 0; i < bytes.length; i++) h = (Math.imul(h, 31) + bytes[i]) >>> 0;
      return h;
    };
    // The game's own validity test, not a count of non-zero bytes -- a battery
    // that has never been saved to still reads five of those.
    const wasBlank = !this.state.saveIsPresent(before);
    const hashBefore = digest(before);

    let s = await this.snap();
    if (s.inBattle) return { ok: false, message: 'finish the battle first' };
    if (!s.worldLoaded) return { ok: false, message: 'start a game first' };
    if (s.scriptRunning) {
      // Mid-cutscene the START menu will not open, and the presses would
      // answer whatever is on screen instead.
      await this.settleText();
      s = await this.snap();
      if (s.scriptRunning) {
        return { ok: false, message: 'something is happening on screen — wait' };
      }
    }

    for (let attempt = 0; attempt < SAVE_ATTEMPTS && !this.cancelled; attempt++) {
      if (await this._saveOnce()) {
        const after = await this.gb.batterySave();
        // Two things have to be true: the bytes moved, and what they now hold
        // is a save the cartridge would load. The first alone would accept a
        // half-written battery; the second alone would accept a save that was
        // already there before this attempt did nothing.
        if (digest(after) !== hashBefore && this.state.saveIsPresent(after)) {
          const secs = ((Date.now() - started) / 1000).toFixed(1);
          return { ok: true, seconds: secs, firstSave: wasBlank,
                   message: wasBlank ? 'saved — the game now has save data'
                                     : 'saved' };
        }
        // The menu flow completed and the battery did not move. Reported
        // rather than smoothed over: a save that did not commit is exactly
        // the thing worth knowing about.
        this.say('the menu went through but the battery did not change');
      }
      await this.closeMenus(6);
      await this.gb.run(SETTLE_FRAMES);
    }
    if (this.cancelled) return { ok: false, message: 'stopped' };
    return { ok: false, message: 'could not get the game to save' };
  }

  /** One attempt at the menu flow. True if it believes it saved. */
  async _saveOnce() {
    await this.closeMenus(3);
    if (!await this._openStartMenu()) return false;

    const count = await this._menuRowCount();
    if (count < 3) return false;
    // The last three rows are always SAVE, OPTION, EXIT, so SAVE is count-2
    // whether or not the POKeDEX row exists yet. Tried first, then the others:
    // a wrong guess opens the pack or the party, which is recoverable, and
    // guessing again beats giving up.
    const order = [count - 2];
    for (let r = 1; r <= count; r++) if (r !== count - 2) order.push(r);

    for (const row of order) {
      if (this.cancelled) return false;
      if (await this._trySaveRow(row, count)) return true;
    }
    return false;
  }

  async _trySaveRow(row, count) {
    if (!await this._openStartMenu()) return false;
    if (!await this._driveMenuCursor(row, count)) return false;

    await this.gb.press('A', 5, 10);
    await this.gb.run(SAVE_PROMPT_FRAMES);

    // "Would you like to save the game?" -- YES is preselected, and the box is
    // not interactive the moment it appears. Waiting for its cursor is the
    // same lesson the nickname box taught: an A pressed too early is swallowed
    // and the next one answers something else.
    for (let i = 0; i < SAVE_CONFIRM_TRIES; i++) {
      const win = await this.gb.readBytes(this.state.menuWindow.addr,
                                          this.state.menuWindow.len);
      if (this.state.menuCursorY(win) === 1) break;
      await this.gb.run(6);
    }
    await this.gb.press('A', 5, 10);
    await this.settleText();

    // Back in the world with no window open is what a finished save looks like.
    const s = await this.snap();
    return s.worldLoaded && !s.windowOpen && !s.inBattle;
  }

  /** Open the START menu and confirm it really opened. */
  async _openStartMenu(tries = 3) {
    for (let attempt = 0; attempt < tries; attempt++) {
      await this.gb.press('START', 5, 10);
      for (let i = 0; i < MENU_OPEN_TRIES; i++) {
        await this.gb.run(6);
        const win = await this.gb.readBytes(this.state.menuWindow.addr,
                                            this.state.menuWindow.len);
        if (this.state.menuCursorY(win) !== 0) return true;
      }
    }
    return false;
  }

  /**
   * How many rows the START menu has, by stepping until the cursor repeats.
   *
   * Counted rather than assumed because the menu grows: no POKeDEX or POKeGEAR
   * early on, and a fixed row number would land on OPTION once they appear.
   * Bails out if the player turns out to be walking -- that means the menu was
   * never open and these presses are moving us through the grass, which starts
   * a battle and makes saving impossible.
   */
  async _menuRowCount(limit = 12) {
    const start = (await this.snap()).pos;
    const seen = [];
    for (let i = 0; i < limit; i++) {
      const win = await this.gb.readBytes(this.state.menuWindow.addr,
                                          this.state.menuWindow.len);
      const cur = this.state.menuCursorY(win);
      if (seen.includes(cur)) break;
      seen.push(cur);
      await this.gb.press('DOWN', 5, 8);
      const now = (await this.snap()).pos;
      if (now[0] !== start[0] || now[1] !== start[1]) {
        this.say('the START menu was not open — the player moved');
        return 0;
      }
    }
    return seen.length ? Math.max(...seen) : 0;
  }

  async _driveMenuCursor(target, count) {
    for (let i = 0; i < count + 2; i++) {
      const win = await this.gb.readBytes(this.state.menuWindow.addr,
                                          this.state.menuWindow.len);
      if (this.state.menuCursorY(win) === target) return true;
      await this.gb.press('DOWN', 5, 8);
    }
    const win = await this.gb.readBytes(this.state.menuWindow.addr,
                                        this.state.menuWindow.len);
    return this.state.menuCursorY(win) === target;
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
        await this.gb.run(40);
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

      if (r.outcome === 'caught') {
        stats.spent = stats.thrown;
        stats.seconds = ((Date.now() - started) / 1000).toFixed(1);
        return { ok: true, stats,
                 message: `caught ${name}${r.level ? ` Lv${r.level}` : ''} `
                          + `with ${stats.spent} ${ballName}`
                          + `${stats.spent === 1 ? '' : 's'}` };
      }
      if (r.outcome === 'knockedOut') {
        // Not a failure worth stopping for: there is another one in the grass.
        stats.knockedOut = (stats.knockedOut || 0) + 1;
        this.say(`knocked the ${name} out — looking for another`);
        await this.settleText();
        continue;
      }
      if (r.outcome === 'gone') {
        this.say(`${name} got away`);
        continue;
      }
      if (r.outcome === 'nopack') {
        return { ok: false, stats,
                 message: 'could not reach the ball in the pack' };
      }
      if (r.outcome === 'ranout') {
        return { ok: false, stats, message:
          `used ${stats.thrown} ${ballName}${stats.thrown === 1 ? '' : 's'} `
          + 'and then had none left' };
      }
      if (r.outcome === 'stuck') {
        return { ok: false, stats, message: 'lost track of the battle' };
      }
      if (r.outcome === 'lost') {
        // Stop. Unlike a grind this has no heal hook, so carrying on would
        // walk into the next encounter with a fainted lead and spend the rest
        // of the budget answering party screens.
        return { ok: false, stats,
                 message: 'your lead fainted while weakening — heal and retry' };
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
}
