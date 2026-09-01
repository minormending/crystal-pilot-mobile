// The emulator, wrapped so the rest of the app never touches WasmBoy directly.
//
// The desktop pilot drives PyBoy and hangs its whole design on CPU hooks: the
// game's own routines announce when they want input. No browser Game Boy core
// exposes breakpoints, so everything here is built on the one thing they all
// do offer -- reading the emulated address space -- and the state variables the
// hooks used to stand in for.

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

  /** Advance `n` frames as fast as the device manages. */
  async run(n = 1) {
    await this.core._runNumberOfFrames(n);
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

  /**
   * Buttons currently held down by the player.
   *
   * The run loop pushes this every frame, which is what makes holding a
   * direction walk. A single short press mostly just turns the character in
   * Gen 2, so tap-only controls cannot move you anywhere.
   */
  hold(button) { this.held.add(button); this.applyHeld(); }
  release(button) { this.held.delete(button); this.applyHeld(); }
  releaseAll() { this.held.clear(); this.applyHeld(); }

  applyHeld() {
    const state = {};
    for (const b of this.held) state[b] = true;
    this.core.setJoypadState(state);
  }

  /** Hold `buttons` for `frames`, then release. */
  async press(buttons, frames = 6, gap = 6) {
    const state = {};
    for (const b of [].concat(buttons)) state[b] = true;
    this.core.setJoypadState(state);
    await this.run(frames);
    this.core.setJoypadState({});
    if (gap) await this.run(gap);
  }

  async saveState() { return this.core.saveState(); }
  async loadState(s) { return this.core.loadState(s); }

  /** Battery save (the .sav other emulators and hardware read). */
  async batterySave() { return this.core.getSavedMemory(); }
}

export { GB_WRAM_START, GB_W, GB_H };
