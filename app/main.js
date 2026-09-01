// Wiring: file pickers, the render loop, and dispatching a task.
import { GameBoy } from './gb.js';
import { Symbols } from './symbols.js';
import { GameState } from './state.js';
import { Tasks } from './tasks.js';

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
  tasks = new Tasks(gb, state, progress);

  // Hand the game over immediately: buttons visible, emulator running.
  $('#loader').classList.add('hide');
  $('#ctrls').classList.remove('hide');
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
  setStatus('press Start, and play until you are out in the world', '');
  progress('the pilot waits here — a new game is yours to start');
  while (true) {
    if (!running) {
      const s = await tasks.snap();
      if (s.worldLoaded) break;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  $('#panel').classList.remove('hide');
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
    try { await gb.run(1); } finally { stepping = false; }
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
                     'wMapStatus', 'wMenuCursorY', 'wPlayerTileCollision']);
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
function bindHold(el, button) {
  const down = (e) => { e.preventDefault(); if (!running) gb.hold(button); };
  const up = (e) => { e.preventDefault(); gb.release(button); };
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
  gb.hold(b);
});
addEventListener('keyup', (e) => {
  const b = KEYS[e.key];
  if (!b) return;
  e.preventDefault();
  gb.release(b);
});
// Releasing on blur avoids a key staying stuck down after tabbing away.
addEventListener('blur', () => gb.releaseAll());

$('#go').onclick = async () => {
  if (running || !tasks) return;
  running = true;
  tasks.cancelled = false;
  $('#go').disabled = true;
  gb.releaseAll();          // do not leave a held button pressed into the task
  setStatus(`grinding to Lv${target}`, 'busy');
  const res = await tasks.grind(0, target);
  setStatus(res.message, res.ok ? 'ok' : 'bad');
  progress(Object.entries(res.stats).map(([k, v]) => `${k}=${v}`).join('  '));
  running = false;
  $('#go').disabled = false;
  refresh();
};

$('#stop').onclick = () => { if (tasks) tasks.cancel(); progress('stopping…'); };

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
window.PILOT = { gb, get tasks() { return tasks; }, get state() { return state; } };
