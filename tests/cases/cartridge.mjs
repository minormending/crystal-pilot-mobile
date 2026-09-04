// Reading a cartridge's own header, which is how a file is refused and how a
// game is recognised.
import { test } from '../harness.mjs';
import { readHeader } from '../../gbcore/cartridge.js';

const LOGO = [0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d];

/** A believable 32KB cartridge, with whatever header the test wants. */
function cart({ logo = true, title = 'PM_CRYSTAL', cgb = 0xc0, size = 0x8000 } = {}) {
  const b = new Uint8Array(size);
  if (logo) LOGO.forEach((v, i) => { b[0x104 + i] = v; });
  for (let i = 0; i < title.length; i++) b[0x134 + i] = title.charCodeAt(i);
  b[0x143] = cgb;
  return b.buffer;
}

test('a cartridge is recognised by its logo, not by its name', async (t) => {
  t.true(readHeader(cart()).ok, 'the logo is there');
  t.false(readHeader(cart({ logo: false })).ok, 'and without it, this is a file');
  t.true(readHeader(cart({ logo: true, title: '' })).ok,
         'a nameless cartridge is still a cartridge');
});

test('a file too small to hold a header is refused before it is read',
     async (t) => {
  const small = readHeader(cart({ size: 0x200 }));
  t.false(small.ok, 'nothing under 32KB is a Gen 2 cartridge');
  t.eq(small.title, '', 'and no title is invented from bytes past the end');
  t.eq(small.bytes, 0x200, 'the length comes back, for the message');
});

test('the title stops at the padding, and at anything unprintable',
     async (t) => {
  t.eq(readHeader(cart({ title: 'PM_CRYSTAL' })).title, 'PM_CRYSTAL',
       'Crystal writes ten characters and pads the rest with zeroes');
  t.eq(readHeader(cart({ title: 'POKEMON GOLD' })).title, 'POKEMON GOLD',
       'a longer name is read whole');

  // A manufacturer code where the name should be: half a title with a control
  // character in it is worse than admitting there is none.
  const odd = new Uint8Array(cart());
  odd[0x137] = 0x01;
  t.eq(readHeader(odd.buffer).title, '',
       'an unprintable byte means this field is not a title');
});

test('Color-only is a property of the cartridge, and worth knowing',
     async (t) => {
  t.true(readHeader(cart({ cgb: 0xc0 })).cgbOnly,
         'Crystal is 0xc0, which is why it brings its own palette');
  t.false(readHeader(cart({ cgb: 0x80 })).cgbOnly,
          'and 0x80 would run on a mono Game Boy too');
});
