// Running the ranked list: the loop, not the choosing.
//
// The choosing has always been in `rows.js` and tested there. This is the other
// half -- the budget, the evidence that something moved, the four ways a step
// can end, and the save at the finish -- which spent four versions inside
// `main.js`, where no test can reach.
//
// Everything here is driven through the two functions `runSequence` takes: one
// that reads a situation and one that runs a job. So a whole sequence is a
// script of answers, which is how the shapes that would take an afternoon on a
// real cartridge get written down in a line.
import { test } from '../harness.mjs';
import { jobFor, runSequence, sequenceSaid, stateSignature } from '../../app/runner.js';

const PARTY = [{ species: 155, level: 5, hp: 20, maxHp: 20 }];
const world = (over = {}) => ({
  worldLoaded: true, map: [3, 1], money: 3000, badges: 0,
  party: PARTY, items: [], balls: [], ...over,
});

/**
 * A situation that answers one offer, and a log of what was run.
 *
 * `results` is what each successive job answers -- which is how a refusal, a
 * silent decline and a plain success get scripted. `states` is the situation
 * each step reads, so a signature that moves (or does not) is a fact the test
 * states rather than one it has to arrange.
 */
function sequencing({ offer = 'grind', results = [], states = [],
                      clearable = false, save = null } = {}) {
  const ran = [];
  let step = 0;
  const read = async () => {
    const s = states[Math.min(step, states.length - 1)] || world();
    return {
      s,
      rows: { [offer]: { enabled: true, text: 'something' },
              duel: { enabled: offer === 'duel', text: '', clearable } },
      offers: { offered: [offer], rank: { [offer]: 1 }, hint: '' },
    };
  };
  const run = async (job) => {
    ran.push(job);
    const answer = results[step];
    step += 1;
    return answer === undefined && results.length > step - 1
      ? undefined : (answer === undefined ? { ok: true } : answer);
  };
  return { read, run, ran, save };
}

test('a sequence runs the front of the list until its budget is spent',
     async (t) => {
  // Each step reads a situation whose signature has moved, so nothing but the
  // budget can end this.
  const states = Array.from({ length: 6 }, (_, i) =>
    world({ money: 3000 + i * 10 }));
  const q = sequencing({ states });
  const out = await runSequence({ ...q, steps: 4 });
  t.eq(out.ran, 4, 'four jobs');
  t.eq(q.ran, ['grind', 'grind', 'grind', 'grind'], 'the same row each time');
  t.contains(out.why, "one press's worth", 'and the budget is the reason');
});

test('a job that fails ends the sequence and says nothing of its own',
     async (t) => {
  // The job has already put its own sentence on the bar, and a sentence of
  // ours would overwrite the useful half.
  const q = sequencing({ results: [{ ok: true }, { ok: false, message: 'no way through' }],
                         states: [world(), world({ money: 10 })] });
  const out = await runSequence({ ...q });
  t.eq(out.ran, 1, 'one job got done');
  t.eq(out.why, '', 'and the runner adds nothing');
});

test('a job that refuses before it starts is named, not swallowed',
     async (t) => {
  // `null` means a job refused, threw or was stopped, and all three have
  // spoken. `undefined` means a handler declined before it began and said
  // nothing at all -- the one stop that would be silent, and a defect if it
  // ever happens.
  const q = sequencing({ results: [undefined] });
  q.run = async (job) => { q.ran.push(job); return undefined; };
  const out = await runSequence({ ...q, steps: 3 });
  t.eq(out.ran, 0, 'nothing done');
  t.contains(out.why, 'would not start', 'and the row is named');
});

test('a stopped sequence says it was stopped', async (t) => {
  const q = sequencing();
  const out = await runSequence({ ...q, stopped: () => true });
  t.eq(out.why, 'stopped', 'the press is the reason');
  t.eq(q.ran.length, 0, 'and nothing ran');
});

test('no game running is a reason, not a crash', async (t) => {
  const q = sequencing({ states: [{ worldLoaded: false }] });
  const out = await runSequence({ ...q });
  t.contains(out.why, 'no game', 'said plainly');
});

test('the same job twice with nothing moved ends it', async (t) => {
  // The loop that must end. Two readings of an identical situation, and the
  // second time the same row is chosen the runner hands back -- whatever the
  // job claimed.
  const same = world();
  const q = sequencing({ states: [same, same, same] });
  const out = await runSequence({ ...q, steps: 5 });
  t.eq(out.ran, 1, 'it tried once');
  t.contains(out.why, 'changed nothing', 'and stopped on the evidence');
});

test('Clear is run wherever the Duel row offers it', async (t) => {
  // The same fights in one job with its own budget, instead of one per step out
  // of eight. The only place that has to know a row can offer two things.
  t.eq(jobFor('duel', { duel: { clearable: true } }), 'clear', 'Clear when offered');
  t.eq(jobFor('duel', { duel: { clearable: false } }), 'duel', 'Duel when not');
  t.eq(jobFor('heal', {}), 'heal', 'and everything else is itself');
  const q = sequencing({ offer: 'duel', clearable: true, results: [{ ok: false }] });
  await runSequence({ ...q, steps: 2 });
  t.eq(q.ran, ['clear'], 'and the sequence runs it');
});

// --- the save at the end ----------------------------------------------------

test('a sequence that got something done saves the game', async (t) => {
  // Up to eight jobs of progress live only in the emulator until the game's own
  // save writes them to the battery -- and a phone discards a background tab
  // whenever it likes. The alternative is a sequence whose whole result can be
  // lost by looking at something else.
  let asked = 0;
  const q = sequencing({ results: [{ ok: true }, { ok: false }],
                         states: [world(), world({ money: 10 })] });
  const out = await runSequence({
    ...q,
    save: async () => { asked += 1; return { ok: true, message: 'saved' }; },
  });
  t.eq(out.ran, 1, 'one job');
  t.eq(asked, 1, 'and it saved once');
  t.true(out.saved.ok, 'which worked');
});

test('a sequence that did nothing does not write to the cartridge', async (t) => {
  // Saving after a sequence that achieved nothing is a write nobody asked for.
  let asked = 0;
  const q = sequencing({ results: [{ ok: false, message: 'nope' }] });
  const out = await runSequence({
    ...q, save: async () => { asked += 1; return { ok: true }; },
  });
  t.eq(out.ran, 0, 'nothing done');
  t.eq(asked, 0, 'so nothing saved');
  t.eq(out.saved, null, 'and nothing claimed');
});

test('a save that refuses is reported rather than assumed', async (t) => {
  // A save can be refused -- mid-script, mid-battle -- and a sequence that says
  // "saved" when it was not is the worst answer available.
  const q = sequencing({ results: [{ ok: true }, { ok: false }],
                         states: [world(), world({ money: 10 })] });
  const out = await runSequence({
    ...q,
    save: async () => ({ ok: false, message: 'something is happening on screen' }),
  });
  t.false(out.saved.ok, 'it did not work');
  t.contains(sequenceSaid(out), 'not saved', 'and the sentence says so');
});

// --- what it says -----------------------------------------------------------

test('the sentence holds what got done, whether it is kept, and why it stopped',
     async (t) => {
  t.eq(sequenceSaid({ ran: 0, why: 'nothing it can start on its own', saved: null }),
       'nothing it can start on its own', 'nothing done is just the reason');
  t.eq(sequenceSaid({ ran: 1, why: '', saved: null }), '1 job done',
       'one job, singular, and nothing more to say');
  t.eq(sequenceSaid({ ran: 4, why: 'Heal ran and changed nothing',
                      saved: { ok: true } }),
       '4 jobs done, saved — Heal ran and changed nothing',
       'all three facts, in that order');
  t.eq(sequenceSaid({ ran: 2, why: '', saved: { ok: false } }),
       '2 jobs done, but not saved', 'and a refused save is not hidden');
});

// --- the signature ----------------------------------------------------------

test('the signature moves for everything a job could move', async (t) => {
  const base = world();
  const before = stateSignature(base);
  for (const [what, over] of [
    ['a walk', { map: [3, 2] }],
    ['a purchase', { money: 2700 }],
    ['a badge', { badges: 1 }],
    ['a level', { party: [{ species: 155, level: 6, hp: 20, maxHp: 20 }] }],
    ['a heal', { party: [{ species: 155, level: 5, hp: 8, maxHp: 20 }] }],
    ['a pick-up', { items: [[18, 1]] }],
    ['a ball thrown', { balls: [[5, 4]] }],
    // The one a *wait* moves, and the only thing it moves. Without it a wait
    // that worked perfectly -- morning to night, the species back in the grass
    // -- reads as "Wait ran and changed nothing" and the sequence stops one
    // step before the thing it was waiting for.
    ['an hour passing', { timeOfDay: 2 }],
  ]) {
    t.ne(stateSignature(world(over)), before, `${what} shows`);
  }
  t.eq(stateSignature(world()), before, 'and nothing moved reads the same');
});

test('the signature survives a snapshot with fields missing', async (t) => {
  // A snapshot taken before the world is loaded has no party and no map, and a
  // guard that throws there would stop the runner with a stack trace instead of
  // a sentence.
  t.eq(typeof stateSignature({}), 'string', 'still a string');
  t.ne(stateSignature({}), stateSignature(world()), 'and not the same one');
});
