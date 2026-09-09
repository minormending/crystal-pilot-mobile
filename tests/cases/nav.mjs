// The walk loop: what it decides between two steps.
//
// **`gen2/nav.js` had no tests at all** -- 130 lines of code, nought per cent
// run, discovered when `tools/coverage` was made to count the files the suite
// never imports rather than leave them out of its own denominator. Every test
// in the repository fakes `nav`, so the module that actually walks the player
// had never been exercised.
//
// It is the right shape to test, too: a loop of decisions over answers from a
// collision map and a Game Boy, both of which a fake can give. `step` is
// stubbed here -- pressing buttons and watching for movement is the half that
// needs an emulator -- so what is under test is the *deciding*, which is where
// every one of the reasons written into that file lives.
import { symbols, test } from '../harness.mjs';
import { Nav } from '../../gen2/nav.js';
import { CollisionMap } from '../../gen2/collision.js';

const sym = symbols();
// The lowest collision byte the real decode calls a warp. Searched for rather
// than copied, so this fake cannot drift from the predicate it stands in for.
const WARP = (() => {
  for (let i = 0; i < 256; i++) if (CollisionMap.isWarp(i)) return i;
  throw new Error('no collision value is a warp, which cannot be right');
})();

/**
 * A pilot walking a fake map.
 *
 * `steps` is what each successive `step` answers, which is how a refusal, a
 * battle or a plain move gets scripted. `paths` is what the collision map
 * offers for each planning attempt, so the three-tries fallback can be watched
 * from outside.
 */
function walking({ at = [1, 1], goal = [3, 1], map = 0x0301,
                   steps = [], path = ['RIGHT'], paths = null,
                   calibrate = true, warp = false, occupied = new Set(),
                   battle = false } = {}) {
  const asked = [];
  const pos = [...at];
  let mapNow = map, taken = 0, plans = 0;
  const gb = {
    async readBytes(addr, n) {
      if (addr === sym.addr('wYCoord')) return [pos[1], pos[0]];
      if (addr === sym.addr('wBattleMode')) return [battle ? 1 : 0];
      if (addr === sym.addr('wMapGroup')) return [mapNow >> 8, mapNow & 0xff];
      return new Array(n).fill(0);
    },
    async readWram() { return calibrate ? new Uint8Array(8) : null; },
    async run() {},
    press: async () => {}, hold: () => {}, release: () => {},
  };
  const collision = {
    calibrate: () => calibrate,
    playerPos: () => [...pos],
    // A real warp value rather than a guessed one: the first byte
    // `CollisionMap.isWarp` accepts, found by asking it.
    collisionAt: () => (warp ? WARP : 0),
    occupied: () => occupied,
    pathTo: (_from, _to, opts = {}) => {
      plans += 1;
      asked.push(opts.avoid ? [...opts.avoid].sort() : null);
      if (paths) return paths[plans - 1] === undefined ? null : paths[plans - 1];
      return path;
    },
  };
  const nav = new Nav(gb, sym);
  nav.step = async (dir) => {
    const outcome = steps[taken] || { moved: true };
    taken += 1;
    if (outcome.moved) { pos[0] += dir === 'RIGHT' ? 1 : 0; }
    return { ...outcome, pos: [...pos] };
  };
  nav.awaitMapChange = async () => (warp ? 0x0401 : null);
  return { nav, collision, asked, at: pos, plans: () => plans,
           // *During* the walk, which is the case under test: `startedOn` is
           // read on the way in, so a map changed beforehand is simply the map
           // the walk starts on.
           warpAfterAStep: () => { nav.step = async () => {
             mapNow = 0x0401; return { moved: true, pos: [...pos] };
           }; } };
}

test('arriving on the goal ends the walk with nothing to report', async (t) => {
  const w = walking({ at: [3, 1], goal: [3, 1] });
  const r = await w.nav.walkTo(w.collision, [3, 1]);
  t.eq(r.stopped, null, 'no reason to stop, because it is there');
});

test('a goal that is a doorway is not reached by standing on it', async (t) => {
  // **Standing on a warp is not going through it.** The transition runs for a
  // few frames after the step, so arriving on the tile and reading the
  // position names a tile on the map just left.
  const w = walking({ at: [3, 1], goal: [3, 1], warp: true });
  const r = await w.nav.walkTo(w.collision, [3, 1]);
  t.eq(r.stopped, 'warped', 'it waited for the map to change');
  t.eq(r.map, 0x0401, 'and says which map it landed on');
});

test('a walk that is asked to stop says it was asked', async (t) => {
  // Not "unreachable", which would blame the map for a decision somebody made.
  const w = walking();
  const r = await w.nav.walkTo(w.collision, [3, 1], { cancelled: () => true });
  t.eq(r.stopped, 'cancelled', 'the press is the reason');
});

test('a battle stops the walk, and is not a navigation failure', async (t) => {
  const w = walking({ battle: true });
  const r = await w.nav.walkTo(w.collision, [3, 1]);
  t.eq(r.stopped, 'battle', 'reported as what it is');
});

test('the map changing underfoot stops the walk as a warp', async (t) => {
  // A warp mid-walk changes the map *and* the tileset, so a plan made on the
  // old one would path through walls on the new.
  const w = walking();
  w.warpAfterAStep();
  const r = await w.nav.walkTo(w.collision, [3, 1]);
  t.eq(r.stopped, 'warped', 'and it does not carry on');
});

test('a decode that will not settle stops rather than pathing through walls',
     async (t) => {
  // Three attempts, because sampling while a map is still loading catches the
  // two halves disagreeing for a few frames and that fixes itself. Three
  // strikes and the decode really is wrong.
  const w = walking({ calibrate: false });
  const r = await w.nav.walkTo(w.collision, [3, 1]);
  t.eq(r.stopped, 'decode', 'it refuses to plan on a decode it cannot trust');
});

test('nowhere to walk is unreachable, and says so', async (t) => {
  const w = walking({ paths: [null, null, null] });
  const r = await w.nav.walkTo(w.collision, [9, 9]);
  t.eq(r.stopped, 'unreachable', 'no path on any of the tries');
});

test('the plan gives up one assumption at a time', async (t) => {
  // Three tries, because being too careful and being too trusting fail in
  // opposite directions: first route around refusals *and* the people the map
  // says are standing about; then drop the people, since an object hidden by
  // its event flag still has an entry and treating those as walls seals
  // corridors that are open; then drop the refusals too.
  const w = walking({ occupied: new Set(['2,1']),
                      paths: [null, null, ['RIGHT']],
                      steps: [{ blocked: true }] });
  // One refusal first, so there is something in `avoid` for the third try to
  // drop.
  await w.nav.walkTo(w.collision, [3, 1], { maxSteps: 2 });
  const withBoth = w.asked[0] || [];
  t.true(withBoth.includes('2,1'), `the first plan avoids the occupied tile: ${withBoth}`);
});

test('a refused step is walked around, not given up on', async (t) => {
  // Once or twice a refusal is somebody standing there, so the tile goes into
  // the avoid set and the route is planned around them.
  const w = walking({ steps: [{ blocked: true }, { moved: true }, { moved: true }] });
  const r = await w.nav.walkTo(w.collision, [3, 1], { maxSteps: 6 });
  t.ne(r.stopped, 'refused', `one refusal is not the end: ${r.stopped}`);
  t.true(w.asked.some((a) => a && a.includes('2,1')),
         `the refused tile went into avoid: ${JSON.stringify(w.asked)}`);
});

test('three refusals in a row is the game not taking input', async (t) => {
  // Every direction refusing means a script is running or somebody is talking.
  // Calling that "unreachable" would blame the map for something it got right.
  const w = walking({ steps: Array(5).fill({ blocked: true }) });
  const r = await w.nav.walkTo(w.collision, [3, 1], { maxSteps: 9 });
  t.eq(r.stopped, 'refused', 'said as a refusal');
});

test('refusals are consecutive, not cumulative', async (t) => {
  // **The reset after a good step is the whole difference**, and it is the same
  // shape as the bug found in the grind loop: two refusals, a step that works,
  // two more refusals is not the game refusing input. Without the reset a long
  // walk past two separate people ends in the middle.
  const w = walking({
    steps: [{ blocked: true }, { blocked: true }, { moved: true },
            { blocked: true }, { blocked: true }, { moved: true },
            { moved: true }, { moved: true }],
  });
  const r = await w.nav.walkTo(w.collision, [3, 1], { maxSteps: 9 });
  t.ne(r.stopped, 'refused', `it walked past both: ${r.stopped}`);
});

test('a walk that runs out of steps is stuck rather than unreachable',
     async (t) => {
  // A budget is not a wall. `walkTo` defaults to eighty steps, which is a plan
  // inside a room; a route is longer and its callers pass more.
  const w = walking({ goal: [99, 1], steps: Array(4).fill({ moved: true }) });
  const r = await w.nav.walkTo(w.collision, [99, 1], { maxSteps: 3 });
  t.eq(r.stopped, 'stuck', 'the budget ran out');
});

test('every step is planned again from where the player actually is',
     async (t) => {
  // A path is a plan and plans go stale: following one blindly means a single
  // missed step puts every later step in the wrong place while the walk still
  // reports success.
  const w = walking({ steps: Array(4).fill({ moved: true }) });
  await w.nav.walkTo(w.collision, [9, 1], { maxSteps: 3 });
  t.gte(w.plans(), 3, `one plan per step, got ${w.plans()}`);
});

test('it reports each step to whoever asked to be told', async (t) => {
  const seen = [];
  const w = walking({ steps: Array(3).fill({ moved: true }) });
  await w.nav.walkTo(w.collision, [9, 1],
                     { maxSteps: 3, onStep: (n, pos) => seen.push([n, pos[0]]) });
  t.eq(seen.map(([n]) => n), [1, 2, 3], 'counted from one');
  t.eq(seen.map(([, x]) => x), [2, 3, 4], 'with where it got to');
});
