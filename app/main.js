// Wiring: file pickers, the render loop, and dispatching a task.
import { GameBoy } from './gb.js';
import { Symbols } from './symbols.js';
import { GameState } from './state.js';
import { Tasks } from './tasks.js';
import { CollisionMap } from './collision.js';
import { Nav } from './nav.js';
import { RomData, normalise } from './romdata.js';
import { Bootstrap } from './bootstrap.js';

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
let huntWanted = null;
let ballId = null;
// Frames advanced per animation frame while nobody is driving. The steps are
// powers of two because that is how it reads: 1x, 2x, 4x... and the last one is
// "as fast as it goes", which on a phone lands somewhere short of the label.
const SPEEDS = [1, 2, 4, 8, 16];
let speed = 1;
let running = false, target = 5;

const setStatus = (text, kind = '') => {
  $('#dot').className = 'dot ' + kind;
  $('#status').textContent = text;
};
const progress = (m) => { $('#progress').textContent = m; };

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
  collision = new CollisionMap(symbols, gb);
  nav = new Nav(gb, symbols);
  boot = new Bootstrap(gb, state, tasks, collision, nav, progress);
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
  $('#huntcard').classList.remove('hide');
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
  $('#bootrow').classList.add('hide');
  $('#bootnote').classList.add('hide');
  setStatus('ready', 'ok');
  progress('');
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
  let stepping = false;
  const tick = async () => {
    requestAnimationFrame(tick);
    if (running || stepping || !gb.ready) return;
    stepping = true;
    try { await gb.run(speed); } finally { stepping = false; }
  };
  requestAnimationFrame(tick);
}

async function refresh() {
  if (!state) return;
  const s = await tasks.snap();
  $('#where').textContent = s.inBattle
    ? `battle · Lv${s.enemy.level}`
    : `map ${s.map[0]}.${s.map[1]}${s.onGrass ? ' · grass' : ''}`;
  $('#party').textContent = s.party.length
    ? s.party.map((m) => `${m.slot + 1}  #${m.species}  Lv${m.level}  ${m.hp}/${m.maxHp}`).join('\n')
    : '(no party)';
  await refreshSpecies(s);
  if (romdata) refreshBag(s);
  if (s.party.length && target <= s.party[0].level) {
    target = Math.min(100, s.party[0].level + 1);
    $('#lvl').textContent = target;
  }
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

document.querySelectorAll('[data-step]').forEach((b) => {
  b.onclick = () => {
    target = Math.max(2, Math.min(100, target + Number(b.dataset.step)));
    $('#lvl').textContent = target;
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
  if (running || !boot) return;
  running = true;
  $('#boot').disabled = true;
  gb.releaseAll();
  syncHeld();
  setStatus('starting a new game', 'busy');
  const res = await boot.run('cyndaquil');
  setStatus(res.message, res.ok ? 'ok' : 'bad');
  progress('');
  running = false;
  $('#boot').disabled = false;
  if (res.ok) {
    $('#bootrow').classList.add('hide');
    $('#bootnote').classList.add('hide');
  }
  refresh();
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
  $('#bag').textContent = carried.length
    ? 'bag: ' + carried.map(([id, q]) => `${romdata.itemName(id)} x${q}`).join(', ')
    : 'bag: no Poke Balls — buy some at a Mart';
  $('#catch').disabled = !(ballId && huntWanted);
  $('#catch').textContent = ballId && huntWanted
    ? `Catch with ${romdata.itemName(ballId)}` : 'Catch';
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
    $('#hunt').disabled = true;
    $('#hunt').textContent = 'Nothing to hunt here';
    return;
  }
  for (const name of here) {
    const b = document.createElement('button');
    b.textContent = name;
    b.onclick = () => {
      huntWanted = name;
      for (const other of list.children) other.classList.toggle('on', other === b);
      $('#hunt').disabled = false;
      $('#hunt').textContent = `Look for ${name}`;
      $('#catch').disabled = !ballId;
      $('#catch').textContent = ballId
        ? `Catch with ${romdata.itemName(ballId)}` : 'Catch';
    };
    list.appendChild(b);
  }
  if (huntWanted && !here.includes(huntWanted)) {
    huntWanted = null;
    $('#hunt').disabled = true;
    $('#hunt').textContent = 'Pick one to look for';
  }
}

$('#hunt').onclick = async () => {
  if (running || !tasks || !huntWanted) return;
  running = true;
  tasks.cancelled = false;
  $('#hunt').disabled = true;
  $('#go').disabled = true;
  gb.releaseAll();
  syncHeld();
  setStatus(`looking for ${huntWanted}`, 'busy');
  const res = await tasks.hunt(huntWanted);
  setStatus(res.message, res.ok ? 'ok' : 'bad');
  progress('');
  $('#seen').textContent = res.seen && res.seen.size
    ? 'seen: ' + [...res.seen.entries()].sort((a, b) => b[1] - a[1])
        .map(([n, c]) => `${n} x${c}`).join(', ')
    : '';
  running = false;
  $('#hunt').disabled = false;
  $('#go').disabled = false;
  refresh();
};

$('#catch').onclick = async () => {
  if (running || !tasks || !huntWanted || !ballId) return;
  running = true;
  tasks.cancelled = false;
  $('#hunt').disabled = true;
  $('#catch').disabled = true;
  $('#go').disabled = true;
  gb.releaseAll();
  syncHeld();
  setStatus(`after ${huntWanted}`, 'busy');
  const res = await tasks.catch_(huntWanted, ballId);
  setStatus(res.message, res.ok ? 'ok' : 'bad');
  progress(Object.entries(res.stats).map(([k, v]) => `${k}=${v}`).join('  '));
  running = false;
  $('#hunt').disabled = false;
  $('#go').disabled = false;
  refresh();
};

$('#stopHunt').onclick = () => {
  if (tasks) tasks.cancel();
  walkCancelled = true;
  progress('stopping…');
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
        : `through the doorway to map ${m >> 8}.${m & 0xff}`, 'ok');
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
  if (running || !tasks) return;
  running = true;
  tasks.cancelled = false;
  $('#go').disabled = true;
  gb.releaseAll();          // do not leave a held button pressed into the task
  syncHeld();
  setStatus(`grinding to Lv${target}`, 'busy');
  const res = await tasks.grind(0, target);
  setStatus(res.message, res.ok ? 'ok' : 'bad');
  progress(Object.entries(res.stats).map(([k, v]) => `${k}=${v}`).join('  '));
  running = false;
  $('#go').disabled = false;
  refresh();
};

$('#stop').onclick = () => {
  // Stop has to reach both kinds of work. It used to set only the task flag,
  // which a walk never reads, so pressing it during one did nothing at all.
  if (tasks) tasks.cancel();
  walkCancelled = true;
  progress('stopping…');
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
  get nav() { return nav; },
  get romdata() { return romdata; },
  get boot() { return boot; },
  walkToTap,
};
