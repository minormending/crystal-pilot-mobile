// Wiring: file pickers, the render loop, and dispatching a task.
import { GameBoy } from './gb.js';
import { Symbols } from './symbols.js';
import { Saves, SLOT_IDS, UNDO_SLOT } from './saves.js';
import { GameState, TRAINER_BATTLE, MAX_PARTY } from './state.js';
import { Tasks } from './tasks.js';
import { CollisionMap } from './collision.js';
import { Nav } from './nav.js';
import { RomData, normalise } from './romdata.js';
import { Bootstrap } from './bootstrap.js';
import { World } from './world.js';

const $ = (s) => document.querySelector(s);
const PARAMS = new URLSearchParams(location.search);
// Dev convenience: load the ROM and .sym from ./dev/ instead of picking them.
const DEV = PARAMS.has('dev');
// Let the pilot play the intro itself. Off by default, dev included: a new game
// is the player's to start, and an auto-pilot can only answer the NAME menu by
// mashing A -- which takes NEW NAME and spells AAAAA into the letter grid.
// Automated runs, which have nobody to press A, opt in.
const AUTOSTART = PARAMS.has('autostart');
const gb = new GameBoy();
let symbols = null, state = null, tasks = null, romBytes = null;
let collision = null, nav = null, romdata = null, boot = null;
let world;
let huntWanted = null;
let ballId = null;
// Frames advanced per animation frame while nobody is driving. The steps are
// powers of two because that is how it reads: 1x, 2x, 4x... and the last one is
// "as fast as it goes", which on a phone lands somewhere short of the label.
const SPEEDS = [1, 2, 4, 8, 16];
// How long an idle-loop step may be outstanding before it is treated as lost.
const LOST_STEP_MS = 1000;
let speed = 1;
let running = false, target = 5;
// Which half of the bootstrap the button is offering. Two presses, because the
// middle of it is not the pilot's decision: the first plays the intro and stops
// at the table in Elm's lab, the second walks out to the grass once you have
// chosen. Which of the three you want is the one real choice in the opening,
// and answering it for you would be taking the interesting part.
let bootStage = 'start';
// Where healing would go from here, worked out once per refresh.
let healPlace = null;
let lastLead = null;   // the lead's level, for the relative grind presets
// Whether this tab has committed a save. Only used for wording -- the
// download checks the battery itself rather than trusting this.
let savedThisSession = false;
let saves = null;
// Whether the undo slot holds a point from the job just run, and what it
// was, so the row can say what undoing would take you back to.
let undoPoint = null;
// Why the last job had no undo point, so the row can say so instead of
// looking like no job has run.
let undoRefused = null;

// --- colour theme -----------------------------------------------------------
// Three states, not two: "auto" follows the phone, and the other two override
// it. Dark is what the app is -- a Game Boy screen looked at in the evening --
// so it is the base palette, and light is a real second one rather than an
// inversion. A phone set to light still gets light by default; this exists so
// that following the phone is not the same as being stuck with it.
const THEMES = ['auto', 'light', 'dark'];
const THEME_KEY = 'crystal-pilot-theme';
let themeChoice = 'auto';

function readTheme() {
  // Private windows and cleared site data both throw rather than return null.
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (THEMES.includes(saved)) return saved;
  } catch (e) { /* no storage: auto is a fine answer */ }
  return 'auto';
}

function applyTheme(choice) {
  themeChoice = choice;
  const root = document.documentElement;
  if (choice === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  const btn = $('#theme');
  if (btn) btn.textContent = choice;
  // The address bar has its own copy of the ground colour, and the media-query
  // pair in the head cannot know about an override.
  const meta = $('#themecolor');
  if (meta) {
    const dark = choice === 'dark' || (choice === 'auto'
      && matchMedia('(prefers-color-scheme: dark)').matches);
    meta.setAttribute('content', dark ? '#16161c' : '#eef0f4');
  }
  try { localStorage.setItem(THEME_KEY, choice); } catch (e) { /* fine */ }
}

applyTheme(readTheme());
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (themeChoice === 'auto') applyTheme('auto');   // refresh the address bar
});
$('#theme').onclick = () => {
  applyTheme(THEMES[(THEMES.indexOf(themeChoice) + 1) % THEMES.length]);
};

const setStatus = (text, kind = '') => {
  $('#dot').className = 'dot ' + kind;
  $('#status').textContent = text;
};
// The pilot's own account of what it is doing, kept rather than overwritten.
// It emits exactly the right events already -- "heading left", "healing up",
// "slot 1 is down - sending out slot 2" -- and a single label threw all but
// the last one away. Three lines is enough to see progress without the card
// growing under your thumb mid-run.
const RUN_LOG_LINES = 3;
let runLines = [];

const progress = (m) => {
  const log = $('#runlog');
  if (!m) { runLines = []; log.textContent = ''; log.classList.add('hide'); return; }
  // Repeats are common -- several legs say "heading left" -- and stacking
  // identical lines reads as being stuck rather than as making progress.
  if (runLines[runLines.length - 1] !== m) runLines.push(m);
  runLines = runLines.slice(-RUN_LOG_LINES);
  log.textContent = '';
  for (const line of runLines) {
    const li = document.createElement('li');
    li.textContent = line;
    log.appendChild(li);
  }
  log.classList.remove('hide');
};

async function maybeStart() {
  if (!romBytes || !symbols) return;
  setStatus('booting…', 'busy');
  await gb.start($('#screen'));
  await gb.loadRom(romBytes);
  state = new GameState(symbols);
  // romdata first: the tasks are handed it at construction, and built
  // in the other order they were handed null -- which a hunt only finds
  // out about when it tries to name the first Pokemon it meets.
  romdata = new RomData(symbols, gb);
  tasks = new Tasks(gb, state, progress, romdata);
  saves = new Saves(gb, state, romdata, progress);
  collision = new CollisionMap(symbols, gb);
  nav = new Nav(gb, symbols);
  world = new World(symbols, gb);
  boot = new Bootstrap(gb, state, tasks, collision, nav, progress, world);
  A_MARK = {
    x: symbols.addr('wXCoord'), y: symbols.addr('wYCoord'),
    offX: symbols.addr('wPlayerBGMapOffsetX'),
    offY: symbols.addr('wPlayerBGMapOffsetY'),
  };

  // Hand the game over immediately: buttons visible, emulator running.
  $('#loader').classList.add('hide');
  $('#intro').classList.add('hide');
  $('#ctrls').classList.remove('hide');
  $('#speedcard').classList.remove('hide');
  $('#speedbox').classList.remove('hide');
  $('#huntcard').classList.remove('hide');
  $('#savecard').classList.remove('hide');
  paintSlots();
  paintUndo();
  $('#screenwrap').classList.remove('hide');
  $('#taphint').classList.remove('hide');
  startLoop();

  if (AUTOSTART) {
    setStatus('starting the game…', 'busy');
    if (!await tasks.continueGame()) {
      setStatus('could not reach the overworld — is this a Crystal ROM?', 'bad');
      return;
    }
  }
  awaitWorld();
}

/**
 * Wait until a game is actually underway, then offer the pilot.
 *
 * A new game belongs to whoever is holding the phone: their intro, their
 * character, their name. Playing it for them means answering the NAME menu the
 * only way an auto-pilot can -- mashing A, which takes NEW NAME and spells
 * AAAAA into the letter grid. So this waits, and presses nothing.
 *
 * Waiting is also the honest signal for the pilot itself: party data and
 * coordinates are restored before the map is, so "there is a party" is not the
 * same as "the world is ready".
 */
async function awaitWorld() {
  setStatus('Press Start, then play until you are out in the world', '');
  progress('the pilot waits here — a new game is yours to start');
  $('#bootrow').classList.remove('hide');
  $('#bootnote').classList.remove('hide');
  // The header tracks where you are, and it is filled in by refresh() once
  // there is a game to describe. Until then it still read "no ROM loaded",
  // which is untrue the moment a ROM has been picked.
  $('#where').textContent = 'no game yet';
  while (true) {
    if (!running) {
      const s = await tasks.snap();
      if (s.worldLoaded) break;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  $('#panel').classList.remove('hide');
  // Not while the pilot is mid-hand-off. This loop's job is to notice that a
  // world exists, and one does the moment the bootstrap reaches Elm's lab --
  // so without this it tidied away the very button offering to finish the
  // trip, and overwrote "your turn - pick a starter" with "ready".
  if (bootStage !== 'grass') {
    $('#bootrow').classList.add('hide');
    $('#bootnote').classList.add('hide');
    setStatus('ready', 'ok');
    progress('');
  }
  refresh();
  setInterval(() => { if (!running) refresh(); }, 1200);
}

/**
 * Advance the emulator in real time while nobody is driving it.
 *
 * Without this the game only moves during a task or a button press, so it looks
 * frozen. Tasks drive the emulator themselves, so the loop stands down while
 * one is running to avoid two things stepping the same core.
 */
function startLoop() {
  let stepping = false, since = 0, stepId = 0, generation = 0;
  const tick = async (mine) => {
    // A newer chain has taken over; this one is a leftover and stops here.
    if (mine !== generation) return;
    requestAnimationFrame(() => tick(mine));
    if (running || !gb.ready) return;
    // A step that never comes back would hold this flag for good, and the loop
    // is then dead for the rest of the session. Belt and braces next to the
    // re-arming below -- that fixes the chain the loop actually lost, this
    // covers a step going missing on its own, which the visibility handler
    // could not help with.
    //
    // A step is a handful of frames, so one still outstanding after a second is
    // not slow, it is lost. The id makes sure a stale step finishing later
    // cannot clear the flag belonging to the step that replaced it.
    if (stepping) {
      if (performance.now() - since < LOST_STEP_MS) return;
      stepping = false;
    }
    stepping = true;
    since = performance.now();
    const step = ++stepId;
    try { await gb.run(speed); } finally { if (stepId === step) stepping = false; }
  };

  /**
   * Start a fresh chain, retiring whatever was running.
   *
   * The loop used to re-arm itself only from inside its own callback, which
   * meant it could not survive being backgrounded: an animation frame already
   * pending when the page is hidden never arrives, so the chain was simply
   * lost. The loop died on the first background and the game stayed frozen
   * ever after -- including back in the foreground, where the only way out was
   * a reload. Measured: zero animation frames scheduled in three seconds by a
   * page whose loop was supposedly running.
   *
   * Re-arming on every visibility change fixes that, and the generation makes
   * sure the transitions cannot leave two chains stepping the same core.
   */
  const restart = () => {
    generation++;
    const mine = generation;
    requestAnimationFrame(() => tick(mine));
  };
  restart();
  document.addEventListener('visibilitychange', restart);
}

/**
 * Run one long job with the UI left in a sane state whichever way it ends.
 *
 * Each handler used to set `running`, disable its buttons, and clear both at the
 * end -- which only happened if nothing threw. One exception and the button
 * stayed disabled for good, the status sat frozen on "grinding to Lv13" with no
 * error anywhere, and `running` stuck true so nothing else would start either.
 * The app was finished until a reload. Measured: throwing from a task left
 * #go disabled and the status mid-sentence.
 *
 * `busy` is what to say while it runs; `lock` are buttons to grey out alongside
 * the one pressed. Returns the job's result, or null if it never got to run.
 */
/**
 * Declare which of the two modes the interface is in.
 *
 * The `running` flag has always existed and gated every handler; nothing in
 * the layout used it, so a task running looked exactly like a task not
 * running. This is the whole switch -- the ordering and dimming live in CSS.
 */
function setMode(piloting) {
  document.body.classList.toggle('piloting', piloting);
  $('#stopRun').classList.toggle('hide', !piloting);
}

async function runTask(id, busy, work,
                       { needsWorld = true, takeUndoPoint = true } = {}) {
  if (running) return null;
  // Every one of these needs a game already running -- the buttons are on
  // screen before that is true, and pressing one first got "no way from map
  // 0.0 to Route 30", which is honest but not much help.
  if (needsWorld && tasks && !(await tasks.snap()).worldLoaded) {
    setStatus('start a game first', 'bad');
    return null;
  }
  running = true;
  setMode(true);
  // Cleared here rather than when a run finishes: the last thing the pilot
  // said is the most useful thing on screen once it stops.
  progress('');
  if (tasks) tasks.cancelled = false;   // clear a Stop left over from last time
  // No list of other buttons to grey out. Only one job can be underway, and
  // piloting mode makes the rest inert -- which is what the hand-maintained
  // lock lists were imitating, inconsistently: grinding locked Hunt but not
  // Catch or the errand; catching locked Hunt and grinding but not the errand.
  $(id).disabled = true;
  gb.releaseAll();
  syncHeld();
  setStatus(busy, 'busy');
  try {
    // An undo point, before anything moves. Only possible where the game can
    // save at all, which rules out the two commands that run inside a battle --
    // so this reports what it did rather than pretending every job is undoable.
    //
    // Inside the try, and this matters more than it looks. It was outside, and
    // anything it threw -- an IndexedDB error, a bad read -- escaped past the
    // finally: `running` stayed true, the pad stayed dimmed and every button
    // stayed disabled, with no way back but a reload. That is the exact failure
    // runTask exists to prevent, reintroduced by adding a step above it.
    if (takeUndoPoint) await snapshotForUndo(busy);
    const res = await work();
    setStatus(res.message, res.ok ? 'ok' : 'bad');
    return res;
  } catch (e) {
    // Surfaced rather than swallowed: a task that dies silently looks
    // indistinguishable from one still working.
    setStatus(`${busy}: ${e && e.message ? e.message : e}`, 'bad');
    return null;
  } finally {
    running = false;
    setMode(false);
    $(id).disabled = false;
    refresh();
  }
}

/**
 * Say what each job would do if you started it now.
 *
 * The state line is the point of the row. A disabled primary button reading
 * "Pick one to look for" was an instruction wearing a button's clothes, and it
 * sat below the chips that were the actual control.
 */
function paintJobs(s) {
  const lead = s.party[0];
  const leadName = lead && romdata ? romdata.speciesName(lead.species) : null;

  $('#grindstate').textContent = lead
    ? `${leadName} \u2192 Lv${target}`
    : 'no party yet';
  $('#go').disabled = !lead;
  $('#job-grind').classList.toggle('blocked', !lead);
  $('#levels').hidden = !lead;

  $('#huntstate').textContent = huntWanted
    ? `${huntWanted} \u00b7 here now`
    : 'pick something below';
  $('#hunt').disabled = !huntWanted;
  $('#job-hunt').classList.toggle('blocked', !huntWanted);

  // Catch owns its own prerequisite. The errand used to be a peer button in
  // this card, below Catch, next to bag advice that contradicted it -- and it
  // is a one-time thing anyway: run it twice and it returns "already carrying
  // 5 ball(s)" without moving. So it is Catch's empty state instead.
  const balls = (s.balls || []).filter(([, q]) => q > 0);
  const ballName = ballId && romdata ? romdata.itemName(ballId) : null;
  const needsBalls = !ballId;
  $('#errand').classList.toggle('hide', !needsBalls);
  $('#catch').classList.toggle('hide', needsBalls);
  $('#catchstate').textContent = needsBalls
    ? 'no Poké Balls yet — fetch them first'
    : huntWanted
      ? `${huntWanted} \u00b7 ${ballName}`
      : 'pick something below';
  $('#catch').disabled = !(ballId && huntWanted);
  $('#job-catch').classList.toggle('blocked', needsBalls || !huntWanted);

  // Saving needs the world and a quiet screen; it drives the START menu, and
  // that menu does not open in a battle or mid-script.
  const canSave = s.worldLoaded && !s.inBattle && !s.scriptRunning;
  $('#savestate').textContent = !s.worldLoaded
    ? 'start a game first'
    : s.inBattle
      ? 'finish the battle first'
      : s.scriptRunning
        ? 'wait for the screen to settle'
        : savedThisSession
          ? 'saved this session'
          : 'not saved yet';
  $('#savegame').disabled = !canSave;
  $('#job-save').classList.toggle('blocked', !canSave);
  $('#exportstate').textContent = savedThisSession
    ? 'ready — the battery has this session in it'
    : 'the battery save, for another emulator';

  // The three below act on the situation you are already in, so what they can
  // do is decided by the game rather than by anything picked on this page.
  const foe = s.inBattle && romdata ? romdata.speciesName(s.enemy.species) : null;
  const trainer = s.battleMode === TRAINER_BATTLE;

  $('#battlestate').textContent = !s.inBattle
    ? 'not in a battle'
    : `${trainer ? 'trainer' : 'wild'} ${foe} Lv${s.enemy.level}`;
  $('#battle').disabled = !s.inBattle;
  $('#job-battle').classList.toggle('blocked', !s.inBattle);

  $('#herestate').textContent = !s.inBattle
    ? 'not in a battle'
    : trainer
      ? 'a trainer\u2019s Pokémon cannot be caught'
      : s.party.length >= MAX_PARTY
        ? 'the party is full'
        : needsBalls
          ? 'no Poké Balls yet'
          : `${foe} Lv${s.enemy.level} · ${ballName || 'a ball'}`;
  $('#catchhere').disabled = !(s.inBattle && !trainer && ballId
                               && s.party.length < MAX_PARTY);
  $('#job-here').classList.toggle('blocked', $('#catchhere').disabled);

  const hurt = s.party.filter((m) => m.hp < m.maxHp);
  $('#healstate').textContent = s.inBattle
    ? 'finish the battle first'
    : !s.party.length
      ? 'no party yet'
      : hurt.length
        ? `${hurt.length} hurt · nearest is ${healPlace || 'a Center'}`
        : 'everyone is at full health';
  $('#heal').disabled = s.inBattle || !hurt.length;
  $('#job-heal').classList.toggle('blocked', $('#heal').disabled);
}

/** One party member: who it is, and how close it is to fainting. */
function monRow(m) {
  const frac = m.maxHp ? m.hp / m.maxHp : 0;
  const name = romdata ? romdata.speciesName(m.species) : `#${m.species}`;
  const cls = m.hp === 0 ? 'out' : frac < 0.34 ? 'low' : '';
  const right = m.hp === 0
    ? '<span class="fnt">FNT</span>'
    : `<span class="hpnum">${m.hp}/${m.maxHp}</span>`;
  return `<div class="mon"><span class="who">${name}` +
         `<span>Lv${m.level}</span></span>${right}` +
         `<span class="hp ${cls}"><i style="width:${Math.round(frac * 100)}%"></i></span></div>`;
}

async function refresh() {
  if (!state) return;
  const s = await tasks.snap();
  // Named, not numbered. Both of these had a friendly form available in this
  // same scope and neither was called, so the interface showed a species id and
  // a map number to the one audience that cannot read either.
  const place = boot ? boot.where(s.map[0] * 256 + s.map[1]) : '—';
  $('#where').textContent = s.inBattle
    ? `battle · ${romdata ? romdata.speciesName(s.enemy.species) : 'wild'} Lv${s.enemy.level}`
    : `${place}${s.onGrass ? ' · grass' : ''}`;
  $('#party').innerHTML = s.party.length
    ? s.party.map(monRow).join('')
    : '<span class="seen">no party yet</span>';
  await refreshSpecies(s);
  if (romdata) refreshBag(s);
  // Remembered so the relative presets have something to be relative to.
  lastLead = s.party.length ? s.party[0].level : null;
  // Named in the Heal row, so the choice the pilot would make is visible
  // before it is asked to make it.
  if (boot && !s.inBattle && s.worldLoaded) {
    try {
      const pick = await boot.nearestHeal(s.map[0] * 256 + s.map[1]);
      healPlace = pick ? boot.where(pick.map) : null;
    } catch (e) { healPlace = null; }
  }
  if (s.party.length && target <= s.party[0].level) {
    target = Math.min(100, s.party[0].level + 1);
  }
  paintJobs(s);
}

// Every Game Boy cartridge starts its header logo with these bytes at 0x104.
// Checking them turns "picked the wrong file" into a sentence instead of a
// mysterious failure to boot.
const NINTENDO_LOGO = [0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d];

function looksLikeGameBoyRom(buf) {
  if (buf.byteLength < 0x8000) return false;
  const head = new Uint8Array(buf, 0x104, NINTENDO_LOGO.length);
  return NINTENDO_LOGO.every((b, i) => head[i] === b);
}

$('#romFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const buf = await f.arrayBuffer();
  if (!looksLikeGameBoyRom(buf)) {
    romBytes = null;
    setStatus(`${f.name} is not a Game Boy ROM — expected a .gbc built from ` +
              `the disassembly`, 'bad');
    return;
  }
  romBytes = buf;
  setStatus(`ROM: ${f.name} (${(buf.byteLength / 1048576).toFixed(1)} MB)`, 'ok');
  maybeStart();
});

$('#symFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const text = await f.text();
    if (!/^[0-9A-Fa-f]{2,3}:[0-9A-Fa-f]{4}\s/m.test(text)) {
      throw new Error(`${f.name} does not look like an rgblink .sym file`);
    }
    symbols = new Symbols(text);
    symbols.require(['wPartyCount', 'wPartyMon1', 'wBattleMode', 'wMapGroup',
                     'wMapStatus', 'wMenuCursorY', 'wPlayerTileCollision',
                     // tap-to-walk: the collision map and the window stack
                     'wOverworldMapBlocks', 'wMapWidth', 'wMapHeight',
                     'wTilesetCollisionBank', 'wTilesetCollisionAddress',
                     'wWindowStackSize', 'CollisionPermissionTable',
                     'wPlayerBGMapOffsetX', 'wPlayerBGMapOffsetY',
                     // hunting: names and wild tables come out of the ROM
                     'PokemonNames', 'JohtoGrassWildMons', 'wTimeOfDay']);
    setStatus(`symbols: ${symbols.size.toLocaleString()} loaded`, 'ok');
  } catch (err) {
    symbols = null;
    setStatus(err.message, 'bad');
    return;
  }
  maybeStart();
});

// The targets people actually pick, two of them relative to the party, rather
// than four buttons and up to four taps to say "Lv10".
document.querySelectorAll('[data-target]').forEach((b) => {
  b.onclick = () => {
    const spec = b.dataset.target;
    const lead = lastLead || 5;
    target = spec.startsWith('+')
      ? Math.min(100, lead + Number(spec.slice(1)))
      : Number(spec);
    target = Math.max(2, Math.min(100, target));
    for (const other of $('#levels').querySelectorAll('button')) {
      other.classList.toggle('on', other === b);
    }
    refresh();
  };
});

// --- controls -------------------------------------------------------------
// Press and hold, not tap. The emulator advances in the run loop below, and the
// loop pushes whatever is held each frame, so holding a direction walks.
/**
 * Light up whatever is currently held.
 *
 * Read back off the emulator's own held set rather than set by whichever
 * handler fired, so a key pressed on a keyboard lights the same button a thumb
 * would -- and so a button released by losing pointer capture cannot be left
 * looking stuck down. The default tap highlight is switched off page-wide, so
 * without this a press gives no sign at all that it landed.
 */
function syncHeld() {
  for (const el of document.querySelectorAll('[data-btn]')) {
    el.classList.toggle('held', gb.held.has(el.dataset.btn));
  }
}

function hold(button) {
  if (running) return;
  gb.hold(button);
  syncHeld();
}

function release(button) {
  gb.release(button);
  syncHeld();
}

function bindHold(el, button) {
  const down = (e) => { e.preventDefault(); hold(button); };
  const up = (e) => { e.preventDefault(); release(button); };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('pointerleave', up);
}
document.querySelectorAll('[data-btn]').forEach((b) => bindHold(b, b.dataset.btn));

// Keyboard too, so the same page is usable on a desktop browser.
const KEYS = {
  ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
  z: 'A', x: 'B', a: 'A', s: 'B', Enter: 'START', Shift: 'SELECT',
  Backspace: 'SELECT',
};
addEventListener('keydown', (e) => {
  const b = KEYS[e.key];
  if (!b || running) return;
  e.preventDefault();
  hold(b);
});
addEventListener('keyup', (e) => {
  const b = KEYS[e.key];
  if (!b) return;
  e.preventDefault();
  release(b);
});
// Releasing on blur avoids a key staying stuck down after tabbing away.
addEventListener('blur', () => { gb.releaseAll(); syncHeld(); });

$('#boot').onclick = async () => {
  if (!boot) return;
  if (bootStage === 'start') {
    const res = await runTask('#boot', 'starting a new game',
                              () => boot.run(), { needsWorld: false });
    if (res && res.handover) {
      bootStage = 'grass';
      $('#boot').textContent = 'Now take me out to the grass';
      // The three balls are identical on screen, and the game does not say
      // which is which until you are already talking to one.
      $('#bootnote').textContent = 'Left to right on the table: Cyndaquil, '
        + 'Totodile, Chikorita. Walk up to one and press A — you are standing '
        + 'in front of the middle ball.';
      $('#bootnote').classList.remove('hide');
    }
    return;
  }
  const res = await runTask('#boot', 'out to the grass', () => boot.toGrass());
  if (res && res.ok) {
    $('#bootrow').classList.add('hide');
    $('#bootnote').classList.add('hide');
  }
};

// --- the errand that pays for the balls --------------------------------------
// Nothing to catch with until this has been round: the Mart wants a Pokédex and
// the free ball on Route 31 is behind a roadblock that only the egg lifts.
$('#errand').onclick = async () => {
  if (!boot) return;
  await runTask('#errand', 'off to Mr. Pokémon\u2019s', () => boot.eggErrand());
};

// --- hunt -------------------------------------------------------------------
// The list is rebuilt from where you are standing and what time the game thinks
// it is, because both change under you: walk to another route, or let the clock
// tick past dusk, and the answer is different.
let speciesKey = '';

function refreshBag(s) {
  const carried = (s.balls || []).filter(([, q]) => q > 0);
  // Preference order matches the desktop pilot's: the cheapest ball that will
  // do, so a Master Ball is never spent on a Rattata by accident.
  const best = ['poke ball', 'great ball', 'ultra ball'];
  let pick = null;
  for (const name of best) {
    const hit = carried.find(([id]) => normalise(romdata.itemName(id)) === name);
    if (hit) { pick = hit; break; }
  }
  if (!pick) pick = carried[0] || null;
  ballId = pick ? pick[0] : null;
}

async function refreshSpecies(s) {
  if (!romdata) return;
  const tod = (await gb.readBytes(symbols.addr('wTimeOfDay'), 1))[0];
  const key = `${s.map[0]}.${s.map[1]}:${tod}`;
  if (key === speciesKey) return;
  speciesKey = key;
  const here = romdata.wildOn(s.map[0], s.map[1], tod);
  const list = $('#species');
  list.textContent = '';
  if (!here.length) {
    list.innerHTML = '<span class="seen">nothing wild appears here — ' +
                     'stand on a route with grass</span>';
    huntWanted = null;
    return;
  }
  for (const name of here) {
    const b = document.createElement('button');
    b.textContent = name;
    b.onclick = () => {
      huntWanted = name;
      for (const other of list.children) other.classList.toggle('on', other === b);
      refresh();
    };
    list.appendChild(b);
  }
  // Whatever was being hunted may not live here.
  if (huntWanted && !here.includes(huntWanted)) huntWanted = null;
}

$('#hunt').onclick = async () => {
  if (!tasks || !huntWanted) return;
  const res = await runTask('#hunt', `looking for ${huntWanted}`,
    () => tasks.hunt(huntWanted, { regrass: () => boot.backToGrass() }));
  $('#seen').textContent = res && res.seen && res.seen.size
    ? 'seen: ' + [...res.seen.entries()].sort((a, b) => b[1] - a[1])
        .map(([n, c]) => `${n} x${c}`).join(', ')
    : '';
};

$('#catch').onclick = async () => {
  if (!tasks || !huntWanted || !ballId) return;
  const res = await runTask('#catch', `after ${huntWanted}`,
    () => tasks.catch_(huntWanted, ballId, { regrass: () => boot.backToGrass() }));
  progress(res
    ? Object.entries(res.stats).map(([k, v]) => `${k}=${v}`).join('  ') : '');
};


// --- speed ------------------------------------------------------------------
// Only the idle loop is affected. Tasks drive their own frames as fast as they
// can, which is what makes a grind worth starting.
const speedInput = $('#speed');
if (speedInput) {
  const showSpeed = () => {
    speed = SPEEDS[Number(speedInput.value)];
    $('#speedx').textContent = speed === SPEEDS[SPEEDS.length - 1]
      ? 'max' : speed + '×';
  };
  speedInput.addEventListener('input', showSpeed);
  showSpeed();
}

// --- tap the screen to walk there -------------------------------------------
// The overworld is drawn in 16x16 tiles, so the 160x144 screen is 10x9 of them
// and the player is always the one at (4, 4): the camera keeps them centred
// rather than clamping at map edges. That makes a tap a map coordinate, which
// the collision map can path to.
const SCREEN_TILES_X = 10, SCREEN_TILES_Y = 9;
const PLAYER_TILE_X = 4, PLAYER_TILE_Y = 4;
let A_MARK = null;          // addresses the marker tracker reads every frame

/**
 * Is a menu or textbox on screen?
 *
 * wWindowStackSize is pushed and popped by the game's own window code, so it
 * cannot be left over from a menu closed minutes ago -- unlike the menu cursor,
 * which keeps its last value out on the map. Walking while a menu is up would
 * send the D-pad to the cursor instead of the player.
 */
async function windowOpen() {
  const at = symbols.addr('wWindowStackSize');
  return (await gb.readBytes(at, 1))[0] > 0;
}

/**
 * Mark a destination, given where the player currently is.
 *
 * The marker has to follow the map, not the screen. The camera keeps the
 * player centred, so the world scrolls underneath while they walk -- a marker
 * left at the tile that was tapped would drift off the destination and end up
 * pointing at somewhere else entirely. Its screen position is therefore
 * recomputed from the goal's offset from the player, every step, and it
 * finishes underneath them.
 */
let markTimer = null;
let walkCancelled = false;
let markState = null;        // { goal, kx, ky } while a marker is on screen
let markRaf = null;

/**
 * Mark a destination on the map, and keep it there.
 *
 * The hard part is that the marker has to sit on a *map* tile while the screen
 * scrolls, and the player's coordinate is the wrong thing to derive that from.
 * Measured frame by frame: the camera starts sliding at frame 11 of a step and
 * has moved the full 16 pixels by frame 22, but wXCoord does not change until
 * frame 23 -- so for almost the whole of every step the coordinate says the
 * player has not moved while the world visibly has. A marker placed from the
 * coordinate therefore stands still while the map slides out from under it,
 * which is exactly what it looks like: the marked spot drifting away.
 *
 * wPlayerBGMapOffsetX/Y is the camera itself, and it moves smoothly. At rest it
 * is `48 - 16 * coordinate`, so the difference between the resting value for
 * the current coordinate and the live one is how far into the step the camera
 * has scrolled. That difference is small and taken modulo 256, so it stays
 * correct however far the offset has wrapped over a long walk.
 */
function markGoal(goal) {
  const mark = $('#tapmark');
  if (!goal) {
    markState = null;
    if (markRaf !== null) { cancelAnimationFrame(markRaf); markRaf = null; }
    mark.classList.add('hide');
    return;
  }
  markState = { goal, k: null };
  if (markRaf === null) markRaf = requestAnimationFrame(trackGoal);
}

/** Signed distance from a resting camera offset to the live one, in tiles. */
function cameraFraction(rest, live) {
  let d = (rest - live) & 0xff;
  if (d > 127) d -= 256;
  return d / 16;
}

async function trackGoal() {
  markRaf = null;
  if (!markState || !gb.ready) return;
  const mark = $('#tapmark');
  try {
    const lo = Math.min(A_MARK.y, A_MARK.offX);
    const hi = Math.max(A_MARK.x, A_MARK.offY);
    const w = await gb.readBytes(lo, hi - lo + 1);
    const at = (a) => w[a - lo];
    const x = at(A_MARK.x), y = at(A_MARK.y);
    const offX = at(A_MARK.offX), offY = at(A_MARK.offY);
    // The resting offset is captured once, from a player who is standing still,
    // rather than assuming the constant is the same on every map.
    if (markState.k === null) {
      markState.k = { x: (offX + 16 * x) & 0xff, y: (offY + 16 * y) & 0xff };
    }
    const k = markState.k;
    const camX = x + cameraFraction((k.x - 16 * x) & 0xff, offX);
    const camY = y + cameraFraction((k.y - 16 * y) & 0xff, offY);
    const tx = markState.goal[0] - camX + PLAYER_TILE_X;
    const ty = markState.goal[1] - camY + PLAYER_TILE_Y;
    if (tx <= -1 || ty <= -1 || tx >= SCREEN_TILES_X || ty >= SCREEN_TILES_Y) {
      mark.classList.add('hide');     // scrolled out of view
    } else {
      mark.style.left = (tx * 100 / SCREEN_TILES_X) + '%';
      mark.style.top = (ty * 100 / SCREEN_TILES_Y) + '%';
      mark.classList.remove('hide');
    }
  } catch (e) { /* a read can fail across a map load; try again next frame */ }
  if (markState) markRaf = requestAnimationFrame(trackGoal);
}

async function walkToTap(tx, ty) {
  // Deliberately stays in playing mode. This sets `running` -- the idle loop
  // must stand down and no task may start on top of it -- but it does not call
  // setMode: a walk lasts a couple of seconds, and reordering the page under a
  // thumb that just tapped it would be worse than the dimming is worth.
  running = true;
  let arrived = false;
  // The previous walk's marker is cleared on a timer. Without cancelling it,
  // tapping again inside that window let the old timer fire mid-route and hide
  // the marker for the walk now under way.
  clearTimeout(markTimer);
  $('#go').disabled = true;
  gb.releaseAll();
  syncHeld();
  try {
    // Which tile a tap meant is only answerable once the world has stopped
    // moving. Mid-step the coordinate lags the screen by up to a whole tile --
    // measured, seven frames of every twenty-six -- so a tap taken during one
    // walks you a tile short of where you aimed.
    if (gb.ready) await nav.settle();
    const wram = await gb.readWram();
    const s = state.read(wram);
    if (s.inBattle) { setStatus('that is a battle, not the map', 'bad'); return; }
    if (!s.worldLoaded) { setStatus('no map on screen to walk on', 'bad'); return; }
    if (await windowOpen()) { setStatus('close the menu first', 'bad'); return; }

    const goal = [s.pos[0] + tx - PLAYER_TILE_X, s.pos[1] + ty - PLAYER_TILE_Y];
    if (goal[0] === s.pos[0] && goal[1] === s.pos[1]) {
      setStatus('you are already standing there', '');
      return;
    }
    // Checked against the game's own wPlayerTileCollision every time rather
    // than once at startup: a wrong decode does not throw, it paths through
    // walls, and the tileset changes with the map.
    if (!collision.calibrate(wram)) {
      setStatus('could not read the map — the collision decode did not check out',
                'bad');
      return;
    }
    // Bounds come from the map, not just from zero: tapping past the edge of a
    // small indoor room is off the map, and saying "no way to reach" there
    // blames the route for a tile that does not exist.
    const [mw, mh] = collision.mapSize();
    if (goal[0] < 0 || goal[1] < 0 || goal[0] >= mw || goal[1] >= mh) {
      setStatus('that is off the edge of the map', 'bad');
      return;
    }
    if (!collision.pathTo(s.pos, goal)) {
      setStatus(`no way to reach (${goal[0]},${goal[1]}) from here`, 'bad');
      progress('ledges are one-way, and some tiles only open up the long way round');
      return;
    }
    setStatus(`walking to (${goal[0]},${goal[1]})`, 'busy');
    markGoal(goal);
    walkCancelled = false;
    const res = await nav.walkTo(collision, goal, {
      onStep: (n, at) => progress(`step ${n} — at (${at[0]},${at[1]})`),
      cancelled: () => walkCancelled,
    });
    const now = res.pos;
    const where = `(${now[0]},${now[1]})`;
    if (res.stopped === null) {
      arrived = true;
      setStatus(`walked to ${where}`, 'ok');
      progress('');
    } else if (res.stopped === 'cancelled') {
      setStatus(`stopped at ${where}`, '');
      progress('');
    } else if (res.stopped === 'battle') {
      setStatus(`a wild battle interrupted the walk at ${where}`, 'bad');
    } else if (res.stopped === 'unreachable') {
      setStatus(`could not get past ${where}`, 'bad');
      progress('ledges are one-way, and some tiles only open up the long way round');
    } else if (res.stopped === 'refused') {
      setStatus(`the game would not let me move from ${where}`, 'bad');
      progress('something is happening on screen, or someone is standing there');
    } else if (res.stopped === 'warped') {
      const m = res.map;
      setStatus(m === undefined
        ? 'that was a doorway — you are somewhere else now'
        : `through the doorway to ${boot ? boot.where(m) : 'somewhere else'}`, 'ok');
      progress('');
    } else if (res.stopped === 'decode') {
      setStatus('lost track of the map mid-walk, so it stopped', 'bad');
    } else {
      setStatus(`gave up at ${where}`, 'bad');
    }
  } finally {
    // The marker outlives the walk by a moment, because arriving is worth
    // seeing -- but only when we arrived. A goal is a tile on one map, so after
    // a doorway it points at whatever happens to be there now, and after a
    // failure it marks a place we never reached.
    if (arrived) {
      markTimer = setTimeout(() => markGoal(null), 1800);
    } else {
      markGoal(null);
    }
    running = false;
    $('#go').disabled = false;
    refresh();
  }
}

$('#screen').addEventListener('click', (e) => {
  if (running || !gb.ready) return;
  const r = e.currentTarget.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const tx = Math.min(SCREEN_TILES_X - 1,
                      Math.floor((e.clientX - r.left) / r.width * SCREEN_TILES_X));
  const ty = Math.min(SCREEN_TILES_Y - 1,
                      Math.floor((e.clientY - r.top) / r.height * SCREEN_TILES_Y));
  walkToTap(tx, ty);
});

$('#go').onclick = async () => {
  if (!tasks) return;
  // Handed a way to heal and a way back to grass, or it trains the party to
  // death, or paces off the grass and starves. Where a Pokémon Center is, and
  // where grass is, is map knowledge tasks.js deliberately does not carry.
  const res = await runTask('#go', `grinding to Lv${target}`,
    () => tasks.grind(0, target, {
      heal: () => boot.healUp(),
      regrass: () => boot.backToGrass(),
    }));
  progress(res
    ? Object.entries(res.stats).map(([k, v]) => `${k}=${v}`).join('  ') : '');
};

// --- the three that act on where you already are ----------------------------
// No parameters and no picking: each one reads the situation and either does
// the obvious thing or says why it cannot.
$('#battle').onclick = async () => {
  if (!tasks) return;
  const res = await runTask('#battle', 'fighting', () => tasks.battleHere());
  progress(res ? Object.entries(res.stats)
    .map(([k, v]) => `${k}=${v}`).join('  ') : '');
};

$('#catchhere').onclick = async () => {
  if (!tasks || !ballId) return;
  const res = await runTask('#catchhere', 'throwing',
                            () => tasks.catchHere(ballId));
  progress(res ? Object.entries(res.stats)
    .map(([k, v]) => `${k}=${v}`).join('  ') : '');
};

$('#heal').onclick = async () => {
  if (!boot) return;
  await runTask('#heal', 'off to heal', () => boot.healNow());
};

$('#stopRun').onclick = () => {
  // Reaches both kinds of work: the task flag, which a walk never reads, and
  // the walk flag, which a task never reads.
  if (tasks) tasks.cancel();
  walkCancelled = true;
  progress('stopping…');
};

// --- slots, undo, and importing a save ---------------------------------------

/**
 * Describe the game as it stands, for a slot row to show.
 *
 * Read at capture time rather than stored as a screenshot: a slot is worth
 * nothing if you cannot tell which one it is.
 */
async function describeGame() {
  const s = await tasks.snap();
  const lead = s.party[0];
  return {
    // The same namer the header uses, so a slot says "Route 29" rather than
    // the map numbers it is stored as.
    where: boot ? boot.where(s.map[0] * 256 + s.map[1]) : `map ${s.map.join('.')}`,
    lead: lead && romdata
      ? `${romdata.speciesName(lead.species)} Lv${lead.level}` : null,
    party: s.party.length,
  };
}

/**
 * Save the game and keep the result in the undo slot.
 *
 * Called before a pilot job. A slot is a save point, so taking one means
 * actually saving -- there is no cheaper snapshot available here, and the
 * honest consequence is that jobs which run inside a battle cannot have one.
 */
async function snapshotForUndo(label) {
  try {
    await keepUndoPoint(label);
  } catch (e) {
    // Belt and braces with the try in runTask: bookkeeping must never be the
    // reason the job you asked for does not happen.
    undoRefused = e && e.message ? e.message : String(e);
    progress(`no undo point: ${undoRefused}`);
    paintUndo();
  }
}

async function keepUndoPoint(label) {
  undoPoint = null;
  undoRefused = null;
  const can = await tasks.canSave();
  if (!can.ok) {
    // Kept, not just logged. The run log holds three lines and a job writes
    // more than that, so the reason scrolled away and the row went on saying
    // "nothing to undo yet" -- which reads as "no job has run" rather than
    // "this job is not undoable". Losing an undo point quietly is the whole
    // problem: you find out when you try to use it.
    undoRefused = can.why;
    progress(`no undo point: ${can.why}`);
    paintUndo();
    return;
  }
  const res = await tasks.saveGame();
  if (!res.ok) {
    undoRefused = res.message;
    progress(`no undo point: ${res.message}`);
    paintUndo();
    return;
  }
  savedThisSession = true;
  const where = await describeGame();
  const kept = await saves.capture(UNDO_SLOT, { ...where, job: label });
  if (kept.ok) {
    undoPoint = { ...where, job: label, when: kept.when };
    progress(`undo point kept before ${label}`);
  } else {
    undoRefused = kept.message;
    progress(`no undo point: ${kept.message}`);
  }
  paintUndo();
}

function describeSlot(meta) {
  if (!meta) return 'empty';
  const bits = [];
  if (meta.where) bits.push(meta.where);
  if (meta.lead) bits.push(meta.lead);
  if (meta.when) {
    const d = new Date(meta.when);
    bits.push(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
  }
  return bits.join(' \u00b7 ') || 'kept';
}

function paintUndo() {
  const row = $('#undostate'), btn = $('#undo');
  if (!row || !btn) return;
  if (!undoPoint) {
    row.textContent = undoRefused
      ? `the last job could not be undone \u2014 ${undoRefused}`
      : 'nothing to undo yet';
    btn.disabled = true;
    $('#job-undo').classList.add('blocked');
    return;
  }
  row.textContent = `back to before ${undoPoint.job} \u00b7 ${describeSlot(undoPoint)}`;
  btn.disabled = false;
  $('#job-undo').classList.remove('blocked');
}

/** Put the game back to a slot, and pick the save up at the title screen. */
async function loadSlot(slot, what) {
  return runTask('#undo', `loading ${what}`, async () => {
    const rec = await saves.read(slot);
    if (!rec || !rec.bytes) return { ok: false, message: `${what} is empty` };
    await saves.install(rec.bytes);
    if (!await tasks.continueFromTitle()) {
      return { ok: false, message: 'loaded the save but could not reach the world' };
    }
    const now = await describeGame();
    return { ok: true, message: `back at ${now.where}`
      + (now.lead ? ` with ${now.lead}` : '') };
  }, { needsWorld: false, takeUndoPoint: false });
}

async function paintSlots() {
  const host = $('#slotrows');
  if (!host || !saves) return;
  const all = await saves.list();
  host.textContent = '';
  for (const id of SLOT_IDS) {
    const meta = all[id];
    const row = document.createElement('div');
    row.className = 'slotrow';
    const name = document.createElement('span');
    name.className = 'sname';
    name.textContent = `Slot ${id}`;
    const stateEl = document.createElement('span');
    stateEl.className = 'sstate';
    stateEl.textContent = describeSlot(meta);
    const keep = document.createElement('button');
    keep.textContent = meta ? 'Replace' : 'Keep';
    keep.onclick = () => runTask('#savegame', `keeping slot ${id}`, async () => {
      const can = await tasks.canSave();
      if (!can.ok) return { ok: false, message: `cannot save: ${can.why}` };
      const saved = await tasks.saveGame();
      if (!saved.ok) return saved;
      savedThisSession = true;
      const where = await describeGame();
      const kept = await saves.capture(id, where);
      await paintSlots();
      return kept.ok
        ? { ok: true, message: `slot ${id}: ${describeSlot({ ...where, when: kept.when })}` }
        : kept;
    }, { takeUndoPoint: false });
    const load = document.createElement('button');
    load.textContent = 'Load';
    load.disabled = !meta;
    load.onclick = () => loadSlot(id, `slot ${id}`);
    row.append(name, stateEl, keep, load);
    host.append(row);
  }
}

$('#undo').onclick = async () => {
  if (!undoPoint) return;
  const res = await loadSlot(UNDO_SLOT, 'the undo point');
  if (res && res.ok) {
    undoPoint = null;
    paintUndo();
  }
};

/**
 * Bring a .sav in from somewhere else.
 *
 * Checked before it is installed, and checked for the right two things: the
 * length, and the cartridge's own save marker. A file that is neither is
 * refused with a reason -- installing it would re-load the ROM and leave the
 * player at a title screen with no save behind it, having lost what they had.
 */
$('#importsav').onchange = async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file || running) return;
  await runTask('#importsav', `loading ${file.name}`, async () => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length !== 32768) {
      return { ok: false, message:
        `${file.name} is ${bytes.length} bytes; a battery save is 32768` };
    }
    if (!state.saveIsPresent(bytes)) {
      return { ok: false, message: `${file.name} holds no save the game would load` };
    }
    await saves.install(bytes);
    if (!await tasks.continueFromTitle()) {
      return { ok: false, message: 'loaded the file but could not reach the world' };
    }
    savedThisSession = true;
    const now = await describeGame();
    await paintSlots();
    return { ok: true, message: `loaded ${file.name} \u2014 ${now.where}`
      + (now.lead ? ` with ${now.lead}` : '') };
  }, { needsWorld: false, takeUndoPoint: false });
};

// --- saving, and getting the save off the phone ------------------------------
$('#savegame').onclick = () => runTask('#savegame', 'saving', async () => {
  const r = await tasks.saveGame();
  if (r.ok) savedThisSession = true;
  return r;
});

/**
 * Hand the battery save over as a file.
 *
 * Read on the click rather than polled: it is 32KB, and the only moment its
 * contents matter is now. A battery with no save in it is refused -- such a
 * file loads as "no save file" in every emulator, so handing one over would
 * look like the download worked and the game had nothing in it, which is a
 * worse answer than saying the game has not been saved.
 *
 * The test is the cartridge's own two check bytes, not whether any byte is
 * non-zero: a never-saved battery has five non-zero bytes in it, so the
 * obvious test passes on a blank cartridge. Measured, having written the
 * obvious one first.
 */
$('#exportsav').onclick = async () => {
  if (running) return;
  try {
    const bytes = await gb.batterySave();
    if (!state.saveIsPresent(bytes)) {
      setStatus('no save data yet — save the game first', 'bad');
      return;
    }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const url = URL.createObjectURL(new Blob([bytes],
      { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `pokecrystal-${stamp}.sav`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked on a timer rather than immediately: Safari cancels an in-flight
    // download if the URL goes away while it is still reading it.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    setStatus(`downloaded ${a.download} (${bytes.length} bytes)`, 'ok');
  } catch (e) {
    setStatus(`could not read the save: ${e && e.message ? e.message : e}`, 'bad');
  }
};

// Dev convenience: with ?dev=1 the ROM and .sym are fetched from ./dev/ instead
// of being picked by hand, so the whole flow can be exercised by a test driver.
// That directory is gitignored -- no game files live in this repo.
(async () => {
  if (!DEV) return;
  try {
    const [rom, sym] = await Promise.all([
      fetch('./dev/pokecrystal.gbc').then((r) => r.arrayBuffer()),
      fetch('./dev/pokecrystal.sym').then((r) => r.text()),
    ]);
    romBytes = rom;
    symbols = new Symbols(sym);
    setStatus('dev files loaded', 'ok');
    maybeStart();
  } catch (e) {
    setStatus('dev auto-load failed: ' + e.message, 'bad');
  }
})();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// Exposed so the spike can be driven from a console or a test harness.
window.PILOT = {
  gb,
  get tasks() { return tasks; },
  get state() { return state; },
  get collision() { return collision; },
  get world() { return world; },
  get nav() { return nav; },
  get romdata() { return romdata; },
  get boot() { return boot; },
  walkToTap,
};
