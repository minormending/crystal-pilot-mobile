// What a title profile has to be, checked rather than described.
//
// Every profile is a file somebody wrote by hand, and the failures that shape
// has are all quiet ones: a `reach` naming a method that does not exist fails
// at healing time with "this[undefined] is not a function", a map key written
// as "24,7" instead of `key(24, 7)` never matches anything, an `engine` holding
// one field replaces all of them. None of those is a crash at load, which is
// exactly why they need finding at load.
//
// So this is the contract, and pickTitle skips a profile that fails it: a hack
// with a broken profile falls through to generic and keeps a working app,
// rather than half-driving with a description it cannot trust.
import { gen2 } from '../gen2/engine.js';

const isKey = (k) => Number.isInteger(k) && k > 0 && k <= 0xffff;

/**
 * Everything wrong with a profile, as sentences. Empty means it is usable.
 *
 * Deliberately not exhaustive about *values* -- whether Elm's lab really is
 * map 24.5 is not something this can know, and a profile that says the wrong
 * map is a profile that walks to the wrong place, which is a bug a checker
 * cannot see. What it does check is the shape: that every field is the kind of
 * thing the engine will try to use, and that every name a profile promises
 * actually exists on the class that promised it.
 */
export function validateTitle(title) {
  const bad = [];
  const say = (m) => bad.push(`${(title && title.id) || 'a title'}: ${m}`);
  if (!title || typeof title !== 'object') return ['a title must be an object'];
  if (typeof title.id !== 'string' || !title.id) say('needs a string `id`');
  if (typeof title.drive !== 'function') say('needs a `drive` class');
  if (typeof title.matches !== 'function') say('needs a `matches` function');

  if (title.names !== undefined) {
    if (typeof title.names !== 'object' || !title.names) say('`names` must be an object');
    else {
      for (const [k, v] of Object.entries(title.names)) {
        if (!isKey(Number(k))) say(`\`names\` has a key that is not a map key: ${k}`);
        if (typeof v !== 'string' || !v) say(`\`names[${k}]\` must be a non-empty string`);
      }
    }
  }

  if (title.healers !== undefined) {
    if (!Array.isArray(title.healers)) say('`healers` must be an array');
    else {
      title.healers.forEach((h, i) => {
        if (!h || !isKey(h.map)) say(`\`healers[${i}].map\` must be a map key`);
        if (typeof h.reach !== 'string') say(`\`healers[${i}].reach\` must name a method`);
        // The one that would otherwise wait until somebody's party is hurt.
        else if (typeof title.drive === 'function'
                 && typeof title.drive.prototype[h.reach] !== 'function') {
          say(`\`healers[${i}].reach\` names ${h.reach}(), which ${title.id} `
              + 'does not have');
        }
      });
    }
  }

  if (title.grassyMaps !== undefined) {
    if (!Array.isArray(title.grassyMaps)) say('`grassyMaps` must be an array');
    else if (!title.grassyMaps.every(isKey)) say('`grassyMaps` must all be map keys');
  }
  if (title.encounters !== undefined
      && !(Array.isArray(title.encounters)
           && title.encounters.every((n) => typeof n === 'string'))) {
    say('`encounters` must be an array of symbol names');
  }
  if (title.legCost !== undefined
      && !(Number.isFinite(title.legCost) && title.legCost > 0)) {
    say('`legCost` must be a positive number of tiles');
  }
  // A profile that inherits scripts must describe the places they walk to. It
  // cannot be checked *against* a script -- what a procedure needs is inside
  // it -- but a profile whose drive class has procedures and whose places are
  // missing is the shape of the trap, so the fields are at least checked to be
  // the kind of thing a walk can use.
  if (title.places !== undefined) {
    if (typeof title.places !== 'object' || !title.places) {
      say('`places` must be an object of map keys and tiles');
    } else {
      for (const [k, v] of Object.entries(title.places)) {
        const tile = Array.isArray(v) && v.length === 2 && v.every(Number.isInteger);
        const map = isKey(v);
        const bag = v && typeof v === 'object' && !Array.isArray(v);
        if (!(tile || map || bag)) {
          say(`\`places.${k}\` must be a map key, an [x, y] tile, or a group `
              + 'of them');
        }
      }
    }
  }
  if (title.engine !== undefined) {
    if (typeof title.engine !== 'object' || !title.engine) {
      say('`engine` must be an object of overrides');
    } else {
      for (const k of Object.keys(title.engine)) {
        if (!(k in gen2)) say(`\`engine.${k}\` is not a field the engine reads`);
      }
    }
  }
  return bad;
}

/**
 * A title's engine numbers: the stock profile with its overrides on top.
 *
 * A patch, not a replacement, and that distinction is the whole function. A
 * cartridge with an eleventh character in its names declares
 * `engine: { nameLength: 11 }` -- and handed to GameState as-is that profile
 * has no party stride, no species count and no grass tiles, so the app reads
 * nothing correctly and the one field that was right is the least of it.
 */
export function engineFor(title) {
  return (title && title.engine) ? { ...gen2, ...title.engine } : gen2;
}
