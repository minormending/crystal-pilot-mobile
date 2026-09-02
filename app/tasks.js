// The pilot's tasks, composed from the four files that hold them.
//
// This module exists so that everything importing `Tasks` keeps working and so
// there is one obvious place to look first. The order of the mixins does not
// matter -- no method is overridden -- but it reads outwards from the machine:
// the base talks to the emulator, menus and battle drive the game, and jobs are
// what a person asked for.
import { TaskBase } from './taskbase.js';
import { withMenus } from './menus.js';
import { withBattle } from './battle.js';
import { withJobs } from './jobs.js';

export class Tasks extends withJobs(withBattle(withMenus(TaskBase))) {}
