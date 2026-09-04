// What a cartridge says about itself, out of its own header.
//
// Sixteen bytes at 0x134 that every Game Boy ROM carries, and the only part of
// this app that reads the ROM without an emulator: picking a file, and then
// working out which game it is. Nothing here knows what a Pokemon is.
//
// The header is read from the bytes rather than through gb.js on purpose. It is
// wanted *before* the core is started -- to refuse a file that is not a
// cartridge at all, and to choose a profile for the one that is -- and starting
// an emulator to read sixteen bytes is a strange way round.

// Every cartridge opens its logo with these. Checking them turns "picked the
// wrong file" into a sentence rather than a mysterious failure to boot.
const LOGO_AT = 0x104;
const LOGO = [0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d];

// The title, 0x134 to 0x143. Eleven characters plus a four-byte manufacturer
// code on later cartridges, which is why this stops at the first zero rather
// than trusting the length: Crystal writes PM_CRYSTAL and pads the rest.
const TITLE_AT = 0x134, TITLE_MAX = 15;
// 0x80 runs on both, 0xc0 is Color-only. Crystal is 0xc0, which is why there is
// no palette switcher for the screen: the game supplies its own colours.
const CGB_AT = 0x143;
// The smallest cartridge that could hold a Gen 2 game. A file under this is a
// mistake rather than a small game, and reading a header out of it would be
// reading past the end.
const MIN_BYTES = 0x8000;

/**
 * Read the header, and say whether this is a cartridge at all.
 *
 * `{ ok, title, cgbOnly, bytes }`. `ok` is the logo check and the length; the
 * rest is only meaningful when `ok` is true, and is returned anyway so a caller
 * can put the title in a message about why it refused something else.
 */
export function readHeader(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < MIN_BYTES) {
    return { ok: false, title: '', cgbOnly: false, bytes: bytes.length };
  }
  const ok = LOGO.every((b, i) => bytes[LOGO_AT + i] === b);
  let title = '';
  for (let i = 0; i < TITLE_MAX; i++) {
    const c = bytes[TITLE_AT + i];
    if (!c) break;
    // Printable ASCII only. A byte outside it means this field is not a title
    // -- a homebrew ROM with a manufacturer code where the name should be --
    // and half a name with a control character in it is worse than none.
    if (c < 0x20 || c > 0x7e) { title = ''; break; }
    title += String.fromCharCode(c);
  }
  return { ok, title, cgbOnly: bytes[CGB_AT] === 0xc0, bytes: bytes.length };
}
