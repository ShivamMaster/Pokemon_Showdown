// test/bridge.test.js
// The bridge is a page-context singleton that reads globals at import time, so
// the stubs must exist *before* the dynamic import. This file simulates the
// exact scenario the user hit: the extension is reloaded (chrome://extensions
// → ↻) while an old battle tab is still open, leaving the old bridge with a
// stale chrome.* context whose calls throw "Extension context invalidated" —
// synchronously, which a promise `.catch()` does not intercept.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const handlers = {};
const posted = [];
globalThis.window = {
  addEventListener: (type, fn) => {
    (handlers[type] ??= []).push(fn);
  },
  removeEventListener: () => {},
  postMessage: (msg) => posted.push(msg),
};

// Every chrome API the bridge touches throws, exactly like a stale context.
globalThis.chrome = {
  storage: {
    local: {
      get: () => {
        throw new Error('Extension context invalidated');
      },
      set: () => {
        throw new Error('Extension context invalidated');
      },
    },
    onChanged: {
      addListener: () => {
        throw new Error('Extension context invalidated');
      },
    },
  },
  runtime: {
    sendMessage: () => {
      throw new Error('Extension context invalidated');
    },
    onMessage: {
      addListener: () => {
        throw new Error('Extension context invalidated');
      },
    },
  },
};

// Importing must not throw (the listener registrations are guarded).
await import('../src/bridge/bridge.js');

const dispatch = (data) => {
  for (const fn of handlers.message ?? []) fn({ source: window, data });
};
const flush = () => new Promise((r) => setTimeout(r, 10));

test('loading the bridge with an invalidated context does not crash', () => {
  // If registration threw at import, the module load above would have failed.
  assert.ok(true);
});

test('no chrome message path throws after invalidation', async () => {
  let uncaught = 0;
  const onUncaught = (e) => {
    uncaught += 1;
    // eslint-disable-next-line no-console
    console.error('UNCAUGHT:', e.message);
  };
  process.on('uncaughtException', onUncaught);

  // Every listener path a stale bridge can still receive from the main world.
  dispatch({ psa: 'psa-storage-req', id: '1', op: 'get', key: 'profiles' });
  dispatch({ psa: 'psa-storage-req', id: '2', op: 'set', key: 'k', value: 1 });
  dispatch({ psa: 'psa-storage-req', id: '3', op: 'bogus', key: 'k' });
  dispatch({ psa: 'psa-badge-req', state: 'live' });
  dispatch({ psa: 'psa-capture-started', ok: true });
  dispatch({ psa: 'psa-ocr-req', id: '4', width: 1, height: 1, pixels: [0] });
  await flush();

  process.removeListener('uncaughtException', onUncaught);
  assert.equal(uncaught, 0);
});

test('storage requests still resolve so callers never hang', async () => {
  dispatch({ psa: 'psa-storage-req', id: '5', op: 'get', key: 'profiles' });
  await flush();
  const res = posted.find((m) => m.psa === 'psa-storage-res' && m.id === '5');
  assert.ok(res, 'expected a storage response');
  assert.equal(res.ok, true);
});
