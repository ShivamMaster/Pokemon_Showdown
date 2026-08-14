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

// Main world -> background: report whether the assistant is actively watching
// a battle, so the toolbar icon can carry a LIVE badge. chrome.runtime is not
// reachable from the MAIN world, so the isolated world forwards it.
window.addEventListener('message', (ev) => {
  if (ev.source !== window || ev.data?.psa !== 'psa-badge-req') return;
  chrome.runtime.sendMessage({ psa: 'psa-badge', state: ev.data.state }).catch(() => {});
});

// Background -> main world: the popup obtained a tab-capture stream id
// (user gesture) and the worker forwards it here; relay it into the page
// world so the capture module can start the stream.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.psa === 'psa-capture-start' || msg?.psa === 'psa-capture-stop') {
    window.postMessage({ psa: msg.psa, streamId: msg.streamId }, '*');
    sendResponse({ ok: true });
  }
});

// Main world -> background: the capture module started (or failed) — report
// back so the popup's ack handshake can finish instead of timing out.
window.addEventListener('message', (ev) => {
  if (ev.source !== window || ev.data?.psa !== 'psa-capture-started') return;
  chrome.runtime
    .sendMessage({ psa: 'psa-capture-status', ok: !!ev.data.ok, error: ev.data.error ?? null })
    .catch(() => {});
});

// Main world -> OCR: the main-world content script cannot use chrome.runtime
// (it's a page-context script), so the isolated world forwards OCR requests
// to the worker/offscreen document and posts the text back. ImageData pixels
// survive structured clone through postMessage + chrome.runtime messaging.
window.addEventListener('message', (ev) => {
  if (ev.source !== window || ev.data?.psa !== 'psa-ocr-req') return;
  const { id, width, height, pixels } = ev.data;
  // chrome.runtime messaging JSON-serializes, which mangles typed arrays —
  // convert to a plain array first so the pixels survive to the offscreen doc.
  const plain = pixels instanceof Uint8ClampedArray || pixels instanceof Uint8Array ? Array.from(pixels) : pixels;
  chrome.runtime
    .sendMessage({ psa: 'psa-ocr-req', id, width, height, pixels: plain })
    .then((res) => {
      window.postMessage({ psa: 'psa-ocr-res', id, text: res?.text, error: res?.error }, '*');
    })
    .catch((err) => {
      window.postMessage({ psa: 'psa-ocr-res', id, error: String(err?.message ?? err) }, '*');
    });
});
