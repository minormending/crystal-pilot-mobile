// Save slots, and getting a save in or out of the cartridge.
//
// A slot holds a *battery save* -- the 32KB the cartridge itself writes, the
// same bytes a .sav file carries -- and not a machine save state. That is a
// deliberate choice forced by the emulator, and it shapes what a slot can do,
// so it is worth being plain about.
//
// WasmBoy can capture a machine state: saveState() comes back with all four
// memory regions populated, and it even persists them. It cannot put one back.
// loadState() rejects with `undefined` -- measured on states this library
// created itself, fetched from its own IndexedDB, handed to its own API, with
// every buffer the right length. So a machine state here is a snapshot you can
// never return to, which is no use as a slot.
//
// The battery, by contrast, goes in and out. Reading it is a memory read.
// Writing it is this module's one piece of cleverness: the library keeps a
// per-cartridge record in IndexedDB, and `loadCartridgeRam` pushes that
// record's `cartridgeRam` into the core when a ROM is loaded. So writing the
// battery means writing that record and re-loading the ROM.
//
// What follows from all this: a slot is a *save point*, not a moment. Making
// one requires the game to be somewhere it can save -- not in a battle, not
// mid-cutscene -- and loading one puts you where you last saved, at the title
// screen's CONTINUE, rather than at the exact frame. A mid-battle undo is not
// possible, and the interface says so rather than offering one that quietly
// does something else.

const DB_NAME = 'crystal-pilot';
const DB_VERSION = 1;
const STORE = 'slots';
// WasmBoy's own database, where the per-cartridge record lives.
const WASMBOY_DB = 'wasmboy';
const WASMBOY_STORE = 'keyval';

/** The slots a person picks, and the one the pilot writes before it acts. */
export const SLOT_IDS = ['1', '2', '3'];
export const UNDO_SLOT = 'undo';
// Where the game that was *replaced* goes when a save arrives from another
// device. Its own slot rather than the undo point, because the undo point is
// written before every job and would be gone by the time anyone noticed the
// handoff was the wrong one -- and unlike slots 1 to 3, nothing a person does
// on purpose can land here, so it is always the last game this device had.
export const REPLACED_SLOT = 'replaced';
export const ALL_SLOTS = [...SLOT_IDS, UNDO_SLOT, REPLACED_SLOT];
// Where a slot's one-line summary lives, beside the slot itself. A key rather
// than a second store, so no version change and nothing to migrate.
const summaryKey = (slot) => `${slot}:about`;

function open(name, version, upgrade) {
  return new Promise((resolve, reject) => {
    const req = version ? indexedDB.open(name, version) : indexedDB.open(name);
    if (upgrade) req.onupgradeneeded = () => upgrade(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, work) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let out;
    try { out = work(t.objectStore(store)); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export class Saves {
  constructor(gb, state, romdata, log = () => {}) {
    this.gb = gb;
    this.state = state;
    this.rom = romdata;
    this.log = log;
    // Which cartridge these slots belong to, set once the ROM's fingerprint is
    // known. Held here rather than passed to `capture` by each of its four
    // callers, because four call sites that must all remember the same field is
    // the shape of the bug this is meant to prevent.
    this.tag = null;
  }

  /** WasmBoy's own database, opened once rather than per call. */
  async libraryDb() {
    if (!this._wdb) {
      this._wdb = await open(WASMBOY_DB);
      this._wdb.onversionchange = () => { this._wdb.close(); this._wdb = null; };
      this._wdb.onclose = () => { this._wdb = null; };
    }
    return this._wdb;
  }

  async db() {
    if (!this._db) {
      this._db = await open(DB_NAME, DB_VERSION, (db) => {
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      });
    }
    return this._db;
  }

  /**
   * Put the battery currently in the cartridge into a slot.
   *
   * The caller is expected to have saved the game first -- this copies what the
   * battery holds, and refuses to store one with no save in it rather than
   * leaving a slot that looks filled and restores to nothing.
   */
  async capture(slot, extra = {}) {
    const bytes = await this.gb.batterySave();
    if (!this.state.saveIsPresent(bytes)) {
      return { ok: false, message: 'the cartridge has no save in it yet' };
    }
    const record = {
      bytes: Uint8Array.from(bytes),
      when: Date.now(),
      tag: this.tag,
      ...extra,
    };
    const db = await this.db();
    // The summary is written beside the record, under its own key, because a
    // row that says "Route 29 · TOTODILE Lv5 · 17:26" should not cost 32KB to
    // draw. Both in one transaction so a slot can never have one without the
    // other.
    const { bytes: _drop, ...summary } = record;
    await tx(db, STORE, 'readwrite', (os) => {
      os.put(record, slot);
      os.put(summary, summaryKey(slot));
    });
    return { ok: true, message: `kept in slot ${slot}`, when: record.when };
  }

  async read(slot) {
    const db = await this.db();
    const rec = await tx(db, STORE, 'readonly', (os) => wrap(os.get(slot)));
    return rec || null;
  }

  /**
   * Everything a slot row needs to describe itself, without the 32KB.
   *
   * It used to say that and then read the whole record anyway -- five slots of
   * battery data deserialised on every repaint, after every job, to print four
   * fields. The summaries are separate records now; a slot written before they
   * existed falls back to the long way round, once, and is rewritten the next
   * time it is captured.
   */
  async list() {
    const db = await this.db();
    const out = {};
    await tx(db, STORE, 'readonly', (os) => {
      for (const slot of ALL_SLOTS) {
        wrap(os.get(summaryKey(slot))).then((s) => { out[slot] = s || null; });
      }
    });
    for (const slot of ALL_SLOTS) {
      if (out[slot]) continue;
      const rec = await tx(db, STORE, 'readonly', (os) => wrap(os.get(slot)));
      out[slot] = rec ? { when: rec.when, where: rec.where, lead: rec.lead,
                          party: rec.party, tag: rec.tag } : null;
    }
    return out;
  }

  async clear(slot) {
    const db = await this.db();
    await tx(db, STORE, 'readwrite', (os) => {
      os.delete(slot);
      os.delete(summaryKey(slot));
    });
  }

  /** The key the library has already used here, or null if it has none. */
  async _existingKey() {
    const wdb = await this.libraryDb();
    if (!wdb.objectStoreNames.contains(WASMBOY_STORE)) return null;
    const keys = await tx(wdb, WASMBOY_STORE, 'readonly',
                          (os) => wrap(os.getAllKeys()));
    // One cartridge per session. With several, this would have to match the
    // header against the loaded ROM rather than take the only entry.
    return keys && keys.length === 1 ? keys[0] : null;
  }

  /**
   * The key the library files this cartridge's record under.
   *
   * Its `cartridgeHeader` is private, but `_getCartridgeInfo()` hands the same
   * bytes back as `header` -- 27 of them -- and IndexedDB takes a typed array
   * as a key directly. Deriving it beats hunting for whatever key happens to
   * be in the store: there is a record to address even when the library has
   * never written one, and it is the right record when it has.
   *
   * The alternative was asking the library to save a state purely so that it
   * would create the record. That works and is worse: a state costs ~99KB,
   * loadState cannot read one back so it is pure waste, and saveState awaits
   * pause(), which wants an animation frame -- so on a backgrounded tab it
   * hangs. Which it did, the first time this was written.
   */
  async _cartridgeKey() {
    const info = await this.gb.core._getCartridgeInfo();
    const header = info && info.header;
    if (!header || !header.length) {
      throw new Error('the emulator has no cartridge loaded');
    }
    return header;
  }

  /**
   * Put these bytes into the cartridge's battery, and re-load the ROM so the
   * core picks them up.
   *
   * The library reads `cartridgeRam` out of its own per-cartridge IndexedDB
   * record when a ROM loads, so this writes that record under the key already
   * there -- an ArrayBuffer of the cartridge header, which is why the key is
   * read back rather than constructed.
   *
   * Leaves the game at the title screen. The caller drives CONTINUE, because
   * pressing buttons is a task's job and not this module's.
   */
  async install(bytes) {
    if (!bytes || bytes.length !== 32768) {
      throw new Error(`a battery save is 32768 bytes, got ${bytes && bytes.length}`);
    }
    if (!this.state.saveIsPresent(bytes)) {
      throw new Error('those bytes hold no save the cartridge would load');
    }
    if (!this.gb.rom) throw new Error('no ROM is loaded');
    // Re-loading the ROM goes through the library's pause(), which awaits an
    // animation frame -- and a hidden page is not given any, so the call never
    // returns. `run()` already branches on this for frame stepping; there is no
    // equivalent escape for loadROM, so this refuses instead of hanging. In
    // practice a person loading a save is looking at the page, and the check
    // only bites a backgrounded tab.
    if (document.hidden) {
      throw new Error('bring the page to the front first — loading a save '
        + 'restarts the emulator, which a hidden tab cannot do');
    }

    // Prefer the key the library has already filed this cartridge under, and
    // only derive one when there is none. Both work, but they are not equally
    // well evidenced: writing the record under an existing key is the path
    // that was watched loading a real save back into a real game, while the
    // derived key is reasoning about how the library builds it. So the proven
    // path stays primary, and the derivation covers only the case that used to
    // fail outright -- a browser where the library has never persisted
    // anything, which is every first visit.
    const existing = await this._existingKey();
    const key = existing || await this._cartridgeKey();
    // Opened with no version and no upgrade, unlike our own database. This one
    // belongs to the library: naming a version means a VersionError the day it
    // bumps its own, and an upgrade callback would have us inventing its schema
    // -- creating a database the library then finds already there and wrong.
    // If the store is not there yet the honest answer is that there is nothing
    // to write into, not that we should build it.
    const wdb = await this.libraryDb();
    if (!wdb.objectStoreNames.contains(WASMBOY_STORE)) {
      throw new Error('the emulator has not stored anything for this cartridge '
        + 'yet — load the ROM first');
    }
    const rec = await tx(wdb, WASMBOY_STORE, 'readonly', (os) => wrap(os.get(key)));
    const next = Object.assign({}, rec || {}, { cartridgeRam: Uint8Array.from(bytes) });
    await tx(wdb, WASMBOY_STORE, 'readwrite', (os) => os.put(next, key));

    await this.gb.core.loadROM(this.gb.rom);
    await this.gb.run(120);
  }

  /** Install a slot's bytes. Returns false if the slot is empty. */
  async restore(slot) {
    const rec = await this.read(slot);
    if (!rec || !rec.bytes) return false;
    await this.install(rec.bytes);
    return true;
  }
}
