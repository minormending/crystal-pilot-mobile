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
  // rather than sending it to a box. The game boxes the seventh quite happily;
// what this number decides is when the party stops *growing*, which is still
// the thing every reader of it wants.
  maxParty: 6,

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
               0xe7: '!', 0xf0: '¥', 0xf1: 'x', 0xed: '>', 0x6d: ':' },
    // The arrow is named twice on purpose: once above so a dumped screen shows
    // which row is selected, and once here so `arrowAt` can find the tile
    // without knowing what character it was rendered as.
    cursor: 0xed,
  },

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
