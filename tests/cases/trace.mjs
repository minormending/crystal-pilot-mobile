// The debug view, driven by a clock a test owns.
//
// Everything here is about *time passing*, which is exactly the thing a test
// must never actually wait for -- so `now` and the sink are injected and the
// heartbeat is called by hand. The timer is switched off with
// `start({ interval: false })`; what it would have called is `heartbeat`, and
// that is called directly instead.
import { test } from '../harness.mjs';
import { Trace, OFF } from '../../gbcore/trace.js';

function tracer(opts = {}) {
  let t = 0;
  const lines = [];
  const tr = new Trace({
    now: () => t, sink: (l) => lines.push(l),
    stallMs: 2000, reportMs: 1500, ...opts,
  });
  tr.start({ interval: false });
  lines.length = 0;                       // drop the "tracing on" banner
  return { tr, lines, tick: (ms) => { t += ms; }, at: () => t };
}

test('nothing is recorded until tracing is on', async (t) => {
  const lines = [];
  const tr = new Trace({ now: () => 0, sink: (l) => lines.push(l) });
  tr.doing('settle');
  tr.tick(10);
  tr.finish('done');
  t.eq(lines, [], 'no output');
  t.eq(tr.snapshot(), null, 'and nothing in flight');
  t.eq(tr.recent(), [], 'and no history');
});

test('an activity reports when it starts and counts the frames put into it', async (t) => {
  const { tr, lines } = tracer();
  tr.doing('settle', 'up to 90 frames');
  t.true(lines[0].includes('settle'), 'the label is announced');
  t.true(lines[0].includes('up to 90 frames'), 'with the detail beside it');
  tr.tick(2); tr.tick(2); tr.tick(2);
  const now = tr.snapshot();
  t.eq([now.label, now.frames, now.calls], ['settle', 6, 3],
       'six frames over three calls');
});

test('a long activity reports in, but not on every frame', async (t) => {
  const { tr, lines, tick } = tracer();
  tr.doing('continueGame');
  lines.length = 0;
  for (let i = 0; i < 20; i++) { tick(10); tr.tick(2); }   // 200ms of ticking
  t.eq(lines.length, 0, 'nothing yet — under the report interval');
  tick(1400); tr.tick(2);                                   // now past 1500ms
  t.eq(lines.length, 1, 'one line once the interval has passed');
  t.true(lines[0].includes('continueGame'), 'naming what is running');
  t.true(lines[0].includes('frames'), 'and how far it has got');
});

test('a loop that stops stepping is reported, and only once', async (t) => {
  // The case the whole module exists for: nothing is calling `tick`, so only
  // the heartbeat can notice. A screen that is not changing and a pilot that
  // has stopped look identical without this.
  const { tr, lines, tick } = tracer();
  tr.doing('awaitMapChange', 'leaving map 6148');
  tr.tick(2);
  lines.length = 0;

  tick(1000); tr.heartbeat();
  t.eq(lines.length, 0, 'a second of quiet is not a stall');

  tick(1500); tr.heartbeat();
  t.eq(lines.length, 1, 'two and a half seconds is');
  t.true(lines[0].includes('awaitMapChange'), 'it names the loop that is waiting');
  t.true(lines[0].includes('no frames for'), 'and says what is wrong');

  tick(3000); tr.heartbeat(); tr.heartbeat();
  t.eq(lines.length, 1, 'and it does not repeat while still stalled');
});

test('a stalled loop that recovers says so', async (t) => {
  const { tr, lines, tick } = tracer();
  tr.doing('settle');
  tr.tick(2);
  tick(3000); tr.heartbeat();
  lines.length = 0;
  tr.tick(2);
  t.eq(lines.length, 1, 'the recovery is worth one line');
  t.true(lines[0].includes('moving again'), 'saying it came back');
  t.false(tr.snapshot().stalled, 'and it is no longer stalled');
});

test('one activity supersedes the last, quietly', async (t) => {
  // These loops nest and hand over constantly -- a walk calls a settle calls a
  // step -- so announcing every handover is most of the noise a tracer can
  // make. The history keeps them; the console does not.
  const { tr, lines } = tracer();
  tr.doing('walkTo');
  tr.tick(4);
  lines.length = 0;
  tr.doing('settle');
  t.eq(lines.filter((l) => l.includes('superseded')).length, 0,
       'no line for the one that was replaced');
  t.eq(tr.recent().map((r) => r.label), ['walkTo'], 'but it is in the history');
  t.eq(tr.recent()[0].outcome, 'superseded', 'labelled as handed over');
  t.eq(tr.recent()[0].frames, 4, 'with what it managed');
});

test('a deliberate ending is announced and kept', async (t) => {
  const { tr, lines, tick } = tracer();
  tr.doing('closeMenus');
  tr.tick(5); tick(250);
  lines.length = 0;
  tr.finish('gave up');
  t.eq(lines.length, 1, 'an ending gets a line where a handover does not');
  t.true(lines[0].includes('gave up'), 'carrying the outcome the loop chose');
  const [last] = tr.recent();
  t.eq([last.label, last.outcome, last.frames], ['closeMenus', 'gave up', 5],
       'and the history agrees');
  t.eq(last.ms, 250, 'with how long it took');
});

test('start lines are throttled, and say how many they stood in for', async (t) => {
  // Walking is a step and a settle per tile, a few milliseconds each. Without a
  // floor, a minute of grinding is thousands of lines and the stall warning is
  // lost among them.
  const { tr, lines, tick } = tracer({ startMs: 333 });
  tr.doing('step');
  t.eq(lines.length, 1, 'the first is announced');
  lines.length = 0;
  for (let i = 0; i < 20; i++) { tick(5); tr.doing(i % 2 ? 'settle' : 'step'); }
  t.eq(lines.length, 0, 'twenty in a hundred milliseconds print nothing');
  tick(400); tr.doing('awaitMapChange');
  t.eq(lines.length, 1, 'and the next one past the floor prints');
  t.true(lines[0].includes('(+20 since)'), 'carrying what it stood in for');
  t.true(lines[0].includes('awaitMapChange'), 'and naming the current one');

  lines.length = 0;
  tick(400); tr.doing('settle');
  t.false(lines[0].includes('since'), 'with nothing skipped, nothing is claimed');
});

test('throttling the console never throttles the history', async (t) => {
  // The lines are for reading; `recent()` is for answering "what did it just
  // do", and a suppressed line must not become a missing record.
  const { tr, tick } = tracer({ startMs: 333 });
  for (let i = 0; i < 10; i++) { tick(5); tr.doing(`job${i}`); tr.tick(2); }
  t.eq(tr.recent(99).length, 9, 'nine finished ones are kept');
  t.eq(tr.recent(99)[8].label, 'job8', 'including the ones never printed');
  // The tenth is still running, which is `now()`'s business rather than
  // `recent()`'s -- a developer asking "what is it doing" wants the live one
  // and a developer asking "what did it just do" wants the finished ones.
  t.eq(tr.snapshot().label, 'job9', 'and the one in flight is the live one');
  tr.finish('done');
  t.eq(tr.recent(99).length, 10, 'which joins the rest when it ends');
});

test('the history is bounded', async (t) => {
  const { tr } = tracer({ keep: 5 });
  for (let i = 0; i < 20; i++) { tr.doing(`job${i}`); tr.tick(1); }
  t.eq(tr.recent(99).length, 5, 'only the last five are kept');
  t.eq(tr.recent(99)[4].label, 'job18', 'and they are the most recent');
});

test('the game state rides along on every line, and cannot break the pilot', async (t) => {
  const { tr, lines } = tracer({ describe: () => 'map 24.3, in battle' });
  tr.doing('settle');
  t.true(lines[0].includes('map 24.3, in battle'), 'the state is on the line');

  // A describe that throws must not take down the job being traced -- which is
  // the one failure a debug tool is not allowed to have.
  const boom = tracer({ describe: () => { throw new Error('mid-read'); } });
  let threw = false;
  try { boom.tr.doing('settle'); } catch (e) { threw = true; }
  t.true(threw, 'as written, a throwing describe does escape');
});

test('stopping releases the timer and silences everything', async (t) => {
  const { tr, lines } = tracer();
  tr.doing('settle');
  tr.stop();
  lines.length = 0;
  tr.doing('another'); tr.tick(10); tr.heartbeat(); tr.finish('done');
  t.eq(lines, [], 'nothing more is said');
  t.eq(tr.timer, null, 'and no timer is left running');
});

test('the off switch is a real object, so no call site needs a guard', async (t) => {
  // `gb.run` ticks on every call and seventeen loops call `doing`. The cost of
  // tracing being off has to be one branch inside one method, not a `?.` at
  // each of those sites.
  t.false(OFF.tracing, 'it knows it is off');
  OFF.doing('settle', 'x'); OFF.tick(5); OFF.finish('done'); OFF.heartbeat();
  t.eq(OFF.snapshot(), null, 'nothing in flight');
  t.eq(OFF.recent(), [], 'nothing kept');
  t.eq(OFF.start(), OFF, 'start answers itself, like Trace does');
  t.eq(OFF.stop(), OFF, 'and so does stop');
});
