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
// How many settles to wait for an expected box. Generous: a box that is going
// to appear appears within a few, and one that is not costs a few frames.
const BOX_TRIES = 8;
// How patiently to wait after each A when pressing toward a box. Small, because
// this is inside a loop that will press again -- the waiting is only to avoid
// pressing into a box that is arriving.
const PRESS_SETTLES = 3;
// How many times to re-press a menu direction that did not move the cursor.
// Three, because the press that gets dropped is the first one -- the menu is
// not interactive the instant a cursor reads non-zero -- and by the second the
// box has always been up.
const MENU_STEP_TRIES = 3;
// The words this walk drives to live in the engine profile, as `menuWords`
// -- one list per row, because a hack that renamed the START menu has
// renamed it and there is nothing to do about that but know its word.
// Polished Crystal's reads Bag, Save, Options, Quit. `check-app phrases`
// holds every list to the cartridge either way.

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
   * Wait for a particular box to be the one on screen.
   *
   * One sample is not enough, and that is measured rather than cautious: the
   * mart's quantity box reads `4/15` when it has settled and **`4/0` while it
   * is being redrawn**, so a check that looked once landed on the transient
   * shape, decided the box was wrong, and reported *bought nothing* from inside
   * a working shop. The first probe of the sequence caught that frame and the
   * second did not, which is exactly what a race looks like in a log.
   *
   * Which makes this the third place in this app to need the same rule --
   * `_packMoved` and `_openBattlePack` are the others. Press, then *wait for
   * what you expected*, rather than pressing and looking.
   */
  async _awaitBox(shape, tries = BOX_TRIES) {
    for (let i = 0; i < tries; i++) {
      if (this._isBox(await this.snap(), shape)) return true;
      await this.step(SETTLE_FRAMES);
    }
    return this._isBox(await this.snap(), shape);
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
  /**
   * Put the Pokemon in `slot` at the front of the party.
   *
   * **Gen 2 sends out slot one and asks nobody.** So walking into a Gym with
   * the wrong Pokemon in front is a battle lost before the door closes -- and
   * since the pass before, the pilot has known what is in the room and could
   * only *say* so. Four presses fix it.
   *
   * Two things about the screens make this different from every other menu
   * walk in this file.
   *
   * **The submenu's shape is built at run time.** `MonSubmenu`'s header has
   * its data pointer filled in by `PopulateMonMenu`, and its top coordinate
   * computed by `MonSubmenu.GetTopCoord`, because which options it holds
   * depends on the Pokemon -- a MON that knows CUT gets a CUT row. So there
   * is no signature to match, and reading the *word* is the only way. Which
   * is what `_driveToSaying` was written for.
   *
   * **And the word is in a different place than in a battle.** The field
   * menu's options begin STATS, SWITCH; the battle one begins SWITCH, STATS.
   * They are opposite -- see `switchBox` in engine.js -- so a press count
   * carried over from the battle version opens a stats screen out here.
   *
   * The evidence is the party *order*, not the presses: species, level and HP
   * of the front slot all matching what was in `slot` before. Two identical
   * Pokemon at identical HP cannot be told apart that way, and that is
   * reported as a failure rather than as a swap that happened -- a reorder
   * nobody can see is not evidence of one.
   */
  async leadWith(slot) {
    const before = await this.snap();
    const want = before.party[slot];
    if (!slot || !want) return { ok: false, message: 'no such party slot' };
    if (!(want.hp > 0)) {
      return { ok: false, message: 'that one is fainted, so it cannot lead' };
    }
    const same = (a, b) => !!a && !!b && a.species === b.species
      && a.level === b.level && a.hp === b.hp;
    if (before.party.filter((m) => same(m, want)).length > 1) {
      return { ok: false,
               message: 'two of those are identical, so a swap would not show' };
    }

    if (!await this._openStartMenu()) {
      return { ok: false, message: 'the menu would not open' };
    }
    const words = this.state.e.menuWords;
    if (!await this._driveToSaying(words.party)) {
      await this.closeMenus();
      return { ok: false, message: `no row says ${words.party[0]}` };
    }
    await this.push('A', 6, 10);
    await this.step(SETTLE_PACK);
    const e = this.state.e;
    if (!await this._awaitBox(e.field && e.field.partyPick)) {
      await this.closeMenus();
      return { ok: false, message: 'the party never came up' };
    }
    if (!await this._driveMenuCursor(slot + 1, e.maxParty)) {
      await this.closeMenus();
      return { ok: false, message: `could not reach party slot ${slot + 1}` };
    }
    await this.push('A', 6, 10);
    await this.step(SETTLE_PACK);
    // The submenu, by its word rather than its shape.
    if (!await this._driveToSaying(this.state.e.menuWords.switch)) {
      await this.closeMenus();
      return { ok: false, message: `no row says ${this.state.e.menuWords.switch[0]}` };
    }
    await this.push('A', 6, 10);
    await this.step(SETTLE_PACK);
    // "Move to where?" -- the party list again, and the front slot is the
    // answer. Driven rather than assumed: the cursor is left on the Pokemon
    // that was picked, which is not row one unless slot one was picked.
    if (!await this._driveMenuCursor(1, e.maxParty)) {
      await this.closeMenus();
      return { ok: false, message: 'could not reach the front of the party' };
    }
    await this.push('A', 6, 10);
    await this.step(SETTLE_PACK);
    await this.closeMenus();

    const after = await this.snap();
    if (!same(after.party[0], want)) {
      return { ok: false, message: 'the party order did not change' };
    }
    return { ok: true, message: `moved slot ${slot + 1} to the front` };
  }

  async _openPack(tries = 8) {
    if (!await this._openStartMenu()) return false;
    const shape = this.state.e.field && this.state.e.field.pack;
    // Ask the screen first. PACK is the row that says PACK, which is a fact
    // about the menu rather than about how far the game has got -- and the
    // shape is still checked afterwards, because a row that says the right
    // thing and opens the wrong box is exactly the kind of thing this app
    // stopped believing several passes ago.
    if (await this._driveToSaying(this.state.e.menuWords.pack)) {
      await this.push('A', 6, 10);
      await this.step(SETTLE_PACK);
      if (this._isBox(await this.snap(), shape)) return true;
      await this.closeMenus();
      if (!await this._openStartMenu()) return false;
    }
    const count = await this._menuRowCount();
    if (!count) return false;
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
      return { ok: false, message: await this.saying('could not open the pack') };
    }
    // The pack remembers which pocket it was left in, so this is a walk to the
    // right one rather than an assumption about where it opens.
    let s = await this.snap();
    for (let i = 0; i < 8 && s.curPocket !== this.state.e.itemPocket; i++) {
      s = await this._packMoved('RIGHT', (x) => x.curPocket);
    }
    if (s.curPocket !== this.state.e.itemPocket) {
      await this.closeMenus();
      return { ok: false,
               message: await this.saying('could not reach the ITEMS pocket') };
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
      return { ok: false,
               message: await this.saying('could not find it in the pack') };
    }

    await this.push('A', 6, 10);
    if (!await this._awaitBox(e.itemUse)) {
      await this.closeMenus();
      return { ok: false,
               message: await this.saying('the USE box never appeared') };
    }
    // USE is row 1 and the cursor opens on it, so this is a confirm rather than
    // a walk -- but it is asked for rather than assumed, because GIVE and TOSS
    // are the two rows under it and TOSS throws the item away.
    if (!await this._driveMenuCursor(1, 4)) {
      await this.closeMenus();
      return { ok: false, message: await this.saying('could not reach USE') };
    }
    await this.push('A', 6, 10);
    if (!await this._awaitBox(e.partyPick)) {
      await this.closeMenus();
      return { ok: false,
               message: await this.saying('the party never came up') };
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
   * Buy `count` of an item from the clerk you are standing in front of.
   *
   * Five boxes, every one confirmed by its shape before anything is pressed
   * into it, and the whole sequence measured in Cherrygrove's Mart -- buying two
   * POTIONs at 300 each and watching the money fall 3000 to 2700 to 2400 while
   * the pocket went one to two to three.
   *
   * **The money is the evidence.** Not the presses landing, and not the pocket:
   * the pocket lags a *use* (see `useItemOn`) and there is no reason to think a
   * purchase is different, while the money moved on the same read as the item
   * arriving in every measurement taken. So the answer is what it spent.
   *
   * One press at a time rather than a quantity, deliberately. The `howMany` box
   * takes UP to raise the count, and getting that wrong buys ninety-nine of
   * something -- whereas repeating a confirmed one-item purchase costs a few
   * frames and cannot overshoot.
   */
  async buyFromClerk(itemId, count = 1) {
    const e = this.state.e.shop || {};
    const before = await this.snap();
    const startMoney = before.money;
    let bought = 0, spent = 0;

    // The clerk's greeting is text; the menu is behind it.
    if (!await this._pressUntilBox(e.menu)) {
      await this.closeConversation();
      return { ok: false, bought: 0, spent: 0, message: 'the clerk never offered a menu' };
    }
    // BUY is row 1 of three, and the cursor opens on it -- asked for rather
    // than assumed, because SELL is the row under it.
    if (!await this._driveMenuCursor(1, 3)) {
      await this.closeConversation();
      return { ok: false, bought: 0, spent: 0,
               message: await this.saying('could not reach BUY') };
    }
    await this.push('A', 6, 10);
    if (!await this._awaitBox(e.list)) {
      await this.closeConversation();
      return { ok: false, bought: 0, spent: 0, message: 'the mart never showed its stock' };
    }

    for (let n = 0; n < count; n++) {
      // Pressed toward, not waited for. The way *back* to the stock list is
      // two text boxes rather than one -- the price line and the thanks -- so
      // waiting for the list without pressing through them times out, and
      // pressing once and then waiting stops one box short. Either way the job
      // buys one of four and says so honestly, which is the worst kind of
      // wrong: nothing looks broken.
      if (!await this._pressUntilBox(e.list)) break;
      let s = await this.snap();
      // The stock list is walked by `wCurItem`, the same way the pack is, and
      // it does not wrap either -- so an overshoot is walked back.
      for (let i = 0; i < 24 && s.curItem !== itemId; i++) {
        if (s.curItem === CANCEL) {
          await this.push('UP', 4, 8);
          await this.step(SETTLE_FRAMES);
          s = await this.snap();
          if (s.curItem === itemId) break;
          await this.closeConversation();
          return { ok: bought > 0, bought, spent,
                   message: `the mart does not stock that (bought ${bought})` };
        }
        s = await this._packMoved('DOWN', (x) => x.curItem);
      }
      if (s.curItem !== itemId) break;
      const had = s.money;
      await this.push('A', 6, 10);          // pick it
      if (!await this._awaitBox(e.howMany)) break;
      await this.push('A', 6, 10);          // one of them
      if (!await this._awaitBox(e.confirm)) break;
      // YES is row 1 and the cursor opens on it; NO is the row under.
      if (!await this._driveMenuCursor(1, 2)) break;
      await this.push('A', 6, 10);
      await this.step(SETTLE_PACK);
      const now = await this.snap();
      if (now.money >= had) {
        // Nothing was spent. Either it could not be afforded or the press went
        // somewhere else, and both are reasons to stop rather than press on.
        await this.closeConversation();
        return { ok: bought > 0, bought, spent,
                 message: bought ? `bought ${bought}, then could not afford another`
                                 : 'could not afford it' };
      }
      bought++;
      spent += had - now.money;
      // The text after a purchase is the top of this loop's business, because
      // it does not know how many boxes it is.
    }

    // The *conversation*, not the box. A clerk whose boxes are closed puts
    // another one up a moment later, and the pilot left standing in front of it
    // buys a Poké Ball every time a later job presses A through text -- measured,
    // the wallet went 3000 to 100 that way. See `closeConversation`.
    await this.closeConversation();
    const end = await this.snap();
    return {
      ok: bought > 0,
      bought,
      spent: startMoney - end.money,
      message: bought
        ? `bought ${bought} for ${startMoney - end.money}`
        : 'bought nothing',
    };
  }

  /**
   * Press A until a particular box is the one on screen.
   *
   * Not `settleText`: that stops when no window is open, and a menu *is* a
   * window -- so it would stop before the text had finished and leave the
   * caller pressing into whatever came next. It stops on the shape it is
   * waiting for, the same rule `_pastTheMessage` follows one feature over.
   *
   * Written for the clerk's greeting and needed twice, which is the useful
   * part: **a purchase is followed by two text boxes, not one.** Measured --
   * confirm, A, the price line, A, the thanks, A, and only then the stock list
   * again. Pressing once and waiting for the list bought exactly one of four
   * items and reported it honestly, which is a job doing a quarter of its work
   * without anything looking wrong.
   */
  async _pressUntilBox(shape, taps = 12) {
    for (let i = 0; i < taps; i++) {
      // Waited for after every press, not merely looked at. Otherwise a press
      // lands *into* the box being waited for while it is still redrawing --
      // which in a stock list picks an item, and is how a patient loop turns
      // into a shopping spree. The fake that models the redraw caught this
      // before the cartridge did, which is the first time round here that the
      // test found the hazard rather than recording it.
      if (await this._awaitBox(shape, PRESS_SETTLES)) return true;
      await this.push('A', 6, 12);
    }
    return this._isBox(await this.snap(), shape);
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

    // The screen knows which row says SAVE, and that is worth asking before
    // any counting: it is right whether or not the POKeDEX row exists yet, and
    // it does not care that the menu grows. The count below is kept for the
    // cartridge whose symbol file does not name the tilemap -- and for the day
    // this reads the word and the row turns out to open something else.
    if (await this._trySaveByName()) return true;
    await this.closeMenus(4);
    await this.step(SETTLE_FRAMES);
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
    return this._confirmSave();
  }

  /** The row that says SAVE, wherever the menu has put it. */
  async _trySaveByName() {
    if (!await this._openStartMenu()) return false;
    if (!await this._driveToSaying(this.state.e.menuWords.save)) return false;
    return this._confirmSave();
  }

  /** Press A on whatever SAVE row is selected, and answer the box behind it. */
  async _confirmSave() {
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
   *
   * **A swallowed press used to read as a one-row menu**, and this is the
   * primitive two features stand on. It pressed DOWN and looked once: the menu
   * is not interactive the instant `_openStartMenu` sees a live cursor, so the
   * first press is the likeliest of the lot to be dropped -- and a dropped
   * press leaves the cursor where it was, which this read as the wrap. One row.
   * `_openPack` then tried row 1 only and reported *the pack never opened*, and
   * `saveGame` tried row 1 only and could not find SAVE, both from a menu that
   * was working perfectly.
   *
   * So it presses and *waits for the cursor to move*, and only calls it a wrap
   * when the value it moved to is one already seen. Which is `_packMoved`'s
   * lesson from the eleventh pass, arriving in its fifth caller and its first
   * counting one.
   */
  async _menuRowCount(limit = 12) {
    const start = (await this.snap()).pos;
    const seen = [];
    let cur = await this.menuCursor();
    const walkedOff = async () => {
      const now = (await this.snap()).pos;
      if (now[0] === start[0] && now[1] === start[1]) return false;
      this.say('the START menu was not open — the player moved');
      return true;
    };
    for (let i = 0; i < limit; i++) {
      if (seen.includes(cur)) break;
      seen.push(cur);
      let moved = null;
      for (let go = 0; go < MENU_STEP_TRIES && moved === null; go++) {
        const s = await this._packMoved('DOWN', (x) => x.menu[1]);
        if (await walkedOff()) return 0;
        if (s.menu[1] !== cur) moved = s.menu[1];
      }
      // Genuinely will not move. A one-row menu is a real thing, so this is a
      // count rather than a failure -- and it is now reached only after the
      // press has been given several goes.
      if (moved === null) break;
      cur = moved;
    }
    return seen.length ? Math.max(...seen) : 0;
  }

  /**
   * Press a direction and wait for the *drawn* arrow to move.
   *
   * The generalisation of `_packMoved` to every box there is, and the reason
   * this pass exists. `_packMoved` waits on a variable, which works for the
   * pack because the pack keeps its index in one. Measured on the bedroom PC's
   * BILL'S-PC submenu, eight DOWN presses over six hundred frames moved
   * `wMenuCursorY` not at all -- a work-RAM diff across a press turned up
   * thirty-seven changed bytes, every one of them in the sprite buffer, and the
   * only named change was the game clock. That box keeps its selection
   * somewhere this app cannot find.
   *
   * The arrow is *drawn*, so it is in the tilemap whatever the box does with
   * its bookkeeping -- and it is what a person is looking at. Measured against
   * a box that does keep a variable, the two agree exactly: the arrow sat at
   * tilemap rows 2, 4, 6, 8, 10 as the cursor read 1 through 5.
   *
   * False where the screen cannot be read at all, which a caller must treat as
   * "cannot tell" and not as "the arrow will not move".
   */
  async _arrowMoved(button = 'DOWN', tries = MENU_STEP_TRIES) {
    const where = async () => {
      const sc = await this.screen();
      if (!sc) return null;
      const a = sc.arrow();
      return a ? `${a.row},${a.col}` : '-';
    };
    const before = await where();
    if (before === null) return false;
    for (let go = 0; go < tries; go++) {
      await this.push(button, 4, 8);
      for (let i = 0; i < BOX_TRIES; i++) {
        await this.step(SETTLE_FRAMES);
        if (await where() !== before) return true;
      }
    }
    return false;
  }

  /**
   * Drive a menu's cursor to the row that *says* something.
   *
   * The row a thing sits on is not a fact about the game; the words on it are.
   * The START menu grows -- no POKeDEX or POKeGEAR early on -- which is why
   * `_openPack` opened rows one at a time asking each time whether the pack had
   * appeared, and why `saveGame` counts SAVE from the bottom. Measured after
   * the errand, the menu reads POKeDEX, POKeMON, PACK, POKeGEAR, CHRIS, SAVE,
   * OPTION, EXIT -- eight rows, and PACK is the row that says PACK.
   *
   * Folded to letters and digits before matching, because the screen is not a
   * string: POKeDEX draws its accented letter as a tile this charmap does not
   * name, and POKeGEAR's logo is drawn as graphics entirely.
   *
   * False also means "could not read the screen", which is why every caller
   * keeps the search it had.
   */
  async _driveToSaying(words, tries = 12) {
    // One word or several: a row a cartridge might call more than one thing.
    const want = Array.isArray(words) ? words : [words];
    for (let i = 0; i < tries; i++) {
      const sc = await this.screen();
      // No arrow means no menu to drive, and pressing anyway is how this would
      // do harm: DOWN in an overworld is a step into the grass. So a screen
      // with nothing selected is "cannot tell" and costs no presses at all --
      // which is also what a cartridge whose tilemap cannot be read looks like.
      if (!sc || !sc.arrow()) return false;
      if (want.some((w) => sc.selectedSays(w))) return true;
      if (!await this._arrowMoved()) return false;
    }
    return false;
  }

  /**
   * Walk the cursor to a row, downwards or upwards.
   *
   * **It only pressed DOWN**, which worked everywhere it was used because
   * every one of those screens opens at row one and the target is below. The
   * party menu's second visit is not one of those: after SWITCH the cursor is
   * left on the Pokemon that was picked, and the answer to "move to where?"
   * is row one -- *above* it. Down-only reaches that by wrapping, if the list
   * wraps, and by running out of presses if it does not.
   *
   * Pressing towards the target is strictly fewer presses either way, and it
   * cannot change what the older callers do: they are already below their
   * target, so the direction chosen for them is the one they had.
   */
  async _driveMenuCursor(target, count) {
    for (let i = 0; i < count + 2; i++) {
      const at = await this.menuCursor();
      if (at === target) return true;
      await this.push(at > target ? 'UP' : 'DOWN', 5, 8);
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
