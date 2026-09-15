// The emulator, wrapped so the rest of the app never touches WasmBoy directly.
//
// One property of this core shapes everything below: it can be read but not
// written. _getWasmMemorySection hands back a *copy* -- a different object with
// a different buffer on every call -- and there is no writer on the core at
// all. Writing through the copy succeeds silently and changes nothing, which is
// the most expensive kind of nothing. So the pilot plays the game by pressing
// buttons rather than by setting memory, and save states are not possible here:
// you could snapshot the machine and never put it back. Measured, not assumed.
//
// The desktop pilot drives PyBoy and hangs its whole design on CPU hooks: the
// game's own routines announce when they want input. No browser Game Boy core
// exposes breakpoints, so everything here is built on the one thing they all
// do offer -- reading the emulated address space -- and the state variables the
// hooks used to stand in for.

import { OFF } from './trace.js';

const SRAM_BYTES = 32768;
const GB_WRAM_START = 0xc000;   // where work RAM begins in the Game Boy's map
// And how much of it there is. Stated once because two different things depend
// on it being the same number: the snapshot readWram takes, and the range
// Symbols.require insists a work-RAM address falls inside. A `w` symbol outside
// this window is not a value byteAt can read -- it indexes the snapshot, so an
// address past the end reads `undefined` rather than failing.
const GB_WRAM_BYTES = 0x2000;
// One switchable work-RAM bank. A Game Boy Color has eight of them and only
// two are in the Game Boy's address space at once -- bank 0 at $C000 and one
// of banks 1-7 at $D000 -- but the core keeps all eight laid end to end, so
// bank N begins N of these into `workRam`. Which is what makes a table the
// game parked in a bank nobody has mapped readable at all.
const GB_WRAM_BANK_BYTES = 0x1000;

// The smallest call worth timing. Below this the per-call cost of crossing
// into the worker is most of what is measured; at this size it is a few per
// cent. See `rate`, which is the only thing that reads it.
const RATE_SAMPLE = 240;
// And how many frames have to have gone by before the average means anything.
const RATE_MIN = 1200;

// How often the canvas is repainted while frames are being stepped.
//
// Stepping no longer draws -- see `run` -- so something has to, and the only
// question is how often. A Game Boy is 60fps and a display is 60 or 120Hz, so
// anything under about 16ms is paint nobody can see; 33ms is thirty a second,
// which reads as smooth for something being watched rather than played, and
// halves the number of times a long job stops to draw.
//
// It is a floor rather than a schedule: a paint is *considered* after every
// step and skipped unless this long has passed, so a job that steps a hundred
// times in a frame paints once and a job that steps twice a second paints
// twice. Nothing is queued and nothing accumulates.
const PAINT_MS = 33;

/**
 * Should the game be making a noise right now?
 *
 * Four conditions, and each one is a different reason rather than a variation
 * on caution:
 *
 * - **`sound`** is the person's answer, and it is the only one they gave.
 * - **`speed` must be 1.** The APU makes its samples per frame, so a game
 *   stepped sixteen times over is a game pitched sixteen times up. See
 *   `setAudible`.
 * - **No job may be running.** A job steps frames flat out, with no speed
 *   setting to consult -- that is the point of one -- so it is the same problem
 *   without a number attached.
 * - **Not while watching another device.** There is no cartridge on this one;
 *   the picture is arriving over WebRTC and the sound is coming out of the
 *   machine that has the game.
 *
 * Pure, and exported, because it is the whole decision and the alternative is
 * four conditions spread across the listeners that change them.
 */
export function audibleNow({ sound = false, speed = 1, running = false,
                             watching = false } = {}) {
  return !!sound && speed === 1 && !running && !watching;
}

export class GameBoy {
  constructor() {
    this.core = null;
    this.workRam = 0;
    this.ready = false;
    this.held = new Set();
    // Frames stepped, and the wall time spent stepping them. Not reset: the
    // longer a session runs the better the answer, and nothing about this
    // machine's throughput goes stale.
    this.stepped = 0;
    this.steppingMs = 0;
    // Whether the master audio channel is currently unmuted. Tracked here so a
    // caller can ask without crossing into the core -- see `setAudible`.
    this.audible = false;
    // What the pilot is doing, for a console that wants to know why the
    // picture is not moving -- see trace.js. A no-op until `main.js` puts a
    // real one here, because every `run` below ticks it.
    this.trace = OFF;
    // The paint throttle -- see PAINT_MS and `paint`. `paintedAt` is when the
    // last one was asked for and `painting` whether one is still in flight,
    // and both are needed: a paint takes longer than the interval, so time
    // alone would start a second one on top of the first.
    this.paintedAt = 0;
    this.painting = false;
  }

  async start(canvas) {
    const lib = window.WasmBoy;
    this.core = lib.WasmBoy || lib;
    // Audio is *configured* on and *heard* only when `audible` says so -- see
    // `setAudible`. The flag cannot be changed after config without rebuilding
    // the core, so the choice here is between never having sound and having a
    // mute; the mute is the one that lets somebody turn it on.
    await this.core.config(
      { headless: false, isGbcEnabled: true, isAudioEnabled: true, frameSkip: 0 },
      canvas
    );
    // Silent until asked, whatever the preference says. A page that made noise
    // before anyone touched it would be a page people close.
    await this.setAudible(false);
    return this;
  }

  async loadRom(bytes) {
    // Kept as well as handed to the core: some of what the pilot needs to read
    // is in the cartridge, not in RAM -- the tileset collision tables and the
    // permission table behind them. Reading those from the file is simpler and
    // steadier than asking the emulator to map a bank.
    this.rom = new Uint8Array(bytes);
    await this.core.loadROM(new Uint8Array(bytes));
    // Where the emulated work RAM sits inside the core's linear memory. Asked
    // for rather than assumed, so a core update cannot silently shift it --
    // and asked for *after* the ROM is in, because the constant reads back
    // undefined before that, which silently makes every later read empty.
    this.workRam = await this.core._getWasmConstant('WORK_RAM_LOCATION');
    if (typeof this.workRam !== 'number') {
      throw new Error('could not locate work RAM in the emulator core');
    }
    this.ready = true;
  }

  /**
   * Advance `n` frames as fast as the device manages.
   *
   * **One path, and it is the one that used to be the exception.** The core's
   * own `_runNumberOfFrames` opens with `await pause()`, and `pause()` waits
   * for an animation frame -- so every call cost one whether it asked for two
   * frames or two hundred. A hidden page never gets that frame at all, which
   * is why stepping directly was already here as the hidden-page path; what
   * took so long to see is that the *visible* page was paying for it sixty
   * times a second and getting nothing back.
   *
   * Measured on the real cartridge, 120Hz display: `_runNumberOfFrames(2)`
   * took 16.36ms to do 0.9ms of work -- 94% waiting. `nav.settle` calls
   * exactly that up to 45 times, so settling after a step spent three quarters
   * of a second to emulate a second and a half of game. On a 60Hz phone the
   * wait is twice as long again, which is why the speed slider never helped:
   * it scales the idle loop's batch and no job reads it.
   *
   * Stepping directly is what `_runNumberOfFrames` does anyway once the
   * waiting is taken out, minus the drawing -- so `paint` below does the
   * drawing, on a throttle, and nothing here waits for it.
   */
  async run(n = 1) {
    const began = performance.now();
    for (let i = 0; i < n; i++) {
      await this.core._runWasmExport('executeFrame', []);
    }
    // Every driving loop in the app reaches the machine through here -- the
    // ones on TaskBase and the ones in nav.js that never touch it -- which is
    // what makes this the one honest place to count from. See trace.js.
    this.trace.tick(n);
    // Stepping draws nothing, so ask for a paint -- throttled, and never
    // awaited. On a hidden page there is nothing to paint and `paint` says so.
    this.paint();
    // Only big calls are sampled -- see `rate` for why.
    if (n >= RATE_SAMPLE) {
      this.stepped += n;
      this.steppingMs += performance.now() - began;
    }
  }

  /**
   * Put what has been stepped on the screen, at most every PAINT_MS.
   *
   * **Never awaited, and that is the whole point.** `_runNumberOfFrames(0)`
   * steps nothing and paints, which is exactly the half of it worth keeping --
   * but it still opens with `await pause()`, and `pause()` waits for an
   * animation frame. Measured at 16.6ms a call on a 120Hz display, so awaiting
   * it here would put the tax this method exists to remove straight back.
   * Left to run on its own it costs the caller nothing: the waiting is on the
   * main thread and the worker is free to step frames right through it.
   *
   * Failures are swallowed rather than raised. A paint that does not land
   * leaves a stale picture for a thirtieth of a second and the next one fixes
   * it; letting it reject would take down the job that happened to be stepping
   * at the time, which is a working game lost to a cosmetic miss.
   */
  paint() {
    // Nothing to paint for a screen nobody is looking at, and `pause()` never
    // returns on a hidden page -- the animation frame it waits for does not
    // come. That was already true of the old visible-page path and is why the
    // hidden one existed; it is now the only reason this check is here.
    if (document.hidden || !this.core || this.painting) return;
    const now = performance.now();
    if (now - this.paintedAt < PAINT_MS) return;
    this.paintedAt = now;
    this.painting = true;
    Promise.resolve(this.core._runNumberOfFrames(0))
      .catch(() => {})
      .finally(() => { this.painting = false; });
  }

  /**
   * How many frames a second this device actually steps, or null.
   *
   * The one number a person deciding whether to wait needs, and it is not a
   * constant: this app has been measured at about 2,200 frames a second on an
   * M-series Mac and perhaps a third of that on a phone, which is the
   * difference between a quarter of an hour and most of one.
   *
   * **Only calls of `RATE_SAMPLE` frames or more are counted**, and the reason
   * has changed with `run`. It used to be that a small call was almost all
   * animation-frame wait, so averaging those in answered *how often does the
   * idle loop tick* rather than *how fast does this core step frames*. That
   * wait is gone. What is left is the per-call `await` into the worker, which
   * a two-frame call still pays in full and a two-hundred-frame call amortises
   * -- smaller than it was, and the same shape, so the same floor holds.
   *
   * The remaining overhead is still inside the samples that count, which makes
   * the rate a slight underestimate and therefore any time computed from it a
   * slight overestimate. That is the right direction for the only thing anyone
   * does with it: deciding whether to press a button and go and do something
   * else.
   *
   * Null until there is enough to say. A guess here would be a number on a
   * screen, and a number on a screen is believed.
   */
  rate() {
    if (this.stepped < RATE_MIN || this.steppingMs <= 0) return null;
    return (this.stepped * 1000) / this.steppingMs;
  }

  /**
   * Put the same cartridge back in, after its battery has been rewritten.
   *
   * saves.install used to call `gb.core.loadROM` itself, which is the one thing
   * the first line of this file says nothing outside it does -- and it is not
   * only tidiness. loadRom re-reads WORK_RAM_LOCATION *after* the ROM is in,
   * because the constant reads back undefined before that and silently makes
   * every later read empty; a re-load that skipped it kept whatever offset the
   * previous cartridge had. Reloading the ROM already in hand is the same job
   * with the same postcondition, so it is the same code.
   *
   * **The flag is what makes installing a battery work more than once.** Every
   * non-headless `loadROM` begins by writing the core's *live* cartridge RAM
   * into the library's stored record, and only then reads that record back
   * into the core. So a re-load that exists to install a record first destroys
   * it: the record is overwritten with the game that is already running, and
   * the game comes back exactly as it was. That is the library doing its job
   * -- it is saving a cartridge's battery before swapping cartridges -- and it
   * is wrong for the one load that is not a swap.
   *
   * It stayed hidden because the write-back is skipped until the library has
   * pushed RAM into the core at least once, which makes the *first* install of
   * a session work and every later one a silent no-op. Measured: three Skips
   * from a save at 10 o'clock left the record at 11, 11, 11, each reporting
   * success, while the bytes handed to `persist` read 11, 12, 13.
   *
   * `WASMBOY_KEEP_STORED_BATTERY` is a one-line patch in `vendor/wasmboy.umd.js`
   * guarding that write-back, and `tools/check-app` fails if it is not there --
   * a vendor refresh that drops it would otherwise bring back a bug whose
   * symptom is a save silently not loading. Set here rather than in `saves`
   * because it is true of this call and not of the caller: re-loading the ROM
   * in hand means the stored record is the one wanted, and `loadRom` -- a
   * different cartridge -- keeps the library's behaviour untouched.
   */
  async reloadRom() {
    if (!this.rom) throw new Error('no ROM is loaded');
    globalThis.WASMBOY_KEEP_STORED_BATTERY = true;
    try {
      await this.loadRom(this.rom);
    } finally {
      globalThis.WASMBOY_KEEP_STORED_BATTERY = false;
    }
  }

  /**
   * The cartridge's own 27-byte header, which is how the library keys its
   * per-cartridge record. `cartridgeHeader` is private on the core, so asking
   * for it belongs here rather than in whoever wants it.
   */
  async cartridgeHeader() {
    const info = await this.core._getCartridgeInfo();
    const header = info && info.header;
    if (!header || !header.length) {
      throw new Error('the emulator has no cartridge loaded');
    }
    return header;
  }

  /**
   * Run frames until the machine is demonstrably executing.
   *
   * The core will not take a *second* ROM while it is still coming up.
   * Measured: a re-load called a moment after the first one left
   * `executeFrame` doing nothing at all and every work-RAM read zero, so the
   * app sat at a title screen it could not drive with a save it had just put
   * in. The .sav and slot paths never met this, because by the time a person
   * has pressed either, the emulator has been running for a while -- it took
   * restoring a session automatically at load to reach a re-load that early.
   *
   * Executing is read off work RAM rather than asked of the core: a machine
   * that has run any code at all has non-zero bytes in there, and one that has
   * not is exactly the all-zero read that gave this away.
   */
  async awake(frames = 30, tries = 20) {
    for (let i = 0; i < tries; i++) {
      await this.run(frames);
      const wram = await this.readWram(0x200);
      if (wram.some((b) => b !== 0)) return true;
    }
    return false;
  }

  /**
   * A snapshot of work RAM: Game Boy 0xC000-0xDFFF, plus the GBC banks.
   *
   * _getWasmMemorySection does not reliably honour its range -- it has been
   * seen returning the core's entire ~10 MB linear memory instead of the slice
   * asked for. Indexing that as if it were the slice reads from the wrong base
   * and yields plausible-looking rubbish, so the result is normalised here
   * rather than trusted.
   */
  async readWram(bytes = GB_WRAM_BYTES) {
    const section = await this.core._getWasmMemorySection(
      this.workRam, this.workRam + bytes
    );
    if (section.length > bytes) {
      return section.subarray(this.workRam, this.workRam + bytes);
    }
    return section;
  }

  /**
   * One work-RAM bank, whichever bank is currently mapped.
   *
   * `readWram` takes the Game Boy's *view*: bank 0, then whichever of 1-7 is
   * switched in at $D000. A table the game decompressed into a bank it does
   * not keep mapped is invisible from there, and Polished Crystal's tileset
   * collision is exactly that -- LZ-compressed in the ROM and unpacked into
   * `wDecompressedCollisions` at bank 5, which is never the mapped bank
   * during play. Read at the ROM pointer it comes back as compressed bytes
   * and every tile decodes to nonsense.
   *
   * The core's linear memory has all eight banks in order, so this is the
   * same normalisation `readWram` does at a different offset.
   */
  async readWramBank(bank, bytes = GB_WRAM_BANK_BYTES) {
    const at = this.workRam + bank * GB_WRAM_BANK_BYTES;
    const section = await this.core._getWasmMemorySection(at, at + bytes);
    return section.length > bytes ? section.subarray(at, at + bytes) : section;
  }

  /**
   * A few bytes at a Game Boy address, without copying a whole block.
   *
   * For checks that have to run after every single press, where taking a full
   * snapshot each time would be the bottleneck -- recognising a menu that
   * blocks on a choice, for instance, where noticing one press late is the
   * entire failure.
   */
  async readBytes(addr, len) {
    const at = this.workRam + (addr - GB_WRAM_START);
    const section = await this.core._getWasmMemorySection(at, at + len);
    return section.length > len ? section.subarray(at, at + len) : section;
  }

  /**
   * Read one byte at a Game Boy address.
   *
   * `wram` is a snapshot from readWram(). Callers take one snapshot per poll
   * and read many addresses from it: crossing into the core for every byte is
   * far slower than copying the block once.
   */
  static byteAt(wram, addr) {
    return wram[addr - GB_WRAM_START];
  }

  /** Big-endian 16-bit, the convention Pokemon uses for HP and stats. */
  static wordAt(wram, addr) {
    const i = addr - GB_WRAM_START;
    return (wram[i] << 8) | wram[i + 1];
  }

  /** Little-endian 16-bit, the convention the game uses for pointers. */
  static wordLeAt(wram, addr) {
    const i = addr - GB_WRAM_START;
    return wram[i] | (wram[i + 1] << 8);
  }

  /**
   * One byte from the cartridge, by bank and address.
   *
   * Bank 0 is the first 16 KB and is always mapped low; every other bank is
   * paged into 0x4000-0x7FFF, so the offset into the file is the bank times
   * its size plus the position within the window.
   */
  romByte(bank, addr) {
    return this.rom[bank * 0x4000 + (addr & 0x3fff)];
  }

  /**
   * Buttons currently held down by the player.
   *
   * The run loop pushes this every frame, which is what makes holding a
   * direction walk. Gen 2 turns you before it walks you, so a short press in a
   * new direction is spent on the turn -- tap-only controls move you a tile per
   * tap at best, and nothing at all on the tap that changes direction.
   */
  /**
   * Sound on or off, without rebuilding the core.
   *
   * **Why a mute rather than the config flag.** `isAudioEnabled` is read when
   * the core is configured and cannot be changed afterwards, and re-configuring
   * means losing the running game. So the core is always built with audio on
   * and the master channel carries the decision -- which is also the only shape
   * that can follow the speed.
   *
   * **And it must follow the speed.** The Game Boy's APU produces samples per
   * *frame*, and this app steps frames as fast as the device manages -- about
   * thirty times real time on a laptop, measured. Those samples are each
   * correct and there are thirty times too many of them a second, which is not
   * fast-forward, it is noise. Sound belongs to ordinary play at 1x and nothing
   * else, the same way a fast-forward key mutes an emulator.
   *
   * Tolerant of a core with no audio behind it: `_getAudioChannels` comes from
   * the library rather than the wasm, and a half-built core answers nothing.
   * Silence is the safe direction, so a failure is reported rather than thrown
   * at a caller who only asked for sound.
   */
  async setAudible(on) {
    this.audible = !!on;
    if (!this.core || typeof this.core._getAudioChannels !== 'function') return false;
    try {
      const channels = await this.core._getAudioChannels();
      const master = channels && channels.master;
      if (!master) return false;
      if (on) master.unmute(); else master.mute();
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Let the page make sound at all, which only a gesture can ask for.
   *
   * Every browser starts an AudioContext suspended until a real interaction
   * resumes it, so this belongs on a click and nowhere else. Safe to call
   * again -- resuming a running context does nothing -- which is cheaper than
   * tracking whether it has already been done.
   */
  async resumeAudio() {
    if (!this.core || typeof this.core.resumeAudioContext !== 'function') return false;
    try { await this.core.resumeAudioContext(); return true; }
    catch (e) { return false; }
  }

  hold(button) { this.held.add(button); this.applyHeld(); }
  release(button) { this.held.delete(button); this.applyHeld(); }
  releaseAll() { this.held.clear(); this.applyHeld(); }

  applyHeld() {
    // The window can blur before a ROM has been picked, and that releases every
    // button -- so this runs with no core behind it and must not throw.
    if (!this.core) return;
    const state = {};
    for (const b of this.held) state[b] = true;
    this.core.setJoypadState(state);
  }

  /**
   * Hold `buttons` for `frames`, then release -- and put back whatever was
   * already being held.
   *
   * The clearing at the end used to be absolute, which was fine while only a
   * task could press and a task runs with the player's input locked out. It
   * stopped being fine the moment presses could arrive from another device:
   * one press() during a held direction would leave the core with nothing
   * down, `held` still claiming a button was, and the pad on two devices
   * lighting a button that is not pressed.
   */
  async press(buttons, frames = 6, gap = 6) {
    const state = {};
    for (const b of [].concat(buttons)) state[b] = true;
    this.core.setJoypadState(state);
    try {
      await this.run(frames);
    } finally {
      // In a `finally` for the reason nav.step's release is: if the frames
      // throw, the button this pressed is still down in the core and nothing
      // is left to lift it. A stuck direction walks into a wall for ever, and
      // a stuck A answers every box on screen. Putting back what was *already*
      // held rather than clearing outright is the other half -- presses can
      // arrive from a watching device while a direction is held here.
      this.applyHeld();
    }
    if (gap) await this.run(gap);
  }

  /**
   * The battery save: the .sav other emulators and hardware read.
   *
   * Read straight out of cartridge RAM, the same way work RAM is located, and
   * not via the core's getSavedMemory() -- that returns the shape WasmBoy
   * persists to IndexedDB, `[{saveStates}]`, which is not save data and cannot
   * be written to a file.
   *
   * All zeroes means the game has never committed an in-game save, not that the
   * read failed. Crystal writes SRAM only when you choose SAVE, so a cartridge
   * that has been played but never saved has a blank battery. That used to be
   * *always* the case, and this comment went on saying so long after it stopped
   * being true: menus.js drives START -> SAVE -> YES, the interface has a Save
   * row, and slots, undo and the handoff between devices are all built on the
   * bytes this returns. A reader taking the old sentence at face value would
   * conclude none of that exists.
   */
  async batterySave() {
    const at = await this.core._getWasmConstant('CARTRIDGE_RAM_LOCATION');
    if (typeof at !== 'number') {
      throw new Error('could not locate cartridge RAM in the emulator core');
    }
    const section = await this.core._getWasmMemorySection(at, at + SRAM_BYTES);
    return section.length > SRAM_BYTES
      ? section.subarray(at, at + SRAM_BYTES) : section;
  }
}

export { GB_WRAM_START, GB_WRAM_BYTES, SRAM_BYTES };
