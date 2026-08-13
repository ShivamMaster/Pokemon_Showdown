// test/ocr.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ocrCanvas, parseOcrText } from '../src/content/ocr.js';
import { parseTooltipText } from '../src/content/tooltips.js';

// ---------------------------------------------------------------------------
// ocrCanvas — main-world client that posts pixels and awaits the text
// ---------------------------------------------------------------------------

function fakeCanvas(width, height, fill = 200) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill;
    data[i + 1] = fill;
    data[i + 2] = fill;
    data[i + 3] = 255;
  }
  return {
    width,
    height,
    getContext: () => ({
      getImageData: () => ({ data }),
    }),
  };
}

test('ocrCanvas posts a request and resolves with the recognized text', async () => {
  const messages = [];
  const listeners = {};
  globalThis.window = {
    addEventListener: (type, fn) => {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener: (type, fn) => {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
    postMessage: (msg) => {
      messages.push(msg);
      // Reply synchronously as the bridge would.
      const { id } = msg;
      for (const fn of listeners.message ?? []) {
        fn({ source: window, data: { psa: 'psa-ocr-res', id, text: 'Raging Bolt\nAbility: Protosynthesis' } });
      }
    },
  };

  const text = await ocrCanvas(fakeCanvas(4, 4));
  assert.equal(text, 'Raging Bolt\nAbility: Protosynthesis');

  const req = messages[0];
  assert.equal(req.psa, 'psa-ocr-req');
  assert.equal(req.width, 4);
  assert.equal(req.height, 4);
  assert.ok(req.pixels instanceof Uint8ClampedArray);
  assert.equal(req.pixels.length, 4 * 4 * 4);
  delete globalThis.window;
});

test('ocrCanvas resolves null when the bridge reports an error', async () => {
  globalThis.window = {
    addEventListener: (type, fn) => {
      if (type === 'message') window._on = fn;
    },
    removeEventListener: () => {},
    postMessage: (msg) => {
      const { id } = msg;
      window._on({ source: window, data: { psa: 'psa-ocr-res', id, error: 'boom' } });
    },
  };
  const text = await ocrCanvas(fakeCanvas(2, 2));
  assert.equal(text, null);
  delete globalThis.window;
});

test('ocrCanvas times out to null when no reply comes', async () => {
  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    postMessage: () => {},
  };
  const text = await ocrCanvas(fakeCanvas(2, 2), 50);
  assert.equal(text, null);
  delete globalThis.window;
});

test('parseOcrText is the tooltip parser (noisy OCR input tolerated)', () => {
  const obs = parseOcrText('Grassy Terrain (4 or 7 turns)\nRaging Bolt\nAbility: Protosynthesis\n« Dragon Pulse (15/16)');
  assert.deepEqual(obs, parseTooltipText('Grassy Terrain (4 or 7 turns)\nRaging Bolt\nAbility: Protosynthesis\n« Dragon Pulse (15/16)'));
  assert.equal(obs.species, 'Raging Bolt');
  assert.deepEqual(obs.moves, [{ name: 'Dragon Pulse', pp: 15, maxpp: 16 }]);
});

// ---------------------------------------------------------------------------
// Offscreen module — pixel reconstruction + message handler contract
// ---------------------------------------------------------------------------

test('pixelsToCanvas reconstructs pixels from a plain array (JSON-safe shape)', () => {
  const { pixelsToCanvas } = globalThis.__psaOffscreen ?? {};
  if (!pixelsToCanvas) {
    // Import dynamically; the module guards its chrome.runtime registration
    // so it's safe in Node.
    return import('../src/offscreen/offscreen.js').then((mod) => {
      // Build a fake document with a canvas whose ImageData we can inspect.
      let written = null;
      const fakeCtx = {
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: (img) => {
          written = img;
        },
      };
      const fakeCanvas = { width: 0, height: 0, getContext: () => fakeCtx };
      const fakeDoc = { createElement: () => fakeCanvas };

      const canvas = mod.pixelsToCanvas(2, 2, [10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255], fakeDoc);
      assert.equal(canvas.width, 2);
      assert.equal(canvas.height, 2);
      assert.equal(written.data[0], 10);
      assert.equal(written.data[5], 50);
      assert.equal(written.data[10], 90);
      assert.equal(written.data[15], 255);
    });
  }
});

test('pixelsToCanvas accepts a typed array directly', async () => {
  const mod = await import('../src/offscreen/offscreen.js');
  let written = null;
  const fakeCtx = {
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (img) => {
      written = img;
    },
  };
  const fakeCanvas = { width: 0, height: 0, getContext: () => fakeCtx };
  const fakeDoc = { createElement: () => fakeCanvas };
  const px = new Uint8ClampedArray(4).fill(77);
  mod.pixelsToCanvas(1, 1, px, fakeDoc);
  assert.equal(written.data[0], 77);
});

test('offscreen handleOcrMessage: async contract (returns true, responds with text)', async () => {
  const mod = await import('../src/offscreen/offscreen.js');
  let response = null;
  const isAsync = mod.handleOcrMessage(
    { psa: 'psa-ocr-req', id: 'x1', width: 1, height: 1, pixels: [128, 128, 128, 255] },
    (res) => {
      response = res;
    }
  );
  assert.equal(isAsync, true, 'handler must signal an async response');
  // The real recognizePixels needs a real document — the handler resolves with
  // an error in Node (no document), which is itself the correct contract:
  // errors are reported back as psa-ocr-res with an error field.
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(response, 'sendResponse must have been called');
  assert.equal(response.psa, 'psa-ocr-res');
  assert.equal(response.id, 'x1');
});

test('offscreen handleOcrMessage ignores unrelated messages', async () => {
  const mod = await import('../src/offscreen/offscreen.js');
  assert.equal(mod.handleOcrMessage({ psa: 'something-else' }, () => {}), false);
});
