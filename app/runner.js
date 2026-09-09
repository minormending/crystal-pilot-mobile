// Running the ranked list, one job after another.
//
// **This was inside `main.js`, and that is why it is here.** The choosing has
// always been in `rows.js`, where it is tested; the *sequencing* -- the budget,
// the evidence that something moved, the four ways a step can end -- sat in the
// DOM layer, which no test can import. So the half of the runner that decides
// had thirty tests and the half that loops had none, and the coverage tool only
// admitted as much once it was made to count the files the suite never loads.
//
// Nothing in here touches a document. It is handed two functions -- one that
// reads the situation and one that runs a job -- and answers what it did.
import { describeAuto } from './rows.js';

// How many jobs one press will run. Not exported: `runSequence` takes `steps`,
// so a caller that wants a different budget says so rather than importing a
// number, and a test says so rather than working around one.
const AUTO_STEPS = 8;

/**
 * The things a job could move, as one string.
 *
 * The runner's only guard against the loop that never ends, and it is evidence
 * rather than a claim: a job that reports success and leaves all of this
 * identical did nothing, whatever it said. That is a real state and not a
 * hypothetical -- "off to heal" with a full party walks to the Center, heals
 * nobody, says so cheerfully, and is offered again a tenth of a second later.
 *
 * Where you are, the money, the badges, every member's level and HP, and both
 * pockets. Between them they cover what every job on the list is *for*: money
 * is a purchase, HP is a heal, a level is a battle, a badge is a Gym, an item
 * is a pick-up, a ball is a throw, and the map is a walk.
 *
 * The balls are a pocket of their own in Gen 2 and were missed on the first
 * draft, which would have read "Catch threw four balls and caught nothing" as
 * *nothing happened*. Four balls happened.
 */
export function stateSignature(s) {
  return [
    (s.map || []).join('.'),
    s.money,
    s.badges,
    (s.party || []).map((m) => `${m.species}/${m.level}/${m.hp}`).join(','),
    (s.items || []).map(([id, n]) => `${id}x${n}`).join(','),
    (s.balls || []).map(([id, n]) => `${id}x${n}`).join(','),
  ].join('|');
}

/**
 * Which job to run for a row the list has chosen.
 *
 * One rule, and it is the only place that has to know a row can offer two
 * things: **Clear beats Duel wherever the row offers it.** The same fights, in
 * one job with its own budget, instead of one per step out of eight.
 *
 * A separate key rather than a button, so this stays testable and the caller
 * keeps the job of knowing which button that is.
 */
export function jobFor(key, rows) {
  if (key === 'duel' && rows.duel && rows.duel.clearable) return 'clear';
  return key;
}

/**
 * Run the top of the list, read the list again, and keep going.
 *
 * `read()` answers `{ s, rows, offers }`, or null where there is no game.
 * `run(job)` runs one and answers what it said. `save()` is optional and is
 * offered the last word. `stopped()` is asked between steps.
 *
 * Answers `{ ran, why, saved }`. `why` is empty where the last job has already
 * said something worth reading -- adding a sentence of ours would overwrite the
 * useful half.
 */
export async function runSequence({ read, run, save = null,
                                    stopped = () => false,
                                    steps = AUTO_STEPS } = {}) {
  let last = null, lastSig = null, ran = 0, why = '', saved = null;
  for (let step = 0; step < steps; step++) {
    if (stopped()) { why = 'stopped'; break; }
    const now = await read();
    if (!now || !now.s || !now.s.worldLoaded) { why = 'no game running'; break; }
    const { s, rows, offers } = now;
    const sig = stateSignature(s);
    const pick = describeAuto(offers, rows, { last, changed: sig !== lastSig });
    if (!pick.key) { why = pick.text; break; }
    last = pick.key;
    lastSig = sig;
    const res = await run(jobFor(pick.key, rows));
    // Three outcomes, and telling two of them apart matters. A job that
    // refuses, throws or is stopped answers `null`, and every one of those has
    // already said something -- so nothing of ours goes on top. A handler that
    // declines *before* it starts answers `undefined` and says nothing at all,
    // which is the one stop that would be silent. Nothing on the list should be
    // able to reach that, since a row is not enabled unless its handler's
    // preconditions hold -- so if it happens it is a defect, and a defect that
    // stops the runner dead with a blank bar is the worst shape for one.
    if (res === undefined) { why = `${last} would not start`; break; }
    if (res === null || !res.ok) { why = ''; break; }
    ran += 1;
  }
  if (ran >= steps) why = `${steps} jobs is one press's worth`;

  // **And then it saves, which is the point of doing this unattended.** Up to
  // eight jobs of progress live only in the emulator until the game's own save
  // writes them to the battery -- and a phone discards a background tab
  // whenever it likes. The alternative is a sequence whose whole result can be
  // lost by looking at something else.
  //
  // Only where a job actually reported success, because saving after a
  // sequence that did nothing is a write nobody asked for. It cannot undo
  // anything either way: `Undo the last job` restores from a slot this app
  // took *before* each job, which the game's own save does not touch.
  if (save && ran > 0) saved = await save();
  return { ran, why, saved };
}

/**
 * What the bar should say when a sequence ends, or '' for nothing.
 *
 * Here rather than at the call site because it is the one sentence that has to
 * hold three facts at once -- what got done, whether it is on the cartridge,
 * and why it handed back -- and getting that ordering right is a decision worth
 * testing rather than a template worth inlining.
 */
export function sequenceSaid({ ran, why, saved }) {
  if (!ran) return why;
  const jobs = `${ran} job${ran === 1 ? '' : 's'} done`;
  const kept = saved && saved.ok ? ', saved'
    : saved ? ', but not saved' : '';
  return why ? `${jobs}${kept} — ${why}` : `${jobs}${kept}`;
}
