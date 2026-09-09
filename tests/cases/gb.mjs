// Reading the machine: the arithmetic, and the guard around a library that lies.
//
// `gbcore/gb.js` scored 12% of its mutations, and most of it is genuinely out
// of reach -- it wraps an emulator. What is *not* out of reach is every line
// that turns an address into an offset, and those are the lines everything else
// in the app trusts: a wrong shift makes every HP wrong, a wrong bank makes
// every ROM read rubbish, and both would look like the cartridge being odd.
import { test } from '../harness.mjs';
import { GameBoy } from '../../gbcore/gb.js';

// Work RAM starts at $C000 on a Game Boy, and every reader here subtracts it.
const BASE = 0xc000;
const at = (offset, ...bytes) => {
  const wram = new Uint8Array(0x2000);
  wram.set(bytes, offset);
  return wram;
};

test('a byte is read at the address the game uses, not at the offset',
     async (t) => {
  const wram = at(0x10, 42);
  t.eq(GameBoy.byteAt(wram, BASE + 0x10), 42, 'the address is translated');
  t.eq(GameBoy.byteAt(wram, BASE + 0x11), 0, 'and its neighbour is not it');
});

test('a big-endian word is read high byte first, above 255 too', async (t) => {
  // **Above 255 is the whole point.** Every HP in this repository's tests is
  // 20 or 44, and for a value under 256 the high byte is zero -- so dropping
  // the `<< 8` entirely gives the same answer and survived every test. A Gen 2
  // Pokémon can have seven hundred HP.
  const wram = at(0x20, 0x02, 0xbc);            // 700
  t.eq(GameBoy.wordAt(wram, BASE + 0x20), 700, 'high byte first');
  const small = at(0x20, 0x00, 20);
  t.eq(GameBoy.wordAt(small, BASE + 0x20), 20, 'and a small one still reads');
  const swapped = at(0x20, 0xbc, 0x02);
  t.ne(GameBoy.wordAt(swapped, BASE + 0x20), 700,
       'the other order is a different number, which is why this matters');
});

test('a little-endian word is read low byte first, above 255 too', async (t) => {
  // The convention the game uses for *pointers*, which is where a wrong order
  // stops looking like a plausible number and starts reading another bank.
  const wram = at(0x30, 0x4f, 0x44);            // $444f
  t.eq(GameBoy.wordLeAt(wram, BASE + 0x30), 0x444f, 'low byte first');
  t.ne(GameBoy.wordLeAt(wram, BASE + 0x30),
       GameBoy.wordAt(wram, BASE + 0x30), 'and the two orders disagree');
});

test('a ROM byte is found by bank and window position', async (t) => {
  // Bank 0 is the first 16 KB and always mapped low; every other bank pages
  // into $4000-$7FFF, so the file offset is the bank times its size plus the
  // position *within* the window. Both halves of that were unasserted, and
  // `tools/route` now leans on the same arithmetic.
  const gb = new GameBoy();
  gb.rom = new Uint8Array(0x4000 * 3);
  gb.rom[0x0100] = 1;                           // bank 0, low
  gb.rom[0x4000 + 0x0044] = 2;                  // bank 1, at $4044
  gb.rom[0x8000 + 0x0044] = 3;                  // bank 2, same window position
  t.eq(gb.romByte(0, 0x0100), 1, 'bank 0 reads where it is mapped');
  t.eq(gb.romByte(1, 0x4044), 2, 'a banked address is masked into its window');
  t.eq(gb.romByte(2, 0x4044), 3, 'and the bank chooses which one');
  t.eq(gb.romByte(1, 0x0044), 2,
       'the mask means an unbanked address in a bank still lands right');
});

// --- the library that lies ---------------------------------------------------
//
// `_getWasmMemorySection(start, end)` does not reliably honour its range: it
// has been seen answering with the core's entire ~10 MB linear memory instead
// of the slice asked for. Indexing that as though it *were* the slice reads
// from the wrong base and yields plausible-looking rubbish, which is the worst
// kind of wrong. Both readers normalise rather than trust, and neither
// normalisation was tested.

/** A core that answers honestly, or with the whole of memory. */
const core = ({ honest = true, size = 0x8000 } = {}) => {
  const all = new Uint8Array(size);
  for (let i = 0; i < size; i++) all[i] = i & 0xff;
  return {
    all,
    async _getWasmMemorySection(from, to) {
      return honest ? all.subarray(from, to) : all;
    },
  };
};

test('a snapshot is the right size whether or not the library obeys',
     async (t) => {
  const gb = new GameBoy();
  gb.workRam = 0x1000;
  gb.core = core();
  const honest = await gb.readWram(0x2000);
  t.eq(honest.length, 0x2000, 'an honest answer comes back as it is');

  gb.core = core({ honest: false });
  const whole = await gb.readWram(0x2000);
  t.eq(whole.length, 0x2000, 'and a whole-memory answer is cut down to size');
  t.eq(whole[0], gb.core.all[0x1000],
       'from the right base — which is the half that would read rubbish');
});

test('a few bytes are the right few, whether or not the library obeys',
     async (t) => {
  const gb = new GameBoy();
  gb.workRam = 0x1000;
  gb.core = core();
  const honest = await gb.readBytes(0xc040, 4);
  t.eq(honest.length, 4, 'four asked for, four given');

  gb.core = core({ honest: false });
  const whole = await gb.readBytes(0xc040, 4);
  t.eq(whole.length, 4, 'and four out of the whole of memory');
  t.eq([...whole], [...gb.core.all.subarray(0x1040, 0x1044)],
       'taken from work RAM plus the address, not from the start of memory');
});

test('a machine with no ROM refuses rather than reading nothing', async (t) => {
  const gb = new GameBoy();
  await t.rejects(() => gb.batterySave(), 'no ROM, no battery');
});
