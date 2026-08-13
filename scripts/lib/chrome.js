// scripts/lib/chrome.js
// Finds a Chrome binary to drive: an explicit CHROME env var wins, then a
// Chrome for Testing install (which supports --load-extension in headless;
// managed/system Chrome often blocks it), then the system Chrome as a last
// resort.

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const SYSTEM_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function findCfT() {
  const roots = ['/tmp/cft-chrome', path.join(process.env.HOME ?? '', '.cache', 'puppeteer', 'chrome')];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const found = [];
    const walk = (dir) => {
      let entries = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/Google Chrome for Testing$|chrome$|headless_shell$/.test(e.name) && e.name !== '.DS_Store') {
          found.push(full);
        }
      }
    };
    walk(root);
    if (found.length) return found[0];
  }
  return null;
}

export function findChrome() {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  const cft = findCfT();
  if (cft) return cft;
  for (const c of SYSTEM_CANDIDATES) if (existsSync(c)) return c;
  return null;
}
