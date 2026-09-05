// The cartridge's own character encoding.
//
// Every byte sequence here was read out of a real Crystal ROM rather than
// copied from a table, because copying a table hopefully is how the gaps got
// there. `decodeText` is exported for exactly this and had no test until the
// gaps were measured.
import { test } from '../harness.mjs';
import { decodeText, normalise } from '../../gen2/romdata.js';

test('the two NIDORAN are two different names', async (t) => {
  // The one that matters. Both came back "NIDORAN?", so the species picker drew
  // two identical chips and hunting for one of them stopped at the other --
  // Route 35 and Route 36 both carry the pair.
  const female = decodeText([0x8d, 0x88, 0x83, 0x8e, 0x91, 0x80, 0x8d, 0xf5, 0x50]);
  const male = decodeText([0x8d, 0x88, 0x83, 0x8e, 0x91, 0x80, 0x8d, 0xef, 0x50]);
  t.eq(female, 'NIDORAN♀', 'the female sign is a character, not a shrug');
  t.eq(male, 'NIDORAN♂', 'and so is the male one');
  t.ne(female, male, 'which is the whole point: they are pickable apart');
});

test('the punctuation in a species name survives it', async (t) => {
  t.eq(decodeText([0x85, 0x80, 0x91, 0x85, 0x84, 0x93, 0x82, 0x87, 0xe0, 0x83]),
       "FARFETCH'D", 'apostrophe');
  t.eq(decodeText([0x8c, 0x91, 0xe8, 0x8c, 0x88, 0x8c, 0x84, 0x50]),
       'MR.MIME', 'full stop');
  t.eq(decodeText([0x87, 0x8e, 0xe3, 0x8e, 0x87, 0x50]), 'HO-OH', 'hyphen');
});

test('and in an item name, which is where it was first noticed', async (t) => {
  t.eq(decodeText([0x8a, 0x88, 0x8d, 0x86, 0xe0, 0x92, 0x7f, 0x91, 0x8e, 0x82, 0x8a]),
       "KING'S ROCK", 'a name with both punctuation and a space');
  t.eq(decodeText([0x84, 0x97, 0x8f, 0xe8, 0x92, 0x87, 0x80, 0x91, 0x84]),
       'EXP.SHARE', 'and one with no space at all');
});

test('the letters, digits and the ligature are unchanged', async (t) => {
  // The parts that already worked, pinned so a charmap edit cannot quietly
  // move them: A-Z at 0x80, a-z at 0xa0, 0-9 at 0xf6, and POKé in one byte.
  t.eq(decodeText([0x80, 0x99, 0xa0, 0xb9]), 'AZaz', 'both letter ranges');
  t.eq(decodeText([0xf6, 0xff]), '09', 'the digits');
  t.eq(decodeText([0x54, 0x7f, 0x81, 0x80, 0x8b, 0x8b]), 'POKé BALL', 'the ligature');
  t.eq(decodeText([0x80, 0x50, 0x81]), 'A', '"@" ends the name');
  t.eq(decodeText([0x01]), '?', 'and a byte nothing claims is still a shrug');
});

test('folding a name for matching keeps what tells two apart', async (t) => {
  // é folds because someone typing "poke ball" means POKé BALL. The gender
  // signs must not, or the fold would undo the fix above.
  t.eq(normalise('POKé BALL'), 'poke ball', 'the accent goes');
  t.ne(normalise('NIDORAN♀'), normalise('NIDORAN♂'),
       'the signs stay, because they are the difference');
});
