// src/content/capture.js
// Real tab capture for the assistant. The popup obtains a MediaStream id via
// chrome.tabCapture.getMediaStreamId (a user-gesture-only API), this module
// grabs the stream with getUserMedia, renders frames to a small canvas, and
// tracks frame/change stats. While the stream is live Chrome shows its own
// "sharing your screen" indicator — the visible proof the tab is being
// watched.
//
// The pixels are consumed for change detection (hover tooltips, HP bar
// movement, etc.) and the stats are surfaced in the panel; the fast, exact
// reading of tooltip *text* stays DOM-based.

const FRAME_W = 320;
const FRAME_H = 180;
const TICK_MS = 250;

// A tiny rolling hash of sampled pixels — cheap way to tell the on-screen
// content changed since the last frame.
export function frameHash(ctx, w, h) {
  const step = Math.max(1, Math.floor(w / 20));
  const data = ctx.getImageData(0, 0, w, h).data;
  let h1 = 0;
  let h2 = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      h1 = (h1 * 31 + data[i]) | 0;
      h2 = (h2 * 31 + data[i + 2]) | 0;
    }
  }
  return `${h1}:${h2}`;
}

export function createCapture({ video = document.createElement('video'), canvas = document.createElement('canvas') } = {}) {
  let stream = null;
  let timer = null;
  let lastHash = '';
  const stats = { active: false, frames: 0, changes: 0, width: FRAME_W, height: FRAME_H };
  let onUpdate = null;

  const ctx = canvas.getContext('2d');
  canvas.width = FRAME_W;
  canvas.height = FRAME_H;

  const tick = () => {
    if (!stream || video.readyState < 2) return;
    try {
      ctx.drawImage(video, 0, 0, FRAME_W, FRAME_H);
      const hash = frameHash(ctx, FRAME_W, FRAME_H);
      stats.frames += 1;
      if (hash !== lastHash) {
        lastHash = hash;
        stats.changes += 1;
      }
      onUpdate?.();
    } catch {
      // a frame may be mid-update — try again next tick
    }
  };

  async function start(streamId) {
    if (stream) return stats;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId,
          },
        },
      });
    } catch (err) {
      stats.error = String(err?.message ?? err);
      throw err;
    }
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play().catch(() => {});
    stats.active = true;
    stats.frames = 0;
    stats.changes = 0;
    lastHash = '';
    timer = setInterval(tick, TICK_MS);
    return stats;
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    video.srcObject = null;
    stats.active = false;
    onUpdate?.();
    return stats;
  }

  // High-resolution crop of the live video (CSS coordinates in the page).
  // Used by the OCR fallback to read tooltips that never render as DOM
  // elements — the capture video is the real tab at full resolution, so we
  // can sample any region sharply.
  function grabRegion({ x = 0, y = 0, w = 200, h = 150, scale = 2 } = {}) {
    if (!stream || !video.videoWidth) return null;
    const sx = Math.max(0, Math.round((x / window.innerWidth) * video.videoWidth));
    const sy = Math.max(0, Math.round((y / window.innerHeight) * video.videoHeight));
    const sw = Math.max(1, Math.round((w / window.innerWidth) * video.videoWidth));
    const sh = Math.max(1, Math.round((h / window.innerHeight) * video.videoHeight));
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(sw * scale));
    out.height = Math.max(1, Math.round(sh * scale));
    const octx = out.getContext('2d');
    try {
      octx.drawImage(video, sx, sy, sw, sh, 0, 0, out.width, out.height);
    } catch {
      return null;
    }
    return out;
  }

  return {
    start,
    stop,
    isCapturing: () => stats.active,
    getStats: () => ({ ...stats }),
    setOnUpdate: (fn) => {
      onUpdate = fn;
    },
    grabRegion,
  };
}
