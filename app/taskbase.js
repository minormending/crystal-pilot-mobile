// What every group of tasks shares: the emulator handle, the snapshot, and the
// small courtesies of driving a game that is not waiting for you.
//
// Split out of tasks.js, which had grown to 1335 lines and thirty-seven methods
// across five unrelated jobs. The split is by what a method is *about*, not by
// size: this file is about the machine, menus.js about the game's own menus,
// battle.js about a turn, and jobs.js about the things a person asks for. The
// pieces are mixins rather than collaborators so that `this` keeps meaning the
// same object -- the alternative was several hundred lines of delegation whose
// only purpose would be to look like a refactor.
// Polls waiting for the overworld to settle after a battle or a script. Sixty
// was not enough: starting a job straight after another one found a script
// still running and gave up, and the job then ran with no undo point. The wait
// is cheap -- it ends the moment the game is quiet -- so the budget is set by
// the worst case worth surviving rather than the common one.
export const QUIET_TRIES = 250;
// Long enough for the pack to write wCurItem for the pocket now showing.
export const SETTLE_FRAMES = 20;

export class TaskBase {
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

  say(msg) { this.onProgress(msg); }

  async closeMenus(times = 4) {
    for (let i = 0; i < times; i++) await this.gb.press('B', 5, 10);
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
   * Wait for the overworld to be standing still, and report where it got to.
   *
   * Needed because "is there a game running?" is briefly false at moments when
   * there obviously is one. A battle does not hand control straight back: for a
   * short while afterwards wMapStatus reads 1 rather than 2 and a script is
   * still running, while the map and the party read correctly the whole time.
   *
   * Measured, and it cost a working feature to find: an undo point taken right
   * after a grind refused itself with "no game is running", because the check
   * ran during that transient and took the answer at face value. Anything that
   * asks whether the game can be saved has to let it settle first.
   */
  async awaitQuiet(tries = QUIET_TRIES) {
    let s = await this.snap();
    for (let i = 0; i < tries; i++) {
      if (s.worldLoaded && !s.scriptRunning && !s.inBattle) return s;
      await this.gb.run(SETTLE_FRAMES);
      s = await this.snap();
    }
    return s;
  }

  /**
   * The menu window, as one small read.
   *
   * state.js works out the few bytes that answer "which menu is this, and where
   * is its cursor" and keeps them as one contiguous window, so asking costs a
   * handful of bytes rather than the eight kilobytes a full snapshot copies.
   * This exists because the two-line incantation for it appeared five times.
   */
  async menuWindow() {
    return this.gb.readBytes(this.state.menuWindow.addr, this.state.menuWindow.len);
  }

  /** Where the cursor is in whatever menu is drawn, or 0 if none is. */
  async menuCursor() {
    return this.state.menuCursorY(await this.menuWindow());
  }
}
