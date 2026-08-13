// src/content/ocr.js
// Main-world OCR client. The main content script runs in the page's MAIN
// world where chrome.runtime is unavailable, so to reach the tesseract engine
// (which lives in an offscreen extension document) it posts the captured
// pixels to the isolated-world bridge, which forwards them over
// chrome.runtime messaging and posts the recognized text back here.
//
// The canvas the caller passes is sampled from the live tab capture video, so
// this is the genuine pixel-OCR fallback for tooltips that never render as
// DOM elements.

let ocrId = 0;

// OCR a canvas (or ImageData) to text. Resolves null on failure — callers
// treat OCR as best-effort.
export function ocrCanvas(canvas, timeoutMs = 20000) {
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  let data;
  try {
    data = ctx.getImageData(0, 0, width, height).data;
  } catch {
    return Promise.resolve(null);
  }
  const id = `ocr-${++ocrId}-${Date.now()}`;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMsg);
      resolve(null);
    }, timeoutMs);

    const onMsg = (ev) => {
      if (ev.source !== window || ev.data?.psa !== 'psa-ocr-res' || ev.data.id !== id) return;
      window.removeEventListener('message', onMsg);
      clearTimeout(timer);
      if (ev.data.error) resolve(null);
      else resolve(ev.data.text ?? null);
    };

    window.addEventListener('message', onMsg);
    // Copy the pixels into a plain Uint8ClampedArray for postMessage.
    window.postMessage(
      { psa: 'psa-ocr-req', id, width, height, pixels: new Uint8ClampedArray(data) },
      '*'
    );
  });
}

// Parse tesseract output the same way we parse the DOM tooltip text — both
// are the same human-readable lines (species, Label: value, • moves).
import { parseTooltipText } from './tooltips.js';
export function parseOcrText(text) {
  return parseTooltipText(text);
}
