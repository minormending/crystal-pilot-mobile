/* Joins a host app's classic scripts to kidsync, which is an ES module.

   This file is IDENTICAL in every app that uses it, which is the point — it used
   to be three near-copies that differed only in comments and in the name of the
   global they looked for, and near-copies drift. Everything app-specific lives
   behind one contract instead:

     window.SyncHost = {
       game,             // stable room namespace, e.g. 'tidy-up'
       initialState(),   // the travelling subset of local state
       merge(a, b),      // how two of those combine — the app's own rules
       apply(incoming),  // fold a merged state in and repaint
       attach(handle)    // receive the live kidsync instance
     }

   Two things here are deliberate and worth not undoing:

   1. kidsync is loaded with a DYNAMIC import inside a try/catch. It pulls the
      Firebase SDK from a CDN, and a static import would mean an unreachable CDN
      — or simply being offline, which for these apps is a normal Tuesday —
      takes the whole page down with it. A failed load is one console line and
      an app that behaves exactly as it did before.
   2. Nothing here reaches into the host app's internals. The seam is one object,
      visible from both sides.                                                  */

import { firebaseConfig } from './firebase-config.js';

async function boot() {
  const host = window.SyncHost;
  if (!host) return;                       // the app's scripts did not load

  let createSync;
  try {
    ({ createSync } = await import('./kidsync.js'));
  } catch (err) {
    console.warn('[sync] could not load the sync module — staying local-only.', err.message);
    return;
  }

  try {
    const handle = await createSync({
      firebaseConfig,
      game: host.game,
      initialState: host.initialState(),
      merge: host.merge,
      onChange: host.apply
    });
    host.attach(handle);
  } catch (err) {
    console.warn('[sync] could not start syncing — staying local-only.', err.message);
  }
}

/* Host apps boot on DOMContentLoaded and register their listener while parsing,
   so their state is loaded and screens painted by the time this runs. */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
