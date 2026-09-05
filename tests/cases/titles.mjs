// Choosing a profile for a cartridge, which is the one thing that has to be
// right before a ROM hack can be pointed at this app at all.
import { test } from '../harness.mjs';
import { TITLES, pickTitle } from '../../titles/pick.js';
import { engineFor, validateTitle } from '../../titles/contract.js';
import { describeTitle } from '../../app/rows.js';
import { gen2 } from '../../gen2/engine.js';

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
