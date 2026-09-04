// Choosing a profile for a cartridge, which is the one thing that has to be
// right before a ROM hack can be pointed at this app at all.
import { test } from '../harness.mjs';
import { TITLES, pickTitle } from '../../titles/pick.js';

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
  const pinned = { id: 'pinned', fingerprint: 'aaaaaaaaaaaaaaaa',
                   matches: () => true };
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
