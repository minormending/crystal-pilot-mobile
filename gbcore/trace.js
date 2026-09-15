// What the pilot is doing, for somebody watching the console.
//
// **The problem this exists for is a screen that is not changing.** A job can
// spend four seconds settling, forty presses closing a conversation, or a
// thousand frames waiting for a map to load, and all three look identical from
// outside: a still picture and a status line that said something once. The
// question a developer has at that moment is not "what happened" -- the status
// line answers that -- it is *"is it working, and on what"*, and nothing in
// this app could answer it.
//
// Two things are needed to answer it and they are different. **A loop that is
// spinning** needs its frame count and its budget, so you can see it is
// getting somewhere and how much rope is left. **A loop that is not spinning
// at all** needs to be noticed without any help from itself, because whatever
// it is stuck awaiting is not going to call anything.
//
// So this counts from `gb.run` -- the one call every driving loop in the app
// goes through, including the ones in `nav.js` that never touch `TaskBase` --
// and it also keeps a timer of its own, which is the only way the second case
// is ever reported.
//
// Off unless asked. A tracer that logs by default is a tracer everybody turns
// off and nobody turns back on.

// How long an activity may go without a frame before it is called stalled.
// Two seconds is well past any legitimate gap: the busiest loops step every
// couple of frames and the slowest deliberate wait in the app -- a settle --
// runs 90 frames, which is under a second even on a phone.
const STALL_MS = 2000;
// And how often a *running* activity reports in. Long enough that a grind does
// not fill the console, short enough that a person who has just switched to
// the console does not sit looking at nothing.
const REPORT_MS = 1500;
// And the closest together two "started doing X" lines may be. Walking is a
// step and a settle per tile, a few milliseconds each, so without a floor here
// a minute of grinding is thousands of lines and the two that matter are lost
// in them. A third of a second still shows the rhythm.
const START_MS = 333;
// How many emitted lines to keep for the on-screen panel. Small on purpose:
// this is what a phone shows in a box a few centimetres tall, and anybody who
// wants the whole run has the console. See `lines`.
const KEEP_LINES = 40;
// How many finished activities to keep for `recent`. A single job is a few
// dozen; this holds the last several jobs without growing without bound.
const KEEP = 200;

/**
 * The pilot's activity log.
 *
 * Pure apart from the timer and the sink, both injected, so the whole of it is
 * testable without a browser -- which matters more here than usual, because
 * the thing being tested is *reporting about time passing* and a test that had
 * to really wait two seconds would be a test nobody runs.
 */
export class Trace {
  constructor({ now = () => Date.now(), sink = null, describe = null,
                stallMs = STALL_MS, reportMs = REPORT_MS, startMs = START_MS,
                keep = KEEP, keepLines = KEEP_LINES } = {}) {
    this.nowFn = now;
    this.sink = sink || ((line) => console.log(line));
    // Answers a short string about the live game -- map, position, whether a
    // script holds the controls. Injected because this module is under gbcore
    // and reading a Gen 2 state is `gen2`'s business, not the tracer's.
    this.describe = describe;
    this.stallMs = stallMs;
    this.reportMs = reportMs;
    this.startMs = startMs;
    this.keep = keep;
    // When a start line was last printed, and how many have been folded into
    // the next one since -- see `doing`.
    this.announcedAt = -Infinity;
    this.skipped = 0;
    // The last few lines, for the settings panel. Kept here rather than in the
    // panel because a developer turns the panel on *after* something has
    // already gone odd, and a buffer that only starts filling when somebody is
    // looking would have nothing to show them.
    this.log = [];
    this.keepLines = keepLines;
    this.tracing = false;
    this.current = null;
    this.past = [];
    this.timer = null;
  }

  /** Begin tracing. `every` is the heartbeat, exposed so a test can drive it. */
  start({ interval = null } = {}) {
    this.tracing = true;
    this.emit('tracing on — PILOT.trace.recent() for the last few, .off() to stop');
    if (interval !== false && typeof setInterval === 'function' && !this.timer) {
      // The heartbeat is the *only* thing that can report a loop which has
      // stopped stepping, because such a loop will never call `tick` again.
      this.timer = setInterval(() => this.heartbeat(), interval || 1000);
    }
    return this;
  }

  /** Stop, and let go of the timer. */
  stop() {
    this.tracing = false;
    if (this.timer && typeof clearInterval === 'function') clearInterval(this.timer);
    this.timer = null;
    return this;
  }

  /**
   * The pilot has started doing something, which ends whatever came before.
   *
   * A flat replace rather than a stack, and that is a decision rather than a
   * shortcut: these loops nest three deep in places -- a job calls a walk which
   * calls a settle -- and a stack would report the settle while the useful
   * label for somebody staring at a still screen is the innermost one anyway.
   * What the outer levels would have added, `recent()` already gives in order.
   */
  doing(label, detail = null) {
    if (!this.tracing) return;
    this.finish('superseded');
    const at = this.nowFn();
    this.current = { label, detail, at, frames: 0, calls: 0,
                     lastTick: at, reportedAt: at, stalled: false };
    // **Announced at most `startMs` apart, and this is what makes the thing
    // usable rather than merely correct.** Walking is a `step` and a `settle`
    // per tile, each a few milliseconds, so a minute of grinding starts
    // thousands of activities -- printing one line each buries the two lines
    // that matter. Skipped starts are counted and shown on the next one, so
    // the rhythm is still visible and nothing is silently dropped.
    if (at - this.announcedAt < this.startMs) { this.skipped += 1; return; }
    const also = this.skipped ? ` (+${this.skipped} since)` : '';
    this.skipped = 0;
    this.announcedAt = at;
    this.emit(`▶ ${this.line(this.current)}${also}`);
  }

  /** Frames have gone into the machine. Called from `gb.run`, so: everything. */
  tick(frames = 1) {
    if (!this.tracing || !this.current) return;
    const c = this.current;
    c.frames += frames;
    c.calls += 1;
    c.lastTick = this.nowFn();
    if (c.stalled) {
      c.stalled = false;
      // The report clock moves with it. A loop coming back from a stall is by
      // definition long overdue a progress line, so without this the recovery
      // is immediately followed by a second line saying the same thing in
      // other words -- two lines for one event.
      c.reportedAt = c.lastTick;
      this.emit(`  ↻ ${c.label} — moving again after ${this.since(c.at)}`);
    }
    if (c.lastTick - c.reportedAt >= this.reportMs) {
      c.reportedAt = c.lastTick;
      this.emit(`  · ${this.line(c)}`);
    }
  }

  /**
   * Close the current activity.
   *
   * `outcome` is free text -- 'done', 'gave up', 'superseded' -- because the
   * loops that report one know things this module could not name.
   */
  finish(outcome = 'done') {
    if (!this.tracing || !this.current) return;
    const c = this.current;
    c.outcome = outcome;
    c.ms = this.nowFn() - c.at;
    this.past.push(c);
    if (this.past.length > this.keep) this.past.splice(0, this.past.length - this.keep);
    this.current = null;
    // A superseded activity is the ordinary case -- one loop handing to the
    // next -- and announcing every one of those is most of the noise a tracer
    // can make. Only a deliberate end gets a line.
    if (outcome !== 'superseded') this.emit(`■ ${c.label} — ${outcome}, ${this.fmt(c.ms)}, ${c.frames} frames`);
  }

  /**
   * The timer's question: has the thing that was running stopped running?
   *
   * Reports once per stall rather than once per beat -- a pilot genuinely stuck
   * would otherwise produce a line a second for as long as somebody left it.
   */
  heartbeat() {
    if (!this.tracing || !this.current) return;
    const c = this.current;
    const quiet = this.nowFn() - c.lastTick;
    if (quiet < this.stallMs || c.stalled) return;
    c.stalled = true;
    this.emit(`⏳ ${c.label} — no frames for ${this.fmt(quiet)} (${c.frames} so far, `
              + `${this.fmt(this.nowFn() - c.at)} in) — the screen is not frozen, this loop is waiting`);
  }

  /** What is happening right now, or null. For a person at a prompt. */
  snapshot() {
    if (!this.current) return null;
    const c = this.current;
    return { label: c.label, detail: c.detail, frames: c.frames, calls: c.calls,
             ms: this.nowFn() - c.at, quietMs: this.nowFn() - c.lastTick,
             stalled: c.stalled };
  }

  /** The last `n` finished activities, oldest first. */
  recent(n = 20) {
    return this.past.slice(-n).map((c) => ({
      label: c.label, detail: c.detail, outcome: c.outcome,
      ms: Math.round(c.ms), frames: c.frames, calls: c.calls,
    }));
  }

  /** One line about an activity in flight. */
  line(c) {
    const bits = [c.label];
    if (c.detail) bits.push(String(c.detail));
    if (c.frames) bits.push(`${c.frames} frames`);
    const ms = this.nowFn() - c.at;
    if (ms >= 100) bits.push(this.fmt(ms));
    const where = this.describe ? this.describe() : null;
    if (where) bits.push(where);
    return bits.join(' · ');
  }

  since(at) { return this.fmt(this.nowFn() - at); }

  fmt(ms) {
    return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
  }

  /** The last `n` lines, newest last -- what the settings panel draws. */
  lines(n = 40) { return this.log.slice(-n); }

  emit(line) {
    const said = `[pilot] ${line}`;
    this.log.push(said);
    if (this.log.length > this.keepLines) {
      this.log.splice(0, this.log.length - this.keepLines);
    }
    this.sink(said);
  }
}

/**
 * A tracer that costs nothing, for when tracing is off.
 *
 * Every driving loop in the app calls `doing`, and `gb.run` calls `tick` on
 * every single call -- so the off path has to be free rather than merely
 * cheap. A shared no-op object beats `trace?.tick(n)` at each of those sites:
 * one branch inside one method instead of a check the reader has to see past
 * at seventeen call sites.
 */
export const OFF = {
  tracing: false,
  doing() {}, tick() {}, finish() {}, heartbeat() {},
  snapshot() { return null; }, recent() { return []; }, lines() { return []; },
  start() { return this; }, stop() { return this; },
};
