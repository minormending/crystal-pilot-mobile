// Wiring: file pickers, the render loop, and dispatching a task.
import { readHeader } from '../gbcore/cartridge.js';
import { GameBoy } from '../gbcore/gb.js';
import { Symbols, sharedNames } from '../gen2/symbols.js';
import { describeHandoff, describeOffers, describeParty, describeReplaced,
         describeRoom, describeRows, describeScreen, describeSlot,
         describeTitle, describeUndo, joinFailure } from './rows.js';
import { VERSION } from '../gbcore/version.js';
import { forgetKept, keepBattery, keepRom, keepSym, keptMeta, readOpts, recall,
         sanitise, writeOpts } from '../gbcore/remember.js';
import { chosenName, needsOffer, openRoom, wasSharing } from '../gbcore/room.js';
import { createHost, createWatcher } from '../gbcore/stream.js';
import { Cancelled } from '../gbcore/taskbase.js';
import { REPLACED_SLOT, Saves, SLOT_IDS, UNDO_SLOT } from '../gbcore/saves.js';
import { GameState } from '../gen2/state.js';
import { Tasks } from '../gen2/tasks.js';
import { CollisionMap } from '../gen2/collision.js';
import { Nav } from '../gen2/nav.js';
import { RomData, normalise } from '../gen2/romdata.js';
import { engineFor } from '../titles/contract.js';
import { pickTitle, titleById } from '../titles/pick.js';
import { World } from '../gen2/world.js';

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
let collision = null, nav = null, romdata = null, boot = null, title = null;
let world;
let huntWanted = null;
let ballId = null;
// Frames advanced per animation frame while nobody is driving. The steps are
// powers of two because that is how it reads: 1x, 2x, 4x... and the last one is
// "as fast as it goes", which on a phone lands somewhere short of the label.
const SPEEDS = [1, 2, 4, 8, 16];
// The presets are read off the markup rather than listed again here, so there
// is one place they are written down and a remembered `+5` cannot outlive the
// button that offered it.
const GRIND_SPECS = [...document.querySelectorAll('[data-target]')]
  .map((b) => b.dataset.target);
const LIMITS = { speeds: SPEEDS.length, grinds: GRIND_SPECS };
// The choices in force: last session's to begin with, and whatever another of
// your devices has chosen since. Not a const any more, because a room can
// change it -- but still only ever written through adoptOptions, so there is
// one place where an option arriving from somewhere else is checked.
let wanted = readOpts(LIMITS);
// A room's options that arrived while a job was running. Never repaint under a
// thumb mid-task: the target moving while a grind runs is alarming, and the
// job is using the old value anyway.
let optionsPending = false;
// The room, once someone asks for one. Null until then, and null forever for
// anyone who never shares -- opening it is what reaches the network.
let room = null;
// The open in flight, so two callers share one room rather than racing to make
// two of them.
let roomOpening = null;
// Set when the Firebase SDK could not be fetched -- an offline first load.
let roomUnavailable = false;
// Showing this screen to another device, or watching one. Never both: a device
// that is watching has no game of its own to show.
let host = null, watcher = null;
// What the room last said about who is showing a screen, and who asked to see
// one. The handshake is three notes long and each device writes two of them.
let signal = {};
// True while the device we are watching says its screen is off. It cannot send
// a picture then -- a hidden page runs about one frame a second -- so it says
// so instead, and the row stops pretending.
let hostAsleep = false;
// Which note each side has already acted on. A room is a mailbox, not a
// stream: notes stay where they were left, so both devices see every note
// again on every change and would answer the same offer forever. Worse, a note
// left behind by a session that has since reloaded blocked the next one --
// measured, with a watcher that could never be offered a picture because an
// offer addressed to the device it used to be was still sitting there.
let offeredTo = null, offeredAt = 0, answeredAt = 0, acceptedAt = 0;
let watchTimer = null;
// The host re-stamps its announcement every 30s; anything older than this is a
// tab that has gone away without saying so.
const SHOWING_GOOD_FOR = 90000;
let showingTimer = null;
// The button names the on-screen pad offers, which is the only set a press
// arriving from another device is allowed to be. It comes from the markup for
// the same reason check-app reads it from there: that is where the canonical
// spelling lives.
const PAD_BUTTONS = new Set(
  [...document.querySelectorAll('[data-btn]')].map((b) => b.dataset.btn));
// What the room is holding, as metadata. Kept rather than asked for on every
// paint because a peek is cheap only if nothing unpacks the payload.
let sharedSave = null;
// Which cartridge this device has, as a short hash of the ROM. Travels with a
// published save so another device can refuse bytes from a different build:
// the addresses the pilot reads and the layout the save is written in both
// come out of the same build, and mixing them reads garbage confidently.
let romTag = '';
// Whether the remembered grind preset has been applied. It cannot be applied
// at load: `+2` means two above the lead, and there is no party until a game
// is running.
let grindRestored = false;
// A remembered battery, to be installed once the emulator is up. Set before
// maybeStart runs so that the one place which decides "are we in the world
// now?" can see it.
let pendingBattery = null;
// The boot in flight, so two callers share one start rather than racing.
let starting = null;
// The 1.2s repaint while nobody is driving. One of them, always.
let idleRefresh = null;
// Whether this session's files came out of the store rather than a file
// picker. It decides whether the app continues the game for you: a restored
// session is one you were already playing, and a reload you did not ask for
// should not cost you two presses. A hand-picked one is left at the title
// screen, where NEW GAME is -- the app's own bootstrap button aside, that
// menu is the only way to start a game, and continuing past it would leave
// nobody a way back to it.
let restoredSession = false;
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

/**
 * Hide the run log's card when there is no log and no offer in it.
 *
 * The status line used to live in this card and gave it a reason to exist at
 * all times. It does not any more, so on a quiet game the sheet opened onto an
 * empty white box -- which is worse than the clutter this step is removing.
 */
function paintStatusCard() {
  const empty = $('#runlog').classList.contains('hide')
                && $('#bootrow').classList.contains('hide');
  $('#statuscard').classList.toggle('hide', empty);
}

const setStatus = (text, kind = '') => {
  $('#dot').className = 'dot ' + kind;
  $('#status').textContent = text;
};

/**
 * Show one of the two panels over the screen, or neither.
 *
 * There are two doors and never two panels: the status line opens the menu, the
 * gear opens settings, and opening either closes the other. One `panel` value
 * rather than two open flags, because "both open" is a state with no meaning
 * that two booleans would let happen.
 *
 * The menu is open until a game is running, because until then it holds the
 * only two things there are to do -- read what this is, and pick the files --
 * and a door closed over an empty screen would be an app with nothing in it.
 * After that it is closed by default and by every job that starts: you asked
 * the pilot to do something, so the thing to look at is the game.
 *
 * The tablet and landscape layouts pin the menu open in CSS and hide its
 * chevron, so this still runs there and simply has nothing to move for 'menu'.
 */
let panel = 'menu';
function showPanel(which) {
  panel = which;
  $('#sheet').classList.toggle('open', which === 'menu');
  $('#setsheet').classList.toggle('open', which === 'settings');
  document.body.classList.toggle('menuopen', !!which);
  $('#door').setAttribute('aria-expanded', which === 'menu' ? 'true' : 'false');
  $('#chev').textContent = which === 'menu' ? 'Close ▾' : 'Menu ▴';
  $('#gear').setAttribute('aria-expanded',
                          which === 'settings' ? 'true' : 'false');
}
// The pilot's own account of what it is doing, kept rather than overwritten.
// It emits exactly the right events already -- "heading left", "healing up",
// "slot 1 is down - sending out slot 2" -- and a single label threw all but
// the last one away. Three lines is enough to see progress without the card
// growing under your thumb mid-run.
const RUN_LOG_LINES = 3;
let runLines = [];

const progress = (m) => {
  const log = $('#runlog');
  // The log itself is behind the door, which a job has just closed, so the
  // newest line is mirrored onto the bar. Without it a ninety-second job shows
  // one busy dot and no sign of progress.
  $('#steps').textContent = m || '';
  if (!m) {
    runLines = []; log.textContent = ''; log.classList.add('hide');
    paintStatusCard();
    return;
  }
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
  paintStatusCard();
};

/**
 * Resolve once the page is actually being looked at.
 *
 * There is one thing in this app that cannot be done in a hidden tab -- see
 * the ROM re-load in saves.install -- and this is how the wait is expressed
 * rather than each caller inventing it.
 */
function whenVisible() {
  if (!document.hidden) return Promise.resolve();
  return new Promise((resolve) => {
    const wake = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', wake);
      resolve();
    };
    document.addEventListener('visibilitychange', wake);
  });
}

/**
 * Boot the emulator, once, whoever asks.
 *
 * Idempotent because two callers can arrive together and did: the ROM picker
 * calls symbolsFromRoom() -- which starts the emulator itself when the room is
 * already offering the addresses -- and then called maybeStart() again on the
 * next line. That is the ordinary second-device path, and it ran two starts
 * concurrently: two gb.start(), two loadROM racing each other in a core that
 * will not take a second ROM while it is still coming up, two sets of tasks,
 * and two awaitWorld intervals polling for the rest of the session.
 *
 * The promise is held rather than a flag, so a caller that awaits gets the
 * same start rather than a resolved nothing.
 */
function maybeStart() {
  if (!romBytes || !symbols) return Promise.resolve();
  if (!starting) starting = reallyStart().finally(() => { starting = null; });
  return starting;
}

async function reallyStart() {
  setStatus('booting…', 'busy');
  // Which cartridge this is, before anything is built out of it: romdata wants
  // the wild tables this title declares, and the pilot itself is the title's
  // class. `?title=` names one by hand, for pointing the app at the generic
  // profile without going and finding a hack to test with.
  const wanted = PARAMS.get('title');
  title = (wanted && titleById(wanted))
          || pickTitle({ header: readHeader(romBytes), symbols, tag: romTag });
  await gb.start($('#screen'));
  await gb.loadRom(romBytes);
  // A title's own engine profile if it declares one, and the stock Gen 2
  // numbers if it does not -- which is every title that only moved the maps.
  // A patch on the stock numbers, not a replacement -- see engineFor.
  const engine = engineFor(title);
  state = new GameState(symbols, engine);
  // romdata first: the tasks are handed it at construction, and built
  // in the other order they were handed null -- which a hunt only finds
  // out about when it tries to name the first Pokemon it meets.
  romdata = new RomData(symbols, gb, title.encounters, engine);
  // Said rather than left to be discovered by an empty species list: without a
  // wild table there is nothing to hunt or catch, and every other job is fine.
  if (!romdata.grass.length) {
    progress(`no wild tables in this .sym (${title.id}) — hunting and catching `
             + 'are unavailable, everything else works');
  }
  tasks = new Tasks(gb, state, progress, romdata);
  saves = new Saves(gb, state, romdata, progress);
  collision = new CollisionMap(symbols, gb);
  nav = new Nav(gb, symbols);
  world = new World(symbols, gb);
  boot = new title.drive(gb, state, tasks, collision, nav, progress, world);
  A_MARK = {
    x: symbols.addr('wXCoord'), y: symbols.addr('wYCoord'),
    offX: symbols.addr('wPlayerBGMapOffsetX'),
    offY: symbols.addr('wPlayerBGMapOffsetY'),
  };

  // Hand the game over immediately: buttons visible, emulator running.
  $('#loader').classList.add('hide');
  $('#intro').classList.add('hide');
  $('#ctrls').classList.remove('hide');
  $('#speedbox').classList.remove('hide');
  $('#huntcard').classList.remove('hide');
  $('#savecard').classList.remove('hide');
  paintSlots();
  paintUndo();
  $('#screenwrap').classList.remove('hide');
  $('#taphint').classList.remove('hide');
  // There is something to look at now, so the menu gets out of the way.
  showPanel(null);
  startLoop();

  paintFiles();
  // A safety net, not the usual path: the three places a ROM arrives each take
  // the fingerprint, because the digest needs it before this function runs.
  // Adding a fourth and forgetting would cost nothing visible on the device
  // that has the .sym file and everything on the device that does not, so this
  // is the backstop for a mistake that would otherwise be invisible here.
  if (romBytes && !romTag) romTag = fingerprintRom(romBytes);
  // Slots belong to a cartridge. Set after the backstop above rather than at
  // construction, because that is the first line where the fingerprint is
  // certain to exist.
  saves.tag = romTag;
  // Said once, and only when it is worth saying: a cartridge the pilot has no
  // description of behaves correctly in a way that reads as broken.
  const known = describeTitle(title);
  $('#titlerow').classList.toggle('hide', !known.show);
  $('#titlestate').textContent = known.text;
  shareSymbols();

  // A battery that came back with the files, put in through the same path a
  // .sav import uses: write the library's record and re-load the ROM. That
  // path is the one that was watched putting a real save into a real game,
  // and this is the same job without the file picker.
  if (pendingBattery) {
    const bytes = pendingBattery;
    pendingBattery = null;
    // Not while nobody is looking. Installing re-loads the ROM, which goes
    // through the library's pause() and waits on an animation frame a hidden
    // page never gets -- so saves.install refuses outright rather than
    // hanging. And a hidden page is not a corner case here: a phone restoring
    // a background tab is one of the ordinary ways this app is opened, and
    // measured in a hidden pane the restore did nothing at all while the
    // settings row went on saying the save was kept.
    //
    // The status is set before the wait rather than after it. On a page nobody
    // is looking at that is written for nobody, but "booting…" left standing
    // would be a lie the moment the page is looked at again.
    setStatus('your game is waiting to be put back…', 'busy');
    await whenVisible();
    setStatus('putting your game back…', 'busy');
    try {
      // Installing re-loads the ROM, and a core still coming up will not take
      // one -- see gb.awake. Nothing else in the app asks for a re-load this
      // early, which is why this is the only caller.
      await gb.awake();
      await saves.install(bytes);
    } catch (e) {
      // Through the log, not the status line: awaitWorld writes the status a
      // moment later, and a message about a save that did not come back must
      // not be the one that gets overwritten.
      progress(`the kept save could not be loaded: ${e.message}`);
    }
  }

  if (AUTOSTART) {
    setStatus('starting the game…', 'busy');
    if (!await tasks.continueGame()) {
      setStatus('could not reach the overworld — is this a Crystal ROM?', 'bad');
      return;
    }
  } else if (restoredSession && await saveIsInCartridge()) {
    setStatus('carrying on where you left off…', 'busy');
    if (!await tasks.continueFromTitle()) {
      progress('your game is on the cartridge — press Start to continue');
    }
  }
  awaitWorld();
}

/**
 * A short fingerprint of the ROM in hand.
 *
 * Arithmetic rather than `crypto.subtle`, and that is the whole point of this
 * function. Subtle crypto exists only in a secure context, and this app is
 * *told* to be served over plain HTTP on a home network -- the README says so.
 * There, `crypto.subtle` is undefined, the fingerprint came back empty, and an
 * empty tag is not "unknown" to anything downstream: `tag && seen.tag && ...`
 * and baton's own check both read it as "matches anything", so a save from a
 * different build would install without a word and every address the pilot
 * reads afterwards would be wrong.
 *
 * The other reason is worse: even a *fallback* would break matching. A phone
 * on Pages hashing with SHA-256 and a laptop on http hashing with something
 * else describe the same cartridge differently and refuse each other's saves.
 * One algorithm everywhere is the only shape that works.
 *
 * So: FNV-1a over the whole file, in two 32-bit halves, sixteen hex characters.
 * Not a cryptographic hash and it does not need to be -- this separates two
 * builds of one disassembly, it does not defend against anyone. Measured at
 * 8ms for this 2MB ROM, once per session.
 */
function fingerprintRom(buffer) {
  const bytes = new Uint8Array(buffer);
  let lo = 0x811c9dc5, hi = 0x01000193;
  for (let i = 0; i < bytes.length; i++) {
    lo = Math.imul(lo ^ bytes[i], 0x01000193) >>> 0;
    // A second lane, seeded and stepped differently, so the two halves are not
    // the same number twice: one 32-bit hash over a 2MB file collides more
    // often than anyone wants to think about.
    if (i % 2 === 0) hi = Math.imul(hi ^ (bytes[i] + i), 0x85ebca6b) >>> 0;
  }
  return lo.toString(16).padStart(8, '0') + hi.toString(16).padStart(8, '0');
}

/**
 * Is there a save in the cartridge to carry on from?
 *
 * The gate on continuing for you, and it has to be a gate: continueFromTitle
 * presses START and then A, which is CONTINUE when a save exists and NEW GAME
 * when it does not -- and that lands in the NAME menu, where the only thing an
 * auto-pilot can do is spell AAAAA. Starting a game stays the player's.
 *
 * Asked of the cartridge rather than of what this session installed, because
 * the library pushes its own record in on every ROM load: a restored session
 * can arrive with a save that nothing in this session put there, and it is
 * just as much a game to carry on from.
 */
async function saveIsInCartridge() {
  try {
    return state.saveIsPresent(await gb.batterySave());
  } catch (e) {
    return false;      // an unreadable battery is not one to press A at
  }
}

/**
 * Say what is being kept on this phone, from the record rather than from what
 * a write here believed.
 *
 * Painted from `keptMeta` because a write can fail -- a full phone, a browser
 * that refuses storage -- and a row claiming the files are kept when they are
 * not would send someone into a reload expecting their game back.
 */
async function paintFiles() {
  const el = $('#filestate'), btn = $('#forget');
  if (!el) return;
  const meta = await keptMeta();
  if (!meta || !meta.romName || !meta.symName) {
    el.textContent = 're-picked each session';
    btn.classList.add('hide');
    return;
  }
  const mb = meta.romBytes ? ` · ${(meta.romBytes / 1048576).toFixed(1)} MB` : '';
  el.textContent = `${meta.romName}, ${meta.symName}`
    + (meta.battery ? ' and your last save' : '') + mb;
  btn.classList.remove('hide');
}

/**
 * Copy the battery out of the cartridge, if there is a save in it.
 *
 * Called when the app knows the bytes have just moved -- a save it drove, a
 * .sav it installed, a slot it loaded -- rather than on a timer. There is no
 * event for "the game saved" in a browser, and polling 32KB forever to catch
 * something the app itself caused would be silly.
 */
async function keepGame() {
  if (!gb.rom || !state) return false;
  try {
    const bytes = await gb.batterySave();
    if (!state.saveIsPresent(bytes)) return false;
    const ok = await keepBattery(bytes);
    paintFiles();
    await shareGame(bytes);
    return ok;
  } catch (e) {
    return false;
  }
}

/**
 * Put this device's save in the room, if there is a room.
 *
 * Called from the one place that already knows the bytes just moved, which is
 * the only honest moment to publish: there is no event for "the game saved" in
 * a browser, and a timer would either miss saves or upload the same one over
 * and over.
 *
 * A room that refuses the payload is not an error worth interrupting anyone
 * for -- the save is still on this device, kept -- but it must be *said*, or
 * the other device will sit there showing an older game with no explanation.
 */
async function shareGame(bytes) {
  if (!room) return;
  let says = '';
  try {
    const now = await describeGame();
    says = now.lead ? `${now.where} · ${now.lead}` : now.where;
  } catch (e) {
    // Mid-title, or no party yet. A save with no description is still a save.
  }
  const said = await room.publishSave(bytes, says, romTag);
  if (!said.ok) {
    progress(said.reason === 'too-big'
      ? `this save is ${said.chars} characters packed, over the ${said.cap} a room holds — it stays on this device`
      : `could not share this save: ${said.reason}`);
    return;
  }
  // The revision is stored beside the bytes it belongs to, so this device can
  // tell "the same save" from "also a save" when it looks at the room again.
  await keepBattery(bytes, { rev: said.rev });
  paintHandoff();
}

/**
 * Hand this device's addresses to the room, for one that has no .sym.
 *
 * Only the names this app reads -- 45 of them, about a kilobyte, against the
 * 1.8MB file they were parsed out of. The fingerprint goes with them because
 * an address is only true of the build it came from.
 *
 * Plus whichever wild tables this cartridge's title declares, because that list
 * is the title's and `SHARED_SYMBOLS` is the app's. A hack that renamed its
 * encounter table would have handed the other device a digest with the two
 * Johto names in it and not the one it actually uses -- and the second device
 * would boot, walk, save, and quietly have nothing to hunt, which is the shape
 * of failure this whole list exists to prevent.
 */
function shareSymbols() {
  // `title` last, and it is not a formality. The room can open while the files
  // are being picked -- `romTag` is set the moment a ROM arrives, `symbols` the
  // moment a .sym does, and `title` not until reallyStart runs -- so there is a
  // real window where the first three are true and the fourth is not. Publishing
  // in it would send a digest built from the app's list alone, which is Crystal's
  // two wild tables and not the hack's; and because the room keeps the *newer*
  // digest, that one would displace a correct digest already sitting in it. So a
  // device that does not yet know what it is holding says nothing, and says it a
  // moment later instead: reallyStart calls this again with the title in hand.
  if (!room || !symbols || !romTag || !title) return;
  const names = sharedNames(title);
  // Not from a digest we were given: passing one on would spread a set of
  // addresses further than the cartridge that vouched for them.
  if (symbols.size > names.length) {
    room.shareSymbols(symbols.digest(names), romTag);
  }
}

/**
 * Take the addresses from the room, if this device has the ROM and no .sym.
 *
 * The fingerprint is checked first and the digest is checked after: a set of
 * addresses from another build reads memory that looks plausible and is not,
 * and a short digest from an older build of this app would fail later, deep
 * inside a task, rather than here.
 */
function symbolsFromRoom() {
  if (symbols || !romBytes || !romTag || !room) return false;
  const offered = room.symbols();
  if (!offered || !offered.map) return false;
  if (offered.tag !== romTag) {
    setStatus('your other device shared addresses for a different ROM', 'bad');
    return false;
  }
  try {
    const from = Symbols.fromDigest(offered.map);
    from.require(NEEDED_SYMBOLS);
    symbols = from;
  } catch (e) {
    setStatus(`the shared addresses are not usable: ${e.message}`, 'bad');
    return false;
  }
  setStatus(`symbols: ${symbols.size} addresses from your other device`, 'ok');
  // Caught, because this is the one path where the addresses were not read off
  // a file this device chose. A digest missing something the app reads throws
  // from inside maybeStart -- and unhandled, that leaves "booting…" on screen
  // for good with the reason only in the console. Measured, by shipping a
  // digest that was short of ItemNames.
  maybeStart().catch((e) => {
    symbols = null;
    setStatus(`the shared addresses are incomplete: ${e && e.message ? e.message : e}`,
              'bad');
  });
  return true;
}

/**
 * Copy the game this device is holding into the reserved slot.
 *
 * Only what the cartridge already has: a battery with no save in it is not a
 * game anyone loses. Failure is not worth stopping a handoff for -- the undo
 * point is still there for the next few minutes -- but it is worth saying.
 */
async function keepReplaced() {
  if (!saves || !state || !gb.rom) return false;
  try {
    const bytes = await gb.batterySave();
    if (!state.saveIsPresent(bytes)) return false;
    const where = await describeGame();
    const kept = await saves.capture(REPLACED_SLOT, where);
    if (!kept.ok) progress(`could not keep the replaced game: ${kept.message || ''}`);
    return kept.ok;
  } catch (e) {
    progress(`could not keep the replaced game: ${e.message}`);
    return false;
  }
}

/** Offer the replaced game back, for as long as there is one. */
async function paintReplaced() {
  const row = $('#job-replaced');
  if (!row || !saves) return;
  const all = await saves.list();
  const said = describeReplaced(all[REPLACED_SLOT], romTag);
  row.classList.toggle('hide', !said.show);
  if (said.show) $('#replacedstate').textContent = said.text;
}

$('#restorereplaced').onclick = () => loadSlot(REPLACED_SLOT, 'the replaced game');

// --- showing this screen to your other device --------------------------------
//
// The picture goes straight between the two devices; the room only introduces
// them. Three notes, and each device writes two of them: the watcher asks, the
// host offers, the watcher answers. Then the notes are cleared, because a
// stale offer in a room is an introduction to a connection that no longer
// exists.

/** Who is showing a screen right now, as far as the room knows. */
// What the host last said about this device's pad, while watching. Starts as
// "yes" so a connection that is working needs no message to look right, and the
// host sends one the moment the channel opens anyway.
let remoteInput = { ok: true, why: null };
// Whether a watching device may press the pad. The host's decision, kept here
// rather than asked of the watcher: a watcher that chose not to send would be
// honour-system, and the thing that has to be able to say no is the end that
// owns the joypad.
let letsPlay = true;

/**
 * Tell the watching device whether its pad is doing anything right now.
 *
 * Two reasons it might not be, and the watcher cannot work out either on its
 * own: view-only is a decision on this device, and a pilot job holds the
 * joypad for as long as it runs. Sent on the data channel rather than through
 * the room because it changes while someone is looking at it -- a debounced
 * room write would dim their pad a second late, or a second after it came back.
 */
function tellInput() {
  if (!host) return;
  const ok = letsPlay && !running;
  host.tell({ t: 'input', v: ok, why: ok ? null : (letsPlay ? 'busy' : 'view') });
}

function screenState() {
  const fresh = signal.showing
    && Date.now() - (signal.showing.at || 0) < SHOWING_GOOD_FOR;
  const showing = fresh ? signal.showing : null;
  const mine = showing && room && showing.id === room.id;
  return {
    hosting: !!host,
    watching: !!watcher,
    host: showing && !mine ? showing.by : null,
    viewer: host && signal.watching ? signal.watching.by : null,
    asleep: hostAsleep,
    // This device's own decision while hosting; the other device's
    // advertisement while watching. The note carries it so a watcher knows
    // before it has a connection to be told over.
    play: host ? letsPlay : !(showing && showing.play === false),
    input: watcher ? remoteInput : null,
  };
}

function paintScreen() {
  const row = $('#screenrow'), btn = $('#screenshare');
  if (!row) return;
  // A pad that cannot act should not look like it can -- the same rule the
  // pilot's list is built on, and the same dimming a running job uses.
  document.body.classList.toggle('noinput', !!watcher && !remoteInput.ok);
  // Keyed on being *in* a room, not on having opened one. leaveRoom() detaches
  // kidsync but leaves the handle in hand, so `room` stays truthy after Stop --
  // and this row went on offering to show a screen into a room this device had
  // just left.
  row.classList.toggle('hide', !(room && room.code));
  const said = describeScreen(screenState());
  $('#screenstate').textContent = said.text;
  btn.textContent = said.button;
  // Only where there is a choice to make. Watching is somebody else's decision
  // to change, so the second control is not drawn there at all.
  $('#screenmode').classList.toggle('hide', !said.second);
  if (said.second) $('#screenmode').textContent = said.second;
}

/**
 * Start showing this screen.
 *
 * Announced rather than connected: there is nobody to connect to yet. The
 * offer is made when a device asks, because an offer is only good for the one
 * device it was made for.
 */
function showScreen({ play = true } = {}) {
  if (!room) return;
  letsPlay = play;
  host = createHost({
    canvas: $('#screen'),
    onInput: applyRemoteInput,
    // The first moment there is anyone to tell. A view-only session that says
    // nothing looks like a playable one until something changes.
    onReady: tellInput,
    onStatus: (st) => {
      if (st === 'failed' || st === 'closed') progress('the watching device dropped');
      paintScreen();
    },
  });
  // Anything left over from a session that has since reloaded is cleared with
  // the same write that announces this one: a stale offer is an introduction
  // to a connection that no longer exists.
  offeredTo = null;
  offeredAt = 0;
  answeredAt = 0;
  acceptedAt = 0;
  const announce = () => room.signal(
    { showing: { id: room.id, by: room.device, play: letsPlay } });
  room.signal({ showing: { id: room.id, by: room.device, play: letsPlay },
                offer: null, answer: null, watching: null });
  // Repeated, because a note in a room outlives the tab that wrote it. A host
  // that is closed, reloaded or discarded by the phone leaves "iPhone is
  // showing its screen" standing for ever, and pressing Watch then waits
  // fifteen seconds for an offer nobody is left to make. A stamp every half
  // minute, and a reader that ignores anything older than SHOWING_GOOD_FOR,
  // means the row stops offering on its own.
  clearInterval(showingTimer);
  showingTimer = setInterval(announce, 30000);
  paintScreen();
  progress('showing this screen — press Watch on your other device');
}

/**
 * Stop showing, or stop watching -- and withdraw only this device's own note.
 *
 * One function for both roles, which is fine until it comes to what to clear.
 * It used to clear everything, so a watcher pressing Leave withdrew the *host's*
 * announcement: the phone went on showing its screen, its own row still said so,
 * and no device could discover it again short of Stop and Show. What each side
 * owns is what each side withdraws.
 */
async function stopScreen() {
  clearTimeout(watchTimer);
  const wasHosting = !!host, wasWatching = !!watcher;
  if (host) { host.stop(); host = null; }
  if (watcher) { watcher.stop(); watcher = null; }
  clearInterval(showingTimer);
  showingTimer = null;
  hostAsleep = false;
  remoteHeld.clear();
  $('#remote').classList.add('hide');
  $('#screen').classList.remove('hide');
  // Awaited, because the caller may be about to leave the room: leaveRoom()
  // unsubscribes immediately, and a withdrawal still in the debounce goes with
  // it -- leaving the other device offering to watch a screen that has gone
  // until the freshness window closes ninety seconds later.
  if (room && wasHosting) {
    await room.signal({ showing: null, offer: null, answer: null });
  } else if (room && wasWatching) {
    await room.signal({ watching: null });
  }
  gb.releaseAll();
  syncHeld();
  paintScreen();
}

/** Ask the device that is showing to include this one. */
function watchScreen() {
  if (!room || !signal.showing) return;
  // A connection that is going to work is up in a second or two on the same
  // wifi. One still trying after this is one that needs a relay nobody here
  // is running, and saying so beats a spinner: across networks, and behind
  // some routers, this does not connect at all.
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    if (watcher && watcher.state !== 'connected') {
      progress('could not reach the other device — this works on one wifi, and '
        + 'across networks it often will not');
    }
  }, 15000);
  // Every watch starts from a clean answer. A previous session's "view only"
  // left over would grey the pad of a host that is handing it over.
  remoteInput = { ok: true, why: null };
  watcher = createWatcher({
    onTrack: (stream) => {
      const v = $('#remote');
      v.srcObject = stream;
      v.classList.remove('hide');
      $('#screen').classList.add('hide');
      $('#screenwrap').classList.remove('hide');
      $('#ctrls').classList.remove('hide');
      paintScreen();
    },
    onTell: (msg) => {
      if (!msg) return;
      if (msg.t === 'asleep') { hostAsleep = !!msg.v; paintScreen(); }
      // Whether this device's pad reaches the game, and which of the two
      // reasons it does not. Anything held when the answer turns to no is let
      // go here as well as there: the host has already dropped it, and a
      // button left lit says a game is being played that cannot be reached.
      if (msg.t === 'input') {
        remoteInput = { ok: !!msg.v, why: msg.why || null };
        if (!remoteInput.ok) { remoteHeld.clear(); syncHeld(); }
        paintScreen();
      }
    },
    onStatus: (st) => {
      if (st === 'failed') {
        progress('could not reach the other device — same wifi works, across '
          + 'networks may not');
      }
      if (st === 'failed' || st === 'closed' || st === 'disconnected') {
        // Whatever was under a thumb when the connection went is not held by
        // anything any more, and a button left lit says a game is being played
        // that cannot be reached.
        remoteHeld.clear();
        syncHeld();
      }
      paintScreen();
    },
  });
  room.signal({ watching: { id: room.id, by: room.device } });
  paintScreen();
}

/**
 * A button from the device that is watching.
 *
 * Checked against the pad's own names, because this arrives over a room and an
 * unknown name would be handed to the core, which ignores it silently -- the
 * exact failure check-app exists to catch in this app's own code. And ignored
 * while a job is running, for the same reason the local pad is: the pilot owns
 * the joypad until it is finished.
 */
function applyRemoteInput(msg) {
  if (!host || !msg) return;
  if (msg.t === 'gone') { gb.releaseAll(); syncHeld(); return; }
  if (!PAD_BUTTONS.has(msg.b)) return;
  // The whole of view-only, and it belongs here: a press that arrives is a
  // press that was sent, so the only place the answer can be enforced is the
  // end holding the joypad. Anything already down is let go, because a button
  // held at the moment the pad is taken away stays held for ever otherwise.
  if (!letsPlay) { gb.releaseAll(); syncHeld(); return; }
  if (running) return;
  if (msg.t === 'hold') gb.hold(msg.b);
  else if (msg.t === 'release') gb.release(msg.b);
  syncHeld();
}

/**
 * Work through whatever the room is saying about screens.
 *
 * Both sides run this on every change, and each acts only on the note addressed
 * to it -- which is why the handshake needs no ordering beyond "is this for
 * me?".
 */
async function onSignal(rtc) {
  signal = rtc || {};
  paintScreen();
  if (!room) return;
  const me = room.id;
  try {
    // Host: somebody is asking for an introduction that has not been made.
    // Keyed on the ask rather than on the asker -- see needsOffer, and the two
    // branches below, which were already keyed that way. Both fields are set
    // before the await, so a room change arriving mid-offer does not start a
    // second one.
    if (host && needsOffer(signal.watching, { to: offeredTo, at: offeredAt })) {
      offeredTo = signal.watching.id;
      offeredAt = signal.watching.at || Date.now();
      answeredAt = 0;
      acceptedAt = 0;
      const offer = await host.offer();
      room.signal({ offer: { to: offeredTo, sdp: offer } });
      return;
    }
    // Watcher: an offer addressed to this device that it has not answered.
    if (watcher && signal.offer && signal.offer.to === me
        && (signal.offer.at || 0) > answeredAt) {
      answeredAt = signal.offer.at || Date.now();
      const answer = await watcher.answer(signal.offer.sdp);
      room.signal({ answer: { from: me, sdp: answer } });
      return;
    }
    // Host: the answer to the offer it actually made. After this the picture is
    // flowing and the notes are litter -- but `showing` stays, because that is
    // what tells a third device there is a screen to ask for.
    if (host && signal.answer && signal.answer.from === offeredTo
        && (signal.answer.at || 0) > acceptedAt) {
      acceptedAt = signal.answer.at || Date.now();
      await host.accept(signal.answer.sdp);
      room.signal({ offer: null, answer: null });
    }
  } catch (e) {
    progress(`could not set up the picture: ${e && e.message ? e.message : e}`);
  }
}

$('#screenshare').onclick = () => {
  const said = describeScreen(screenState());
  if (said.button === 'Show') showScreen();
  else if (said.button === 'Watch') watchScreen();
  else stopScreen();      // nothing waits on it here; the room is staying open
};

/**
 * Hand the pad over, or take it back.
 *
 * Two jobs in one button, because they are the same decision made at different
 * times: before showing it chooses how to start, and while showing it changes
 * this device's mind. The watching device is told twice over -- the room note
 * for the row it draws, and the channel for the pad it is holding.
 */
$('#screenmode').onclick = () => {
  if (!host) { showScreen({ play: false }); return; }
  letsPlay = !letsPlay;
  // Anything held when the pad is taken away would stay held for ever.
  if (!letsPlay) { gb.releaseAll(); syncHeld(); }
  if (room) room.signal({ showing: { id: room.id, by: room.device, play: letsPlay } });
  tellInput();
  paintScreen();
};

// A hidden page runs about one frame a second, so a host that goes away says
// so rather than sending a still picture and letting the other end guess.
document.addEventListener('visibilitychange', () => {
  if (host) host.tell({ t: 'asleep', v: document.hidden });
});

/** Say what the room is holding, and offer to take it if it is ahead. */
async function paintHandoff() {
  const row = $('#handoffrow'), btn = $('#takeover');
  if (!row) return;
  if (!room || !room.code) { row.classList.add('hide'); return; }
  const meta = await keptMeta();
  const said = describeHandoff({
    seen: sharedSave,
    rev: (meta && meta.rev) || 0,
    tag: romTag,
  });
  // Only the two states worth interrupting for. This row is on the status line
  // now, which is the one thing always on screen -- "in step" sitting there all
  // session is the noise the rest of this interface just stopped making.
  row.classList.toggle('hide', !said.urgent);
  $('#handoffstate').textContent = said.text;
  btn.textContent = said.button || 'Take over';
  btn.classList.toggle('hide', !said.button);
}

/**
 * Take the save the other device shared, and carry on from it.
 *
 * Through runTask with an undo point, unlike the .sav and slot paths: those
 * are a person choosing bytes they can see, and this is bytes chosen on
 * another device, possibly hours ago. The undo point is the local game -- one
 * press back if this was not what you wanted.
 */
$('#takeover').onclick = () => runTask('#takeover', 'taking the shared save',
  async () => {
    if (!room) return { ok: false, message: 'not sharing' };
    const got = await room.takeSave(romTag);
    if (!got.ok) {
      return { ok: false, message: got.reason === 'tag'
        ? 'that save was made with a different ROM'
        : `nothing to take: ${got.reason}` };
    }
    // The game about to be replaced, kept where the next job cannot reach it.
    // runTask has already taken an undo point, but the undo slot is written
    // before *every* job -- one grind after a handoff you did not want and it
    // is gone. This slot is only ever written here.
    await keepReplaced();
    await saves.install(got.bytes);
    if (!await tasks.continueFromTitle()) {
      return { ok: false, message: 'installed it but could not reach the world' };
    }
    // Only now. Everything above this line can fail -- install refuses on a
    // hidden page -- and a claim made before it lands is one the room cannot
    // take back: the other device would read "they are playing now" while this
    // one still had its old game.
    room.baton.claim();
    // The revision that came back with the bytes, not the one last painted:
    // the room can move between a row being drawn and a button being pressed,
    // and recording the older number makes this device believe it is behind a
    // save it is already holding.
    await keepBattery(got.bytes, { rev: got.rev });
    savedThisSession = true;
    await paintSlots();
    paintFiles();
    // After the revision is stored, not before: the row compares the two, and
    // painting it first left it saying the other device was still ahead.
    await paintHandoff();
    const now = await describeGame();
    const said = `took ${got.by}'s save — ${now.where}`
      + (now.lead ? ` with ${now.lead}` : '');
    // Into the log as well as the status line, because the idle refresh writes
    // "ready" over the status a second later. The one case where even the log
    // does not keep it is a device that had no game at all until this moment:
    // awaitWorld is still clearing both every tick while it waits for a world,
    // and it gets its wish half a second after this line. The handoff row is
    // the durable statement either way.
    progress(said);
    return { ok: true, message: said };
  }, { needsWorld: false, takeUndoPoint: true });

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
  // Only a title that has a scripted intro offers to play one. A cartridge
  // nobody has described has no `run`, and a button that throws is worse than a
  // button that is not there -- the same rule the offers list is built on.
  const scripted = typeof boot.run === 'function';
  $('#bootrow').classList.toggle('hide', !scripted);
  $('#bootnote').classList.toggle('hide', !scripted);
  paintStatusCard();
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
  // Not while the pilot is mid-hand-off. This loop's job is to notice that a
  // world exists, and one does the moment the bootstrap reaches Elm's lab --
  // so without this it tidied away the very button offering to finish the
  // trip, and overwrote "your turn - pick a starter" with "ready".
  if (bootStage !== 'grass') {
    $('#bootrow').classList.add('hide');
    $('#bootnote').classList.add('hide');
    paintStatusCard();
    setStatus('ready', 'ok');
    progress('');
  }
  refresh();
  // Cleared first: this used to be a fresh interval per call to awaitWorld, and
  // two of those poll twice as often for ever. maybeStart is idempotent now, so
  // this is the belt to that pair of braces.
  clearInterval(idleRefresh);
  idleRefresh = setInterval(() => { if (!running) refresh(); }, 1200);
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
  // Asking for a job is asking to watch it. Only one way: a job that ends does
  // not re-open the menu, because the person may well be reading the screen.
  if (piloting) showPanel(null);
  // A watching device's pad stops working for as long as this runs, and it has
  // no way to know that unless it is told.
  tellInput();
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
    // Stop is not a failure. It unwinds as a thrown sentinel so that a press
    // lands immediately rather than after whatever loop was running finishes,
    // and it arrives here when it interrupts a primitive -- the jobs handle the
    // tidier case themselves and return their own message.
    if (e instanceof Cancelled) {
      setStatus('stopped', 'ok');
      return null;
    }
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
/**
 * Put a row's description on screen.
 *
 * The decision of what it should say is in rows.js; this only applies it. The
 * `blocked` class and the disabled button always agree because they are set
 * from the same flag, which they did not always -- one row read its own
 * button's disabled property back out of the DOM to decide.
 */
/**
 * One row: what it says, whether its button works, and whether it reads as live.
 *
 * `lit` separates the two meanings that `enabled` used to carry. A row can be
 * unable to start its own job and still be the thing to press -- Catch with no
 * balls offers the errand -- and greying that row's name out while accenting
 * the button next to it says two opposite things at once.
 */
function paintRow(row, stateSel, buttonSel, rowSel) {
  $(stateSel).textContent = row.text;
  if (buttonSel) $(buttonSel).disabled = !row.enabled;
  if (rowSel) $(rowSel).classList.toggle('blocked', !(row.enabled || row.lit));
}

const JOB_ROWS = {
  grind: ['#grindstate', '#go', '#job-grind'],
  hunt: ['#huntstate', '#hunt', '#job-hunt'],
  catch: ['#catchstate', '#catch', '#job-catch'],
  heal: ['#healstate', '#heal', '#job-heal'],
};

function paintJobs(s) {
  // `canFetch` is a title question, not a game one: the errand that gets the
  // first Poké Balls is a scripted walk to particular places, and a cartridge
  // nobody has described has no such walk.
  const ctx = { rom: romdata, target, huntWanted, ballId, savedThisSession,
                healPlace, canFetch: typeof boot.eggErrand === 'function',
                engine: state.e };
  const rows = describeRows(s, ctx);
  const offers = describeOffers(s, ctx);

  // The pilot's rows are reordered and hidden rather than rebuilt. Every one of
  // them keeps its id, its handler and its place in check-app's wiring check;
  // what changes is which are drawn and in what order, which is the whole of
  // the difference between presenting six things and offering three.
  for (const [key, [state, button, row]] of Object.entries(JOB_ROWS)) {
    const rank = offers.rank[key];
    $(row).classList.toggle('hide', rank === undefined);
    $(row).classList.toggle('lead', rank === 1);
    $(row).style.order = rank === undefined ? '' : rank;
    // The accent follows the ranking rather than sitting on Grind forever.
    // Grind wore it in the markup, which was true of a fixed list and became a
    // lie the moment the list could put something else first.
    $(button).classList.toggle('primary', rank === 1);
    if (rank !== undefined) {
      paintRow(key === 'catch' && rows.catch.needsBalls
                 ? { ...rows.catch, lit: true } : rows[key],
               state, button, row);
    }
  }
  $('#offerhint').textContent = offers.hint;

  // The picker and the presets belong to the jobs that read them. In a battle
  // neither job is on the list, so neither control has anything to change.
  const picking = offers.rank.hunt !== undefined || offers.rank.catch !== undefined;
  $('#pick').hidden = !picking;
  $('#seen').hidden = !picking;
  $('#levels').hidden = !rows.grind.levels || offers.rank.grind === undefined;

  // The battle's own two actions, beside the pad rather than behind the door.
  // Throw explains itself only when it cannot be pressed: its own line reads
  // "PIDGEY Lv3 - POKE BALL" when it works, which is the foe said twice.
  $('#battlebar').classList.toggle('hide', !s.inBattle);
  const why = rows.here.enabled ? '' : rows.here.text;
  paintRow({ ...rows.battle, text: why ? '' : rows.battle.text },
           '#battlestate', '#battle');
  paintRow({ ...rows.here, text: why }, '#herestate', '#catchhere');
  // Catch shows one of two buttons, so the accent has to go to whichever one
  // is actually on the screen.
  const leadsWithCatch = offers.rank.catch === 1;
  $('#errand').classList.toggle('hide', !rows.catch.needsBalls || !ctx.canFetch);
  $('#errand').classList.toggle('primary', leadsWithCatch && rows.catch.needsBalls);
  $('#catch').classList.toggle('hide', rows.catch.needsBalls);
  $('#catch').classList.toggle('primary', leadsWithCatch && !rows.catch.needsBalls);

  paintRow(rows.save, '#savestate', '#savegame', '#job-save');
  paintRow(rows.export, '#exportstate');
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
  // Nothing to summarise and nothing to expand: the hint under the offers
  // already says that most jobs want a Pokemon along.
  $('#panel').classList.toggle('hide', !s.party.length);
  $('#leadline').textContent = describeParty(s, { rom: romdata });
  $('#party').innerHTML = s.party.length
    ? s.party.map(monRow).join('')
    : '<span class="seen">no party yet</span>';
  await refreshSpecies(s);
  if (romdata) refreshBag(s);
  // Remembered so the relative presets have something to be relative to.
  lastLead = s.party.length ? s.party[0].level : null;
  // Options that arrived from another device while a job was running.
  if (optionsPending && !running) applyWanted();
  // Last session's preset, applied the moment it means something and then
  // never again -- re-applying on every refresh would drag the target back
  // every time the person chose differently.
  if (!grindRestored && wanted.grind && s.party.length) {
    grindRestored = true;
    pickTarget(wanted.grind, false);
  }
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

// What a .sym has to contain to be this game's. Hoisted out of the picker
// because a kept file comes back a different way and has to meet the same bar:
// a record written by an older build, or one truncated by a phone that ran out
// of room mid-write, must fail here rather than deep inside a task.
const NEEDED_SYMBOLS = [
  'wPartyCount', 'wPartyMon1', 'wBattleMode', 'wMapGroup',
  'wMapStatus', 'wMenuCursorY', 'wPlayerTileCollision',
  // tap-to-walk: the collision map and the window stack
  'wOverworldMapBlocks', 'wMapWidth', 'wMapHeight',
  'wTilesetCollisionBank', 'wTilesetCollisionAddress',
  'wWindowStackSize', 'CollisionPermissionTable',
  'wPlayerBGMapOffsetX', 'wPlayerBGMapOffsetY',
  // hunting: the names come out of the ROM. The wild tables do too, and are
  // deliberately *not* here -- which table holds them is a fact about a
  // cartridge's regions, so it is the title's to name and this gate would
  // otherwise refuse a hack for the crime of not being Johto. A cartridge with
  // none of its title's tables loses the species picker and keeps everything
  // else, which reallyStart says out loud.
  'PokemonNames', 'wTimeOfDay',
];

$('#romFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const buf = await f.arrayBuffer();
  if (!readHeader(buf).ok) {
    romBytes = null;
    setStatus(`${f.name} is not a Game Boy ROM — expected a .gbc built from ` +
              `the disassembly`, 'bad');
    return;
  }
  romBytes = buf;
  romTag = fingerprintRom(buf);
  setStatus(`ROM: ${f.name} (${(buf.byteLength / 1048576).toFixed(1)} MB)`, 'ok');
  // A ROM with no symbol file is half a pilot -- unless another of your devices
  // has already put the addresses in the room.
  symbolsFromRoom();
  // Kept before the emulator is handed it, not after: the core takes the bytes
  // and there is no promise that the buffer this side of it stays readable.
  keepRom(f.name, buf).then(paintFiles);
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
    symbols.require(NEEDED_SYMBOLS);
    setStatus(`symbols: ${symbols.size.toLocaleString()} loaded`, 'ok');
    keepSym(f.name, text).then(paintFiles);
  } catch (err) {
    symbols = null;
    setStatus(err.message, 'bad');
    return;
  }
  maybeStart();
});

// The targets people actually pick, two of them relative to the party, rather
// than four buttons and up to four taps to say "Lv10".
//
/**
 * Aim a grind at what a preset means right now.
 *
 * The spec is what is remembered, never the level it works out to. `+2` means
 * two above the lead, and the lead next session will not be the lead this one
 * ended with -- so storing the 12 it resolved to today would come back
 * tomorrow meaning something the person never chose.
 */
function pickTarget(spec, remember = true) {
  const lead = lastLead || 5;
  target = spec.startsWith('+')
    ? Math.min(100, lead + Number(spec.slice(1)))
    : Number(spec);
  target = Math.max(2, Math.min(100, target));
  for (const other of $('#levels').querySelectorAll('button')) {
    other.classList.toggle('on', other.dataset.target === spec);
  }
  if (remember) saveOption({ grind: spec });
}

document.querySelectorAll('[data-target]').forEach((b) => {
  b.onclick = () => {
    pickTarget(b.dataset.target);
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
// What this device is holding down while it is driving another one. The local
// emulator's own held set is empty then -- there is no game here to hold a
// button on -- so without this a press on a watching device lights nothing, and
// the page-wide tap highlight is switched off, so it gives no sign at all. That
// is the exact failure the comment above describes, arriving by a door it did
// not have when it was written.
const remoteHeld = new Set();

function syncHeld() {
  const held = watcher ? remoteHeld : gb.held;
  for (const el of document.querySelectorAll('[data-btn]')) {
    el.classList.toggle('held', held.has(el.dataset.btn));
  }
}

function hold(button) {
  if (running) return;
  // Watching means this device has no game: the joypad belongs to the one that
  // does. The same two functions every pad and key already go through, so
  // nothing else in the app has to know which machine it is talking to.
  if (watcher) {
    // The host refuses these anyway; not sending them is what keeps the pad
    // from lighting up as though they had landed. The guarantee is still the
    // host's -- this is only the same answer, given a frame earlier.
    if (!remoteInput.ok) return;
    watcher.press({ t: 'hold', b: button });
    remoteHeld.add(button);
    syncHeld();
    return;
  }
  gb.hold(button);
  syncHeld();
}

function release(button) {
  if (watcher) {
    watcher.press({ t: 'release', b: button });
    remoteHeld.delete(button);
    syncHeld();
    return;
  }
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
      paintStatusCard();
    }
    return;
  }
  const res = await runTask('#boot', 'out to the grass', () => boot.toGrass());
  if (res && res.ok) {
    $('#bootrow').classList.add('hide');
    $('#bootnote').classList.add('hide');
    paintStatusCard();
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
      saveOption({ hunt: name });
      markSpecies(list);
      refresh();
    };
    list.appendChild(b);
  }
  // Whatever was being hunted may not live here.
  if (huntWanted && !here.includes(huntWanted)) huntWanted = null;
  // Last session's quarry, but only where it can actually be found and only
  // when nothing is chosen -- so this restores a choice and never overrides
  // one. The list is rebuilt whenever the map or the hour changes, which is
  // exactly when "is it here?" has a new answer.
  if (!huntWanted && wanted.hunt && here.includes(wanted.hunt)) {
    huntWanted = wanted.hunt;
  }
  markSpecies(list);
}

/** One source for which button is lit: whatever `huntWanted` says. */
function markSpecies(list) {
  for (const b of list.children) {
    b.classList.toggle('on', b.textContent === huntWanted);
  }
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
// At module scope rather than inside the block below, because an option
// arriving from another device has to be able to repaint this too.
function showSpeed() {
  if (!speedInput) return;
  speed = SPEEDS[Number(speedInput.value)];
  $('#speedx').textContent = speed === SPEEDS[SPEEDS.length - 1]
    ? 'max' : speed + '×';
}
if (speedInput) {
  if (wanted.speed !== null) speedInput.value = String(wanted.speed);
  speedInput.addEventListener('input', showSpeed);
  // Written on `change` rather than `input`: dragging the slider fires input
  // for every step it passes through, and there is no reason to write four
  // records on the way to the fifth.
  speedInput.addEventListener('change',
    () => saveOption({ speed: Number(speedInput.value) }));
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
  //
  // The watching device is a different matter, and not calling setMode is
  // exactly how it got missed: setMode is where tellInput lives, so a tap here
  // took the remote pad away without a word. Locally that is invisible, because
  // the person who took it is the person who tapped. On the other device it is a
  // pad that looks live, sends nothing, and comes back on its own.
  running = true;
  tellInput();
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
    tellInput();
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

$('#door').onclick = () => showPanel(panel === 'menu' ? null : 'menu');
$('#gear').onclick = () => showPanel(panel === 'settings' ? null : 'settings');
// The log's card starts empty, and nothing paints it until a job runs.
paintStatusCard();

$('#stopRun').onclick = () => {
  // Reaches both kinds of work: the task flag, which a walk never reads, and
  // the walk flag, which a task never reads.
  if (tasks) tasks.cancel();
  walkCancelled = true;
  progress('stopping…');
};

// --- which build this is -----------------------------------------------------

/**
 * Show the running version, and whether the server has a newer one.
 *
 * The version comes from the module, so it is the identity of the code actually
 * executing. The comparison comes from the network, because that is the only
 * way to answer "am I behind?" -- and being behind without knowing it is how
 * you end up chasing a bug that was fixed two deploys ago.
 *
 * The service worker fetches network-first now, so a reload normally does pick
 * up a new build. Normally is not always: the browser's own HTTP cache can
 * still hand back a module, which cost me most of a day before it was
 * understood. So this both tells you and offers to do something about it.
 *
 * Called once at load, and the display lives in the header, because the
 * question is asked *before* a game is loaded at least as often as during one:
 * you deploy, open the app, and want to know whether the phone in your hand is
 * running what you just pushed. It used to run from maybeStart and write into
 * the settings card, so answering that meant picking a 2MB ROM and a symbol
 * file first -- to read a number the app already knew on the first frame.
 *
 * The wording is short because that row already holds the app's name, where
 * you are and the speed slider, and 375px does not fit a sentence as well. Up
 * to date says nothing, so it says nothing; the two states worth words are a
 * newer version and a server that did not answer.
 */
async function showVersion() {
  const el = $('#version'), btn = $('#update');
  if (!el) return;
  // Written before the fetch, not after it: the running version is known here
  // and now, and there is no reason to show an em dash while the network
  // decides. What comes back can only add to it.
  el.textContent = VERSION;
  el.classList.remove('stale');
  btn.classList.add('hide');
  try {
    const text = await (await fetch('./sw.js', { cache: 'no-store' })).text();
    const live = text.match(/crystal-pilot-(v\d+)/);
    if (!live) return;
    if (live[1] !== VERSION) {
      el.textContent = `${VERSION} \u2192 ${live[1]}`;
      el.classList.add('stale');
      btn.classList.remove('hide');
    }
  } catch (e) {
    // Offline is not an error worth shouting about; the version still shows.
    el.textContent = `${VERSION} \u00b7 offline`;
  }
}

/**
 * Throw away everything cached and reload.
 *
 * Deliberately heavy-handed. A plain reload is what did not work for the person
 * pressing this, so it unregisters the worker, deletes every cache, and only
 * then reloads -- which is exactly the sequence I ended up typing by hand over
 * and over while working on this app.
 *
 * The ROM is untouched: it lives in the page, never in a cache, and is picked
 * again next session anyway.
 *
 * It asks first when a game is loaded, which it did not need to when it sat in
 * the settings card two screens down. Beside the app's name it is a thumb's
 * width from the title, and what it does is close the game.
 *
 * What that costs has changed twice, so the question is built from what is
 * true now rather than from a sentence written once. When the files are kept,
 * the reload brings them and the last save back and the cost is the current
 * moment -- steps since you saved, a battle in progress. When they are not,
 * it is that plus two file pickers.
 *
 * The earlier version of this said the battery save survives a reload. It does
 * not, and that was worth measuring rather than assuming: the library persists
 * a cartridge only when something asks it to, and its own store held zero
 * records after a save this app had verified byte for byte. The save is kept
 * because this file keeps it now.
 */
$('#update').onclick = async () => {
  const btn = $('#update');
  if (romBytes) {
    const meta = await keptMeta();
    const kept = meta && meta.romName && meta.battery;
    if (!confirm(kept
      ? 'Update now? The game closes and comes back at your last save. '
        + 'Anything since then is lost.'
      : 'Update now? The game closes and the ROM has to be picked again. '
        + 'Anything not kept in a slot is lost.')) return;
    // The moment before a reload the app is causing is the one moment worth
    // spending 32KB on unasked.
    await keepGame();
  }
  btn.disabled = true;
  btn.textContent = 'updating…';
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch (e) {
    // Even if clearing fails, a reload is still worth a try.
  }
  location.reload();
};

showVersion();

/**
 * Throw away the files and the save kept on this phone.
 *
 * Asks, because this is the one control here that destroys something: the kept
 * battery can be the only copy of a game if no slot was taken and no .sav was
 * downloaded. The slots are in a different database and are not touched, which
 * the question says, because "forget my files" should not read as "wipe
 * everything".
 */
$('#forget').onclick = async () => {
  const meta = await keptMeta();
  const alsoSave = meta && meta.battery ? ' and the saved game beside them' : '';
  if (!confirm(`Forget ${meta && meta.romName ? meta.romName : 'the ROM'} and the `
    + `symbol file${alsoSave}? You will pick them again next time. `
    + 'Your slots are kept.')) return;
  await forgetKept();
  paintFiles();
  progress('the files are no longer kept on this phone');
};

// --- sharing between your own devices ----------------------------------------
//
// One person, several devices, no accounts: a room code is the whole mechanism.
// This is the small half of it -- the three remembered options -- and it exists
// first because it proves the whole path with nothing at stake. If a slider
// position can cross between two phones, so can a save.

/**
 * Remember one option locally, and tell the room if there is one.
 *
 * The local write happens either way. remember.js is the source of truth and
 * works with no network, no room, and no Firebase config at all; the room is
 * a layer on top that can be absent forever.
 */
function saveOption(patch) {
  writeOpts(patch);
  wanted = { ...wanted, ...patch };
  // All three, not just the one that changed: the merge picks a whole group by
  // its stamp, so a half group would be a state neither device ever had.
  if (room) room.share(readOpts(LIMITS));
}

/**
 * Take options from somewhere that is not this device.
 *
 * Through the same sanitise() a stored record goes through, and for a stronger
 * reason: this came from another device, which may be running an older build.
 * A remembered `+3` is a preset this build dropped; a remote one is a preset
 * another build still offers.
 */
function adoptOptions(raw) {
  const clean = sanitise(raw, LIMITS);
  // An empty group is not a choice anybody made. A room nobody has written to
  // answers with one, and adopting it would clear this device's options at the
  // moment it joined -- which is exactly what happened the first time this ran.
  if (clean.speed === null && clean.grind === null && clean.hunt === null) return;
  // And an older group loses. Both devices stamp what they chose when they
  // chose it, so this is the same comparison the room's own merge makes,
  // repeated here because onChange also fires for this device's own writes.
  if (clean.at < wanted.at) return;
  if (clean.speed === wanted.speed && clean.grind === wanted.grind
      && clean.hunt === wanted.hunt) return;
  wanted = clean;
  // The room is this device's memory now too, so a reload keeps what arrived,
  // and it keeps *their* stamp rather than taking a new one here.
  writeOpts(clean);
  optionsPending = true;
  if (!running) applyWanted();
}

/**
 * Put the options in force in front of the person.
 *
 * Only when no job is running. A target or a quarry changing under a thumb
 * mid-task is alarming, and the task is holding the old value anyway -- so a
 * pending change waits for the next quiet refresh instead.
 */
function applyWanted() {
  optionsPending = false;
  if (speedInput && wanted.speed !== null) {
    speedInput.value = String(wanted.speed);
    showSpeed();
  }
  if (wanted.grind && lastLead !== null) pickTarget(wanted.grind, false);
  if (wanted.hunt !== huntWanted) {
    // Dropped rather than switched: refreshSpecies owns the rule about what can
    // be hunted where and when, and clearing its key makes it rebuild and
    // re-select *through* that rule rather than around it.
    huntWanted = null;
    speciesKey = '';
  }
}

/**
 * Say what the loader card still needs.
 *
 * A device that has joined a room where the addresses are already shared needs
 * one file, not two -- and it had no way of knowing that. It asked for both,
 * took the ROM, and then silently started, which reads like a bug even when it
 * is the feature working.
 */
function paintLoader() {
  const note = $('#loadernote');
  if (!note) return;
  const offered = room && room.symbols();
  note.textContent = offered
    ? 'Just the ROM — your other device is sharing the addresses.'
    : 'Pick the ROM first; the symbol file can follow.';
}

/** Say what sharing is doing, from rows.js so the four states can be tested. */
function paintRoom() {
  paintHandoff();
  paintLoader();
  paintScreen();
  const nameRow = $('#namerow');
  if (nameRow) {
    nameRow.classList.toggle('hide', !(room && room.code));
    if (room) $('#devicename').placeholder = room.device;
  }
  const said = describeRoom({
    status: room ? room.status : (roomUnavailable ? 'unavailable' : 'local'),
    code: room ? room.code : null,
  });
  $('#roomstate').textContent = said.text;
  const btn = $('#share');
  btn.textContent = said.button || 'Share';
  btn.classList.toggle('hide', !said.button);
  $('#joinrow').classList.toggle('hide', !said.joining);
}

/**
 * Open the room, once. Nothing before this touches the network.
 *
 * Deliberately lazy: someone who never shares never loads the Firebase SDK,
 * never signs in anonymously, and cannot be broken by either. That is also why
 * room.js imports kidsync dynamically -- see the note at the top of it.
 */
async function ensureRoom() {
  if (room) return room;
  // The promise is held, not just the result. Two callers arriving while the
  // first is still opening -- the startup call for a device that has shared
  // before, and a press a second later -- would each run createSync, and the
  // second initializeApp with the same name throws `app/duplicate-app`.
  // kidsync catches that and falls back to local-only, so the row would say it
  // was sharing while nothing was ever sent or received.
  if (roomOpening) return roomOpening;
  roomOpening = openRoom({
    options: readOpts(LIMITS),
    onOptions: adoptOptions,
    onSave: (seen) => { sharedSave = seen; paintHandoff(); },
    // A digest can arrive after the ROM was picked, so this is a second chance
    // rather than only a first one.
    onSymbols: () => { paintLoader(); symbolsFromRoom(); },
    onSignal,
    onStatus: paintRoom,
  }).then((opened) => {
    room = opened;
    if (!room) roomUnavailable = true;
    paintRoom();
    // Both directions, because either device may be the one that has the file.
    shareSymbols();
    symbolsFromRoom();
    return room;
  }).finally(() => { roomOpening = null; });
  return roomOpening;
}

$('#share').onclick = async () => {
  const btn = $('#share');
  btn.disabled = true;
  try {
    if (room && room.code) {
      // The screen first. The room is what introduced those two devices, so
      // leaving it while a picture is flowing left the pad on a watching device
      // still sending presses down a channel with no room behind it, and no
      // way back except pressing Leave on a row that had lost its meaning.
      if (host || watcher) await stopScreen();
      room.stop();
      progress('this device has stopped sharing — your options are kept');
    } else {
      const r = await ensureRoom();
      if (!r) { progress('sharing needs a connection'); return; }
      const code = await r.start();
      r.share(readOpts(LIMITS));
      progress(`sharing as ${code} — type that on your other device`);
    }
  } catch (e) {
    progress(`could not start sharing: ${e && e.message ? e.message : e}`);
  } finally {
    btn.disabled = false;
    paintRoom();
  }
};

$('#rename').onclick = () => {
  if (!room) return;
  const said = room.rename($('#devicename').value);
  $('#devicename').value = '';
  paintRoom();
  progress(`your other devices will call this one ${said}`);
};

$('#joingo').onclick = async () => {
  const btn = $('#joingo'), input = $('#joincode');
  btn.disabled = true;
  try {
    const r = await ensureRoom();
    if (!r) { progress('sharing needs a connection'); return; }
    const got = await r.join(input.value);
    if (!got.ok) { progress(joinFailure(got.reason)); return; }
    input.value = '';
    progress(`sharing as ${got.code}`);
  } catch (e) {
    // The sibling above has always had this. joinRoom answers rather than
    // throwing for every failure it expects -- a wrong code is a normal thing
    // to type -- but attaching to the room is a live network call, and a
    // `finally` alone turned a throw into a button that came back enabled with
    // nothing said. Silence is the one answer a press must never get.
    progress(`could not join: ${e && e.message ? e.message : e}`);
  } finally {
    btn.disabled = false;
    paintRoom();
  }
};

// Painted once at load, because the markup can only hold one of the four states
// and the honest one before anything happens is "not sharing, here is how".
if ($('#devicename') && chosenName()) $('#devicename').placeholder = chosenName();
paintRoom();
// A device that has shared before picks the room up again on its own; one that
// never has stays entirely local, network included.
if (wasSharing()) {
  // Caught, because nothing is waiting on this one. openRoom answers null for
  // the failures it expects, but a rejection from inside createSync would
  // otherwise surface as an unhandled promise rather than as the row this app
  // already has words for.
  ensureRoom().catch(() => { roomUnavailable = true; paintRoom(); });
}

// A debounced write is lost if the tab goes away inside the window, and a phone
// closes tabs without asking. kidsync's own advice.
addEventListener('pagehide', () => {
  // Withdrawn rather than left to time out: the other device can stop offering
  // to watch a screen that is closing right now instead of in ninety seconds.
  if (room && host) room.signal({ showing: null });
  if (room) room.sync.flush();
});

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

function paintUndo() {
  const row = $('#undostate'), btn = $('#undo');
  if (!row || !btn) return;
  paintRow(describeUndo(undoPoint, undoRefused), '#undostate', '#undo', '#job-undo');
}

/** Put the game back to a slot, and pick the save up at the title screen. */
async function loadSlot(slot, what) {
  return runTask('#undo', `loading ${what}`, async () => {
    const rec = await saves.read(slot);
    if (!rec || !rec.bytes) return { ok: false, message: `${what} is empty` };
    // The same refusal the handoff has always made, for the same reason: a save
    // written by another build loads and is then confidently wrong. Only when
    // both sides know their cartridge -- a slot kept before slots recorded one
    // is loaded as it always was.
    if (romTag && rec.tag && rec.tag !== romTag) {
      return { ok: false,
               message: `${what} was made with a different ROM` };
    }
    await saves.install(rec.bytes);
    if (!await tasks.continueFromTitle()) {
      return { ok: false, message: 'loaded the save but could not reach the world' };
    }
    await keepGame();
    const now = await describeGame();
    return { ok: true, message: `back at ${now.where}`
      + (now.lead ? ` with ${now.lead}` : '') };
  }, { needsWorld: false, takeUndoPoint: false });
}

async function paintSlots() {
  paintReplaced();
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
    stateEl.textContent = describeSlot(meta, romTag);
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
      await keepGame();
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
    await keepGame();
    const now = await describeGame();
    await paintSlots();
    return { ok: true, message: `loaded ${file.name} \u2014 ${now.where}`
      + (now.lead ? ` with ${now.lead}` : '') };
  }, { needsWorld: false, takeUndoPoint: false });
};

// --- saving, and getting the save off the phone ------------------------------
$('#savegame').onclick = () => runTask('#savegame', 'saving', async () => {
  const r = await tasks.saveGame();
  if (r.ok) {
    savedThisSession = true;
    await keepGame();
  }
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

/**
 * Start from what was kept, if anything was.
 *
 * This is the whole point of keeping the files: the app opens and the game is
 * there, rather than opening on a card asking for two files you have to go and
 * find. It runs before nothing and after nothing -- there is no ROM in the
 * page at load, so either this finds one or the loader card is the right thing
 * to be looking at.
 *
 * `?dev=1` wins, because a dev run is deliberately reading ./dev/ and a kept
 * ROM from an earlier session would silently take its place.
 */
(async () => {
  if (DEV) return;
  const kept = await recall();
  if (!kept) return;
  setStatus(`opening ${kept.rom.name}\u2026`, 'busy');
  try {
    if (!readHeader(kept.rom.buffer).ok) {
      throw new Error(`${kept.rom.name} is not a Game Boy ROM`);
    }
    symbols = new Symbols(kept.sym.text);
    symbols.require(NEEDED_SYMBOLS);
    romBytes = kept.rom.buffer;
    romTag = fingerprintRom(kept.rom.buffer);
    pendingBattery = kept.battery;
    restoredSession = true;
  } catch (e) {
    // A record this build cannot use is not something to argue with: drop it
    // and let the loader card ask, which is where the person already is.
    symbols = null;
    romBytes = null;
    setStatus('the kept files could not be read — pick them again', 'bad');
    await forgetKept();
    paintFiles();
    return;
  }
  maybeStart();
})();

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
    romTag = fingerprintRom(rom);
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
  // Exposed for the same reason as the rest of this object: so the version
  // check can be driven and watched rather than reasoned about.
  showVersion,
  // Same again for the picture. A connection either carries frames or does
  // not, and the only way to know which is to ask the connection -- from a
  // console, or from whatever is driving the two devices in a test.
  get host() { return host; },
  get watcher() { return watcher; },
};
