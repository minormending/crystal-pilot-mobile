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
