// Which cartridge a battery record belongs to.
//
// The rest of saves.js needs IndexedDB and a running emulator, so it is not
// reachable from here. This part is, and it is the part that was wrong: the
// arithmetic of deciding whether a record in the library's store is *ours*.
import { test } from '../harness.mjs';
import { pickKey, sameKey, Saves } from '../../gbcore/saves.js';

// The real thing, measured: ROM bytes 0x134-0x14E of pokecrystal, which is the
// title, the cartridge flags, the header checksum, and the top byte of the
// global checksum.
const CRYSTAL = new Uint8Array([
  80, 77, 95, 67, 82, 89, 83, 84, 65, 76, 0, 0, 0, 0, 0, 0,
  0, 0, 3, 16, 6, 3, 1, 51, 0, 39, 18,
]);
/** A hack of it: same title, one byte of the global checksum different. */
const hack = () => { const h = CRYSTAL.slice(); h[26] = 200; return h; };
/** What IndexedDB hands back for a key that went in as a Uint8Array. */
const stored = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.length);

test('a key equals itself across the type IndexedDB returns it as', async (t) => {
  // The library files the record under a Uint8Array; a binary key comes back
  // out as an ArrayBuffer. `===` is false between a key and itself, which is
  // the whole reason this is a function.
  t.true(sameKey(stored(CRYSTAL), CRYSTAL), 'ArrayBuffer against Uint8Array');
  t.true(sameKey(CRYSTAL, CRYSTAL), 'and against itself');
  t.false(sameKey(stored(hack()), CRYSTAL), 'one byte apart is not the same key');
  t.false(sameKey(null, CRYSTAL), 'nothing is not a key');
  t.false(sameKey(stored(CRYSTAL.slice(0, 20)), CRYSTAL), 'nor a shorter one');
});

test('the only record in the store is not automatically ours', async (t) => {
  // The bug. The library writes nothing until a battery is persisted, so after
  // playing one cartridge the store holds exactly one record -- and taking it
  // wrote this cartridge's save into the other cartridge's record, which
  // applied nothing here and destroyed the save there.
  t.eq(pickKey([stored(hack())], CRYSTAL), null,
       'a single record belonging to a different cartridge is refused');
  t.true(sameKey(pickKey([stored(CRYSTAL)], CRYSTAL), CRYSTAL),
         'and one belonging to this cartridge is taken');
});

test('the right record is found among several cartridges', async (t) => {
  const keys = [stored(hack()), stored(CRYSTAL)];
  t.true(sameKey(pickKey(keys, CRYSTAL), CRYSTAL), 'ours, not the first one');
  t.true(sameKey(pickKey(keys, hack()), hack()), 'and theirs when we are it');
  t.eq(pickKey([], CRYSTAL), null, 'an empty store has nothing of ours');
  t.eq(pickKey(null, CRYSTAL), null, 'nor does a store that is not there');
});

// --- listing the slots, and what happens when a read fails -------------------

/**
 * The smallest thing `tx` and `wrap` will accept for a read.
 *
 * Not a mock of `list` -- a mock of *IndexedDB*, to the two shapes this file
 * uses: a transaction that completes, and requests that call back. `fails` names
 * the keys whose read raises, which is the case with no other way to reach it.
 */
function fakeDb(records, { fails = [], abort = false } = {}) {
  return {
    transaction() {
      const t = {};
      const reqs = [];
      queueMicrotask(() => {
        for (const r of reqs) {
          if (fails.includes(r.key)) { r.error = new Error('read failed'); r.onerror && r.onerror(); }
          else { r.result = records[r.key]; r.onsuccess && r.onsuccess(); }
        }
        // The transaction settles after every request has, which is the ordering
        // the real one guarantees and the fill used to depend on by luck.
        queueMicrotask(() => {
          if (abort) { t.error = new Error('aborted'); t.onabort && t.onabort(); }
          else t.oncomplete && t.oncomplete();
        });
      });
      t.objectStore = () => ({
        get(key) { const r = { key }; reqs.push(r); return r; },
      });
      return t;
    },
  };
}

/** A Saves whose database is that. */
function slots(records, opts) {
  const s = new Saves({}, {}, null, () => {});
  s.db = async () => fakeDb(records, opts);
  return s;
}

test('every slot comes back, summary or nothing', async (t) => {
  const got = await slots({
    '1:about': { when: 5, where: 'Route 29', lead: 'CYNDAQUIL Lv5' },
    'undo:about': { when: 9, where: "Elm's lab" },
  }).list();
  t.eq(Object.keys(got).sort(), ['1', '2', '3', 'replaced', 'undo'],
       'all five, whether or not they hold anything');
  t.eq(got['1'].where, 'Route 29', 'the one that was written');
  t.eq(got['2'], null, 'and an empty slot is null rather than missing');
});

test('a read that fails leaves an empty slot, not an unhandled rejection',
     async (t) => {
  // The defect. The five reads were fired and forgotten, so a read that failed
  // rejected with nobody listening -- an error the caller can catch *and* one
  // it cannot, arriving a turn later with no stack pointing here. Which is the
  // shape the codec had nine passes earlier, on the other half of the save
  // path.
  const strays = [];
  const catcher = (e) => strays.push(e);
  process.on('unhandledRejection', catcher);
  let got;
  try {
    got = await slots({ '2:about': { when: 1, where: 'Route 30' } },
                      { fails: ['1:about'] }).list();
    // Abandoned rejections are reported a turn after the fact, so a check here
    // without the wait would always find none.
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.off('unhandledRejection', catcher);
  }
  t.eq(strays.length, 0, 'nothing was left rejecting into the void');
  t.eq(got['1'], null, 'the one that failed reads as empty');
  t.eq(got['2'].where, 'Route 30', 'and the others are unaffected');
});

test('a transaction that aborts fails the call rather than half-filling it',
     async (t) => {
  await t.rejects(() => slots({}, { abort: true }).list(),
                  'the caller is told, once');
});
