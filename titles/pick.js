// Which cartridge is this, and therefore which profile drives it.
//
// One registry and one function. Every title says how to recognise itself and
// the first that agrees wins, with the generic profile last -- so an unknown
// cartridge is *supported at once* rather than refused until somebody writes a
// file for it.
//
// Recognising a hack is not a solved problem and this does not pretend
// otherwise. A pokecrystal hack routinely keeps PM_CRYSTAL in its header, so a
// header match alone would claim every hack as Crystal and then walk confidently
// into a lab that has been moved. The header is therefore a necessary condition
// and never a sufficient one: a profile may also probe the symbol table, and may
// pin an exact ROM fingerprint when it wants to be certain. Crystal asks for
// both a name and a symbol only Johto has.
//
// What this cannot do is tell two hacks of the same base apart when neither
// changed its header or its symbols. The honest answer there is the fingerprint,
// which a profile can declare and this will honour.
import { validateTitle } from './contract.js';
import { Crystal, crystal } from './crystal.js';
import { CrystalEarly, crystalEarly } from './crystal-early.js';
import { Generic, generic } from './generic.js';

/**
 * Every profile, most specific first. The last one must match anything.
 */
export const TITLES = [
  { ...crystal, drive: Crystal,
    matches: ({ header, symbols }) =>
      header.title === 'PM_CRYSTAL' && symbols.has('JohtoGrassWildMons') },
  // Never wins a selection; reached with ?title=crystal-early. An instrument
  // for seeing what a partly described cartridge looks like.
  { ...crystalEarly, drive: CrystalEarly, matches: () => false },
  { ...generic, drive: Generic, matches: () => true },
];

/**
 * One profile by id, if it is usable.
 *
 * The `?title=` override went straight to the array, which put the one path a
 * profile author would use to try their own file -- naming it by hand -- past
 * the only thing that would tell them it is wrong. Same gate as recognising
 * one: a profile that fails the contract is not returned, and says why.
 */
export function titleById(id) {
  const found = TITLES.find((t) => t.id === id);
  if (!found) {
    console.warn(`[title] no profile called ${id}; there is `
                 + TITLES.map((t) => t.id).join(', '));
    return null;
  }
  const wrong = validateTitle(found);
  for (const line of wrong) console.warn(`[title] ${line}`);
  return wrong.length ? null : found;
}

/**
 * The profile for this cartridge.
 *
 * `header` is gbcore/cartridge.js's, `symbols` the parsed .sym, `tag` the ROM
 * fingerprint. Always returns something: the last entry matches anything, and a
 * profile that throws while deciding is treated as a no rather than taking the
 * app down -- a bad `matches` in one title should not stop the others being
 * tried.
 */
export function pickTitle({ header = {}, symbols = null, tag = null } = {}) {
  const has = symbols || { has: () => false };
  for (const title of TITLES) {
    if (title.fingerprint && title.fingerprint !== tag) continue;
    try {
      if (!title.matches({ header, symbols: has, tag })) continue;
    } catch (e) {
      // Keep going. A profile is a file somebody wrote by hand.
      continue;
    }
    // Recognised, and now checked. A profile whose shape is wrong is skipped
    // rather than driven: falling through to generic keeps a working app,
    // where a half-trusted description walks to the wrong places. Said out
    // loud, because the alternative is a hack author whose file silently did
    // nothing.
    const wrong = validateTitle(title);
    if (!wrong.length) return title;
    for (const line of wrong) console.warn(`[title] ${line}`);
  }
  return TITLES[TITLES.length - 1];
}
