# The interface

[← crystal-pilot mobile](../README.md) · [Using it](USING.md) · [The interface](INTERFACE.md) · [Two devices](DEVICES.md) · [What is proven](PROVEN.md) · [Developing](DEVELOPING.md) · [The code](CODE.md)

What the screen is made of, and why it is shaped like the console it
emulates. For what the buttons do, see [Using it](USING.md); for the code
behind it, [The code](CODE.md) section 9.

---

## Layout

The app does two jobs and used to look identical doing both: you play it by
hand, or you send the pilot off to work for ninety seconds. Measured on a
375 × 812 viewport with a game running, the page was 1537px — 1.89 screens —
with the emulator at the top and everything that starts or stops the pilot at
the bottom. There was no scroll position from which you could watch the game and
reach the thing that stops it.

`main` was `display:block`, so source order was the only order. It is a column
flex now and the order is a decision:

| | directly under the screen | then |
| --- | --- | --- |
| **Playing** | the pad | status, the jobs, the party |
| **Piloting** | the run state and Stop | the jobs, then the pad, dimmed |

Playing puts the pad against the screen. Piloting gives that band to the run
state instead and drops the pad below the fold, dimmed — pressing it would be
fighting the pilot for the same emulator, so it should not look available. The
switch is one class on `<body>`, set where `running` was already set: that flag
had always existed and gated every handler, and nothing in the layout used it.

Tap-to-walk deliberately does not switch modes. It sets `running`, because the
idle loop must stand down and no job may start on top of it, but a walk lasts a
couple of seconds and reordering the page under a thumb that just tapped it
would cost more than the dimming is worth.

## The pilot's jobs are a list, not a toolbar

`runTask` opens with `if (running) return null`, so only one job can ever be
underway. These were never four independent buttons — they are one mutually
exclusive choice, and a row of buttons is the wrong shape for that. The old
arrangement kept the fiction by hand, and the lists disagreed: grinding locked
Hunt but not Catch or the errand; catching locked Hunt and grinding but not the
errand. That bookkeeping is gone.

It measured badly too. Content-sized flex rows gave the four actions four
different widths — 207, 110, 167 and 86 — inside a 351px card, which made
Catch, the most consequential thing in it, the smallest target on screen.

Three rows now, each a name, what it would actually do, and one small
affordance. Only the ready job takes the accent, because a list where everything
shouts is worse than the grid it replaced:

```
Grind   CYNDAQUIL → Lv10          Start
Hunt    HOPPIP · here now         Start
Catch   no Poké Balls yet         Get
```

Catch owns its prerequisite. The errand used to be a peer button *below* Catch,
beside bag advice that contradicted it — and it is a one-time thing anyway: run
it twice and it returns *already carrying 5 ball(s)* without moving. It is
Catch's empty state instead, so the row that says you need balls is the row that
fetches them.

Two other things went with it. *Pick one to look for* was a filled accent
primary button that was disabled and did nothing, sitting below the chips that
were the real control — the chips are the control, and the rows report readiness.
And the level stepper, four buttons and up to four taps to say Lv10, became the
targets people pick, two of them relative to the party's own level.

## What the pilot is doing

There were two Stop buttons, one per card, at 1181px and 1463px down the page —
so during a ninety-second grind neither was on screen, and two identical buttons
in different cards asked a question nobody should have to hold: *which one stops
which thing.* There is one, under the screen, only while something runs.

The pilot's account of itself was a single label that overwrote itself, with a
second line left over from whatever ran before — "ready" sitting above a stale
"finding grass". The errand walks four maps, heals twice and fights a rival, and
all of it arrived as one string. It already emitted the right events and they
were being thrown away.

Three lines now, newest last, cleared when a run *starts* rather than when it
finishes: the last thing the pilot said is the most useful thing on screen once
it has stopped. Consecutive repeats collapse, because several legs say "heading
left" and a stack of identical lines reads as being stuck rather than as making
progress.

Net effect, measured the same way: the page went from 1537px to 1424px and the
pad card from 341px to 257px, and the screen, the pad, the status line and the
run log now all sit above the fold — where before the fold landed inside the pad
and both Stops were some 500px below it. It got shorter while gaining a run log
and three job state lines, because the duplicate Stop, two prose footers and the
stepper all went.

## Three layouts, one machine

The screen and the pad are furniture: they hold their places and the cards
between them are the only thing that scrolls. What changes with the room is how
that furniture is arranged.

| | screen | the rest |
| --- | --- | --- |
| **Portrait phone** | full width, letterboxed on short phones | flow between screen and pad |
| **Landscape phone** | between your thumbs | D-pad left, A/B right, cards beside |
| **Tablet** | an integer 3× — 480 × 432 | the flow alongside, no scrolling |

Landscape was not cramped before this, it was unusable: at 844 × 390 the page
ran to six screens and the pad started at 575px, so the game and the buttons
that drive it could not both be seen at any scroll position. A phone in
landscape now puts the D-pad under one thumb and A/B under the other with the
picture between them, which is where a handheld has always put them.

Sizes are in `dvh`, because mobile browser chrome comes and goes and a pad
positioned against `100vh` sits under the address bar exactly when a thumb
reaches for it.

## Colour

Two palettes, named by the job each colour does. Dark is the base, because that
is what this app is: a Game Boy screen looked at in the evening. Light is for
the people whose phone is set that way.

There is no palette switcher for the *screen*, and that is deliberate: this
ROM's header reads `0xc0`, Game Boy Color only, so Crystal supplies its own
colours and uses them to tell things apart. A DMG green wash would destroy
information, and the core exposes no palette API to do it with anyway.

The interface theme is a different question, and the order mattered. A second
theme multiplies a palette rather than resolving one, and this palette had four
measurable failures in it — so those were fixed first, on one palette, and the
light set was derived afterwards from the roles rather than from the old
values. Doing it the other way round would have doubled the work and shipped
both halves broken.

What was actually wrong:

* **Ordinary buttons were filled with `--panel`** — the exact colour of the card
  holding them, 1.00:1 — and leaned on a 1.27:1 border to be visible at all.
  The comment in that stylesheet already said *"a button the same colour as its
  container reads as a label"*, and applied it only to the D-pad keys. `--raise`
  is that lesson applied to everything pressable.
* **White on the accent was 3.80:1**, so the label on every Start button in the
  app failed. `--action` at `#4269c9` passes at 5.13:1 and still steps clear of
  a card at 3.04:1. Darker blues pass more easily and go muddy.
* **Stop read at 3.93:1** — the one control you want in a hurry.
* **Select and Start read at 4.41:1**: `--dim` is legible on the page and on a
  card, but not on a raised key, which is where those two live. They have their
  own ink now.

And one thing that was not a contrast problem at all: **`--accent` meant six
unrelated things** — the primary action, a selected species, a selected level, a
held key, where you tapped, and something running. When everything important is
the same blue, blue has stopped signalling anything. Filled controls that carry
a label are `--action`; `--accent` is now only used where there is no text on it
(the running dot, the slider, links); and where you tapped is `--mark`, a warm
amber, deliberately not a control colour — as the accent blue it read as one
more button sitting on the map.

Every pair is checked in both themes: no text combination under 4.5:1, no
meaningful edge under 3:1. Removing the old under-the-screen `.speed` block also
fixed a cascade collision it was causing — it still set `margin-top:10px`, which
the header rule did not override, so the header's speed control carried a stray
margin.

Three things about light are not simply the dark values flipped:

* **A pressable cannot be lighter than a white card.** On dark, `--raise` steps
  up and carries the affordance on its own. On light it steps *down* and the
  border does more of the work.
* **The gamepad needs a bigger step than the buttons do**, because it is drawn
  as one connected cross with no borders at all — the fill is the only thing
  separating it from the card. `--key` stopped being an alias of `--raise` for
  that reason. The first attempt gave each cell its own outline instead, which
  worked and was wrong: it turned the cross back into the four loose boxes the
  original CSS says it is not.
* **`--mark` is identical in both.** Where you tapped sits on the game's own
  picture, not on any surface of ours, so it is not the theme's business.

The control is three-state — auto, light, dark — and lives in the card with
*How this works* rather than the header. The header is for where you are and
how fast the game is running; a theme is neither, and it is set once. Putting it
there also overflowed 375px, wrapping the title and truncating the location.
