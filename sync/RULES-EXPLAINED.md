# What firebase-rules.json actually does

Written down because in six months you will look at that file and wonder.

Two things guard a room: **anonymous authentication**, which shuts out anyone not
signed in at all, and **the room code**, which is the actual secret. Neither is
sufficient alone. Line by line:

### `".read": false` / `".write": false` at the root
Deny everything by default, then open up only `/rooms/$roomId`. This is what
stops anyone from reading your whole database, and — importantly — from
**listing** the rooms. Read permission is only ever granted at the level of one
specific room, so you must already know a code to see anything. There is no
query that returns "all rooms."

### `auth != null`
Requires a signed-in caller. kidsync signs in anonymously on startup — no email,
no password, nothing the child or parent ever sees, and the session is restored
from local storage afterwards, so it costs one network round trip on a device's
first run.

Be clear about what this buys. Anonymous sign-in is open to anybody, so it does
**not** make a room private — it cannot, because there is nobody to
authenticate. What it does is worth having anyway:

- Completely unauthenticated access is refused, so drive-by scanners and a plain
  `curl` get nothing.
- Every write carries a real uid, which the next rule pins down.
- Firebase can apply its own per-user abuse limits, and usage is attributable
  in the console instead of anonymous in aggregate.

### `$roomId.length >= 16`
A cheap guard that the path looks like a real generated room id
(`gamename-WORD-WORD-WORD-123`) rather than someone poking at `/rooms/a`. It is
not the security boundary — the two billion possible codes are. It just blocks
the laziest probing.

**Why 16 and not something rounder:** the shortest code the generator can
possibly emit is `IVY-FIG-OWL-123` (15 characters, from the four 3-letter words
in the list), and the room path is `<game>-<code>`. So with a one-character game
name the shortest real path is 17 characters. A floor of 16 always passes for
legitimate writes. If you raise this number, short game names start getting
their writes **silently rejected**, which is a genuinely annoying thing to
debug. Leave it alone.

### `newData.hasChildren([...])`
A write must supply all four fields together. Prevents someone surgically
overwriting just `rev` to wedge every client in a room.

### `"writer"` validate: `newData.val() == auth.uid`
A write must label itself with the uid actually making it. Without this the
`writer` field is a string the client invented, which is worth nothing. With it,
every write in a room is attributable to a specific anonymous session.

Note that `writer` is diagnostic only — kidsync decides what to keep by
comparing against the database, never by trusting this field. It exists so that
if a room ever misbehaves you can tell how many distinct devices touched it.

### `"state"` validate: `length <= 32768`
**This is the rule that does the most work.** Without it, a writable database is
free file hosting, and someone will eventually find it. 32KB is generous for game
progress and small enough to be useless for abuse. `MAX_STATE_BYTES` in
`kidsync.js` mirrors this so you get a clear console error instead of a silent
rejection — if you change one, change both.

### `"$other": { ".validate": false }`
Rejects any field not listed above, so nobody can hang arbitrary extra data off
a room object.

## The honest limitation

Anyone who is signed in — which anyone can be — and who holds a room code can
read and overwrite that room. Nothing here rate-limits room *creation* either.
For sharing a child's game progress between their own devices that is a fair
trade. Do **not** extend this pattern to anything you would mind a stranger
reading: no names, no email addresses, no photos, no free text a child typed.
Game progress only.

If you ever need a real privacy boundary, the next step is a genuine sign-in
(email link, or a provider) plus a rule listing which uids may touch a room —
`"$roomId": { ".read": "root.child('members/' + $roomId + '/' + auth.uid).exists()" }`
or similar. That is a different product with accounts in it, which is exactly
what this design set out to avoid, so weigh it properly before starting.

## Changing the rules is a two-step deploy

The rules and the client have to agree, and they are deployed by different
means — the client by pushing code, the rules by pasting them into the console.
Tighten the rules **after** the matching client is live, never before, or you
lock out every device still running the old code. Loosening is the other way
round. There is no atomic way to do both, so pick the order that fails safe.
