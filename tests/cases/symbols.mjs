// The symbol table, and the small version of it that crosses between devices.
import { symbols, test } from '../harness.mjs';
import { Symbols } from '../../app/symbols.js';

test('a digest of the names an app uses behaves like the file it came from', async (t) => {
  // 1.8MB of .sym against about a kilobyte of the 45 lines that get read. The
  // point of the digest is that nothing downstream can tell the difference.
  const full = symbols();
  const names = ['wPartyCount', 'wBattleMode', 'wMapGroup'];
  const small = Symbols.fromDigest(full.digest(names));
  for (const n of names) {
    t.eq(small.addr(n), full.addr(n), `${n} is at the same address`);
    t.eq(small.bank(n), full.bank(n), `${n} is in the same bank`);
  }
  t.eq(small.size, names.length, 'and it says how many symbols it actually has');
  t.true(small.has('wPartyCount'), 'has() works the same');
  t.false(small.has('wTimeOfDay'), 'and says no to one that was not asked for');
});

test('a digest missing what this build needs fails at load, not mid-task', async (t) => {
  // The same guarantee `require` gives a .sym from the wrong build: say so now,
  // rather than throwing "symbol not in this .sym file" in the middle of a
  // grind an hour later.
  const small = Symbols.fromDigest(symbols().digest(['wPartyCount']));
  await t.rejects(async () => small.require(['wPartyCount', 'wBattleMode']),
                  'an incomplete digest is refused');
  small.require(['wPartyCount']);
  t.true(true, 'and a complete one is not');
});

test('junk in a digest is dropped rather than believed', async (t) => {
  // It arrives from another device, over a room anyone with the code can write
  // to. An address that is not a number would read memory at NaN and hand back
  // plausible-looking rubbish.
  const small = Symbols.fromDigest({
    wPartyCount: [1, 0xdcd7],
    wBadPair: [1],
    wNotNumbers: ['bank', 'addr'],
    wNotAnArray: 0xdcd7,
  });
  t.eq(small.size, 1, 'only the well-formed entry survives');
  t.eq(small.addr('wPartyCount'), 0xdcd7, 'and it is intact');
});

test('a digest asks for names the file does not have, and simply lacks them', async (t) => {
  const made = symbols().digest(['wPartyCount', 'wNoSuchSymbolAnywhere']);
  t.eq(Object.keys(made), ['wPartyCount'], 'absent names are left out, not stored empty');
});
