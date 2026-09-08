// Choosing where to heal, which is arithmetic rather than map knowledge.
//
// This moved out of the Crystal file when titles became data, and moving it
// made it testable: the places come from a title object, and everything else is
// a sum over the map graph that can be handed stubs. It had never been tested
// before, and it is the piece most likely to be quietly wrong -- a cost model
// that picks the wrong Center costs a minute of walking and looks like a bug in
// the walk.
import { FakeGameBoy, fakeRom, symbols, test, worldRam } from '../harness.mjs';
import { GameState } from '../../gen2/state.js';
import { Journey } from '../../gen2/journey.js';

const sym = symbols();

const HOME = 1, NEAR = 2, FAR = 3;

/** A Journey with the map graph and the decode stubbed out. */
function walker({ routes = {}, at = [5, 5], size = [60, 20], title = {},
                  world: game = { party: [{ hp: 4, maxHp: 20 }] } } = {}) {
  const gb = new FakeGameBoy({ wram: worldRam(sym, game) });
  const collision = {
    off: 0,
    calibrate: () => true,
    playerPos: () => at,
    mapSize: () => size,
  };
  const world = { route: (from, to) => (to in routes ? routes[to] : null) };
  const nav = { mapKey: async () => HOME };
  const j = new Journey(gb, new GameState(sym), null, collision, nav,
                        () => {}, world, title);
  j.reached = [];
  j.healAtNear = async () => { j.reached.push('near'); return true; };
  j.healAtFar = async () => { j.reached.push('far'); return true; };
  return j;
}

test('a cartridge with no healers cannot heal, and says so', async (t) => {
  const j = walker({ title: {} });
  t.eq(await j.nearestHeal(HOME), null, 'nothing to choose between');

  const said = await j.healNow();
  t.false(said.ok, 'healing refuses rather than walking hopefully');
  t.contains(said.message, 'nowhere to heal', 'and the message says which');
});

test('standing where the healing is costs nothing', async (t) => {
  const title = { healers: [{ map: NEAR, reach: 'healAtNear' }], legCost: 25 };
  const j = walker({ title, routes: {} });
  const pick = await j.nearestHeal(NEAR);
  t.eq(pick.map, NEAR, 'the one under our feet');
  t.eq(pick.cost, 0, 'and no route to price');
});

test('the nearer healer is the cheaper one in tiles, not in legs',
     async (t) => {
  // The whole reason this is not a leg count. FAR is two legs away but its
  // route leaves by an edge three tiles from the player; NEAR is one leg away
  // and leaves by an edge fifty-five tiles away, across a whole route.
  const title = {
    healers: [{ map: FAR, reach: 'healAtFar' },
              { map: NEAR, reach: 'healAtNear' }],
    legCost: 25,
  };
  const j = walker({
    at: [3, 5], size: [60, 20],
    title,
    routes: {
      [FAR]: [{ kind: 'edge', dir: 'LEFT' }, { kind: 'edge', dir: 'UP' }],
      [NEAR]: [{ kind: 'edge', dir: 'RIGHT' }],
    },
  });
  const pick = await j.nearestHeal(HOME);
  t.eq(pick.map, FAR, 'two legs beats one when the first edge is next to you');
  t.eq(pick.cost, 28, 'one further leg at 25, plus 3 tiles to the edge');

  await pick.heal();
  t.eq(j.reached.join(','), 'far', '`reach` dispatches to the title\'s method');
});

test('a leg whose entry point cannot be measured is charged flat', async (t) => {
  const title = { healers: [{ map: NEAR, reach: 'healAtNear' }], legCost: 25 };
  // A warp rather than an edge: there is no "how far to the door" to read off
  // the collision map from here, so the leg costs what any further leg costs.
  const j = walker({ title, routes: { [NEAR]: [{ kind: 'warp' }] } });
  t.eq((await j.nearestHeal(HOME)).cost, 0,
       'one leg is zero further legs, and a warp adds no measurable tiles');
});

test('with no map graph, the last healer is the answer', async (t) => {
  const title = {
    healers: [{ map: FAR, reach: 'healAtFar' }, { map: NEAR, reach: 'healAtNear' }],
  };
  const j = walker({ title });
  j.world = null;
  const pick = await j.nearestHeal(HOME);
  t.eq(pick.map, NEAR, 'titles list their most general healer last');
  t.eq(pick.cost, undefined, 'and nothing was priced');
});

test('a map with no name is still named', async (t) => {
  const j = walker({ title: { names: { [24 * 256 + 3]: 'Route 29' } } });
  t.eq(j.where(24 * 256 + 3), 'Route 29', 'the title supplies what it knows');
  t.eq(j.where(99 * 256 + 7), 'map 99.7', 'and the engine names the rest');
  t.eq(walker({ title: {} }).where(26 * 256 + 1), 'map 26.1',
       'including when a title supplies no names at all');
});

test('Stop lands inside a script, not after 400 taps of it', async (t) => {
  // runScripts presses through this.gb rather than through TaskBase.push, so it
  // gets none of the cancellation every other pressing loop is handed for free.
  // Checked only on the way in, Stop was ignored for the rest of a scene it was
  // pressed in the middle of -- and by its own account that is the longest loop
  // in the file, about 190 taps for Mom's.
  let taps = 0;
  const cancel = { cancelled: false, pump: async () => {} };
  const gb = new FakeGameBoy({ wram: worldRam(sym, {}) });
  gb.press = async () => { taps++; if (taps === 3) cancel.cancelled = true; };
  gb.run = async () => {};
  const j = new Journey(gb, new GameState(sym), cancel, null, null, () => {}, null, {});
  j.scriptRunning = async () => true;          // a scene that never ends
  t.false(await j.runScripts(), 'it reports having been stopped');
  t.true(taps < 10, `it stopped pressing at once — ${taps} taps, not 400`);
});

test('a script that finishes is still reported as finished', async (t) => {
  const gb = new FakeGameBoy({ wram: worldRam(sym, {}) });
  gb.press = async () => {};
  gb.run = async () => {};
  const j = new Journey(gb, new GameState(sym), { cancelled: false, pump: async () => {} },
                        null, null, () => {}, null, {});
  j.scriptRunning = async () => false;
  t.true(await j.runScripts(), 'the quiet case is unchanged');
});

// --- where the interface can offer to walk ----------------------------------

/** A Journey whose graph answers routesFrom, which is what placesFrom asks. */
function traveller({ reachable = {}, names = null } = {}) {
  const gb = new FakeGameBoy({ wram: worldRam(sym, {}) });
  const world = {
    routesFrom: (from, targets) => new Map(
      [...targets].filter((k) => k !== from && k in reachable)
        .map((k) => [k, new Array(reachable[k]).fill({ kind: 'edge' })])),
  };
  return new Journey(gb, new GameState(sym), null, null, { mapKey: async () => HOME },
                     () => {}, world, names === null ? {} : { names });
}

test('the places offered are the named ones the graph can reach', async (t) => {
  const j = traveller({
    names: { [HOME]: 'here', [NEAR]: 'Cherrygrove City', [FAR]: 'Route 30', 9: 'Mahogany' },
    reachable: { [NEAR]: 2, [FAR]: 1 },      // Mahogany is not reachable at all
  });
  const places = j.placesFrom(HOME);
  t.eq(places.map((p) => p.name), ['Route 30', 'Cherrygrove City'],
       'nearest first, and only what can be reached');
  t.eq(places.map((p) => p.legs), [1, 2], 'with the cost that ordered them');
  t.false(places.some((p) => p.key === HOME), 'never the map you are standing on');
  t.false(places.some((p) => p.name === 'Mahogany'),
          'and never a place the graph cannot get to');
});

test('a cartridge nobody has described offers nowhere, rather than numbers',
     async (t) => {
  // The same rule the scripted intro and the ball errand follow: a title that
  // declares nothing does not get a row full of `map 26.4`.
  const j = traveller({ names: null, reachable: { [NEAR]: 1 } });
  t.eq(j.placesFrom(HOME), [], 'no names, no list');

  // And a half-described one offers exactly what it wrote down.
  const half = traveller({ names: { [NEAR]: 'the only place I named' },
                           reachable: { [NEAR]: 1, [FAR]: 1 } });
  t.eq(half.placesFrom(HOME).map((p) => p.name), ['the only place I named'],
       'one name, one offer');
});

test('a title that names only where you stand offers nothing', async (t) => {
  const j = traveller({ names: { [HOME]: 'here' }, reachable: { [NEAR]: 1 } });
  t.eq(j.placesFrom(HOME), [], 'the one name it has is the map under your feet');
});

test('with no map graph there is nowhere to offer either', async (t) => {
  const gb = new FakeGameBoy({ wram: worldRam(sym, {}) });
  const j = new Journey(gb, new GameState(sym), null, null,
                        { mapKey: async () => HOME }, () => {}, null,
                        { names: { [NEAR]: 'Cherrygrove City' } });
  t.eq(j.placesFrom(HOME), [], 'a title with names but no world knows no routes');
});

// --- taking what the map is holding ------------------------------------------

/**
 * A Journey standing on a map with things on it, and a scripted walk.
 *
 * `open` says which tiles can be stood on, `pocket` is the bag as the game will
 * report it after each press, and every walk and press is recorded. What is
 * under test is the *choosing* -- which side to approach from, how many times to
 * try, and what to call the result -- so the pressing is stubbed.
 */
function collector({ things = [], open = () => true, gives = () => [],
                     walkFails = () => null, at = [5, 5] } = {}) {
  const sym = symbols();
  const pocket = [];
  const gb = new FakeGameBoy({ wram: worldRam(sym, {}) });
  const log = [];
  const collision = {
    off: 0,
    calibrate: () => true,
    playerPos: () => at,
    mapSize: () => [60, 20],
    walkable: (x, y) => open(x, y),
    takeables: () => things,
  };
  const nav = {
    mapKey: async () => 1,
    walkTo: async (_c, to) => {
      log.push(`walk ${to[0]},${to[1]}`);
      const bad = walkFails(to);
      if (!bad) { at = [...to]; return { stopped: null }; }
      return { stopped: bad };
    },
    step: async (dir) => { log.push(`face ${dir}`); return { blocked: false }; },
  };
  const j = new Journey(gb, new GameState(sym), null, collision, nav, () => {},
                        { route: () => null }, {});
  j.log = log;
  j.said = [];
  j.say = (m) => j.said.push(m);
  j.settled = async () => gb.wram;
  j.escapeBattle = async () => true;
  j.runScripts = async () => {};
  j.itemName = (id) => `ITEM ${id}`;
  j.snap = async () => ({ items: pocket.map((id) => [id, 1]), balls: [] });
  j.gb = { press: async () => { for (const id of gives(at)) pocket.push(id); } };
  return j;
}

test('a thing with a wall under it is approached from the side that is open',
     async (t) => {
  // The defect this replaced. `pickUp` stood on the tile *below* and pressed
  // UP, which works for Route 31's ball and is a rule about nothing: the item
  // ball at (8,35) on Route 30 has a wall under it, so the walk failed and the
  // old code pressed A wherever it had stopped. Approaching from above and
  // facing DOWN is what put an ANTIDOTE in the bag.
  const j = collector({
    open: (x, y) => !(x === 8 && y === 36),        // the tile below is a wall
    gives: (at) => (at[0] === 8 && at[1] === 34 ? [11] : []),
  });
  t.eq(await j.pickUp([8, 35]), null, 'it got there');
  t.contains(j.log.join(' | '), 'walk 8,34', 'from above');
  t.contains(j.log.join(' | '), 'face DOWN', 'facing back down at it');
});

test('a berry counts as having picked something up', async (t) => {
  // It reported "the ball would not go in the bag" with the berry in the
  // pocket, because it decided by looking at the balls -- the pocket next door
  // to the one it had read since the beginning.
  const j = collector({ gives: () => [7] });
  t.eq(await j.pickUp([4, 4]), null, 'a non-ball is still something');
});

test('a thing nothing can reach is reported rather than pressed at', async (t) => {
  const j = collector({ open: () => false });
  t.contains(await j.pickUp([4, 4]), 'could not get to it', 'it says which');
  t.eq(j.log.filter((l) => l.startsWith('face')).length, 0, 'and never pressed');
});

test('a battle on the way is asked again, not given up on', async (t) => {
  // Measured: the first press of Take on Route 29 -- thirty-five tiles of grass
  // between the two things it wanted -- came back with neither, because one
  // battle ended the approach. Each walk gets partway before something jumps
  // out, so asking again from where it stopped converges.
  // Exactly one open side, so re-asking is the only way through: with four to
  // choose from, moving on to the next side hides a retry that never happens.
  let battles = 2, escapes = 0;
  const j = collector({
    open: (x, y) => x === 4 && y === 5,
    walkFails: () => (battles-- > 0 ? 'battle' : null),
    gives: () => [11],
  });
  j.escapeBattle = async () => { escapes++; return true; };
  t.eq(await j.pickUp([4, 4]), null, 'it got there on the third ask');
  t.eq(j.log.filter((l) => l === 'walk 4,5').length, 3,
       'the same side asked three times, not three different sides');
  t.eq(escapes, 3, 'and each ask escaped whatever was on screen first');

  // Two battles is not the bound. A walk that keeps being interrupted has to
  // run out eventually, and say so rather than looping.
  let forever = 99;
  const stuck = collector({
    open: (x, y) => x === 4 && y === 5,
    walkFails: () => (forever-- > 0 ? 'battle' : null),
  });
  t.contains(await stuck.pickUp([4, 4]), 'could not get to it', 'it gives up saying which');

  // And a battle must not send it to the *other* side of the same thing. The
  // battle is still on screen, so that walk would fail too -- the way out is up
  // a level, where the escape is.
  let first = true;
  const two = collector({
    at: [4, 6],
    open: (x, y) => (x === 4 && y === 5) || (x === 4 && y === 3),
    walkFails: () => { const bad = first; first = false; return bad ? 'battle' : null; },
    gives: () => [11],
  });
  const order = [];
  two.escapeBattle = async () => { order.push('escape'); return true; };
  const realWalk = two.nav.walkTo;
  two.nav.walkTo = async (c, to) => { order.push(`walk ${to[1]}`); return realWalk(c, to); };
  await two.pickUp([4, 4]);
  t.eq(order[0], 'escape', 'it escapes before the first walk');
  t.eq(order[2], 'escape', 'and again before the second, rather than trying the far side');
});

test('taking everything here reports what arrived, by name', async (t) => {
  const j = collector({
    things: [{ x: 10, y: 4, what: 'ball' }, { x: 4, y: 4, what: 'tree' }],
    gives: (at) => (at[0] === 4 && at[1] === 5 ? [7] : [11]),
  });
  const r = await j.takeHere();
  t.true(r.ok, 'it worked');
  t.eq(r.got.length, 2, 'both');
  t.contains(r.message, 'ITEM 7', 'named');
  t.contains(j.said.join(' | '), 'picked up', 'and said at the time');
});

test('the nearest thing is taken first', async (t) => {
  const j = collector({
    at: [5, 5],
    things: [{ x: 40, y: 4, what: 'ball' }, { x: 6, y: 5, what: 'tree' }],
    gives: () => [7],
  });
  await j.takeHere();
  // The walk goes to a *side* of the thing, so this asserts on which thing was
  // approached rather than on the tile: (5,5) and (7,5) are sides of the tree
  // at (6,5), and anything near x=40 is the far ball.
  const first = j.log.find((l) => l.startsWith('walk'));
  t.true(Number(first.split(' ')[1].split(',')[0]) < 10,
         'the one six tiles away, not the one thirty-five');
});

test('a ball already taken is an ordinary outcome, not a failure', async (t) => {
  // The object stays in work RAM once the item is in the bag -- measured, the
  // ball at (8,35) was still there with the ANTIDOTE carried -- so the row goes
  // on offering it. Painting that red says something went wrong when nothing
  // did.
  const j = collector({ things: [{ x: 4, y: 4, what: 'ball' }], gives: () => [] });
  const r = await j.takeHere();
  t.true(r.ok, 'it is not a failure');
  t.contains(r.message, 'nothing left to take here', 'and it says which');
  t.eq(r.missed, 0, 'nothing was out of reach');
});

test('a thing that could not be reached is a failure, and is counted',
     async (t) => {
  const j = collector({ things: [{ x: 4, y: 4, what: 'ball' }], open: () => false });
  const r = await j.takeHere();
  t.false(r.ok, 'this one really did go wrong');
  t.contains(r.message, 'could not get to 1', 'and says how many');
});

test('a map with nothing on it says so instead of walking', async (t) => {
  const j = collector({ things: [] });
  const r = await j.takeHere();
  t.false(r.ok, 'nothing to do');
  t.eq(j.log.length, 0, 'and it did not move');
});

// --- healing out of the bag --------------------------------------------------

const ITEMS = { 18: 'POTION', 154: 'BERRY', 26: 'FULL RESTORE', 19: 'SUPER POTION',
                12: 'ANTIDOTE', 173: 'PSNCUREBERRY', 45: 'PARLYZ HEAL' };
const STOCK = ['berry', 'potion', 'super potion', 'full restore'];

const CURES = { psn: ['psncureberry', 'antidote', 'full heal'],
                par: ['przcureberry', 'parlyz heal', 'full heal'] };

/** A Journey whose party, bag and item use are scripted. */
function mender({ party = [{ hp: 10, maxHp: 40 }], items = [[18, 2]],
                  heals = STOCK, cures = CURES, gain = 20,
                  works = () => true } = {}) {
  const sym = symbols();
  const state = new GameState(sym);
  const gb = new FakeGameBoy({ wram: worldRam(sym, {}) });
  const mons = party.map((m, slot) => ({ species: 155, level: 5, slot, ...m }));
  const bag = items.map(([id, n]) => [id, n]);
  const used = [];
  const tasks = {
    rom: fakeRom({ items: ITEMS }),
    useItemOn: async (id, slot) => {
      used.push({ id, slot });
      if (!works({ id, slot })) return { ok: false, message: 'refused' };
      const e = bag.find(([b]) => b === id);
      if (e && --e[1] <= 0) bag.splice(bag.indexOf(e), 1);
      const mon = mons[slot];
      if (!mon) return { ok: false, message: 'no effect' };
      // A cure moves no HP at all: what it changes is the status byte. Which is
      // why `useItemOn` cannot judge on HP alone.
      const isCure = Object.values(cures || {}).some((names) =>
        names.includes((ITEMS[id] || '').toLowerCase()));
      if (isCure) {
        const gone = mon.status || [];
        mon.status = [];
        return { ok: gone.length > 0, gained: 0, cured: gone,
                 message: `cured ${gone.join(', ')}` };
      }
      if (mon.hp >= mon.maxHp) return { ok: false, message: 'no effect' };
      mon.hp = Math.min(mon.maxHp, mon.hp + gain);
      return { ok: true, gained: gain, cured: [], message: `+${gain} HP` };
    },
  };
  const j = new Journey(gb, state, tasks, { off: 0, calibrate: () => true,
                                            playerPos: () => [1, 1], mapSize: () => [10, 10] },
                        { mapKey: async () => 1 }, () => {}, { route: () => null },
                        { heals, cures });
  j.said = [];
  j.say = (m) => j.said.push(m);
  j.snap = async () => ({ party: mons.map((m) => ({ status: [], ...m })),
                          items: bag.map((b) => [...b]), inBattle: false });
  j.nameOf = (m) => `MON${m.slot}`;
  j.used = used;
  return j;
}

test('the bag mends the one nearest to fainting first', async (t) => {
  // A party of two at 3/40 and 38/40 has one member the next battle will lose
  // and one it will not.
  const j = mender({ party: [{ hp: 38, maxHp: 40 }, { hp: 3, maxHp: 40 }],
                     items: [[18, 4]] });
  const r = await j.healFromBag();
  t.true(r.ok, 'it mended somebody');
  t.eq(j.used[0].slot, 1, 'the one at 3 HP went first');
});

test('a fainted Pokémon is a Centre’s job, not a potion’s', async (t) => {
  // A Potion does nothing for a Pokémon at 0 HP in Gen 2, and the knockout is
  // the whole reason a grind walks to a Center.
  const j = mender({ party: [{ hp: 0, maxHp: 40 }], items: [[18, 2]] });
  const r = await j.healFromBag();
  t.false(r.ok, 'the bag is not offered as an answer');
  t.eq(j.used.length, 0, 'and nothing was spent finding out');
});

test('one potion is not always enough, and four is where it stops', async (t) => {
  const j = mender({ party: [{ hp: 4, maxHp: 100 }], items: [[18, 9]], gain: 20 });
  const r = await j.healFromBag();
  t.true(r.ok, 'it made progress');
  t.eq(j.used.length, 4, 'four goes at one Pokémon, then the walk can answer');
});

test('an item the pack would not use is dropped, not asked again', async (t) => {
  // A refusal is a *kind* of item this attempt cannot get at -- the pack would
  // not open, or the walk to it overshot -- so asking again with the same id is
  // how one failure becomes four.
  const j = mender({ party: [{ hp: 4, maxHp: 100 }], items: [[18, 9]],
                     works: () => false });
  const r = await j.healFromBag();
  t.false(r.ok, 'nothing was mended');
  t.eq(j.used.length, 1, 'asked once, with nine of them in the bag');
});

test('a refusal moves on to the next kind of item', async (t) => {
  // Measured on the cartridge: a BERRY was used, the pocket still listed it on
  // the next read, so the loop picked the berry again, walked past it in a pack
  // that no longer had it, and gave up -- leaving the Pokémon at 15 of 22 with
  // two potions in the bag.
  const j = mender({ party: [{ hp: 4, maxHp: 100 }], items: [[154, 1], [18, 2]],
                     works: ({ id }) => id !== 154 });
  const r = await j.healFromBag();
  t.true(r.ok, 'the potion was reached');
  t.eq(j.used.map((u) => u.id), [154, 18, 18], 'berry refused, then the potions');
});

test('a party at full health is not the bag’s business', async (t) => {
  const j = mender({ party: [{ hp: 40, maxHp: 40 }] });
  const r = await j.healFromBag();
  t.false(r.ok, 'nothing to do');
  t.contains(r.message, 'nothing the bag can mend', 'and it says so');
});

test('healNow spends the bag before it spends the walk', async (t) => {
  // The caller-level test, and it is here because its absence let a patch land
  // in the wrong method: the bag block went into `healUp` instead of `healNow`,
  // where `before` is not in scope. Every one of the tests above still passed.
  // The cartridge caught it in under a minute -- "off to heal: before is not
  // defined" -- which is not a substitute for a test that bites.
  const j = mender({ party: [{ hp: 10, maxHp: 40 }], items: [[18, 2]] });
  j.walked = 0;
  j.mapKey = async () => 1;
  j.nearestHeal = async () => ({ map: 2, heal: async () => true });
  j.healUp = async () => { j.walked++; return true; };
  const r = await j.healNow();
  t.true(r.ok, 'it healed');
  t.eq(j.walked, 0, 'and never walked');
  t.contains(r.message, 'out of the bag', 'saying which it was');
});

test('healNow walks when the bag has nothing to give', async (t) => {
  // The fall-through has to stay whole: this feature adds a preference, it does
  // not replace the answer underneath it.
  const j = mender({ party: [{ hp: 10, maxHp: 40 }], items: [] });
  j.walked = 0;
  j.mapKey = async () => 1;
  j.nearestHeal = async () => ({ map: 2, heal: async () => true });
  j.healUp = async () => { j.walked++; return true; };
  const r = await j.healNow();
  t.true(r.ok, 'it still healed');
  t.eq(j.walked, 1, 'by walking');
  t.contains(r.message, 'healed', 'and the old message is unchanged');
});

test('healNow on a fainted party walks, carrying potions or not', async (t) => {
  const j = mender({ party: [{ hp: 0, maxHp: 40 }], items: [[18, 5]] });
  j.walked = 0;
  j.mapKey = async () => 1;
  j.nearestHeal = async () => ({ map: 2, heal: async () => true });
  j.healUp = async () => { j.walked++; return true; };
  await j.healNow();
  t.eq(j.walked, 1, 'a Centre is the only thing that mends a faint');
  t.eq(j.used.length, 0, 'and no potion was spent finding that out');
});

test('the bag cures what a potion cannot', async (t) => {
  // A potion does nothing about poison, and poison goes on doing damage while
  // you walk -- so a potion spent before the antidote is a potion spent into a
  // leak.
  const j = mender({ party: [{ hp: 40, maxHp: 40, status: ['psn'] }],
                     items: [[12, 1], [18, 2]] });
  const r = await j.healFromBag();
  t.true(r.ok, 'something was done');
  t.eq(j.used.map((u) => u.id), [12], 'the antidote, and no potion');
  t.contains(r.stats.cured, 'ANTIDOTE', 'and it says what it spent');
});

test('the specific cure comes before the general one', async (t) => {
  // A FULL HEAL is not spent on a poisoning an ANTIDOTE would have fixed --
  // which is the ball preference's rule, in a third pocket.
  const j = mender({ party: [{ hp: 40, maxHp: 40, status: ['psn'] }],
                     items: [[26, 1], [12, 1], [173, 1]] });
  await j.healFromBag();
  t.eq(j.used[0].id, 173, 'the berry first, being free and regrowing');
});

test('poisoned and hurt gets the cure and the potion', async (t) => {
  const j = mender({ party: [{ hp: 10, maxHp: 40, status: ['psn'] }],
                     items: [[12, 1], [18, 1]] });
  const r = await j.healFromBag();
  t.true(r.ok, 'both');
  t.eq(j.used.map((u) => u.id).sort(), [12, 18], 'antidote and potion');
});

test('a cure the bag does not have is left alone rather than guessed at',
     async (t) => {
  const j = mender({ party: [{ hp: 40, maxHp: 40, status: ['par'] }],
                     items: [[12, 1]] });
  const r = await j.healFromBag();
  t.false(r.ok, 'nothing the bag holds cures paralysis');
  t.eq(j.used.length, 0, 'and an antidote was not tried on it');
});

test('a fainted Pokémon’s status is not cured', async (t) => {
  // The faint is the problem, and only a Center answers it.
  const j = mender({ party: [{ hp: 0, maxHp: 40, status: ['psn'] }],
                     items: [[12, 1]] });
  const r = await j.healFromBag();
  t.false(r.ok, 'nothing to do here');
  t.eq(j.used.length, 0, 'and no antidote spent on a corpse');
});

test('a cartridge whose title lists no cures cures nothing', async (t) => {
  const j = mender({ party: [{ hp: 40, maxHp: 40, status: ['psn'] }],
                     items: [[12, 1]], cures: null });
  t.eq(await j.cureFromBag(), [], 'and says so by doing nothing');
});

// --- duels -------------------------------------------------------------------

/**
 * A Journey whose map has trainers on it and whose battles are scripted.
 *
 * `trainers` is a function so a test can move somebody between attempts, which
 * is the one thing a trainer does that a ball never does. `starts` says whether
 * pressing A actually brings a battle, and `outcome` what fightBattle makes of
 * it -- the two failures a duel has that a pickup does not.
 */
function dueller({ trainers = () => [], at = [5, 5], starts = true,
                   outcome = 'won', prize = 300, walkFails = () => null,
                   open = () => true, battle = null } = {}) {
  const sym = symbols();
  const log = [];
  let money = 1000, inBattle = !!battle, mode = battle || 0, level = 5;
  const gb = new FakeGameBoy({ wram: worldRam(sym, {}) });
  const collision = {
    off: 0,
    calibrate: () => true,
    playerPos: () => at,
    mapSize: () => [60, 60],
    walkable: (x, y) => open(x, y),
    trainers: () => trainers(),
  };
  const nav = {
    mapKey: async () => 1,
    walkTo: async (_c, to) => {
      log.push(`walk ${to[0]},${to[1]}`);
      const bad = walkFails(to);
      if (!bad) { at = [...to]; return { stopped: null }; }
      return { stopped: bad };
    },
    step: async (dir) => { log.push(`face ${dir}`); return { blocked: false }; },
  };
  const j = new Journey(gb, new GameState(sym), null, collision, nav, () => {},
                        { route: () => null }, { heals: ['potion'] });
  j.log = log;
  j.said = [];
  j.say = (m) => j.said.push(m);
  j.settled = async () => gb.wram;
  j.snap = async () => ({
    inBattle, battleMode: mode, money,
    party: [{ hp: 20, maxHp: 20, level }], balls: [], items: [],
  });
  j.tasks = {
    flee: async () => { log.push('flee'); inBattle = false; mode = 0; return true; },
    fightBattle: async (turns, opts) => {
      log.push(`fight ${turns} heals=${opts && opts.heals ? opts.heals.join() : 'none'}`);
      inBattle = false; mode = 0;
      if (outcome === 'won') { money += prize; level += 1; }
      return outcome;
    },
  };
  j.gb = {
    press: async () => {
      log.push('press A');
      if (starts) { inBattle = true; mode = 2; }
    },
  };
  return j;
}

test('a trainer already in front of us is fought without walking anywhere',
     async (t) => {
  // Above the walk rather than below it, because this is how most duels start:
  // a trainer with a sight range opens the battle the moment you cross their
  // line, which on the way to one of them is the ordinary case.
  const j = dueller({ battle: 2, trainers: () => [{ x: 9, y: 9, sprite: 39 }] });
  const r = await j.duelHere();
  t.true(r.ok, 'it was fought');
  t.true(r.won, 'and won');
  t.eq(j.log.filter((l) => l.startsWith('walk')).length, 0, 'and nothing walked');
});

test('a duel is priced in money, because only a trainer pays', async (t) => {
  // The same rule the shop follows: money is the evidence. A wild Pokemon never
  // pays out, so the prize is the one number that says the battle was both a
  // trainer's and won -- HP says who fought and levels say what it was worth,
  // and neither tells a win from any other ending.
  const j = dueller({ trainers: () => [{ x: 9, y: 9, sprite: 39 }], prize: 448 });
  const r = await j.duelHere();
  t.true(r.ok, 'won');
  t.eq(r.prize, 448, 'and the purse is the difference');
  t.contains(r.message, '448', 'said out loud');
  t.contains(r.message, 'Lv5 to Lv6', 'with what the lead got out of it');
});

test('the bag is offered to the fight, so a duel can heal mid-battle',
     async (t) => {
  const j = dueller({ trainers: () => [{ x: 9, y: 9, sprite: 39 }] });
  await j.duelHere();
  t.contains(j.log.join(' | '), 'heals=potion', "the title's own list");
});

test('a map with nobody near says so instead of walking', async (t) => {
  // "Near", not "on this map", because near is all the game will tell us: it
  // only loads an object you are close enough to draw, so this list is a local
  // answer and a sentence about the whole map would be a claim it cannot make.
  // The map's own total is the interface's business -- see rows.js, where it
  // goes in the hint.
  const j = dueller({ trainers: () => [] });
  const r = await j.duelHere();
  t.false(r.ok, 'nothing to do');
  t.contains(r.message, 'nobody near enough', 'and says which');
  t.eq(j.log.length, 0, 'and it did not move');
});

test('the nearest trainer is the one walked to', async (t) => {
  const j = dueller({
    at: [5, 5],
    trainers: () => [{ x: 40, y: 5, sprite: 37 }, { x: 7, y: 5, sprite: 39 }],
  });
  await j.duelHere();
  const first = j.log.find((l) => l.startsWith('walk'));
  t.true(Number(first.split(' ')[1].split(',')[0]) < 10,
         'the one two tiles away, not the one thirty-five');
});

test('the trainer list is re-read every attempt, because a trainer moves',
     async (t) => {
  // The difference from `takeHere`, and it is measured rather than tidy: a ball
  // and a tree stay where the map put them, and on Route 30 a wanderer moved a
  // tile while nothing else happened. So a tile read once and walked to twice
  // is a tile nobody is standing on.
  const spots = [[9, 9], [20, 20]];
  let asked = 0;
  const j = dueller({
    // Standing at (9,9) the first time anybody looks, and at (20,20) after
    // that. The walk refuses everything west of x=15, so the first attempt can
    // only succeed if the second look happens.
    trainers: () => {
      const [x, y] = spots[Math.min(asked++, spots.length - 1)];
      return [{ x, y, sprite: 39 }];
    },
    walkFails: (to) => (to[0] < 15 ? 'refused' : null),
  });
  const r = await j.duelHere();
  t.true(asked > 1, 'it asked again');
  t.true(r.ok, 'and caught up with them where they had gone');
});

test('something else in the way is run from, not fought', async (t) => {
  // A Pidgey met on the way to a trainer is a delay, not the job -- the same
  // rule escapeBattle follows, for the same reason.
  const j = dueller({ battle: 1, trainers: () => [{ x: 9, y: 9, sprite: 39 }] });
  const r = await j.duelHere();
  t.contains(j.log.join(' | '), 'flee', 'the wild one was fled');
  t.true(r.ok, 'and the duel still happened');
});

test('a trainer who will not fight reads as beaten, not as unreachable',
     async (t) => {
  // Two answers, and only one of them is about the map. Gen 2 leaves a trainer
  // standing there for ever once they have lost, so a walk that arrives and a
  // press that does nothing is the ordinary end state of this feature -- and
  // saying "could not get to anyone" of it would blame the route.
  const j = dueller({ trainers: () => [{ x: 9, y: 9, sprite: 39 }], starts: false });
  const r = await j.duelHere();
  t.false(r.ok, 'no battle happened');
  t.contains(r.message, 'already beaten', 'and it says what that probably means');
});

test('a trainer nothing can walk to is a route problem, and says so',
     async (t) => {
  const j = dueller({ trainers: () => [{ x: 9, y: 9, sprite: 39 }],
                      open: () => false });
  const r = await j.duelHere();
  t.false(r.ok, 'it did not happen');
  t.contains(r.message, 'could not get to anyone', 'and blames the walk');
  t.eq(j.log.filter((l) => l === 'press A').length, 0, 'nothing was pressed');
});

test('a duel that is lost is reported as lost, not as nothing happening',
     async (t) => {
  const j = dueller({ trainers: () => [{ x: 9, y: 9, sprite: 39 }],
                      outcome: 'lost' });
  const r = await j.duelHere();
  t.false(r.ok, 'it went badly');
  t.contains(r.message, 'lost', 'and says so');
  t.eq(r.prize, 0, 'and nothing was won');
});

test('Stop ends a duel before it starts a battle', async (t) => {
  const j = dueller({ trainers: () => [{ x: 9, y: 9, sprite: 39 }] });
  j.tasks.cancelled = true;
  const r = await j.duelHere();
  t.false(r.ok, 'it stopped');
  t.contains(r.message, 'stopped', 'saying that rather than blaming the map');
});

test('a trainer who would not fight is not asked again, so the next one is',
     async (t) => {
  // Measured on Route 30: standing at (3,28) there were two trainers in range,
  // the near one already beaten and the far one not. Every attempt went to the
  // nearer, so all six were spent on somebody who was never going to answer and
  // the one who would was never approached.
  const asked = [];
  const j = dueller({
    at: [3, 28],
    trainers: () => [{ x: 2, y: 28, sprite: 39 }, { x: 5, y: 23, sprite: 39 }],
    starts: false,
  });
  // Only the far one fights. `starts` is read on every press, so this stands in
  // for a beaten trainer beside an unbeaten one.
  const press = j.gb.press;
  j.gb.press = async () => {
    asked.push(j.log.filter((l) => l.startsWith('walk')).pop());
    await press();
  };
  const r = await j.duelHere();
  t.false(r.ok, 'neither fought, in this arrangement');
  const tiles = [...new Set(asked)];
  t.true(tiles.length > 1, 'but it did not spend every attempt on the same one');
});

test('once everybody near has refused, it says so rather than walking again',
     async (t) => {
  const j = dueller({ trainers: () => [{ x: 9, y: 9, sprite: 39 }], starts: false });
  const r = await j.duelHere();
  t.contains(r.message, 'already beaten', 'the ordinary end state of a route');
  t.eq(j.log.filter((l) => l.startsWith('walk')).length, 1,
       'and it only walked there once');
});
