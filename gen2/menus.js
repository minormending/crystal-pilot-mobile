// The game's own menus: the intro, the START menu, and saving.
//
// Driving a menu means reading the cursor and stepping it, never counting
// presses from an assumed origin -- the cursor persists between openings, so
// an assumed origin is wrong exactly when it matters.
import { SETTLE_FRAMES } from '../gbcore/taskbase.js';
// Times to try the whole START -> SAVE -> YES flow before giving up.
const SAVE_ATTEMPTS = 3;
// Frames for the save prompt to appear after SAVE is chosen.
const SAVE_PROMPT_FRAMES = 40;
// Polls waiting for the confirm box to become interactive.
const SAVE_CONFIRM_TRIES = 60;
// Polls waiting for the START menu's cursor to appear.
const MENU_OPEN_TRIES = 25;

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
