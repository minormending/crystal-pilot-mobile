# crystal-pilot mobile

An exploration: **can the [crystal-pilot](https://github.com/minormending/crystal-pilot)
auto-pilot run on an Android phone itself**, rather than on a Mac with the phone
as a remote?

Short answer: yes, in the browser — and this repo is a working spike that proves
the hard part. It boots a Pokémon Crystal ROM on the device, reads the game's
live state through the disassembly's symbol file, and drives it with synthetic
input. No app store, no NDK, no cable.

<img src="docs/on-device.png" alt="Running in a phone browser" width="330">

That screenshot is the app running in a phone-sized browser, having booted the
ROM and played through the intro on its own. The header reads `map 24.7` —
`PLAYERS_HOUSE_2F`, the bedroom — which is exactly where the desktop pilot's
bootstrap lands. Same address, same value, different emulator.

## How the options actually compared

Measured rather than guessed, on an M-series Mac:

| Approach | Speed | Memory access | Save states | Could I test it? |
| --- | --- | --- | --- | --- |
| PyBoy (the desktop pilot) | ~28,000 fps (470×) | yes, bank-qualified | yes | yes |
| **WasmBoy in a browser** | **2,197 fps (37×)** | **yes** | **yes** | **yes** |
| serverboy (pure JS, Node) | 3,185 fps (53×) | yes | no | yes |
| Native Android app (Kotlin + NDK core) | fastest in principle | n/a | n/a | **no** |
| Termux + Python + PyBoy | unknown | yes | yes | **no** |

The last two are the interesting rejections.

**A native app** would be fastest, and the NDK and cmake are even installed on
this machine — but there is no Gradle, no Android Studio, no emulator image and
no device here, so none of it could be run, let alone tested. It also means
rewriting ~7,500 lines of Python into Kotlin *and* wrapping a C emulator core
through JNI. Highest cost, and nothing to show for it until the very end.

**Termux** would reuse every line of the existing Python, which is genuinely
tempting. But PyBoy ships 54 compiled Cython extensions and Android is not
manylinux, so it means building all of them against bionic with clang, plus
numpy and SDL2 — and then there is still no touch interface, because the
pilot's front ends are a terminal CLI and an SDL keyboard menu.

**The browser** wins on the thing that actually matters here: it is the only
option that runs on the phone *and* can be developed and verified without one.
37× real time means a three-hour grind takes about five minutes on a desktop,
and perhaps fifteen on a phone. Slower than the 470× the desktop pilot manages,
but the pilot is still doing hours of work while you wait for a coffee.

## What is proven, and what is not

Proven, and visible in the screenshot:

- a 2 MB Crystal ROM boots in the browser
- the symbol file parses to the same 58,456 symbols the Python version reads,
  with `wPartyMon2 - wPartyMon1 == 0x30` as expected
- **game state reads correctly**: `wMapGroup`/`wMapNumber` at `0xDCB5` return
  `24, 7` after the intro, matching the desktop pilot exactly
- synthetic input works — the intro was played through by the app, not by hand
- `wMapStatus == 2` distinguishes "the world is live" from "the party happens to
  be loaded", the same signal the desktop version needed
- save states and battery saves are both available from the core

**Not proven:** a completed grind. The task loop in `app/tasks.js` is written and
is a direct port of logic the desktop version has tests for, but it has not been
watched finishing a grind here, because reaching a party means porting the
"walk to Elm's lab and take a starter" bootstrap, which this spike does not do.
Treat the loop as untested code.

## The part that had to be redesigned

The desktop pilot hangs its whole design on CPU hooks: the game's own routines
announce when they want input, so `BattleMenu` firing *is* the signal that the
battle menu opened. No browser Game Boy core offers breakpoints.

So the same questions are answered by watching memory instead:

| Question | Hook (desktop) | Polled address (here) |
| --- | --- | --- |
| is the battle menu up? | `BattleMenu` | `wMenuCursorX/Y` become 1..2 while `wBattleMenuCursorPosition` is still 0 |
| is the move menu up? | `MoveSelectionScreen` | `wMenuCursorY` is 1..4 during a battle |
| is a script running? | — | `wScriptMode != 0` |
| is the world live? | — | `wMapStatus == 2` |

What carries over unchanged is the hard-won lesson underneath: **read the live
cursor and step toward the target**. Gen 2 menus wrap, so counting presses from
an assumed starting position silently picks the wrong thing.

## Two traps worth knowing

Both cost real time here, and both fail quietly rather than loudly:

1. `_getWasmMemorySection(start, end)` does not reliably honour its range — it
   was observed returning the core's entire ~10 MB linear memory instead of the
   32 KB asked for. Index that as though it were the slice and every read is
   offset, producing plausible-looking rubbish rather than an error.
2. `_getWasmConstant('WORK_RAM_LOCATION')` returns `undefined` until a ROM is
   loaded. Fetch it during `config()` and every later read is silently empty.

`app/gb.js` guards against both.

## Running it

It is a static site with no build step:

```bash
python3 -m http.server 8124
```

Open `http://localhost:8124/`, pick your own ROM and `.sym`, and it starts. Both
files stay in the browser — nothing is uploaded, and none of it is in this repo.
Serve it over HTTPS on your network and Android will offer to install it to the
home screen; the service worker caches the shell so it opens offline.

Build the ROM and symbol file yourself from the
[pokecrystal](https://github.com/pret/pokecrystal) disassembly.

## Licence

**GPL-3.0-or-later**, unlike the MIT-licensed desktop pilot. That is not a
preference: the emulator core this ships, [WasmBoy](https://github.com/torch2424/wasmBoy),
is GPL-3.0-or-later, and a web app that bundles it is a combined work. The other
core measured, serverboy, is GPL-2 — every browser Game Boy core worth using is
copyleft, so any real version of this inherits it.

## If this were taken further

In the order that would pay off:

1. **Port the bootstrap** so the loop can be exercised end to end. Without a
   party there is nothing to grind, and nothing to test against.
2. **Import a `.sav`** from the desktop pilot, which would sidestep (1) and let
   the two halves share progress.
3. **Port the collision map and pathfinding.** They are pure arithmetic over
   memory and carry across unchanged — which is what makes Pokémon Center
   healing, and therefore unattended grinding, possible.
4. **Then reconsider native.** If 15× real time on a phone turns out to be too
   slow in practice, a JNI core is the fix — but by then the task logic exists
   in a portable form and the rewrite is only the platform layer.
