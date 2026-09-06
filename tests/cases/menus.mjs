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
