// Which cartridge a battery record belongs to.
//
// The rest of saves.js needs IndexedDB and a running emulator, so it is not
// reachable from here. This part is, and it is the part that was wrong: the
// arithmetic of deciding whether a record in the library's store is *ours*.
import { test } from '../harness.mjs';
import { pickKey, sameKey } from '../../gbcore/saves.js';

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
