// test/capture.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { blockHashes, changedBlocks, createCapture } from '../src/content/capture.js';

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

// Like fakeContext but with a rectangular region painted a different color.
function contextWithRegion(width, height, fill, region) {
  const ctx = fakeContext(width, height, fill);
  const img = ctx.getImageData(0, 0, width, height);
  const { x, y, w, h } = region;
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const i = (py * width + px) * 4;
      img.data[i] = 255 - fill.r;
      img.data[i + 1] = 255 - fill.g;
      img.data[i + 2] = 255 - fill.b;
    }
  }
  return ctx;
}

test('blockHashes: stable for identical pixels, different per changed block', () => {
  const ctx1 = fakeContext(320, 180, { r: 10, g: 20, b: 30 });
  const ctx2 = fakeContext(320, 180, { r: 10, g: 20, b: 30 });
  const ctx3 = fakeContext(320, 180, { r: 11, g: 20, b: 30 });

  assert.deepEqual(blockHashes(ctx1, 320, 180), blockHashes(ctx2, 320, 180));
  assert.notDeepEqual(blockHashes(ctx1, 320, 180), blockHashes(ctx3, 320, 180));
});

test('changedBlocks: idle animation (a few blocks) is ignored, real changes count', () => {
  const bw = Math.floor(320 / 32); // 10 blocks wide
  // A bobbing sprite: a ~30x30 region (about one block) shifts by a few px.
  const idleA = contextWithRegion(320, 180, { r: 10, g: 20, b: 30 }, { x: 60, y: 40, w: 30, h: 30 });
  const idleB = contextWithRegion(320, 180, { r: 10, g: 20, b: 30 }, { x: 70, y: 45, w: 30, h: 30 });
  const idle = changedBlocks(blockHashes(idleA, 320, 180), blockHashes(idleB, 320, 180), bw);
  assert.ok(idle.count < 5, `idle bobbing must stay under the threshold, got ${idle.count}`);

  // A tooltip: a ~100x70 region (4x3 blocks) appears.
  const quiet = fakeContext(320, 180, { r: 10, g: 20, b: 30 });
  const tooltip = contextWithRegion(320, 180, { r: 10, g: 20, b: 30 }, { x: 40, y: 30, w: 100, h: 70 });
  const tip = changedBlocks(blockHashes(quiet, 320, 180), blockHashes(tooltip, 320, 180), bw);
  assert.ok(tip.count >= 5, `a tooltip must count as a change, got ${tip.count}`);
  assert.ok(tip.bx0 <= 2 && tip.bx1 >= 4, 'the change bbox spans the tooltip region');
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
