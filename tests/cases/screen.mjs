// Reading the words the game is showing.
//
// Every box in this app was identified by its *shape* until this pass, and
// three of them share one. The screen says which. These tests run over a
// tilemap painted by the harness through the same charmap the reader uses, so
// what is under test is the decoding and the matching rather than the table.
import { blindTo, paintScreen, symbols, test, worldRam } from '../harness.mjs';
import { GameState } from '../../gen2/state.js';
import { gen2 } from '../../gen2/engine.js';
import { arrowAt, charOf, fold, screenLines, screenSays, screenText,
         selectedLine } from '../../gen2/screen.js';

const sym = symbols();
const AT = sym.addr('wTilemap');

/** A work-RAM snapshot with these lines on screen. */
const showing = (lines) => worldRam(sym, { screen: lines });

test('the letters on screen are the letters in memory', async (t) => {
  // Measured off the cartridge, by dumping the raw tilemap beside the picture:
  // $80-$99 are A-Z, $a0-$b9 are a-z, $f6-$ff are 0-9, and $7f is the blank
  // inside every box.
  t.eq(charOf(0x80), 'A', 'the first letter');
  t.eq(charOf(0x99), 'Z', 'and the last');
  t.eq(charOf(0xa0), 'a', 'lower case starts its own run');
  t.eq(charOf(0xb9), 'z', 'and ends it');
  t.eq(charOf(0xf6), '0', 'digits are a third run');
  t.eq(charOf(0xff), '9', 'ten of them');
  t.eq(charOf(0x7f), ' ', 'and the blank is a space');
});

test('a tile that is not a letter reads as a space, not as nothing',
     async (t) => {
  // A space rather than a marker, and rather than dropping it: the columns stay
  // lined up, so a dumped screen says where things are. Dropping unmapped tiles
  // shifts every character after a graphic.
  t.eq(charOf(0x7a), ' ', 'the box border is a graphic');
  t.eq(charOf(0x60), ' ', 'so is a health bar');
  const lines = screenLines(showing(['AB']), AT);
  t.eq(lines[0].length, 20, 'every line is twenty characters wide');
  t.eq(lines.length, 18, 'and there are eighteen of them');
});

test('a contraction is one tile and two characters', async (t) => {
  // Measured off the cartridge, from the man at the top of Route 32 who turns
  // the pilot back: his second line dumps as
  //
  //     96 a7 a0 b3 d4 7f b3 a7 a4 7f a7 b4 b1 b1 b8 e6
  //     W  h  a  t  's _  t  h  e  _  h  u  r  r  y  ?
  //
  // so $d4 carries both characters. Gen 2 has no apostrophe in running text --
  // it has a ligature tile per contraction -- and this matters now that a
  // failure a person reads quotes the screen: *turned back on the way to ROUTE
  // 32 — Wait up! / What's the hurry?* is the message, and "What  the hurry?"
  // was what it said before.
  const wram = showing(['What']);
  wram[AT - 0xc000 + 4] = 0xd4;
  const lines = screenLines(wram, AT);
  t.eq(charOf(0xd4), '\u2019s', 'the tile is two characters');
  t.contains(lines[0], 'What\u2019s', 'and the line reads as one word');
  t.eq(lines[0].length, 21, 'so this row is twenty tiles and twenty-one characters');
  // The reason that is safe: nothing here counts columns in a *string*.
  t.eq(arrowAt(wram, AT), null, 'the arrow is found in the tiles, not the text');
  t.true(screenSays(wram, AT, 'whats'), 'and matching folds the apostrophe away');
});

test('the readable lines are what the screen is saying, in order', async (t) => {
  const wram = showing(['', ' >PACK', '  SAVE', '', 'What do you want']);
  t.eq(screenText(wram, AT), [' >PACK', '  SAVE', 'What do you want'],
       'blank rows dropped, the rest in order');
});

test('the arrow is found where it is drawn', async (t) => {
  // Which is the whole reason this module exists. Measured on the bedroom PC:
  // the arrow sat at tilemap rows 2, 4, 6, 8, 10 as wMenuCursorY read 1 to 5 --
  // and on the submenu behind it, eight presses over six hundred frames moved
  // that variable not at all while the arrow moved every time.
  const wram = showing(['', ' WITHDRAW ITEM', '', ' >DEPOSIT ITEM']);
  t.eq(arrowAt(wram, AT), { row: 3, col: 1 }, 'row and column');
  t.eq(selectedLine(wram, AT), '>DEPOSIT ITEM', 'and the line it is on');
});

test('a screen with no arrow has nothing selected', async (t) => {
  // "No menu to drive", which is what stops `_driveToSaying` pressing DOWN into
  // an overworld -- where DOWN is a step into the grass.
  const wram = showing(['CHRIS turned on', 'the PC.']);
  t.eq(arrowAt(wram, AT), null, 'no arrow');
  t.eq(selectedLine(wram, AT), '', 'and so no selection');
});

test('matching folds away everything that is not a letter or a digit',
     async (t) => {
  // Because the screen is not a string. POKeDEX draws its accented letter as a
  // tile the charmap does not name; POKeGEAR's logo is drawn as graphics
  // entirely, so the row reads "  GEAR"; and an HP reading is "21/ 21".
  t.eq(fold(' >POK DEX '), 'POKDEX', 'spaces and the arrow go');
  t.eq(fold('21/ 21'), '2121', 'and punctuation');
  const wram = showing(['', ' >POK DEX', '  PACK']);
  t.true(screenSays(wram, AT, 'pack'), 'case does not matter');
  t.true(screenSays(wram, AT, 'POK DEX'), 'nor do the gaps a glyph leaves');
  t.false(screenSays(wram, AT, 'SAVE'), 'and a word that is not there is not there');
});

test('a phrase is not matched across two lines', async (t) => {
  // Two unrelated lines that happen to abut are not a sentence.
  const wram = showing(['SAVE', 'THE GAME']);
  t.true(screenSays(wram, AT, 'SAVE'), 'each line on its own');
  t.false(screenSays(wram, AT, 'SAVETHE'), 'but not the two run together');
});

test('a cartridge whose symbol file has no tilemap reads no screen',
     async (t) => {
  // "Cannot read" rather than "says nothing", which is the distinction every
  // caller of this leans on: it keeps the row counting it had.
  const bare = blindTo(sym, 'wTilemap');
  const state = new GameState(bare);
  t.eq(state.screen(showing([' >PACK'])), null, 'no reader at all');

  const real = new GameState(sym);
  const sc = real.screen(showing([' >PACK']));
  t.true(!!sc, 'and one where the name is there');
  t.true(sc.selectedSays('PACK'), 'which can answer about the selected row');
});

test('the harness paints what the reader reads', async (t) => {
  // One charmap, used in both directions, so a table that is wrong is wrong in
  // both -- rather than a test passing against a second copy of the mistake.
  const wram = new Uint8Array(0x2000);
  paintScreen(wram, sym, ['ABZ abz 09'], gen2);
  t.eq(screenLines(wram, AT)[0].trim(), 'ABZ abz 09', 'there and back');
});

// --- putting the screen on the end of a failure -----------------------------

test('a failure that expected a box says what turned up instead', async (t) => {
  // "The USE box never appeared" says what the pilot expected. It does not say
  // what was there, and that is the difference between a report somebody can
  // act on and one they can only re-run. Measured while driving the bedroom PC:
  // three probes failed to identify a box by its shape, and one look at its
  // words -- "CHRIS turned on the PC" -- settled it.
  const { Tasks } = await import('../../gen2/tasks.js');
  const { FakeGameBoy, fakeRom } = await import('../harness.mjs');
  const state = new GameState(sym);
  const gb = new FakeGameBoy({ wram: showing(['CHRIS turned on', 'the PC.']) });
  const tasks = new Tasks(gb, state, () => {}, fakeRom());
  t.eq(await tasks.saying('the USE box never appeared'),
       'the USE box never appeared — the screen says: CHRIS turned on / the PC.',
       'the message, and the screen behind it');
});

test('a message is unchanged where the screen cannot be read', async (t) => {
  // So a caller can wrap every failure without asking first.
  const { Tasks } = await import('../../gen2/tasks.js');
  const { FakeGameBoy, fakeRom } = await import('../harness.mjs');
  const bare = blindTo(sym, 'wTilemap');
  const gb = new FakeGameBoy({ wram: showing(['CHRIS turned on']) });
  const tasks = new Tasks(gb, new GameState(bare), () => {}, fakeRom());
  t.eq(await tasks.saying('the pack never opened'), 'the pack never opened',
       'no clause appended');
});

test('an empty screen adds nothing either', async (t) => {
  const { Tasks } = await import('../../gen2/tasks.js');
  const { FakeGameBoy, fakeRom } = await import('../harness.mjs');
  const gb = new FakeGameBoy({ wram: showing([]) });
  const tasks = new Tasks(gb, new GameState(sym), () => {}, fakeRom());
  t.eq(await tasks.saying('could not reach BUY'), 'could not reach BUY',
       'an overworld says nothing, so nothing is added');
});

// --- the cartridge that has no screen to read -----------------------------
//
// A symbol file that does not name `wTilemap` has no words in it, and neither
// has a Journey driving nothing but a graph. Every reader here answers the
// same way for that, and every one of those guards is a chain of three or
// four `||`s — so each has to be able to refuse on its own.

test('no tilemap and no memory both read as nothing to say', async (t) => {
  const wram = showing(['HELLO']);
  t.eq(screenLines(wram, null), [], 'a cartridge that will not say where');
  t.eq(screenLines(wram, undefined), [], 'nor at all');
  t.eq(screenLines(null, AT), [], 'and a snapshot that is not there');
  t.eq(screenText(wram, null), [], 'so there is no text either');
  t.false(screenSays(wram, null, 'HELLO'), 'and nothing is on it');
  t.eq(selectedLine(wram, null), '', 'nor selected');
});

test('the arrow refuses on each of the four things it needs', async (t) => {
  // `tile === undefined` is the cartridge whose engine profile has no cursor
  // tile, which is a different absence from having no tilemap — and a reader
  // that needed all four missing before it refused would dereference the
  // first one present.
  const wram = showing(['>ONE']);
  t.eq(arrowAt(wram, AT, { ...gen2, charmap: { ...gen2.charmap, cursor: undefined } }),
       null, 'no cursor tile declared');
  t.eq(arrowAt(wram, null), null, 'no tilemap');
  t.eq(arrowAt(null, AT), null, 'no snapshot');
  t.ne(arrowAt(wram, AT), null, 'and with all of them, it finds the arrow');
});

test('an empty phrase is not on the screen', async (t) => {
  // `fold` strips everything that is not a letter or a digit, so a phrase of
  // nothing but punctuation folds to nothing — and *nothing* is a substring
  // of every line. Answered false, because "the screen says ''" is not a
  // thing anybody wants to be told yes about.
  const wram = showing(['HELLO']);
  t.false(screenSays(wram, AT, ''), 'the empty phrase');
  t.false(screenSays(wram, AT, '!!!'), 'and one that folds away to it');
  t.false(screenSays(wram, AT, null), 'and no phrase at all');
  t.true(screenSays(wram, AT, 'hello'), 'while a real one still matches');
});

test('a phrase is matched inside one line, not across two', async (t) => {
  // Two unrelated lines that happen to abut are not a sentence. The pilot
  // acts on what a box says, and a match spanning the gap between boxes is a
  // sentence the game never wrote.
  const wram = showing(['THE PARTY IS', 'FULL OF POKéMON']);
  t.true(screenSays(wram, AT, 'party is'), 'within a line');
  t.false(screenSays(wram, AT, 'is full'), 'and not across the break');
});
