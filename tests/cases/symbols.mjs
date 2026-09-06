// The symbol table, and the small version of it that crosses between devices.
import { symbols, test } from '../harness.mjs';
import { SHARED_SYMBOLS, Symbols, sharedNames } from '../../gen2/symbols.js';

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

test('a cartridge sends its own wild tables, not only the app\'s list',
     async (t) => {
  t.eq(sharedNames(null).length, SHARED_SYMBOLS.length,
       'with no title, the app\'s list is the whole of it');
  t.eq(sharedNames({ encounters: ['JohtoGrassWildMons'] }).length,
       SHARED_SYMBOLS.length,
       'a table already in the list adds nothing — Crystal\'s two are in it');

  const hack = sharedNames({ encounters: ['HackGrassWildMons'] });
  t.eq(hack.length, SHARED_SYMBOLS.length + 1, 'a table of its own is added');
  t.true(hack.includes('HackGrassWildMons'),
         'so the device with no .sym can find what this cartridge hunts in');

  // The failure this prevents is quiet: that device boots, walks and saves, and
  // has nothing to hunt, on a cartridge where hunting works fine next to it.
  t.false(SHARED_SYMBOLS.includes('HackGrassWildMons'),
          'and the app\'s own list is left alone');
});

test('a symbol moved out of work RAM is refused, not read as undefined',
     async (t) => {
  // The failure this replaces is the quietest one in the app. Every `w` read
  // goes through a snapshot of 0xC000-0xDFFF and `GameBoy.byteAt` indexes it by
  // subtracting the base, so an address outside that window does not throw --
  // it reads `undefined`. Measured with wBattleMode in HRAM: `inBattle` became
  // `undefined !== 0`, which is true, and the pilot believed it was in a battle
  // it could never leave. Nothing downstream can name that as the cause.
  const full = symbols();
  const moved = Symbols.fromDigest({
    ...full.digest(SHARED_SYMBOLS),
    wBattleMode: [0, 0xff90],        // HRAM
    wXCoord: [0, 0xa123],            // SRAM
  });
  const e = await t.rejects(async () => moved.require(['wBattleMode']),
                            'a table with reads outside work RAM is refused');
  t.contains(e.message, 'outside work RAM', 'and says what is wrong');
  t.contains(e.message, 'wBattleMode at $ff90', 'naming one, with its address');

  // Presence and placement are different questions, and only the second one is
  // absolute: a hack may legitimately lack a name this app would like.
  const partial = Symbols.fromDigest(full.digest(['wPartyCount', 'wBattleMode']));
  partial.require(['wPartyCount']);
  t.true(true, 'a short table whose addresses are all readable still loads');
});

test('the stock table places every symbol this app reads where it can read it',
     async (t) => {
  // The other direction, and the one that would catch this check being wrong:
  // if the range or the `w` rule were off, the ordinary path would refuse.
  const full = symbols();
  full.require(SHARED_SYMBOLS.filter((n) => full.has(n)));
  t.true(true, 'every name the harness places passes its own gate');
});
