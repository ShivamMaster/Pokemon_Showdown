// src/profiles/store.js
// Profile persistence, on top of the unified storage driver
// (src/storage.js): chrome.storage.local in the extension, the postMessage
// bridge from the main-world content script, and an in-memory map in Node so
// tests run without a browser.

import { getValue, setValue } from '../storage.js';
import { toProfileKey, normalizeProfile } from './learn.js';

const PROFILES_KEY = 'profiles';

// Load profiles, normalizing each entry: `aliases` is always a lowercase
// string array, and entries are keyed by the display name (so profiles
// renamed or saved under older formats still resolve correctly).
export async function loadProfiles() {
  try {
    const raw = (await getValue(PROFILES_KEY)) ?? {};
    const out = {};
    for (const [key, p] of Object.entries(raw)) {
      const norm = normalizeProfile(p);
      if (!norm) continue;
      const k = toProfileKey(norm.opponent) || key;
      out[k] = norm;
    }
    return out;
  } catch {
    return {};
  }
}

export async function saveProfiles(profiles) {
  await setValue(PROFILES_KEY, profiles ?? {});
}
