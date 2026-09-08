// The game's own menus: the intro, the START menu, and saving.
//
// Driving a menu means reading the cursor and stepping it, never counting
// presses from an assumed origin.
//
// That used to say the reason was that "the cursor persists between openings",
// and measured on the cartridge it does not -- not for this menu. Walking the
// START menu to row 3, 6 and 2, closing it and re-opening it each time, put the
// cursor back on row 1 every time, and `wMenuCursorY` read 0 for the whole of
// every interval when nothing was open. So the origin is more predictable than
// this module assumed.
//
// Reading the cursor is still right, and the better reason is the one below it:
// the number of rows is not fixed either. The START menu grows as the game
// gives you a POKeDEX and a POKeGEAR -- measured at six rows in Elm's lab --
// so counting presses from a known origin still lands on the wrong row later
// even when the origin is known.
import { SETTLE_FRAMES } from '../gbcore/taskbase.js';
// Times to try the whole START -> SAVE -> YES flow before giving up.
const SAVE_ATTEMPTS = 3;
// Frames for the save prompt to appear after SAVE is chosen.
const SAVE_PROMPT_FRAMES = 40;
// Polls waiting for the confirm box to become interactive.
const SAVE_CONFIRM_TRIES = 60;
// Polls waiting for the START menu's cursor to appear.
const MENU_OPEN_TRIES = 25;
// How long the pack and its boxes take to draw. Measured: fifty frames is
// enough for the pack to be readable after A, and reading sooner gives the box
// that was there before -- which is the whole reason these are matched on shape.
const SETTLE_PACK = 50;
// DOWN past the last entry in a pocket lands here and stays: the list does not
// wrap, so an overshoot has to be walked back.
const CANCEL = 0xff;
// How long to wait for the ITEM pocket to be written back after a use. The
// pocket lags -- see `useItemOn` for the measurement -- and this is a bound on
// waiting for it, not a promise that it will arrive.
const BAG_SETTLE_TRIES = 10;

export function withMenus(Base) {
  // Named, so a stack trace says which of these a frame came from.
  return class WithMenus extends Base {
  /**
   * Advance to a live, controllable overworld -- title screen through to a map.
   *
   * Only ever run for an automated test. A person starting a new game should
   * see their own intro and pick their own name; see main.js.
   */
  async continueGame(maxFrames = 20000) {
    await this.step(2500);
    let spent = 2500;
    // Two different checks at two different rates. "Has the world loaded?"
    // needs a whole snapshot, which is expensive, and being a few presses late
    // costs nothing -- so it runs every tenth press. "Is the NAME menu up?"
    // reads a handful of bytes and must run every press: that menu blocks on a
    // choice, and one stray A takes NEW NAME and drops us in the letter grid.
    for (let i = 0; spent < maxFrames; i++) {
      if (await this.takeNameMenu()) continue;
      await this.push('A', 5, 8);
      await this.pump();
      spent += 13;
      if (i % 10 !== 0) continue;
      const s = await this.snap();
      if (s.worldLoaded) {
        await this.step(30);
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
    const first = this.state.e.nameMenu.firstPreset;
    for (let i = 0; i < 12; i++) {
      const now = await this.gb.readBytes(
        this.state.menuWindow.addr, this.state.menuWindow.len);
      const cur = this.state.menuCursorY(now);
      if (cur === first) {
        await this.push('A', 6, 20);
        this.named = true;
        this.say('picked one of the game\'s own names');
        return true;
      }
      await this.push(cur < first ? 'DOWN' : 'UP', 4, 6);
    }
    return false;
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
    return this.answerNo(tries);
  }

  /**
   * Answer whatever YES/NO box is on screen with YES.
   *
   * The cursor starts on YES, so this looks like it could just press A -- and
   * that is the mistake `answerNo` was written to avoid: the box is not
   * interactive the instant it appears, and a press that arrives early is
   * swallowed. So this waits for the cursor to be somewhere real, moves it up if
   * something has already moved it down, and only then presses.
   */
  async answerYes(tries = 14) {
    await this.step(24);
    for (let i = 0; i < tries; i++) {
      const s = await this.snap();
      if (!s.windowOpen) return false;
      const row = s.menu[1];
      if (row === 1) { await this.push('A', 6, 10); return true; }
      if (row === 0) { await this.step(6); continue; }
      await this.push('UP', 4, 6);
    }
    return false;
  }

  /**
   * Answer whatever YES/NO box is on screen with NO.
   *
   * This was the body of `declineNickname`, and nothing about it was ever about
   * nicknames: Gen 2 draws one two-row box for every yes-or-no question, YES on
   * row 1 and NO on row 2, and this drives the cursor to the second row and
   * presses it. Lifted out under its own name because a second caller arrived
   * -- the box offering to delete a move to make room for a new one -- and
   * naming it after the first question it was asked would have been the reason
   * somebody wrote a second copy.
   *
   * Driven against the live cursor rather than blind, and that is the whole
   * lesson in it: the box is not interactive the instant it appears, so a blind
   * DOWN is swallowed and the A behind it answers YES -- which is the exact
   * failure being avoided.
   */
  async answerNo(tries = 14) {
    await this.step(24);
    for (let i = 0; i < tries; i++) {
      const s = await this.snap();
      if (!s.windowOpen) return false;
      const row = s.menu[1];
      if (row === 2) { await this.push('A', 6, 10); return true; }
      if (row === 0) { await this.step(6); continue; }
      await this.push('DOWN', 4, 6);
    }
    return false;
  }

  /**
   * Is the box on screen the one this shape describes?
   *
   * The cursor keeps its previous value between boxes, so "a window is open" and
   * "the cursor is somewhere" are both true of the wrong box. The shape --
   * `menuItems` and `menuTop` -- is what identifies one, which is the lesson
   * `learnMove` and the battle pack both already carry, arriving here for the
   * three boxes between the START menu and a healed Pokemon.
   */
  _isBox(s, shape) {
    return !!shape && s.windowOpen
           && s.menuItems === shape.items && s.menuTop === shape.top;
  }

  /**
   * Open the pack from the START menu, by trying rows and checking.
   *
   * The row is not fixed and cannot be counted to. The START menu grows -- no
   * POKeDEX or POKeGEAR early on -- so PACK sits at a different index depending
   * on how far the game has got, and `saveGame` learned the same thing about
   * SAVE. Measured on a fresh Route 29 save it is row 2 of 7; the point is that
   * nothing here believes that. It drives to a row, presses A, and asks whether
   * the pack's own box is what appeared.
   */
  async _openPack(tries = 8) {
    if (!await this._openStartMenu()) return false;
    const count = await this._menuRowCount();
    if (!count) return false;
    const shape = this.state.e.field && this.state.e.field.pack;
    for (let row = 1; row <= Math.min(count, tries); row++) {
      if (!await this._openStartMenu()) return false;
      if (!await this._driveMenuCursor(row, count)) continue;
      await this.push('A', 6, 10);
      await this.step(SETTLE_PACK);
      if (this._isBox(await this.snap(), shape)) return true;
      // Not the pack. Back out of whatever it was -- which is what
      // `closeMenus` is for, and it checks now, so a row that opened something
      // sticky cannot leave the next row's press driving that instead.
      await this.closeMenus();
    }
    return false;
  }

  /**
   * Use an item in `slot` of the ITEM pocket on party member `on`.
   *
   * Four boxes deep, and every one of them is confirmed by its shape before
   * anything is pressed into it. The evidence of success is not the presses
   * landing: it is **the item count going down and the HP going up**, which is
   * the same standard `saveGame` holds itself to, and for the same reason --
   * measured at full HP, the game takes the presses, says the item would have
   * no effect, spends nothing, and drops back to the pack. A press-counting
   * version calls that a heal.
   */
  async useItemOn(itemId, on = 0) {
    const e = this.state.e.field || {};
    const before = await this.snap();
    const had = (before.items.find(([id]) => id === itemId) || [0, 0])[1];
    if (!had) return { ok: false, message: 'that is not in the bag' };
    const target = before.party[on];
    if (!target) return { ok: false, message: `party slot ${on + 1} is empty` };

    if (!await this._openPack()) {
      await this.closeMenus();
      return { ok: false, message: 'could not open the pack' };
    }
    // The pack remembers which pocket it was left in, so this is a walk to the
    // right one rather than an assumption about where it opens.
    let s = await this.snap();
    for (let i = 0; i < 8 && s.curPocket !== this.state.e.itemPocket; i++) {
      s = await this._packMoved('RIGHT', (x) => x.curPocket);
    }
    if (s.curPocket !== this.state.e.itemPocket) {
      await this.closeMenus();
      return { ok: false, message: 'could not reach the ITEMS pocket' };
    }
    // DOWN past the last entry lands on CANCEL and stays there, so an overshoot
    // is walked back rather than pressed through -- the same shape `throwBall`
    // found in the ball pocket.
    for (let i = 0; i < 24 && s.curItem !== itemId; i++) {
      if (s.curItem === CANCEL) {
        await this.push('UP', 4, 8);
        await this.step(SETTLE_FRAMES);
        s = await this.snap();
        if (s.curItem === itemId) break;
        await this.closeMenus();
        return { ok: false, message: 'walked past it in the pack' };
      }
      s = await this._packMoved('DOWN', (x) => x.curItem);
    }
    if (s.curItem !== itemId) {
      await this.closeMenus();
      return { ok: false, message: 'could not find it in the pack' };
    }

    await this.push('A', 6, 10);
    await this.step(SETTLE_PACK);
    if (!this._isBox(await this.snap(), e.itemUse)) {
      await this.closeMenus();
      return { ok: false, message: 'the USE box never appeared' };
    }
    // USE is row 1 and the cursor opens on it, so this is a confirm rather than
    // a walk -- but it is asked for rather than assumed, because GIVE and TOSS
    // are the two rows under it and TOSS throws the item away.
    if (!await this._driveMenuCursor(1, 4)) {
      await this.closeMenus();
      return { ok: false, message: 'could not reach USE' };
    }
    await this.push('A', 6, 10);
    await this.step(SETTLE_PACK);
    if (!this._isBox(await this.snap(), e.partyPick)) {
      await this.closeMenus();
      return { ok: false, message: 'the party never came up' };
    }
    if (!await this._driveMenuCursor(on + 1, 6)) {
      await this.closeMenus();
      return { ok: false, message: `could not reach party slot ${on + 1}` };
    }
    await this.push('A', 6, 10);
    await this._pastTheMessage();
    await this.closeMenus();

    // **HP is the evidence; the bag is corroboration, and it lags.**
    //
    // Measured, and it cost a working heal to find out: a BERRY used on a
    // Cyndaquil at 7/23 took it to 17/23 -- ten HP, exactly a BERRY -- and
    // `wItems` still read `POTION 2, BERRY 1` forty seconds later. The removal
    // was not written back until the pack was next opened, at which point *both*
    // that BERRY and the POTION just used disappeared together.
    //
    // Which is the same warning this repository already carries about the other
    // pocket -- *wBalls does not settle until a battle ends* -- and the note
    // added one pass ago saying it settles immediately out on the map was
    // wrong. So the pocket is polled for, briefly, and its silence is reported
    // rather than believed: a heal that moved the HP is a heal.
    // **HP is not the only evidence, and assuming it was would have made every
    // cure report a failure.** An ANTIDOTE moves no HP at all: what it changes
    // is the status byte, which is the field this same pass taught the party
    // reader to look at. So the question is "did anything about that Pokemon
    // change", and there are two answers worth telling apart.
    const after = (await this._settled(itemId, had)).party[on];
    const gained = after ? after.hp - target.hp : 0;
    const had_ = target.status || [];
    const now = (after && after.status) || [];
    const cured = had_.filter((k) => !now.includes(k));
    const left = (await this.snap()).items.find(([id]) => id === itemId);
    const spentIt = !left || left[1] < had;
    if (gained > 0 || cured.length) {
      const said = [gained > 0 ? `+${gained} HP` : null,
                    cured.length ? `cured ${cured.join(', ')}` : null]
        .filter(Boolean).join(', ');
      return { ok: true, gained, cured, spent: spentIt,
               message: spentIt ? said : `${said} (the bag has not caught up)` };
    }
    // Nothing changed. Now the pocket is the question, because the two ways of
    // getting here are different states: on a Pokemon the item cannot help the
    // game takes every press, says it would have no effect and spends nothing --
    // measured -- and an item that went and did nothing is a different problem.
    return { ok: false, gained: 0, cured: [], spent: spentIt,
             message: spentIt ? 'the item was spent and nothing changed'
                              : 'it would have had no effect' };
  }

  /**
   * Wait for the pocket to be written back, and hand back a fresh snapshot.
   *
   * The pocket is the *slowest* of the three things a use changes -- measured:
   * a BERRY moved ten HP while `wItems` still listed it -- which is exactly why
   * it is the one to wait on. By the time it has caught up, the HP and the
   * status certainly have; waiting on either of those instead would return
   * early and leave `spent` reading false for an ordinary heal.
   *
   * Bounded, and it returns whatever it has rather than failing: the pocket not
   * settling is a thing to report, not a reason to stop.
   */
  async _settled(itemId, had, tries = BAG_SETTLE_TRIES) {
    let s = await this.snap();
    for (let i = 0; i < tries; i++) {
      const entry = s.items.find(([id]) => id === itemId);
      if (!entry || entry[1] < had) return s;
      await this.step(SETTLE_FRAMES);
      s = await this.snap();
    }
    return s;
  }

  /**
   * Tap through the message a heal leaves, and *only* the message.
   *
   * Not `settleText`, which taps A for as long as any window is open -- and
   * after a heal the pack is still one of those. With two Potions in the bag
   * that press lands on the next item and uses it, which is the stray-press
   * failure `watchThrow` has warned about in this file's neighbour since it was
   * written: *a stray press while the battle menu is up picks FIGHT, and the
   * next throw spends a ball the count never sees.*
   *
   * So the stopping condition is a shape rather than a flag: stop as soon as
   * the box on screen is the pack or the party list again, because those are
   * boxes to back out of and not text to advance.
   */
  async _pastTheMessage(taps = 20) {
    const e = this.state.e.field || {};
    for (let i = 0; i < taps; i++) {
      const s = await this.snap();
      if (!s.windowOpen && !s.scriptRunning) return true;
      if (this._isBox(s, e.pack) || this._isBox(s, e.partyPick)) return true;
      await this.push('A', 4, 8);
      await this.pump();
    }
    return false;
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

    // Settled first, not read raw: straight after a battle the overworld
    // reports itself absent for a moment, and refusing then means a save right
    // after a job never works.
    let s = await this.awaitQuiet();
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
      await this.step(SETTLE_FRAMES);
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
      // The recovery the paragraph above promises, which nothing was actually
      // doing. A wrong row opens the pack or the party and _trySaveRow returns
      // false with that submenu still on screen -- and _openStartMenu cannot
      // tell a submenu from the START menu, because all it asks is whether
      // *some* cursor is non-zero. So the next row was driven blind through
      // whatever the last one left open: DOWN moved a cursor in the pack's
      // USE / GIVE / TOSS box rather than in the START menu, and the A behind
      // it answered that.
      await this.closeMenus(4);
      await this.step(SETTLE_FRAMES);
    }
    return false;
  }

  async _trySaveRow(row, count) {
    if (!await this._openStartMenu()) return false;
    if (!await this._driveMenuCursor(row, count)) return false;

    await this.push('A', 5, 10);
    await this.step(SAVE_PROMPT_FRAMES);

    // "Would you like to save the game?" -- YES is preselected, and the box is
    // not interactive the moment it appears. Waiting for its cursor is the
    // same lesson the nickname box taught: an A pressed too early is swallowed
    // and the next one answers something else.
    for (let i = 0; i < SAVE_CONFIRM_TRIES; i++) {
      if (await this.menuCursor() === 1) break;
      await this.step(6);
    }
    await this.push('A', 5, 10);
    await this.settleText();

    // Back in the world with no window open is what a finished save looks like.
    const s = await this.snap();
    return s.worldLoaded && !s.windowOpen && !s.inBattle;
  }

  /**
   * Open the START menu and confirm it really opened.
   *
   * "Really" is doing less work than it looks: this asks whether a cursor is
   * live, not whether it is the START menu's. Nothing in memory distinguishes
   * them the way wMenuDataItems distinguishes the battle menu, so the honest
   * guard is the caller's -- _saveOnce closes whatever a failed row opened
   * before trying the next, and _menuRowCount bails if the player turns out to
   * be walking, which is what "no menu at all" looks like from here.
   */
  async _openStartMenu(tries = 3) {
    for (let attempt = 0; attempt < tries; attempt++) {
      // Nothing is pressed if a window is already up, and that is not a saved
      // press -- it is a wrong state avoided. START *toggles* this menu:
      // measured on the cartridge, the window stack goes 0, 1, 0, 1 across
      // three presses. And `_saveOnce` reaches here with the menu already open,
      // because it opens it, counts its rows, and then calls `_trySaveRow`,
      // which calls this. So the press closed the very menu that had just been
      // counted; the poll below then read a zero cursor for all of its tries,
      // and the *next* attempt pressed START again and re-opened it. It came
      // out right, by timing out, which is not the same as being right.
      //
      // `windowOpen` rather than the cursor, because it is the signal state.js
      // calls reliable -- and because the question here is only "is something
      // open", which is exactly what it answers.
      if ((await this.snap()).windowOpen) return true;
      await this.push('START', 5, 10);
      for (let i = 0; i < MENU_OPEN_TRIES; i++) {
        await this.step(6);
        if (await this.menuCursor() !== 0) return true;
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
      const cur = await this.menuCursor();
      if (seen.includes(cur)) break;
      seen.push(cur);
      await this.push('DOWN', 5, 8);
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
      if (await this.menuCursor() === target) return true;
      await this.push('DOWN', 5, 8);
    }
    return await this.menuCursor() === target;
  }

  /**
   * From the title screen to the world, by way of CONTINUE.
   *
   * Used after a slot is installed: loading a battery re-loads the ROM, so the
   * game restarts and the save has to be picked up the way a person picks it
   * up. START opens the title menu, A takes CONTINUE (which is the top entry
   * whenever save data exists), and the alternation covers both the press that
   * opens the menu and the ones that answer the "saved on" panel behind it.
   */
  async continueFromTitle(rounds = 24) {
    for (let i = 0; i < rounds && !this.cancelled; i++) {
      const s = await this.snap();
      if (s.worldLoaded) return true;
      await this.push(i % 2 === 0 ? 'START' : 'A', 6, 12);
      await this.step(90);
    }
    return (await this.snap()).worldLoaded;
  }

  /**
   * Can the game be saved right now?
   *
   * Saving drives the START menu, which does not open in a battle or while a
   * script is running. Exposed because the pilot's undo point is a save, so
   * whether one can be taken has to be answerable *before* a task starts --
   * and for the two commands that run inside a battle the answer is no.
   */
  async canSave() {
    const s = await this.awaitQuiet();
    if (s.inBattle) return { ok: false, why: 'a battle is in progress' };
    if (!s.worldLoaded) return { ok: false, why: 'no game is running' };
    if (s.scriptRunning) return { ok: false, why: 'the screen is busy' };
    return { ok: true };
  }
  };
}
