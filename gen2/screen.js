// What the game is saying, in words.
//
// Every box this app drives has been identified by its *shape* -- the pair
// `wMenuDataItems`/`wMenuBorderTopCoord` -- since the eleventh pass, and that
// was a real advance over counting presses. It is also as far as it goes: three
// boxes share 2/7 and two share 2/0, the START menu grows so PACK is at a
// different row depending on how far the game has got, and a box whose cursor
// the pilot could not find in memory had to be driven by pressing and hoping.
//
// The screen itself answers all three. Gen 2 renders text into `wTilemap` --
// twenty by eighteen bytes of tile ids -- and the letters are tiles, so the
// words a person reads are sitting in work RAM the whole time. So is the cursor
// arrow, which is why this file exists at all: the arrow is *drawn*, and a box
// that keeps its selection somewhere this app cannot find still shows you where
// it is.
//
// Everything here is a pure function of a work-RAM snapshot, an address and an
// engine profile. Nothing presses a button.
import { gen2 } from './engine.js';

// 20x18 is the Game Boy's tile grid, and the tilemap is one byte per tile.
const COLS = 20, ROWS = 18;

/**
 * One tile id as a character, or a space for anything that is not text.
 *
 * A space rather than a marker, deliberately: the columns stay lined up, which
 * makes a dumped screen readable, and matching folds punctuation away anyway.
 * The alternative -- dropping unmapped tiles -- shifts every character after a
 * graphic and makes the dump lie about where things are.
 */
export function charOf(tile, engine = gen2) {
  const cm = engine.charmap || {};
  for (const [from, to, first] of cm.ranges || []) {
    if (tile >= from && tile <= to) {
      return String.fromCharCode(first.charCodeAt(0) + (tile - from));
    }
  }
  return (cm.singles || {})[tile] || ' ';
}

/**
 * The screen as `ROWS` strings, one per tilemap row.
 *
 * `COLS` tiles per row, but **not always `COLS` characters**: Gen 2 draws a
 * contraction as a single ligature tile, so the `'s` in "What's" is one tile
 * and two characters. Safe because nothing here indexes a line by column --
 * `arrowAt` scans the raw tiles, `fold` strips punctuation before matching, and
 * the rest trim whole lines.
 */
export function screenLines(wram, at, engine = gen2) {
  if (at === null || at === undefined || !wram) return [];
  const base = at - 0xc000;
  const out = [];
  for (let y = 0; y < ROWS; y++) {
    let line = '';
    for (let x = 0; x < COLS; x++) {
      const i = base + y * COLS + x;
      line += i >= 0 && i < wram.length ? charOf(wram[i], engine) : ' ';
    }
    out.push(line);
  }
  return out;
}

/**
 * Where the cursor arrow is drawn: `{ row, col }`, or null.
 *
 * Measured on the bedroom PC's menu: the arrow tile sits at tilemap rows 2, 4,
 * 6, 8, 10 as `wMenuCursorY` reads 1, 2, 3, 4, 5 -- so the drawn arrow and the
 * variable agree exactly, on a box that keeps one. On the box that does not,
 * this is the only answer there is.
 */
export function arrowAt(wram, at, engine = gen2) {
  const tile = (engine.charmap || {}).cursor;
  if (tile === undefined || at === null || at === undefined || !wram) return null;
  const base = at - 0xc000;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const i = base + y * COLS + x;
      if (i >= 0 && i < wram.length && wram[i] === tile) return { row: y, col: x };
    }
  }
  return null;
}

/**
 * A string reduced to what a match should care about: letters and digits, upper
 * case.
 *
 * Because the screen is not a string. `POKéDEX` draws its `é` as a tile this
 * charmap does not name, `POKéGEAR`'s logo is drawn as graphics entirely, and
 * an item count reads `21/ 21` with the slash as its own tile. Folding all of
 * that away is what lets a caller ask for `PACK` and mean it.
 */
export function fold(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** The text of the line the arrow is on, trimmed. Empty when there is no arrow. */
export function selectedLine(wram, at, engine = gen2) {
  const arrow = arrowAt(wram, at, engine);
  if (!arrow) return '';
  const lines = screenLines(wram, at, engine);
  return (lines[arrow.row] || '').trim();
}

/**
 * Is `phrase` on the screen at all?
 *
 * Line by line, so a phrase cannot be matched across a line break -- two
 * unrelated lines that happen to abut are not a sentence.
 */
export function screenSays(wram, at, phrase, engine = gen2) {
  const want = fold(phrase);
  if (!want) return false;
  return screenLines(wram, at, engine).some((l) => fold(l).includes(want));
}

/** The readable lines, blank ones dropped: what the screen is saying, in order. */
export function screenText(wram, at, engine = gen2) {
  return screenLines(wram, at, engine)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim().length);
}
