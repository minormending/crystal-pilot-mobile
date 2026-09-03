// Battle decisions. Every test here corresponds to something that was once
// wrong in a way no static check could see.
import { FakeGameBoy, fakeRom, romReading, symbols, test, worldRam } from '../harness.mjs';
import { GameState } from '../../app/state.js';
import { Tasks } from '../../app/tasks.js';

function pilot({ wram = null, onPress = null } = {}) {
  const sym = symbols();
  const state = new GameState(sym);
  const gb = new FakeGameBoy({ wram: wram || worldRam(sym, {}), onPress });
  const tasks = new Tasks(gb, state, () => {}, fakeRom());
  return { sym, state, gb, tasks };
}

test('the drawn battle menu is told apart from the pack over the top of it', async (t) => {
  const { sym, state } = pilot();
  // Both park the cursor at (1,1), so the cursor alone cannot distinguish them
  // -- which is how a thrown ball once looked like a Pokemon breaking free.
  const battleMenu = state.read(worldRam(sym, {
    battleMode: 1, menu: [1, 1], menuItems: 34, menuTop: 12,
  }));
  const packOverIt = state.read(worldRam(sym, {
    battleMode: 1, menu: [1, 1], menuItems: 5, menuTop: 1,
  }));
  t.true(Tasks.menuIsLive(battleMenu), '34 items at row 12 is the battle menu');
  t.false(Tasks.menuIsLive(packOverIt), '5 items at row 1 is the pack');
});

test('the battle menu is not live on the turn it has not been drawn yet', async (t) => {
  const { sym, state } = pilot();
  const stillText = state.read(worldRam(sym, {
    battleMode: 1, menu: [0, 0], menuItems: 34, menuTop: 12,
  }));
  t.false(Tasks.menuIsLive(stillText),
          'a cursor at 0 means the menu is drawn but not interactive');
});

test('weakening never reaches for a move whose power byte lies about it', async (t) => {
  // Driven through the real RomData against a real byte layout, because a stub
  // of isChipMove would only be testing the stub.
  const rom = romReading({
    12: { name: 'GUILLOTINE', effect: 38, power: 0 },
    32: { name: 'HORN DRILL', effect: 38, power: 1 },
    68: { name: 'COUNTER', effect: 89, power: 1 },
    69: { name: 'SEISMIC TOSS', effect: 87, power: 1 },
    162: { name: 'SUPER FANG', effect: 40, power: 1 },
    33: { name: 'TACKLE', effect: 0, power: 35 },
    82: { name: 'DRAGON RAGE', effect: 41, power: 40 },
    43: { name: 'LEER', effect: 19, power: 0 },
  });
  // These store 0 or 1, so ranking by power puts every one of them ahead of
  // TACKLE. Asked for the gentlest damaging move, the obvious implementation
  // returns a one-hit KO.
  for (const [id, name] of [[12, 'GUILLOTINE'], [32, 'HORN DRILL'], [68, 'COUNTER'],
                            [69, 'SEISMIC TOSS'], [162, 'SUPER FANG']]) {
    t.false(rom.isChipMove(id), `${name} must not be picked to weaken with`);
  }
  t.true(rom.isChipMove(33), 'TACKLE is a real weakening move');
  // Not the same as "fixed damage": this one really does store its damage as
  // its power, so it ranks correctly and stays in.
  t.true(rom.isChipMove(82), 'DRAGON RAGE stays in');
  t.false(rom.isChipMove(43), 'LEER weakens nothing and would spend every turn');
});

test('awaitQuiet settles rather than believing a transient', async (t) => {
  const sym = symbols();
  const state = new GameState(sym);
  // Straight after a battle the map reads status 1 with a script running, while
  // the map and party read correctly the whole time. Taking that at face value
  // is how an undo point came to be refused with "no game is running".
  const busy = worldRam(sym, { mapStatus: 1, scriptMode: 1, map: [24, 3] });
  const gb = new FakeGameBoy({
    wram: busy,
    onRun: (_frames, self) => {
      // The game finishes what it was doing after a little while.
      if (self.frames > 200) {
        self.wram[sym.addr('wMapStatus') - 0xc000] = 2;
        self.wram[sym.addr('wScriptMode') - 0xc000] = 0;
      }
    },
  });
  const tasks = new Tasks(gb, state, () => {}, fakeRom());

  const raw = await tasks.snap();
  t.false(raw.worldLoaded, 'the raw read says there is no game');

  const settled = await tasks.awaitQuiet();
  t.true(settled.worldLoaded, 'settling finds the game that was there all along');
  t.false(settled.scriptRunning, 'and the script has finished');
});

test('canSave refuses in a battle, and says which reason', async (t) => {
  const sym = symbols();
  const state = new GameState(sym);
  const gb = new FakeGameBoy({
    wram: worldRam(sym, { battleMode: 1, mapStatus: 2, map: [24, 3] }),
  });
  const tasks = new Tasks(gb, state, () => {}, fakeRom());
  const can = await tasks.canSave();
  t.false(can.ok, 'cannot save mid-battle');
  t.contains(can.why, 'battle', 'and says so');
});

test('awaitBattleMenu waits for the menu and hands back the snapshot', async (t) => {
  // The regression this guards shipped. Six call sites in battle.js said
  // `Tasks.menuIsLive(...)`, and after the class was split into mixins that
  // name lives in tasks.js and is not in scope there -- so every one was a
  // ReferenceError the moment it ran, and grinding broke in the deployed app.
  //
  // The existing tests called the static directly, which works, and never
  // called anything that calls it. So this drives a caller.
  const sym = symbols();
  const state = new GameState(sym);
  let polls = 0;
  const inBattleNoMenu = worldRam(sym, {
    battleMode: 1, party: [{ hp: 20, maxHp: 20 }],
    enemy: { species: 16, level: 3, hp: 15, maxHp: 15 },
    active: { hp: 20, maxHp: 20 }, menuItems: 34, menuTop: 12, menu: [0, 0],
  });
  // The menu appears after a few polls, as it does in a real battle. Driven
  // from onPress rather than onRun: awaitBattleMenu taps A between polls to
  // push through text, so onRun alone fires once and never again.
  const draw = (_x, self) => {
    if (++polls > 3) {
      self.wram[sym.addr('wMenuCursorX') - 0xc000] = 1;
      self.wram[sym.addr('wMenuCursorY') - 0xc000] = 1;
    }
  };
  const gb = new FakeGameBoy({ wram: inBattleNoMenu, onRun: draw, onPress: draw });
  const tasks = new Tasks(gb, state, () => {}, fakeRom());

  const menu = await tasks.awaitBattleMenu(40);
  t.true(menu !== null, 'it found the menu rather than throwing');
  t.true(menu.inBattle, 'and hands back a snapshot of the battle');
  t.eq(menu.menu, [1, 1], 'with the cursor where the menu put it');
});

test('awaitBattleMenu gives up rather than throwing when no menu appears', async (t) => {
  const sym = symbols();
  const state = new GameState(sym);
  const gb = new FakeGameBoy({
    wram: worldRam(sym, {
      battleMode: 1, party: [{ hp: 20, maxHp: 20 }],
      enemy: { hp: 15, maxHp: 15 }, active: { hp: 20, maxHp: 20 },
      menuItems: 34, menuTop: 12, menu: [0, 0],
    }),
  });
  const tasks = new Tasks(gb, state, () => {}, fakeRom());
  t.eq(await tasks.awaitBattleMenu(8), null, 'it returns null, not an exception');
});
