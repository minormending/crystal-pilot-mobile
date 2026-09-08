// Driving the game's own menus.
//
// menus.js had no tests, and it is the module that saves your game. The parts
// that need a real screen cannot be tested here; the order of operations can,
// and that is where the fault was.
import { FakeGameBoy, fakeRom, symbols, test, worldRam } from '../harness.mjs';
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
function cartridgeMenu({ rows = 6, saveRow = 4, startOpen = false } = {}) {
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
