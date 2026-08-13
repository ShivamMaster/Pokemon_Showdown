// scripts/build-ocr-assets.js
// Copies the tesseract.js assets the OCR offscreen document needs into
// extension/dist/ocr/:
//   - worker.min.js          (the tesseract worker script)
//   - tesseract-core-*.wasm.js (core variants; each inlines its wasm as base64,
//                              so the raw .wasm files are NOT needed)
//   - eng.traineddata.gz     (English language data — the traineddata is NOT in
//                              the npm package; it's downloaded once at build
//                              time from the same CDN tesseract.js uses)
//
// All paths are resolved at runtime via chrome.runtime.getURL('dist/ocr/…'),
// so the extension works fully offline after a build.

import { existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'node_modules');
const OUT = path.join(ROOT, 'extension', 'dist', 'ocr');

const TRAINEDDATA_URL =
  'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz';

mkdirSync(OUT, { recursive: true });

const copies = [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  // Core variants — the worker picks one based on SIMD support at runtime.
  'tesseract.js-core/tesseract-core.wasm.js',
  'tesseract.js-core/tesseract-core-lstm.wasm.js',
  'tesseract.js-core/tesseract-core-simd.wasm.js',
  'tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
  'tesseract.js-core/tesseract-core-relaxedsimd.wasm.js',
  'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js',
];

for (const entry of copies) {
  const [rel, name] = typeof entry === 'string' ? [entry, path.basename(entry)] : entry;
  const from = path.join(SRC, rel);
  if (!existsSync(from)) {
    console.error(`⚠ missing ${rel} — run npm install first`);
    process.exit(1);
  }
  copyFileSync(from, path.join(OUT, name));
}

const trainedFile = path.join(OUT, 'eng.traineddata.gz');
if (!existsSync(trainedFile)) {
  console.log('↓ downloading eng.traineddata.gz (one-time)…');
  const res = await fetch(TRAINEDDATA_URL);
  if (!res.ok) throw new Error(`traineddata download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(trainedFile, buf);
  console.log(`  saved ${(buf.length / 1048576).toFixed(1)} MB`);
} else {
  console.log('✓ eng.traineddata.gz present');
}

console.log('⚡ OCR assets done');
