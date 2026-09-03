// ─────────────────────────────────────────────────────────────────────────────
//  THE ONLY FILE YOU EVER EDIT PER-PROJECT.
//
//  Paste the config object Firebase gives you in:
//    Project settings (gear icon) → General → scroll to "Your apps" → Config
//
//  These values are PUBLIC BY DESIGN. Firebase expects them to ship in your
//  client code. Committing them to a public repo is correct and safe — they are
//  not secrets, they are addresses. Your actual protection is the security
//  rules (see firebase-rules.json), not the secrecy of these strings.
// ─────────────────────────────────────────────────────────────────────────────

export const firebaseConfig = {
    apiKey: "AIzaSyBdBfTvwhULgnS8-JCO6cmfPxmSlmhdZ9A",
    authDomain: "kids-games-sync.firebaseapp.com",
    databaseURL: "https://kids-games-sync-default-rtdb.firebaseio.com",
    projectId: "kids-games-sync",
    storageBucket: "kids-games-sync.firebasestorage.app",
    messagingSenderId: "740391976396",
    appId: "1:740391976396:web:02f8e31c9161c4a6a23169"
  };

// Sanity check so a forgotten paste fails loudly instead of silently not syncing.
if (firebaseConfig.apiKey === "PASTE_ME") {
  console.warn(
    "[kidsync] firebase-config.js still has placeholder values. " +
    "Sync is disabled; the game will run in local-only mode. " +
    "See kidsync/README.md for the 5-minute setup."
  );
}
