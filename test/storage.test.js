// test/storage.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getValue, setValue, onStorageChanged } from '../src/storage.js';

// ---------------------------------------------------------------------------
// Memory mode (no window, no chrome — plain Node)
// ---------------------------------------------------------------------------

test('storage: memory mode round-trips values', async () => {
  assert.equal(await getValue('missing'), undefined);
  await setValue('profiles', { alice: { battles: 3 } });
  assert.deepEqual(await getValue('profiles'), { alice: { battles: 3 } });
  await setValue('profiles', null);
  assert.equal(await getValue('profiles'), null);
});

test('storage: onStorageChanged is a no-op in memory mode', () => {
  let called = false;
  const off = onStorageChanged('settings', () => (called = true));
  off();
  assert.equal(called, false);
});

// ---------------------------------------------------------------------------
// Bridge mode: simulate a main-world window talking to a fake bridge that
// owns a store, exactly like the isolated-world content script does.
// ---------------------------------------------------------------------------

function fakeBridgeWindow(store) {
  const listeners = {};
  const win = {
    postMessage(data) {
      if (data?.psa !== 'psa-storage-req') return;
      const { id, op, key, value } = data;
      const res =
        op === 'get'
          ? { psa: 'psa-storage-res', id, ok: true, value: store[key] }
          : (store[key] = value, { psa: 'psa-storage-res', id, ok: true });
      for (const fn of listeners.message ?? []) fn({ source: win, data: res });
    },
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
  };
  return win;
}

test('storage: bridge mode reads and writes through the window bridge', async () => {
  const store = {};
  globalThis.window = fakeBridgeWindow(store);
  try {
    assert.equal(await getValue('settings'), undefined);
    await setValue('settings', { panelEnabled: false });
    await setValue('profiles', { bob: { totalBattles: 5 } });
    assert.deepEqual(await getValue('settings'), { panelEnabled: false });
    assert.deepEqual(await getValue('profiles'), { bob: { totalBattles: 5 } });
    // the bridge actually owns the data (it lives in the fake bridge's store)
    assert.deepEqual(store.settings, { panelEnabled: false });
  } finally {
    delete globalThis.window;
  }
});

test('storage: bridge mode falls back to memory when the bridge errors', async () => {
  // A window whose postMessage answers every request with an error, as if no
  // bridge were installed.
  const listeners = {};
  const win = {
    postMessage(data) {
      if (data?.psa !== 'psa-storage-req') return;
      const res = { psa: 'psa-storage-res', id: data.id, ok: false, error: 'no bridge' };
      for (const fn of listeners.message ?? []) fn({ source: win, data: res });
    },
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
  };
  globalThis.window = win;
  try {
    await setValue('settings', { panelEnabled: false });
    assert.deepEqual(await getValue('settings'), { panelEnabled: false }); // from memory
  } finally {
    delete globalThis.window;
  }
});

test('storage: onStorageChanged bridges storage-changed events from other worlds', async () => {
  const listeners = {};
  const win = {
    postMessage() {},
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
  };
  globalThis.window = win;
  try {
    const seen = [];
    const off = onStorageChanged('settings', (v) => seen.push(v));
    // Simulate the isolated-world bridge forwarding a chrome.storage change.
    for (const fn of listeners.message ?? []) {
      fn({ source: win, data: { psa: 'psa-storage-changed', key: 'settings', value: { panelEnabled: false } } });
      fn({ source: win, data: { psa: 'psa-storage-changed', key: 'profiles', value: {} } }); // wrong key
    }
    assert.deepEqual(seen, [{ panelEnabled: false }]);
    off();
    assert.equal(listeners.message.length, 0, 'unsubscribe removes the listener');
  } finally {
    delete globalThis.window;
  }
});
