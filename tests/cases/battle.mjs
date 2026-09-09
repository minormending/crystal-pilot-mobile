// Battle decisions. Every test here corresponds to something that was once
// wrong in a way no static check could see.
import { FakeGameBoy, fakeRom, romReading, symbols, test, worldRam } from '../harness.mjs';
import { learnMoveBox, onField } from '../../gen2/battle.js';
import { GameState } from '../../gen2/state.js';
import { gen2 } from '../../gen2/engine.js';
import { Tasks } from '../../gen2/tasks.js';

/**
 * `rom` is explicit because two tests need it to be something other than the
 * default: one drives the real move-table reader, and one passes null to check
 * what happens on a cartridge whose moves cannot be read at all.
 */
function pilot({ wram = null, onPress = null, rom = undefined } = {}) {
  const sym = symbols();
  const state = new GameState(sym);
  const gb = new FakeGameBoy({ wram: wram || worldRam(sym, {}), onPress });
  const said = [];
  const tasks = new Tasks(gb, state, (line) => said.push(line),
                          rom === undefined ? fakeRom() : rom);
  return { sym, state, gb, tasks, said };
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

test('the battle menu is live at every cursor it has, and nowhere else',
     async (t) => {
  // **The bounds, which nothing tested.** `tools/mutate` could widen or narrow
  // every one of `x >= 1 && x <= 2 && y >= 1 && y <= 2` and the suite passed --
  // in the guard that tells the battle menu from the pack drawn over it, which
  // is the confusion that once made a thrown ball look like a Pokémon breaking
  // free.
  //
  // Four positions, because the battle menu is a two-by-two: FIGHT, PKMN, PACK,
  // RUN. A bound that is one out either way reads one of those four as "not the
  // menu" and the turn is driven blind.
  const { sym, state } = pilot();
  const at = (x, y) => Tasks.menuIsLive(state.read(worldRam(sym, {
    battleMode: 1, menu: [x, y], menuItems: 34, menuTop: 12,
  })));
  for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]]) {
    t.true(at(x, y), `(${x},${y}) is one of the four corners`);
  }
  t.false(at(0, 1), 'x of nought is the menu not yet interactive');
  t.false(at(1, 0), 'and so is y of nought');
  t.false(at(3, 1), 'x past the right-hand column is not the menu');
  t.false(at(1, 3), 'nor y past the bottom row');
});

test('having PP is not the same as having a move that can win', async (t) => {
  // **Measured on Route 31, and it cost forty turns and a walk each time.**
  // Cyndaquil at Lv11 with TACKLE on 0 of 35, LEER and SMOKESCREEN full, and a
  // Lv2 CATERPIE at 1 HP in a *trainer* battle -- so no fleeing either. The
  // pilot lowered the Caterpie's defence forty times and reported 'stuck',
  // which is true and says nothing anybody can act on.
  //
  // Driven through the real move table, because a stub of "does this move do
  // damage" would only be testing the stub -- and the power byte is the part
  // that can be wrong.
  const { tasks } = pilot();
  const outOfPP = { moves: [33, 43, 108, 0], pp: [0, 30, 20, 0] };
  t.eq(tasks.canStillWin(outOfPP), false,
       'TACKLE is spent and the rest cannot end a battle');

  const fine = { moves: [33, 43, 108, 0], pp: [5, 30, 20, 0] };
  t.eq(tasks.canStillWin(fine), true, 'one hit left is enough');

  const allSpent = { moves: [33, 43, 0, 0], pp: [0, 0, 0, 0] };
  t.eq(tasks.canStillWin(allSpent), false,
       'and nothing at all is certainly not enough');

  // Null rather than false where there is no ROM to price moves with: "cannot
  // say" and "no" send a caller different places.
  const blind = pilot();
  blind.tasks.rom = null;
  t.eq(blind.tasks.canStillWin(fine), null, 'no table, no answer');
  t.eq(blind.tasks.canStillWin(null), null, 'and nothing to ask about');
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

test('the moves come from the Pokemon on the field, not from slot one', async (t) => {
  // sendOut arrived for the party of more than one, and the two places that
  // read a move list were never told. After a switch, `party[0]` is the
  // *fainted* lead, so an index chosen from its four moves means a different
  // entry on the two the game has actually drawn.
  const lead = { hp: 0, maxHp: 30, moves: [1, 2, 3, 4], pp: [5, 5, 5, 5] };
  const second = { hp: 22, maxHp: 41, moves: [7, 8, 0, 0], pp: [9, 9, 0, 0] };
  const out = onField({ party: [lead, second], active: { hp: 22, maxHp: 41 } });
  t.eq(out.moves, [7, 8, 0, 0], 'the replacement, not the corpse in slot one');

  const standing = onField({ party: [lead, second], active: { hp: 30, maxHp: 30 } });
  t.eq(standing.hp, 22, 'no party entry matches, so the first one standing');
});

test('a healthy lead is still the one on the field', async (t) => {
  const lead = { hp: 30, maxHp: 30, moves: [1, 2, 0, 0], pp: [5, 5, 0, 0] };
  const second = { hp: 41, maxHp: 41, moves: [7, 0, 0, 0], pp: [9, 0, 0, 0] };
  t.eq(onField({ party: [lead, second], active: { hp: 30, maxHp: 30 } }).moves,
       [1, 2, 0, 0], 'the ordinary case is unchanged');
});

test('an ambiguous match still picks a Pokemon the HP could belong to', async (t) => {
  // The case that made the old rule wrong. Two slots read alike, so no unique
  // match -- and the *lead* is standing at a different HP entirely. Demanding
  // uniqueness sent the caller to that lead, whose numbers plainly are not the
  // battle mon's. Any of the ones that match is a better answer than one that
  // does not.
  const lead = { hp: 30, maxHp: 30, moves: [1, 0, 0, 0], pp: [5, 0, 0, 0] };
  const b = { hp: 20, maxHp: 25, moves: [2, 0, 0, 0], pp: [5, 0, 0, 0] };
  const c = { hp: 20, maxHp: 25, moves: [3, 0, 0, 0], pp: [5, 0, 0, 0] };
  const out = onField({ party: [lead, b, c], active: { hp: 20, maxHp: 25 } });
  t.eq(out.moves, [2, 0, 0, 0], 'one of the two that match, not the lead');
});

test('two Pokemon that read alike fall back to the one sendOut would pick', async (t) => {
  // Same species, same level, both untouched: the HP pair cannot tell them
  // apart, so guessing between them would be worse than the rule sendOut
  // already follows.
  const a = { hp: 0, maxHp: 25, moves: [1, 0, 0, 0], pp: [5, 0, 0, 0] };
  const b = { hp: 25, maxHp: 25, moves: [2, 0, 0, 0], pp: [5, 0, 0, 0] };
  const c = { hp: 25, maxHp: 25, moves: [3, 0, 0, 0], pp: [5, 0, 0, 0] };
  t.eq(onField({ party: [a, b, c], active: { hp: 25, maxHp: 25 } }).moves,
       [2, 0, 0, 0], 'the first one standing');
  t.eq(onField({ party: [], active: { hp: 0, maxHp: 0 } }), null, 'no party, nobody out');
});

test('a fainted Pokemon on the field is answered, whatever loop is driving', async (t) => {
  // Gen 2 asks "Which POKeMON?" and waits. fightBattle answered it from the day
  // sendOut was written and nothing else did -- so fleeing spent 150 presses
  // hunting for a battle menu that was never coming.
  const { tasks } = pilot();
  let asked = 0;
  tasks.sendOut = async () => { asked++; return 'ok'; };

  const live = { inBattle: true, party: [{ hp: 0, maxHp: 30 }],
                 active: { hp: 0, maxHp: 30 } };
  t.eq(await tasks.coverFaint(live), 'ok', 'it sends the next one out');
  t.eq(asked, 1, 'by way of sendOut');

  const standing = { inBattle: true, party: [{ hp: 12, maxHp: 30 }],
                     active: { hp: 12, maxHp: 30 } };
  t.eq(await tasks.coverFaint(standing), null, 'nothing to answer while it stands');

  // "Wild PIDGEY appeared!": the battle mon is not loaded and both read zero.
  const appearing = { inBattle: true, party: [{ hp: 30, maxHp: 30 }],
                      active: { hp: 0, maxHp: 0 } };
  t.eq(await tasks.coverFaint(appearing), null, 'and not at the start of one');

  t.eq(await tasks.coverFaint({ inBattle: false, party: [], active: {} }), null,
       'nor outside a battle');
  t.eq(asked, 1, 'sendOut was reached exactly once');
});

test('fleeing sends out a replacement rather than giving up', async (t) => {
  // Running can fail, and the wild Pokemon that gets the turn can knock ours
  // out. Hunting flees from everything, so this arrives eventually on any long
  // hunt -- and it stopped it with "could not run from a PIDGEY".
  const { tasks } = pilot();
  let sent = 0;
  const live = { inBattle: true, party: [{ hp: 0, maxHp: 30 }, { hp: 20, maxHp: 25 }],
                 active: { hp: 0, maxHp: 30 } };
  tasks.snap = async () => live;
  tasks.sendOut = async () => { sent++; live.inBattle = false; return 'ended'; };
  tasks.awaitBattleMenu = async () => { throw new Error('should not look for a menu'); };
  t.true(await tasks.flee(), 'the battle is over, so it ran');
  t.eq(sent, 1, 'and it answered the prompt instead of hunting for a menu');
});

test('with nothing left standing, fleeing says so rather than looping', async (t) => {
  const { tasks } = pilot();
  tasks.snap = async () => ({ inBattle: true, party: [{ hp: 0, maxHp: 30 }],
                              active: { hp: 0, maxHp: 30 } });
  tasks.sendOut = async () => 'lost';
  tasks.awaitBattleMenu = async () => { throw new Error('should not look for a menu'); };
  t.false(await tasks.flee(), 'there is nothing to run with');
});

test('the pack is stepped until it moves, not for a fixed time', async (t) => {
  // The lesson nav.step learned about walking, arriving late in the one place
  // that had not had it. The pocket switch swallows presses while it animates
  // and wCurItem is written a frame after wCurPocket, so a fixed wait re-reads
  // a value that has not caught up -- and the loop presses again, walking two
  // pockets for one observed change.
  const { tasks } = pilot();
  let pocket = 0, polls = 0;
  tasks.snap = async () => ({ curPocket: pocket, curItem: 0 });
  tasks.push = async () => { polls = 0; };          // the press lands...
  tasks.step = async () => { if (++polls >= 3) pocket++; };  // ...three polls later
  const s = await tasks._packMoved('RIGHT', (x) => x.curPocket);
  t.eq(s.curPocket, 1, 'it waited for the pocket to actually change');
});

test('a pack that never moves is handed back rather than waited on for ever', async (t) => {
  const { tasks } = pilot();
  tasks.snap = async () => ({ curPocket: 2, curItem: 0 });
  tasks.push = async () => {};
  tasks.step = async () => {};
  const s = await tasks._packMoved('RIGHT', (x) => x.curPocket);
  t.eq(s.curPocket, 2, 'a press the game ignored costs a re-read, not a hang');
});

test('a pack that never opened is told apart by the menu, not by the pocket', async (t) => {
  // The old guard asked whether wCurPocket was above 3. Measured on the real
  // cartridge the four pockets read 0..3 and the value never leaves that range,
  // so it could not fire. The battle menu's own signature is what separates
  // them: five items at row one for the pack, thirty-four at twelve for the
  // battle menu.
  const { tasks, sym, state } = pilot();
  const stillBattleMenu = state.read(worldRam(sym, {
    battleMode: 1, menu: [1, 1], menuItems: 34, menuTop: 12, curPocket: 0, curItem: 0,
  }));
  t.true(Tasks.menuIsLive(stillBattleMenu),
         'that is the battle menu, so the pack never opened');
  const packOpen = state.read(worldRam(sym, {
    battleMode: 1, menu: [1, 1], menuItems: 5, menuTop: 1, curPocket: 0, curItem: 18,
  }));
  t.false(Tasks.menuIsLive(packOpen), 'and this is the pack, which is what we wanted');
});

// --- winning a battle, rather than taking the first move in the list --------

test('a grind swings with the hardest move it can, not the first one',
     async (t) => {
  // Measured on the cartridge. A Chikorita's slots are Tackle, Growl, Razor
  // Leaf, Reflect. Sixty-four battles in, Tackle's PP was gone -- so slot order
  // handed back Growl, which takes no HP off anything, while Razor Leaf sat in
  // slot three at 25 PP. The battle could not end, five in a row tripped the
  // stall detector, and the grind gave up at 3 HP out of 36.
  const rom = romReading({
    33:  { id: 33, name: 'TACKLE', power: 35, effect: 0, pp: 35 },
    45:  { id: 45, name: 'GROWL', power: 0, effect: 18, pp: 40 },
    75:  { id: 75, name: 'RAZOR LEAF', power: 55, effect: 0, pp: 25 },
    115: { id: 115, name: 'REFLECT', power: 0, effect: 66, pp: 20 },
  });
  const { tasks } = pilot({ rom });
  const chikorita = { moves: [33, 45, 75, 115], pp: [0, 3, 25, 20] };

  // Slot order would say 1 (Growl). Power says 2 (Razor Leaf).
  t.eq(tasks.strongest([1, 2, 3], chikorita), 2,
       'Razor Leaf, which is the only thing here that can end a battle');

  const full = { moves: [33, 45, 75, 115], pp: [35, 40, 25, 20] };
  t.eq(tasks.strongest([0, 1, 2, 3], full), 2, 'and it beats Tackle on power');
});

test('with nothing that does damage it takes what there is, and says so',
     async (t) => {
  // The honest fallback: with only status moves left there is no winning move
  // to prefer, and `grind` reads that as a reason to go and heal rather than
  // as a move to make.
  const rom = romReading({
    45:  { id: 45, name: 'GROWL', power: 0, effect: 18, pp: 40 },
    115: { id: 115, name: 'REFLECT', power: 0, effect: 66, pp: 20 },
  });
  const { tasks } = pilot({ rom });
  const statusOnly = { moves: [45, 115, 0, 0], pp: [3, 20, 0, 0] };
  t.eq(tasks.strongest([0, 1], statusOnly), 0, 'the first usable one');
});

test('a move the cartridge cannot be read for is still swung', async (t) => {
  // "I cannot tell how hard this hits" is not a reason to stand there. A hack
  // that renumbered its move table reads as power 0 for everything, and the
  // fallback keeps the pilot fighting instead of refusing to.
  const { tasks } = pilot({ rom: null });
  const mon = { moves: [33, 45, 75, 115], pp: [0, 3, 25, 20] };
  t.eq(tasks.strongest([1, 2, 3], mon), 1,
       'no move table, so no preference — the first usable slot');
});

test('fightBattle actually asks for the hardest move, not just could', async (t) => {
  // The wiring, not the function. A first draft of these tests exercised
  // `strongest` on its own and passed with the argument removed from
  // `fightBattle` entirely -- which is the same shape as the ReferenceError
  // that once reached the deployed app: "the tests exercised the static
  // directly rather than any of its callers".
  const rom = romReading({
    33: { id: 33, name: 'TACKLE', power: 35, effect: 0, pp: 35 },
    45: { id: 45, name: 'GROWL', power: 0, effect: 18, pp: 40 },
    75: { id: 75, name: 'RAZOR LEAF', power: 55, effect: 0, pp: 25 },
  });
  const { sym, tasks } = pilot({ rom });
  const party = [{ slot: 0, species: 152, level: 13, hp: 36, maxHp: 36,
                   moves: [33, 45, 75, 0], pp: [0, 3, 25, 0] }];
  const inBattle = { party, inBattle: true, menu: [1, 1], menuItems: 34,
                     menuTop: 12, worldLoaded: true, windowOpen: true,
                     enemy: { species: 16, level: 3, hp: 10, maxHp: 10 },
                     active: { hp: 36, maxHp: 36 } };

  let asked = null, turns = 0;
  tasks.coverFaint = async () => null;
  tasks.awaitBattleMenu = async () => inBattle;
  tasks.chooseAction = async () => {};
  tasks.step = async () => {};
  tasks.pump = async () => {};
  tasks.snap = async () => (turns > 0 ? { ...inBattle, inBattle: false } : inBattle);
  tasks.chooseMove = async (mon, prefer) => {
    asked = prefer ? prefer([1, 2], mon) : 'no preference was passed';
    turns++;
    return 0;
  };
  await tasks.fightBattle(2);
  t.eq(asked, 2, 'Razor Leaf — so a preference was passed, and it was this one');
});


// --- the type chart, which is the difference between a number and a hit -----
//
// The moves are the real ones with their real types; the chart is the head of
// the real table plus its real tail. Ranking by `power` alone picks the bigger
// number, and the bigger number is not always the harder hit.

const NORMAL = 0x00, BUG = 0x07, GHOST = 0x08, FIRE = 0x14, GRASS = 0x16;
const CHART = [
  NORMAL, GHOST, 0,
  FIRE, GRASS, 20,
  FIRE, BUG, 20,
  GRASS, BUG, 5,
  GRASS, FIRE, 5,
  0xff,
];
const TYPED_MOVES = {
  33: { power: 35, type: NORMAL, pp: 35 },        // TACKLE
  45: { power: 0, effect: 18, type: NORMAL, pp: 40 }, // GROWL
  52: { power: 40, type: FIRE, pp: 25 },          // EMBER
  75: { power: 55, type: GRASS, pp: 25 },         // RAZOR LEAF
};
// Packed, terminated, and in the same numbering as the moves above, because
// the log line names the move it picked and a name off by one entry names the
// wrong one. Ids 33, 45, 52 and 75, so the table is mostly filler.
const MOVE_NAMES = (() => {
  const named = { 33: 'TACKLE', 45: 'GROWL', 52: 'EMBER', 75: 'RAZOR LEAF' };
  const out = [];
  for (let id = 1; id <= 75; id++) {
    for (const c of named[id] || '-') {
      out.push(c === ' ' ? 0x7f : (c === '-' ? 0xe3 : 0x80 + c.charCodeAt(0) - 65));
    }
    out.push(0x50);
  }
  return out;
})();
const typedRom = () => romReading(TYPED_MOVES, { chart: CHART, names: MOVE_NAMES });

test('the bigger number is not the harder hit, and the chart says which is',
     async (t) => {
  // A Chikorita meeting a CATERPIE. Razor Leaf is 55 and halved on a Bug --
  // 27.5 -- and Tackle is 35 and neutral. Ranking by power swings the 55 and
  // takes longer over every Bug on Route 30 than the move in slot one would.
  const { tasks } = pilot({ rom: typedRom() });
  const chikorita = { moves: [33, 45, 75, 0], pp: [35, 40, 25, 0] };
  t.eq(tasks.strongest([0, 1, 2], chikorita, [BUG, BUG]), 0,
       'Tackle, because half of 55 is less than 35');
  t.eq(tasks.strongest([0, 1, 2], chikorita, [NORMAL, NORMAL]), 2,
       'and against something the chart is quiet about, Razor Leaf again');
});

test('a weaker move that is super effective wins', async (t) => {
  const { tasks } = pilot({ rom: typedRom() });
  const quilava = { moves: [33, 52, 0, 0], pp: [35, 25, 0, 0] };
  t.eq(tasks.strongest([0, 1], quilava, [GRASS, GRASS]), 1,
       'Ember at 40 doubled beats Tackle at 35');
  t.eq(tasks.strongest([0, 1], quilava, [NORMAL, NORMAL]), 1,
       'and it beats it on power alone anyway');
});

test('the same-type bonus is enough to change the pick', async (t) => {
  // Nothing here is super effective and nothing is resisted: 55 against 40,
  // and the only thing between them is which Pokemon is holding them. A Fire
  // mon swings the 55; the bonus does not move it. The chart is the same.
  const { tasks } = pilot({ rom: typedRom() });
  const mon = { moves: [52, 75, 0, 0], pp: [25, 25, 0, 0] };
  t.eq(tasks.strongest([0, 1], mon, [NORMAL, NORMAL]), 1,
       'Razor Leaf on the raw numbers: 55 against 40');
  t.eq(tasks.strongest([0, 1], mon, [NORMAL, NORMAL], [FIRE, FIRE]), 0,
       'and Ember once the Fire mon is holding it: 40 and a half is 60');
  t.eq(tasks.strongest([0, 1], mon, [NORMAL, NORMAL], [GRASS, GRASS]), 1,
       'the other way round for a Grass one');
});

test('a chart that says nothing can land never hands back a status move',
     async (t) => {
  // The set is chosen by raw power and only the *order* by the chart, which
  // is deliberate: a Normal-only moveset against a GASTLY prices every attack
  // at nothing, and picking by the scaled number would empty the pool and
  // fall back to slot order -- which is how a grind came to choose GROWL.
  const { tasks } = pilot({ rom: typedRom() });
  const rattata = { moves: [33, 45, 0, 0], pp: [35, 40, 0, 0] };
  t.eq(tasks.strongest([0, 1], rattata, [GHOST, GHOST]), 0,
       'Tackle, which does nothing, rather than Growl, which does less');
});

test('fightBattle hands the chooser both sides of the matchup', async (t) => {
  // The wiring, not the function -- the same shape of gap as the first draft
  // of the "hardest move" tests, which passed with the argument removed from
  // `fightBattle` entirely. The enemy is a Bug, so a chooser that was told so
  // picks Tackle and one that was not picks Razor Leaf.
  const { tasks } = pilot({ rom: typedRom() });
  const party = [{ slot: 0, species: 152, level: 13, hp: 36, maxHp: 36,
                   moves: [33, 45, 75, 0], pp: [35, 40, 25, 0] }];
  const inBattle = { party, inBattle: true, menu: [1, 1], menuItems: 34,
                     menuTop: 12, worldLoaded: true, windowOpen: true,
                     enemy: { species: 10, level: 3, hp: 10, maxHp: 10,
                              types: [BUG, BUG] },
                     active: { hp: 36, maxHp: 36, types: [FIRE, FIRE] } };
  let asked = null, turns = 0;
  tasks.coverFaint = async () => null;
  tasks.awaitBattleMenu = async () => inBattle;
  tasks.chooseAction = async () => {};
  tasks.step = async () => {};
  tasks.pump = async () => {};
  tasks.snap = async () => (turns > 0 ? { ...inBattle, inBattle: false } : inBattle);
  tasks.chooseMove = async (mon, prefer) => {
    asked = prefer(mon.moves.map((_, i) => i).filter((i) => mon.moves[i]), mon);
    turns++;
    return 0;
  };
  await tasks.fightBattle(2);
  t.eq(asked, 0, 'Tackle — so the Bug reached the chooser');

  // And the other half of the wiring: the same Bug, and a Grass mon holding
  // the Razor Leaf. The bonus is 41.25 against Tackle's 35, so a chooser told
  // what it *is* swings the leaf and one told only what it faces does not.
  const mine = { ...inBattle, active: { hp: 36, maxHp: 36, types: [GRASS, GRASS] } };
  asked = null; turns = 0;
  tasks.awaitBattleMenu = async () => mine;
  tasks.snap = async () => (turns > 0 ? { ...mine, inBattle: false } : mine);
  await tasks.fightBattle(2);
  t.eq(asked, 2, 'Razor Leaf — so its own types reached the chooser too');
});

test('weakening something for a ball asks the same question backwards',
     async (t) => {
  // `chip` wants the *softest* real hit, and the mirror of the ranking bug is
  // here: against a GRASS target, Ember at 40 doubled hits harder than Razor
  // Leaf at 55 halved, so the smaller number is the bigger hit and picking it
  // knocks out the thing being caught.
  const { tasks } = pilot({ rom: typedRom() });
  const mon = { moves: [52, 75, 0, 0], pp: [25, 25, 0, 0] };
  const picked = await pickedByChip(tasks, mon, [GRASS, GRASS]);
  t.eq(picked, 1, 'Razor Leaf, which is 55 and does less to a Grass than 40 does');
});

test('and it will not weaken something with a move that cannot touch it',
     async (t) => {
  // The gentlest imaginable move is one the target is immune to, and it
  // weakens it forever: a Normal-only lead chipping a GASTLY threw balls at
  // full health until the budget ran out.
  const { tasks } = pilot({ rom: typedRom() });
  const mon = { moves: [33, 52, 0, 0], pp: [35, 25, 0, 0] };
  t.eq(await pickedByChip(tasks, mon, [GHOST, GHOST]), 1,
       'Ember, because Tackle is not a gentle hit, it is no hit');
  // Ember at 40 is the softer hit against something Normal, because Tackle is
  // Normal too and the same-type bonus makes it 52.5. Which is the point: the
  // softest *hit*, not the smallest number.
  t.eq(await pickedByChip(tasks, mon, [NORMAL, NORMAL]), 1,
       'Ember, once the bonus on Tackle is counted');
});

/** Run `chip` far enough to see which slot its preference picks. */
async function pickedByChip(tasks, mon, types) {
  const menu = { party: [{ slot: 0, hp: 20, maxHp: 20, ...mon }],
                 inBattle: true, menu: [1, 1], menuItems: 34, menuTop: 12,
                 enemy: { species: 92, level: 5, hp: 20, maxHp: 20, types },
                 active: { hp: 20, maxHp: 20, types: [NORMAL, NORMAL] } };
  let picked = null;
  tasks.awaitBattleMenu = async () => menu;
  tasks.chooseAction = async () => {};
  tasks.step = async () => {};
  tasks.pump = async () => {};
  tasks.push = async () => {};
  tasks.snap = async () => menu;
  tasks.chooseMove = async (m, prefer) => {
    picked = prefer(m.moves.map((_, i) => i).filter((i) => m.moves[i]), m);
    return picked;
  };
  await tasks.chip();
  return picked;
}

test('the log says what the chart thought, and only when there is something',
     async (t) => {
  const { tasks } = pilot({ rom: typedRom() });
  t.eq(tasks.movePicked(52, [GRASS, GRASS]), 'EMBER — super effective',
       'named, because the cartridge knows its name');
  t.eq(tasks.movePicked(75, [BUG, BUG]), 'RAZOR LEAF — not very effective',
       'and the other way');
  t.eq(tasks.movePicked(33, [GHOST, GHOST]), 'TACKLE — no effect on this one',
       'and the one worth saying loudest');
  t.eq(tasks.movePicked(33, [NORMAL, NORMAL]), '',
       'a neutral hit is the ordinary case and buries the log');
  t.eq(tasks.movePicked(33, null), '', 'and so does one nobody can price');
  const { tasks: blind } = pilot({ rom: null });
  t.eq(blind.movePicked(33, [GHOST, GHOST]), '', 'no cartridge, nothing to say');
});


// --- the one question the battle loop must not answer with A ----------------

test('the delete-a-move box is told apart from everything else drawn',
     async (t) => {
  // Measured by grinding a Chikorita from Lv5 on Route 29 and recording every
  // snapshot the battle loop took. At the instant its moveset went from
  // [TACKLE, GROWL, RAZOR LEAF, REFLECT] to [POISONPOWDER, GROWL, RAZOR LEAF,
  // REFLECT] the box read items=2, top=7, cursor (1,1), still in battle.
  const box = (over) => ({ windowOpen: true, inBattle: true, menuItems: 2,
                           menuTop: 7, menu: [1, 1], ...over });
  t.true(learnMoveBox(box(), gen2), 'two items at row seven, in a battle');

  // The three other things that get drawn during a battle, none of which is a
  // question: the battle menu, the pack, and the pack mid-throw -- which is
  // also two items, and is the reason the row matters rather than the count.
  t.false(learnMoveBox(box({ menuItems: 34, menuTop: 12 }), gen2),
          'the battle menu is not it');
  t.false(learnMoveBox(box({ menuItems: 5, menuTop: 1 }), gen2),
          'nor the pack');
  t.false(learnMoveBox(box({ menuTop: 0 }), gen2),
          'nor the pack mid-throw, which is two items at row zero');

  t.false(learnMoveBox(box({ windowOpen: false }), gen2),
          'and a stale signature with no window up is not a box');
  t.false(learnMoveBox(box({ inBattle: false }), gen2),
          'nor anything outside a battle');
  t.false(learnMoveBox(box(), null),
          'a cartridge whose engine says nothing about it is never matched');
});

test('a cartridge that moved the box is matched where it moved it', async (t) => {
  // The reason this reads the engine off the instance rather than off a module
  // constant at import time -- which is what its neighbours in this file still
  // do, and what the first audit pass fixed in state.js.
  const moved = { ...gen2, learnMove: { items: 3, top: 9 } };
  const at = (items, top) => ({ windowOpen: true, inBattle: true,
                                menuItems: items, menuTop: top, menu: [1, 1] });
  t.true(learnMoveBox(at(3, 9), moved), 'the profile it was given');
  t.false(learnMoveBox(at(2, 7), moved), 'and not the stock one');
});

test('turning down a new move takes two answers, in the right order',
     async (t) => {
  // The model is the measured game. Gen 2 asks "delete an older move?" and
  // then, on a no, "give up on learning it?" -- and the second wants YES. Say
  // no to both and they loop: no to the second means carry on learning it, and
  // puts the first back on screen. Measured as four declines in a row with the
  // cursor walking 1, 2, 1, 2, 1, and the move replaced anyway once a stray A
  // from the turn presses landed on the delete prompt.
  const { tasks } = pilot();
  const game = { box: 'delete', cursor: 0, deleted: false, loops: 0 };
  tasks.step = async () => { if (game.cursor === 0) game.cursor = 1; };
  tasks.snap = async () => ({
    inBattle: true, windowOpen: game.box !== 'closed',
    menuItems: 2, menuTop: 7, menu: [1, game.cursor], party: [], worldLoaded: true,
  });
  tasks.push = async (button) => {
    if (game.box === 'closed') return;
    if (button === 'DOWN') { game.cursor = 2; return; }
    if (button === 'UP') { game.cursor = 1; return; }
    if (button !== 'A') return;
    if (game.box === 'delete') {
      if (game.cursor === 1) { game.deleted = true; game.box = 'closed'; }
      else { game.box = 'confirm'; game.cursor = 1; }
    } else if (game.box === 'confirm') {
      if (game.cursor === 1) game.box = 'closed';
      else { game.box = 'delete'; game.cursor = 1; game.loops++; }
    }
  };

  t.true(await tasks.declineNewMove(), 'it reports having dealt with the box');
  t.eq(game.box, 'closed', 'and the box is gone');
  t.false(game.deleted, 'with nothing deleted, which is the whole point');
  t.eq(game.loops, 0, 'and without going round the two questions even once');
});

test('a box that will not close is reported rather than pressed at for ever',
     async (t) => {
  // Everything in this file is bounded, for the reason the suite's own timeout
  // exists: a routine that cannot finish cannot fail, it hangs.
  const { tasks } = pilot();
  let presses = 0;
  tasks.step = async () => {};
  tasks.snap = async () => ({ inBattle: true, windowOpen: true, menuItems: 2,
                              menuTop: 7, menu: [1, 2], party: [], worldLoaded: true });
  tasks.push = async () => { presses++; };
  t.false(await tasks.declineNewMove(), 'it gives up and says so');
  // Three passes at the second question, each of which walks the cursor for up
  // to fourteen tries, plus the one that answered the first. The number is not
  // the point -- that it is a number at all is.
  t.true(presses <= 60, `bounded at ${presses} presses`);
});

// --- reaching for the bag before the thing on the field faints --------------

const POTION = 18, BERRY = 173;
const HEALS = ['berry', 'potion'];

/**
 * A pilot in a battle whose pack is a scripted state machine.
 *
 * The boxes are the ones measured on the cartridge — the pack at 5/1, USE/QUIT
 * at 2/7, the result written over 2/0 — because what is under test is whether
 * each is confirmed before anything is pressed into it.
 */
function fighting({ active = { hp: 6, maxHp: 21 }, pocket = [[POTION, 2]],
                    heals = 20, packOpens = true, useBox = true,
                    pickAction = () => {} } = {}) {
  const sym = symbols();
  const state = new GameState(sym);
  const gb = new FakeGameBoy({ wram: worldRam(sym, {}) });
  const tasks = new Tasks(gb, state, () => {},
                          fakeRom({ items: { 18: 'POTION', 173: 'BERRY' } }));
  const mon = { species: 155, level: 7, moves: [33, 0, 0, 0], pp: [35, 0, 0, 0], ...active };
  const bag = pocket.map(([id, n]) => [id, n]);
  const at = { box: 'battle', pocket: 0, item: bag.length ? bag[0][0] : 0xff, row: 1, linger: 0 };
  const log = [];
  const SHAPES = {
    battle: gen2.battleMenu,
    pack: gen2.battlePack ? { items: 5, top: 1 } : null,
    use: gen2.battlePack.use,
    applied: gen2.battlePack.applied,
  };
  tasks.step = async () => {};
  tasks.pump = async () => {};
  tasks.closeMenus = async () => { at.box = 'battle'; log.push('close'); return true; };
  tasks.snap = async () => {
    const shape = SHAPES[at.box] || { items: 0, top: 0 };
    return {
      ...state.read(worldRam(sym, { battleMode: 1, party: [mon], items: bag,
                                    enemy: { species: 16, level: 3, hp: 9, maxHp: 12 } })),
      windowOpen: at.box !== 'battle',
      menuItems: shape.items, menuTop: shape.top, menu: [1, at.row],
      curPocket: at.pocket, curItem: at.item,
    };
  };
  tasks.awaitBattleMenu = async () => { at.box = 'battle'; return tasks.snap(); };
  // `packOpens` may be a boolean or a function of how many times PACK has been
  // pressed, because a press swallowed by the turn's text is exactly what the
  // retry exists for.
  let packPresses = 0;
  tasks.chooseAction = async (which) => {
    log.push(`action ${which}`);
    pickAction(which);
    if (which !== gen2.battleAction.pack) return;
    const opens = typeof packOpens === 'function' ? packOpens(++packPresses) : packOpens;
    at.box = opens ? 'pack' : 'battle';
  };
  tasks._packMoved = async (button, of) => {
    log.push(button);
    if (button === 'RIGHT') at.pocket = (at.pocket + 1) % 4;
    if (button === 'DOWN') {
      const i = bag.findIndex(([id]) => id === at.item);
      at.item = i + 1 < bag.length ? bag[i + 1][0] : 0xff;
    }
    return tasks.snap();
  };
  tasks.push = async (b) => {
    log.push(b);
    if (b !== 'A') return;
    if (at.box === 'pack') { at.box = useBox ? 'use' : 'applied'; return; }
    if (at.box === 'use') { at.box = 'applied'; return; }
    if (at.box === 'applied') {
      if (heals && mon.hp < mon.maxHp) {
        mon.hp = Math.min(mon.maxHp, mon.hp + heals);
        const e = bag.find(([id]) => id === at.item);
        if (e && --e[1] <= 0) bag.splice(bag.indexOf(e), 1);
        // The box does *not* go away when the HP moves. Measured: it stayed at
        // 2/0 for three more presses before closing, which is why the loop
        // stops on the HP rather than on the window -- and why removing that
        // check has to fail a test.
        at.linger = 3;
        return;
      }
      if (at.linger > 0) { at.linger--; return; }
      at.box = 'battle';
    }
  };
  return { tasks, log, mon, bag, at };
}

test('a potion is used on whoever is on the field, and confirmed by the HP',
     async (t) => {
  // Measured on the cartridge at 9 of 21: PACK draws 5/1, the item draws
  // USE/QUIT at 2/7, confirming draws 2/0, and the HP moves on the press after
  // that -- while the pocket is not written back until the box closes. So HP is
  // the evidence, the same as in the field.
  const { tasks, mon, at } = fighting({ active: { hp: 6, maxHp: 21 } });
  const r = await tasks.useItemInBattle(POTION);
  t.true(r.ok, 'it healed');
  t.eq(r.gained, 15, 'up to full, and it says by how much');
  t.eq(mon.hp, 21, 'on the field');
  // It stopped on the HP rather than waiting the box out: the box was still
  // open, as it is on the cartridge for three more presses.
  t.true(at.linger > 0, 'and it did not tap on into whatever came next');
});

test('an item not in the bag is refused before the pack is opened', async (t) => {
  const { tasks, log } = fighting({ pocket: [[POTION, 1]] });
  const r = await tasks.useItemInBattle(BERRY);
  t.false(r.ok, 'refused');
  t.contains(r.message, 'not in the bag', 'and says why');
  t.eq(log.length, 0, 'nothing was pressed');
});

test('a swallowed PACK press is asked again, not given up on', async (t) => {
  // Measured, and it cost a knockout: three attempts in one battle came back
  // "the pack never opened" -- an accurate reading and a wrong conclusion. The
  // pack opens in under twenty frames, measured separately; what happens is the
  // A press landing while the turn's text is still running and vanishing.
  // Three of those spent the whole per-battle allowance, and the Pokémon fought
  // on at 4 of 18 and fainted.
  const { tasks, mon, log } = fighting({ packOpens: (n) => n >= 3 });
  const r = await tasks.useItemInBattle(POTION);
  t.true(r.ok, 'the third press landed and it healed');
  t.eq(mon.hp, 21, 'up to full');
  t.eq(log.filter((l) => l === 'action 3').length, 3, 'two eaten, one landed');
});

test('a pack that never opens is backed out to the battle menu', async (t) => {
  // Not `closeMenus`: that presses B until no window is open, and in a battle
  // the battle menu *is* a window that B will not close -- so it could only
  // ever exhaust its budget and report failure. The resting state in a battle
  // is the battle menu.
  const { tasks, log } = fighting({ packOpens: false });
  const r = await tasks.useItemInBattle(POTION);
  t.false(r.ok, 'it stopped');
  t.contains(r.message, 'never opened', 'naming what went wrong');
  t.eq(log.filter((l) => l === 'close').length, 0, 'and it did not call closeMenus');
  t.eq(log.filter((l) => l === 'action 3').length, 4,
       'having asked four times first');
});

test('the USE box is confirmed before it is confirmed', async (t) => {
  // The box after the item is USE/QUIT, and the two rows a mispress reaches in
  // the field version of this are GIVE and TOSS. Here the wrong box means the
  // press went somewhere unknown, and pressing on is how a pilot throws a ball
  // it did not mean to.
  const { tasks } = fighting({ useBox: false });
  const r = await tasks.useItemInBattle(POTION);
  t.false(r.ok, 'it stopped');
  t.contains(r.message, 'USE box never appeared', 'naming the box');
});

test('the ITEMS pocket is walked to, and the item within it', async (t) => {
  const { tasks, log, mon } = fighting({ pocket: [[BERRY, 1], [POTION, 1]] });
  const r = await tasks.useItemInBattle(POTION);
  t.true(r.ok, 'it got there');
  t.contains(log.join(' '), 'DOWN', 'past the berry to the potion');
  t.eq(mon.hp, 21, 'and used it');
});

test('the battle loop reaches for the bag before it swings', async (t) => {
  // A knockout takes half your money and puts you back at a Center, and the
  // grind's answer to one has always been to heal up and carry on -- after the
  // fact. The pilot was carrying potions through every one of them, because
  // nothing in this loop had ever opened the pack.
  const actions = [];
  const { tasks, mon } = fighting({ active: { hp: 6, maxHp: 21 },
                                    pickAction: (w) => actions.push(w) });
  tasks._outcome = async () => 'won';
  // One turn: after the item is used the loop comes round, HP is full, and
  // FIGHT is chosen. Ending the battle then stops it.
  let turns = 0;
  const realSnap = tasks.snap;
  tasks.snap = async () => {
    const s = await realSnap();
    return turns++ > 6 ? { ...s, inBattle: false } : s;
  };
  await tasks.fightBattle(3, { heals: HEALS });
  t.eq(actions[0], gen2.battleAction.pack, 'the pack came first');
  t.eq(mon.hp, 21, 'and the thing on the field was mended');
});

test('a healthy Pokémon is not given a potion', async (t) => {
  const actions = [];
  const { tasks, bag } = fighting({ active: { hp: 20, maxHp: 21 },
                                    pickAction: (w) => actions.push(w) });
  tasks._outcome = async () => 'won';
  let turns = 0;
  const realSnap = tasks.snap;
  tasks.snap = async () => {
    const s = await realSnap();
    return turns++ > 4 ? { ...s, inBattle: false } : s;
  };
  await tasks.fightBattle(2, { heals: HEALS });
  t.eq(actions[0], gen2.battleAction.fight, 'it swung');
  t.eq(bag[0][1], 2, 'and the potions are untouched');
});

test('without a list of healing items it fights exactly as it did', async (t) => {
  // The behaviour for twenty-three passes, and it has to stay the behaviour for
  // a cartridge nobody has described: an item name is content, and this file is
  // the engine.
  const actions = [];
  const { tasks, bag } = fighting({ active: { hp: 2, maxHp: 21 },
                                    pickAction: (w) => actions.push(w) });
  tasks._outcome = async () => 'won';
  let turns = 0;
  const realSnap = tasks.snap;
  tasks.snap = async () => {
    const s = await realSnap();
    return turns++ > 4 ? { ...s, inBattle: false } : s;
  };
  await tasks.fightBattle(2);
  t.eq(actions[0], gen2.battleAction.fight, 'FIGHT, as always');
  t.eq(bag[0][1], 2, 'and nothing spent');
});

test('one battle gets three potions and no more', async (t) => {
  // A fight that needs four is a fight that should have been run from, and
  // spending the bag on it is worse than losing it.
  const actions = [];
  const { tasks } = fighting({ active: { hp: 2, maxHp: 60 }, pocket: [[POTION, 9]],
                               heals: 1, pickAction: (w) => actions.push(w) });
  tasks._outcome = async () => 'won';
  await tasks.fightBattle(8, { heals: HEALS });
  const packs = actions.filter((w) => w === gen2.battleAction.pack).length;
  t.eq(packs, 3, 'three, then it fights on with what it has');
});

test('backing out presses nothing when the battle menu is already up',
     async (t) => {
  // The resting state in a battle. A B press into it is not free: it is a press
  // the game may read as something else on the next frame.
  const { tasks, log } = fighting();
  t.true(await tasks._backToBattleMenu(), 'already there');
  t.eq(log.length, 0, 'so nothing was pressed');
});

test('backing out of the pack presses until the battle menu is back', async (t) => {
  const { tasks, log, at } = fighting();
  at.box = 'use';
  // Two B presses to climb out of USE and the pack.
  tasks.push = async (b) => {
    log.push(b);
    if (b !== 'B') return;
    at.box = at.box === 'use' ? 'pack' : 'battle';
  };
  t.true(await tasks._backToBattleMenu(), 'it got back');
  t.eq(log.filter((l) => l === 'B').length, 2, 'two boxes, two presses');
});

test('pacing refuses to start with a menu open', async (t) => {
  // A directional press with a menu on screen moves a *cursor*, and this
  // presses four hundred of them. The pass before last, a menu left open by a
  // `closeMenus` that never checked turned this into four hundred presses
  // against the START menu -- after which the grind reported "no wild Pokémon
  // appeared -- are you standing in grass?" from a tile of tall grass. The
  // reading was confident and the diagnosis was wrong.
  const { tasks } = pilot();
  const pressed = [];
  const said = [];
  tasks.say = (m) => said.push(m);
  tasks.snap = async () => ({ windowOpen: true, inBattle: false });
  tasks.push = async (b) => pressed.push(b);
  t.eq(await tasks.paceUntilBattle(10), null, 'it declines');
  t.eq(pressed.length, 0, 'without a single press');
  t.contains(said.join(' '), 'a menu is open', 'and says why');
});

test('pacing with nothing open walks until something jumps out', async (t) => {
  const { tasks } = pilot();
  let steps = 0;
  const pressed = [];
  tasks.pump = async () => {};
  tasks.snap = async () => ({ windowOpen: false, inBattle: steps > 3, party: [] });
  tasks.push = async (b) => { pressed.push(b); steps++; };
  const got = await tasks.paceUntilBattle(50);
  t.true(!!got, 'it found a battle');
  t.true(pressed.length >= 4 && pressed.length < 50, 'after a few steps, not all of them');
});

// --- whiting out -------------------------------------------------------------

test('a lost battle is pressed through, so "lost" means the battle is over',
     async (t) => {
  // The measurement this exists for: the egg errand passes exactly one trainer,
  // and the log said "trainer battle: lost" **seven times**. One loss, reported
  // seven ways -- `lost` came back with the battle still on screen and not a
  // button pressed, so every caller that asks "are we in a battle?" was told
  // yes, fought it again, read the same wiped party and lost again.
  const { tasks } = pilot();
  const wiped = { inBattle: true, party: [{ hp: 0, maxHp: 30 }],
                  active: { hp: 0, maxHp: 30 }, menu: [1, 1] };
  let presses = 0;
  tasks.snap = async () => wiped;
  tasks.pump = async () => {};
  tasks.push = async () => { if (++presses >= 4) wiped.inBattle = false; };
  tasks.coverFaint = async () => 'lost';
  t.eq(await tasks.fightBattle(), 'lost', 'still a loss');
  t.false(wiped.inBattle, 'and the battle has actually ended');
  t.true(presses >= 4, 'because it pressed through the whiteout');
});

test('a whiteout that will not end is still called lost, not stuck', async (t) => {
  // Bounded, and it reports the same word either way: a whiteout this could not
  // sit through is still a whiteout, and trading a true answer for a vaguer one
  // helps nobody.
  const { tasks } = pilot();
  let presses = 0;
  tasks.snap = async () => ({ inBattle: true, party: [{ hp: 0, maxHp: 30 }],
                              active: { hp: 0, maxHp: 30 } });
  tasks.pump = async () => {};
  tasks.push = async () => { presses++; };
  tasks.coverFaint = async () => 'lost';
  t.eq(await tasks.fightBattle(), 'lost', 'the honest answer');
  t.true(presses > 20 && presses < 1000, 'after a bounded number of tries');
});

test('a wiped party found at the battle menu is pressed through too', async (t) => {
  // The other way `lost` is reached -- the menu comes up with nothing standing
  // -- and it had the same defect, which is why the fix is one helper and not
  // one branch.
  const { tasks } = pilot();
  const wiped = { inBattle: true, party: [{ hp: 0, maxHp: 30 }],
                  active: { hp: 5, maxHp: 30 } };
  let presses = 0;
  tasks.snap = async () => wiped;
  tasks.pump = async () => {};
  tasks.push = async () => { if (++presses >= 3) wiped.inBattle = false; };
  tasks.coverFaint = async () => null;
  tasks.awaitBattleMenu = async () => ({ party: [{ hp: 0, maxHp: 30 }] });
  t.eq(await tasks.fightBattle(), 'lost', 'a loss');
  t.false(wiped.inBattle, 'and over');
});

test('a battle nothing carried can touch is its own dead end', async (t) => {
  // A different question from PP, and invisible to the one that asks it: the
  // move has power, so `canStillWin` says yes, and the type chart says the
  // swing takes nothing off. A Normal-only moveset facing a GASTLY swings for
  // forty turns while the enemy's HP does not move, and the loop reports
  // 'stuck' — which is true and says nothing anybody can act on.
  const { tasks } = pilot({ rom: typedRom() });
  const normalOnly = { moves: [33, 45, 0, 0], pp: [35, 40, 0, 0] };
  t.true(tasks.nothingLands(normalOnly, [GHOST, GHOST]),
         'Tackle is the only attack, and it does nothing to a Ghost');
  t.false(tasks.nothingLands(normalOnly, [NORMAL, NORMAL]),
          'against something it can hit, it can hit');

  const withFire = { moves: [33, 52, 0, 0], pp: [35, 25, 0, 0] };
  t.false(tasks.nothingLands(withFire, [GHOST, GHOST]),
          'one move that lands is enough, whichever slot it is in');
  t.true(tasks.nothingLands({ moves: [33, 52, 0, 0], pp: [35, 0, 0, 0] },
                            [GHOST, GHOST]),
         'and it has to have PP: with the Ember spent, nothing lands again');
});

test('cannot tell is not the same as cannot touch', async (t) => {
  // The rule the whole app is built on, in the one place where breaking it
  // would stand the pilot still: with no chart, or no types to price against,
  // every move is worth swinging.
  const { tasks } = pilot({ rom: typedRom() });
  const normalOnly = { moves: [33, 45, 0, 0], pp: [35, 40, 0, 0] };
  t.false(tasks.nothingLands(normalOnly, null), 'no types, keep swinging');
  const { tasks: blind } = pilot({ rom: null });
  t.false(blind.nothingLands(normalOnly, [GHOST, GHOST]),
          'and no cartridge, the same');
  t.false(tasks.nothingLands({ moves: [45, 0, 0, 0], pp: [40, 0, 0, 0] },
                             [GHOST, GHOST]),
          'a moveset with nothing but status moves is a PP question, not this one');
});

test('the loop hands that word back rather than pressing on to stuck',
     async (t) => {
  const { tasks } = pilot({ rom: typedRom() });
  const party = [{ slot: 0, species: 19, level: 9, hp: 20, maxHp: 20,
                   moves: [33, 45, 0, 0], pp: [35, 40, 0, 0] }];
  const menu = { party, inBattle: true, menu: [1, 1], menuItems: 34,
                 menuTop: 12, worldLoaded: true, windowOpen: true,
                 enemy: { species: 92, level: 5, hp: 20, maxHp: 20,
                          types: [GHOST, GHOST] },
                 active: { hp: 20, maxHp: 20, types: [NORMAL, NORMAL] } };
  let swings = 0;
  tasks.coverFaint = async () => null;
  tasks.awaitBattleMenu = async () => menu;
  tasks.chooseAction = async () => { swings++; };
  tasks.step = async () => {};
  tasks.pump = async () => {};
  tasks.push = async () => {};
  tasks.snap = async () => menu;
  t.eq(await tasks.fightBattle(2), 'notouch', 'the word, first time round');
  t.eq(swings, 0, 'and not one swing spent finding out');
});

// --- four guards the mutation run found nothing standing behind ------------

test('the Pokémon on the field is the one on the field at 1 HP', async (t) => {
  // `onField` falls back to the first party member that is still standing,
  // and "standing" is above zero. Read it as above one and a Pokémon on its
  // last hit point is stepped over — so every move the pilot then reasons
  // about belongs to the Pokémon *behind* it, which is not the one whose
  // moves the menu is showing.
  const nearly = { slot: 0, hp: 1, maxHp: 24, moves: [33], pp: [10] };
  const behind = { slot: 1, hp: 20, maxHp: 20, moves: [52], pp: [10] };
  t.eq(onField({ party: [nearly, behind] }).slot, 0,
       'one hit point is still on the field');
  t.eq(onField({ party: [{ ...nearly, hp: 0 }, behind] }).slot, 1,
       'and none at all is not');
});

test('a move that computes its damage can still win a battle', async (t) => {
  // The eleven moves that lie about their power store 0 or 1, and `canStillWin`
  // asks whether the power is above zero rather than above one for exactly
  // that reason: HORN DRILL reads 1 and ends battles. Read it as above one and
  // a Pokémon holding nothing else is declared unable to win, which sends a
  // grind to a Center it does not need and stops it there.
  const { tasks } = pilot();
  t.true(tasks.canStillWin({ moves: [32, 0, 0, 0], pp: [5, 0, 0, 0] }),
         'Horn Drill at power 1 counts');
  t.false(tasks.canStillWin({ moves: [43, 0, 0, 0], pp: [30, 0, 0, 0] }),
          'Leer at power 0 does not');
});

test('the move menu has to be drawn before a move is aimed at', async (t) => {
  // Cursor row 0 means the move menu is not up — most often the message
  // refusing the move just picked is still on screen. Pressing into that
  // re-picks the refused move, which is the eighty-four "battles" in one
  // grind that were the same refusal over and over.
  const { tasks } = pilot({ rom: typedRom() });
  const party = [{ slot: 0, species: 155, level: 9, hp: 20, maxHp: 20,
                   moves: [33, 52, 0, 0], pp: [35, 25, 0, 0] }];
  const noMenu = { party, inBattle: true, menu: [1, 0], menuItems: 34,
                   menuTop: 12, worldLoaded: true, windowOpen: true,
                   enemy: { species: 16, level: 3, hp: 10, maxHp: 10,
                            types: [NORMAL, NORMAL] },
                   active: { hp: 20, maxHp: 20, types: [FIRE, FIRE] } };
  let asked = 0, turns = 0;
  tasks.coverFaint = async () => null;
  tasks.awaitBattleMenu = async () => noMenu;
  tasks.chooseAction = async () => {};
  tasks.step = async () => {};
  tasks.pump = async () => {};
  tasks.push = async () => {};
  tasks.snap = async () => (turns++ > 2 ? { ...noMenu, inBattle: false } : noMenu);
  tasks.chooseMove = async () => { asked++; return 0; };
  await tasks.fightBattle(1);
  t.eq(asked, 0, 'nothing was aimed at a menu that is not there');
});

test('a caught Pokémon is a party that grew, not a party that is the same size',
     async (t) => {
  // The evidence for a catch is one more party member than there was. Read as
  // "at least as many" and the very first poll after the throw reports
  // caught — before the ball has finished animating, and whether or not it
  // held.
  const { tasks } = pilot();
  const party = [{ slot: 0, hp: 20, maxHp: 20, moves: [33], pp: [10] }];
  const stillOne = { party, inBattle: true, menu: [1, 1], menuItems: 34,
                     menuTop: 12, windowOpen: true,
                     enemy: { species: 16, level: 3, hp: 10, maxHp: 10 },
                     active: { hp: 20, maxHp: 20 } };
  tasks.step = async () => {};
  tasks.pump = async () => {};
  tasks.push = async () => {};
  tasks.screenSays = async () => false;
  tasks.snap = async () => stillOne;
  t.eq(await tasks.watchThrow(1), 'broke free',
       'one party member where there was one is not a catch');
  const grew = { ...stillOne, party: [...party, { slot: 1, hp: 9, maxHp: 9 }] };
  tasks.snap = async () => grew;
  t.eq(await tasks.watchThrow(1), 'caught', 'two where there was one is');
});

test('the line about the chart is said for the move in slot one too',
     async (t) => {
  // Slot indices are zero-based and the log guard is `>= 0`, which is the
  // difference between saying something about every move and saying nothing
  // about the first one — and the first one is where a starter's best move
  // usually is.
  const { tasks, said } = pilot({ rom: typedRom() });
  const party = [{ slot: 0, species: 155, level: 9, hp: 20, maxHp: 20,
                   moves: [52, 33, 0, 0], pp: [25, 35, 0, 0] }];
  const menu = { party, inBattle: true, menu: [1, 1], menuItems: 34,
                 menuTop: 12, worldLoaded: true, windowOpen: true,
                 enemy: { species: 1, level: 5, hp: 20, maxHp: 20,
                          types: [GRASS, GRASS] },
                 active: { hp: 20, maxHp: 20, types: [FIRE, FIRE] } };
  let turns = 0;
  tasks.coverFaint = async () => null;
  tasks.awaitBattleMenu = async () => menu;
  tasks.chooseAction = async () => {};
  tasks.step = async () => {};
  tasks.pump = async () => {};
  tasks.push = async () => {};
  tasks.snap = async () => (turns > 0 ? { ...menu, inBattle: false } : menu);
  tasks.chooseMove = async (mon, prefer) => { turns++; return prefer([0, 1], mon); };
  await tasks.fightBattle(1);
  t.true(said.some((l) => l === 'EMBER — super effective'),
         `slot one's move was named: ${JSON.stringify(said)}`);
});
