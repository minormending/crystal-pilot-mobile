// The numbers that describe the machine, in one place.
//
// Every value here is a fact about a Gen 2 cartridge's own data structures --
// how wide a party entry is, how many slots an encounter block has, which byte
// of a move is its power. They were spread across six modules as bare
// constants, each correct and each invisible from anywhere else, which is fine
// while there is one cartridge and useless the moment somebody asks "what would
// I have to change?"
//
// This is the answer to that question. A hack that only moved the maps needs
// none of it; a hack that added a move slot or an eleventh character to a name
// needs one field.
//
// WHAT IS NOT IN HERE, and deliberately. Two kinds of number look like these
// and are not:
//
//   *This app's patience.* MAX_SEND_TRIES, SAVE_ATTEMPTS, MENU_OPEN_TRIES,
//   PARTY_HOLD, MAX_STUCK_BATTLES -- how long the pilot keeps pressing before
//   it decides something is wrong. Those are decisions about this app, not
//   facts about the cartridge, and putting them here would invite a title to
//   "tune" them, which is how a stall becomes a config option instead of a bug.
//
//   *Structures a number cannot describe.* The collision value ranges, the
//   map-header strides in world.js, the character encoding. A cartridge that
//   changed those changed the shape of its data rather than a size in it, and
//   the honest answer is code -- a decoder that knows the new shape -- not a
//   field somebody sets to 11.
//
// Sources are the disassembly. Each line says where it comes from so the next
// person can check it against their own build rather than against this comment.

export const gen2 = {
  id: 'gen2',

  // --- the party -----------------------------------------------------------
  // wPartyMon1 to wPartyMon2 is 0x30 in Crystal; the offsets are box_struct's,
  // and `pp` is masked to six bits by the reader because PP Ups live in the
  // top two.
  //
  // Every offset here is the symbol file's own arithmetic rather than a number
  // off a wiki: `wPartyMon1` is $dcdf on this cartridge, so `wPartyMon1DVs` at
  // $dcf4 *is* 0x15, `wPartyMon1HPExp` at $dcea is 0x0b, `wPartyMon1Attack` at
  // $dd05 is 0x26. A build that moved the struct moves both ends together and
  // the subtraction still holds.
  partyStride: 0x30,
  mon: {
    species: 0x00, item: 0x01, moves: 0x02, exp: 0x08, statExp: 0x0b,
    dvs: 0x15, pp: 0x17, happiness: 0x1b, caught: 0x1d, level: 0x1f,
    status: 0x20, hp: 0x22, maxHp: 0x24, stats: 0x26,
  },
  // The cap the game enforces, and the reason a catch refuses a full party
  // rather than sending it to a box. The game boxes the seventh quite happily;
  // what this number decides is when the party stops *growing*, which is still
  // the thing every reader of it wants.
  maxParty: 6,

  // --- the three lists a stat is made of, and why they are three different
  // --- lengths ---------------------------------------------------------------
  // This asymmetry is Gen 2's, it is the thing that makes a stat screen hard to
  // read out of memory, and getting it wrong is silent in both directions:
  //
  //   `stats`      six numbers, the ones the game has already worked out and
  //                stored -- HP, attack, defence, speed, special attack,
  //                special defence. `maxHp` above is the first of them; the
  //                other five run from `mon.stats`.
  //   `statExp`    **five** counters, because Gen 2 keeps one shared Special
  //                stat experience and spends it on both special stats. A
  //                reader expecting six walks two bytes into the DVs.
  //   `dvNames`    **four** nibbles, because the HP DV is not stored at all --
  //                it is assembled from the low bit of each of the other four.
  //
  // Names rather than a count, because a reader that only knows "five" has to
  // decide for itself which five and in what order, and that decision is this
  // file's to make.
  statNames: ['hp', 'atk', 'def', 'spd', 'satk', 'sdef'],
  statExpNames: ['hp', 'atk', 'def', 'spd', 'spc'],
  dvNames: ['atk', 'def', 'spd', 'spc'],
  // Which counter and which nibble feed which stat, which is where the three
  // lists above meet. The only interesting row is the last two: **both special
  // stats are grown by one counter and rolled from one nibble**, so a screen
  // showing six independent pairs is showing two numbers twice and saying they
  // are different. That is a fact about the machine, not about the screen,
  // which is why it is here and not in the thing that draws it.
  statSource: { hp: 'hp', atk: 'atk', def: 'def', spd: 'spd',
                satk: 'spc', sdef: 'spc' },
  // A DV is a nibble, so fifteen is perfect and there is no separate maximum to
  // state. Stat experience is a sixteen-bit counter that the game caps at
  // 65535, and what reaches the stat is its square root -- so the *useful*
  // ceiling is 255 squared, which is 65025, and a counter above that is
  // indistinguishable from one at it.
  dvMax: 0x0f,
  statExpMax: 0xffff,
  statExpUseful: 255 * 255,

  // --- what is wrong with a Pokemon besides its HP ------------------------
  // The status byte at mon.status, from constants/pokemon_data_constants.asm.
  // Sleep is a *counter* in the low three bits rather than a flag, which is why
  // it is a mask and not a single bit: a Pokemon asleep for three more turns
  // reads 3, and asking `byte & 0x04` of that is false.
  //
  // Declared here since the engine profile was written and read by nothing for
  // ten passes. What that cost: poison ticks a Pokemon while you *walk*, so a
  // grind or a journey with a poisoned lead loses HP per step -- and the walk to
  // a Center could kill the thing it was going to heal, with the app reporting
  // only that the party was hurt.
  //
  // **The bit values here are from the disassembly, not from the cartridge**,
  // and that is worth saying plainly. What was measured is the *offset*: on a
  // Lv13 Cyndaquil at 35 of 37, byte 0x1f read 13, 0x22-0x23 read 35 and
  // 0x24-0x25 read 37 -- so 0x20 is bracketed by two fields already known to be
  // right, and it reads 0, which is what a well Pokemon should hold.
  //
  // No *non-zero* status has been seen. Getting one needs a wild Pokemon to
  // land a status move, and the only one on the routes this save can reach is
  // Weedle's Poison Sting -- which needs a Weedle to get a turn, which an
  // over-levelled lead never gives it. Sixty battles on Route 30 produced none.
  // So this is the same kind of gap as the remote-play picture: honest, written
  // down, and waiting on a situation rather than on more reading.
  statusBits: { slp: 0x07, psn: 0x08, brn: 0x10, frz: 0x20, par: 0x40 },

  // --- where it was caught, and at what level ------------------------------
  // wPartyMon1CaughtData, two bytes. The first packs the time of day into the
  // top two bits and the level it was caught at into the low six; the second
  // holds the landmark in its low seven, with the OT's gender in the top bit.
  //
  // **From the disassembly, not from a cartridge**, exactly like `statusBits`
  // above, and said plainly for the same reason. Nothing has been read off a
  // live party here -- so the reader treats a level outside 1..100 as "this
  // save does not say" rather than printing it, which is the behaviour a guess
  // has to earn. A save carried in from Gold or Silver genuinely holds zeroes
  // here, so "does not say" is a real state and not only a hedge.
  caughtData: { timeShift: 6, levelMask: 0x3f, placeMask: 0x7f },
  caughtTimes: [null, 'morning', 'day', 'night'],

  // --- species -------------------------------------------------------------
  // The highest id PokemonNames has an entry for. Reading past it reads
  // whatever table follows, so a hack that added species has to say so -- and
  // this is the field it is most likely to need.
  speciesCount: 251,
  // data/pokemon/base_stats/*.asm: the species id, then **six** stats -- hp,
  // attack, defence, speed, special attack, special defence -- then the two
  // types, then the catch rate and the rest. 32 bytes an entry.
  //
  // Counting five stats instead of six is silent, which is why the number is
  // here rather than in a reader: CHIKORITA came out as "type 65/GRASS",
  // where 65 is its special defence. A plausible type number, so it printed
  // rather than failed, and a Grass move on a Grass/Grass CATERPIE was
  // priced at a quarter. Measured back into place against three species
  // whose types nobody needs a table to know.
  baseBytes: 32,
  // And the first byte of an entry is the species' own id, which makes the
  // table self-identifying -- a check worth having because there is no
  // terminator to run off the end of. A symbol file pointing somewhere else
  // reads zeroes, and `[0, 0]` is NORMAL/NORMAL: a real type pair, and a
  // wrong answer that looks like an answer. Verified over all 251 entries on
  // this cartridge; every one carries its own id.
  // `stats` is the six in front of the types, `growth` is which experience
  // curve the species is on, and the rest are read because a dex entry is the
  // one screen that wants them.
  //
  // **`growth` is 0x16, not 0x15**, and that distinction was measured rather
  // than trusted: at 0x15 every one of the 251 entries came back MEDIUM_FAST,
  // which is a real growth rate and a plausible answer for the handful of
  // species anybody checks first. At 0x16 BULBASAUR and CYNDAQUIL read
  // MEDIUM_SLOW, MAGIKARP reads SLOW and PIKACHU reads MEDIUM_FAST, which is
  // the cartridge's own answer and not the same one for everybody. The same
  // failure as the five-stats-instead-of-six above, one field along.
  baseField: { id: 0, stats: 1, types: 7, catchRate: 9, baseExp: 10,
               gender: 13, hatch: 15, growth: 0x16 },
  // data/growth_rates.asm, in the order `GrowthRates` has them. Keys rather
  // than prose for the same reason `takeable` uses them: what to call a curve
  // on screen is the interface's business.
  growthRates: ['mediumFast', 'slightlyFast', 'slightlySlow', 'mediumSlow',
                'fast', 'slow'],

  // --- what a species turns into, and what it learns on the way ------------
  // data/pokemon/evos_attacks.asm, reached through `EvosAttacksPointers`: a
  // `dw` per species into the same bank, then for that species a run of
  // evolution records ended by a zero, then (level, move) pairs ended by a
  // zero.
  //
  // Verified against the cartridge rather than assumed: entry 155 resolves to
  // exactly the address the symbol file gives `CyndaquilEvosAttacks`, and 16
  // to `PidgeyEvosAttacks`. That is the one thing a pointer table can be wrong
  // about, and the symbol file can settle it.
  //
  // **The five kinds of record are not all the same width.** EVOLVE_STAT is
  // four bytes -- it carries a level *and* a comparison -- and the other four
  // are three. This is the `trainerMonBytes` situation again, and it fails the
  // same silent way: TYROGUE is the only species in the game with a STAT
  // record, it has three of them, and reading them at three bytes turns its
  // learnset into whatever the shifted bytes happen to say.
  //
  // The species evolved into is the record's **last** byte on this cartridge,
  // whichever kind it is, so no per-kind field table is needed -- only the
  // width and how far back from the end the species sits. Polished Crystal
  // writes `dp species, form`, two bytes, so there it is one further back.
  evo: {
    end: 0,
    intoBack: 1,
    // Whether one terminator can end a species' move list *and* mark the
    // next species as having no evolutions. Crystal writes both bytes
    // separately, so every record carries its own two. Polished Crystal's
    // `learnset` macro emits one and says so -- "end of evolutions and, if
    // there were no evos, previous mon's moves". It changes nothing for the
    // reader, which stops at the byte either way, and it changes the *length*
    // of a record, which is what `tools/dex --verify` measures.
    sharedEnd: false,
    bytes: { 1: 3, 2: 3, 3: 3, 4: 3, 5: 4 },
    kind: { level: 1, item: 2, trade: 3, happiness: 4, stat: 5 },
    // EVOLVE_HAPPINESS's parameter and EVOLVE_STAT's second one, from
    // constants/pokemon_data_constants.asm. Named numbers, not sentences.
    when: { anytime: 1, morningDay: 2, night: 3 },
    compare: { atkOverDef: 1, atkUnderDef: 2, atkEqualsDef: 3 },
    // A bound on a run, not a size: a species with a garbage pointer must stop
    // rather than read the bank. The longest real learnset in Crystal is under
    // twenty moves and the longest evolution run is TYROGUE's three.
    maxEvos: 8,
    maxLearn: 40,
  },
  // `TypeNames` is a `dw` per type id in the same order as the type constants,
  // so the id *is* the index. Named here because the pointer stride is the one
  // thing about it a hack could change, and because a dex entry that says
  // "type 20" has not answered the question.
  // --- the cartridge's alphabet --------------------------------------------
  // Everything about decoding a name that is not "A is $80". Crystal's blocks
  // are here, and a cartridge that moved them says so rather than reading
  // every name with a question mark in it.
  //
  // **This is not cosmetic.** NIDORAN-female and NIDORAN-male differ by one
  // byte and nothing else, so a charmap that cannot tell $ef from $f5 draws
  // two identical species and hunting for one of them stops at the other --
  // which is the bug that put `punctuation` in this app in the first place.
  // Polished Crystal moves the whole block: its ♂ is $be and its ♀ is $bf.
  alphabet: {
    upper: [0x80, 0x99], lower: [0xa0, 0xb9], digits: [0xf6, 0xff],
    space: 0x7f,
    // One byte, four letters: the game expands it to POKé when it prints.
    ligature: 0x54,
    // A line break inside a *name* is a space -- a landmark name is written
    // to fit a two-line sign. $1f is the one landmark names use; $4e and $4f
    // are the ones ordinary text uses.
    breaks: [0x1f, 0x4e, 0x4f],
    // Measured out of the cartridge rather than copied hopefully: 0xe0 in
    // FARFETCH'D and KING'S ROCK, 0xe3 in HO-OH, 0xe8 in MR.MIME, GUARD
    // SPEC., EXP.SHARE and S.S.TICKET, 0xef and 0xf5 in the two NIDORAN.
    punctuation: {
      0xe0: "'", 0xe3: '-', 0xe6: '?', 0xe7: '!', 0xe8: '.',
      0xe9: '&', 0xea: 'é', 0xef: '\u2642', 0xf1: '×', 0xf3: '/',
      0xf4: ',', 0xf5: '\u2640',
    },
  },
  // --- the words on the game's own menus -----------------------------------
  // What a row *says*, which is how the pilot finds it: the cursor is walked
  // until the selected line reads one of these. Lists rather than words,
  // because a cartridge may call the same row something else and there is
  // no third thing to do about it -- Polished Crystal's start menu reads
  // Bag, Save, Options, Quit, so a pilot looking for PACK walked its whole
  // menu and gave up.
  //
  // Order is preference, and Crystal's word is first everywhere. Matching
  // folds case, so a word is here only when it is a different *word*.
  menuWords: {
    party: ['POKéMON'],
    pack: ['PACK'],
    save: ['SAVE'],
    switch: ['SWITCH'],
  },
  typeNameMax: 12,
  // How an entry of `TypeNames` points at its name, in order of preference.
  // Crystal writes `dw`: two bytes, an address in the table's own bank.
  // Polished Crystal writes `dr`, which assembles as `db X - @` -- one byte,
  // an offset from the entry's *own* address, so the table is a third the
  // size and every entry has a different origin. Which one a cartridge uses
  // is derived rather than declared; see `_typeNameKind`.
  typeNamePointers: ['dw', 'dr'],

  // --- names ---------------------------------------------------------------
  // PokemonNames is fixed-width; ItemNames is packed with a terminator between
  // entries, which is why one is read at a stride and the other is scanned.
  nameLength: 10,

  // --- moves ---------------------------------------------------------------
  // data/moves/moves.asm: animation, effect, power, type, accuracy, pp, chance.
  moveBytes: 7,
  moveField: { effect: 1, power: 2, type: 3, pp: 5 },
  moveCount: 251,
  // Which *index* of `ItemNames` holds item 1. Zero on Crystal, whose table
  // begins with MASTER BALL. Polished Crystal's begins with an entry for the
  // no-item slot -- "Park Ball" -- so its POKE_BALL is index 1, and reading
  // at index 0 made every item on that cartridge the one before it: Pikachu
  // evolved with a WATER STONE where its record says THUNDERSTONE.
  //
  // **Declared, where the species table's is derived.** A placeholder there
  // is `?000?`, which does not start with a letter and gives the reader
  // something to see; a placeholder here is a plausible item name and gives
  // it nothing. The move table is not shifted on either cartridge, which is
  // why this is one number and not three.
  itemBase: 0,
  // Effects whose damage has nothing to do with the power byte, so ranking by
  // power to find something gentle picks exactly the moves that end a battle:
  //   38 OHKO, 40 SUPER_FANG, 87 LEVEL_DAMAGE, 88 PSYWAVE, 89 COUNTER,
  //  144 MIRROR_COAT. A hack that renumbered its effect table needs this list.
  lethalEffects: [38, 40, 87, 88, 89, 144],

  // --- how hard a move lands ------------------------------------------------
  // data/types/type_matchups.asm: `db attacker, defender, multiplier`, run
  // together until $ff ends the table. The multiplier is in tenths, and only
  // the pairs that are *not* ten are written down -- so a pair the table does
  // not mention is neutral, which is why reading it means scanning for a pair
  // rather than indexing at an offset.
  //
  // Measured on the cartridge rather than copied: 110 triples at
  // TypeMatchups, carrying exactly three multipliers -- 0 (immune, 7 pairs),
  // 5 (half, 57) and 20 (double, 46). $fe is a *one-byte* separator, not a
  // triple of its own, and the two entries past it are the pair Foresight
  // cancels: NORMAL and FIGHTING against GHOST. Reading $fe as a triple eats
  // the first of those and shifts the rest by two.
  //
  // `stab` is the same-type bonus: Gen 2 scales damage by 15/10 when the move
  // shares a type with the Pokemon using it.
  // The type numbers themselves. **The chart is indexed by these and a rule
  // about Pokemon has to be written in them**, because the *names* come out of
  // the cartridge and are one translation away from changing: on a Dutch build
  // FIRE reads VUUR and ELECTRIC reads ELEKTRO, and a checker that looked its
  // rules up by name resolved every one of them to nothing and reported thirty
  // correct matchups as wrong.
  //
  // 0x06 BIRD and 0x13 CURSE are here for completeness and are used by
  // nothing: Gen 2 leaves 0x0a-0x13 between the physical types and the special
  // ones, and BIRD is unused. Naming them is what stops the gap looking like a
  // mistake in this list.
  typeIds: {
    NORMAL: 0x00, FIGHTING: 0x01, FLYING: 0x02, POISON: 0x03, GROUND: 0x04,
    ROCK: 0x05, BIRD: 0x06, BUG: 0x07, GHOST: 0x08, STEEL: 0x09,
    CURSE: 0x13, FIRE: 0x14, WATER: 0x15, GRASS: 0x16, ELECTRIC: 0x17,
    PSYCHIC: 0x18, ICE: 0x19, DRAGON: 0x1a, DARK: 0x1b,
  },
  damage: {
    matchupBytes: 3, neutral: 10, chartEnd: 0xff, chartForesight: 0xfe,
    chartScan: 256, stab: 1.5,
  },

  // --- what a trainer is carrying ------------------------------------------
  // data/trainers/parties.asm, reached through `TrainerGroups`: a `dw` per
  // trainer class, then for each trainer in it a terminated name, a **type**
  // byte, that many Pokemon, and $ff.
  //
  // The type byte says how wide a Pokemon is, and it is the only part of this
  // that cannot be guessed from the bytes: level and species, then optionally
  // an item and optionally four moves. Falkner reads type 1 -- so six bytes a
  // Pokemon -- and comes out PIDGEY Lv7 with TACKLE and MUD-SLAP, PIDGEOTTO
  // Lv9 with TACKLE, MUD-SLAP and GUST, which is exactly what he has.
  //
  // **The class count is derived rather than written down**, because the
  // pointer table ends where its own first pointer lands: 67 classes on this
  // cartridge, and a hack that added one does not need this file changed.
  trainerMonBytes: { 0: 2, 1: 6, 2: 3, 3: 7 },
  // How wide one entry of `TrainerGroups` is -- and this is a *list of the
  // widths that exist*, not a declaration, because which one a cartridge uses
  // is derived from the table itself the same way its length is.
  //
  // Two is a `dw` table, which is what Crystal has. Three is `dba`: a bank
  // byte and then the address, which is what a hack writes when its trainer
  // data outgrew one bank -- pokecrystal16 does exactly this. Measured on
  // both: at `TrainerGroups` vanilla reads `1f 5a 35 5a ...` and
  // pokecrystal16 reads `0e d4 59 0e ea 59 ...`, so the bank comes first and
  // the address after it, little-endian.
  //
  // The derivation is decisive rather than a guess, which is why it is a
  // derivation: read the first entry at each width and only one of them lands
  // inside the same bank window as the table with a gap divisible by itself.
  // Both cartridges then agree the table holds **67 classes**, which is the
  // cross-check -- pokecrystal16 did not add trainer classes, it widened the
  // pointers to them.
  trainerPointerBytes: [2, 3],
  trainerEnd: 0xff,
  // A bound on a terminated name, not a size. "COOLTRAINER♀" is the longest
  // class name; a trainer's own name is shorter still.
  trainerNameMax: 14,

  // --- wild encounters -----------------------------------------------------
  // A grass entry is: map group, map number, three rates, then three blocks of
  // seven (level, species) -- morning, day, night.
  encounter: { blocks: 3, slotsPerBlock: 7, headerBytes: 5 },
  // --- a map's header, in `MapGroupPointers` ------------------------------
  // Crystal writes nine bytes and puts the attributes' **bank** in front:
  // `db BANK(attributes), tileset, environment` then `dw attributes`.
  // Polished Crystal writes seven and no bank at all -- `db tileset`,
  // `dn sign, environment`, `dw attributes` -- because every one of its
  // attribute blocks is in one bank. Read at Crystal's offsets its headers
  // gave addresses like $0401, which is not in a banked window, and the map
  // graph came out empty.
  //
  // `attrBank: null` means the bank is not in the header and has to be
  // found; see `_attrBank` in world.js, which scores every bank in the ROM
  // against every map and takes the one that works.
  mapHeader: { bytes: 9, attrBank: 0, attrAddr: 3, landmark: 5 },
  // What those three blocks are called, in the order `wTimeOfDay` numbers
  // them. Keys rather than prose, the same bargain `growthRates` makes: what
  // to call "after dark" on a screen is the interface's business and `rows.js`
  // has those words; this is what a log line and a job message say.
  //
  // It is the same three the encounter table is indexed by, and saying so
  // here rather than leaving it implicit is the point -- a cartridge with four
  // blocks changes both numbers or neither, and `tools/check-app` holds them
  // to each other.
  timeNames: ['morning', 'day', 'night'],
  // data/times.asm, reached through `TimesOfDay`: pairs of *up to this hour*
  // and *this block*, walked until one is greater than the hour, ended by $ff.
  // Two bytes a pair, and a bound rather than a count -- the table is five
  // pairs on this cartridge and a hack could write more.
  timeTable: { bytes: 2, end: 0xff, scan: 16 },
  // Hours in a day. Here because the clock arithmetic below wraps on it and a
  // bare 24 in three places is the shape that drifts.
  hoursInDay: 24,
  // Frames the game counts its own time at. Not the emulator's speed -- the
  // *game's*, which advances one frame per frame however fast those frames are
  // produced, and that is the whole reason an hour of game time can go by in
  // seconds of yours. 216,000 frames an hour, on any machine.
  gameFps: 60,
  // --- the in-game clock, which is not the hardware clock --------------------
  // Read out of the cartridge rather than assumed, because it decides whether
  // the time of day can be moved at all -- and the app had it backwards in
  // prose for four versions.
  //
  // `FixTime` at 00:061d **adds**: it takes the RTC's seconds, minutes, hours
  // and day-low, adds `wStartSecond`/`Minute`/`Hour`/`Day` with the carry
  // chained upward, and writes `hSeconds`/`hMinutes`/`hHours`/`wCurDay`. So the
  // in-game hour is `(wStartHour + rtcHours) mod 24`, and **the four `wStart`
  // bytes are an offset the game applies to the hardware clock** -- which is
  // how Gen 2 lets you set the time without touching an RTC it cannot write.
  //
  // Getting the direction wrong sends the clock the wrong way, and the label
  // names are what nearly did: `DSTChecks.SetClockForward` at 05:64b9
  // *increments* `wStartHour`, which is only "forward" because the offset is
  // added. That routine is also the arithmetic to copy rather than invent --
  // hour up one, and the carry into `wStartDay`:
  //
  //     a = hour + 1; a -= 24; if no borrow keep it else a += 24   ; wrap
  //     ld [wStartHour], a ; ccf ; a = day ; adc 0 ; ld [wStartDay], a
  //
  // All four bytes are inside the saved block, so the offset is editable in a
  // `.sav` -- see `tools/clock`.
  clock: { startDay: 'wStartDay', startHour: 'wStartHour',
           startMinute: 'wStartMinute', startSecond: 'wStartSecond' },

  // --- things on the map you can take something from -----------------------
  // Map objects carry a sprite id in wMapObjects, and two of those sprites are
  // not people. Both measured on the cartridge rather than copied out of
  // constants/sprite_constants.asm, because the point of reading them is that a
  // hack may have moved them:
  //
  //   84  an item ball. Route 31's ball, the one the errand fetches, carries it
  //       in the ROM's object_events at exactly its known tile (19,15); and on
  //       Route 30 the object at (8,35) with this sprite gave an ANTIDOTE.
  //   93  a fruit tree. Route 30's two, at (5,39) and (11,5), gave a BERRY and
  //       a PSNCUREBERRY.
  //
  // Kept apart because they are approached the same way and read differently: a
  // ball is gone once taken, a tree comes back.
  takeable: [
    { sprite: 84, what: 'ball' },
    { sprite: 93, what: 'tree' },
  ],

  // --- what the game itself says an object *is* ----------------------------
  // One byte in a wMapObjects entry carries two things, and the cartridge's own
  // symbol file is what settles it: `wMap1ObjectPalette` and `wMap1ObjectType`
  // are *the same address*, colour in the high nibble and the type in the low.
  // So this is the game's own answer to a question the sprite table above can
  // only guess at -- a hack that moves the item-ball sprite still tags its
  // balls as balls, because the engine branches on this byte to decide what
  // pressing A does.
  //
  // Measured on Route 30, whose objects are one of each: the item ball at
  // (8,35) reads 1, the three trainers read 2, and the fruit trees, townsfolk
  // and the two Rattata read 0.
  //
  // `script` is here to be named rather than to be used: nothing branches on
  // it, and leaving it out would make 0 look like an absence.
  objectTypes: { script: 0, itemball: 1, trainer: 2 },

  // --- how to recognise a place through a door -----------------------------
  // The two rooms the pilot has business in, and the one object each that says
  // which is which. Measured across the whole ROM rather than on the two the
  // app already knew: of twenty-three maps carrying the nurse sprite,
  // **twenty-one have her at (3,1)**; of twenty-six carrying a clerk,
  // **thirteen have him at (1,3)**, and the other thirteen are department-store
  // floors and kiosks, which this rule does not claim.
  //
  // So the signature is a sprite *and* a tile, and it is deliberately narrow: a
  // wrong match walks the pilot into a stranger's front room, and a missed one
  // costs nothing but the town the title already named.
  //
  // `nurse` and `clerk` are the same tiles, said twice, because they are two
  // facts: where the object stands, and where the pilot must stand to speak to
  // it. A counter is a *wall* -- measured in Cherrygrove, the clerk sits at
  // (1,3) and the only tile you can talk to him from is (3,3) facing LEFT, two
  // away across a corner -- so `reach` says how to turn the one into the other.
  places: {
    center: { sprite: 55, at: [3, 1], nurse: [3, 1] },
    mart: { sprite: 57, at: [1, 3], reach: { dx: 2, dy: 0, face: 'LEFT' } },
  },

  // --- the letters on the screen -------------------------------------------
  // Gen 2 draws text as tiles, so `wTilemap` holds the words a person is
  // reading. Every entry below was measured off the cartridge rather than
  // copied out of `charmap.asm`, by dumping the raw tilemap beside the picture
  // and reading them against each other:
  //
  //   $80-$99  A-Z     "WITHDRAW ITEM" on the bedroom PC
  //   $a0-$b9  a-z     "What do you want to do?" under it
  //   $f6-$ff  0-9     "21/ 21" and "Lv6" on the party screen
  //   $7f      space   the blank inside every box
  //   $f3      /       between the two halves of an HP reading
  //   $e6      ?       the end of that same question
  //   $ed      the cursor arrow, at rows 2,4,6,8,10 as the cursor read 1..5
  //   $6d      :       between the two halves of the save panel's "0:03"
  //   $d4      's      "What's the hurry?" from the man at the top of Route 32
  //
  // **$d4 is one tile for two characters.** Gen 2 has no apostrophe key in
  // running text: it has a ligature tile per contraction. Dumped from the
  // gate script's second line, `96 a7 a0 b3 d4 7f b3 a7 a4` is
  // `W h a t 's _ t h e` -- so the tile carries both characters and the
  // decoder has to emit both.
  //
  // Its neighbours in $d0-$d6 are the other contractions and are deliberately
  // *not* here: one of them is measured and the rest would be copied off a
  // table without a screen to check them against. An unnamed tile reads as a
  // space, so "don't" comes out "don t" -- clumsy, and readable, which is the
  // right way round for a guess nobody has checked.
  //
  // **The arrow is a tile in a list menu and a sprite in a YES/NO box.** The
  // save confirmation was dumped with its panel up, "Would you like to save?"
  // plainly readable, and not one $ed anywhere in the tilemap -- the same thing
  // `sendOut` found about the party screen years of passes ago. So a list can
  // be driven by following the arrow and a question cannot; a question is
  // recognised by its words and answered through `wMenuCursorY`, which it does
  // keep.
  //
  // The box border is $79-$7e and is left unnamed on purpose: it maps to
  // spaces like every other graphic, and naming it would put punctuation in the
  // middle of a line that has none.
  //
  // Here rather than in a title profile because it is an *encoding*, the same
  // kind of thing as `moneyBytes`: a pokecrystal hack keeps this charmap, and a
  // translation is exactly the case where a title would want to replace it.
  charmap: {
    ranges: [[0x80, 0x99, 'A'], [0xa0, 0xb9, 'a'], [0xf6, 0xff, '0']],
    singles: { 0x7f: ' ', 0xf3: '/', 0xe6: '?', 0xe8: '.', 0xf4: ',',
               0xe7: '!', 0xf0: '¥', 0xf1: 'x', 0xed: '>', 0x6d: ':',
               0xd4: '\u2019s' },
    // The arrow is named twice on purpose: once above so a dumped screen shows
    // which row is selected, and once here so `arrowAt` can find the tile
    // without knowing what character it was rendered as.
    cursor: 0xed,
  },

  // How many bytes of badge flags there are. Two in Gen 2 -- `wJohtoBadges` at
  // $d857 and `wKantoBadges` right after it -- one bit per badge, and the count
  // is all this app wants: a badge is the thing that opens a route somebody has
  // been turned back from, so *how many* is exactly the question, and *which*
  // one opens *which* route is content no cartridge writes down.
  badgeBytes: 2,

  // --- what the overworld rolls an encounter on ----------------------------
  // COLL_LONG_GRASS $14, COLL_TALL_GRASS $18, and the two unused mirrors the
  // engine still treats as grass.
  grassTiles: [0x10, 0x14, 0x18, 0x1c],

  // --- battles -------------------------------------------------------------
  // wBattleMode: 0 none, 1 wild, 2 trainer.
  trainerBattle: 2,
  // wBattleMenuCursorPosition, and which menu is *drawn*: measured, the battle
  // menu is 34 items with its box at row 12, the pack is 5 items at row 1, and
  // the pack mid-throw is 2 at row 0. The cursor alone cannot tell them apart.
  // 1 FIGHT, 2 PKMN, 3 PACK, 4 RUN, in the 2x2 the cursor walks. `pkmn` was
  // the one nobody needed until the pilot could tell that the thing on the
  // field cannot touch what it is facing -- before that, the answer to a
  // hopeless matchup was a sentence, so there was nothing to press.
  battleAction: { fight: 1, pkmn: 2, pack: 3, run: 4 },
  // 34 items with the border at row 12, and the box's **left** column at 8.
  //
  // The left column is here because `tools/rom-events --menus` found that
  // three battle menus share the first two numbers exactly:
  // `BattleMenuHeader`, `ContestBattleMenuHeader` and
  // `SafariBattleMenuHeader` all read 34 at row 12. They differ only in where
  // the box starts -- 8, 2 and 0 -- so a signature of two numbers cannot tell
  // the pilot's own battle menu from the Bug-Catching Contest's, where item 3
  // is not the PACK but a PARK BALL.
  battleMenu: { items: 34, top: 12, left: 8 },
  // The battle menus that are *not* ours, by the one number that tells them
  // apart. Only the Contest is reachable on this cartridge -- Gen 2's Safari
  // Zone is closed -- and its column is **unique across all 73 named menu
  // headers in the ROM**, which is what makes acting on it safe: the only way
  // to read a 2 here is to actually be in one.
  otherBattles: [{ left: 2, what: 'the Bug-Catching Contest' }],
  // "<MON> wants to learn <MOVE>. But it already knows four moves. Delete an
  // older move to make room?" -- a two-item YES/NO box, and YES is where the
  // cursor starts. Measured by grinding a Chikorita from Lv5 on Route 29 and
  // watching every snapshot the battle loop took: at the instant its moveset
  // went from [TACKLE, GROWL, RAZOR LEAF, REFLECT] to [POISONPOWDER, GROWL,
  // RAZOR LEAF, REFLECT] the box read items=2, top=7, cursor (1,1). The pack
  // mid-throw is also two items but sits at row 0, and the battle menu is
  // thirty-four at row 12, so the row is what tells them apart.
  learnMove: { items: 2, top: 7 },

  // The box that comes up when a Pokemon is picked in a battle's party
  // screen: SWITCH, STATS, CANCEL.
  //
  // **Read out of the cartridge's own menu header rather than measured on a
  // screen**, because the two are different orders and guessing costs the
  // wrong screen. `MonMenuOptionStrings`, which the *field* party menu uses,
  // begins STATS, SWITCH -- so a press of A on a Pokemon out in the world
  // opens its stats, and the same press in a battle switches it in. Assume
  // the order you have seen more often and the pilot pages through a stats
  // screen while a trainer takes its turn.
  //
  // `BattleMonMenu.MenuHeader` at 09:4ed4 is `flags, y1, x1, y2, x2` then a
  // pointer to `flags, count` then the strings: a box at rows 11-17, columns
  // 11-19, three items, and the strings behind it read SWITCH, STATS,
  // CANCEL. That layout is not assumed either -- read the same way,
  // `BattleMenuHeader` comes out **34 items at row 12**, which is what
  // `battleMenu` above says after being measured on a real cartridge. A
  // derivation that reproduces a measurement is worth more than either.
  //
  // `tools/rom-events --menus` holds all of this to the cartridge.
  switchBox: { items: 3, top: 11, choose: 1 },
  ballPocket: 1,
  itemPocket: 0,

  // --- the pack, from inside a battle -------------------------------------
  // Measured on a Cyndaquil at 9 of 21, mid-encounter: PACK draws the same 5/1
  // box the field pack does, selecting an item draws USE/QUIT, and confirming
  // draws the box the result is written over.
  //
  // `use` is *the same shape as `learnMove`* -- two items at row 7 -- and that
  // is written down rather than deduplicated, because they are two different
  // questions that a snapshot cannot tell apart. Only the context can: the
  // learn-move box appears while a turn is resolving, and this one only while
  // the pack is being driven. Any code that could be in both states at once
  // would answer the wrong one, so `useItemInBattle` finishes before the turn
  // loop resumes.
  battlePack: {
    use: { items: 2, top: 7 },
    applied: { items: 2, top: 0 },
  },

  // --- the three boxes between the START menu and a healed Pokemon ---------
  // Measured on the cartridge, in the order they appear. Every one of them is a
  // box signature rather than a press count, for the reason `learnMove` gives:
  // the cursor keeps its previous value, so the *shape* of the box is what says
  // which box it is.
  //
  //   pack        the pack itself, five items at row 1 -- the same box the
  //               battle pack draws, which is why `throwBall` already knew it
  //   itemUse     USE / GIVE / TOSS / QUIT, four items at row 3, USE on row 1
  //   partyPick   which Pokemon, four items at row 0, the lead on row 1
  //
  // `itemUse` and `partyPick` both measure four items and are told apart by the
  // row, exactly as the pack mid-throw is told from the battle menu.
  field: {
    pack: { items: 5, top: 1 },
    itemUse: { items: 4, top: 3 },
    partyPick: { items: 4, top: 0 },
  },

  // --- money, and the counter it is spent at -------------------------------
  // wMoney is **three bytes, big-endian, plain binary** -- measured on a new
  // game: [0x00, 0x0b, 0xb8] is 3000, which is exactly what Crystal starts you
  // with. Worth stating because the bytes next door are not: `wMartItem1BCD`
  // and its siblings hold the *prices* as BCD, so a reader that inferred one
  // encoding from the other would be wrong in the direction that looks
  // plausible.
  moneyBytes: 3,

  // The five boxes between the clerk and a bought item, in the order they
  // appear. Measured in Cherrygrove's Mart, buying two POTIONs at 300 each and
  // watching the money fall 3000 -> 2700 -> 2400:
  //
  //   menu     BUY / SELL / QUIT, three items at row 0, BUY on row 1
  //   list     what the mart stocks, four items at row 3; wCurItem says which
  //   howMany  the quantity box, four items at row 15
  //   confirm  "that'll be N. OK?", two items at row 7, YES on row 1
  //   done     the thanks, two items at row 0; A returns to the list
  //
  // `confirm` is the *third* box in this app measuring two items at row 7 --
  // `learnMove` and `battlePack.use` are the others -- and `done` is the same
  // shape as `battlePack.applied`. Three boxes sharing a signature is fine and
  // only because the contexts cannot overlap: a shop box exists only while the
  // shop is being driven, which is a claim the code has to keep rather than a
  // property it gets.
  shop: {
    menu: { items: 3, top: 0 },
    list: { items: 4, top: 3 },
    howMany: { items: 4, top: 15 },
    confirm: { items: 2, top: 7 },
    done: { items: 2, top: 0 },
  },

  // --- the intro's NAME menu ----------------------------------------------
  // ChrisNameMenuHeader: five items drawn in the top-left ten columns, matched
  // on shape because the cursor still holds whatever the gender prompt left in
  // it. Cursor 1 is NEW NAME; 2 and below are the names the game ships.
  nameMenu: { items: 5, right: 10, firstPreset: 2 },

  // --- the battery ---------------------------------------------------------
  // Crystal validates a save by two magic bytes. Counting non-zero bytes does
  // not work: a battery that has never been saved to still reads five.
  sram: { start: 0xa000, bankBytes: 0x2000 },
  saveCheck: [99, 127],
};
