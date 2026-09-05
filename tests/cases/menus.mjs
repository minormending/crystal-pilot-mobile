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
