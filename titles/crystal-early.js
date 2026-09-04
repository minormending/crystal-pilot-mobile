// Crystal, described the way a first attempt describes a cartridge.
//
// This is an instrument rather than a product. Every profile written for a ROM
// hack starts partial -- somebody knows where the Center is and has not yet
// worked out the intro, or has three map names and no errand -- and until this
// file existed there was no way to see what the interface does with one. The
// generic profile is the floor (nothing declared) and Crystal is the ceiling
// (everything); this is the middle, which is where a hack author actually
// stands.
//
// It describes a real cartridge, so it can be driven against a real ROM: every
// value here is read from the same source as crystal.js -- New Bark's map
// constants and Cherrygrove's warp events -- and is simply a subset of them.
// Two named maps out of ten, one healer out of two, no errand, no intro.
//
// `matches` returns false on purpose: this must never win a selection. It is
// reached with `?title=crystal-early`, next to the other development flags.
import { Crystal, crystal } from './crystal.js';

const key = (group, number) => group * 256 + number;
const ROUTE_29 = key(24, 3);
const CHERRYGROVE_CITY = key(26, 3);

export const crystalEarly = {
  id: 'crystal-early',
  // Two, so a walk crosses a named map into an unnamed one and the difference
  // is visible in one sentence.
  names: {
    [ROUTE_29]: 'Route 29',
    [CHERRYGROVE_CITY]: 'Cherrygrove City',
  },
  // One, and the general one -- which is what somebody finds first, because a
  // Pokemon Center is signposted and Elm's machine is not.
  healers: [{ map: CHERRYGROVE_CITY, reach: 'heal' }],
  grassyMaps: [ROUTE_29],
  encounters: ['JohtoGrassWildMons'],
  legCost: 25,
  // Declared, not inherited by accident. This profile drives Crystal's own
  // procedures, and a procedure walks to places -- so the places have to be in
  // the description or the script is reading somebody else's map. Crystal's are
  // right here, because this *is* Crystal; a hack that moved New Bark would
  // spread this out and change the one field it moved.
  places: crystal.places,
};

/**
 * Driven by Crystal's own procedures, which is the realistic shape.
 *
 * A hack of the same base game keeps the engine *and* most of the scripts: the
 * nurse still stands behind a counter and is still asked with two presses. What
 * it changes is where things are, which is the data above. So this extends the
 * title it is a subset of rather than the engine, and inherits the one
 * procedure its single healer names.
 */
export class CrystalEarly extends Crystal {
  constructor(gb, state, tasks, collision, nav, say, world) {
    super(gb, state, tasks, collision, nav, say, world);
    // The profile above, in place of the one Crystal's constructor set.
    this.title = crystalEarly;
  }
}
