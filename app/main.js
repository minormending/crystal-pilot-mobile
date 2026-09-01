// Wiring: file pickers, the render loop, and dispatching a task.
import { GameBoy } from './gb.js';
import { Symbols } from './symbols.js';
import { GameState } from './state.js';
import { Tasks } from './tasks.js';

const $ = (s) => document.querySelector(s);
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

  // Reach a live overworld before offering anything: party data and
  // coordinates come back before the map does, so "there is a party" is not
  // the same as "the world is ready".
  setStatus('starting the game…', 'busy');
  const ok = await tasks.continueGame();
  if (!ok) {
    setStatus('could not reach the overworld — is this a Crystal ROM?', 'bad');
    return;
  }
  $('#loader').classList.add('hide');
  $('#panel').classList.remove('hide');
  $('#ctrls').classList.remove('hide');
  setStatus('ready', 'ok');
  refresh();
  setInterval(() => { if (!running) refresh(); }, 1200);
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

document.querySelectorAll('[data-btn]').forEach((b) => {
  b.onclick = () => { if (!running) gb.press(b.dataset.btn, 6, 2); };
});

$('#go').onclick = async () => {
  if (running || !tasks) return;
  running = true;
  tasks.cancelled = false;
  $('#go').disabled = true;
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
  if (!new URLSearchParams(location.search).has('dev')) return;
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
