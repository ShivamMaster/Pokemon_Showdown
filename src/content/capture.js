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
const BLOCK = 32;            // sample-block size in the 320x180 frame (10x5)
// A real on-screen change (hover tooltip, HP bar move, log text) touches
// several blocks; idle sprite bobbing/animations move only one or two. Only
// count a change when at least this many blocks differ.
const MIN_CHANGED_BLOCKS = 5;

// One 32-bit hash per BLOCK×BLOCK block of the frame, from a few sampled
// pixels inside it. Two frames' hashes are compared block-by-block, so a
// small animated region (a bobbing sprite) shows up as a handful of differing
// blocks instead of "the whole screen changed".
export function blockHashes(ctx, w, h) {
  // ceil so the partial blocks at the frame's bottom/right edges are sampled
  // too (pixel indices are clamped below).
  const bw = Math.max(1, Math.ceil(w / BLOCK));
  const bh = Math.max(1, Math.ceil(h / BLOCK));
  const data = ctx.getImageData(0, 0, w, h).data;
  const out = new Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let h1 = 0;
      let h2 = 0;
      for (let sy = 0; sy < 2; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          const px = Math.min(w - 1, bx * BLOCK + Math.floor((BLOCK * (sx + 0.5)) / 2));
          const py = Math.min(h - 1, by * BLOCK + Math.floor((BLOCK * (sy + 0.5)) / 2));
          const i = (py * w + px) * 4;
          h1 = (h1 * 31 + data[i]) | 0;
          h2 = (h2 * 31 + data[i + 2]) | 0;
        }
      }
      out[by * bw + bx] = (h1 << 16) | (h2 & 0xffff);
    }
  }
  return out;
}

// Zero out the hashes of every block overlapped by a page-space rectangle
// (the assistant panel itself). The panel is part of the captured tab, so
// scrolling or resizing it would otherwise register as a constant "screen
// change" — masking it keeps the diff honest about the battle, not the
// extension. Mutates and returns `blocks`.
export function maskRect(blocks, rect, pageW, pageH, frameW, frameH, bw) {
  if (!blocks || !rect || !rect.w || !rect.h || !pageW || !pageH) return blocks;
  const bh = Math.ceil(frameH / BLOCK);
  const bx0 = Math.max(0, Math.floor(((rect.x / pageW) * frameW) / BLOCK));
  const by0 = Math.max(0, Math.floor(((rect.y / pageH) * frameH) / BLOCK));
  const bx1 = Math.min(bw - 1, Math.ceil((((rect.x + rect.w) / pageW) * frameW) / BLOCK) - 1);
  const by1 = Math.min(bh - 1, Math.ceil((((rect.y + rect.h) / pageH) * frameH) / BLOCK) - 1);
  for (let by = by0; by <= by1; by++) {
    for (let bx = bx0; bx <= bx1; bx++) {
      blocks[by * bw + bx] = 0;
    }
  }
  return blocks;
}

// How many blocks differ between two frames, plus the bounding box (in block
// units) of the changed area. Returns { count, bx0, by0, bx1, by1 }.
export function changedBlocks(prev, cur, bw) {
  if (!prev || !cur || prev.length !== cur.length) return { count: 0, bx0: 0, by0: 0, bx1: 0, by1: 0 };
  let count = 0;
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -1;
  let by1 = -1;
  for (let i = 0; i < cur.length; i++) {
    if (prev[i] !== cur[i]) {
      count += 1;
      const bx = i % bw;
      const by = Math.floor(i / bw);
      if (bx < bx0) bx0 = bx;
      if (by < by0) by0 = by;
      if (bx > bx1) bx1 = bx;
      if (by > by1) by1 = by;
    }
  }
  return {
    count,
    bx0: bx0 === Infinity ? 0 : bx0,
    by0: by0 === Infinity ? 0 : by0,
    bx1: Math.max(0, bx1),
    by1: Math.max(0, by1),
  };
}

export function createCapture({ video = document.createElement('video'), canvas = document.createElement('canvas'), maskEl = null } = {}) {
  let stream = null;
  let timer = null;
  let prevBlocks = null;
  const stats = { active: false, frames: 0, changes: 0, width: FRAME_W, height: FRAME_H };
  let onUpdate = null;
  // The page element whose on-screen region should be ignored by change
  // detection (defaults to the assistant panel). Lazily resolved each tick so
  // it works whether or not the panel exists, and safely in non-DOM tests.
  const getMaskEl =
    maskEl ??
    (() =>
      typeof document !== 'undefined' ? document.getElementById('psa-overlay') : null);

  const ctx = canvas.getContext('2d');
  canvas.width = FRAME_W;
  canvas.height = FRAME_H;

  const tick = () => {
    if (!stream || video.readyState < 2) return;
    try {
      ctx.drawImage(video, 0, 0, FRAME_W, FRAME_H);
      const blocks = blockHashes(ctx, FRAME_W, FRAME_H);
      const bw = Math.ceil(FRAME_W / BLOCK);
      // Ignore the assistant panel's own region: scrolling/resizing it is the
      // user interacting with the extension, not a change on the battle.
      const el = getMaskEl();
      if (el && typeof el.getBoundingClientRect === 'function' && typeof window !== 'undefined') {
        const r = el.getBoundingClientRect();
        maskRect(blocks, r, window.innerWidth, window.innerHeight, FRAME_W, FRAME_H, bw);
      }
      stats.frames += 1;
      const first = prevBlocks === null;
      const { count } = changedBlocks(prevBlocks, blocks, bw);
      prevBlocks = blocks;
      // Only meaningful changes count: a tooltip/HP-bar/log change moves many
      // blocks; idle sprite animation moves a few and is ignored.
      if (first || count >= MIN_CHANGED_BLOCKS) stats.changes += 1;
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
    prevBlocks = null;
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
