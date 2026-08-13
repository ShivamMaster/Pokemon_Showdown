// test/capture.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { frameHash, createCapture } from '../src/content/capture.js';

// A minimal fake 2D context that returns deterministic pixel data.
function fakeContext(width, height, fill) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill.r;
    data[i + 1] = fill.g;
    data[i + 2] = fill.b;
    data[i + 3] = 255;
  }
  return {
    getImageData: () => ({ data }),
    drawImage: () => {},
  };
}

test('frameHash: stable for identical pixels, different for changed pixels', () => {
  const ctx1 = fakeContext(320, 180, { r: 10, g: 20, b: 30 });
  const ctx2 = fakeContext(320, 180, { r: 10, g: 20, b: 30 });
  const ctx3 = fakeContext(320, 180, { r: 11, g: 20, b: 30 });

  assert.equal(frameHash(ctx1, 320, 180), frameHash(ctx2, 320, 180));
  assert.notEqual(frameHash(ctx1, 320, 180), frameHash(ctx3, 320, 180));
});

test('createCapture: start/stop lifecycle and stats', async () => {
  let readyState = 0;
  const video = {
    srcObject: null,
    muted: false,
    playsInline: false,
    play: async () => {
      readyState = 2;
    },
    get readyState() {
      return readyState;
    },
  };
  const canvas = { width: 0, height: 0, getContext: () => fakeContext(320, 180, { r: 5, g: 5, b: 5 }) };
  const tracks = [];
  const stream = {
    getTracks: () => tracks,
  };

  const origGetUserMedia = globalThis.navigator?.mediaDevices?.getUserMedia;
  try {
    const fakeNav = {
      mediaDevices: {
        getUserMedia: async () => {
          tracks.push({ stop: () => {} });
          return stream;
        },
      },
    };
    Object.defineProperty(globalThis, 'navigator', { value: fakeNav, configurable: true });

    const capture = createCapture({ video, canvas });

    // Not capturing initially.
    assert.equal(capture.isCapturing(), false);
    assert.deepEqual(capture.getStats(), {
      active: false,
      frames: 0,
      changes: 0,
      width: 320,
      height: 180,
    });

    let updates = 0;
    capture.setOnUpdate(() => updates++);

    // Start: stats go active, frames accumulate on the tick timer.
    const stats = await capture.start('stream-id-123');
    assert.equal(stats.active, true);
    assert.equal(capture.isCapturing(), true);
    await new Promise((r) => setTimeout(r, 650)); // ~2 ticks at 250ms
    const mid = capture.getStats();
    assert.ok(mid.frames >= 1, `expected frames to accumulate, got ${mid.frames}`);
    assert.ok(mid.changes >= 1, `expected changes (same hash only first frame), got ${mid.changes}`);
    assert.ok(updates > 0, 'onUpdate should fire while capturing');

    // Stop: stream tracks stopped, stats inactive.
    capture.stop();
    assert.equal(capture.isCapturing(), false);
    assert.equal(capture.getStats().active, false);
    assert.equal(tracks.length, 1);
    assert.equal(video.srcObject, null);
  } finally {
    if (origGetUserMedia) {
      Object.defineProperty(globalThis, 'navigator', {
        value: { mediaDevices: { getUserMedia: origGetUserMedia } },
        configurable: true,
      });
    }
  }
});

test('createCapture: start failure surfaces the error and stays inactive', async () => {
  const video = { srcObject: null, muted: false, playsInline: false, play: async () => {}, readyState: 0 };
  const canvas = { width: 0, height: 0, getContext: () => fakeContext(320, 180, { r: 0, g: 0, b: 0 }) };

  const origGetUserMedia = globalThis.navigator?.mediaDevices?.getUserMedia;
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        mediaDevices: {
          getUserMedia: async () => {
            throw new Error('Error starting tab capture');
          },
        },
      },
      configurable: true,
    });

    const capture = createCapture({ video, canvas });
    await assert.rejects(() => capture.start('bad-id'), /Error starting tab capture/);
    assert.equal(capture.isCapturing(), false);
    assert.match(capture.getStats().error ?? '', /Error starting tab capture/);
  } finally {
    if (origGetUserMedia) {
      Object.defineProperty(globalThis, 'navigator', {
        value: { mediaDevices: { getUserMedia: origGetUserMedia } },
        configurable: true,
      });
    }
  }
});

test('grabRegion: samples a CSS rect from the live video at scale', async () => {
  let drawn = null;
  const video = {
    videoWidth: 800,
    videoHeight: 600,
    srcObject: null,
    muted: false,
    playsInline: false,
    play: async () => {},
    readyState: 2,
  };
  const outCanvas = { width: 0, height: 0, getContext: () => ({ drawImage: () => {} }) };
  let createCount = 0;
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => fakeContext(320, 180, { r: 0, g: 0, b: 0 }),
  };
  const origGetUserMedia = globalThis.navigator?.mediaDevices?.getUserMedia;
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        mediaDevices: {
          getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }),
        },
      },
      configurable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      value: { innerWidth: 800, innerHeight: 600 },
      configurable: true,
    });
    // Patch document.createElement to return the output canvas for grabRegion.
    const origCreate = globalThis.document?.createElement;
    Object.defineProperty(globalThis, 'document', {
      value: {
        createElement: (tag) => {
          if (tag === 'canvas') {
            createCount++;
            return outCanvas;
          }
          return origCreate?.(tag);
        },
      },
      configurable: true,
    });

    const capture = createCapture({ video, canvas });
    await capture.start('id');

    const result = capture.grabRegion({ x: 100, y: 200, w: 200, h: 100, scale: 2 });
    assert.ok(result, 'grabRegion should return a canvas while capturing');
    assert.equal(result.width, 400); // 200 css * 2 scale
    assert.equal(result.height, 200);
    // Not capturing -> null.
    capture.stop();
    assert.equal(capture.grabRegion({}), null);
  } finally {
    if (origGetUserMedia) {
      Object.defineProperty(globalThis, 'navigator', {
        value: { mediaDevices: { getUserMedia: origGetUserMedia } },
        configurable: true,
      });
    }
    delete globalThis.window;
    delete globalThis.document;
  }
});

test('createCapture: start twice is a no-op (stream kept)', async () => {
  const video = { srcObject: null, muted: false, playsInline: false, play: async () => {}, readyState: 0 };
  const canvas = { width: 0, height: 0, getContext: () => fakeContext(320, 180, { r: 0, g: 0, b: 0 }) };

  let calls = 0;
  const origGetUserMedia = globalThis.navigator?.mediaDevices?.getUserMedia;
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        mediaDevices: {
          getUserMedia: async () => {
            calls++;
            return { getTracks: () => [{ stop: () => {} }] };
          },
        },
      },
      configurable: true,
    });

    const capture = createCapture({ video, canvas });
    await capture.start('id');
    await capture.start('id-again');
    assert.equal(calls, 1, 'second start must not create a second stream');
    assert.equal(capture.isCapturing(), true);
    capture.stop();
  } finally {
    if (origGetUserMedia) {
      Object.defineProperty(globalThis, 'navigator', {
        value: { mediaDevices: { getUserMedia: origGetUserMedia } },
        configurable: true,
      });
    }
  }
});
