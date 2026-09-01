# crystal-pilot mobile

An exploration: **can the [crystal-pilot](https://github.com/minormending/crystal-pilot)
auto-pilot run on an Android phone itself**, rather than on a Mac with the phone
as a remote?

**It is live: https://minormending.github.io/crystal-pilot-mobile/** — open it
on your phone, pick your own ROM and `.sym`, and it runs. Android will offer to
install it to the home screen.

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
- **the collision map decodes correctly**: the same 48 tiles of PLAYERS_HOUSE_2F
  come out byte-for-byte identical to the desktop pilot's reading of the same
  room — two implementations, one in Python over PyBoy and one in JS over
  WasmBoy, agreeing exactly

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

## Starting a game is yours, not the pilot's

If the ROM has no save, the app boots it, hands you the buttons, and waits. It
does not play the intro for you.

That is deliberate. An auto-pilot can only answer a prompt by pressing A, and
the intro's NAME menu defaults to NEW NAME -- which opens the letter grid, where
pressing A repeatedly spells `AAAAA`. Your character, your name. The pilot's
panel stays hidden until `wMapStatus` says the world is live, and then it
appears on its own.

Automated runs have nobody to press A, so they opt in with `?autostart=1`, and
even then they take one of the game's own names (CHRIS/MAT/ALLAN/JON, or
KRIS/AMANDA/JUANA/JODI) rather than typing one. `NamePlayer` stores those
directly, with no naming screen involved.

## Tap to walk

Tap anywhere on the screen and the pilot walks there.

The overworld is drawn in 16×16 tiles, so the 160×144 screen is 10×9 of them and
the player is always the one at (4, 4) — the camera keeps them centred rather
than clamping at map edges. That makes a tap a map coordinate, and `app/collision.js`
turns the map into something you can search: Gen 2 keeps the loaded blocks in
`wOverworldMapBlocks` and the per-quadrant collision values in ROM at
`wTilesetCollisionAddress`, which together give the collision byte for any tile.
Ledges are one-way, so a route never plans a hop it could not walk back.

The decode is checked against the game rather than trusted. `wPlayerTileCollision`
is the collision of the tile the player is standing on, so every step compares
the two and stops if they disagree — a wrong decode does not throw, it silently
paths through walls. As a cross-check the same 48 tiles read here match the
desktop pilot's reading of the same room exactly.

Two things had to be learned again in the browser, because each produced a walk
that ended somewhere plausible but wrong:

- **Coordinates change when the game commits to a step, not when it finishes.**
  Returning then reports a tile the player has not reached, and the next press
  lands mid-stride — so every step performed the *previous* one. Steps now wait
  for the player to come to rest.
- **A path is a plan, and plans go stale.** Following one blindly meant a single
  missed step put every later step in the wrong place while the walk still
  reported success. The route is re-planned from where the player actually is,
  every step.

It also distinguishes the ways a walk can end, because they mean different
things: a wild battle, a tile with no route to it, a doorway that changed the
map underneath, and *the game refusing input at all* — walk downstairs into
Mom's script and every direction is blocked, which is not the map's fault and
should not be reported as one.

## Controls

Eight on-screen buttons: the D-pad, A, B, Select and Start. **Press and hold** —
Gen 2 turns you before it walks you, so a tap in a new direction only turns you,
and each tap after that moves a single tile. Holding walks.

<img src="docs/controls.png" alt="The on-screen controls, with LEFT held" width="330">

That is the app mid-hand-off: a ROM booted, the intro left alone for the player,
and LEFT held down — which is what the lit key means. The held state is read
back from the emulator's own set of held buttons, so pressing `Z` on a keyboard
lights up the same A button a thumb would.

There is no TAB button. On the desktop pilot, TAB opens an in-game menu because
the only surface there is the emulator window; here the pilot's controls are the
page itself — the Grind card, the level stepper, and Start/Stop sit above the
buttons, so the game never has to be interrupted to reach them. The on-screen
buttons are ignored while a task is running, so a stray thumb cannot fight the
pilot for the joypad.

A keyboard works on the same page, which is what makes it testable on a desktop:

| Key | Button |
| --- | --- |
| Arrow keys | D-pad |
| `Z` or `A` | A |
| `X` or `S` | B |
| `Enter` | Start |
| `Shift` or `Backspace` | Select |

Buttons release on `pointerup`, `pointercancel`, `pointerleave` and on window
blur, so a direction cannot get stuck down after your thumb slides off the
button or you switch apps mid-press.

## Running it

Easiest: open **https://minormending.github.io/crystal-pilot-mobile/** and pick
your ROM and `.sym`. Both files stay in the browser — nothing is uploaded, which
is also why hosting this publicly is fine: no game data is served, only the app.

It is a static site with no build step, so it runs anywhere that serves files:

```bash
python3 -m http.server 8124
```

GitHub Pages suits it particularly well. The emulator core inlines its
WebAssembly as base64 in a single JS file, so there is no separate `.wasm` to
serve and no MIME type to configure, and it uses no `SharedArrayBuffer`, so it
does not need the cross-origin isolation headers Pages cannot set. Every path is
relative, so the `/crystal-pilot-mobile/` project subpath works untouched.

The HTTPS matters: service workers need a secure context, so on Pages the app
installs to the home screen and opens offline — which it will not do over plain
HTTP on your network. Bump `CACHE` in `sw.js` when you change the shell, or
browsers will keep serving the old one.

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
3. ~~**Port the collision map and pathfinding.**~~ Done — see *Tap to walk*
   below. It is what makes Pokémon Center healing, and therefore unattended
   grinding, possible, so the remaining work there is the route between maps
   rather than the route across one.
4. **Then reconsider native.** If 15× real time on a phone turns out to be too
   slow in practice, a JNI core is the fix — but by then the task logic exists
   in a portable form and the rewrite is only the platform layer.
