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
  partyStride: 0x30,
  mon: {
    species: 0x00, moves: 0x02, pp: 0x17, level: 0x1f,
    status: 0x20, hp: 0x22, maxHp: 0x24,
  },
  // The cap the game enforces, and the reason a catch refuses a full party
  // rather than sending it to a box this does not handle.
  maxParty: 6,

  // --- species -------------------------------------------------------------
  // The highest id PokemonNames has an entry for. Reading past it reads
  // whatever table follows, so a hack that added species has to say so -- and
  // this is the field it is most likely to need.
  speciesCount: 251,

  // --- names ---------------------------------------------------------------
  // PokemonNames is fixed-width; ItemNames is packed with a terminator between
  // entries, which is why one is read at a stride and the other is scanned.
  nameLength: 10,

  // --- moves ---------------------------------------------------------------
  // data/moves/moves.asm: animation, effect, power, type, accuracy, pp, chance.
  moveBytes: 7,
  moveField: { effect: 1, power: 2, type: 3, pp: 5 },
  moveCount: 251,
  // Effects whose damage has nothing to do with the power byte, so ranking by
  // power to find something gentle picks exactly the moves that end a battle:
  //   38 OHKO, 40 SUPER_FANG, 87 LEVEL_DAMAGE, 88 PSYWAVE, 89 COUNTER,
  //  144 MIRROR_COAT. A hack that renumbered its effect table needs this list.
  lethalEffects: [38, 40, 87, 88, 89, 144],

  // --- wild encounters -----------------------------------------------------
  // A grass entry is: map group, map number, three rates, then three blocks of
  // seven (level, species) -- morning, day, night.
  encounter: { blocks: 3, slotsPerBlock: 7, headerBytes: 5 },

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
  battleAction: { fight: 1, pack: 3, run: 4 },
  battleMenu: { items: 34, top: 12 },
  // "<MON> wants to learn <MOVE>. But it already knows four moves. Delete an
  // older move to make room?" -- a two-item YES/NO box, and YES is where the
  // cursor starts. Measured by grinding a Chikorita from Lv5 on Route 29 and
  // watching every snapshot the battle loop took: at the instant its moveset
  // went from [TACKLE, GROWL, RAZOR LEAF, REFLECT] to [POISONPOWDER, GROWL,
  // RAZOR LEAF, REFLECT] the box read items=2, top=7, cursor (1,1). The pack
  // mid-throw is also two items but sits at row 0, and the battle menu is
  // thirty-four at row 12, so the row is what tells them apart.
  learnMove: { items: 2, top: 7 },
  ballPocket: 1,

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
