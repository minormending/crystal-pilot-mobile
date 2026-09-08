// The tiles someone is standing on.
//
// collision.js had no tests, because the harness could not describe a map.
// This is the half that can be tested without a cartridge: which map objects
// become tiles to route around, and which are thrown away.
import { symbols, test, worldRam } from '../harness.mjs';
import { CollisionMap } from '../../gen2/collision.js';

// Route 30 in blocks, because the tiles below are its real ones and the default
// map here is a room. Ten by twenty-seven blocks is twenty by fifty-four tiles,
// which is the map the trainers and the ball were measured on.
const ROUTE_30 = [10, 27];

/** A CollisionMap over one snapshot. Nothing here reaches the ROM. */
function mapWith({ mapBlocks = [5, 6], objects = [], spawned = null,
                   pos = [7, 4], engine = undefined } = {}) {
  const sym = symbols();
  const cm = new CollisionMap(sym, { romByte: () => 0 }, engine);
  return cm.use(worldRam(sym, { mapBlocks, objects, spawned, pos }));
}

/** The same map with no object structs in its symbol file at all. */
function noStructs({ objects = [], mapBlocks = [5, 6] } = {}) {
  const sym = symbols();
  const bare = { has: (n) => n !== 'wObjectStructs' && sym.has(n),
                 addr: (n) => sym.addr(n), bank: (n) => sym.bank(n) };
  const cm = new CollisionMap(bare, { romByte: () => 0 });
  return cm.use(worldRam(sym, { mapBlocks, objects }));
}

test('map objects become tiles, four lower than the cartridge stores them', async (t) => {
  // Measured in Elm's lab: a 5x6-block map, so 10x12 tiles, with objects the
  // ROM records at (7,8), (6,13) and (10,7).
  const cm = mapWith({ objects: [
    { sprite: 1, x: 8, y: 15 },     // index 0 is the player
    { sprite: 16, x: 7, y: 8 },
    { sprite: 60, x: 6, y: 13 },
    { sprite: 84, x: 10, y: 7 },
  ] });
  t.eq(cm.placedObjects().map((o) => `${o.x},${o.y}`),
       ['4,11', '3,4', '2,9', '6,3'], 'four placements, minus the origin');
  t.eq(cm.placedObjects()[0].index, 0, 'and the player is kept, as index zero');
});

test('an object outside the map is dropped rather than kept as a key', async (t) => {
  // The only check available: the entry at index 0 holds where the map *placed*
  // the player, not where the player is -- (8,15) while standing at (7,4) -- so
  // nothing in this array can confirm the origin. Bounds can.
  const cm = mapWith({ mapBlocks: [2, 2], objects: [   // 4x4 tiles
    { sprite: 1, x: 5, y: 5 },      // (1,1): the player, inside
    { sprite: 16, x: 6, y: 5 },     // (2,1): inside
    { sprite: 16, x: 40, y: 6 },    // (36,2): far off the right
    { sprite: 16, x: 1, y: 6 },     // (-3,2): before the left edge
  ] });
  t.eq(cm.placedObjects().map((o) => `${o.x},${o.y}`), ['1,1', '2,1'],
       'only the two that are on the map');
});

test('a sprite of zero is an empty slot, not an object at the origin', async (t) => {
  const cm = mapWith({ objects: [
    { sprite: 1, x: 8, y: 15 },
    { sprite: 0, x: 4, y: 4 },      // would be (0,0) if it counted
    { sprite: 7, x: 9, y: 9 },
  ] });
  t.eq(cm.placedObjects().map((o) => o.index), [0, 2], 'the empty slot is skipped');
});

// --- who is actually standing there -----------------------------------------

test('the tiles to route around are where objects are, not where they were put',
     async (t) => {
  // The measurement this exists for, off one screen of Route 30: the wanderer
  // the map placed at (7,30) was standing at (8,30). Read from the placements
  // this marked an empty tile and left an occupied one open -- wrong in both
  // directions at once, from the same byte.
  const cm = mapWith({
    mapBlocks: ROUTE_30,
    objects: [
      { sprite: 1, x: 8, y: 15 },
      { sprite: 39, x: 11, y: 34 },     // placed at (7,30)
    ],
    spawned: [{ placed: 1, sprite: 39, x: 12, y: 34 }],   // standing at (8,30)
  });
  t.eq([...cm.occupied()], ['8,30'], 'where it is');
  t.false(cm.occupied().has('7,30'), 'and not where the map put it');
});

test('an object the game has not spawned is not in the way', async (t) => {
  // Also Route 30, also measured: it places a trainer at (2,28) that a new save
  // has never seen, because the flag that reveals it is unset. There is no
  // struct for it, and standing on that tile is nobody.
  const cm = mapWith({
    mapBlocks: ROUTE_30,
    objects: [
      { sprite: 1, x: 8, y: 15 },
      { sprite: 39, x: 6, y: 32 },      // placed at (2,28), never spawned
      { sprite: 39, x: 9, y: 29 },      // placed at (5,25), and here
    ],
    spawned: [{ placed: 2, sprite: 39, x: 9, y: 29 }],
  });
  t.eq([...cm.occupied()], ['5,25'], 'only the one the game loaded');
});

test("the player's own struct is not an obstacle to the player", async (t) => {
  // Struct 0 is the player's, and the harness leaves it empty for the reason
  // the reader skips it: a walk that avoided the tile it was standing on could
  // not take a first step.
  const cm = mapWith({
    objects: [{ sprite: 1, x: 8, y: 15 }, { sprite: 39, x: 9, y: 9 }],
    spawned: [{ placed: 1, sprite: 39, x: 9, y: 9 }],
  });
  t.eq([...cm.occupied()], ['5,5'], 'the other one, and only it');
});

test('a symbol file with no object structs falls back to the placements',
     async (t) => {
  // The old behaviour, kept deliberately for a cartridge whose .sym does not
  // name the array: stale tiles beat no tiles, because walking into somebody
  // costs one refused step and nav.walkTo drops this whole set when it seals a
  // route.
  const cm = noStructs({ objects: [
    { sprite: 1, x: 8, y: 15 },
    { sprite: 16, x: 7, y: 8 },
  ] });
  t.eq(cm.liveObjects(), null, 'cannot tell, which is not the same as nothing');
  t.eq([...cm.occupied()], ['3,4'], 'so the placement is used, player aside');
});

// --- what the map is holding -------------------------------------------------

test('an item ball and a fruit tree are told apart from the people', async (t) => {
  // Both sprite ids measured on the cartridge and carried in the engine
  // profile: Route 31's ball, the one the errand fetches, has sprite 84 in the
  // ROM's object_events at exactly its known tile, and pressing A on the object
  // with that sprite on Route 30 gave an ANTIDOTE. Sprite 93 is a fruit tree --
  // Route 30's two gave a BERRY and a PSNCUREBERRY.
  const cm = mapWith({ objects: [
    { sprite: 1, x: 8, y: 15 },     // the player
    { sprite: 39, x: 7, y: 8 },     // somebody
    { sprite: 84, x: 6, y: 13, type: 1 },    // an item ball
    { sprite: 93, x: 10, y: 7 },    // a fruit tree
  ] });
  t.eq(cm.takeables(), [{ x: 2, y: 9, what: 'ball' }, { x: 6, y: 3, what: 'tree' }],
       'the two that hold something, and not the person');
});

test('a takeable is read from the placements, spawned or not', async (t) => {
  // Which is the opposite of `occupied`, and measured: with the player at the
  // north end of Route 30, the ball at (8,35) and both fruit trees had no live
  // struct at all. Reading the structs here would have made Take see only what
  // you were already standing next to.
  const cm = mapWith({
    mapBlocks: ROUTE_30,
    objects: [
      { sprite: 1, x: 8, y: 15 },
      { sprite: 84, x: 12, y: 39, type: 1 },   // (8,35), far away, no struct
    ],
    spawned: [],
  });
  t.eq(cm.takeables(), [{ x: 8, y: 35, what: 'ball' }], 'still offered');
  t.eq([...cm.occupied()], [], 'and still not in anybody\u2019s way');
});

test("an item ball is found by the game's own type byte, not only its sprite",
     async (t) => {
  // The better test where a cartridge has one -- this is the byte the engine
  // branches on when you press A -- and the reason it is worth having as well
  // as the sprite table is a hack that draws its balls with a sprite nobody
  // has measured. The type only knows about balls, so a fruit tree is still
  // found by its sprite alone.
  const cm = mapWith({ objects: [
    { sprite: 1, x: 8, y: 15 },
    { sprite: 200, x: 6, y: 13, type: 1 },   // a sprite the profile never named
  ] });
  t.eq(cm.takeables(), [{ x: 2, y: 9, what: 'ball' }], 'the type is enough');
});

// --- who wants a battle ------------------------------------------------------

test('a trainer is a live struct whose placement says trainer', async (t) => {
  // Measured on Route 30, whose objects are one of each kind: the item ball
  // reads 1, the three trainers read 2, and the fruit trees, the townsfolk and
  // the two Rattata read 0.
  const cm = mapWith({
    mapBlocks: ROUTE_30,
    objects: [
      { sprite: 1, x: 8, y: 15 },
      { sprite: 39, x: 9, y: 27, type: 2 },    // a trainer at (5,23)
      { sprite: 76, x: 9, y: 28 },             // a Rattata at (5,24)
      { sprite: 84, x: 12, y: 39, type: 1 },   // a ball at (8,35)
    ],
    spawned: [
      { placed: 1, sprite: 39, x: 9, y: 27 },
      { placed: 2, sprite: 76, x: 9, y: 28 },
    ],
  });
  t.eq(cm.trainers(), [{ x: 5, y: 23, sprite: 39 }], 'the one that is both');
});

test('a trainer the map placed but has not spawned is not offered', async (t) => {
  // The reason this returns nothing rather than falling back the way `occupied`
  // does: measured on a new save, Route 30 places three trainers and has
  // spawned none of them -- one hidden by its flag and two too far north to be
  // loaded. A fallback here would offer three walks to nobody.
  const cm = mapWith({
    mapBlocks: ROUTE_30,
    objects: [
      { sprite: 1, x: 8, y: 15 },
      { sprite: 39, x: 9, y: 27, type: 2 },
    ],
    spawned: [],
  });
  t.eq(cm.trainers(), [], 'nobody to fight');
});

test('a cartridge whose profile names no object types offers no trainers',
     async (t) => {
  // The generic profile's position, and the same rule the takeable sprites
  // follow: a type byte is layout, and a cartridge nobody has measured gets
  // silence rather than a guess that walks the pilot up to a shopkeeper.
  const cm = mapWith({
    mapBlocks: ROUTE_30,
    engine: { takeable: [] },
    objects: [{ sprite: 1, x: 8, y: 15 }, { sprite: 39, x: 9, y: 27, type: 2 }],
    spawned: [{ placed: 1, sprite: 39, x: 9, y: 27 }],
  });
  t.eq(cm.trainers(), [], 'nothing is offered');
  t.eq([...cm.occupied()], ['5,23'], 'but they are still somebody to walk around');
});

test('a takeable off the map is dropped, the same as anyone else', async (t) => {
  const cm = mapWith({ mapBlocks: [2, 2], objects: [   // 4x4 tiles
    { sprite: 1, x: 8, y: 15 },
    { sprite: 84, x: 5, y: 5 },     // (1,1): inside
    { sprite: 84, x: 40, y: 6 },    // (36,2): far off the right
    { sprite: 93, x: 1, y: 6 },     // (-3,2): before the left edge
  ] });
  t.eq(cm.takeables(), [{ x: 1, y: 1, what: 'ball' }], 'only the one on the map');
});

test('a cartridge whose profile names no takeable sprites has none', async (t) => {
  // The generic profile's position, and it has to be silence rather than a
  // guess: a sprite id is exactly the kind of thing a hack moves, and a wrong
  // one would send the pilot to press A at a person.
  const sym = symbols();
  const cm = new CollisionMap(sym, { romByte: () => 0 }, { takeable: [] });
  cm.use(worldRam(sym, { objects: [{ sprite: 1, x: 8, y: 15 }, { sprite: 84, x: 6, y: 13 }] }));
  t.eq(cm.takeables(), [], 'nothing is offered');
});
