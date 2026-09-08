// Choosing where to heal, which is arithmetic rather than map knowledge.
//
// This moved out of the Crystal file when titles became data, and moving it
// made it testable: the places come from a title object, and everything else is
// a sum over the map graph that can be handed stubs. It had never been tested
// before, and it is the piece most likely to be quietly wrong -- a cost model
// that picks the wrong Center costs a minute of walking and looks like a bug in
// the walk.
import { FakeGameBoy, symbols, test, worldRam } from '../harness.mjs';
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
