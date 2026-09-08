// Driving the game's own menus.
//
// menus.js had no tests, and it is the module that saves your game. The parts
// that need a real screen cannot be tested here; the order of operations can,
// and that is where the fault was.
import { FakeGameBoy, fakeRom, paintScreen, symbols, test,
         worldRam } from '../harness.mjs';
import { GameState } from '../../gen2/state.js';
import { Tasks } from '../../gen2/tasks.js';

function pilot() {
  const sym = symbols();
  const state = new GameState(sym);
  const gb = new FakeGameBoy({ wram: worldRam(sym, {}) });
  return { tasks: new Tasks(gb, state, () => {}, fakeRom()) };
}

/** A pilot whose menu machinery is scripted, so only the ordering is under test. */
function saving({ rowThatWorks = null, rows = 8 } = {}) {
  const { tasks } = pilot();
  const log = [];
  tasks.closeMenus = async () => { log.push('close'); };
  tasks.step = async () => {};
  tasks._openStartMenu = async () => true;
  tasks._menuRowCount = async () => rows;
  tasks._trySaveRow = async (row) => {
    log.push(`row ${row}`);
    return row === rowThatWorks;
  };
  return { tasks, log };
}

test('SAVE is tried first, at two rows from the bottom', async (t) => {
  // The last three rows are always SAVE, OPTION, EXIT, whether or not the
  // POKeDEX row exists yet -- so counting from the bottom is what survives the
  // menu growing.
  const { tasks, log } = saving({ rows: 8, rowThatWorks: 6 });
  t.true(await tasks._saveOnce(), 'it saved');
  t.eq(log.filter((l) => l.startsWith('row')), ['row 6'], 'first guess, no others');
});

test('a wrong row is closed before the next one is tried', async (t) => {
  // The comment always said a wrong guess "opens the pack or the party, which
  // is recoverable". Nothing performed the recovery. _openStartMenu cannot tell
  // a submenu from the START menu -- it only asks whether *some* cursor is
  // live -- so the next row was driven blind through whatever the last one had
  // left open, moving a cursor in the pack's USE / GIVE / TOSS box.
  const { tasks, log } = saving({ rows: 8, rowThatWorks: null });
  t.false(await tasks._saveOnce(), 'nothing saved');
  const rows = log.filter((l) => l.startsWith('row'));
  t.eq(rows.length, 8, 'every row was tried');
  for (let i = 0; i < log.length - 1; i++) {
    if (log[i].startsWith('row')) {
      t.eq(log[i + 1], 'close', `${log[i]} was cleared before the next`);
    }
  }
});

test('a menu that will not open is not pressed into', async (t) => {
  const { tasks, log } = saving();
  tasks._openStartMenu = async () => false;
  t.false(await tasks._saveOnce(), 'it gives up');
  t.eq(log.filter((l) => l.startsWith('row')).length, 0, 'without pressing a row');
});

test('a row count that says the menu never opened stops the attempt', async (t) => {
  // _menuRowCount returns 0 when the player moved, which means those presses
  // were walking through grass rather than driving a menu.
  const { tasks, log } = saving();
  tasks._menuRowCount = async () => 0;
  t.false(await tasks._saveOnce(), 'it gives up');
  t.eq(log.filter((l) => l.startsWith('row')).length, 0, 'and presses nothing');
});

// --- a START menu that behaves like the cartridge's -------------------------
//
// Everything above stubs the menu machinery out and tests only the order the
// rows are tried in. That left the code that actually drives the menu -- opens
// it, counts its rows, walks its cursor -- never run by anything: measured with
// V8 coverage, menus.js was the least-covered module in the app at 16%, which
// is an uncomfortable place for the module that saves your game.
//
// The model below is not invented. Every rule in it was measured against the
// real cartridge in Elm's lab, because a first attempt at this test guessed and
// guessed wrong:
//
//   START toggles          window stack 0, 1, 0, 1 across three presses
//   the cursor is 0        whenever nothing is open, not a stale row
//   re-opening resets      left on row 3, 6 or 2, it came back on row 1 each time
//   six rows, not eight    early on there is no POKeDEX or POKeGEAR
/**
 * `swallow` drops that many of the first DOWN presses, which is what the
 * cartridge does while the box is still being drawn: `_openStartMenu` returns
 * as soon as a cursor reads non-zero, and the menu is not interactive yet.
 */
/**
 * A menu that draws itself, and keeps its selection nowhere this app can read.
 *
 * Which is a real box, measured: the bedroom PC's BILL'S-PC submenu took eight
 * DOWN presses over six hundred frames without `wMenuCursorY` moving once. The
 * arrow moved every time, because the arrow is drawn.
 */
function drawnMenu({ items = ['POKEDEX', 'POKEMON', 'PACK', 'SAVE'],
                     tracksCursor = false, swallow = 0 } = {}) {
  const sym = symbols();
  const state = new GameState(sym);
  const wram = worldRam(sym, { pos: [5, 5] });
  const at = (name) => sym.addr(name) - 0xc000;
  const world = { row: 0, presses: 0 };
  const draw = () => {
    const lines = ['', ...items.map((it, i) =>
      `${i === world.row ? '>' : ' '}${it}`)];
    paintScreen(wram, sym, lines);
    wram[at('wWindowStackSize')] = 1;
    wram[at('wMenuCursorY')] = tracksCursor ? world.row + 1 : 1;
  };
  draw();
  const gb = new FakeGameBoy({
    wram,
    onPress: (button) => {
      world.presses++;
      if (button === 'DOWN') {
        if (swallow > 0) { swallow--; return; }
        world.row = (world.row + 1) % items.length;
      }
      draw();
    },
  });
  return { tasks: new Tasks(gb, state, () => {}, fakeRom()), world };
}

function cartridgeMenu({ rows = 6, saveRow = 4, startOpen = false,
                         swallow = 0 } = {}) {
  const sym = symbols();
  const state = new GameState(sym);
  const wram = worldRam(sym, { pos: [5, 5] });
  const at = (name) => sym.addr(name) - 0xc000;
  const world = { open: startOpen, cursor: startOpen ? 1 : 0, confirm: false,
                  saved: false, walked: 0, starts: 0 };
  const write = () => {
    const up = world.open || world.confirm;
    wram[at('wMenuCursorY')] = up ? world.cursor : 0;
    wram[at('wWindowStackSize')] = up ? 1 : 0;
  };
  write();
  const gb = new FakeGameBoy({
    wram,
    onPress: (button) => {
      if (button === 'START') {
        world.starts++;
        world.open = !world.open;
        world.cursor = world.open ? 1 : 0;      // always re-opens on row 1
      } else if (button === 'B') {
        world.open = false; world.confirm = false; world.cursor = 0;
      } else if (button === 'DOWN') {
        if (swallow > 0) { swallow--; write(); return; }
        if (world.open) world.cursor = (world.cursor % rows) + 1;
        else { world.walked++; wram[at('wYCoord')] += 1; }   // the player walks
      } else if (button === 'A') {
        if (world.confirm) { world.saved = true; world.confirm = false; }
        else if (world.open && world.cursor === saveRow) {
          world.open = false; world.confirm = true; world.cursor = 1;
        } else if (world.open) { world.open = false; world.cursor = 0; }
      }
      write();
    },
  });
  return { tasks: new Tasks(gb, state, () => {}, fakeRom()), gb, world };
}

test('a menu that is already open is not pressed shut again', async (t) => {
  // START toggles, and _saveOnce arrives here with the menu open -- it opened
  // it, counted its rows, and then calls _trySaveRow, which calls this. The
  // press used to close the very menu that had just been counted, and the flow
  // recovered by polling a zero cursor to exhaustion and pressing START again.
  // Recovering by timing out is not the same as being right.
  const { tasks, world } = cartridgeMenu({ startOpen: true });
  t.true(await tasks._openStartMenu(), 'it reports the menu is open');
  t.true(world.open, 'and it still is');
  t.eq(world.starts, 0, 'nothing was pressed to find that out');
});

test('a menu that is shut is opened', async (t) => {
  const { tasks, world } = cartridgeMenu({ startOpen: false });
  t.true(await tasks._openStartMenu(), 'it opens');
  t.true(world.open, 'and the menu really is open');
  t.eq(world.starts, 1, 'on one press');
});

test('the row count refuses a menu that never opened', async (t) => {
  // The guard that works, and the shape the rest of the flow leans on: DOWN in
  // an overworld is a step, not a cursor move, and walking into grass while
  // trying to save is how a save becomes a battle.
  const { tasks, world } = cartridgeMenu({ startOpen: false });
  t.eq(await tasks._menuRowCount(), 0, 'it reports no menu');
  t.eq(world.walked, 1, 'after a single step, not a walk across the map');
});

test('an open menu is counted, and the count is its last row', async (t) => {
  const { tasks } = cartridgeMenu({ rows: 6, startOpen: true });
  t.eq(await tasks._menuRowCount(), 6, 'six rows, as measured early in the game');
  const { tasks: grown } = cartridgeMenu({ rows: 8, startOpen: true });
  t.eq(await grown._menuRowCount(), 8, 'and eight once the menu has grown');
});

test('a swallowed first press is not a one-row menu', async (t) => {
  // The defect this closes, in the primitive two features stand on. It pressed
  // DOWN and looked once -- and the menu is not interactive the instant
  // `_openStartMenu` sees a live cursor, so the first press is the likeliest of
  // the lot to be dropped. A dropped press leaves the cursor where it was,
  // which read as the wrap: one row. `_openPack` then tried row 1 only and
  // reported *the pack never opened*; `saveGame` tried row 1 only and could not
  // find SAVE. Both from a menu that was working perfectly.
  const { tasks } = cartridgeMenu({ rows: 7, startOpen: true, swallow: 1 });
  t.eq(await tasks._menuRowCount(), 7, 'all seven rows, first press dropped');

  const { tasks: worse } = cartridgeMenu({ rows: 7, startOpen: true, swallow: 2 });
  t.eq(await worse._menuRowCount(), 7, 'and two dropped');
});

test('a menu that really has one row is counted as one', async (t) => {
  // The other half, and the reason this is a count rather than a retry loop
  // that gives up: a one-row menu is a real thing, and it is reached only after
  // the press has been given several goes.
  const { tasks } = cartridgeMenu({ rows: 1, startOpen: true });
  t.eq(await tasks._menuRowCount(), 1, 'one row, and no waiting for ever');
});

test('the cursor is driven to the row asked for, and says so if it cannot',
     async (t) => {
  const { tasks, world } = cartridgeMenu({ rows: 6, startOpen: true });
  t.true(await tasks._driveMenuCursor(4, 6), 'it reaches row 4');
  t.eq(world.cursor, 4, 'and the cursor is actually there');
  const { tasks: shut, world: w2 } = cartridgeMenu({ startOpen: false });
  t.false(await shut._driveMenuCursor(4, 6), 'a shut menu cannot be driven');
  t.gte(w2.walked, 1, 'though the presses do land somewhere — hence the guard above');
});

test('the whole flow saves, through the real menu code', async (t) => {
  // End to end with nothing stubbed but the battery: open, count, pick SAVE at
  // two rows from the bottom, answer the confirm box.
  const { tasks, world } = cartridgeMenu({ rows: 6, saveRow: 4, startOpen: false });
  t.true(await tasks._saveOnce(), 'it believes it saved');
  t.true(world.saved, 'and the confirm box was actually answered');
  t.eq(world.walked, 0, 'without ever walking the player');
});

// --- using an item out of the pack -------------------------------------------

const POTION = 18, BERRY = 154;

/**
 * A pilot whose pack is a scripted state machine.
 *
 * The four boxes between the START menu and a healed Pokémon are matched on
 * shape, so the fake's whole job is to be the right shape at the right moment
 * and the wrong one when asked to be. `heals` says how much HP the item gives,
 * so "the item was spent and nothing healed" and "it would have had no effect"
 * are both reachable.
 */
function packing({ pocket = [[POTION, 1]], party = [{ hp: 10, maxHp: 40 }],
                   // What the item does about a status, if anything: an
                   // ANTIDOTE moves no HP at all.
                   curesKeys = null,
                   packRow = 2, rows = 7, heals = 20, consumes = true,
                   boxes = null, curPocket = 0, startItem = null,
                   // How many reads of the pocket happen before the removal is
                   // written back. The real cartridge lags: measured, a berry
                   // was still in `wItems` long after it had healed ten HP.
                   lag = 0 } = {}) {
  const sym = symbols();
  const state = new GameState(sym);
  const gb = new FakeGameBoy({ wram: worldRam(sym, {}) });
  const tasks = new Tasks(gb, state, () => {}, fakeRom({
    items: { 18: 'POTION', 154: 'BERRY' },
  }));
  const E = tasks.state.e.field;
  // The pack opens on the first entry of the pocket, which is what the
  // cartridge does -- defaulting to a fixed id made a test with a different
  // pocket look like the walk had overshot.
  const at = { box: 'start', cursor: 1, pocket: curPocket, row: 1,
               item: startItem ?? (pocket.length ? pocket[0][0] : 0xff) };
  const bag = pocket.map(([id, n]) => [id, n]);
  const mons = party.map((m) => ({ species: 155, level: 5, moves: [33, 0, 0, 0],
                                   pp: [35, 0, 0, 0], status: [], ...m }));
  const log = [];
  // The write-back the pocket owes, and when it lands.
  let pending = null, reads = 0;
  const shapeOf = () => (boxes ? boxes(at) : ({
    start: { items: rows, top: 0 },
    pack: E.pack,
    use: E.itemUse,
    party: E.partyPick,
    closed: null,
  })[at.box]);

  tasks.step = async () => {};
  tasks.settleText = async () => {};
  tasks.snap = async () => {
    reads++;
    if (pending && reads >= pending.after) {
      const e = bag.find(([id]) => id === pending.id);
      if (e && --e[1] <= 0) bag.splice(bag.indexOf(e), 1);
      pending = null;
    }
    const shape = shapeOf();
    return {
      ...state.read(worldRam(sym, { party: mons, items: bag })),
      // The party as the fake holds it, so a status the item cleared is visible
      // -- `worldRam` writes the byte and `state.read` decodes it, but the fake
      // mutates the object rather than the bytes.
      party: mons.map((m) => ({ ...m })),
      windowOpen: at.box !== 'closed',
      menuItems: shape ? shape.items : 0,
      menuTop: shape ? shape.top : 0,
      menu: [1, at.row],
      curPocket: at.pocket,
      curItem: at.item,
    };
  };
  tasks.push = async (button) => {
    log.push(`${button}@${at.box}`);
    if (button === 'B') { at.box = at.box === 'start' ? 'closed' : 'start'; return; }
    if (button === 'DOWN') { at.row++; return; }
    if (button === 'UP') { at.row = Math.max(1, at.row - 1); return; }
    if (button === 'RIGHT') { at.pocket = (at.pocket + 1) % 4; return; }
    if (button !== 'A') return;
    if (at.box === 'start') { at.box = at.row === packRow ? 'pack' : 'start'; at.row = 1; return; }
    if (at.box === 'pack') { at.box = 'use'; at.row = 1; return; }
    if (at.box === 'use') { at.box = 'party'; at.row = 1; return; }
    if (at.box === 'party') {
      const mon = mons[at.row - 1];
      if (mon && heals && mon.hp < mon.maxHp) {
        mon.hp = Math.min(mon.maxHp, mon.hp + heals);
      }
      if (mon && curesKeys) {
        mon.status = (mon.status || []).filter((k) => !curesKeys.includes(k));
      }
      // Consumption is independent of healing on purpose: the cartridge spends
      // an item that turns out to do nothing, and refuses one that would have
      // no effect at all, and those are two different states.
      if (consumes) pending = { id: at.item, after: reads + lag };
      at.box = 'closed';
    }
  };
  tasks._openStartMenu = async () => { if (at.box === 'closed') { at.box = 'start'; at.row = 1; } return true; };
  tasks._menuRowCount = async () => rows;
  tasks.menuCursor = async () => at.row;
  return { tasks, log, bag, mons, at };
}

test('the pack row is found by trying and looking, not by counting', async (t) => {
  // The START menu grows -- no POKéDEX or POKéGEAR early on -- so PACK sits at a
  // different index depending on how far the game has got. Measured on a fresh
  // Route 29 save it is row 2 of 7; nothing here believes that.
  const { tasks, log } = packing({ packRow: 4 });
  t.true(await tasks._openPack(), 'it found the pack');
  t.true(log.filter((l) => l === 'A@start').length >= 2,
         'it pressed into more than one row before finding it');
});

test('a pack that never opens is reported rather than pressed into', async (t) => {
  const { tasks } = packing({ packRow: 99 });
  t.false(await tasks._openPack(), 'no row was the pack');
});

test('using a potion is confirmed by the bag going down and the HP going up',
     async (t) => {
  const { tasks, bag, mons } = packing({ party: [{ hp: 10, maxHp: 40 }] });
  const r = await tasks.useItemOn(POTION, 0);
  t.true(r.ok, 'it worked');
  t.eq(r.gained, 20, 'and says how much');
  t.eq(bag.length, 0, 'the potion is gone');
  t.eq(mons[0].hp, 30, 'and the HP moved');
});

test('a full-health Pokémon is not a heal, however many presses landed',
     async (t) => {
  // Measured on the cartridge: at full HP the game takes every press, says the
  // item would have no effect, spends nothing, and drops back to the pack. A
  // press-counting version calls that a heal.
  // At full HP the cartridge spends nothing, which is what tells this apart
  // from an item that went and did nothing.
  const { tasks, bag } = packing({ party: [{ hp: 40, maxHp: 40 }], heals: 0,
                                   consumes: false });
  const r = await tasks.useItemOn(POTION, 0);
  t.false(r.ok, 'not a heal');
  t.contains(r.message, 'no effect', 'and it says which');
  t.eq(bag[0][1], 1, 'the potion is still there');
});

test('an item spent for nothing is said differently from one never spent',
     async (t) => {
  const { tasks } = packing({ party: [{ hp: 10, maxHp: 40 }], heals: 0, consumes: true });
  const r = await tasks.useItemOn(POTION, 0);
  t.false(r.ok, 'still not a heal');
  t.contains(r.message, 'spent and nothing changed', 'the bag moved, so this is the other one');
});

test('a pocket that catches up late is waited for, briefly', async (t) => {
  // The bound is on waiting, not a promise that it arrives -- but where it does
  // arrive, `spent` should say so rather than reporting a heal the bag has not
  // seen.
  const { tasks } = packing({ party: [{ hp: 10, maxHp: 40 }], lag: 6 });
  const r = await tasks.useItemOn(POTION, 0);
  t.true(r.ok, 'the HP moved');
  t.true(r.spent, 'and the pocket was waited for rather than read once');
  t.eq(r.message, '+20 HP', 'so the message carries no caveat');
});

test('a heal the bag has not caught up with is still a heal', async (t) => {
  // Measured on the cartridge, and it cost a working heal to find out: a BERRY
  // used on a Cyndaquil at 7/23 took it to 17/23 -- ten HP, exactly a BERRY --
  // and `wItems` still read the berry forty seconds later. The removal was not
  // written back until the pack was next opened, when both that berry and the
  // potion used after it disappeared together.
  //
  // HP is the evidence. Judging on the pocket made a heal that worked report a
  // failure, and that failure then stopped the loop from reaching for a second
  // item.
  const { tasks } = packing({ party: [{ hp: 10, maxHp: 40 }], consumes: false });
  const r = await tasks.useItemOn(POTION, 0);
  t.true(r.ok, 'the HP moved, so it healed');
  t.eq(r.gained, 20, 'by that much');
  t.false(r.spent, 'and it says the bag has not caught up');
  t.contains(r.message, 'not caught up', 'in the message too');
});

test('an item that is not in the bag is refused before any menu opens',
     async (t) => {
  const { tasks, log } = packing({ pocket: [[POTION, 1]] });
  const r = await tasks.useItemOn(BERRY, 0);
  t.false(r.ok, 'refused');
  t.contains(r.message, 'not in the bag', 'and says why');
  t.eq(log.length, 0, 'and nothing was pressed');
});

test('an empty party slot is refused the same way', async (t) => {
  const { tasks } = packing({ party: [{ hp: 10, maxHp: 40 }] });
  const r = await tasks.useItemOn(POTION, 3);
  t.false(r.ok, 'refused');
  t.contains(r.message, 'slot 4 is empty', 'counting slots the way a person does');
});

test('a box that is not the one expected stops the sequence', async (t) => {
  // The USE box never appearing means the press went somewhere else, and
  // pressing on into it is how a pilot ends up choosing TOSS.
  const E = new Tasks(new FakeGameBoy({ wram: worldRam(symbols(), {}) }),
                      new GameState(symbols()), () => {}, fakeRom()).state.e.field;
  const { tasks } = packing({
    boxes: (at) => (at.box === 'use' ? { items: 9, top: 9 } : ({
      start: { items: 7, top: 0 }, pack: E.pack, party: E.partyPick, closed: null,
    })[at.box]),
  });
  const r = await tasks.useItemOn(POTION, 0);
  t.false(r.ok, 'it stopped');
  t.contains(r.message, 'USE box never appeared', 'naming the box that was wrong');
});

test('the ITEMS pocket is walked to rather than assumed', async (t) => {
  const { tasks, log } = packing({ curPocket: 2 });
  const r = await tasks.useItemOn(POTION, 0);
  t.true(r.ok, 'it still worked');
  t.true(log.filter((l) => l.startsWith('RIGHT')).length >= 2,
         'the pocket was switched, twice, from where the pack had been left');
});

// --- backing out of a menu, and checking that it closed ----------------------

test('closing a menu presses until it is shut, not a fixed number of times',
     async (t) => {
  // The defect, and it was in the primitive every other primitive falls back
  // to. Four blind B presses; what that costs is not a menu left open, it is
  // that every directional press afterwards drives a menu cursor instead of the
  // player. Measured three boxes deep in the pack: closeMenus returned, then
  // 400 paces of paceUntilBattle moved the START menu's cursor, and the grind
  // reported "no wild Pokemon appeared -- are you standing in grass?" from a
  // tile whose collision byte is $18, with onGrass true.
  const { tasks } = pilot();
  let depth = 3;
  const pressed = [];
  tasks.snap = async () => ({ windowOpen: depth > 0 });
  tasks.push = async (b) => { pressed.push(b); if (b === 'B' && depth > 0) depth--; };
  t.true(await tasks.closeMenus(), 'it closed');
  t.eq(pressed.length, 3, 'three presses for three boxes, and not one more');
});

test('a box that swallows presses is pressed at again, up to a bound',
     async (t) => {
  // Four was not even the wrong number: a box swallows a press while it
  // animates, so the count that closes three levels is not three or four or any
  // number.
  const { tasks } = pilot();
  let depth = 3, swallow = 2;
  const pressed = [];
  tasks.snap = async () => ({ windowOpen: depth > 0 });
  tasks.push = async (b) => {
    pressed.push(b);
    if (b !== 'B') return;
    if (swallow-- > 0) return;
    if (depth > 0) depth--;
  };
  t.true(await tasks.closeMenus(), 'it still got there');
  t.eq(pressed.length, 5, 'two swallowed, three that landed');
});

test('a menu that will not close says so rather than pretending', async (t) => {
  const { tasks } = pilot();
  tasks.snap = async () => ({ windowOpen: true });
  tasks.push = async () => {};
  t.false(await tasks.closeMenus(4), 'the answer is no');
});

test('nothing is pressed when nothing is open', async (t) => {
  const { tasks } = pilot();
  const pressed = [];
  tasks.snap = async () => ({ windowOpen: false });
  tasks.push = async (b) => pressed.push(b);
  t.true(await tasks.closeMenus(), 'already shut');
  t.eq(pressed.length, 0, 'and a press into the overworld is a step');
});

test('the message is tapped through, and the pack is not', async (t) => {
  // `settleText` taps A for as long as any window is open, and after a heal the
  // pack is one of those -- so with two Potions in the bag that press lands on
  // the next item and uses it. Which is the stray-press failure `watchThrow`
  // has warned about in the neighbouring file since it was written.
  const { tasks } = pilot();
  const E = tasks.state.e.field;
  const boxes = [{ items: 9, top: 9 }, { items: 9, top: 9 }, E.pack, E.pack];
  let at = 0;
  const pressed = [];
  tasks.step = async () => {};
  tasks.pump = async () => {};
  tasks.snap = async () => ({ windowOpen: true, scriptRunning: false,
                              menuItems: boxes[Math.min(at, boxes.length - 1)].items,
                              menuTop: boxes[Math.min(at, boxes.length - 1)].top });
  tasks.push = async (b) => { pressed.push(b); at++; };
  t.true(await tasks._pastTheMessage(), 'it got past');
  t.eq(pressed.length, 2, 'two taps for two message boxes, and it stopped at the pack');
});

test('a message that never clears is given up on rather than tapped for ever',
     async (t) => {
  const { tasks } = pilot();
  const pressed = [];
  tasks.step = async () => {};
  tasks.pump = async () => {};
  tasks.snap = async () => ({ windowOpen: true, scriptRunning: false,
                              menuItems: 9, menuTop: 9 });
  tasks.push = async (b) => pressed.push(b);
  t.false(await tasks._pastTheMessage(5), 'the answer is no');
  t.eq(pressed.length, 5, 'and it is bounded');
});

test('a cure counts as the item having worked, though no HP moved', async (t) => {
  // An ANTIDOTE moves no HP at all: what it changes is the status byte, which
  // is the field this same pass taught the party reader to look at. Judging on
  // HP alone would have made every cure report a failure -- and that failure
  // would then have stopped the loop reaching for the next item.
  const ANTIDOTE = 12;
  const { tasks, mons } = packing({ pocket: [[ANTIDOTE, 1]],
                                    party: [{ hp: 40, maxHp: 40, status: ['psn'] }],
                                    heals: 0, curesKeys: ['psn'] });
  const r = await tasks.useItemOn(ANTIDOTE, 0);
  t.true(r.ok, 'it worked');
  t.eq(r.gained, 0, 'without moving any HP');
  t.eq(r.cured, ['psn'], 'and it says what it cured');
  t.eq(mons[0].status, [], 'which is gone');
});

test('an item that cures nothing on a well Pokémon is still no effect',
     async (t) => {
  const ANTIDOTE = 12;
  const { tasks } = packing({ pocket: [[ANTIDOTE, 1]],
                              party: [{ hp: 40, maxHp: 40 }],
                              heals: 0, consumes: false, curesKeys: ['psn'] });
  const r = await tasks.useItemOn(ANTIDOTE, 0);
  t.false(r.ok, 'nothing happened');
  t.contains(r.message, 'no effect', 'and it says so');
});

// --- the counter -------------------------------------------------------------

/**
 * A pilot in front of a clerk whose shop is a scripted state machine.
 *
 * The five boxes are the ones measured in Cherrygrove's Mart, in the order they
 * appear — so what is under test is whether each is confirmed before anything
 * is pressed into it, and whether the *money* is what decides a purchase
 * happened.
 */
function shopping({ stock = [POTION], price = 300, purse = 3000,
                    pocket = [], greetings = 1, boxes = null,
                    // How many reads a box spends being redrawn before it
                    // settles. The mart's quantity box reads 4/0 mid-redraw and
                    // 4/15 settled, measured -- so a checker that looks once
                    // lands on the wrong shape.
                    redraw = 0 } = {}) {
  const sym = symbols();
  const state = new GameState(sym);
  const gb = new FakeGameBoy({ wram: worldRam(sym, {}) });
  const tasks = new Tasks(gb, state, () => {},
                          fakeRom({ items: { 18: 'POTION', 12: 'ANTIDOTE' } }));
  const E = tasks.state.e.shop;
  const bag = pocket.map(([id, n]) => [id, n]);
  const at = { box: 'greeting', row: 1, item: stock[0], left: greetings,
               money: purse, settling: 0 };
  const log = [];
  const SHAPES = { greeting: null, menu: E.menu, list: E.list, howMany: E.howMany,
                   confirm: E.confirm, done: E.done, closed: null };
  tasks.step = async () => {};
  tasks.pump = async () => {};
  tasks.closeMenus = async () => { at.box = 'closed'; log.push('close'); return true; };
  tasks.menuCursor = async () => at.row;
  tasks.snap = async () => {
    let shape = (boxes ? boxes(at) : SHAPES[at.box]) || { items: 0, top: 0 };
    // Mid-redraw: the right item count at the wrong row, which is exactly what
    // the cartridge showed.
    if (at.settling > 0) { at.settling--; shape = { items: shape.items, top: 0 }; }
    return {
      ...state.read(worldRam(sym, { items: bag, money: at.money })),
      windowOpen: at.box !== 'closed',
      menuItems: shape.items, menuTop: shape.top, menu: [1, at.row],
      curItem: at.item, curPocket: 0,
      // The fake's own view, because it mutates objects rather than bytes.
      items: bag.map((b) => [...b]), money: at.money,
    };
  };
  tasks._packMoved = async (button) => {
    log.push(button);
    if (button === 'DOWN') {
      const i = stock.indexOf(at.item);
      at.item = i + 1 < stock.length ? stock[i + 1] : 0xff;
    }
    if (button === 'UP') {
      const i = stock.indexOf(at.item);
      at.item = i > 0 ? stock[i - 1] : stock[stock.length - 1];
    }
    return tasks.snap();
  };
  tasks.push = async (b) => {
    log.push(`${b}@${at.box}`);
    if (b === 'DOWN') { at.row++; return; }
    if (b === 'UP') { at.row = Math.max(1, at.row - 1); return; }
    if (b !== 'A') return;
    if (at.box === 'greeting') { if (--at.left <= 0) at.box = 'menu'; at.row = 1; return; }
    if (at.box === 'menu') { at.box = at.row === 1 ? 'list' : 'closed'; at.row = 1; return; }
    if (at.box === 'list') { at.box = 'howMany'; return; }
    if (at.box === 'howMany') { at.box = 'confirm'; at.row = 1; return; }
    if (at.box === 'confirm') {
      if (at.row === 1 && at.money >= price) {
        at.money -= price;
        const e = bag.find(([id]) => id === at.item);
        if (e) e[1]++; else bag.push([at.item, 1]);
      }
      at.box = 'done';
      at.settling = redraw;
      return;
    }
    if (at.box === 'done') { at.box = 'list'; at.row = 1; at.settling = redraw; return; }
  };
  return { tasks, log, bag, at };
}

test('buying is confirmed by the money, not by the presses', async (t) => {
  // Measured in Cherrygrove: two POTIONs at 300 each took the money 3000 to
  // 2700 to 2400 while the pocket went one to two to three. The money moved on
  // the same read as the item arriving; the pocket lags a *use*, and there is
  // no reason to trust it more here.
  const { tasks, bag, at } = shopping({ purse: 3000 });
  const r = await tasks.buyFromClerk(POTION, 2);
  t.true(r.ok, 'it bought');
  t.eq(r.bought, 2, 'both');
  t.eq(r.spent, 600, 'and says what it cost');
  t.eq(at.money, 2400, 'which the wallet agrees with');
  t.eq(bag[0][1], 2, 'and the pocket has them');
});

test('it stops when the money runs out rather than pressing on', async (t) => {
  const { tasks } = shopping({ purse: 700, price: 300 });
  const r = await tasks.buyFromClerk(POTION, 5);
  t.true(r.ok, 'it bought what it could');
  t.eq(r.bought, 2, 'two of five');
  t.contains(r.message, 'could not afford another', 'and says why it stopped');
});

test('nothing affordable at all is said rather than reported as success',
     async (t) => {
  const { tasks } = shopping({ purse: 100, price: 300 });
  const r = await tasks.buyFromClerk(POTION, 1);
  t.false(r.ok, 'nothing bought');
  t.contains(r.message, 'could not afford', 'and it says so');
});

test('a mart that does not stock it is reported, not pressed at', async (t) => {
  const { tasks } = shopping({ stock: [12] });
  const r = await tasks.buyFromClerk(POTION, 1);
  t.false(r.ok, 'nothing bought');
  t.contains(r.message, 'does not stock that', 'naming the reason');
});

test('the greeting is tapped through however long it is', async (t) => {
  // Not `settleText`, which stops when no window is open -- and the menu *is* a
  // window, so it would stop before the greeting had finished and leave the
  // caller pressing into text.
  const { tasks } = shopping({ greetings: 4 });
  const r = await tasks.buyFromClerk(POTION, 1);
  t.true(r.ok, 'it still got there');
});

test('a clerk that never offers a menu is backed away from', async (t) => {
  const { tasks, log } = shopping({ greetings: 99 });
  const r = await tasks.buyFromClerk(POTION, 1);
  t.false(r.ok, 'nothing bought');
  t.contains(r.message, 'never offered a menu', 'and it says which');
  // B presses, not a `closeMenus` call: the shop leaves the *conversation*
  // now, which is a different thing from closing its box. See the tests below.
  t.contains(log.join(' '), 'B@', 'having backed away from the counter');
});

test('leaving a counter waits for the script, not just for the box',
     async (t) => {
  // The defect this closes, and it cost a wallet. `closeMenus` presses B until
  // no window is open, which is right for a menu the pilot opened itself and
  // wrong for a box the *game* is holding up: measured at a mart counter, the
  // boxes closed, `wScriptMode` stayed non-zero, and the clerk's confirmation
  // was back a moment later. Every later job then ran `runScripts`, which
  // presses A through text -- and A on that box is a purchase. 3000 to 100, in
  // Poké Balls nobody asked for.
  const sym0 = symbols();
  const wram = worldRam(sym0, {});
  const at = (n) => sym0.addr(n) - 0xc000;
  let presses = 0;
  const gb = new FakeGameBoy({
    wram,
    onPress: (button) => {
      if (button !== 'B') return;
      presses++;
      // The box closes at once and the script keeps going for three presses,
      // which is the shape measured at the counter.
      wram[at('wWindowStackSize')] = 0;
      wram[at('wScriptMode')] = presses >= 3 ? 0 : 1;
    },
  });
  wram[at('wWindowStackSize')] = 1;
  wram[at('wScriptMode')] = 1;
  const tasks = new Tasks(gb, new GameState(sym0), () => {}, fakeRom());
  t.true(await tasks.closeConversation(), 'it got out');
  t.eq(presses, 3, 'pressing until the script ended, not until the box closed');
});

test('a conversation that will not end is reported rather than assumed',
     async (t) => {
  const sym0 = symbols();
  const wram = worldRam(sym0, {});
  const at = (n) => sym0.addr(n) - 0xc000;
  wram[at('wWindowStackSize')] = 0;
  wram[at('wScriptMode')] = 1;                 // never clears
  const gb = new FakeGameBoy({ wram });
  const tasks = new Tasks(gb, new GameState(sym0), () => {}, fakeRom());
  t.false(await tasks.closeConversation(4), 'it says so');
});

test('nothing on screen costs no presses', async (t) => {
  const sym0 = symbols();
  let presses = 0;
  const gb = new FakeGameBoy({ wram: worldRam(sym0, {}),
                               onPress: () => { presses++; } });
  const tasks = new Tasks(gb, new GameState(sym0), () => {}, fakeRom());
  t.true(await tasks.closeConversation(), 'already out');
  t.eq(presses, 0, 'and it pressed nothing');
});

test('a box that is not the one expected stops the purchase', async (t) => {
  // Pressing on from an unknown box in a shop is how a pilot sells something.
  const sym0 = symbols();
  const E = new Tasks(new FakeGameBoy({ wram: worldRam(sym0, {}) }),
                      new GameState(sym0), () => {}, fakeRom()).state.e.shop;
  const { tasks } = shopping({
    boxes: (at) => (at.box === 'confirm' ? { items: 9, top: 9 }
      : ({ greeting: null, menu: E.menu, list: E.list, howMany: E.howMany,
           done: E.done, closed: null })[at.box]),
  });
  const r = await tasks.buyFromClerk(POTION, 1);
  t.false(r.ok, 'it stopped');
  t.eq(r.bought, 0, 'with nothing bought');
});

test('a box being redrawn is waited for, not judged on one look', async (t) => {
  // Measured, and it reported "bought nothing" from inside a working shop: the
  // mart's quantity box reads 4/15 settled and **4/0 while being redrawn**, so
  // a check that looked once landed on the transient shape and gave up. The
  // first probe of the sequence caught that frame and the second did not, which
  // is what a race looks like in a log.
  const { tasks } = pilot();
  const want = { items: 4, top: 15 };
  let looks = 0;
  tasks.step = async () => {};
  tasks.snap = async () => (++looks < 3
    // Two frames of the redraw, then the box it settles to.
    ? { windowOpen: true, menuItems: 4, menuTop: 0 }
    : { windowOpen: true, menuItems: 4, menuTop: 15 });
  t.true(await tasks._awaitBox(want), 'it waited and found it');
  t.true(looks >= 3, 'having looked more than once');
});

test('a box that never appears is given up on, bounded', async (t) => {
  const { tasks } = pilot();
  let looks = 0;
  tasks.step = async () => {};
  tasks.snap = async () => { looks++; return { windowOpen: true, menuItems: 9, menuTop: 9 }; };
  t.false(await tasks._awaitBox({ items: 4, top: 15 }, 4), 'the answer is no');
  t.true(looks <= 6, 'and it stopped rather than waiting for ever');
});

test('a second purchase survives the box still closing behind the first',
     async (t) => {
  // Measured: with the wait only on the way *in*, one press of Shop bought one
  // potion of four and reported it honestly -- because the thanks box was still
  // closing when the loop looked for the stock list again.
  const { tasks, at } = shopping({ purse: 3000, redraw: 2 });
  const r = await tasks.buyFromClerk(POTION, 3);
  t.eq(r.bought, 3, 'all three');
  t.eq(at.money, 2100, 'and nine hundred spent');
});

// --- driving a menu by what it says ------------------------------------------

test('the row wanted is the row that says so, whatever number it is',
     async (t) => {
  // The START menu grows -- no POKeDEX or POKeGEAR early on -- which is why
  // opening the pack used to try rows one at a time and ask each time whether
  // the pack had appeared. Measured after the errand it reads POKeDEX, POKeMON,
  // PACK, POKeGEAR, CHRIS, SAVE, OPTION, EXIT: PACK is the row that says PACK.
  const { tasks } = drawnMenu({ items: ['POKEDEX', 'POKEMON', 'PACK', 'SAVE'] });
  t.true(await tasks._driveToSaying('PACK'), 'it got there');
  const sc = await tasks.screen();
  t.true(sc.selectedSays('PACK'), 'and the arrow is on it');
});

test('a box that keeps its selection nowhere readable is still driven',
     async (t) => {
  // The measurement this whole module exists for. `_packMoved` waits on a
  // variable; this box has none, so the arrow is the only answer there is.
  const { tasks } = drawnMenu({ items: ['WITHDRAW', 'DEPOSIT', 'CHANGE BOX'],
                                tracksCursor: false });
  t.true(await tasks._driveToSaying('DEPOSIT'), 'the arrow moved to it');
  const sc = await tasks.screen();
  t.eq(sc.selected(), '>DEPOSIT', 'and it is what is selected');
});

test('a swallowed press does not end the search', async (t) => {
  const { tasks } = drawnMenu({ items: ['POKEDEX', 'POKEMON', 'PACK'],
                                swallow: 2 });
  t.true(await tasks._driveToSaying('PACK'), 'it kept pressing');
});

test('a word that is not on the menu is not found, and it stops looking',
     async (t) => {
  // Bounded by the wrap: once the arrow has been round the menu the answer is
  // no, and pressing on would be pressing for ever.
  const { tasks, world } = drawnMenu({ items: ['POKEDEX', 'POKEMON', 'PACK'] });
  t.false(await tasks._driveToSaying('BICYCLE'), 'not there');
  t.true(world.presses < 40, `and it gave up after ${world.presses} presses`);
});

test('a screen with no arrow costs no presses at all', async (t) => {
  // Because DOWN in an overworld is a step into the grass, and this is asked
  // before anything is known to be open.
  const { tasks } = pilot();
  t.false(await tasks._driveToSaying('PACK'), 'nothing to drive');
});

// --- keeping the name the game gives ----------------------------------------

/**
 * A pilot in front of the nickname question, with the text still typing.
 *
 * Measured shape: the question's text stops and waits for a button with
 * `wWindowStackSize` reading zero, and one press finishes it and draws the
 * choice. So `pagesOfText` presses reach the box and nothing before that is
 * answerable.
 */
function beingAsked({ pagesOfText = 2 } = {}) {
  const sym0 = symbols();
  const wram = worldRam(sym0, {});
  const at = (n) => sym0.addr(n) - 0xc000;
  const log = [];
  let page = 0;
  const show = (lines, open) => {
    paintScreen(wram, sym0, lines);
    wram[at('wWindowStackSize')] = open ? 1 : 0;
  };
  show([' Give a nickname to', ' the PIDGEY you'], false);
  const gb = new FakeGameBoy({
    wram,
    onPress: (button) => {
      log.push(button);
      if (button === 'B') { show([], false); return; }
      page++;
      if (page >= pagesOfText) show([' >YES', '  NO', ' Give a nickname'], true);
    },
  });
  const tasks = new Tasks(gb, new GameState(sym0), () => {}, fakeRom());
  return { tasks, log };
}

test('B on the nickname question keeps the name the game gave it', async (t) => {
  // Measured by pausing a new game on that box and pressing it:
  // wPartyMon1Nickname went from ten $80s to 82 98 8d 83 80 90 94 88 8b 50 --
  // CYNDAQUIL. Every starter this app took for twenty-eight passes was called
  // AAAAAAAAAA, and so would every catch made with a full party.
  const { tasks, log } = beingAsked();
  t.true(await tasks.keepDefaultName(), 'it answered');
  t.eq(log[log.length - 1], 'B', 'B last');
  t.eq(log.filter((b) => b === 'B').length, 1, 'and exactly once');
});

test('A is pressed until the choice is drawn, however long the text is',
     async (t) => {
  // A press issued too early only hurries the text, and a look taken straight
  // afterwards sees no box -- which is what `declineNickname` did, twelve runs
  // in a row. So this is a loop: press, look, press B.
  const { tasks, log } = beingAsked({ pagesOfText: 5 });
  t.true(await tasks.keepDefaultName(), 'it still got there');
  t.eq(log.slice(0, -1).filter((b) => b !== 'A').length, 0, 'A for every page');
  t.eq(log[log.length - 1], 'B', 'then B');
});

test('a question that never comes is given up on rather than pressed for ever',
     async (t) => {
  const { tasks, log } = beingAsked({ pagesOfText: 99 });
  t.false(await tasks.keepDefaultName(), 'it gave up');
  t.false(log.includes('B'), 'without pressing B at nothing');
});

test('Stop ends the answering', async (t) => {
  const { tasks, log } = beingAsked();
  tasks.cancelled = true;
  t.false(await tasks.keepDefaultName(), 'it stopped');
  t.eq(log.length, 0, 'having pressed nothing');
});
