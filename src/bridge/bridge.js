// src/bridge/bridge.js
// Isolated-world storage bridge for the extension.
//
// The assistant's main content script runs in the page's MAIN world so it can
// see the Showdown client's globals — but `chrome.*` is undefined there. This
// script runs in the default isolated world (where chrome.storage IS
// available) and serves storage requests from the main world over
// window.postMessage, plus forwards chrome.storage.onChanged events (e.g.
// settings changed in the options page) back to the main world.
//
// Bundled by esbuild into extension/dist/bridge.js; declared in the manifest
// as a normal (isolated-world) content script.

const REQ = 'psa-storage-req';
const RES = 'psa-storage-res';
const CHANGED = 'psa-storage-changed';

window.addEventListener('message', async (ev) => {
  if (ev.source !== window || ev.data?.psa !== REQ) return;
  const { id, op, key, value } = ev.data;
  try {
    if (op === 'get') {
      const obj = await chrome.storage.local.get(key);
      window.postMessage({ psa: RES, id, ok: true, value: obj?.[key] }, '*');
    } else if (op === 'set') {
      await chrome.storage.local.set({ [key]: value });
      window.postMessage({ psa: RES, id, ok: true }, '*');
    } else {
      window.postMessage({ psa: RES, id, ok: false, error: `unknown op ${op}` }, '*');
    }
  } catch (err) {
    window.postMessage({ psa: RES, id, ok: false, error: String(err) }, '*');
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const [key, { newValue }] of Object.entries(changes)) {
    window.postMessage({ psa: CHANGED, key, value: newValue }, '*');
  }
});
