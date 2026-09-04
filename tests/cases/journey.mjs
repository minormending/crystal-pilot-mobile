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
