// The tiles someone is standing on.
//
// collision.js had no tests, because the harness could not describe a map.
// This is the half that can be tested without a cartridge: which map objects
// become tiles to route around, and which are thrown away.
//
// And then a second half nobody had noticed was missing. Every test below used
// to hand the decode `{ romByte: () => 0 }`, so `permission()` answered LAND for
// every byte on every map -- which made `isWall`, `isWater` and everything
// built on them run on each of these tests and be checked by none.
// `tools/mutate` put the number on it: **eighteen per cent** of this module's
// mutations caught, in the file that decides where the pilot may walk. Line
// coverage had said fifty-one, which sounds like a gap and reads as a plateau;
// what it was measuring is that the lines *ran*.
import { blindTo, collisionRom, symbols, test, withSymbol,
         worldRam } from '../harness.mjs';
import { CollisionMap } from '../../gen2/collision.js';
import { gen2 } from '../../gen2/engine.js';
import { readFileSync } from 'node:fs';

// Route 30 in blocks, because the tiles below are its real ones and the default
// map here is a room. Ten by twenty-seven blocks is twenty by fifty-four tiles,
// which is the map the trainers and the ball were measured on.
const ROUTE_30 = [10, 27];

/** A CollisionMap over one snapshot. Nothing here reaches the ROM. */
function mapWith({ mapBlocks = [5, 6], objects = [], spawned = null,
                   pos = [7, 4], engine = undefined } = {}) {
  const sym = symbols();
  // Merged onto the stock profile, not substituted for it: a test that
  // says `{ takeable: [] }` means "Crystal, but with no takeables", and a
  // bare object would leave every other field -- the object strides among
  // them -- undefined.
  const cm = new CollisionMap(sym, { romByte: () => 0 },
                              engine ? { ...gen2, ...engine } : undefined);
  return cm.use(worldRam(sym, { mapBlocks, objects, spawned, pos }));
}

/** The same map with no object structs in its symbol file at all. */
function noStructs({ objects = [], mapBlocks = [5, 6] } = {}) {
  const sym = symbols();
  const bare = blindTo(sym, 'wObjectStructs');
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

test('a cartridge with two kinds of trainer is offered both', async (t) => {
  // **Polished Crystal has `OBJECTTYPE_TRAINER` and
  // `OBJECTTYPE_GENERICTRAINER`, and 461 of its 525 fightable objects are
  // the second one.** Held to a single number this saw an eighth of the
  // trainers in the game, and every trainer in every Gym but the leader is
  // generic -- so a "cleared" Gym would have been a Gym nobody fought.
  //
  // A kind is a number or a list of them, the same bargain
  // `encounter.blockOf` makes.
  const two = { ...gen2,
                objectTypes: { ...gen2.objectTypes, trainer: [2, 3] } };
  const objects = [
    { sprite: 1, x: 8, y: 15 },              // index 0 is the player
    { sprite: 39, x: 9, y: 27, type: 2 },    // at (5,23)
    { sprite: 89, x: 9, y: 28, type: 3 },    // at (5,24)
    { sprite: 76, x: 9, y: 29, type: 0 },    // a Rattata at (5,25)
  ];
  const spawned = [
    { placed: 1, sprite: 39, x: 9, y: 27 },
    { placed: 2, sprite: 89, x: 9, y: 28 },
    { placed: 3, sprite: 76, x: 9, y: 29 },
  ];
  t.eq(mapWith({ mapBlocks: ROUTE_30, objects, spawned }).trainers(),
       [{ x: 5, y: 23, sprite: 39 }],
       'one kind declared, one trainer seen');
  t.eq(mapWith({ mapBlocks: ROUTE_30, engine: two, objects, spawned })
         .trainers(),
       [{ x: 5, y: 23, sprite: 39 }, { x: 5, y: 24, sprite: 89 }],
       'two kinds declared, both — and still not the Rattata');
});

test('a cartridge whose profile names no object types offers no trainers',
     async (t) => {
  // The generic profile's position, and the same rule the takeable sprites
  // follow: a type byte is layout, and a cartridge nobody has measured gets
  // silence rather than a guess that walks the pilot up to a shopkeeper.
  const cm = mapWith({
    mapBlocks: ROUTE_30,
    // The field this is about, emptied on purpose. It used to be the whole
    // profile -- `{ takeable: [] }` substituted for gen2 -- which left
    // `objectTypes` undefined by accident rather than by saying so, and
    // every other number in the profile with it.
    engine: { takeable: [], objectTypes: {} },
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


// --- what a collision byte means --------------------------------------------
//
// The permission table is the cartridge's own, so these are the ROM's rules
// rather than this file's. Painted through `collisionRom`, which is the harness
// answering `romByte` out of a real table instead of returning zero.

const FLOOR = 0x00, WATER_TILE = 0x14, WALL_TILE = 0x3d;
const PERMS = { [WATER_TILE]: 0x01, [WALL_TILE]: 0x0f };

/** A CollisionMap whose ROM has a permission table in it. */
function decoding(perms = PERMS) {
  const sym = symbols();
  return new CollisionMap(sym, collisionRom(perms))
    .use(worldRam(sym, { mapBlocks: [5, 6] }));
}

test('a wall is a wall and water is water, out of the ROM\'s own table',
     async (t) => {
  // LAND $00, WATER $01, WALL $0f, out of collision_permissions.asm and read
  // through `CollisionPermissionTable`. The low nybble only: the high one holds
  // things this app does not use, and masking it off is the sort of detail that
  // reads as obviously right and has never been checked.
  const cm = decoding();
  t.true(cm.isWall(WALL_TILE), 'a wall');
  t.false(cm.isWall(FLOOR), 'and a floor is not one');
  t.true(cm.isWater(WATER_TILE), 'water');
  t.false(cm.isWater(FLOOR), 'and a floor is not that either');
  t.false(cm.isWall(WATER_TILE), 'water is not a wall');
  t.false(cm.isWater(WALL_TILE), 'nor a wall water');
});

test('only the low nybble of a permission is read', async (t) => {
  // A table entry with anything in its high nybble still means what its low
  // one says. Worth pinning because dropping the mask would make every
  // permission wrong on a hack whose table used the upper bits.
  const cm = decoding({ 0x50: 0xaf, 0x51: 0xa0 });
  t.true(cm.isWall(0x50), '0xaf is a wall');
  t.false(cm.isWall(0x51), 'and 0xa0 is not');
});

test('a ledge is the range the engine says, and no wider', async (t) => {
  // $a0-$bf, from constants/collision_constants.asm. Both ends, because a
  // range is two decisions and an off-by-one at either would make a ledge
  // ordinary ground or ordinary ground a ledge -- and the search treats the
  // two completely differently.
  t.true(CollisionMap.isLedge(0xa0), 'the first');
  t.true(CollisionMap.isLedge(0xbf), 'the last');
  t.false(CollisionMap.isLedge(0x9f), 'one below is not');
  t.false(CollisionMap.isLedge(0xc0), 'nor one above');
  t.false(CollisionMap.isLedge(0x00), 'and a floor certainly is not');
});

test('a warp is its own range, which does not overlap the ledges', async (t) => {
  t.true(CollisionMap.isWarp(0x70), 'the first');
  t.true(CollisionMap.isWarp(0x7f), 'the last');
  t.false(CollisionMap.isWarp(0x6f), 'one below is not');
  t.false(CollisionMap.isWarp(0x80), 'nor one above');
  t.false(CollisionMap.isWarp(0xa0), 'and a ledge is not a warp');
  t.false(CollisionMap.isLedge(0x70), 'nor a warp a ledge');
});

test('a warp carpet wants the direction it points, and the rest just fire',
     async (t) => {
  // The four in `CheckDirectionalWarp`. Standing on a carpet and pressing
  // anything else walks you off it, which is what made the front door of the
  // player's house look like a wall that could be reached but never opened.
  t.eq(CollisionMap.pushFor(0x70), 'DOWN', 'the down carpet');
  t.eq(CollisionMap.pushFor(0x76), 'LEFT', 'left');
  t.eq(CollisionMap.pushFor(0x78), 'UP', 'up');
  t.eq(CollisionMap.pushFor(0x7e), 'RIGHT', 'right');
  t.eq(CollisionMap.pushFor(0x71), null, 'an ordinary warp needs no direction');
  t.eq(CollisionMap.pushFor(0x00), null, 'and a floor is not a warp at all');
});

test('the direction that hops a ledge comes from its low three bits',
     async (t) => {
  // `.ledge_table` in engine/overworld/player_movement.asm, indexed by
  // `collision & 7`. So $a4 and $ac are the same ledge, which is the point of
  // the mask -- and dropping it would make four of the eight kinds unreadable.
  const cm = decoding({});
  t.eq(cm.hopDirs(0, 0), [], 'a floor hops nowhere');
  const sym = symbols();
  const on = (coll) => {
    const map = new CollisionMap(sym, collisionRom({}));
    map.use(worldRam(sym, { mapBlocks: [5, 6] }));
    map.collisionAt = () => coll;
    return map.hopDirs(0, 0);
  };
  t.eq(on(0xa0), ['RIGHT'], 'the low bits pick the direction');
  t.eq(on(0xa3), ['DOWN'], 'and again');
  t.eq(on(0xa4), ['DOWN', 'RIGHT'], 'two of them for a corner');
  t.eq(on(0xac), ['DOWN', 'RIGHT'], 'and $ac is the same ledge as $a4');
  t.eq(on(0x00), [], 'while something that is not a ledge hops nowhere');
});

test('what can be stood on: not a wall, not water, and warps only when asked',
     async (t) => {
  // A ledge *is* standable -- what is one-way is hopping off one, which the
  // search refuses as a move rather than refusing the tile. Excluding them
  // outright made whole sections of routes look unreachable.
  const sym = symbols();
  const cm = new CollisionMap(sym, collisionRom(PERMS));
  cm.use(worldRam(sym, { mapBlocks: [5, 6] }));
  const at = {};
  cm.collisionAt = (x, y) => at[`${x},${y}`] ?? FLOOR;
  at['1,1'] = WALL_TILE;
  at['2,1'] = WATER_TILE;
  at['3,1'] = 0xa0;          // a ledge
  at['4,1'] = 0x71;          // a warp

  t.true(cm.walkable(0, 1), 'a floor');
  t.false(cm.walkable(1, 1), 'not a wall');
  t.false(cm.walkable(2, 1), 'not water');
  t.true(cm.walkable(3, 1), 'a ledge can be stood on');
  t.false(cm.walkable(3, 1, { allowLedge: false }), 'unless the caller says not');
  t.false(cm.walkable(4, 1), 'a warp is not walked onto by accident');
  t.true(cm.walkable(4, 1, { allowWarp: true }), 'only when it is the goal');
});

test('nothing outside the map can be stood on', async (t) => {
  // Ten by twelve tiles, so 0..9 and 0..11. The bounds are the only check
  // available -- there is no sentinel in the block data -- and getting them
  // wrong reads a stride into the next row of blocks.
  const cm = decoding();
  t.true(cm.walkable(0, 0), 'the origin is inside');
  t.true(cm.walkable(9, 11), 'and so is the far corner');
  t.false(cm.walkable(-1, 0), 'left of the map is not');
  t.false(cm.walkable(0, -1), 'nor above it');
  t.false(cm.walkable(10, 0), 'nor right of it');
  t.false(cm.walkable(0, 12), 'nor below it');
});


// --- planning a walk over a painted map -------------------------------------
//
// `pathTo` and `furthestToward` decide every walk this app makes, and neither
// had a test. `tools/mutate` found them by surviving: the four direction
// comparators in `furthestToward` could all be inverted and the suite passed.
//
// Painted rather than built out of block data, because what is under test is
// the search and not the decode -- and the decode has its own tests above.
//
//     .  floor      #  wall      ~  water      W  warp
//     v ^ < >       a ledge that hops that way

const PAINT = { '.': FLOOR, '#': WALL_TILE, '~': WATER_TILE, W: 0x71,
                '>': 0xa0, '<': 0xa1, '^': 0xa2, v: 0xa3 };

/**
 * A CollisionMap over a picture. Rows are equal-length strings.
 *
 * A block is two tiles each way, so the picture is padded up to an even size
 * with wall -- and it has to be, because `mapSize` multiplies the byte it reads
 * by two. Handing it three rows meant a block count of 1.5, which is written as
 * 1 and read back as a two-tile map: half the picture outside the bounds, and
 * four of these tests failing in a way that read as the pathfinder being wrong.
 */
function painted(rows) {
  const sym = symbols();
  const wide = Math.ceil(rows[0].length / 2) * 2;
  const tall = Math.ceil(rows.length / 2) * 2;
  const cm = new CollisionMap(sym, collisionRom(PERMS));
  cm.use(worldRam(sym, { mapBlocks: [wide / 2, tall / 2] }));
  cm.collisionAt = (x, y) => {
    if (y < 0 || y >= rows.length || x < 0 || x >= rows[y].length) return WALL_TILE;
    return PAINT[rows[y][x]] ?? FLOOR;
  };
  return cm;
}

test('a plan goes straight at the goal when it can', async (t) => {
  const cm = painted(['......', '......', '......', '......']);
  t.eq(cm.pathTo([0, 0], [3, 0]), ['RIGHT', 'RIGHT', 'RIGHT'], 'three east');
  t.eq(cm.pathTo([0, 0], [0, 0]), [], 'and standing on it is no walk at all');
});

test('a plan goes round a wall, and reports the shortest way round',
     async (t) => {
  //   0123
  // 0 .#..
  // 1 .#..
  // 2 ....
  const cm = painted(['.#..', '.#..', '....', '....']);
  const path = cm.pathTo([0, 0], [2, 0]);
  t.eq(path.length, 6, `six steps round the fence, not ${path && path.length}`);
  t.true(path.includes('DOWN') && path.includes('UP'), 'down, along, and back up');
});

test('a tile nothing can reach has no plan, which is not an empty one',
     async (t) => {
  // The distinction every caller leans on: `[]` means you are already there
  // and `null` means there is no way, and treating the second as the first
  // makes a walk report success without moving.
  const cm = painted(['..#..', '..#..', '..#..']);
  t.eq(cm.pathTo([0, 0], [4, 0]), null, 'walled off');
  t.eq(cm.pathTo([0, 0], [0, 0]), [], 'and here is not walled off');
});

test('water is not a way through', async (t) => {
  const cm = painted(['..~..', '..~..', '..~..']);
  t.eq(cm.pathTo([0, 1], [4, 1]), null, 'no surfing in this app');
});

test('a tile in the avoid set is planned around', async (t) => {
  // What a refused step becomes: the collision map knows the terrain and not
  // that somebody is standing on it.
  const cm = painted(['...', '...', '...']);
  t.eq(cm.pathTo([0, 0], [2, 0]), ['RIGHT', 'RIGHT'], 'straight, normally');
  const round = cm.pathTo([0, 0], [2, 0], { avoid: new Set(['1,0']) });
  t.eq(round.length, 4, 'four steps when the middle is occupied');
});

test('the goal itself is walked to even when it is in the avoid set',
     async (t) => {
  // Otherwise a trainer who refused once could never be approached again --
  // and the tile they are standing on is exactly where the walk has to end.
  const cm = painted(['...', '...']);
  t.eq(cm.pathTo([0, 0], [2, 0], { avoid: new Set(['2,0']) }),
       ['RIGHT', 'RIGHT'], 'the goal is the exception');
});

test('a warp is stepped onto only when it is the goal', async (t) => {
  // Otherwise a plan across a room walks through the door and out of the map,
  // which ends the walk somewhere nobody asked for.
  const cm = painted(['.W.', '...']);
  t.eq(cm.pathTo([0, 0], [2, 0]).length, 4,
       'round the doorway when it is merely in the way');
  t.eq(cm.pathTo([0, 0], [1, 0]), ['RIGHT'], 'onto it when it is the errand');
  t.eq(cm.pathTo([0, 0], [1, 0], { allowWarpGoal: false }), null,
       'and a caller that refuses even that has nowhere to go, not a way round');
});

test('a ledge is stood on but never hopped off', async (t) => {
  // The one-way rule, and the reason it is a *move* that is refused rather
  // than a tile. Hopping jumps two tiles and cannot be undone, so the search
  // never plans one -- it would be modelling an outcome it gets wrong.
  //
  //   012
  // 0 ...
  // 1 .v.     a ledge that hops downward
  // 2 ...
  const cm = painted(['...', '.v.', '...']);
  t.eq(cm.pathTo([1, 0], [1, 1]), ['DOWN'], 'stepping onto it is fine');
  const off = cm.pathTo([1, 1], [1, 2]);
  t.true(off === null || !off.length || off[0] !== 'DOWN',
         `it is not hopped off downward, got ${JSON.stringify(off)}`);
  t.eq(off.length, 3, 'so the way down is round the side: left, down, right');
});

test('the furthest reachable tile in a direction, not the furthest tile',
     async (t) => {
  // Why this exists: Route 30 is fifty-four tiles top to bottom and fenced, so
  // the opening at the far end is not reachable in one plan from the near end.
  // The crossing walks to the best tile it *can* reach and asks again.
  //
  //   0123
  // 0 ....
  // 1 ####     a fence with no gap
  // 2 ....
  const cm = painted(['....', '####', '....']);
  t.eq(cm.furthestToward([0, 0], 'DOWN'), [0, 0],
       'nothing further down is reachable, so it stays put');
  t.eq(cm.furthestToward([0, 0], 'RIGHT'), [3, 0], 'the far end of its own row');

  const gap = painted(['....', '##.#', '....']);
  t.eq(gap.furthestToward([0, 0], 'DOWN')[1], 2,
       'and with a gap it gets to the bottom row');
});

test('each direction is measured on its own axis, and the right way along it',
     async (t) => {
  // Four comparators, and `tools/mutate` could invert every one of them
  // without the suite noticing. An inverted one walks the pilot away from the
  // edge it is trying to leave by.
  const cm = painted(['.....', '.....', '.....', '.....', '.....']);
  t.eq(cm.furthestToward([2, 2], 'UP'), [2, 0], 'up is the smallest y');
  t.eq(cm.furthestToward([2, 2], 'DOWN'), [2, 4], 'down is the largest');
  t.eq(cm.furthestToward([2, 2], 'LEFT'), [0, 2], 'left is the smallest x');
  t.eq(cm.furthestToward([2, 2], 'RIGHT'), [4, 2], 'right is the largest');
});

test('a search that runs out of room gives up rather than running for ever',
     async (t) => {
  // The bound is what makes this safe to call on a map nobody has seen. A
  // plan that needs more nodes than it is given is no plan, not a wrong one.
  const cm = painted(['.....', '.....', '.....', '.....', '.....']);
  t.eq(cm.pathTo([0, 0], [4, 4], { maxNodes: 2 }), null, 'no plan on two nodes');
  t.true((cm.pathTo([0, 0], [4, 4]) || []).length === 8, 'and eight with room');
});


// --- a cartridge that unpacks its collision table into work RAM -----------

test('a wall is whatever number this cartridge calls a wall', async (t) => {
  // `WALL_TILE` is $0f on Crystal and %10 -- two -- on Polished Crystal, so
  // the permission table was read perfectly and compared against the wrong
  // constant. Every wall in the game came back walkable, and a lab full of
  // bookshelves read as open floor.
  const perms = { 0x07: 0x02, 0x00: 0x00 };
  const sym = symbols();
  const two = new CollisionMap(sym, collisionRom(perms),
                               { ...gen2, permissions: { land: 0, water: 1, wall: 0x02 } });
  const fifteen = new CollisionMap(sym, collisionRom(perms), gen2);
  t.true(two.isWall(0x07), 'two is this cartridge\'s wall');
  t.false(fifteen.isWall(0x07), 'and $0f is not, on the same bytes');
  t.false(two.isWall(0x00), 'floor is still floor');
});

test('the collision table is read from work RAM where a cartridge unpacks it',
     async (t) => {
  // Polished Crystal LZ-compresses its tileset collision -- 79 bytes for 248
  // -- and unpacks it at map load into `wDecompressedCollisions`, a work-RAM
  // bank it does not keep mapped. Following the ROM pointer reads the
  // *compressed* bytes, and the walkable grid came out an alternating
  // checkerboard.
  //
  // Derived rather than declared: a cartridge that names the buffer has one.
  // Crystal's table has no such name, so the test cartridge is given one --
  // at the bank and address the real one uses.
  const sym = withSymbol(symbols(), 'wDecompressedCollisions', 5, 0xd000);
  // Four collision values per block, and block 1's second quadrant is a wall.
  const unpacked = new Uint8Array(64);
  unpacked[1 * 4 + 1] = 0x07;
  const gb = {
    romByte: () => 0xff,                 // the ROM would answer nonsense
    async readWramBank() { return unpacked; },
  };
  const cm = new CollisionMap(sym, gb, gen2);
  t.ne(cm.unpacked, null, 'the symbol file says there is one');
  t.eq(cm.unpacked.bank, sym.bank('wDecompressedCollisions'),
       'in the bank the symbol file gives it');
  const wram = worldRam(sym, { mapBlocks: [5, 6], pos: [0, 0] });
  await cm.calibrate(wram);
  t.eq(cm.unpackedBytes, unpacked, 'and the table came from work RAM');
});

test('a cartridge that does not unpack one still reads the ROM', async (t) => {
  // The other half: Crystal keeps its table in the ROM and names no buffer,
  // so nothing changes for it.
  const cm = new CollisionMap(symbols(), collisionRom({}), gen2);
  t.eq(cm.unpacked, null, 'no buffer named, so none looked for');
});

test('the object strides are the cartridge\'s own', async (t) => {
  // Polished Crystal writes 21 map objects of 14 bytes and a spawned struct
  // of 34, where Crystal writes 16 of 16 and 40. At Crystal's stride nothing
  // read at all, so the walker could not see a person to walk around.
  const narrow = { ...gen2,
    mapObjects: { ...gen2.mapObjects, count: 21, bytes: 0x0e },
    objectStructs: { ...gen2.objectStructs, bytes: 0x22 } };
  t.eq(narrow.mapObjects.bytes, 0x0e, 'fourteen bytes a map object');
  t.eq(narrow.objectStructs.bytes, 0x22, 'thirty-four a spawned one');
  // And the reader takes them from the profile rather than a constant.
  const src = readFileSync(new URL('../../gen2/collision.js', import.meta.url), 'utf8');
  t.false(src.includes('MAP_OBJECT_BYTES ='), 'no module constant left behind');
  t.false(src.includes('STRUCT_BYTES ='), 'nor for the spawned structs');
});
