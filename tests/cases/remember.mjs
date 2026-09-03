// What survives a reload, and what must not.
//
// The storage call itself is three lines and a try; everything that can go
// wrong is in deciding whether a remembered value is still usable. A record
// written by an older build, or edited by hand, reaches this code as data --
// and a bad value here is not a wrong preference, it is `SPEEDS[9]` coming
// back undefined and the idle loop stepping the emulator undefined frames.
import { test } from '../harness.mjs';
import { readOpts, sanitise, writeOpts } from '../../app/remember.js';

const LIMITS = { speeds: 5, grinds: ['+2', '+5', '10', '20'] };

/** A localStorage that is only a Map, and one that refuses like a private window. */
function fakeStore(seed = null) {
  const held = new Map();
  if (seed !== null) held.set('crystal-pilot-opts', seed);
  return {
    held,
    getItem: (k) => (held.has(k) ? held.get(k) : null),
    setItem: (k, v) => held.set(k, v),
  };
}

function refusingStore(which) {
  const s = fakeStore();
  const boom = () => { throw new Error('private window'); };
  if (which === 'read' || which === 'both') s.getItem = boom;
  if (which === 'write' || which === 'both') s.setItem = boom;
  return s;
}

test('nothing usable comes out of nothing, or out of junk', async (t) => {
  for (const raw of [null, undefined, 'v70', 42, [], true]) {
    const got = sanitise(raw, LIMITS);
    t.eq([got.speed, got.grind, got.hunt], [null, null, null],
         `${JSON.stringify(raw) ?? 'undefined'} yields no options`);
  }
});

test('a speed index this build cannot use is dropped, not clamped', async (t) => {
  // The record may have been written when there were more steps. Clamping it
  // to the last one would silently start the emulator at max.
  t.eq(sanitise({ speed: 9 }, LIMITS).speed, null, 'nine steps ago');
  t.eq(sanitise({ speed: -1 }, LIMITS).speed, null, 'negative');
  t.eq(sanitise({ speed: 1.5 }, LIMITS).speed, null, 'not a whole step');
  t.eq(sanitise({ speed: '2' }, LIMITS).speed, null, 'a string, not an index');
  t.eq(sanitise({ speed: 0 }, LIMITS).speed, 0, 'zero is a real step');
  t.eq(sanitise({ speed: 4 }, LIMITS).speed, 4, 'the last step is usable');
});

test('a grind preset the markup no longer offers is dropped', async (t) => {
  // There is no nearest neighbour to fall back on: +5 and Lv20 are different
  // intentions, not different amounts of the same one.
  t.eq(sanitise({ grind: '+5' }, LIMITS).grind, '+5', 'a preset that exists');
  t.eq(sanitise({ grind: '+3' }, LIMITS).grind, null, 'one that does not');
  t.eq(sanitise({ grind: 12 }, LIMITS).grind, null, 'a resolved level, not a preset');
});

test('a hunted species survives as a name, and absurdity does not', async (t) => {
  t.eq(sanitise({ hunt: 'SENTRET' }, LIMITS).hunt, 'SENTRET', 'a species name');
  t.eq(sanitise({ hunt: '' }, LIMITS).hunt, null, 'an empty name');
  t.eq(sanitise({ hunt: 'X'.repeat(400) }, LIMITS).hunt, null, 'a name no game has');
  t.eq(sanitise({ hunt: { name: 'SENTRET' } }, LIMITS).hunt, null, 'an object');
});

test('one choice does not forget the others', async (t) => {
  const st = fakeStore();
  writeOpts({ speed: 3 }, st);
  writeOpts({ hunt: 'HOOTHOOT' }, st);
  writeOpts({ grind: '10' }, st);
  const got = readOpts(LIMITS, st);
  t.eq([got.speed, got.grind, got.hunt], [3, '10', 'HOOTHOOT'],
       'three separate writes, all three remembered');
});

test('a field written by a build that no longer exists is dropped on the next write', async (t) => {
  const st = fakeStore(JSON.stringify({ speed: 2, stepper: 7 }));
  writeOpts({ hunt: 'RATTATA' }, st);
  const stored = JSON.parse(st.getItem('crystal-pilot-opts'));
  t.eq(Object.keys(stored).sort(), ['hunt', 'speed'], 'stepper is gone, speed stays');
});

test('passing null forgets that one', async (t) => {
  const st = fakeStore();
  writeOpts({ hunt: 'SENTRET', speed: 1 }, st);
  writeOpts({ hunt: null }, st);
  const got = readOpts(LIMITS, st);
  t.eq([got.speed, got.hunt], [1, null], 'the hunt is forgotten, the speed is not');
});

test('storage that throws is the same as storage with nothing in it', async (t) => {
  // A private window does not return null, it raises -- and an app that lets
  // that out dies before it has drawn anything.
  const got = readOpts(LIMITS, refusingStore('read'));
  t.eq([got.speed, got.grind, got.hunt], [null, null, null], 'reading throws');
  writeOpts({ speed: 2 }, refusingStore('write'));
  writeOpts({ speed: 2 }, refusingStore('both'));
  t.true(true, 'writing throws, and nothing comes out of here');
});

test('a record that is not JSON is replaced rather than believed', async (t) => {
  const st = fakeStore('{ speed: 3, this is not json');
  const got = readOpts(LIMITS, st);
  t.eq(got.speed, null, 'unparseable means nothing remembered');
  writeOpts({ speed: 2 }, st);
  t.eq(readOpts(LIMITS, st).speed, 2, 'and the next choice overwrites it');
});
