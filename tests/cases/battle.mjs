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
  const tasks = new Tasks(gb, state, () => {},
                          rom === undefined ? fakeRom() : rom);
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
