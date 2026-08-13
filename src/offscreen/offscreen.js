// src/offscreen/offscreen.js
// Hidden extension page (chrome.offscreen) that runs the tesseract OCR engine.
// The main-world content script can't use chrome.runtime (to resolve the
// bundled asset URLs) and content-script workers can't fetch extension
// resources — so OCR lives here, in a full extension page where workers and
// fetch work normally.
//
// Protocol (chrome.runtime messages):
//   { psa: 'psa-ocr-req', id, width, height, pixels: Uint8ClampedArray }
//   -> sendResponse({ psa: 'psa-ocr-res', id, text })

import { createWorker } from 'tesseract.js';

let workerPromise = null;

function assetBase() {
  return chrome.runtime.getURL('dist/ocr/');
}

// Lazy singleton worker — created on first request, reused after.
function getWorker() {
  if (!workerPromise) {
    const base = assetBase();
    workerPromise = createWorker('eng', 1, {
      workerPath: base + 'worker.min.js',
      corePath: base,
      langPath: base,
      workerBlobURL: false,
    });
  }
  return workerPromise;
}

// Build a canvas from raw RGBA pixels and OCR it.
// Exported as a pure helper (injectable document) so unit tests can exercise
// the pixel reconstruction without a real canvas.
export function pixelsToCanvas(width, height, pixels, doc = document) {
  const canvas = doc.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(width, height);
  // The bridge converts pixels to a plain array (chrome.runtime messaging
  // JSON-serializes, which mangles typed arrays) — convert back here.
  const arr = pixels instanceof Uint8ClampedArray || pixels instanceof Uint8Array ? pixels : new Uint8ClampedArray(pixels);
  imageData.data.set(arr);
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

async function recognizePixels(width, height, pixels) {
  const canvas = pixelsToCanvas(width, height, pixels);
  const worker = await getWorker();
  const { data } = await worker.recognize(canvas);
  return data?.text ?? '';
}

export function handleOcrMessage(msg, sendResponse) {
  if (msg?.psa !== 'psa-ocr-req') return false;
  const { id, width, height, pixels } = msg;
  recognizePixels(width, height, pixels)
    .then((text) => sendResponse({ psa: 'psa-ocr-res', id, text }))
    .catch((err) => sendResponse({ psa: 'psa-ocr-res', id, error: String(err?.message ?? err) }));
  return true; // async response
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => handleOcrMessage(msg, sendResponse));
}
