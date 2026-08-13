// scripts/e2e-extension.js
// End-to-end check of the extension. Loads the built unpacked extension into
// headless Chrome, opens a real Showdown battle page (a replay renders through
// the same client as live battles), and verifies:
//
//   1. the assistant panel appears with live battle data and a recommendation,
//   2. the finished battle is recorded into the opponent's profile (persisted
//      through the isolated-world storage bridge),
//   3. the profile survives a page reload (loaded back from chrome.storage),
//   4. the options page lists the learned profile,
//   5. flipping the panel setting in storage hides/shows the panel live.
//
// Requires a build first: npm run build
//
//   node scripts/e2e-extension.js

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

import { findChrome } from './lib/chrome.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = path.join(ROOT, 'extension');
const REPLAY = process.argv[2] ?? 'https://play.pokemonshowdown.com/battle-gen9ou-2104765130-8jjmu80p6yi3y3ndho3b0w1yepcl8dppw';

const CHROME = findChrome();
if (!CHROME) {
  console.error('No Chrome found. Set CHROME env var or run: npx @puppeteer/browsers install chrome@stable --path /tmp/cft-chrome');
  process.exit(1);
}
if (!existsSync(path.join(EXT_DIR, 'dist', 'content.js'))) {
  console.error('extension/dist/content.js missing — run `npm run build` first');
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-gpu',
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
  ],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Panel is up and carrying real battle data.
const panelReady = () => {
  const panel = document.querySelector('#psa-overlay .psa-panel');
  if (!panel) return false;
  const text = panel.innerText ?? '';
  return /Turn \d+/.test(text) && /Best move/.test(text);
};

// The recorded profile strip for the fixture opponent.
const stripReady = (battles) => {
  const text = document.querySelector('#psa-overlay')?.innerText ?? '';
  return text.includes('vs vkhss') && text.includes(`${battles} battle`) && text.includes('record');
};

// Write settings from the page's main world through the isolated-world bridge.
const setSettings = (settings) =>
  new Promise((resolve, reject) => {
    const id = 'e2e-' + Math.random().toString(36).slice(2);
    const onMsg = (ev) => {
      if (ev.source !== window || ev.data?.psa !== 'psa-storage-res' || ev.data.id !== id) return;
      window.removeEventListener('message', onMsg);
      if (ev.data.ok) resolve();
      else reject(new Error(ev.data.error ?? 'bridge error'));
    };
    window.addEventListener('message', onMsg);
    window.postMessage({ psa: 'psa-storage-req', id, op: 'set', key: 'settings', value: settings }, '*');
  });

const results = { chrome: CHROME };
const steps = {};

async function step(name, fn) {
  try {
    await fn();
    steps[name] = 'ok';
  } catch (err) {
    steps[name] = `FAIL: ${String(err).slice(0, 300)}`;
  }
}

try {
  const page = await browser.newPage();
  await page.goto(REPLAY, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 1. Panel with live battle data and a recommendation.
  await step('panel', async () => {
    await page.waitForFunction(panelReady, { timeout: 45000 });
    results.panelMounted = true;
    results.panel = await page.evaluate(() => {
      const panel = document.querySelector('#psa-overlay .psa-panel');
      const text = panel?.innerText ?? '';
      return {
        dataOpp: panel?.getAttribute('data-opp'),
        dataTurn: panel?.getAttribute('data-turn'),
        hasDragonite: text.includes('Dragonite'),
        hasBestMove: text.includes('Best move'),
        hasScaleShot: text.includes('Scale Shot'),
        hasSwitchRow: text.includes('Switch to'),
        reasoningItems: panel?.querySelectorAll('.psa-reasoning li').length ?? 0,
        sample: text.slice(0, 260),
      };
    });
  });

  // 1b. Hovering a Pokémon on screen shows its tooltip, which the assistant
  // reads: the hovered mon (Raging Bolt) gains PP on its revealed moves.
  await step('hoverTooltip', async () => {
    const sel = '.battle .teamicons .picon.has-tooltip';
    await page.waitForSelector(sel, { timeout: 15000 });
    await page.hover(sel);
    await page.waitForFunction(
      () => {
        const overlay = document.getElementById('psa-overlay');
        const text = overlay?.innerText ?? '';
        return Number(overlay?.dataset.psaObserved ?? 0) >= 1 && text.includes('Dragon Pulse (15/16)');
      },
      { timeout: 15000 }
    );
    results.hoverTooltip = await page.evaluate(() => {
      const overlay = document.getElementById('psa-overlay');
      return {
        observed: overlay?.dataset.psaObserved,
        hasPp: (overlay?.innerText ?? '').includes('Dragon Pulse (15/16)'),
      };
    });
  });

  // 2. Battle ends -> opponent profile recorded and persisted via the bridge.
  await step('profileRecorded', async () => {
    await page.waitForFunction(stripReady, { timeout: 30000 }, 1);
    results.profileRecorded = true;
  });

  // 3. Reload: the profile must come back from chrome.storage (fresh page,
  //    fresh in-memory state — only storage survives). The replayed battle
  //    fast-forwards and re-records, so the strip goes straight to "2 battles"
  //    — proof the stored profile was loaded and incremented, not rebuilt.
  await step('profilePersisted', async () => {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(panelReady, { timeout: 45000 });
    await page.waitForFunction(stripReady, { timeout: 30000 }, 2);
    results.profilePersisted = true;
  });

  // 4. Options page lists the learned profile.
  await step('options', async () => {
    let extId = null;
    for (let i = 0; i < 20 && !extId; i++) {
      const sw = (await browser.targets()).find((t) => t.type() === 'service_worker');
      if (sw) extId = new URL(sw.url()).host;
      else await sleep(250);
    }
    if (!extId) throw new Error('no service worker target found — cannot resolve extension id');
    const options = await browser.newPage();
    await options.goto(`chrome-extension://${extId}/options.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await options.waitForFunction(() => !!document.querySelector('.psa-row'), { timeout: 10000 });
    const text = await options.evaluate(() => document.querySelector('#psa-root')?.innerText ?? '');
    results.optionsSample = text.slice(0, 200);
    if (!(text.includes('vkhss') && text.includes('2 battles') && text.includes('record 2-0'))) {
      throw new Error('options page missing the learned profile');
    }
    results.optionsHasProfile = true;
    await options.close();
  });

  // 4b. Popup renders its controls with the current settings.
  await step('popup', async () => {
    let extId = null;
    for (let i = 0; i < 20 && !extId; i++) {
      const sw = (await browser.targets()).find((t) => t.type() === 'service_worker');
      if (sw) extId = new URL(sw.url()).host;
      else await sleep(250);
    }
    if (!extId) throw new Error('no service worker target found — cannot resolve extension id');
    const popup = await browser.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await popup.waitForFunction(() => !!document.querySelector('#psa-panel-enabled'), { timeout: 10000 });
    const popupState = await popup.evaluate(() => ({
      checked: document.querySelector('#psa-panel-enabled')?.checked,
      hasOptionsLink: !!document.querySelector('#psa-open-options'),
    }));
    if (!popupState.checked || !popupState.hasOptionsLink) {
      throw new Error(`popup state wrong: ${JSON.stringify(popupState)}`);
    }
    results.popupOk = true;
    await popup.close();
  });

  // 5. Live toggle: disable -> panel hides; re-enable -> panel returns.
  await step('toggleOff', async () => {
    await page.evaluate(setSettings, { panelEnabled: false, statAssumption: 'max' });
    await page.waitForFunction(
      () => document.getElementById('psa-overlay')?.style.display === 'none',
      { timeout: 10000 }
    );
    results.toggleOff = true;
  });

  await step('toggleOn', async () => {
    await page.evaluate(setSettings, { panelEnabled: true, statAssumption: 'max' });
    await page.waitForFunction(
      () => document.getElementById('psa-overlay')?.style.display !== 'none',
      { timeout: 10000 }
    );
    results.toggleOn = true;
  });

  results.steps = steps;
  results.ok = Object.values(steps).every((s) => s === 'ok');
} catch (err) {
  results.ok = false;
  results.error = String(err).slice(0, 500);
} finally {
  await browser.close();
}

console.log(JSON.stringify(results, null, 2));
process.exit(results.ok ? 0 : 1);
