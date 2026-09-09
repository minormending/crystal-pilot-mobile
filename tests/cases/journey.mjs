// Choosing where to heal, which is arithmetic rather than map knowledge.
//
// This moved out of the Crystal file when titles became data, and moving it
// made it testable: the places come from a title object, and everything else is
// a sum over the map graph that can be handed stubs. It had never been tested
// before, and it is the piece most likely to be quietly wrong -- a cost model
// that picks the wrong Center costs a minute of walking and looks like a bug in
// the walk.
import { FakeGameBoy, fakeRom, paintScreen, symbols, test,
         worldRam } from '../harness.mjs';
import { GameState } from '../../gen2/state.js';
import { Journey } from '../../gen2/journey.js';

const sym = symbols();

const HOME = 1, NEAR = 2, FAR = 3;

/** A Journey with the map graph and the decode stubbed out. */
function walker({ routes = {}, at = [5, 5], size = [60, 20], title = {},
                  via = {},
                  world: game = { party: [{ hp: 4, maxHp: 20 }] } } = {}) {
  // `game.badges` rides along in the same snapshot, because that is where the
  // real one lives: a written-off route expires on a badge count, and the count
  // is read out of the same work RAM as the party.
  const gb = new FakeGameBoy({ wram: worldRam(sym, game) });
  const collision = {
    off: 0,
    calibrate: () => true,
    playerPos: () => at,
    mapSize: () => size,
  };
  // `via` names the legs a destination's route is made of, so the fake can
  // honour `avoid` the way the real graph does -- which is the only way to test
  // that a shut leg *on the way* makes the place beyond it unreachable.
  const world = {
    route: (from, to, { avoid = null } = {}) => {
      if (!(to in routes)) return null;
      if (avoid && (via[to] || []).some((leg) => avoid.has(leg))) return null;
      return routes[to];
    },
  };
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

/**
 * A Journey whose graph answers both questions `placesFrom` asks: which named
 * maps it can reach, and what lies within a few legs.
 *
 * `landmarks` maps a map key to what the *cartridge* calls it, which is the
 * half that needs no title data at all.
 */
function traveller({ reachable = {}, names = null, landmarks = {} } = {}) {
  const gb = new FakeGameBoy({ wram: worldRam(sym, {}) });
  const world = {
    routesFrom: (from, targets, { avoid = null } = {}) => new Map(
      [...targets].filter((k) => k !== from && k in reachable)
        // A star, so a destination's only leg is `HOME>k` -- which is exactly
        // what a write-off names.
        .filter((k) => !(avoid && avoid.has(`${from}>${k}`)))
        .map((k) => [k, new Array(reachable[k]).fill({ kind: 'edge' })])),
    // A star: everything reachable is one leg from home, which is enough to
    // exercise one-entry-per-landmark without modelling a map.
    exits: (key) => (key === HOME
      ? Object.keys(reachable).map((k) => ({ kind: 'edge', key: Number(k) }))
      : []),
    landmarkOf: (g, n) => (g * 256 + n) in landmarks ? g * 256 + n : 0,
  };
  const j = new Journey(gb, new GameState(sym), null, null,
                        { mapKey: async () => HOME },
                        () => {}, world, names === null ? {} : { names });
  j.tasks = { rom: { landmarkName: (k) => landmarks[k] || '' } };
  return j;
}

test('Travel does not offer a place behind a leg the game refused',
     async (t) => {
  // The rule this list has always followed -- an offer nobody can take is
  // worse than no offer -- meeting a fact the pilot could not learn until this
  // pass. Every leg the graph knew about used to be one it could take.
  //
  // Both halves of the list, because they are two searches: the title's own
  // names go through `routesFrom` and the cartridge's landmarks through
  // `_within`, and wiring one and not the other is this repository's most
  // frequent kind of defect.
  const j = traveller({
    names: { [NEAR]: 'Cherrygrove City' },
    reachable: { [NEAR]: 1, [FAR]: 1 },
    landmarks: { [FAR]: 'VIOLET CITY' },
  });
  t.eq(j.placesFrom(HOME).map((p) => p.name),
       ['Cherrygrove City', 'VIOLET CITY'], 'both to start with');

  j.shutLeg(HOME, NEAR, 'a guard', 0);
  t.eq(j.placesFrom(HOME).map((p) => p.name), ['VIOLET CITY'],
       'the title-named one goes when its leg is shut');

  j.shutLeg(HOME, FAR, 'another guard', 0);
  t.eq(j.placesFrom(HOME), [], 'and so does the landmark-named one');
});

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
                   open = () => true, battle = null,
                   // `hp` is the lead's, mutable, so the loop that clears a
                   // map can be watched mending it and stopping when it
                   // cannot. `bag` is what mending costs: a function, because
                   // whether it works is the thing under test.
                   hp = 20, bag = null, hurtPerFight = 0,
                   // Who the map *placed*, separately from who is spawned.
                   // On a route they differ, and that difference is what
                   // `_closeOnTrainer` exists for: Gen 2 draws an object only
                   // when you are near it.
                   placed = null } = {}) {
  const sym = symbols();
  const log = [];
  let money = 1000, inBattle = !!battle, mode = battle || 0, level = 5;
  let lead = hp;
  const gb = new FakeGameBoy({ wram: worldRam(sym, {}) });
  const collision = {
    off: 0,
    calibrate: () => true,
    playerPos: () => at,
    mapSize: () => [60, 60],
    walkable: (x, y) => open(x, y),
    trainers: () => trainers(),
    // What the map *placed*, which is what bounds a sweep: Gen 2 only spawns an
    // object you are close enough to draw, so `trainers()` answered nought
    // arriving on Route 31 with four of them further along. Placements never
    // move and are all there whether drawn or not, so the fake gives the same
    // people an index and the trainer type.
    placedObjects: () => (placed || trainers())
      .map((o, i) => ({ ...o, index: i + 1, type: 2 })),
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
    party: [{ hp: lead, maxHp: 20, level }], balls: [], items: [],
  });
  j.healFromBag = async () => {
    log.push('bag');
    if (!bag) return { ok: false, message: 'nothing in the bag' };
    lead = 20;
    return { ok: true, message: 'mended out of the bag' };
  };
  j.tasks = {
    flee: async () => { log.push('flee'); inBattle = false; mode = 0; return true; },
    fightBattle: async (turns, opts) => {
      log.push(`fight ${turns} heals=${opts && opts.heals ? opts.heals.join() : 'none'}`);
      inBattle = false; mode = 0;
      if (outcome === 'won') { money += prize; level += 1; }
      lead = Math.max(0, lead - hurtPerFight);
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

// --- winning a badge --------------------------------------------------------
//
// The badge is the evidence and the only evidence there is. A Gym ends with the
// leader beaten and the pilot standing in a room that looks like every other
// room it has cleared, so counting won battles would say "fought four, won
// four" about a run that never reached the leader.

/** A Journey at a Gym, with a badge that the leader's loss would set. */
function gymGoer({ badge = 0, has = false, inside = 2567, at = 2565,
                   trainers = 2, wins = true, enter = true } = {}) {
  const sym = symbols();
  // `leaderAt` because a leader is a *script* object, not a trainer: Falkner is
  // object 1 at (5,1) with type 0 while the Bird Keepers are type 2, so nothing
  // in the duelling machinery finds him and the tile has to be declared.
  const title = { legCost: 25, heals: ['potion'],
                  gyms: [{ map: at, inside, door: [18, 17],
                           leader: 'FALKNER', leaderAt: [5, 1], badge,
                           opens: 'the road south' }] };
  let here = at, badges = has ? 1 << badge : 0;
  const gb = new FakeGameBoy({ wram: worldRam(sym, {}) });
  const j = new Journey(gb, new GameState(sym), null,
                        { off: 0, calibrate: () => true, playerPos: () => [5, 5],
                          mapSize: () => [10, 16], placedObjects: () => [] },
                        { mapKey: async () => here }, () => {},
                        { route: () => [] }, title);
  j.said = [];
  j.say = (m) => j.said.push(m);
  j.settled = async () => gb.wram;
  j.snap = async () => ({
    inBattle: false, money: 3000, wram: gb.wram,
    party: [{ hp: 20, maxHp: 20, level: 10 }], balls: [], items: [],
  });
  // The badge is read out of the same snapshot the real one is, so the bit has
  // to actually be in work RAM.
  const at8 = sym.addr('wJohtoBadges') - 0xc000;
  gb.wram[at8] = badges;
  j.state.hasBadge = (wram, bit) =>
    bit === null || bit === undefined ? null : (wram[at8] & (1 << bit)) !== 0;
  j.through = async () => { if (enter) here = inside; return enter; };
  j.travelTo = async () => ({ ok: true, message: 'arrived' });
  j.healNow = async () => ({ ok: true, message: 'healed' });
  let fought = 0;
  j.clearHere = async () => {
    fought = trainers;
    // Winning the last battle is what sets the bit, which is the game's own
    // order of events.
    if (wins) gb.wram[at8] |= 1 << badge;
    return { ok: wins, stats: { won: trainers, prize: 100 * trainers },
             message: wins ? `beat ${trainers} trainers` : 'nobody fit to send out' };
  };
  j.fought = () => fought;
  // Talking to the leader is its own step, stubbed to nothing here so the tests
  // that are about the badge or the sweep are not also about the walk across a
  // gym floor. The two that *are* about it replace this.
  j.leaderFight = async () => ({ ok: true, won: true, message: 'won the battle' });
  return j;
}

test('the leader is talked to, because a leader is not a trainer', async (t) => {
  // **Read off Violet's Gym in work RAM.** Falkner is object 1 at (5,1) with
  // type 0 -- a *script* -- while the two Bird Keepers at (5,6) and (2,10) are
  // type 2. `clearHere` fights what the map calls a trainer, so it beat the
  // Keepers, reported *everyone here has already been beaten*, and left without
  // a badge. His battle starts by being talked to.
  const j = gymGoer();
  let talked = false;
  j.clearHere = async () => ({ ok: true, stats: { won: 2, prize: 200 },
                               message: 'beat 2 trainers' });
  j.leaderFight = async (gym) => {
    talked = true;
    j.gb.wram[symbols().addr('wJohtoBadges') - 0xc000] |= 1 << gym.badge;
    return { ok: true, won: true, message: 'won the battle' };
  };
  const r = await j.beatGym((await j.gymList(2565))[0]);
  t.true(talked, 'the leader was talked to');
  t.true(r.ok, `and the badge is in: ${r.message}`);
});

test('the badge is read after the speech, not before it', async (t) => {
  // **Measured.** Falkner went down for ¥675 and `hasBadge` still read false,
  // with a script running and his "just because you beat me!" on the screen:
  // the award is *in* that speech. Reading the case before pressing through it
  // says the Gym was not beaten about a Gym that was -- the same shape as
  // reading the ITEM pocket before the game has put the thing in it.
  const j = gymGoer();
  const at = symbols().addr('wJohtoBadges') - 0xc000;
  j.clearHere = async () => ({ ok: true, stats: { won: 2, prize: 200 },
                               message: 'beat 2 trainers' });
  // The battle ends and the badge is *not* set. Only pressing through gives it.
  j.leaderFight = async () => ({ ok: true, won: true, message: 'won the battle' });
  j.runScripts = async () => { j.gb.wram[at] |= 1; return true; };
  const r = await j.beatGym((await j.gymList(2565))[0]);
  t.true(r.ok, `the badge arrived with the speech: ${r.message}`);
  t.eq(r.stats.badge, true, 'and is read as in the case');
});

test('a badge won is the evidence, and it says what it opens', async (t) => {
  // `opens` is a *title's* claim about its own cartridge, and optional -- and
  // Crystal's own entry declines to make one, because the claim first written
  // there was wrong: with Falkner beaten, the man on Route 32 still turns the
  // pilot back. The field works; nobody should put a guess in it.
  const j = gymGoer();
  const r = await j.beatGym((await j.gymList(2565))[0]);
  t.true(r.ok, `won: ${r.message}`);
  t.eq(r.stats.badge, true, 'the bit is set');
  t.contains(r.message, 'FALKNER', 'the leader is named');
  t.contains(r.message, 'the road south', 'and what it opens');
});

test('a Gym cleared without the badge is not a Gym beaten', async (t) => {
  // **The reason this reads a bit rather than counting wins.** A run that
  // fights every trainer in the room and never reaches the leader looks
  // identical from the inside: four battles, four wins, and a room that has
  // been cleared.
  const j = gymGoer({ wins: true });
  // Everything the sweep reports, and no badge.
  j.clearHere = async () => ({ ok: true, stats: { won: 4, prize: 400 },
                               message: 'beat 4 trainers' });
  j.leaderFight = async () => ({ ok: false, message: 'the battle lost' });
  const r = await j.beatGym((await j.gymList(2565))[0]);
  t.false(r.ok, 'not a win');
  t.eq(r.stats.won, 4, 'even with four battles won');
  t.contains(r.message, 'no badge yet', 'and it says so plainly');
  t.contains(r.message, 'the battle lost', "keeping the leader's own answer");
});

test('the leader is who gets named when the leader is the problem', async (t) => {
  // **Measured, and it is this pass's own mistake made once more.** A Gym whose
  // Bird Keepers had already been beaten, and FALKNER then won, reported
  // *no badge yet — everyone here has already been beaten*. He is the reason
  // there is no badge; they are not.
  const j = gymGoer();
  j.clearHere = async () => ({ ok: true, stats: { won: 0, prize: 0 },
                               message: 'everyone here has already been beaten' });
  j.leaderFight = async () => ({ ok: false, message: 'the battle lost' });
  const r = await j.beatGym((await j.gymList(2565))[0]);
  t.contains(r.message, 'the battle lost', 'the leader is named');
  t.false(r.message.includes('already been beaten'),
          `and the sweep is not: ${r.message}`);
});

test('the sweep still speaks when the leader was never reached', async (t) => {
  // A party that ran out on the way to him is the sweep's story to tell.
  const j = gymGoer();
  j.clearHere = async () => ({ ok: false, stats: { won: 1, prize: 100 },
                               message: 'nobody fit to send out' });
  // Nothing left standing, so `leaderFight` is not even tried.
  j.snap = async () => ({ inBattle: false, money: 3000, wram: j.gb.wram,
                          party: [{ hp: 0, maxHp: 22, level: 7 }],
                          balls: [], items: [] });
  const r = await j.beatGym((await j.gymList(2565))[0]);
  t.contains(r.message, 'nobody fit to send out', "the sweep's reason stands");
});

test('a party that could not be healed does not go into the Gym', async (t) => {
  // **Measured on the first cartridge run of this**: a lead at 1 of 22, a heal
  // turned back at Route 32's gate, and it walked into the Gym anyway and lost
  // the first battle. Worse than not going, because losing costs half the
  // money -- and the pilot knew it could not heal before it set off.
  const j = gymGoer();
  let hp = 1;
  j.snap = async () => ({ inBattle: false, money: 3000, wram: j.gb.wram,
                          party: [{ hp, maxHp: 22, level: 7 }],
                          balls: [], items: [] });
  j.healNow = async () => ({ ok: false, message: 'turned back on the way' });
  const r = await j.beatGym((await j.gymList(2565))[0]);
  t.false(r.ok, 'it did not go');
  t.contains(r.message, 'not fit for a Gym', 'and says why');
  t.contains(r.message, 'turned back on the way', "keeping the heal's reason");
  t.false(j.said.join(' ').includes('in through the door'), 'no door was opened');
});

test('a heal that worked lets the Gym go ahead', async (t) => {
  // The other side: the check is on whether the party is *fit*, not on whether
  // the heal reported success -- a bag heal that mends everybody is a heal.
  const j = gymGoer();
  let hp = 1;
  j.snap = async () => ({ inBattle: false, money: 3000, wram: j.gb.wram,
                          party: [{ hp, maxHp: 22, level: 7 }],
                          balls: [], items: [] });
  j.healNow = async () => { hp = 22; return { ok: false, message: 'odd but mended' }; };
  const r = await j.beatGym((await j.gymList(2565))[0]);
  t.true(r.ok, `it went and won: ${r.message}`);
});

test('the pilot goes shopping before a Gym, and goes anyway if it cannot',
     async (t) => {
  // **Measured on the cartridge.** A Lv13 lead with an empty pocket beat
  // Falkner's first Bird Keeper for 162 and lost to the second: `clearHere`
  // mends between rounds and there was nothing to mend with. A Gym is several
  // battles with no Center between them, so the bag is the only mid-way help
  // there is.
  const bought = [];
  const j = gymGoer();
  j.restock = async (names, want) => {
    bought.push(`${names.join()} x${want}`);
    return { ok: true, message: 'bought some' };
  };
  await j.beatGym((await j.gymList(2565))[0]);
  t.eq(bought.length, 1, 'it went shopping');
  t.contains(bought[0], 'potion', 'for what the title says heals');
  t.contains(bought[0], 'x4', 'and carried a spare');

  // No mart in reach, no money, nothing named to buy: all reasons to walk in
  // with what you have rather than reasons not to go.
  const broke = gymGoer();
  broke.restock = async () => ({ ok: false, message: 'no mart within reach of here' });
  const r = await broke.beatGym((await broke.gymList(2565))[0]);
  t.true(r.ok, `it still went and won: ${r.message}`);
  t.contains(broke.said.join(' '), 'going in as we are', 'saying so on the way');
});

test('a Gym already beaten is not offered, and not walked to', async (t) => {
  const j = gymGoer({ has: true });
  t.eq(await j.gymList(2565), [], 'off the list');
  const r = await j.beatGym({ map: 2565, inside: 2567, door: [18, 17],
                              leader: 'FALKNER', badge: 0 });
  t.true(r.ok, 'and asking anyway is not an error');
  t.true(r.stats.already, 'it says it was already done');
  t.eq(j.said.length, 0, 'having gone nowhere');
});

test('a Gym that will not let the pilot in says who stopped it', async (t) => {
  const j = gymGoer({ enter: false });
  j.turnedBack = 'the Gym is closed today';
  const r = await j.beatGym((await j.gymList(2565))[0]);
  t.false(r.ok, 'no badge');
  t.contains(r.message, 'the Gym is closed today', 'quoting whoever said no');
});

test('a cartridge with no Gyms declared offers none', async (t) => {
  const j = gymGoer();
  j.title = { legCost: 25 };
  t.eq(await j.gymList(2565), [], 'nothing to offer');
  const r = await j.beatGym(null);
  t.false(r.ok, 'and nothing to walk to');
  t.contains(r.message, 'no Gym', 'said rather than crashed');
});

test('a cartridge that cannot read badges still offers the Gym', async (t) => {
  // Null is "cannot tell", and offering the walk is the right answer to it: the
  // worst case is a trip to a Gym already beaten, and the alternative is never
  // offering one at all.
  const j = gymGoer({ has: true });
  j.state.hasBadge = () => null;
  t.eq((await j.gymList(2565)).length, 1, 'still on the list');
});

// --- a battle nothing can finish ---------------------------------------------

test('a walk gives up on a battle it cannot play, rather than re-asking',
     async (t) => {
  // **Measured while grinding on Route 31.** Cyndaquil out of PP on its only
  // damaging move, a Lv2 Caterpie at 1 HP, and a *trainer* battle -- which
  // cannot be fled. `fightBattle` answered 'stuck' and `escapeBattle` said
  // `trainer battle: stuck`, five times and counting, because every walk calls
  // it: at the top of each crossing stage, each edge attempt, each doorway try.
  //
  // `grind` bounds its own stuck run at five. The walks had no such bound,
  // because they could not tell a battle that was *lost* from one that could
  // not be *played* -- both came back false.
  const j = ringWalker();
  let asked = 0;
  j.escapeBattle = async () => { asked++; j.battleStuck = true; return false; };
  const r = await j.travelTo(3);
  t.false(r.ok, 'the walk stops');
  t.contains(r.message, 'nothing can finish', 'and says what is in the way');
  t.true(asked <= 2, `asked once or twice, not per step: ${asked}`);
});

test('escapeBattle is what notices, driven rather than stubbed', async (t) => {
  // **The line that sets the flag, through the real method.** Every test around
  // it replaces `escapeBattle` wholesale -- which is how `if (how === 'stuck')`
  // survived every mutation of it. A stub agrees with whoever wrote it.
  const sym = symbols();
  const gb = new FakeGameBoy({ wram: worldRam(sym, {}) });
  const j = new Journey(gb, new GameState(sym), null, {}, {}, () => {}, null,
                        { heals: ['potion'] });
  j.said = [];
  j.say = (m) => j.said.push(m);
  let how = 'stuck';
  j.snap = async () => ({ inBattle: true, battleMode: j.state.e.trainerBattle,
                          party: [{ hp: 5, maxHp: 30 }], money: 0 });
  j.tasks = { fightBattle: async () => how };

  t.false(await j.escapeBattle(), 'a stuck battle is not escaped');
  t.true(j.stuckInBattle, 'and the walks are told');
  t.contains(j.said.join(' '), 'trainer battle: stuck', 'said out loud too');

  // A battle that is merely *lost* is a different thing: the walk carries on
  // from wherever the whiteout put it, which it has always done.
  const lost = new Journey(gb, new GameState(sym), null, {}, {}, () => {}, null,
                           { heals: ['potion'] });
  lost.say = () => {};
  lost.snap = j.snap;
  lost.tasks = { fightBattle: async () => 'lost' };
  t.false(await lost.escapeBattle(), 'still not a win');
  t.false(lost.stuckInBattle, 'but not unplayable either');

  // And a win clears nothing and blocks nothing.
  const won = new Journey(gb, new GameState(sym), null, {}, {}, () => {}, null,
                          { heals: ['potion'] });
  won.say = () => {};
  won.snap = j.snap;
  won.tasks = { fightBattle: async () => 'won' };
  t.true(await won.escapeBattle(), 'a won battle is a won battle');
  t.false(won.stuckInBattle, 'and the walk goes on');
});

test('a battle nothing can play is not reported as a door problem', async (t) => {
  // **Measured.** A Cyndaquil with no PP left a box on the screen, and the
  // window check in the warp branch read it as a conversation in the way:
  // *could not get through to DARK CAVE -- something is still on screen*. The
  // door was never the problem and the sentence sent the reader at it.
  const j = atADoor({ windowOpen: true });
  j.nav.mapKey = async () => 1;
  j.world = { route: () => [{ kind: 'warp', tile: [2, 7], key: 2 }] };
  j.escapeBattle = async () => { j.battleStuck = true; j.stuckReason = 'nopp'; return false; };
  const r = await j.travelTo(2);
  t.false(r.ok, 'the walk stops');
  t.contains(r.message, 'out of PP', 'and names the battle');
  t.false(r.message.includes('still on screen'), 'not the door');
});

test('a doorway gives up on one too, and says so', async (t) => {
  const j = atADoor({ windowOpen: false });
  j.escapeBattle = async () => { j.battleStuck = true; return false; };
  t.false(await j.through([2, 7], 2), 'it does not keep trying the door');
  t.contains(j.said.join(' '), 'stuck in a battle', 'saying which');
});

test('the flag is about this walk, not about ever', async (t) => {
  // Cleared at the start of each walk, because a battle dealt with between two
  // presses must not make the second press refuse.
  const j = ringWalker();
  j.battleStuck = true;
  const r = await j.travelTo(3);
  t.true(r.ok, `a fresh walk starts clean: ${r.message}`);
});

// --- a whiteout looks exactly like success -----------------------------------

test('a heal that was really a knockout says so', async (t) => {
  // **Measured on the cartridge, and it is the worst kind of wrong report: not
  // a failure dressed as one, but a failure dressed as a success.** `healNow`
  // was asked to mend a lead at 9 of 24; the walk to Violet met something it
  // could not run from; the party fainted. A whiteout in Gen 2 heals the party,
  // moves the player to the last Center and takes half the wallet -- so
  // afterwards the HP was full, the map was the town it had been walking to,
  // and the job said *healed one Pokémon at Violet City*.
  //
  // Every reading agreed. The only trace was a wallet that had gone from 3136
  // to 1568, which is why money is the evidence here and nothing else can be.
  const sym = symbols();
  const title = { legCost: 25, healers: [{ map: 1, reach: 'healAtNear' }] };
  const gb = new FakeGameBoy({ wram: worldRam(sym, {}) });
  const j = new Journey(gb, new GameState(sym), null,
                        { off: 0, calibrate: () => true, playerPos: () => [5, 5],
                          mapSize: () => [20, 20] },
                        { mapKey: async () => 1 }, () => {},
                        { route: () => [] }, title);
  j.said = [];
  j.say = (m) => j.said.push(m);
  j.settled = async () => gb.wram;
  let hp = 9, money = 3136;
  j.snap = async () => ({ inBattle: false, money,
                          party: [{ hp, maxHp: 24, level: 8 }],
                          balls: [], items: [] });
  j.healFromBag = async () => ({ ok: false, message: 'nothing in the bag' });
  // What a whiteout does: full HP, and half the money.
  j.healUp = async () => { hp = 24; money = Math.floor(money / 2); return true; };

  const r = await j.healNow();
  t.false(r.ok, 'not reported as a heal');
  t.contains(r.message, 'knocked out', 'named for what it was');
  t.contains(r.message, '1568', 'with what it cost');
  t.true(r.stats.knockedOut, 'and said so where a caller can read it');
});

test('a heal that really was a heal is still a heal', async (t) => {
  // The other side, and the reason this keys on money rather than on the walk:
  // reaching a Center and being mended is the ordinary case and must not start
  // reading as a disaster.
  const sym = symbols();
  const title = { legCost: 25, healers: [{ map: 1, reach: 'healAtNear' }] };
  const gb = new FakeGameBoy({ wram: worldRam(sym, {}) });
  const j = new Journey(gb, new GameState(sym), null,
                        { off: 0, calibrate: () => true, playerPos: () => [5, 5],
                          mapSize: () => [20, 20] },
                        { mapKey: async () => 1 }, () => {},
                        { route: () => [] }, title);
  j.said = [];
  j.say = () => {};
  j.settled = async () => gb.wram;
  let hp = 9;
  j.snap = async () => ({ inBattle: false, money: 3136,
                          party: [{ hp, maxHp: 24, level: 8 }],
                          balls: [], items: [] });
  j.healFromBag = async () => ({ ok: false, message: 'nothing in the bag' });
  j.healUp = async () => { hp = 24; return true; };

  const r = await j.healNow();
  t.true(r.ok, 'a heal');
  t.contains(r.message, 'healed one Pokémon', 'said plainly');
  t.true(r.stats.knockedOut === undefined, 'and nothing about a knockout');
});

test('arriving after a knockout is not simply arriving', async (t) => {
  // A whiteout puts the player at a Center and the walk carries on from there,
  // so it very often *does* reach the target -- and `arrived` on its own is
  // true and misleading. The trip that found this reported "arrived" with half
  // the money gone and one line in a log that had already scrolled.
  const j = ringWalker();
  let money = 2000;
  j.snap = async () => ({ inBattle: false, money, scriptRunning: false,
                          windowOpen: false, badges: 0,
                          party: [{ hp: 20, maxHp: 20 }], balls: [], items: [] });
  const walked = j.crossEdge;
  j.crossEdge = async (dir, expect) => {
    money = 1000;                       // knocked out on the first leg
    return walked(dir, expect);
  };
  const r = await j.travelTo(3);
  t.true(r.ok, 'it did arrive');
  t.true(r.knockedOut, 'and says it was knocked out');
  t.contains(r.message, '1000', 'with what that cost');
});

// --- clearing a whole map ---------------------------------------------------
//
// The primitive a Gym needs. `duelHere` fights one; this is the loop, and the
// loop is where all four of the awkward things live.

/** Trainers that stop answering once beaten, the way Gen 2 does not. */
function crowd(n) {
  const all = [];
  for (let i = 0; i < n; i++) all.push({ x: 9, y: 9 + i, sprite: 39 });
  return () => all;
}

test('everybody on the map is fought, one after another', async (t) => {
  const j = dueller({ trainers: crowd(3), prize: 100 });
  const r = await j.clearHere();
  t.true(r.ok, `it worked: ${r.message}`);
  t.eq(r.stats.won, 3, 'three beaten');
  t.eq(r.stats.prize, 300, 'and the money added up');
  t.contains(r.message, 'everyone on this map',
             'said against the map’s own total');
});

test('beating some of a map is not the same as clearing it', async (t) => {
  // **Measured inside Falkner's Gym.** One Bird Keeper beaten, two more on the
  // map, and the sweep said *beat one trainer, ¥126* -- which reads as a
  // finished job. Whether the other two declined or could not be reached is
  // not something this can tell, and it does not pretend to; the number is the
  // part that was missing.
  const three = [{ x: 9, y: 9, sprite: 39 }, { x: 7, y: 6, sprite: 39 },
                 { x: 2, y: 10, sprite: 39 }];
  let asked = 0;
  const j = dueller({
    placed: three,
    // Only the first ever answers, which is what "unreachable or already
    // beaten" looks like from inside the loop.
    trainers: () => (asked++ === 0 ? [three[0]] : []),
    open: (x, y) => x === 9 || y === 9,
  });
  const r = await j.clearHere();
  t.eq(r.stats.won, 1, 'one beaten');
  t.contains(r.message, 'beat one trainer', 'said');
  t.contains(r.message, '2 more on this map did not fight', 'and so is the rest');
  t.false(r.message.includes('everyone'), 'no claim to have cleared it');

  // Exactly one left, which is the boundary: nought left is a cleared map and
  // takes the branch above, so this is the smallest number this sentence is
  // ever about.
  let once = 0;
  const two = [{ x: 9, y: 9, sprite: 39 }, { x: 7, y: 6, sprite: 39 }];
  const j2 = dueller({
    placed: two,
    trainers: () => (once++ === 0 ? [two[0]] : []),
    open: (x, y) => x === 9 || y === 9,
  });
  const r2 = await j2.clearHere();
  t.contains(r2.message, '1 more on this map did not fight', 'one is still said');
});

test('one trainer is one trainer, and the map is only claimed when known',
     async (t) => {
  // Two claims in one sentence, and both can be wrong quietly. The plural is
  // ordinary care. "everyone on this map" is a *claim*, and it may only be made
  // against the map's own object list -- so a snapshot that will not decode
  // means the count is unknown, and an unknown count is not a clear sweep.
  const one = dueller({ trainers: crowd(1), prize: 50 });
  const r1 = await one.clearHere();
  t.contains(r1.message, 'beat one trainer', 'singular');
  t.contains(r1.message, 'everyone on this map', 'and the map was countable');

  // Not settled *yet*, which is the real shape of this: `clearHere` counts the
  // map once on the way in, and coming through a door the decode has not
  // settled -- the same window `crossEdge` measures its edge openings after.
  // So the count is unknown and the fighting still works.
  const blind = dueller({ trainers: crowd(2), prize: 50 });
  const real = blind.settled;
  let first = true;
  blind.settled = async () => {
    if (first) { first = false; return null; }
    return real.call(blind);
  };
  const r2 = await blind.clearHere();
  t.eq(r2.stats.won, 2, 'both fought, because the trainers still spawn');
  t.contains(r2.message, 'beat 2 trainers', 'plural, and counted');
  t.false(r2.message.includes('everyone'),
          `no claim about the map it could not read: ${r2.message}`);
});

test('a beaten trainer is not walked back to', async (t) => {
  // **The rule the whole loop turns on.** Gen 2 leaves a beaten trainer on the
  // map for ever -- same sprite, same type byte, same sight range -- so a loop
  // that called `duelHere` afresh each round would walk back to the one it had
  // just beaten and spend every attempt asking it again. One spent set for the
  // job, handed down.
  //
  // Measured here as the number of walks: three trainers is three approaches,
  // not three times six attempts.
  const j = dueller({ trainers: crowd(3) });
  await j.clearHere();
  const walks = j.log.filter((l) => l.startsWith('walk'));
  const places = new Set(walks);
  t.eq(places.size, walks.length,
       `no tile approached twice: ${JSON.stringify(walks)}`);
});

test('a trainer the map placed but has not drawn is walked up to', async (t) => {
  // **The difference between clearing a route and only working next to
  // somebody.** Measured arriving on Route 31 at its western edge: `duelHere`
  // said "nobody near enough to fight" with a trainer placed seventeen tiles
  // east and not yet spawned. The placements say where they are whether drawn
  // or not, so the sweep closes the distance and asks again.
  let near = false;
  const far = { x: 21, y: 13, sprite: 37 };
  const j = dueller({
    at: [4, 6],
    placed: [far],                        // the map's list: always there
    trainers: () => (near ? [far] : []),  // spawned: only once we are close
  });
  // Walking is what brings them into being, which is what the game does -- the
  // object loads when the player gets near enough to draw it.
  const walkTo = j.nav.walkTo;
  j.nav.walkTo = async (...a) => { near = true; return walkTo(...a); };

  const r = await j.clearHere();
  t.true(j.log.some((l) => l.startsWith('walk')), 'it walked');
  t.contains(j.said.join(' '), 'walking up to whoever is at 21,13',
             'and said who it was walking at');
  t.eq(r.stats.won, 1, 'then fought them');
});

test('an already-beaten trainer does not end the sweep', async (t) => {
  // **Measured on Route 30, and it is the difference between sweeping a route
  // and giving up at its north end.** The pilot walked up to the trainer at
  // (1,7), found them already beaten -- Gen 2 leaves them standing there with
  // the same sprite and sight range -- and stopped, with two more placed at
  // (2,28) and (5,23) that had never been drawn.
  //
  // So an *empty* view and an *exhausted* view ask this loop the same question:
  // is there anybody further along, and can I get to them?
  const done = { x: 1, y: 7, sprite: 37 };
  const far = { x: 5, y: 23, sprite: 39 };
  let reached = false;
  const j = dueller({
    at: [1, 8],
    placed: [done, far],
    trainers: () => (reached ? [far] : [done]),
    // The near one will not fight, which is what "already beaten" looks like
    // from outside: reached, asked, and no battle.
    starts: false,
  });
  const walkTo = j.nav.walkTo;
  j.nav.walkTo = async (...a) => {
    if (a[1][1] > 20) reached = true;      // got down to the far one
    return walkTo(...a);
  };
  await j.clearHere();
  t.contains(j.said.join(' '), 'walking up to whoever is at 5,23',
             'it went looking for the one further along');
  t.false(j.said.join(' ').includes('whoever is at 1,7'),
          'and not back to the one it had just been told was finished');
});

test('a map of people who have all already lost says that, not "nobody here"',
     async (t) => {
  // Different things to do next: an empty map is empty, and a map of people who
  // have already lost to you is one you have finished with.
  const j = dueller({ trainers: crowd(1), starts: false });
  const r = await j.clearHere();
  t.contains(r.message, 'already been beaten', 'named for what it is');
});

test('a placement nothing can walk to is not asked about twice', async (t) => {
  // Otherwise the sweep spends every round walking at somebody behind a fence.
  const j = dueller({
    at: [4, 6],
    placed: [{ x: 21, y: 13, sprite: 37 }],
    trainers: () => [],
    open: () => false,
  });
  const r = await j.clearHere();
  t.false(r.message.includes('everyone'), 'no claim to have cleared it');
  const tries = j.said.filter((l) => l.includes('walking up to')).length;
  t.true(tries <= 1, `asked once, not once per round: ${tries}`);
});

test('the bag mends between rounds, and the walk to a Center does not',
     async (t) => {
  // A walk to a Center in the middle of this is a walk *out* of the map the job
  // is about, and the pilot would come back to fight the next one at whatever
  // HP the trip left it. So the pocket, which costs no steps.
  const j = dueller({ trainers: crowd(3), hurtPerFight: 6, bag: true });
  const r = await j.clearHere();
  t.eq(r.stats.won, 3, 'all three, because the bag kept up');
  t.true(j.log.filter((l) => l === 'bag').length >= 2,
         'the bag was reached for between rounds');
});

test('a party the bag cannot mend stops the job rather than fighting on',
     async (t) => {
  // Nothing in the pocket and somebody at nought: the next round would be
  // fought by nobody fit, and the Heal row above this one is what to do about
  // it. Reported with what was won, because two beaten trainers are still two.
  const j = dueller({ trainers: crowd(4), hurtPerFight: 20, bag: null });
  const r = await j.clearHere();
  t.eq(r.stats.won, 1, 'one, and then the lead was out');
  t.contains(r.message, 'nobody fit', 'and it says why it stopped');
});

test('a loss ends the job where a refusal would not', async (t) => {
  // Losing wipes the party and hands control back at the last Center, which is
  // not this map -- so the next round would be fought from the wrong place by
  // nobody fit. Not retried.
  const j = dueller({ trainers: crowd(4), outcome: 'lost' });
  const r = await j.clearHere();
  t.eq(r.stats.won, 0, 'nothing won');
  t.eq(r.stats.fought, 1, 'and it stopped after the one');
  t.contains(r.message, 'lost', 'saying so');
});

test('an empty map is not a failure, it is an empty map', async (t) => {
  const j = dueller({ trainers: () => [] });
  const r = await j.clearHere();
  t.true(r.ok, 'nothing went wrong');
  t.contains(r.message, 'nobody here', 'and it says what it found');
});

test('the rounds are bounded by who the map actually placed', async (t) => {
  // Not a number somebody picked: the map's own object list says how many
  // trainers it holds, so a trainer who declines twice cannot spin the loop.
  // Three placed plus the slack, and every round costs an approach.
  const j = dueller({ trainers: crowd(3), starts: false });
  const r = await j.clearHere();
  // Three placed, none of whom will fight, which on a cartridge means three
  // already beaten -- so there is nobody left, and that is not a failure.
  t.true(r.ok, `nothing left to fight: ${r.message}`);
  t.eq(r.stats.won, 0, 'and nothing was won');
  const walks = j.log.filter((l) => l.startsWith('walk')).length;
  t.true(walks <= 3 * 6 + 1, `bounded, not runaway: ${walks} walks`);
  t.true(walks >= 3, `and it did ask all three: ${walks} walks`);
});

test('Stop ends the clearing between rounds', async (t) => {
  const j = dueller({ trainers: crowd(4) });
  j.tasks.cancelled = true;
  const r = await j.clearHere();
  t.eq(r.stats.won, 0, 'nothing fought');
  t.contains(r.message, 'stopped', 'and it says so');
});

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

// --- the name the game gives -------------------------------------------------

/**
 * A ball script that hands over a Pokemon and then asks about a nickname.
 *
 * The shape is measured rather than invented. When the party grows the
 * question's text has barely begun -- the screen reads `G` -- and it then
 * *stops and waits for a button* with `wWindowStackSize` reading zero. One
 * press finishes it and draws the choice, which is up and stable from that
 * frame on. `pagesOfText` is how many presses that takes.
 */
function ballScript({ growsAt = 3, pagesOfText = 2 } = {}) {
  const sym = symbols();
  const at = (name) => sym.addr(name) - 0xc000;
  const wram = worldRam(sym, {});
  const log = [];
  let pressed = 0, party = 0, page = 0, answered = null, running = true;
  const show = (lines, open) => {
    paintScreen(wram, sym, lines);
    wram[at('wWindowStackSize')] = open ? 1 : 0;
  };
  show([], false);
  const j = new Journey(new FakeGameBoy({ wram }), new GameState(sym), null, {},
                        { mapKey: async () => 1 }, () => {}, null, {});
  j.said = [];
  j.say = (m) => j.said.push(m);
  j.scriptRunning = async () => running;
  j.snap = async () => ({
    ...new GameState(sym).read(wram),
    party: Array.from({ length: party }, () => ({ hp: 20 })),
  });
  j.gb = {
    readWram: async () => wram,
    press: async (button) => {
      pressed++;
      log.push(button);
      if (party === 0) {
        if (pressed >= growsAt) { party = 1; show([' G'], false); }
        return;
      }
      if (button === 'B') {
        // The measured answer: B on the choice keeps the species name.
        answered = 'default';
        show([], false);
        running = false;
        return;
      }
      // A hurries the text, and the press after the last page draws the choice.
      page++;
      if (page >= pagesOfText) show([' >YES', '  NO', ' Give a nickname'], true);
      else show([' Give a nickname to', ' the CYNDAQUIL you'], false);
    },
    run: async () => {},
  };
  j.tasks = { pump: async () => {} };
  j.log = log;
  j.answered = () => answered;
  return j;
}

test('the pressing stops the moment the party grows', async (t) => {
  // The line between the two questions. "Do you want CYNDAQUIL?" wants yes,
  // which pressing through gives; the nickname question wants no, and is the
  // next box.
  const j = ballScript({ growsAt: 3 });
  t.true(await j.runUntilParty(), 'it got that far');
  t.eq(j.log.length, 3, 'three presses, and not the fourth');
  t.eq(j.log.filter((b) => b !== 'A').length, 0, 'all of them A');
});

test('the name is kept through the shared primitive, and said out loud',
     async (t) => {
  // The behaviour is `tasks.keepDefaultName` -- tested against a real Tasks in
  // the menus cases, because the second caller is a catch with a full party.
  // What this layer adds is the sentence in the log.
  const j = ballScript({ growsAt: 1 });
  await j.runUntilParty();
  let asked = 0;
  j.tasks.keepDefaultName = async () => { asked++; return true; };
  t.true(await j.takeDefaultName(), 'it answered');
  t.eq(asked, 1, 'through the primitive');
  t.contains(j.said.join(' '), 'the name the game gave', 'and said so');
});

test('Stop ends the pressing before the party grows', async (t) => {
  const j = ballScript({ growsAt: 99 });
  j.tasks.cancelled = true;
  t.false(await j.runUntilParty(), 'the pressing stops');
  t.eq(j.log.length, 0, 'nothing was pressed');
});

// --- a window in the way is not a door that will not open -------------------

/**
 * A Journey at a doorway, with something on screen.
 *
 * `battles` is how many wild encounters interrupt the walk before it arrives,
 * which is what a long walk through grass actually looks like.
 */
function atADoor({ windowOpen = true, closes = true, battles = 0,
                  refuses = 0, saying = '' } = {}) {
  const sym = symbols();
  const wram = worldRam(sym, {});
  const at = (n) => sym.addr(n) - 0xc000;
  wram[at('wWindowStackSize')] = windowOpen ? 1 : 0;
  const log = [];
  let here = 1;
  const collision = { off: 0, calibrate: () => true, playerPos: () => [3, 3],
                      mapSize: () => [12, 8], collisionAt: () => 0 };
  const j = new Journey(new FakeGameBoy({ wram }), new GameState(sym), null,
                        collision, {
    mapKey: async () => here,
    walkTo: async () => {
      log.push('walk');
      if (battles > 0) { battles--; return { stopped: 'battle' }; }
      if (refuses > 0) { refuses--; return { stopped: 'refused' }; }
      here = 2;
      return { stopped: null };
    },
    step: async () => ({ blocked: false }),
  }, () => {}, null, {});
  j.said = [];
  j.say = (m) => j.said.push(m);
  j.escapeBattle = async () => true;
  j.runScripts = async () => { log.push('runScripts'); return true; };
  j.settled = async () => wram;
  j.tasks = {
    screenSaid: async () => saying,
    closeConversation: async () => {
      log.push('closeConversation');
      if (closes) wram[at('wWindowStackSize')] = 0;
      return closes;
    },
  };
  j.log = log;
  return j;
}

test('a walk closes what is on screen before blaming the door', async (t) => {
  // The defect, and it cost a wallet. Left standing at a mart counter with the
  // clerk's confirmation up, `travelTo` reported *could not get through to
  // Cherrygrove City* eight times over -- and the `runScripts` in the same loop
  // pressed A into that box on every one of them. A on a shop confirmation is a
  // purchase: 3000 to 100, in Poké Balls nobody asked for.
  //
  // Backed out with B rather than pressed through with A, which is the point: A
  // answers a question and B declines it, and a walk has no business answering
  // anything.
  const j = atADoor({ windowOpen: true });
  t.true(await j.through([2, 7], 2), 'it got through');
  t.eq(j.log[0], 'closeConversation', 'the screen was cleared first');
  t.true(j.log.indexOf('closeConversation') < j.log.indexOf('walk'),
         'before a step was taken');
  t.contains(j.said.join(' '), 'closing what is on screen', 'and it said so');
});

test('a wild encounter does not spend one of the door\'s tries', async (t) => {
  // Measured on the cartridge the pass a Pokémon Center could be *discovered*
  // rather than declared: Route 32's Center is ninety-six steps down ninety
  // tiles of grass, and `through`'s eight tries were gone long before the door.
  // A battle is progress-neutral -- the walk got partway and something jumped
  // out -- so counting it made the budget a function of the grass rather than
  // of the distance. Twelve encounters is an ordinary walk down that route.
  const j = atADoor({ windowOpen: false, battles: 12 });
  t.true(await j.through([2, 7], 2, 2), 'it still got through');
  t.eq(j.log.filter((l) => l === 'walk').length, 13,
       'thirteen walks on a budget of two tries');
});

test('the encounters a door will sit through are still bounded', async (t) => {
  // The other half of the same change: not counting battles must not mean
  // walking forever. Five hundred encounters and *then* the door is a route
  // that has stopped being a walk, and the answer has to be no rather than
  // eventually -- so the arrival is put out of reach of the allowance on
  // purpose, and a lost bound shows up as a `true` here instead of as a suite
  // that never finishes.
  const j = atADoor({ windowOpen: false, battles: 500 });
  t.false(await j.through([2, 7], 2), 'it gave up');
  t.true(j.log.length <= 41, `it stopped after the allowance, not ${j.log.length}`);
});

test('nothing on screen means nothing to close', async (t) => {
  const j = atADoor({ windowOpen: false });
  t.true(await j.through([2, 7], 2), 'it got through');
  t.false(j.log.includes('closeConversation'), 'no pressing at all');
});

test('a walk turned back twice says who turned it back', async (t) => {
  // Measured on the cartridge, and the reason this exists. The first Pokémon
  // Center the pilot ever *found* rather than was told about is on Route 32 --
  // and two tiles south of Violet a man says "Wait up! What's the hurry? Have
  // you gone to the POKéMON GYM?" and puts you back where you started. The door
  // is real and the ninety-six-step path to it is real; the game will not let
  // anyone down that route without Falkner's badge.
  //
  // `walkTo` reports `refused` when every direction is blocked, which is what a
  // running script looks like from outside, so the pilot pressed A and walked
  // at the same tile eight times over and then said *could not heal*. That
  // blames its own walking for a rule of the game, while the screen had the
  // reason on it in words the whole time.
  const j = atADoor({ windowOpen: false, refuses: 8, saying: 'Wait up! / What\'s the hurry?' });
  t.false(await j.through([2, 7], 2), 'it gave up');
  t.eq(j.log.filter((l) => l === 'walk').length, 2,
       'after two attempts, not eight');
  t.contains(j.said.join(' '), 'turned back', 'and it said it was turned back');
  t.contains(j.said.join(' '), 'Wait up!', 'in the words on the screen');
  t.eq(j.turnedBack, 'Wait up! / What\'s the hurry?', 'kept for the caller');
});

test('a refusal with nothing on screen is still just a refusal', async (t) => {
  // The other side of the rule, and the reason it keys on the words rather than
  // on the refusal. A tile somebody is standing on refuses too, and re-asking
  // is how that gets walked around -- so a silent refusal must keep spending
  // its tries the way it always did.
  const j = atADoor({ windowOpen: false, refuses: 3, saying: '' });
  t.true(await j.through([2, 7], 2), 'it got through on the fourth');
  t.eq(j.log.filter((l) => l === 'walk').length, 4, 'having spent four tries');
  t.eq(j.turnedBack, null, 'and nothing to name');
});

// --- a walk routes around a leg it cannot take ------------------------------

/**
 * A Journey over a ring of maps, with one leg the walk refuses.
 *
 * `refuse` is the edge that will not go, named the way a failure names it.
 */
function ringWalker({ refuse = null, saying = '', badges = 0 } = {}) {
  const sym = symbols();
  const [a, b, c, d, e] = [1, 2, 3, 4, 5];
  const edges = { [a]: { RIGHT: b, LEFT: e }, [b]: { LEFT: a, RIGHT: c },
                  [c]: { LEFT: b, RIGHT: d }, [d]: { LEFT: c, RIGHT: e },
                  [e]: { LEFT: d, RIGHT: a } };
  let here = a;
  const log = [];
  const world = {
    route: (from, to, { avoid = null } = {}) => {
      // Breadth-first over `edges`, honouring `avoid` -- the same contract
      // World.route keeps, small enough to state here.
      const seen = new Set([from]);
      const queue = [[from, []]];
      while (queue.length) {
        const [k, path] = queue.shift();
        for (const [dir, next] of Object.entries(edges[k] || {})) {
          if (avoid && avoid.has(`${k}>${next}`)) continue;
          if (seen.has(next)) continue;
          const step = path.concat({ kind: 'edge', dir, key: next });
          if (next === to) return step;
          seen.add(next);
          queue.push([next, step]);
        }
      }
      return null;
    },
  };
  const j = new Journey(new FakeGameBoy({ wram: worldRam(sym, { badges }) }),
                        new GameState(sym), null, {},
                        { mapKey: async () => here }, () => {}, world, {});
  j.tasks = { screenSaid: async () => saying };
  j.said = [];
  j.say = (m) => j.said.push(m);
  j.escapeBattle = async () => true;
  j.runScripts = async () => true;
  j.settled = async () => new Uint8Array(0x2000);
  j.crossEdge = async (dir, expect) => {
    // The real one runs `escapeBattle` at the top of every staged advance and
    // every edge attempt, which is the whole reason a battle it cannot play
    // gets asked about once per step. A fake that skips it cannot show that.
    await j.escapeBattle();
    if (j.stuckInBattle) return false;
    log.push(`${here}>${expect}`);
    if (refuse && `${here}>${expect}` === refuse) {
      // What the real one does on a gate: read the words on the refusal and
      // leave them where `travelTo` looks.
      j.turnedBack = saying || null;
      return false;
    }
    j.turnedBack = null;
    here = expect;
    return true;
  };
  j.log = log;
  return j;
}

test('a leg that will not go is routed around, not given up on', async (t) => {
  // Not a theoretical case. Route 29's connection struct says there is a map to
  // the north and there is -- Route 46 -- but the pilot cannot get up there,
  // and naming Violet City made that the shortest route to it by legs. The walk
  // refused UP three times and this gave up, on a town four ordinary legs away.
  const j = ringWalker({ refuse: '1>2' });
  const r = await j.travelTo(3);
  t.true(r.ok, `it arrived: ${r.message}`);
  t.contains(j.said.join(' '), 'trying another way', 'and said what it did');
  t.true(j.log.length > 2, 'having gone the long way round');
});

test('an edge somebody is refusing is written off, not just retried',
     async (t) => {
  // The other half of the write-off, and it needed the read moved. A gate
  // script *finishes* -- the man says his piece, moves the player back, and
  // stops -- so by the time three retries are done `runScripts` has pressed
  // the whole conversation away and the screen is blank. Asked afterwards it
  // found nothing and wrote off nothing, which is a mechanism that looks
  // correct and does nothing. Asked on the refusal, it works.
  const j = ringWalker({ refuse: '1>2', saying: 'Wait up! / no badge, no road' });
  const r = await j.travelTo(3);
  t.true(r.ok, `it still arrived the long way: ${r.message}`);
  t.true(j.isShut(1, 2), 'and the leg is written off for next time');
  t.contains(j.said.join(' '), 'turned back', 'said in those words');
  t.contains(j.said.join(' '), 'no badge, no road', 'quoting the game');
});

test('a gate stops the crossing rather than being retried at', async (t) => {
  // Measured on the cartridge, and it is why this exists: driving at Route 32's
  // southern connection with no badge, `crossEdge` ground away for over two and
  // a half minutes -- twelve staged advances, then thirty attempts per opening,
  // each walking the length of a ninety-tile route -- and the job looked hung.
  //
  // A refusal out there is usually a phone call, which is why the loops answer
  // one by running the scripts and asking again. A gate answers the same way
  // and never stops. So the second one gives up.
  const j = ringWalker({ refuse: '1>2', saying: 'Wait up! / no badge, no road' });
  const r = await j.travelTo(3);
  t.true(r.ok, `it went the other way: ${r.message}`);
  t.eq(j.log.filter((l) => l === '1>2').length, 1,
       'the shut leg was tried once, not three times over');
});

test('a leg that merely failed is still retried three times', async (t) => {
  // The other side, and the reason this keys on the words. Measured long ago:
  // the same leg failed on one run and worked on the next, so one silent
  // refusal is not an answer -- it is worth asking again from wherever we
  // ended up.
  const j = ringWalker({ refuse: '1>2', saying: '' });
  await j.travelTo(3);
  t.eq(j.log.filter((l) => l === '1>2').length, 3, 'three attempts');
  t.false(j.isShut(1, 2), 'and nothing written off, because nobody said no');
});

test('a written-off leg is not walked at again on the next press', async (t) => {
  // The point of remembering. Without this the pilot rediscovers the gate on
  // every press, at the cost of a walk across a route each time.
  const j = ringWalker({ refuse: '1>2', saying: 'somebody said no' });
  await j.travelTo(3);
  const first = j.log.length;
  j.log.length = 0;
  const again = await j.travelTo(3);
  t.true(again.ok, 'still arrives');
  t.false(j.log.includes('1>2'), 'without trying the shut leg at all');
  t.true(j.log.length < first, `fewer legs than the first time (${j.log.length} < ${first})`);
});

test('the short way is still the way when it works', async (t) => {
  const j = ringWalker();
  const r = await j.travelTo(3);
  t.true(r.ok, 'arrived');
  t.eq(j.log, ['1>2', '2>3'], 'two legs, no detour');
});

test('a graph with no walkable route says so, and how many it tried',
     async (t) => {
  // Every leg refused, which is the honest end of the search rather than the
  // loop running out: each failure removes an edge from a finite graph, so the
  // route runs out before the leg budget does.
  const j = ringWalker();
  j.crossEdge = async () => false;
  const r = await j.travelTo(3);
  t.false(r.ok, 'no way through');
  t.contains(r.message, 'refused', 'and it says how many legs it tried');
  t.contains(r.message, 'this can walk', 'distinguished from no route at all');
});

// --- one cost model, two lists of places ------------------------------------

test('the nearest mart is chosen, not the first one written down', async (t) => {
  // Measured on the cartridge: standing in Violet City with a Mart across the
  // street, `marts[0]` walked the pilot all the way back to Cherrygrove for a
  // potion. The same defect `heal()` had, in the other feature that keeps a
  // list of places -- and fixed by the two of them sharing one cost model.
  const FAR = 2, NEAR = 3;
  const title = {
    legCost: 25,
    marts: [{ map: 20, from: FAR }, { map: 30, from: NEAR }],
  };
  const j = walker({
    at: [3, 5], size: [60, 20], title,
    routes: {
      [FAR]: [{ kind: 'edge', dir: 'LEFT' }, { kind: 'edge', dir: 'UP' }],
      [NEAR]: [{ kind: 'edge', dir: 'LEFT' }],
    },
  });
  const picked = await j.nearestPlace(title.marts, 1, (m) => m.from || m.map);
  t.eq(picked.place.map, 30, 'the near one');
  t.eq(picked.cost, 3, 'priced in tiles to the edge it leaves by');
});

test('a place under our feet costs nothing and wins outright', async (t) => {
  const title = { legCost: 25, marts: [{ map: 20, from: 2 }, { map: 30, from: 1 }] };
  const j = walker({ title, routes: { 2: [{ kind: 'edge', dir: 'LEFT' }] } });
  const picked = await j.nearestPlace(title.marts, 1, (m) => m.from || m.map);
  t.eq(picked.place.map, 30, 'the one we are standing beside');
  t.eq(picked.cost, 0, 'and it costs nothing');
});

test('the grass it walks to is the nearest, not the first written down',
     async (t) => {
  // **The third caller to need this.** `restock` walked from Violet back to
  // Cherrygrove because it used `marts[0]`; `heal` picked the first healer
  // written down; both were fixed by one shared cost model, and this one still
  // walked the list in the order the title happened to write it.
  //
  // Measured: from Route 32 it set off for Route 29 at five legs while Route 31
  // sat two away, and a grind spent ninety-nine seconds and eighteen walking
  // steps without fighting anything.
  const FAR = 2, MID = 3, NEAR = 4;
  const title = { legCost: 25, grassyMaps: [FAR, MID, NEAR] };
  const went = [];
  const j = walker({
    title,
    routes: {
      [FAR]: [{ kind: 'warp' }, { kind: 'warp' }, { kind: 'warp' }],
      [MID]: [{ kind: 'warp' }, { kind: 'warp' }],
      [NEAR]: [{ kind: 'warp' }],
    },
  });
  j.onGrass = async () => false;
  j.findGrass = async () => went.length >= 1;   // arriving anywhere works
  j.travelTo = async (map) => { went.push(map); return { ok: true }; };
  t.true(await j.backToGrass(), 'it found grass');
  t.eq(went, [NEAR], 'and went to the near one, not the first listed');
});

test('grass further off is tried when the near one does not work out',
     async (t) => {
  // Picked one at a time rather than sorted once, because arriving somewhere
  // changes what is nearest -- and because a route that refuses has to leave
  // the others reachable.
  const FAR = 2, NEAR = 4;
  const title = { legCost: 25, grassyMaps: [FAR, NEAR] };
  const went = [];
  const j = walker({
    title,
    routes: { [FAR]: [{ kind: 'warp' }, { kind: 'warp' }], [NEAR]: [{ kind: 'warp' }] },
  });
  j.onGrass = async () => false;
  j.findGrass = async () => went.length >= 2;   // only the second try works
  j.travelTo = async (map) => { went.push(map); return { ok: true }; };
  t.true(await j.backToGrass(), 'it kept looking');
  t.eq(went, [NEAR, FAR], 'near first, then the other one');
});

test('a battle nothing can play ends the search for grass', async (t) => {
  // Otherwise the grind walks the whole list while a battle it cannot finish
  // makes every step of it pointless.
  const title = { legCost: 25, grassyMaps: [2, 3, 4] };
  const went = [];
  const j = walker({ title, routes: { 2: [{ kind: 'warp' }], 3: [{ kind: 'warp' }],
                                      4: [{ kind: 'warp' }] } });
  j.onGrass = async () => false;
  j.findGrass = async () => false;
  j.travelTo = async (map) => { went.push(map); j.battleStuck = true; return { ok: true }; };
  t.false(await j.backToGrass(), 'it gives up');
  t.eq(went.length, 1, 'after one, not three');
});

test('an empty list has no nearest anything', async (t) => {
  const j = walker({ title: {} });
  t.eq(await j.nearestPlace([], 1), null, 'nothing to choose between');
});

// --- a route the game itself refuses ----------------------------------------

test('a place the game turned us back from is not offered again', async (t) => {
  // The feature the pass before earned. Standing on Route 32 the Center *on*
  // Route 32 costs nothing, and a man two tiles south turns the player back
  // until Falkner is beaten -- so the cheapest answer was the one answer that
  // could not work, and the pilot walked at it on every press.
  //
  // Written off by *leg*, because "shut from here" is what was measured: the
  // same Center may well be open from the south.
  // **The real healer shape, and it is the point of this test.** An entry
  // names two maps: `map` is the town you stand in, `inside` is the room behind
  // the door. Route 32 is 2561 and its Center is 2573, and `healAtCenter` walks
  // `through(door, inside)` -- so the leg written off is `2561>2573`, not
  // `2561>2561`. The first version of this filter asked about the second, which
  // nothing ever writes, and it did nothing at all on a cartridge.
  //
  // It passed a test, too, because the fake healer had been written with one
  // map and no `inside` -- matching the mistake rather than the game.
  const title = {
    legCost: 25,
    healers: [{ map: 2, inside: 20, reach: 'healAtFar' },
              { map: 1, inside: 10, reach: 'healAtNear' }],
  };
  const j = walker({ title, routes: { 2: [{ kind: 'warp' }] } });
  const under = await j.nearestPlace(title.healers, 1);
  t.eq(under.place.map, 1, 'under our feet, so it wins outright');
  t.eq(under.cost, 0, 'at no cost');

  j.shutLeg(1, 10, "Wait up! / What's the hurry?", 0);
  const after = await j.nearestPlace(title.healers, 1);
  t.eq(after.place.map, 2, 'now the one a leg away');
  t.eq(after.cost, 0, 'priced by the route, not skipped');
  t.eq(j.shutSaid(1, 10), "Wait up! / What's the hurry?",
       'and the words are kept, for a row that has to explain itself');
});

test('choosing a place sweeps the write-offs itself', async (t) => {
  // Nobody calls `reopen` before pressing Heal, so the caller that reads the
  // badge count out of work RAM has to be the one that asks -- and a test that
  // sweeps by hand first proves the sweep and not the caller. This one does
  // not touch it: one badge in the snapshot, an entry written off at none, and
  // the near place has to come back on its own.
  const title = {
    legCost: 25,
    healers: [{ map: 2, inside: 20, reach: 'healAtFar' },
              { map: 1, inside: 10, reach: 'healAtNear' }],
  };
  const j = walker({ title, routes: { 2: [{ kind: 'warp' }] },
                     world: { party: [{ hp: 4, maxHp: 20 }], badges: 1 } });
  j.shutLeg(1, 10, 'a man with a rite of passage', 0);
  const picked = await j.nearestPlace(title.healers, 1);
  t.eq(picked.place.map, 1, 'the near one, re-opened by the badge');
  t.eq(j.shut.size, 0, 'and the entry swept away by the asking');
});

test('a place beyond a shut leg is not offered either', async (t) => {
  // A door being open says nothing about the road to it. An edge refused
  // mid-route makes everything past it unreachable, and the graph already
  // knows how to be asked that -- so the same set that skips a shut door is
  // handed to `route` as the legs it may not use.
  const title = {
    legCost: 25,
    healers: [{ map: 3, inside: 30, reach: 'healAtFar' },
              { map: 2, inside: 20, reach: 'healAtNear' }],
  };
  const j = walker({
    title,
    routes: { 2: [{ kind: 'warp' }], 3: [{ kind: 'warp' }, { kind: 'warp' }] },
    via: { 2: ['1>2'], 3: ['1>9', '9>3'] },
  });
  const before = await j.nearestPlace(title.healers, 1);
  t.eq(before.place.map, 2, 'the near one to start with');

  j.shutLeg(1, 2, 'a guard on the near road', 0);
  const after = await j.nearestPlace(title.healers, 1);
  t.eq(after.place.map, 3, 'the far one, once the near road is shut');

  j.shutLeg(9, 3, 'a guard on the far road too', 0);
  const both = await j.nearestPlace(title.healers, 1);
  t.eq(both.cost, undefined, 'and with both shut it cannot price anything');
});

test('a shut mart is read off the other list shape, not the healers\' one',
     async (t) => {
  // The two lists name their two maps the opposite way round -- a healer's
  // `map` is the town and its `inside` is the room; a mart's `from` is the town
  // and its `map` is the room. So `place.map` means different things in the two
  // lists, and a reader that guesses gets one of them wrong every time. It got
  // both wrong, in turn, within an afternoon.
  const marts = [{ map: 30, from: 3 }, { map: 10, from: 1 }];
  const j = walker({ title: { legCost: 25, marts },
                     routes: { 3: [{ kind: 'warp' }] } });
  const mapOf = (m) => m.from || m.map;

  const before = await j.nearestPlace(marts, 1, mapOf);
  t.eq(before.place.map, 10, 'the mart in the town we are standing in');

  // What `through(door, map)` writes for a mart: town to room.
  j.shutLeg(1, 10, 'the shutters are down', 0);
  t.true(j.shutBetween(1, marts[1], mapOf), 'that is the leg the reader wants');
  const after = await j.nearestPlace(marts, 1, mapOf);
  t.eq(after.place.map, 30, 'so the other town is chosen');
});

test('a place with no door at all is judged on the road to it', async (t) => {
  // Elm's computer is a healer with one map and no door -- there is nothing to
  // walk `through`. So the only question is the road, and asking about a door
  // that does not exist must not answer yes.
  const healers = [{ map: 2, reach: 'healAtFar' }, { map: 1, reach: 'healAtNear' }];
  const j = walker({ title: { legCost: 25, healers },
                     routes: { 2: [{ kind: 'edge', dir: 'LEFT' }] } });
  t.eq(Journey.doorTo(healers[0]), null, 'no door named');
  t.false(j.shutBetween(1, healers[1]), 'and nothing shut, so it is open');
  j.shutLeg(1, 1, 'a guard', 0);
  t.true(j.shutBetween(1, healers[1]), 'shut on the road, which is the only way in');
});

test('nearestHeal quotes the door that refused, not the town it is in',
     async (t) => {
  // Two maps in one entry, and the words belong to the leg that was walked.
  // Reporting `map` instead of `inside` looked identical in every log and was
  // simply always null.
  const title = { legCost: 25,
                  healers: [{ map: 1, inside: 10, reach: 'healAtNear' }] };
  const j = walker({ title, routes: {} });
  j.shutLeg(1, 10, "Wait up! / What's the hurry?", 0);
  const pick = await j.nearestHeal(1);
  t.eq(pick.map, 1, 'the town is what a row names');
  t.eq(pick.shut, "Wait up! / What's the hurry?", 'and the door is what refused');
});

test('a badge re-opens every route that was written off', async (t) => {
  // Because the pilot has no idea which badge opened which route, and guessing
  // would be worse than asking again. One walk that would have worked is the
  // cost of being wrong this way round; the same wall on every press is the
  // cost of being wrong the other.
  const title = {
    legCost: 25,
    healers: [{ map: 2, inside: 20, reach: 'healAtFar' },
              { map: 1, inside: 10, reach: 'healAtNear' }],
  };
  const j = walker({ title, routes: { 2: [{ kind: 'warp' }] },
                     world: { party: [{ hp: 4, maxHp: 20 }], badges: 1 } });
  j.shutLeg(1, 10, 'a man with a rite of passage', 0);
  t.eq(j.reopen(1), 1, 'one badge beats the none it was shut with');
  t.false(j.isShut(1, 10), 'so the leg is open again');
  const after = await j.nearestPlace(title.healers, 1);
  t.eq(after.place.map, 1, 'so the near one is offered again');
  t.eq(j.shut.size, 0, 'and the write-off is gone rather than merely ignored');
});

test('a cartridge that will not say how many badges keeps its write-offs',
     async (t) => {
  // The safe way round, and it is a real cartridge: `wJohtoBadges` is optional,
  // like the tilemap. Believing a stale write-off costs one walk that would
  // have worked. Forgetting a real one costs that walk on every press.
  const j = walker({ title: {} });
  j.shutLeg(1, 2, 'somebody said no', null);
  t.eq(j.reopen(null), 0, 'no count now, so nothing to compare');
  t.eq(j.reopen(3), 0, 'and a count now cannot expire an entry that had none');
  t.true(j.isShut(1, 2), 'so it stays shut');
});

test('everything shut still gives an answer rather than nothing', async (t) => {
  // `nearestHeal` returning null means *nowhere to heal that this build knows
  // about*, which is a different and wronger sentence than "the way is shut".
  const title = { legCost: 25, healers: [{ map: 2, reach: 'healAtFar' }] };
  const j = walker({ title, routes: { 2: [{ kind: 'warp' }] } });
  j.shutLeg(1, 2, 'no', 0);
  const picked = await j.nearestPlace(title.healers, 1);
  t.eq(picked.place.map, 2, 'the last one, named');
  t.eq(picked.cost, undefined, 'with no cost, which is how it says it cannot price it');
});

// --- the cartridge names its own places -------------------------------------

test("a map the title never named is offered under the cartridge's own name",
     async (t) => {
  // The one table that retires hand-written data rather than adding to it.
  // Until this pass a map was called whatever the title said and everything
  // else was "map 26.1" -- ten names out of two hundred and fifty. Every map
  // header carries a landmark id and `Landmarks` is a table of names, so the
  // game knows all of them.
  const j = traveller({
    reachable: { 2: 1, 3: 2 },
    names: { 2: "Elm's lab" },
    landmarks: { 2: 'NEW BARK TOWN', 3: 'VIOLET CITY' },
  });
  const places = j.placesFrom(HOME);
  t.eq(places.map((p) => p.name), ["Elm's lab", 'VIOLET CITY'],
       'the title name, then the one nobody wrote down');
});

test("the title's name wins, because a hand-written one can be better",
     async (t) => {
  // "Elm's lab" against the cartridge's "NEW BARK TOWN", which is the town the
  // lab is in: several maps share a landmark, and that is right for naming a
  // place and wrong for naming a building.
  const j = traveller({ reachable: { 2: 1 }, names: { 2: "Elm's lab" },
                        landmarks: { 2: 'NEW BARK TOWN' } });
  t.eq(j.where(2), "Elm's lab", 'the title');
  t.eq(j.landmarkName(2), 'NEW BARK TOWN', 'and the cartridge, asked directly');
});

test('one entry per place, not one per map', async (t) => {
  // A city, its Mart and its Center all carry the city's landmark. Offering
  // three rows that say VIOLET CITY would be worse than offering one.
  const j = traveller({
    reachable: { 2: 1, 3: 1, 4: 2 },
    landmarks: { 2: 'VIOLET CITY', 3: 'VIOLET CITY', 4: 'ROUTE 32' },
  });
  t.eq(j.placesFrom(HOME).map((p) => p.name), ['VIOLET CITY', 'ROUTE 32'],
       'the nearest map of each');
});

test('a map with no landmark of its own is not offered', async (t) => {
  // Landmark 0 is SPECIAL, which is what an indoor map with no place of its own
  // gets -- and "SPECIAL" is not somewhere to walk to.
  const j = traveller({ reachable: { 2: 1 }, landmarks: {} });
  t.eq(j.placesFrom(HOME), [], 'nothing to offer');
  t.eq(j.where(2), 'map 0.2', 'and it is still named by its numbers');
});

test('a graph that cannot list exits still offers what the title named',
     async (t) => {
  const j = traveller({ reachable: { 2: 1 }, names: { 2: 'Route 29' } });
  j.world.exits = undefined;
  t.eq(j.placesFrom(HOME).map((p) => p.name), ['Route 29'], 'the title half');
});

test('the place we are standing in is not offered as somewhere to go',
     async (t) => {
  // `routesFrom` already excludes *this map*, and that is not the same thing:
  // measured from Route 29, a gate one leg away carries Route 29's own
  // landmark, so the list offered to walk to "ROUTE 29" from Route 29.
  const j = traveller({
    reachable: { 2: 1, 3: 1 },
    landmarks: { [HOME]: 'ROUTE 29', 2: 'ROUTE 29', 3: 'VIOLET CITY' },
  });
  t.eq(j.placesFrom(HOME).map((p) => p.name), ['VIOLET CITY'],
       'the gate that shares our landmark is not a destination');
});

test('the list is bounded, because the graph is not', async (t) => {
  // Six legs from Route 29 gives forty rows on the real cartridge, which is a
  // data dump by this file's own standard. The nearest two dozen is an offer.
  const reachable = {}, landmarks = {};
  for (let k = 2; k < 60; k++) { reachable[k] = 1; landmarks[k] = `PLACE ${k}`; }
  const j = traveller({ reachable, landmarks });
  t.eq(j.placesFrom(HOME).length, 24, 'two dozen');
});

test('a refused leg does not spend the walk budget', async (t) => {
  // How the first walk to a landmark-only place failed: DARK CAVE is two legs
  // from Route 29 through Route 46, the pilot cannot get up there, and every
  // refusal spent one of the twelve legs until the budget ran out in
  // Cherrygrove with *too many legs*.
  const j = ringWalker({ refuse: '1>2' });
  const r = await j.travelTo(3, { maxLegs: 3 });
  t.true(r.ok, `it arrived on a budget of three: ${r.message}`);
  t.eq(j.log.filter((l) => l !== '1>2').length, 3, 'three legs actually walked');
});

test('a graph of nothing but refusals is given up on, and says so', async (t) => {
  // The routes run out before the refusal cap does on a graph this small, which
  // is the better of the two answers: it says there is no way *this can walk*,
  // as against no way at all.
  const j = ringWalker();
  j.crossEdge = async () => false;
  const r = await j.travelTo(3, { maxLegs: 12 });
  t.false(r.ok, 'no way through');
  t.contains(r.message, 'this can walk', 'and which kind of no it is');
  t.contains(r.message, 'refused', 'with a count of what it tried');
});

// --- the cartridge shows its own Centers and Marts --------------------------

/**
 * A Journey whose graph can be asked what is behind a door.
 *
 * `rooms` maps a map key to the objects the ROM places on it, which is the one
 * thing `collision` can never answer: it reads work RAM, so it only knows the
 * map that is loaded, and the pilot needs to know what is behind a door before
 * it walks through.
 */
function explorer({ warps = {}, rooms = {}, title = {} } = {}) {
  const sym = symbols();
  const world = {
    warps: (g, n) => warps[g * 256 + n] || [],
    objectsOn: (g, n) => rooms[g * 256 + n] || [],
    exits: (key) => (warps[key] || []).map((w) => ({ kind: 'warp', key: w.key })),
    route: () => [],
  };
  const j = new Journey(new FakeGameBoy({ wram: worldRam(sym, {}) }),
                        new GameState(sym), null, {},
                        { mapKey: async () => 1 }, () => {}, world, title);
  return j;
}

const NURSE = { sprite: 55, x: 3, y: 1 };
const CLERK = { sprite: 57, x: 1, y: 3 };

test('a Center is recognised through the door, before walking in', async (t) => {
  // The last thing in this app that had to be written out by hand. A title said
  // where the Centers were, so the pilot healed in the two towns somebody had
  // described and nowhere else -- and the cartridge has always known: a Center
  // is the room with the nurse behind her counter.
  const j = explorer({
    warps: { 1: [{ x: 29, y: 3, key: 5 }, { x: 23, y: 3, key: 6 }] },
    rooms: { 5: [NURSE, { sprite: 41, x: 1, y: 6 }], 6: [CLERK] },
  });
  const found = j.discover('center', 1);
  t.eq(found.length, 1, 'one Center behind one of the two doors');
  t.eq(found[0].inside, 5, 'the room with the nurse');
  t.eq(found[0].door, [29, 3], 'reached by its own door tile');
  t.eq(found[0].reach, 'healAtCenter', 'and driven by the shared procedure');
  t.eq(found[0].nurse, [3, 1], 'which is told where she stands');
});

test('a Mart is recognised, and the counter is a wall', async (t) => {
  // Measured in Cherrygrove: the clerk sits at (1,3) and the only tile you can
  // talk to him from is (3,3) facing LEFT, two away across a corner.
  const j = explorer({
    warps: { 1: [{ x: 23, y: 3, key: 6 }] },
    rooms: { 6: [CLERK] },
  });
  const found = j.discover('mart', 1);
  t.eq(found.length, 1, 'one Mart');
  t.eq(found[0].stand, [3, 3], 'stand two along the row');
  t.eq(found[0].face, 'LEFT', 'and face back at him');
  t.eq(found[0].from, 1, 'entered from the map we are standing on');
});

test('a room with the right sprite in the wrong place is not claimed',
     async (t) => {
  // Narrow on purpose: of twenty-six maps carrying a clerk, thirteen have him
  // at (1,3) and the rest are department-store floors and kiosks. A wrong match
  // walks the pilot into a stranger's front room.
  const j = explorer({
    warps: { 1: [{ x: 1, y: 1, key: 7 }] },
    rooms: { 7: [{ sprite: 57, x: 13, y: 5 }] },
  });
  t.eq(j.discover('mart', 1), [], 'not a standard Mart');
});

test('a cartridge with no signatures discovers nothing', async (t) => {
  // The generic profile's position, and the same rule the takeable sprites
  // follow: a sprite id is exactly the kind of thing a hack moves.
  const j = explorer({ warps: { 1: [{ x: 1, y: 1, key: 5 }] },
                       rooms: { 5: [NURSE] } });
  j.state.e = { ...j.state.e, places: undefined };
  t.eq(j.discover('center', 1), [], 'nothing is claimed');
});

test('what the title declared comes first, and is not found twice', async (t) => {
  // Elm's computer is a healer no signature will ever recognise, and it is the
  // only one available before the Pokedex -- so a declared entry is not just
  // preferred, it is sometimes the only one there is.
  const title = { healers: [{ map: 9, reach: 'healAtElm' },
                            { map: 1, reach: 'healAtCenter', inside: 5,
                              door: [29, 3], nurse: [3, 1] }] };
  const j = explorer({
    warps: { 1: [{ x: 29, y: 3, key: 5 }, { x: 1, y: 1, key: 8 }] },
    rooms: { 5: [NURSE], 8: [NURSE] },
    title,
  });
  const list = await j.healerList(1);
  t.eq(list.length, 3, 'two declared, one found');
  t.eq(list[0].reach, 'healAtElm', 'the declared ones first');
  t.true(list[1].inside === 5 && !list[1].found, 'the declared Center, not the found one');
  t.true(list[2].inside === 8 && list[2].found, 'and the one nobody described');
});

// --- declared gates ---------------------------------------------------------
//
// A *declared* gate, as against the write-off map, which is observed: one is
// knowledge a title carries and the other is a walk that failed. The difference
// is that a declared gate comes with a remedy, and the game's own words rarely
// do -- the man on Route 32 says "Wait up! What's the hurry?", which is no help
// to anybody.
//
// The one in `titles/crystal.js` was read out of the cartridge: his script
// checks event $2d, and the only thing in the ROM that sets $2d is Elm's aide
// in Violet's Pokémon Center, asking you to take the Egg.

const gated = (events = []) => {
  const gb = new FakeGameBoy({ wram: worldRam(sym, { events }) });
  const title = {
    names: { 1: 'Violet City', 10: 'ROUTE 32', 13: "Violet's Pokémon Center" },
    gates: [{ from: 1, to: 10, event: 0x2d,
              needs: 'Elm’s aide has an Egg for you', at: 13 }],
  };
  const j = new Journey(gb, new GameState(sym), null, null,
                        { mapKey: async () => 1 }, () => {}, {}, title);
  return j;
};

test('a gate is found by its leg, and only in the direction it faces',
     async (t) => {
  const j = gated();
  t.ne(j.gateFor(1, 10), null, 'south out of Violet is gated');
  t.eq(j.gateFor(10, 1), null, 'and walking north is not');
  t.eq(j.gateFor(1, 99), null, 'nor is any other leg');
});

test('a gate whose event is unset says what to do about it', async (t) => {
  const j = gated();
  const wram = worldRam(sym, {});
  t.contains(j.gateSaid(1, 10, wram), 'Egg', 'what is wanted');
  t.contains(j.gateSaid(1, 10, wram), 'Pok', 'and where it is');
});

test('a gate whose event is set is not in the way any more', async (t) => {
  const j = gated();
  t.eq(j.gateSaid(1, 10, worldRam(sym, { events: [0x2d] })), null,
       'the Egg has been taken, so there is nothing to say');
});

test('a cartridge that cannot read events says nothing rather than "shut"',
     async (t) => {
  // The distinction the feature rests on. `hasEvent` answers null where the
  // symbol file has no `wEventFlags`, and null must not become a sentence
  // claiming the road is closed -- an app that cannot tell has to stay quiet.
  const gb = new FakeGameBoy({ wram: worldRam(sym, {}) });
  const blind = new GameState({ ...sym, has: (n) => n !== 'wEventFlags',
                                addr: sym.addr, bank: sym.bank });
  const j = new Journey(gb, blind, null, null, { mapKey: async () => 1 },
                        () => {}, {},
                        { gates: [{ from: 1, to: 10, event: 0x2d,
                                    needs: 'an Egg' }] });
  t.eq(j.gateSaid(1, 10, worldRam(sym, {})), null, 'quiet, not confident');
});

test('a written-off leg reports the remedy in preference to the words',
     async (t) => {
  const j = gated();
  j.shutLeg(1, 10, "Wait up! / What's the hurry?", 0,
            j.gateSaid(1, 10, worldRam(sym, {})));
  t.contains(j.shutSaid(1, 10), 'Egg', 'the thing to do about it');
  t.false(j.shutSaid(1, 10).includes('hurry'),
          'rather than the sentence that explains nothing');
});

test('taking the Egg reopens the road, with no badge having changed',
     async (t) => {
  // The other half of a declared gate, and the half a badge cannot do: the
  // write-off would otherwise outlive the remedy and the road would stay shut
  // for the rest of the session.
  const j = gated();
  const before = worldRam(sym, {});
  j.shutLeg(1, 10, 'Wait up!', 0, j.gateSaid(1, 10, before));
  t.eq(j.reopen(0, before), 0, 'nothing expires while the Egg is unclaimed');
  t.true(j.isShut(1, 10), 'so the leg stays written off');
  t.eq(j.reopen(0, worldRam(sym, { events: [0x2d] })), 1, 'and expires once it is');
  t.false(j.isShut(1, 10), 'the road is offered again');
});

test('a leg written off for some other reason is not reopened by a gate',
     async (t) => {
  // `why` is what marks a write-off as a gate's. One without it is an ordinary
  // refusal and only a badge expires it, which is the behaviour that was there
  // before gates existed and has to stay.
  const j = gated();
  j.shutLeg(1, 10, 'a locked door', 0);
  t.eq(j.reopen(0, worldRam(sym, { events: [0x2d] })), 0, 'not a gate, not swept');
  t.true(j.isShut(1, 10), 'still written off');
});

// --- more than one gym ------------------------------------------------------
//
// `gyms` held a single entry from the day it was written until v169, so the
// rules about choosing between them had never been exercised. The pilot reads
// the badge case rather than remembering, which means the choice is made from
// work RAM every time it is asked.

const twoGyms = (badges = 0) => {
  const title = { legCost: 25, heals: ['potion'], gyms: [
    { map: 2565, inside: 2567, door: [18, 17],
      leader: 'FALKNER', leaderAt: [5, 1], badge: 0 },
    { map: 2055, inside: 2053, door: [10, 15],
      leader: 'BUGSY', leaderAt: [5, 7], badge: 1 },
  ] };
  const gb = new FakeGameBoy({ wram: worldRam(sym, { badges }) });
  const j = new Journey(gb, new GameState(sym), null, null,
                        { mapKey: async () => 2565 }, () => {}, {}, title);
  j.snap = async () => ({ inBattle: false, wram: gb.wram, party: [], balls: [],
                          items: [], money: 0 });
  return j;
};

test('with no badges, the first gym is the one on offer', async (t) => {
  const list = await twoGyms(0).gymList(2565);
  t.eq(list.map((g) => g.leader), ['FALKNER', 'BUGSY'], 'both, in order');
  t.eq(list[0].leader, 'FALKNER', 'and the first is first');
});

test('a gym that has been won drops off the list, and the next one leads',
     async (t) => {
  // One badge in the case, set from the bottom bit up, which is how the real
  // one reads: beating Falkner sets bit 0.
  const list = await twoGyms(1).gymList(2565);
  t.eq(list.map((g) => g.leader), ['BUGSY'], 'Falkner is done');
});

test('with every badge won there is no gym to offer', async (t) => {
  const list = await twoGyms(2).gymList(2565);
  t.eq(list, [], 'nothing left');
});

test('each gym carries its own town as the leg to walk', async (t) => {
  // `from: g.map` is what the row prices and what `beatGym` walks to, so two
  // gyms in different towns must not share one. This was free with one entry.
  const list = await twoGyms(0).gymList(2565);
  t.eq(list.map((g) => g.from), [2565, 2055], 'each its own town');
  t.eq(new Set(list.map((g) => g.from)).size, 2, 'and they differ');
});
