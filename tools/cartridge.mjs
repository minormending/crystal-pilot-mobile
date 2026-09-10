// Which cartridge is in `dev/`, for the tools that read one.
//
// Five tools opened `dev/pokecrystal.gbc` and `dev/pokecrystal.sym` by name,
// which is right for the disassembly and wrong for everything built from it:
// a hack's Makefile names its own output, so `pokeperidot.gbc`,
// `crystal-speedchoice.gbc`, `polishedcrystal-3.0.0.gbc`. Testing one meant
// renaming two files, and renaming files to test a thing is how you end up
// testing the wrong thing.
//
// **The pairing is the part that matters, not the globbing.** A symbol file
// describes exactly one build: its addresses are that ROM's memory map, and
// handed the wrong ROM it does not fail, it answers. Every read comes back
// plausible and wrong, which is this repository's most expensive shape of
// bug and the reason `loadSlot` and the handoff both check a ROM fingerprint
// before believing a save. So a pair is taken when the two names *agree*, and
// a pair that has to be assumed is said out loud.
import { readHeader } from '../gbcore/cartridge.js';
import { engineFor } from '../titles/contract.js';
import { pickTitle } from '../titles/pick.js';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

import { Symbols } from '../gen2/symbols.js';

// What a Game Boy ROM is called. `.gb` as well as `.gbc`, because a hack that
// targets the mono machine is still a cartridge this can read.
const ROM_EXTS = ['.gbc', '.gb'];

const stemOf = (f) => basename(f, extname(f));

/**
 * The ROM and symbol file to use, or null.
 *
 * `DEV_ROM` and `DEV_SYM` override the search outright, which is what makes a
 * run over several hacks scriptable without moving files about.
 */
export function findCartridge(dev) {
  // The other half of the override, and the one that catches bugs rather than
  // enabling scripts: every tool here has a second path for when there is no
  // cartridge, and on a machine with one that path never runs.
  if (process.env.DEV_NO_CARTRIDGE) return null;
  const forced = process.env.DEV_ROM && process.env.DEV_SYM;
  if (forced) {
    return { rom: process.env.DEV_ROM, sym: process.env.DEV_SYM,
             name: stemOf(process.env.DEV_ROM), note: null };
  }
  if (!existsSync(dev)) return null;
  const all = readdirSync(dev);
  const roms = all.filter((f) => ROM_EXTS.includes(extname(f).toLowerCase()));
  const syms = all.filter((f) => extname(f).toLowerCase() === '.sym');
  if (!roms.length || !syms.length) return null;

  // Newest first, so a tree with two builds in it uses the one just made
  // rather than whichever sorts first.
  const newest = (a, b) => statSync(join(dev, b)).mtimeMs
    - statSync(join(dev, a)).mtimeMs;
  roms.sort(newest);
  const paired = roms.find((r) => syms.includes(`${stemOf(r)}.sym`));
  if (paired) {
    const one = roms.length === 1 && syms.length === 1;
    return {
      rom: join(dev, paired), sym: join(dev, `${stemOf(paired)}.sym`),
      name: stemOf(paired),
      note: one ? null : `using ${paired} with ${stemOf(paired)}.sym`,
    };
  }
  // Nothing agrees. One of each is almost certainly the pair somebody meant
  // -- a file renamed by hand, most likely -- and it is still an assumption,
  // so it is made once and said. Anything else is refused: guessing here buys
  // a run of confident wrong answers, and moving one file buys certainty.
  if (roms.length === 1 && syms.length === 1) {
    return {
      rom: join(dev, roms[0]), sym: join(dev, syms[0]), name: stemOf(roms[0]),
      note: `${roms[0]} and ${syms[0]} do not share a name — assuming they are `
            + 'the same build. A symbol file from another build answers every '
            + 'read, plausibly and wrongly.',
    };
  }
  return { rom: null, sym: null, name: null,
           note: `cannot tell which of ${roms.length} ROM(s) goes with which `
                 + `of ${syms.length} symbol file(s): ${roms.join(', ')} / `
                 + `${syms.join(', ')}. Name them alike, or set DEV_ROM and `
                 + 'DEV_SYM.' };
}

/**
 * The cartridge, opened, or null with a reason printed.
 *
 * `gb` is the one thing every reader in this app asks of a Game Boy: a byte of
 * ROM. Bank 0 is mapped low and every other bank pages into 0x4000, which is
 * `GameBoy.romByte`'s arithmetic — repeated here rather than imported because
 * `gb.js` reaches for a canvas on the way in, and it was repeated in four
 * tools before it was repeated in one.
 */
/**
 * The engine numbers this cartridge would run under, and which profile said so.
 *
 * **The tools were reading every cartridge as Crystal.** `RomData` takes an
 * engine profile and they all left it out, so the stock one applied -- which
 * is right for Crystal and for every hack that kept its shape, and wrong for
 * the one that did not: `tools/dex bulbasaur` on Polished Crystal answered
 * "no readable base-stats entry" while the app, which does pick a profile,
 * read it. A tool that disagrees with the app it is meant to check is worse
 * than no tool.
 *
 * The same `pickTitle` the app uses, from the same header and symbol table,
 * so there is one answer to "which cartridge is this" and not two.
 */
export function engineOf({ rom, symbols }) {
  const title = pickTitle({ header: readHeader(rom), symbols });
  return { title, engine: engineFor(title) };
}

/**
 * The `.sav` to read, or null -- `DEV_SAV` first, then whatever is in `dev/`.
 *
 * The same escape `DEV_ROM` and `DEV_SYM` give the other two files, and it
 * was missing: a hack's save could only be tested by copying it into `dev/`
 * beside somebody's real cartridge, which is exactly the thing those
 * variables exist to avoid.
 */
export function findSave(dev) {
  if (process.env.DEV_SAV) return process.env.DEV_SAV;
  if (process.env.DEV_NO_CARTRIDGE || !dev || !existsSync(dev)) return null;
  const found = readdirSync(dev).filter((f) => f.toLowerCase().endsWith('.sav'));
  return found.length ? join(dev, found.sort()[0]) : null;
}

export function openCartridge(dev) {
  const found = findCartridge(dev);
  if (!found) {
    console.log('no cartridge in dev/ — nothing to read');
    console.log('(a ROM is not in this repository and never will be)');
    return null;
  }
  if (found.note) console.log(`[cartridge] ${found.note}`);
  if (!found.rom) return null;
  const rom = readFileSync(found.rom);
  return {
    rom,
    symbols: new Symbols(readFileSync(found.sym, 'utf8')),
    gb: { romByte: (bank, addr) => rom[bank * 0x4000 + (addr & 0x3fff)] },
    name: found.name,
    romPath: found.rom,
    symPath: found.sym,
  };
}
