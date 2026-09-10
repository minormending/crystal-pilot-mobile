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
import { gen2 } from '../gen2/engine.js';
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
    // **Its trainer records say their own length.** `db _tr_size`, then the
    // name, then a flags byte, then the Pokemon -- and no `$ff` at the end,
    // because the size is the end. Each Pokemon is a level and a
    // `dp species, form`, plus a byte for each of item, EVs, DVs and
    // personality the flags claim, four for the moves, and a whole
    // terminated string for a nickname.
    trainer: {
      sized: true,
      monBase: 3,
      formSpeciesBit: 0x20,
      monFields: [[0, 1], [2, 1], [3, 1], [4, null], [1, 1], [5, 4]],
    },
    // 21 map objects of 14 bytes, and a spawned struct of 34 -- against
    // Crystal's 16 of 16 and 40. Measured on the running game: with the
    // player at (4,6) the struct 34 × 2 bytes in reads (5,6), which is the
    // girl standing beside them. At Crystal's stride nothing read at all,
    // so the walker could not see a person to walk around.
    mapObjects: { count: 21, bytes: 0x0e, sprite: 1, y: 2, x: 3, type: 8,
                  origin: 4 },
    objectStructs: { count: 13, bytes: 0x22, sprite: 0, placed: 1,
                     x: 0x10, y: 0x11 },
    // **A wall is 2 here, not `$0f`.** Its `WALL_TILE` is `%10` where
    // Crystal's is `$0f`, so the permission table was read perfectly and
    // compared against the wrong number -- every wall in the game came back
    // walkable, and a lab full of bookshelves read as open floor.
    permissions: { land: 0x00, water: 0x01, wall: 0x02 },
    // Its attributes block stops after the scripts: `db border, height,
    // width`, `dba BlockData, MapScriptHeader`, `db connections`. So the
    // connections mask is at 9 where Crystal keeps an events pointer, and
    // reading Crystal's offsets gave an indoor room an edge connection and
    // warps at coordinates outside the map.
    //
    // Its warps live *inside* the script header, behind a count of scene
    // scripts and a count of callbacks -- so where they begin depends on
    // the map. Two bytes a scene script, three a callback, and then the
    // warp count itself.
    mapAttr: { height: 1, width: 2, scriptsBank: 6, events: null,
               connections: 9, structs: 10,
               eventSkip: [2, 3], warpCount: 0, warps: 1 },
    // Seven bytes a map header, not nine, and no attributes bank in it:
    // `db tileset`, `dn sign, environment`, `dw attributes`, `db location,
    // music`, `dn phone, palette`. Read at Crystal's offsets its headers
    // gave addresses like $0401 and the map graph came out empty. The bank
    // is found by scoring rather than declared -- see `_attrBank` -- because
    // a number like "$26" is true of one release and nothing else.
    mapHeader: { bytes: 7, attrBank: null, attrAddr: 2, landmark: 4 },
    // Its `ItemNames` begins with an entry for the no-item slot, "Park
    // Ball", so POKE_BALL is index 1 rather than 0 -- and every item read
    // one early. Pikachu evolved with a Water Stone where its own record
    // says Thunderstone.
    itemBase: 1,
    // $ff moves, against Crystal's 251.
    moveCount: 255,
    // **Eight bytes an entry, not seven**: it adds a category byte --
    // physical, special or status, the split Gen 2 does by type. Read at
    // seven, every move past the first drifts, which is how COUNTER came
    // back with effect 10 and MIRROR COAT with a power of 213.
    moveBytes: 8,
    // The effects whose damage ignores the power byte, in this cartridge's
    // numbering: EFFECT_LEVEL_DAMAGE 26 (Seismic Toss, Night Shade),
    // EFFECT_SUPER_FANG 84, EFFECT_COUNTER 93 (Counter and Mirror Coat
    // both). Three rather than Crystal's six, because it has no one-hit-KO
    // moves and no Psywave at all -- so the pilot has fewer ways to end a
    // battle it meant to weaken, not more.
    lethalEffects: [26, 84, 93],
    // **Its day has four parts, and they are not in a table.**
    // `GetValueByTimeOfDay` compares the hour against `MORN_HOUR` 5,
    // `DAY_HOUR` 9, `EVE_HOUR` 17 and `NITE_HOUR` 21 -- `cp` operands in
    // the code, with nothing to read. The block *ids* are readable, at
    // `GetTimeOfDay.TimesOfDay`: `00 01 03 02`, so morning is 0, day 1,
    // evening 3 and night 2. Which is why the names below are in that
    // order and not the obvious one.
    //
    // Without this the app kept "wait for morning" and lost "skip to it",
    // which is the documented degradation for a cartridge with no table --
    // and this one has the hours, just not where a reader can reach them.
    timeNames: ['morning', 'day', 'night', 'evening'],
    hours: [2, 2, 2, 2, 2, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1,
            3, 3, 3, 3, 2, 2, 2],
    // Its grass entry is a two-byte map id and one encounter rate, then
    // seven slots of *three* bytes -- `db level` and `dp species, form` --
    // for each of three blocks. Crystal's is a five-byte header and
    // two-byte slots, and read at that stride this cartridge finds a
    // neighbouring map's block without failing.
    //
    // Three blocks against four times of day, and `GetTimeOfDayNotEve`
    // says how: **evening rolls the day's table 60% of the time and the
    // night's the other 40%**, so what is in the grass then is the union of
    // both and not either alone.
    encounter: { blocks: 3, slotsPerBlock: 7, headerBytes: 3, slotBytes: 3,
                 level: 0, species: 1,
                 blockOf: { 0: 0, 1: 1, 2: 2, 3: [1, 2] } },
    // **The one row its chart deliberately does not have.** Its source
    // comments out `db GROUND, FLYING, NO_EFFECT` with `; checks airborne
    // state instead`, because it decides airborne-ness at battle time from
    // Flying, Levitate and Telekinesis together. Read faithfully the chart
    // then prices a Ground move at neutral on a Flying Pokemon and the
    // pilot swings it for nothing.
    //
    // The type half is what can be said without being in the battle, and it
    // is the common case: a Flying-type is airborne. A Levitating
    // ground-type still reads neutral here and takes nothing, which is the
    // same class of thing as an ability this app has never modelled.
    damage: { ...gen2.damage, extra: [[0x04, 0x02, 0]] },
    // It writes 97 as its first check digit and calls 99
    // `SAVE_CHECK_VALUE_1_OLD` -- "before save version 7" -- so both are
    // its saves. With only Crystal's 99, a battery this cartridge had just
    // written read as "no save in it yet".
    saveCheck: [[97, 127], [99, 127]],
    // Each part of the caught data has a byte of its own here, where
    // Crystal packs all three into two: the time shares the first with the
    // ball (`CAUGHT_TIME_MASK %01100000`, a shift of five), the level has
    // the second and the location the third. Read Crystal's way, a starter
    // caught "Day at 5, New Bark Town" came back as level 1, morning,
    // Route 30 -- every byte present and every field misplaced.
    caughtData: {
      when: { at: 0, shift: 5, mask: 0x03 },
      level: { at: 1, shift: 0, mask: 0xff },
      place: { at: 2, shift: 0, mask: 0xff },
    },
    // **Its cursor is a different tile**, and that one is not cosmetic:
    // `_driveToSaying` gives up the instant a screen has no arrow, because
    // pressing DOWN in an overworld is a step into the grass. Crystal's is
    // `$ed`; this one draws `▶` at **`$f0`**, which Crystal uses for the
    // yen sign -- so every menu on this cartridge read as "not a menu" and
    // the pilot drove none of them. Found by booting it.
    charmap: {
      singles: { 0xea: '¥', 0xf1: '\u25b7', 0xf0: '>', 0xbd: ':' },
      cursor: 0xf0,
    },
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
    // Its stats are multiplied by a nature -- `NATURE_MASK %00011111` in
    // the personality byte -- so Gen 2's arithmetic cannot reproduce them
    // and `--check` would report a disagreement about a reading that is
    // right. Four of Cyndaquil's six come out exact even so; the two that
    // do not are the two a nature moves.
    statsAreGen2: false,
    // Six stat-experience counters and six DVs, one per stat, so nothing
    // is shared: Crystal spends one Special counter on two stats, and
    // mapping this cartridge that way left both special DVs reading null.
    statSource: { hp: 'hp', atk: 'atk', def: 'def', spd: 'spd',
                  satk: 'satk', sdef: 'sdef' },
    statExpNames: ['hp', 'atk', 'def', 'spd', 'satk', 'sdef'],
    dvNames: ['hp', 'atk', 'def', 'spd', 'satk', 'sdef'],
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
      // $5e is the one its *landmark* names use -- read off "New
      // Bark<break>Town", whose bytes are `8d a4 b6 7f 81 a0 b1 aa 5e 93
      // ae b6 ad 53`, so the break sits exactly where the sign wraps.
      // Without it half the towns had a question mark in the middle.
      breaks: [0x55, 0x56, 0x57, 0x58, 0x59, 0x5e],
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
