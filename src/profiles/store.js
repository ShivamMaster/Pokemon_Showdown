// src/profiles/store.js
// Profile persistence, on top of the unified storage driver
// (src/storage.js): chrome.storage.local in the extension, the postMessage
// bridge from the main-world content script, and an in-memory map in Node so
// tests run without a browser.

import { getValue, setValue } from '../storage.js';

const PROFILES_KEY = 'profiles';

export async function loadProfiles() {
  try {
    return (await getValue(PROFILES_KEY)) ?? {};
  } catch {
    return {};
  }
}

export async function saveProfiles(profiles) {
  await setValue(PROFILES_KEY, profiles ?? {});
}
