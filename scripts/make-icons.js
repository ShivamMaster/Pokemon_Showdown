// scripts/make-icons.js
// Generates the extension icons (16/32/48/128) as PNGs with zero
// dependencies: a hand-rolled PNG encoder on top of Node's built-in zlib.
// Draws a yellow ⚡ bolt on a dark rounded square, matching the panel theme.
//
//   node scripts/make-icons.js   # writes extension/icons/icon-{16,32,48,128}.png

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');

// --- PNG encoding -----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // compression 0, filter 0, interlace 0 (already zero)

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Drawing ----------------------------------------------------------------

const BG = [0x12, 0x14, 0x1a, 255]; // #12141a, panel background
const BOLT = [0xff, 0xd4, 0x3d, 255]; // #ffd43d, accent yellow
const EDGE = [0x2a, 0x2f, 0x3d, 255]; // subtle border

// Bolt polygon in normalized (0..1) coordinates.
const BOLT_POLY = [
  [0.63, 0.05],
  [0.22, 0.58],
  [0.45, 0.58],
  [0.33, 0.95],
  [0.8, 0.42],
  [0.55, 0.42],
  [0.71, 0.05],
];

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const margin = size * 0.06;
  const radius = size * 0.2;
  const inner = size - margin * 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const idx = (y * size + x) * 4;

      // Rounded-square background.
      const nx = Math.max(margin, Math.min(size - margin, px));
      const ny = Math.max(margin, Math.min(size - margin, py));
      const dx = px - nx;
      const dy = py - ny;
      const corner =
        (px < margin + radius && py < margin + radius) || (px > size - margin - radius && py < margin + radius) ||
        (px < margin + radius && py > size - margin - radius) || (px > size - margin - radius && py > size - margin - radius);
      const dist = corner ? Math.hypot(dx, dy) : 0;
      const inRect = px >= margin && px <= size - margin && py >= margin && py <= size - margin;
      const inCorner = corner && dist <= radius;
      const insideBg = inRect || inCorner;
      if (!insideBg) {
        rgba[idx + 3] = 0;
        continue;
      }

      // Bolt.
      const inBolt = pointInPoly(px / size, py / size, BOLT_POLY);
      let color = BG;
      if (inBolt) color = BOLT;
      else if (Math.abs(dx) < 1.5 || Math.abs(dy) < 1.5) color = EDGE;

      rgba[idx] = color[0];
      rgba[idx + 1] = color[1];
      rgba[idx + 2] = color[2];
      rgba[idx + 3] = color[3];
    }
  }
  return encodePng(size, size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, drawIcon(size));
  console.log(`wrote ${file}`);
}
