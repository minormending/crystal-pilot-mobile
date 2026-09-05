// The tiles someone is standing on.
//
// collision.js had no tests, because the harness could not describe a map.
// This is the half that can be tested without a cartridge: which map objects
// become tiles to route around, and which are thrown away.
import { symbols, test, worldRam } from '../harness.mjs';
import { CollisionMap } from '../../gen2/collision.js';

/** A CollisionMap over one snapshot. Nothing here reaches the ROM. */
function mapWith({ mapBlocks = [5, 6], objects = [], pos = [7, 4] } = {}) {
  const sym = symbols();
  const cm = new CollisionMap(sym, { romByte: () => 0 });
  return cm.use(worldRam(sym, { mapBlocks, objects, pos }));
}

test('map objects become tiles, four lower than the cartridge stores them', async (t) => {
  // Measured in Elm's lab: a 5x6-block map, so 10x12 tiles, with objects the
  // ROM records at (7,8), (6,13) and (10,7).
  const cm = mapWith({ objects: [
    { sprite: 1, x: 8, y: 15 },     // index 0 is the player, and is skipped
    { sprite: 16, x: 7, y: 8 },
    { sprite: 60, x: 6, y: 13 },
    { sprite: 84, x: 10, y: 7 },
  ] });
  const taken = cm.occupied();
  t.eq([...taken].sort(), ['2,9', '3,4', '6,3'], 'three objects, minus the origin');
  t.false(taken.has('4,11'), 'and not the player, whose entry is index zero');
});

test('an object outside the map is dropped rather than kept as a key', async (t) => {
  // Index 0 aside, this is the only check available: the entry at index 0 holds
  // where the map *placed* the player, not where the player is -- (8,15) while
  // standing at (7,4) -- so it cannot confirm the origin. Bounds can.
  const cm = mapWith({ mapBlocks: [2, 2], objects: [   // 4x4 tiles
    { sprite: 1, x: 8, y: 15 },
    { sprite: 16, x: 5, y: 5 },     // (1,1): inside
    { sprite: 16, x: 40, y: 6 },    // (36,2): far off the right
    { sprite: 16, x: 1, y: 6 },     // (-3,2): before the left edge
  ] });
  t.eq([...cm.occupied()], ['1,1'], 'only the one that is on the map');
});

test('a sprite of zero is an empty slot, not an object at the origin', async (t) => {
  const cm = mapWith({ objects: [
    { sprite: 1, x: 8, y: 15 },
    { sprite: 0, x: 4, y: 4 },      // would be (0,0) if it counted
    { sprite: 7, x: 9, y: 9 },
  ] });
  t.eq([...cm.occupied()], ['5,5'], 'the empty slot is skipped');
});
