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
import { mapKey as key } from '../gen2/world.js';
import { Journey } from '../gen2/journey.js';

// Where a game begins, which is what `tools/route --reach` measures every
// other place from. Named the way `titles/crystal.js` names its own, so the
// tool finds it without being told which profile it is reading.
const NEW_BARK_TOWN = key(24, 2);
const PLAYERS_HOUSE_2F = key(24, 5);

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
    // **No takeable *sprites*, on purpose.** `takeables` finds an item ball
    // by its type byte, which is 1 here as it is on Crystal, and falls back
    // to a sprite list for things the map types as scripts -- Crystal's
    // fruit trees. This cartridge has one sprite, `SPRITE_BALL_CUT_TREE`
    // `$b4`, for a ball on the ground *and* a cuttable tree, and the three
    // starter balls in Elm's lab wear it as scripts. Listing it would offer
    // the pilot Professor Elm's starters as things to pick up. The cost is
    // that a fruit tree is not offered here; the alternative was worse.
    takeable: [],
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
    // **A coord event is five bytes here and eight on Crystal.** Crystal
    // pads: `db scene, y, x`, a filler byte, `dw script`, then two more
    // filler bytes. Polished writes the five bytes of content and stops.
    //
    // Nothing failed on the wrong stride, which is the whole reason this is
    // written down. `coordEventsOn` reported three triggers for New Bark
    // Town at scenes 0, 65 and 68 -- the map has seven, at scenes 1 and 3 --
    // and `objectsOn`, which steps past the triggers to reach the objects,
    // came back with an empty list for a town with five people on it. An
    // empty list is what a map with nobody on it looks like, so the pilot's
    // Center-finder simply never found a Center and the profile grew a
    // hand-written table of nineteen instead.
    //
    // The type byte is the other half. Crystal packs the palette into the
    // high nibble of byte seven -- `dn palette, type` -- so its type is the
    // low nibble. Polished gives the palette a byte of its own and writes
    // the type whole, and masking it would fold `OBJECTTYPE_SCRIPT_SILENT`
    // ($06) into a script and lose the distinction it exists to make.
    mapEvents: { ...gen2.mapEvents, coordBytes: 5, typeMask: 0xff },
    // Five more kinds than Crystal, and the one that matters is 3. Its
    // `script_constants.asm` reads SCRIPT, ITEMBALL, TRAINER,
    // GENERICTRAINER, POKEMON, COMMAND, SCRIPT_SILENT, DONOTHING -- so the
    // first three agree with Crystal, and a *generic* trainer is a fourth
    // kind nothing in Crystal has.
    //
    // **`trainer` is a list here, because 461 of this cartridge's 525
    // fightable objects are the second kind.** Only 64 are type 2. Held to
    // one number the Duel row counted an eighth of the trainers in the game
    // and offered to clear a map full of people it could not see -- and
    // every Gym but the leader is generic, so a swept Gym would have been a
    // Gym nobody fought.
    objectTypes: { script: 0, itemball: 1, trainer: [2, 3], pokemon: 4,
                   command: 5, scriptSilent: 6, doNothing: 7 },
    // Which object says *this room is a Pokemon Center* and which says
    // *this is a Mart*. Different sprites and, for the nurse, a different
    // tile.
    //
    // Measured the same way Crystal's were, over every map in the game:
    // count the maps carrying each sprite, keep the ones that land
    // overwhelmingly on maps the symbol file calls a Center or a Mart, and
    // take the tile most of them stand on. On Crystal the method returns
    // sprite 55 at (3,1) for 21 of 23 nurses and sprite 57 at (1,3) for 13
    // of 26 clerks -- which is exactly what `gen2/engine.js` has written
    // down, so the method reproduces somebody's hand before it is trusted
    // with a cartridge nobody has measured.
    //
    // Here it gives **sprite 151 at (5,1)** for 21 of 26, and **sprite 152
    // at (1,3)** for 13 of 46. The nurse's tile is the one the twenty-one
    // Centers in `healers` below already say by hand, found a different way
    // -- so the two agree.
    //
    // `reach` is Crystal's, and it is the one number here that is assumed:
    // a counter is a wall, so the clerk at (1,3) is spoken to from (3,3)
    // facing LEFT, two tiles away across a corner. Both cartridges put the
    // clerk on the same tile of what looks like the same room, and a wrong
    // `reach` walks the pilot to a tile it cannot talk from rather than
    // into a stranger's house.
    places: {
      center: { sprite: 151, at: [5, 1], nurse: [5, 1] },
      mart: { sprite: 152, at: [1, 3], reach: { dx: 2, dy: 0, face: 'LEFT' } },
    },
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
                 blockOf: { 0: 0, 1: 1, 2: 2, 3: [1, 2] },
                 // **Its wild levels scale with the badge case**, and
                 // nothing about the byte says so. A slot writes
                 // `LEVEL_FROM_BADGES + 1` or `- 3`, which assembles to 179
                 // or 175, and `AdjustLevelForBadges` subtracts 178, adds
                 // `wBadgeBaseLevel` and clamps to 2..99. 357 slots across
                 // 32 of its 151 grass entries are written this way --
                 // Route 47, Route 48, most of Kanto.
                 //
                 // Read literally that is a Lv179 Ditto, and the Hunt row
                 // would write off a patch of grass the pilot could clear.
                 // Found by walking the table with `tools/dex --wilds`,
                 // which was written to check the *stride* and found this
                 // instead: the stride was right and every level over 100
                 // was a sentinel.
                 levelFromBadges: 178 },
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
  // **Every Pokemon Center in the game, found by asking the cartridge.**
  // Not typed out: a map whose own symbol is `*PokeCenter1F` is a Center,
  // the town that reaches it is whichever map warps into it, the door is
  // that warp's tile, and the nurse is the object wearing `SPRITE_NURSE`.
  // All twenty-one keep her at (5,1) -- Crystal's is (3,1) -- and Violet's
  // door comes out (31,25), which is the tile `titles/crystal.js` has
  // written by hand, so the derivation agrees with somebody's eyes on the
  // one place both cartridges can be compared.
  //
  // **This list was written because the app could not find them, and it
  // can now.** `discover` recognises a Center by its nurse, and on this
  // cartridge it recognised none: the object reader was stepping past a
  // five-byte coord event by eight, so every map with a trigger tile on it
  // came back empty. With `places` above and the strides right, standing in
  // Violet City finds six Centers and four Marts, Violet's own doors among
  // them at (31,25) and (9,17).
  //
  // It stays because discovery is **bounded to three legs** and this is
  // not. `healerList` concatenates: the title's own first, then whatever is
  // near enough to see and not already here. Twenty-one Centers is what
  // makes `nearestHeal` able to answer from anywhere in the game rather
  // than from the corner of it the pilot is standing in.
  healers: [
    { map: key(1, 13), reach: 'healAtCenter',
      inside: key(1, 1), door: [13,17], nurse: [5,1] }, // Olivine
    { map: key(2, 7), reach: 'healAtCenter',
      inside: key(2, 3), door: [15,13], nurse: [5,1] }, // Mahogany
    { map: key(4, 2), reach: 'healAtCenter',
      inside: key(4, 5), door: [23,27], nurse: [5,1] }, // Ecruteak
    { map: key(5, 10), reach: 'healAtCenter',
      inside: key(5, 6), door: [21,29], nurse: [5,1] }, // Blackthorn
    { map: key(6, 12), reach: 'healAtCenter',
      inside: key(6, 1), door: [11,15], nurse: [5,1] }, // Cinnabar
    { map: key(7, 13), reach: 'healAtCenter',
      inside: key(7, 4), door: [19,15], nurse: [5,1] }, // Cerulean
    { map: key(8, 7), reach: 'healAtCenter',
      inside: key(8, 1), door: [15,9], nurse: [5,1] }, // Azalea
    { map: key(10, 3), reach: 'healAtCenter',
      inside: key(10, 8), door: [31,25], nurse: [5,1] }, // Violet
    { map: key(10, 1), reach: 'healAtCenter',
      inside: key(10, 11), door: [11,73], nurse: [5,1] }, // Route32
    { map: key(12, 3), reach: 'healAtCenter',
      inside: key(12, 5), door: [9,3], nurse: [5,1] }, // Vermilion
    { map: key(14, 2), reach: 'healAtCenter',
      inside: key(14, 3), door: [61,3], nurse: [5,1] }, // Route3
    { map: key(14, 4), reach: 'healAtCenter',
      inside: key(14, 8), door: [13,27], nurse: [5,1] }, // Pewter
    { map: key(17, 6), reach: 'healAtCenter',
      inside: key(17, 11), door: [19,27], nurse: [5,1] }, // Fuchsia
    { map: key(18, 5), reach: 'healAtCenter',
      inside: key(18, 6), door: [5,7], nurse: [5,1] }, // Lavender
    { map: key(19, 1), reach: 'healAtCenter',
      inside: key(19, 2), door: [23,13], nurse: [5,1] }, // SilverCave
    { map: key(21, 7), reach: 'healAtCenter',
      inside: key(21, 20), door: [33,9], nurse: [5,1] }, // Celadon
    { map: key(22, 2), reach: 'healAtCenter',
      inside: key(22, 5), door: [23,43], nurse: [5,1] }, // Cianwood
    { map: key(23, 2), reach: 'healAtCenter',
      inside: key(23, 9), door: [23,25], nurse: [5,1] }, // Viridian
    { map: key(26, 4), reach: 'healAtCenter',
      inside: key(26, 6), door: [29,3], nurse: [5,1] }, // Cherrygrove
  ],
  // Where to go looking for grass when there is none underfoot. Five early
  // Johto routes, the same fallback `titles/crystal.js` declares three of.
  //
  // **Declared rather than derived, and the reason is a road the graph can
  // walk and the game cannot.** Every map with a grass table is a correct
  // answer to "where is there grass", and asking the cartridge from New Bark
  // Town returns Route 27 at one leg and Route 26 at two -- the late-game
  // road to Kanto, which the map data joins to New Bark's eastern edge and a
  // guard closes for most of the story. A pilot sent there walks until
  // somebody turns it back.
  //
  // So this is the half of the answer that is about the *story*: the routes
  // an early game can actually stand on. Their keys and their contents came
  // out of the encounter table -- Route 29 has Rattata, Hoothoot and Hoppip
  // one leg out, Route 46 Geodude and Spearow at two -- and which of them to
  // walk to is `backToGrass`'s decision, nearest first.
  grassyMaps: [key(24, 1), key(5, 9), key(26, 1), key(26, 2), key(10, 1)],
  // **Every Mart with a counter in it, found the way the Centers were.**
  // A map whose own symbol is `*Mart`, the town that warps into it, that
  // warp's tile for the door, and a clerk wearing `SPRITE_MART_CLERK` at
  // (1,3) to say the room is one. Twelve of the thirteen; Saffron's is left
  // out because no map in the game warps into it that this reader can
  // follow, and a Mart with no door is a row that cannot be pressed.
  //
  // Cherrygrove's door comes out (23,3) and Violet's (9,17), which are the
  // two tiles `titles/crystal.js` measured by hand -- so the derivation
  // agrees with somebody's eyes on the two places both cartridges can be
  // compared, the same check the healers passed.
  //
  // `stand` and `face` rather than the clerk's tile, because a counter is a
  // *wall*: the clerk sits at (1,3) and the tile you can talk to it from is
  // (3,3) facing LEFT, two away across a corner. Crystal's geometry, and it
  // is the one thing here that is assumed rather than read -- a wrong
  // `stand` walks the pilot to a tile it cannot speak from, which is a
  // refusal rather than a wrong purchase.
  //
  // Declared as well as discovered for the reason the healers are:
  // `discover` sees three legs and `martList` concatenates, so this is what
  // lets the Shop row answer from anywhere in the game rather than from the
  // corner of it the pilot happens to be in.
  marts: [
    { map: key(8, 3), from: key(8, 7), door: [21, 5],
      stand: [3, 3], face: 'LEFT' }, // Azalea Town
    { map: key(5, 5), from: key(5, 10), door: [15, 29],
      stand: [3, 3], face: 'LEFT' }, // Blackthorn City
    { map: key(7, 6), from: key(7, 13), door: [25, 23],
      stand: [3, 3], face: 'LEFT' }, // Cerulean City
    { map: key(26, 5), from: key(26, 4), door: [23, 3],
      stand: [3, 3], face: 'LEFT' }, // Cherrygrove City
    { map: key(4, 8), from: key(4, 2), door: [29, 21],
      stand: [3, 3], face: 'LEFT' }, // Ecruteak City
    { map: key(17, 7), from: key(17, 6), door: [5, 13],
      stand: [3, 3], face: 'LEFT' }, // Fuchsia City
    { map: key(18, 10), from: key(18, 5), door: [1, 7],
      stand: [3, 3], face: 'LEFT' }, // Lavender Town
    { map: key(1, 7), from: key(1, 13), door: [21, 17],
      stand: [3, 3], face: 'LEFT' }, // Olivine City
    { map: key(14, 7), from: key(14, 4), door: [23, 21],
      stand: [3, 3], face: 'LEFT' }, // Pewter City
    { map: key(12, 8), from: key(12, 3), door: [21, 13],
      stand: [3, 3], face: 'LEFT' }, // Vermilion City
    { map: key(10, 4), from: key(10, 3), door: [9, 17],
      stand: [3, 3], face: 'LEFT' }, // Violet City
    { map: key(23, 8), from: key(23, 2), door: [29, 19],
      stand: [3, 3], face: 'LEFT' }, // Viridian City
  ],
  // **Every gym in Johto, and not one number of it typed out by hand.**
  //
  // `tools/rom-events --findgyms` reads all six fields per entry out of the
  // cartridge -- the town, the room, the door tile, the leader's tile, the
  // badge bit -- and it was run against Crystal first, where it reproduces
  // Falkner at (5,1) behind Violet's door at (18,17) and Bugsy at (5,7)
  // behind Azalea's at (10,15). Those are the two entries `titles/crystal.js`
  // measured by hand, one of them by walking into the room. A derivation that
  // returns somebody's eyes is a derivation worth pointing at a cartridge
  // nobody has walked.
  //
  // Every field is held to the ROM by `check-app gyms`: an object stands on
  // the leader's tile, its script pointer resolves to a symbol carrying the
  // leader's name, that object is a *script* rather than a trainer -- a
  // leader is talked to, so `clearHere` could never beat one -- and the badge
  // bit is a bit `EngineFlags` points at `wJohtoBadges` with.
  //
  // **Two things about this cartridge that Crystal's two entries could not
  // have shown.**
  //
  // Its badge order is not Crystal's. Crystal runs ZEPHYR, HIVE, PLAIN, FOG,
  // STORM, MINERAL, GLACIER, RISING; this one swaps the middle pair, so
  // Chuck's Storm Badge is bit 5 and Jasmine's Mineral is 4. Read out of the
  // cartridge's own `BadgeNames`, which it has because it names a badge as it
  // hands it over and Crystal never does. Backwards, the pilot would offer a
  // beaten gym for ever and read a win as a loss -- and no check could have
  // said so, because both numbers are badges.
  //
  // And Blackthorn's Gym has six ways in. Five are the holes its boulder
  // puzzle drops you through from the floor above; the sixth, at (18,11), is
  // the front door in Blackthorn City. The tool reports all six rather than
  // ranking them, and this is the one that is a door.
  //
  // No `opens:` on any of them, the same absence Crystal's carry: what a
  // badge unlocks is a script's business and this app has been wrong about it
  // before. See `gates`.
  gyms: [
    { map: key(10, 3), inside: key(10, 5), door: [18, 17],
      leader: 'FALKNER', leaderAt: [5, 2], badge: 0 },
    { map: key(8, 7), inside: key(8, 5), door: [10, 15],
      leader: 'BUGSY', leaderAt: [7, 3], badge: 1 },
    { map: key(11, 6), inside: key(11, 7), door: [28, 7],
      leader: 'WHITNEY', leaderAt: [8, 3], badge: 2 },
    { map: key(4, 2), inside: key(4, 9), door: [6, 27],
      leader: 'MORTY', leaderAt: [5, 1], badge: 3 },
    { map: key(1, 13), inside: key(1, 2), door: [10, 7],
      leader: 'JASMINE', leaderAt: [5, 3], badge: 4 },
    { map: key(22, 2), inside: key(22, 4), door: [8, 43],
      leader: 'CHUCK', leaderAt: [12, 11], badge: 5 },
    { map: key(2, 7), inside: key(2, 2), door: [6, 13],
      leader: 'PRYCE', leaderAt: [5, 3], badge: 6 },
    { map: key(5, 10), inside: key(5, 1), door: [18, 11],
      leader: 'CLAIR', leaderAt: [5, 3], badge: 7 },
  ],
  // No map names and no scripts: the same absences `generic` has,
  // and each one is a job the interface will not offer rather than one that
  // fails. Somebody who plays this cartridge can fill them in.
};

export class Polished extends Journey {
  constructor(gb, state, tasks, collision, nav, say, world) {
    super(gb, state, tasks, collision, nav, say, world, polished);
  }
}
