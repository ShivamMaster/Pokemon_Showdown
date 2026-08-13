// src/settings.js
// User-facing extension settings, persisted through the unified storage
// driver (chrome.storage.local in the extension, postMessage bridge from the
// main-world content script, memory in Node).
//
//   panelEnabled    - show the assistant panel over battles
//   statAssumption  - how the engine fills in the opponent's hidden stats:
//                     'max'  = typical 252-EV competitive builds (default)
//                     'base' = raw base stats (no EVs)

import { getValue, setValue, onStorageChanged } from './storage.js';

export const DEFAULT_SETTINGS = Object.freeze({
  panelEnabled: true,
  statAssumption: 'max',
});

export function normalizeSettings(partial) {
  return { ...DEFAULT_SETTINGS, ...(partial ?? {}) };
}

export async function loadSettings() {
  return normalizeSettings(await getValue('settings'));
}

export async function saveSettings(settings) {
  await setValue('settings', normalizeSettings(settings));
}

export { onStorageChanged };
