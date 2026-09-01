// Tasks, driven by polling instead of CPU hooks.
//
// This is the one part of the desktop pilot that could not be ported directly.
// There, the game's own routines announced what it wanted -- a hook on
// BattleMenu fired the moment the battle menu opened. No browser core offers
// breakpoints, so the same questions are answered by watching memory:
//
//   "is the battle menu up?"   wMenuCursorX/Y become 1..2 and
//                              wBattleMenuCursorPosition is 0 (it is only
//                              written on confirm)
//   "is the move menu up?"     wMenuCursorY is 1..4 while in a battle
//   "is a script running?"     wScriptMode != 0
//   "is the world live?"       wMapStatus == 2
//
// The lesson that survives from the desktop version: read the live cursor and
// step toward the target. Gen 2 menus wrap, so counting presses from an assumed
// starting position silently picks the wrong thing.

import { NAME_MENU_FIRST_PRESET } from './state.js';

const FIGHT = 1;   // wBattleMenuCursorPosition: 1 FIGHT 2 PKMN 3 PACK 4 RUN
const PACK = 3;
const RUN = 4;
const BALL_POCKET = 1;   // wCurPocket: 0 ITEM, 1 BALL, 2 KEY ITEM, 3 TM/HM
const MAX_PARTY = 6;

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
   */
  static menuIsLive(s) {
    const [x, y] = s.menu;
    return x >= 1 && x <= 2 && y >= 1 && y <= 2 && s.battleCursor === 0;
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
  async chooseMove(mon) {
    const idx = mon.pp.findIndex((p, i) => mon.moves[i] && p > 0);
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
    await this.gb.press('A', 6, 10);
    return idx;
  }

  /** Play out one wild battle. -> 'won' | 'lost' | 'ended' | 'stuck' */
  async fightBattle(maxTurns = 40) {
    for (let turn = 0; turn < maxTurns && !this.cancelled; turn++) {
      await this.pump();
      const menu = await this.awaitBattleMenu();
      if (menu === null) {
        const s = await this.snap();
        return s.inBattle ? 'stuck' : 'won';
      }
      if (menu.party.length && menu.party.every((m) => m.hp === 0)) return 'lost';
      await this.chooseAction(FIGHT);
      await this.gb.run(30);
      const inMoves = await this.snap();
      if (inMoves.inBattle && inMoves.menu[1] >= 1) {
        await this.chooseMove(inMoves.party[0] || { moves: [], pp: [] });
      }
      // Turn resolution is text; press through it until the battle ends or the
      // menu comes back.
      for (let i = 0; i < 120; i++) {
        const s = await this.snap();
        if (!s.inBattle) return 'won';
        if (i > 3 && Tasks.menuIsLive(s)) break;
        await this.gb.press('A', 4, 6);
        await this.pump();
      }
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
  async hunt(want, { maxEncounters = 200 } = {}) {
    const started = Date.now();
    const stats = { encounters: 0, fled: 0 };
    const seen = new Map();
    this.say(`looking for ${want}`);

    while (stats.encounters < maxEncounters && !this.cancelled) {
      let s = await this.snap();
      if (!s.inBattle) {
        const found = await this.paceUntilBattle();
        if (!found) {
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
    await this.chooseAction(PACK);
    await this.gb.run(60);
    let s = await this.snap();
    if ((s.curItem === 0 || s.curItem === 0xff) && s.curPocket > 3) {
      await this.closeMenus();          // the pack never opened
      return false;
    }
    for (let i = 0; i < 10 && s.curPocket !== BALL_POCKET; i++) {
      await this.gb.press('RIGHT', 4, 8);
      s = await this.snap();
    }
    if (s.curPocket !== BALL_POCKET) { await this.closeMenus(); return false; }
    for (let i = 0; i < 12 && s.curItem !== ballId; i++) {
      await this.gb.press('DOWN', 4, 8);
      s = await this.snap();
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
  async catch_(want, ballId, { maxEncounters = 200, maxBalls = 40 } = {}) {
    const stats = { encounters: 0, fled: 0, thrown: 0 };
    const started = Date.now();
    let s = await this.snap();
    if (s.party.length >= MAX_PARTY) {
      return { ok: false, stats, message:
        'the party is full — a caught Pokemon would go to the PC, ' +
        'which this does not handle. Free a slot first.' };
    }
    const ballsOf = (snap) => {
      const e = snap.balls.find(([id]) => id === ballId);
      return e ? e[1] : 0;
    };
    const before = ballsOf(s);
    if (before <= 0) {
      return { ok: false, stats, message: 'no balls of that kind in the bag' };
    }
    const ballName = this.rom.itemName(ballId);
    this.say(`after ${want} with ${ballName}s`);

    while (stats.encounters < maxEncounters && !this.cancelled) {
      s = await this.snap();
      if (!s.inBattle) {
        const found = await this.paceUntilBattle();
        if (!found) {
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

      this.say(`found ${name} Lv${s.enemy.level} — throwing`);
      const partyBefore = s.party.length;
      while (stats.thrown < maxBalls && !this.cancelled) {
        const snap = await this.snap();
        if (ballsOf(snap) <= 0) {
          return { ok: false, stats, message: `ran out of ${ballName}s` };
        }
        if (!snap.inBattle) break;
        if (!await this.throwBall(ballId)) {
          return { ok: false, stats, message: 'could not reach the ball in the pack' };
        }
        stats.thrown++;
        const outcome = await this.watchThrow(partyBefore);
        if (outcome === 'caught') {
          const after = await this.snap();
          stats.spent = before - ballsOf(after);
          stats.seconds = ((Date.now() - started) / 1000).toFixed(1);
          const slot = after.party.length - 1;
          return { ok: true, stats,
                   message: `caught ${name} Lv${after.party[slot].level} ` +
                            `with ${stats.spent} ${ballName}` +
                            `${stats.spent === 1 ? '' : 's'}` };
        }
        if (outcome === 'gone') {
          this.say(`${name} got away`);
          break;
        }
        if (outcome === 'stuck') {
          return { ok: false, stats, message: 'lost track of the battle' };
        }
      }
      if (stats.thrown >= maxBalls) {
        return { ok: false, stats, message: `used ${stats.thrown} balls without catching it` };
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
  async grind(slot, toLevel, { maxBattles = 200, healBelow = 0.25 } = {}) {
    const started = Date.now();
    const stats = { battles: 0, won: 0, levels: 0 };
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
      if (mon.hp / Math.max(1, mon.maxHp) < healBelow) {
        return {
          ok: false,
          message: `stopped at Lv${mon.level}: ${mon.hp}/${mon.maxHp} HP and ` +
                   `this build cannot heal yet`,
          stats: { ...stats, levels: mon.level - startLevel },
        };
      }
      if (!s.inBattle) {
        const found = await this.paceUntilBattle();
        if (!found) {
          return {
            ok: false,
            message: 'no wild Pokemon appeared — are you standing in grass?',
            stats,
          };
        }
      }
      const outcome = await this.fightBattle();
      stats.battles++;
      if (outcome === 'won') stats.won++;
      if (outcome === 'lost') break;
      this.say(`battle ${stats.battles}: ${outcome}`);
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
