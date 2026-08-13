// src/background/background.js
// Minimal MV3 service worker. The extension keeps all state in
// chrome.storage.local (written by the options page, popup, and the
// isolated-world storage bridge), so the worker currently has nothing to do —
// it exists as the conventional entry point for future background work and
// gives the extension a stable, inspectable target.
