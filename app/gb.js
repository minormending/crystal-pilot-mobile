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

const SRAM_BYTES = 32768;
const GB_WRAM_START = 0xc000;   // where work RAM begins in the Game Boy's map
const GB_W = 160, GB_H = 144;

export class GameBoy {
  constructor() {
    this.core = null;
    this.workRam = 0;
    this.ready = false;
    this.held = new Set();
  }

  async start(canvas) {
    const lib = window.WasmBoy;
    this.core = lib.WasmBoy || lib;
    await this.core.config(
      { headless: false, isGbcEnabled: true, isAudioEnabled: false, frameSkip: 0 },
      canvas
    );
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
   * Two paths, because the core's own _runNumberOfFrames begins by awaiting
   * pause() -- and pause() waits for an animation frame, which a hidden page
   * never gets. Left alone, backgrounding the tab (switching apps, screen off)
   * hangs every call here forever: the grind stops dead while the page still
   * claims to be running. So when the page is hidden the frames are stepped
   * directly, which is what _runNumberOfFrames does anyway minus the drawing
   * -- and there is nothing to draw for a screen nobody is looking at.
   */
  async run(n = 1) {
    if (!document.hidden) {
      await this.core._runNumberOfFrames(n);
      return;
    }
    for (let i = 0; i < n; i++) {
      await this.core._runWasmExport('executeFrame', []);
    }
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
  async readWram(bytes = 0x2000) {
    const section = await this.core._getWasmMemorySection(
      this.workRam, this.workRam + bytes
    );
    if (section.length > bytes) {
      return section.subarray(this.workRam, this.workRam + bytes);
    }
    return section;
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
    await this.run(frames);
    this.applyHeld();
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
   * that has been played but never saved has a blank battery -- and nothing
   * here drives the SAVE menu yet, so that is currently always the case.
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

export { GB_WRAM_START, GB_W, GB_H, SRAM_BYTES };
