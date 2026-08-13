// src/storage.js
// Unified storage access for the extension.
//
// chrome.storage.local is only reachable from the extension's isolated world
// (default content scripts) and the extension's own pages. The main content
// script runs in the page's MAIN world — that is the only world that can see
// the Showdown client's globals — where `chrome` is undefined. So it talks to
// the tiny isolated-world bridge (src/bridge/bridge.js) through
// window.postMessage, which all worlds share. In Node (tests) everything falls
// back to an in-memory map.
//
// Exported API:
//   getValue(key)            -> Promise<value | undefined>
//   setValue(key, value)     -> Promise<void>
//   onStorageChanged(key, cb) -> subscribe to external changes of `key`

let memory = new Map();

let bridgeSeq = 0;
let bridgeListening = false;
const pending = new Map();

function hasChromeStorage() {
  return typeof chrome !== 'undefined' && !!chrome.storage?.local;
}

function hasWindow() {
  return typeof window !== 'undefined' && typeof window.postMessage === 'function';
}

function initBridgeListener() {
  if (!hasWindow() || bridgeListening) return;
  bridgeListening = true;
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.data?.psa !== 'psa-storage-res') return;
    const { id, ok, value, error } = ev.data;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (ok) entry.resolve(value);
    else entry.reject(new Error(error ?? 'storage bridge error'));
  });
}

// Bridge round-trip with a timeout so a missing bridge never hangs the caller.
function bridgeRequest(op, key, value) {
  return new Promise((resolve, reject) => {
    initBridgeListener();
    const id = `p${Date.now()}-${++bridgeSeq}`;
    pending.set(id, { resolve, reject });
    window.postMessage({ psa: 'psa-storage-req', id, op, key, value }, '*');
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`storage bridge timeout (${op} ${key})`));
    }, 2000);
  });
}

export async function getValue(key) {
  if (hasChromeStorage()) {
    try {
      const obj = await chrome.storage.local.get(key);
      return obj?.[key];
    } catch {
      return memory.get(key);
    }
  }
  if (hasWindow()) {
    try {
      return await bridgeRequest('get', key);
    } catch {
      return memory.get(key);
    }
  }
  return memory.get(key);
}

export async function setValue(key, value) {
  if (hasChromeStorage()) {
    try {
      await chrome.storage.local.set({ [key]: value });
      return;
    } catch {
      // fall through to memory
    }
  } else if (hasWindow()) {
    try {
      await bridgeRequest('set', key, value);
      return;
    } catch {
      // fall through to memory
    }
  }
  memory.set(key, value);
}

// Subscribe to changes made from *outside* this world (e.g. the options page
// toggling a setting while a battle is open). Returns an unsubscribe fn.
export function onStorageChanged(key, cb) {
  if (hasChromeStorage()) {
    const listener = (changes, area) => {
      if (area === 'local' && changes[key]) cb(changes[key].newValue);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }
  if (hasWindow()) {
    const listener = (ev) => {
      if (ev.source !== window || ev.data?.psa !== 'psa-storage-changed') return;
      if (ev.data.key === key) cb(ev.data.value);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }
  return () => {};
}
