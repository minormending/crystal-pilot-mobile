// A cartridge nobody has described yet.
//
// The profile a ROM hack gets on arrival, before anyone has written one for it.
// It declares almost nothing and adds no methods at all, and the point is how
// much still works: the map graph, the collision map, the encounter tables, the
// species and item names and the move table are all read out of the cartridge,
// so hunting, grinding, catching, fighting, tap-to-walk, saving and slots need
// nothing from this file.
//
// What it cannot do is the part a person had to write down. It has no name for
// any map, so a walk says "map 26.1" instead of "Route 30". It knows nowhere
// that heals, so Heal is not offered. It has no scripted intro and no errand,
// so those are not offered either -- which the interface handles by not drawing
// them, the same way it does not draw a job that cannot run.
//
// A hack gets better supported by someone filling this in as titles/<name>.js,
// not by the app refusing it until they do.
import { Journey } from '../gen2/journey.js';

export const generic = {
  id: 'generic',
  // The two tables pokecrystal ships. Named here rather than in romdata.js
  // because which regions a cartridge has is a fact about the cartridge, and
  // whichever of these exists is used -- a hack with one region loses nothing.
  encounters: ['JohtoGrassWildMons', 'KantoGrassWildMons'],
  // No names, no healers, no grassy maps, no scripts. Each absence is a
  // capability the interface will not offer rather than a thing that fails.
};

export class Generic extends Journey {
  constructor(gb, state, tasks, collision, nav, say, world) {
    super(gb, state, tasks, collision, nav, say, world, generic);
  }
}
