// Polished Crystal — the cartridge this repository calls the hard one.
//
// It keeps `PKPCRYSTAL` in its header and almost nothing else of Crystal's
// shape: nineteen types including FAIRY, a `TypeNames` table of one-byte
// relative offsets, a chart on Q4 fixed point rather than tenths, strings
// ending in `$53`, a party entry that moves five of its fields, and 291
// species. Most of that is read rather than declared — the engine derives the
// scale, the pointer shape, the terminator and the party layout off the
// cartridge itself, and every one of those derivations was written because
// this cartridge broke the assumption underneath it.
//
// **What is left here is what cannot be derived**, which is one table's
// layout and two lists of the cartridge's own words. `BaseData` has no
// species id in front of each entry to check a stride against and no
// self-describing field at all; its entry is 34 bytes where Crystal's is 32,
// its stats come before its types, and it has four experience curves where
// Crystal has six. Nothing in the ROM says so. A profile is the honest place
// for a fact a reader cannot measure.
//
// It is not a claim that the app plays this cartridge well. Its menus are its
// own — a start menu reading Bag, Save, Options, Quit — its move effects are
// renumbered, and its trainer parties are in banks the reader refuses to
// guess at. See `docs/DEVELOPING.md` for what passes and what does not.
import { Journey } from '../gen2/journey.js';

export const polished = {
  id: 'polished',
  // Both tables, under the names Crystal uses for them, which this cartridge
  // kept.
  encounters: ['JohtoGrassWildMons', 'KantoGrassWildMons'],
  // What the game says when a catch goes to the box rather than the party --
  // `_MonSentToPCText`, "<name> was / sent to <box>." Crystal names Bill;
  // this one names whichever box is current, out of a RAM buffer, so the
  // phrase stops before it. Without this a successful catch on a full party
  // is reported as a getaway, which is the one outcome the branch exists to
  // prevent.
  phrases: {
    boxed: 'sent to',
  },
  // Read off the cartridge's own item table rather than copied from Crystal's
  // profile: the berries are renamed to their Gen 3 words — BERRY is ORAN
  // BERRY here — and PRZCUREBERRY is CHERI BERRY. A list that named Crystal's
  // would have healed with nothing at all.
  heals: ['oran berry', 'sitrus berry', 'potion', 'berry juice', 'fresh water',
          'soda pop', 'lemonade', 'moomoo milk', 'super potion',
          'hyper potion', 'max potion', 'full restore'],
  cures: {
    psn: ['pecha berry', 'antidote', 'full heal', 'full restore'],
    par: ['cheri berry', 'paralyzeheal', 'full heal', 'full restore'],
    brn: ['rawst berry', 'burn heal', 'full heal', 'full restore'],
    frz: ['aspear berry', 'ice heal', 'full heal', 'full restore'],
    slp: ['chesto berry', 'awakening', 'full heal', 'full restore'],
  },
  engine: {
    // 0x123 species constants, which is what `NUM_SPECIES` comes to. Not 334:
    // that number was in this repository's own notes for two passes and is
    // from an older release.
    speciesCount: 291,
    // 34 bytes an entry, measured — Ivysaur's stats begin 34 bytes after
    // Bulbasaur's. Crystal's 32 read Bulbasaur's TM bitfield as Ivysaur's HP.
    baseBytes: 34,
    // `id: null` because there is no species byte in front of the entry to
    // check against. The reader proves the alignment another way when it is
    // told that; see `baseStats`. `hatch` is null because the hatch cycles
    // are a nibble beside the gender ratio rather than a byte of their own.
    baseField: { id: null, stats: 0, types: 6, catchRate: 8, baseExp: 9,
                 gender: 12, hatch: null, growth: 16 },
    // Four, in this order, against Crystal's six. Bulbasaur's growth byte is
    // 1, which is MEDIUM_SLOW here and would read as "slightly fast" on
    // Crystal's list — a wrong word rather than a missing one, which is the
    // kind of mistake a profile exists to stop.
    growthRates: ['mediumFast', 'mediumSlow', 'fast', 'slow'],
    // $ff moves, against Crystal's 251.
    moveCount: 255,
    // **Its start menu is its own.** `#dex`, `#mon`, Bag, Save, Options,
    // Exit, Pokégear, Quit -- so a pilot looking for PACK walked the whole
    // menu and gave up, and one looking for SAVE never saved. The battle
    // party menu says Switch rather than SWITCH, which matching folds, but
    // the word is here anyway because reading the list should not require
    // knowing that.
    //
    // `party` is the row the start menu writes as `#mon`: a ligature byte
    // and three letters, so what a screen reads is not "POKéMON". Both are
    // listed and the first that the selected line says wins.
    menuWords: {
      party: ['POKéMON', 'mon'],
      pack: ['PACK', 'Bag'],
      save: ['SAVE', 'Save'],
      switch: ['SWITCH', 'Switch'],
    },
    // Nineteen types where Crystal has seventeen with two gaps, renumbered
    // end to end: no BIRD, no unused block between the physical types and
    // the special ones, and FAIRY on the end. The numbers are what
    // `tools/types --verify` writes its rules in, so without these it says
    // FIGHTING does double damage to GHOST -- which is polished's FIGHTING
    // against polished's *STEEL*, read at Crystal's numbering.
    typeIds: {
      NORMAL: 0x00, FIGHTING: 0x01, FLYING: 0x02, POISON: 0x03, GROUND: 0x04,
      ROCK: 0x05, BUG: 0x06, GHOST: 0x07, STEEL: 0x08, FIRE: 0x09,
      WATER: 0x0a, GRASS: 0x0b, ELECTRIC: 0x0c, PSYCHIC: 0x0d, ICE: 0x0e,
      DRAGON: 0x0f, DARK: 0x10, FAIRY: 0x11,
    },
    // **Its alphabet is not Crystal's**, and the block that matters is the
    // punctuation: ♂ is $be and ♀ is $bf where Crystal has $ef and $f5, so
    // without this Nidoran♀ and Nidoran♂ both read "Nidoran?" -- two
    // identical species in the picker, which is the bug that put a
    // punctuation table in this app to begin with. The digits move too, and
    // that is what the placeholder in front of species one is written in:
    // `?000?` is `9e e0 e0 e0 9e`.
    //
    // The letter blocks are Crystal's and the terminator is measured off
    // `TypeNames`, so neither is here.
    alphabet: {
      upper: [0x80, 0x99], lower: [0xa0, 0xb9], digits: [0xe0, 0xe9],
      space: 0x7f,
      ligature: 0x4d,
      breaks: [0x55, 0x56, 0x57, 0x58, 0x59],
      punctuation: {
        0x9c: '.', 0x9d: ',', 0x9e: '?', 0x9f: '!',
        0xbc: '-', 0xbe: '\u2642', 0xbf: '\u2640', 0xc0: "'",
        0xc8: 'é', 0xd8: '&', 0xdb: '×', 0xdc: '/',
      },
    },
    // Twelve kinds of evolution against Crystal's five, and every record two
    // bytes for the species rather than one -- `dp IVYSAUR, PLAIN_FORM`,
    // since a species here can have forms. So the species is the
    // second-to-last byte and a plain level evolution is four bytes wide.
    // EVOLVE_HOLDING and EVOLVE_STAT carry an extra byte, and EVOLVE_PARTY's
    // own parameter is a `dp` too, which makes all three five.
    //
    // $ff, not $00: `end_evos_attacks` writes `db -1`. Read with Crystal's
    // terminator the first record's parameter ends the run, so Bulbasaur
    // evolved into nothing and learnt nothing.
    evo: {
      end: 0xff,
      intoBack: 2,
      sharedEnd: true,
      bytes: { 1: 4, 2: 4, 3: 4, 4: 5, 5: 4, 6: 5, 7: 4, 8: 4, 9: 4, 10: 5,
               11: 4 },
      kind: { level: 1, item: 2, trade: 3, holding: 4, happiness: 5, stat: 6,
              location: 7, move: 8, crit: 9, party: 10, egg: 11 },
      when: { anytime: 1, morningDay: 2, night: 3 },
      compare: { atkOverDef: 1, atkUnderDef: 2, atkEqualsDef: 3 },
      maxEvos: 8,
      maxLearn: 40,
    },
  },
  // No map names, no healers, no scripts: the same absences `generic` has,
  // and each one is a job the interface will not offer rather than one that
  // fails. Somebody who plays this cartridge can fill them in.
};

export class Polished extends Journey {
  constructor(gb, state, tasks, collision, nav, say, world) {
    super(gb, state, tasks, collision, nav, say, world, polished);
  }
}
