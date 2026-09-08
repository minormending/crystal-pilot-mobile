// Driving the real cartridge from a console, in one call instead of six.
//
// Verification against the ROM in `dev/` is the only method this repository has
// that can refuse an assumption its author and its tests share -- the
// thirty-fourth pass turned on exactly that -- and it costs six fiddly steps
// every time. Worse, two of them are easy to get wrong in ways that read as the
// app being broken:
//
//   * A page reload loses the running game. The emulator library persists a
//     cartridge only when something asks it to, and its own store held *no
//     record at all* for this cartridge after a save the app had verified byte
//     for byte. One of our slots is the only copy.
//   * `collision.playerPos()` reads the snapshot handed to `use`, not live
//     work RAM. A stale read cost one pass a phantom "ledge hop" and two hours
//     of chasing a pathfinder that was fine.
//
// So: paste this file into the console at `?dev=1`, and `DEV` is the shorthand.
//
//     await DEV.keep('3')      save in-game, then copy the battery to a slot
//     await DEV.load('3')      put that slot back, boot it, and unstick it
//     await DEV.at()           where, who, how hurt -- always a fresh read
//     await DEV.watch(fn, 60)  run a job and report what it said and did
//     await DEV.grid(9)        the collision map around the player, as a picture
//
// Not part of the app: nothing imports it, `?dev=1` does not load it, and the
// service worker's shell does not list it. It is a note to whoever is next at
// the console, which is usually me, and it is here rather than in a scratch
// file because every pass has rewritten the same six lines from memory.
/* eslint-disable no-undef */
(() => {
  const P = window.PILOT;
  if (!P) throw new Error('no PILOT on this page — is this ?dev=1 with a ROM in?');

  /** A snapshot, with the collision decode pointed at it. Never stale. */
  const fresh = async () => {
    const s = await P.tasks.snap();
    if (s.wram) P.collision.use(s.wram);
    return s;
  };

  const where = async () => {
    const key = await P.boot.mapKey();
    return P.boot.where(key);
  };

  const DEV = {
    fresh,

    /** Save in-game, then copy the battery into one of our slots. */
    async keep(slot = '3', note = '') {
      const saved = await P.tasks.saveGame();
      // `capture` refuses a battery with no save in it, which is the whole
      // reason the in-game save has to come first rather than after.
      const kept = await P.saves.capture(slot, { note: note || await where() });
      return { saved: saved.ok, kept: kept.message };
    },

    /**
     * Put a slot back and get a playable game out of it.
     *
     * `saves.install` refuses on a hidden page, by design -- and the refusal
     * earns its keep even though the reason it gives is only half of one: the
     * ROM does reload, and the game that comes up will not take a single button
     * press until something presses through the script it wakes in. So the
     * write and the unsticking are both here, and both are needed.
     */
    async load(slot = '3') {
      const rec = await P.saves.read(slot);
      if (!rec) throw new Error(`slot ${slot} is empty`);
      const key = await P.saves._cartridgeKey();
      const wdb = await P.saves.libraryDb();
      await new Promise((ok, no) => {
        const r = wdb.transaction('keyval', 'readwrite').objectStore('keyval')
          .put({ cartridgeRam: Uint8Array.from(rec.bytes) }, key);
        r.onsuccess = () => ok();
        r.onerror = () => no(r.error);
      });
      await P.gb.reloadRom();
      await P.gb.run(180);
      await P.tasks.continueGame();
      // The restored game refuses every button, START included, with a script
      // running that nothing has pressed. Three goes, because the first often
      // lands mid-fade.
      for (let i = 0; i < 3; i++) {
        const s = await P.tasks.snap();
        if (!s.scriptRunning) break;
        await P.boot.runScripts();
      }
      return this.at();
    },

    /** Where and who, off one fresh snapshot. */
    async at() {
      const s = await fresh();
      let pos = null, size = null;
      try { pos = P.collision.playerPos(); size = P.collision.mapSize(); } catch (e) {}
      return {
        where: await where(), pos, size,
        badges: s.badges,
        party: s.party.map((m) => `${m.hp}/${m.maxHp} Lv${m.level}`),
        money: s.money,
        script: s.scriptRunning, window: s.windowOpen, battle: s.inBattle,
        trainersHere: s.wram ? P.collision.trainers(s.wram).length : null,
        shut: [...P.boot.shut.keys()],
      };
    },

    /**
     * Run a job, collect what it said, and report where it left the game.
     *
     * `seconds` is a budget, not a timeout on the job: it returns what it has
     * when the time is up and the job carries on, because the console call that
     * waits for a two-minute crossing is the one that times out and loses the
     * log. Poll `DEV.last` for the rest.
     */
    async watch(run, seconds = 30) {
      const log = [];
      const say = P.boot.say;
      P.boot.say = (m) => log.push(m);
      const done = { finished: false, res: null, err: null };
      DEV.last = done;
      const job = Promise.resolve()
        .then(() => run(P.boot))
        .then((r) => { done.res = r; })
        .catch((e) => { done.err = String(e); })
        .finally(() => { done.finished = true; P.boot.say = say; });
      const t0 = Date.now();
      while (!done.finished && Date.now() - t0 < seconds * 1000) {
        await new Promise((r) => setTimeout(r, 250));
      }
      void job;
      done.log = log;
      return { ...done, secs: ((Date.now() - t0) / 1000).toFixed(1),
               ended: await this.at() };
    },

    /**
     * Re-import the modules and put the new methods on the live objects.
     *
     * **The thing this session has typed most.** Verifying an edit against the
     * cartridge means either reloading the page -- which loses the running game
     * and costs a `keep`/`load` round trip -- or hand-listing every method that
     * changed and copying it off a fresh prototype. The hand-list is what gets
     * it wrong: a method left off the list runs its old body, the run behaves
     * oddly, and half an hour goes on a defect that was fixed already.
     *
     * So this takes the whole prototype. `?v=` because a module already
     * imported is cached for the life of the page, and a stale import is the
     * same trap one level up.
     *
     * Only methods, and only own ones: a getter is left alone because copying
     * one evaluates it, and an inherited method is somebody else's business.
     */
    async patch(tag = String(Date.now())) {
      const P2 = window.PILOT;
      const took = { journey: [], world: [], title: null };
      const J = await import(`../gen2/journey.js?v=${tag}`);
      const proto = J.Journey.prototype;
      // The live driver is a title subclass, so its *own* overrides have to
      // survive this -- copying the base over them would undo the title.
      const ownToTitle = new Set(
        Object.getOwnPropertyNames(Object.getPrototypeOf(P2.boot)));
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const d = Object.getOwnPropertyDescriptor(proto, name);
        if (typeof d.value !== 'function') continue;   // leave getters be
        if (ownToTitle.has(name)) continue;            // the title's own
        P2.boot[name] = d.value;
        took.journey.push(name);
      }
      const W = await import(`../gen2/world.js?v=${tag}`);
      for (const name of Object.getOwnPropertyNames(W.World.prototype)) {
        if (name === 'constructor') continue;
        const d = Object.getOwnPropertyDescriptor(W.World.prototype, name);
        if (typeof d.value !== 'function') continue;
        P2.world[name] = d.value;
        took.world.push(name);
      }
      // And the title's data, which is where declared places live.
      try {
        const T = await import(`../titles/crystal.js?v=${tag}`);
        P2.boot.title = { ...P2.boot.title, ...T.crystal };
        took.title = Object.keys(T.crystal).length;
      } catch (e) { took.title = `not this title (${e.message})`; }
      return { journey: took.journey.length, world: took.world.length,
               title: took.title,
               note: 'title-owned overrides left alone: '
                     + [...ownToTitle].filter((n) => n !== 'constructor').length };
    },

    /**
     * The collision map around the player, as a picture.
     *
     * Because reading twenty numbers per row and working out which one is under
     * your feet is how a stale coordinate goes unnoticed. `@` is the player,
     * `#` wall, `~` water, `L` ledge, `W` warp, `o` somebody standing there.
     */
    async grid(radius = 8) {
      const s = await fresh();
      const C = P.collision;
      const at = C.playerPos();
      const [w, h] = C.mapSize();
      const occupied = C.occupied(s.wram) || new Set();
      const { CollisionMap } = await import('../gen2/collision.js');
      const rows = [];
      for (let y = Math.max(0, at[1] - radius); y <= Math.min(h - 1, at[1] + radius); y++) {
        let line = String(y).padStart(3) + ' ';
        for (let x = Math.max(0, at[0] - radius); x <= Math.min(w - 1, at[0] + radius); x++) {
          const coll = C.collisionAt(x, y);
          line += x === at[0] && y === at[1] ? '@'
            : occupied.has(`${x},${y}`) ? 'o'
            : C.isWall(coll) ? '#'
            : C.isWater(coll) ? '~'
            : CollisionMap.isLedge(coll) ? 'L'
            : CollisionMap.isWarp(coll) ? 'W' : '.';
        }
        rows.push(line);
      }
      return { at, size: [w, h], rows };
    },
  };

  window.DEV = DEV;
  return 'DEV ready — keep, load, at, watch, grid';
})();
