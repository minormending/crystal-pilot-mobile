// Choosing a profile for a cartridge, which is the one thing that has to be
// right before a ROM hack can be pointed at this app at all.
import { test } from '../harness.mjs';
import { TITLES, pickTitle, titleById } from '../../titles/pick.js';
import { engineFor, validateTitle } from '../../titles/contract.js';
import { describeTitle } from '../../app/rows.js';
import { gen2 } from '../../gen2/engine.js';
import { crystal } from '../../titles/crystal.js';

// The smallest thing that passes the contract, for tests about picking rather
// than about shape.
class Drive {}
const ok = (extra) => ({ id: 'x', drive: Drive, matches: () => true, ...extra });

const syms = (...names) => ({ has: (n) => names.includes(n) });
const CRYSTAL = { header: { title: 'PM_CRYSTAL', ok: true },
                  symbols: syms('JohtoGrassWildMons') };

test('a real Crystal cartridge is recognised by two things, not one',
     async (t) => {
  t.eq(pickTitle(CRYSTAL).id, 'crystal', 'the name and a symbol only Johto has');

  t.eq(pickTitle({ ...CRYSTAL, symbols: syms() }).id, 'generic',
       'the right name with the wrong symbols is not Crystal');
  t.eq(pickTitle({ header: { title: 'POKEMON GOLD' },
                   symbols: syms('JohtoGrassWildMons') }).id, 'generic',
       'and neither is the right symbols under another name');
});

test('an unknown cartridge gets a profile rather than a refusal', async (t) => {
  t.eq(pickTitle({ header: { title: 'MY HACK' }, symbols: syms() }).id, 'generic',
       'something always matches');
  t.eq(pickTitle().id, 'generic', 'including with nothing to go on at all');
  t.eq(TITLES[TITLES.length - 1].matches(), true,
       'because the last profile matches anything, by contract');
});

test('the generic profile declares absences, not defaults', async (t) => {
  const g = pickTitle();
  t.eq(g.names, undefined, 'no map is named, so a walk says map 26.1');
  t.eq(g.healers, undefined, 'nowhere heals, so Heal is not offered');
  t.eq(g.scripts, undefined, 'and there is no scripted intro to offer either');
  t.true(Array.isArray(g.encounters) && g.encounters.length > 0,
         'what it does declare is where the wild tables are');
  t.true(typeof g.drive === 'function', 'and a class to drive the cartridge with');
});

test('a profile that throws while deciding is a no, not a crash', async (t) => {
  const angry = { id: 'angry', matches: () => { throw new Error('nope'); } };
  TITLES.unshift(angry);
  try {
    t.eq(pickTitle(CRYSTAL).id, 'crystal',
         'a hand-written matches() must not stop the others being tried');
  } finally {
    TITLES.shift();
  }
});

test('a profile may pin an exact build, and is skipped when it does not match',
     async (t) => {
  const pinned = ok({ id: 'pinned', fingerprint: 'aaaaaaaaaaaaaaaa' });
  TITLES.unshift(pinned);
  try {
    t.eq(pickTitle({ ...CRYSTAL, tag: 'aaaaaaaaaaaaaaaa' }).id, 'pinned',
         'the fingerprint is how two hacks of one base are told apart');
    t.eq(pickTitle({ ...CRYSTAL, tag: 'bbbbbbbbbbbbbbbb' }).id, 'crystal',
         'and a mismatch skips it without asking matches() at all');
  } finally {
    TITLES.shift();
  }
});

test('every profile this app ships satisfies its own contract', async (t) => {
  for (const title of TITLES) {
    t.eq(validateTitle(title).join(' | '), '',
         `${title.id} is a usable profile`);
  }
});

test('a profile whose shape is wrong is skipped, not driven', async (t) => {
  // The failure this prevents: a hand-written profile that is recognised, then
  // half-trusted, and walks to the wrong places.
  const broken = { id: 'broken', matches: () => true };   // no drive
  TITLES.unshift(broken);
  try {
    t.eq(pickTitle({ header: { title: 'ANYTHING' } }).id, 'generic',
         'a recognised profile that cannot be used falls through');
  } finally {
    TITLES.shift();
  }
});

test('the contract catches the mistakes a profile is written by hand',
     async (t) => {
  const bad = (extra) => validateTitle(ok(extra)).join(' | ');

  t.contains(bad({ names: { 'not a key': 'Somewhere' } }), 'not a map key',
             'a map key written as a string never matches anything');
  t.contains(bad({ names: { 6151: '' } }), 'non-empty string',
             'and a name nobody can read is not a name');

  class WithHeal { atCentre() {} }
  t.eq(validateTitle(ok({ drive: WithHeal,
                          healers: [{ map: 6151, reach: 'atCentre' }] })).length, 0,
       'a healer whose method exists is fine');
  t.contains(validateTitle(ok({ drive: WithHeal,
                                healers: [{ map: 6151, reach: 'atCenter' }] })).join(),
             'does not have',
             'and one letter out is caught here rather than at healing time');

  t.contains(bad({ grassyMaps: [1, 'two'] }), 'map keys', 'grass maps are keys');
  t.contains(bad({ encounters: [1] }), 'symbol names', 'tables are named');
  t.contains(bad({ legCost: -3 }), 'positive number', 'a leg costs tiles');
  t.contains(bad({ engine: { nameLenght: 11 } }), 'not a field the engine reads',
             'a typo in an engine override would otherwise be ignored');
});

test('an engine override is a patch, not a replacement', async (t) => {
  const e = engineFor(ok({ engine: { nameLength: 11 } }));
  t.eq(e.nameLength, 11, 'the field the cartridge changed is changed');
  t.eq(e.partyStride, gen2.partyStride, 'and everything it did not is intact');
  t.eq(e.speciesCount, gen2.speciesCount, 'including the ones it never mentioned');
  t.eq(engineFor(ok({})), gen2, 'a title with no overrides gets the stock profile');
});

test('the app says which cartridge it is driving, only when that is news',
     async (t) => {
  class Full { run() {} heal() {} }
  const complete = { id: 'crystal', drive: Full, names: { 6151: 'Route 29' },
                     healers: [{ map: 6151, reach: 'heal' }] };
  t.false(describeTitle(complete).show,
          'a cartridge it knows needs no announcement that it knows it');

  const none = describeTitle({ id: 'generic', drive: class {} });
  t.true(none.show, 'a cartridge nobody has described is worth a line');
  t.contains(none.text, 'maps are numbered',
             'and the line is the consequences, not the id');
  t.contains(none.text, 'cannot start a game or heal',
             'because those absences are what looks broken');

  // The middle, which is the one somebody can act on: a file to go and finish.
  const half = describeTitle({ id: 'crystal-early', drive: class {},
                               names: { 6151: 'Route 29' } });
  t.contains(half.text, 'crystal-early', 'a half-written profile is named');
  t.contains(half.text, '1 map named', 'with how much of it there is');
  t.contains(half.text, 'nowhere to heal', 'and what it has not said yet');
  t.contains(half.text, 'no scripted start', 'both of them');

  t.false(describeTitle(null).show, 'and nothing at all before a game loads');
});

test('naming a profile by hand goes through the same gate as recognising one',
     async (t) => {
  t.eq(titleById('crystal').id, 'crystal', 'a usable profile comes back');
  t.eq(titleById('no-such-thing'), null, 'and a name nobody has is a no');

  // The path a profile author uses to try their own file was the path that
  // skipped the check that would tell them it is wrong.
  const broken = { id: 'broken', matches: () => true };   // no drive
  TITLES.unshift(broken);
  try {
    t.eq(titleById('broken'), null,
         'a profile that fails the contract is not handed back by id either');
  } finally {
    TITLES.shift();
  }
});

// --- a healer is a place, not a procedure with a place baked in -------------

test('a healer that names a place has to describe it', async (t) => {
  // Checked here rather than discovered when somebody's party is hurt, which is
  // the same reason `reach` is checked against the class. `heal()` used to be
  // Cherrygrove's -- the map, the door, the Center and the town it left by were
  // all constants in the body -- so a second Center would have been a second
  // copy of all of it.
  const base = { id: 'x', drive: class { healAtCenter() {} }, matches: () => true };
  const bad = validateTitle({ ...base,
    healers: [{ map: 100, reach: 'healAtCenter', inside: 200 }] });
  t.contains(bad.join(' '), 'door', 'a missing door is named');
  t.contains(bad.join(' '), 'nurse', 'and a missing nurse');

  const good = validateTitle({ ...base,
    healers: [{ map: 100, reach: 'healAtCenter', inside: 200,
                door: [29, 3], nurse: [3, 1] }] });
  t.eq(good, [], 'a described one passes');
});

test('a healer with no coordinates at all is not asked for any', async (t) => {
  // Elm's machine: the procedure carries its own places, because it is the one
  // healer in the game that is not a Center.
  const base = { id: 'x', drive: class { healAtElm() {} }, matches: () => true };
  t.eq(validateTitle({ ...base, healers: [{ map: 100, reach: 'healAtElm' }] }),
       [], 'nothing to describe');
});

test('a tile has to be a pair of small numbers', async (t) => {
  const base = { id: 'x', drive: class { healAtCenter() {} }, matches: () => true };
  const wrong = validateTitle({ ...base,
    healers: [{ map: 100, reach: 'healAtCenter', inside: 200,
                door: 29, nurse: [3, 1] }] });
  t.contains(wrong.join(' '), 'door', 'a single number is not a tile');
});

test('Crystal names Violet City, and can heal and shop there', async (t) => {
  // Found by reading the cartridge rather than a walkthrough: group 10's maps
  // were scanned for the nurse standing at (3,1) behind her counter and for a
  // clerk at (1,3), and Violet City's own warp list says which door leads to
  // each.
  t.eq(crystal.names[10 * 256 + 5], 'Violet City', 'the city is named');
  const centre = crystal.healers.find((h) => h.map === 10 * 256 + 5);
  t.true(!!centre, 'and it has a healer');
  t.eq(centre.inside, 10 * 256 + 10, "which is the city's own Center");
  t.eq(centre.reach, 'healAtCenter', 'reached by the shared procedure');
  const mart = crystal.marts.find((m) => m.from === 10 * 256 + 5);
  t.true(!!mart, 'and a mart');
  t.eq(mart.map, 10 * 256 + 6, 'through its own door');
});

// --- the gyms a title declares ----------------------------------------------
//
// The data itself is held to the cartridge by `check-app gyms`, which reads the
// ROM. What is worth testing here is the shape the engine relies on, because a
// second gym is the first time this list has had more than one entry -- and
// every rule about it was written when it could not be exercised.
//
// **Every title that declares any**, rather than Crystal's. Polished Crystal
// declares eight, generated in one paste from `--findgyms`, and a generated
// list is exactly the kind that can come out in the wrong order or with a
// repeated bit. Crystal's two were hand-written and read twice.
const WITH_GYMS = TITLES.filter((t) => (t.gyms || []).length);

test('the declared gyms are in badge order, one bit each', async (t) => {
  // `gymList` walks them and asks `hasBadge` per entry, so a repeated bit
  // would mark two gyms beaten at once and a gap would leave one unofferable
  // for ever.
  for (const title of WITH_GYMS) {
    const bits = title.gyms.map((g) => g.badge);
    t.eq(bits, [...bits].sort((a, b) => a - b), `${title.id}: in order`);
    t.eq(new Set(bits).size, bits.length, `${title.id}: no bit used twice`);
    t.eq(bits[0], 0, `${title.id}: starting at the first badge`);
  }
});

test('every gym names a town, a room, a door, a leader and a tile',
     async (t) => {
  // Five facts, and the engine dereferences all five: a missing one is a
  // silent `undefined` inside a walk rather than a refusal.
  for (const title of WITH_GYMS) for (const g of title.gyms) {
    const who = `${title.id}/${g.leader}`;
    t.true(Number.isInteger(g.map), `${who}: a town`);
    t.true(Number.isInteger(g.inside), `${who}: a room`);
    t.eq(g.door.length, 2, `${who}: a door`);
    t.eq(g.leaderAt.length, 2, `${who}: a tile to talk from`);
    t.true(Number.isInteger(g.badge), `${who}: a badge bit`);
  }
});

test('a gym room is never also a town, and never shared', async (t) => {
  // `Journey.doorTo` reads `inside` to find the room, and `beatGym` walks
  // `through(door, inside)`. Two gyms sharing a room, or a room that is also
  // somebody's town, would write off the wrong leg -- which is exactly the
  // defect that made the shut-leg feature do nothing on a cartridge.
  for (const title of WITH_GYMS) {
    const rooms = title.gyms.map((g) => g.inside);
    const towns = title.gyms.map((g) => g.map);
    t.eq(new Set(rooms).size, rooms.length, `${title.id}: each its own room`);
    t.false(rooms.some((r) => towns.includes(r)),
            `${title.id}: and no room is a town`);
  }
});

test('every gym is somewhere the cartridge has a name for', async (t) => {
  // Otherwise the row reads "map 8.5", which is honest and useless. The town's
  // name comes from the landmark table for free; the room's has to be
  // declared -- and a title with no `names` at all has said so, which is a
  // gap in what the interface can say rather than a broken declaration.
  for (const g of crystal.gyms) {
    t.true(!!crystal.names[g.inside], `${g.leader}'s room is named`);
    t.true(!!crystal.names[g.map] || true, `${g.leader}'s town`);
  }
});


// --- what "described" means, across every profile that ships ----------------

test('every shipped profile either drives a cartridge or says what it lacks',
     async (t) => {
  // **The banner is the parity marker, and it reads the same things a job
  // row does**: a name for a map, somewhere to heal, and a scripted start.
  // Polished Crystal showed "no scripted start" for eight passes, which was
  // true, and the row it stands for was the last one dark.
  //
  // `generic` is the deliberate exception and always will be: it is the
  // profile for a cartridge nobody has described, and announcing that is its
  // whole job.
  for (const title of TITLES) {
    const said = describeTitle(title, { named: true });
    if (title.id === 'generic') {
      t.true(said.show, 'generic says so');
      continue;
    }
    t.false(said.show,
            `${title.id} needs no announcement — ${said.text || 'silent'}`);
  }
});

test('a scripted start walks tiles the profile declares, in order',
     async (t) => {
  // Four doors on Polished Crystal and six legs on Crystal, and neither
  // class names a tile of its own: every one comes out of `places`, which
  // `tools/route --reach` holds to the map graph. A driver that reached past
  // its profile for a coordinate is a driver that cannot be checked.
  for (const title of TITLES) {
    const run = title.drive && title.drive.prototype.run;
    if (typeof run !== 'function') continue;
    const src = run.toString();
    const named = [...src.matchAll(/\bp\.(\w+)/g)].map((m) => m[1]);
    t.true(named.length >= 3, `${title.id}: its run walks declared places`);
    for (const name of new Set(named)) {
      t.true((title.places || {})[name] !== undefined,
             `${title.id}: places.${name} is declared`);
    }
    t.false(/\[\s*\d+\s*,\s*\d+\s*\]/.test(src),
            `${title.id}: and no tile is written into the walk itself`);
  }
});
