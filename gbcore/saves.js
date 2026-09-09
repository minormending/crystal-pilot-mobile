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
const ALL_SLOTS = [...SLOT_IDS, UNDO_SLOT, REPLACED_SLOT];
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

/**
 * Two cartridge keys, byte for byte.
 *
 * Worth its own function because the two sides are never the same type: the
 * library files its record under the 27-byte Uint8Array the core hands back,
 * and IndexedDB gives a binary key back as an ArrayBuffer. So `===` is false
 * between a key and itself, and anything comparing them without normalising is
 * comparing the wrappers rather than the bytes.
 */
export function sameKey(a, b) {
  if (!a || !b) return false;
  const x = new Uint8Array(a.buffer || a);
  const y = new Uint8Array(b.buffer || b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/**
 * Which of the library's records belongs to the cartridge in the machine.
 *
 * This used to be "the only one, if there is exactly one", which is wrong in
 * the one way this app now actively encourages. The key is ROM bytes
 * 0x134-0x14E: the title, the cartridge flags, the header checksum *and* the
 * top byte of the global checksum. So it changes when the ROM does -- a hack is
 * a different key, and so is a rebuild of the same disassembly.
 *
 * The library also writes nothing until a battery is persisted, so after
 * playing one cartridge the store holds exactly one record. Loading a second
 * cartridge then matched that single stale key, and writing this cartridge's
 * save into the other cartridge's record fails twice over, silently: the reload
 * looks up the record for the cartridge actually loaded, finds none and applies
 * nothing -- so the install reports success and does nothing -- while the save
 * belonging to the first cartridge is overwritten with bytes from a game it has
 * never seen.
 */
export function pickKey(keys, mine) {
  for (const k of keys || []) if (sameKey(k, mine)) return k;
  return null;
}

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
    // Five reads in one transaction, fired and forgotten. **A read that fails
    // rejected with nobody listening** -- an error the caller can catch, and one
    // it cannot, arriving a turn later with no stack pointing here. Which is the
    // shape the codec had nine passes ago, on the other half of the save path.
    // Answered at the source: a slot whose read failed is a slot with no
    // summary, which is a state this already draws.
    //
    // The `Promise.all` is belt and braces rather than a second fix, and is
    // worth saying so: a request's onsuccess resolves before the transaction's
    // oncomplete and the microtask queue drains in between, so the fill was
    // already ordered. Removing it fails no test, deliberately -- it makes the
    // ordering a rule of this function instead of a property of the platform.
    const pending = [];
    await tx(db, STORE, 'readonly', (os) => {
      for (const slot of ALL_SLOTS) {
        pending.push(wrap(os.get(summaryKey(slot))).then(
          (s) => { out[slot] = s || null; },
          () => { out[slot] = null; }));
      }
    });
    await Promise.all(pending);
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

  /**
   * The key the library has already used *for this cartridge*, or null.
   *
   * The stored key is handed back rather than the derived one, even though
   * pickKey has just proved them equal byte for byte: it is the object the
   * library itself filed the record under, which is one assumption fewer than
   * rebuilding an equal one.
   */
  async _existingKey(mine) {
    const wdb = await this.libraryDb();
    if (!wdb.objectStoreNames.contains(WASMBOY_STORE)) return null;
    const keys = await tx(wdb, WASMBOY_STORE, 'readonly',
                          (os) => wrap(os.getAllKeys()));
    return pickKey(keys, mine);
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
    return this.gb.cartridgeHeader();
  }

  /**
   * Move the game's clock by whole hours, through its battery.
   *
   * Gen 2 keeps the in-game clock as an offset added to the cartridge's own
   * real-time clock, and that offset is four bytes inside the saved block --
   * so the time of day can be changed without the hardware clock moving at
   * all. `state.advanceClock` does the arithmetic, which is the game's own.
   *
   * **What this costs is the reason it is a separate call and not part of
   * `install`.** Writing the battery re-loads the ROM, which restarts the
   * emulator at the title screen: everything since the last *in-game* save is
   * gone. So the caller saves first and drives CONTINUE afterwards, exactly as
   * loading a slot does — pressing buttons is a task's job, not this module's.
   *
   * Refuses before it writes rather than after. A battery whose checksum
   * already disagrees with its bytes is one somebody else has damaged, and
   * re-sealing it here would turn a save the game refuses into a save the game
   * accepts and is wrong about, which is worse.
   */
  async shiftClock(hours) {
    const bytes = await this.gb.batterySave();
    if (!bytes || !this.state.saveIsPresent(bytes)) {
      return { ok: false,
               message: 'the cartridge holds no save to edit — save the game first' };
    }
    const made = this.state.checksum(bytes);
    const held = this.state.storedChecksum(bytes);
    if (made === null || held === null) {
      return { ok: false,
               message: 'this cartridge does not say where its save checksum is' };
    }
    if (made !== held) {
      return { ok: false,
               message: 'the battery\'s checksum already disagrees with its bytes' };
    }
    const out = this.state.advanceClock(bytes, hours);
    if (!out) {
      return { ok: false,
               message: 'this cartridge does not keep its clock where the profile says' };
    }
    await this.install(out);
    return { ok: true,
             message: `moved the clock ${hours >= 0 ? 'forward' : 'back'} `
                      + `${Math.abs(hours)} hour(s)` };
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

    // Prefer the key the library has already filed *this cartridge* under, and
    // derive one when there is none. Both work, but they are not equally well
    // evidenced: writing under an existing key is the path that was watched
    // loading a real save into a real game, while the derived key is reasoning
    // about how the library builds one. So the proven path stays primary, and
    // the derivation covers the two cases where there is no record of ours to
    // find -- a browser the library has never written in, which is every first
    // visit, and a second cartridge in a browser where it has. See pickKey for
    // what the second one used to do instead.
    const mine = await this._cartridgeKey();
    const key = await this._existingKey(mine) || mine;
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

    await this.gb.reloadRom();
    await this.gb.run(120);
  }

  // There is no `restore(slot)` here, and its absence is deliberate.
  //
  // One used to sit at this line: read the slot, install the bytes, return
  // true. Nothing called it -- `loadSlot` in main.js does the same job -- and
  // the difference between them is the whole reason it is gone. `loadSlot`
  // refuses a slot whose ROM fingerprint is not this cartridge's, which is the
  // check the fourth audit pass added after finding two ways to install a save
  // from a build that did not write it. This one had no such refusal.
  //
  // So it was the pre-audit version of an operation that already exists, left
  // where the next person would reach for it by name. Deleted rather than
  // patched: two ways to load a slot is the thing that made one of them wrong.
}
