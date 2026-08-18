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
//   5. flipping the panel setting in storage hides/shows the panel live,
//   6. item-condition plays (Focus Sash / Weakness Policy) show inline in the
//      matchup Damage row, not just the reasoning,
//   7. the confidence badge's tooltip shows the engine-committee breakdown
//      (calc / KO / speed / context votes).
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

// Write a storage value from the page's main world through the isolated-world
// bridge (same protocol the content script uses). Serialized into the page by
// puppeteer, so each helper is fully self-contained (no closure references).
const setStorage = (key, value) =>
  new Promise((resolve, reject) => {
    const id = 'e2e-' + Math.random().toString(36).slice(2);
    const onMsg = (ev) => {
      if (ev.source !== window || ev.data?.psa !== 'psa-storage-res' || ev.data.id !== id) return;
      window.removeEventListener('message', onMsg);
      if (ev.data.ok) resolve();
      else reject(new Error(ev.data.error ?? 'bridge error'));
    };
    window.addEventListener('message', onMsg);
    window.postMessage({ psa: 'psa-storage-req', id, op: 'set', key, value }, '*');
  });
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
  // The very first navigation right after launch can race the browser's
  // about:blank frame ("Requesting main frame too early!") — retry it once.
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(REPLAY, { waitUntil: 'domcontentloaded', timeout: 60000 });
      break;
    } catch (err) {
      if (attempt >= 1 || !/Requesting main frame too early/.test(String(err))) throw err;
      await sleep(1500);
    }
  }

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
        winGauge: !!panel?.querySelector('.psa-win-gauge'),
        winGaugeText: (panel?.querySelector('.psa-win-value')?.innerText ?? '').trim(),
        sample: text.slice(0, 260),
      };
    });
    // The per-turn win-probability gauge should be present with a percentage
    // read on any live turn (the positional eval runs every turn). The only
    // exception is a decided game — the log this test replays ends at the
    // win screen, where recommend() returns early with no risk read.
    const decided = results.panel.sample.includes('wins');
    if (!decided && (!results.panel.winGauge || !/^~\d+%$/.test(results.panel.winGaugeText))) {
      throw new Error(`win-probability gauge missing or malformed: ${JSON.stringify(results.panel)}`);
    }
  });

  // 1a. While a battle is being watched, the toolbar icon carries a LIVE
  // badge (set by the service worker from the content script's report).
  await step('badge', async () => {
    let extId = null;
    for (let i = 0; i < 20 && !extId; i++) {
      const sw = (await browser.targets()).find((t) => t.type() === 'service_worker');
      if (sw) extId = new URL(sw.url()).host;
      else await sleep(250);
    }
    if (!extId) throw new Error('no service worker target found');
    const sw = (await browser.targets()).find((t) => t.type() === 'service_worker');
    await page.waitForFunction(
      () => document.getElementById('psa-overlay')?.dataset.psaTurn != null,
      { timeout: 30000 }
    );
    const client = await sw.createCDPSession();
    const { result } = await client.send('Runtime.evaluate', {
      expression: 'chrome.action.getBadgeText({})',
      awaitPromise: true,
      returnByValue: true,
    });
    const badge = result?.value ?? '';
    results.badge = badge;
    if (badge !== 'LIVE') throw new Error(`badge should be LIVE while watching, got "${badge}"`);
  });

  // 1b. Hovering a Pokémon on screen shows its tooltip, which the assistant
  // reads: the hovered mon (Raging Bolt) gains PP on its revealed moves, and
  // the panel gives instant visual feedback (flash + counter) on EVERY hover.
  await step('hoverTooltip', async () => {
    const sel = '.battle .teamicons .picon.has-tooltip';
    await page.waitForSelector(sel, { timeout: 15000 });
    await page.hover(sel);
    await page.waitForFunction(
      () => {
        const overlay = document.getElementById('psa-overlay');
        const text = overlay?.innerText ?? '';
        return (
          Number(overlay?.dataset.psaObserved ?? 0) >= 1 &&
          Number(overlay?.dataset.psaHover ?? 0) >= 1 &&
          text.includes('Dragon Pulse (15/16)') &&
          text.includes('watching your screen')
        );
      },
      { timeout: 15000 }
    );
    // Hover away, then hover the SAME icon again: the panel must still
    // acknowledge the second hover (feedback fires every time, even when no
    // new info is learned) — the reading counter goes 1 -> 2.
    await page.mouse.move(0, 0);
    await new Promise((r) => setTimeout(r, 400));
    await page.hover(sel);
    await page.waitForFunction(
      () => Number(document.getElementById('psa-overlay')?.dataset.psaHover ?? 0) >= 2,
      { timeout: 10000 }
    );
    const flashed = await page.evaluate(
      () => document.querySelector('#psa-overlay .psa-panel')?.classList.contains('psa-flash')
    );
    results.hoverTooltip = await page.evaluate(() => {
      const overlay = document.getElementById('psa-overlay');
      const panel = overlay?.querySelector('.psa-panel');
      return {
        observed: overlay?.dataset.psaObserved,
        hovers: overlay?.dataset.psaHover,
        hasPp: (overlay?.innerText ?? '').includes('Dragon Pulse (15/16)'),
        hasWatchRow: (overlay?.innerText ?? '').includes('watching your screen'),
        flashed: panel?.classList.contains('psa-flash'),
      };
    });
    if (Number(results.hoverTooltip.hovers) < 2) {
      throw new Error('hover feedback counter did not increment on the second hover');
    }
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
    const optionsState = await options.evaluate(() => {
      const root = document.querySelector('#psa-root');
      return {
        text: root?.innerText ?? '',
        names: [...root.querySelectorAll('.psa-row-name')].map((i) => i.value),
      };
    });
    results.optionsSample = optionsState.text.slice(0, 200);
    if (!(optionsState.names.includes('vkhss') && optionsState.text.includes('2 battles') && optionsState.text.includes('record 2-0'))) {
      throw new Error(`options page missing the learned profile: ${JSON.stringify(optionsState)}`);
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

  // 4c. Real screen capture: trigger the extension's toolbar action (the
  // invocation a real click would grant), click Start in the popup, and verify
  // the tab stream is live (frames increment, panel reports capture, stop
  // halts it). This is the "watching my screen" path — Chrome shows its
  // recording indicator while this stream is active.
  await step('capture', async () => {
    const exts = await browser.extensions();
    const ext = [...exts.values()][0];
    if (!ext) throw new Error('no extension found for capture step');
    await page.triggerExtensionAction(ext);

    let popupTarget = null;
    for (let i = 0; i < 15 && !popupTarget; i++) {
      await sleep(400);
      popupTarget = (await browser.targets()).find((t) => t.type() === 'page' && t.url().includes('popup.html'));
    }
    if (!popupTarget) throw new Error('popup did not open after triggering the action');
    const capturePopup = await popupTarget.asPage();
    await capturePopup.waitForSelector('#psa-start-capture', { timeout: 10000 });
    await capturePopup.click('#psa-start-capture');

    const readCapture = () =>
      page.evaluate(() => {
        const overlay = document.getElementById('psa-overlay');
        const m = (overlay?.innerText ?? '').match(/(\d+) frames · (\d+) changes/);
        return { capturing: overlay?.dataset.psaCapturing, frames: m ? +m[1] : 0 };
      });

    await page.waitForFunction(
      () => document.getElementById('psa-overlay')?.dataset.psaCapturing === 'true',
      { timeout: 15000 }
    );
    const s1 = await readCapture();
    await sleep(2500);
    const s2 = await readCapture();
    if (!(s2.frames > s1.frames)) {
      throw new Error(`capture frames not incrementing: ${JSON.stringify(s1)} -> ${JSON.stringify(s2)}`);
    }
    results.capture = { started: s1, later: s2 };

    // Stop from the popup: the stream must actually halt.
    await capturePopup.bringToFront();
    await capturePopup.click('#psa-stop-capture');
    await page.waitForFunction(
      () => document.getElementById('psa-overlay')?.dataset.psaCapturing === 'false',
      { timeout: 10000 }
    );
    results.captureStopped = true;
  });

  // 4d. OCR fallback: hover a Pokémon while the client renders NO tooltip DOM
  // (simulated by hiding .tooltip and drawing the tooltip as a plain pixel
  // element). The extension must grab the region from the capture video, run
  // tesseract in the offscreen document, and merge the recognized PP into the
  // panel. This is the pixel-OCR fallback for tooltips that never appear as
  // DOM. (Slow: first OCR loads wasm + traineddata, ~5-15s.)
  await step('ocrFallback', async () => {
    // Restart capture (the capture step stopped it) so we have frames.
    const exts = await browser.extensions();
    const ext = [...exts.values()][0];
    if (!ext) throw new Error('no extension found for ocr step');
    await page.triggerExtensionAction(ext);
    let popupTarget = null;
    for (let i = 0; i < 15 && !popupTarget; i++) {
      await sleep(400);
      popupTarget = (await browser.targets()).find((t) => t.type() === 'page' && t.url().includes('popup.html'));
    }
    if (!popupTarget) throw new Error('popup did not open for ocr step');
    const ocrPopup = await popupTarget.asPage();
    await ocrPopup.waitForSelector('#psa-start-capture', { timeout: 10000 });
    await ocrPopup.click('#psa-start-capture');
    await page.waitForFunction(
      () => document.getElementById('psa-overlay')?.dataset.psaCapturing === 'true',
      { timeout: 15000 }
    );

    // Suppress the client's DOM tooltip entirely and draw the tooltip text as
    // a plain fixed element (pixels on screen, never a .tooltip node) — the
    // exact "tooltip rendered but not as DOM" case OCR exists for.
    await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = '.tooltip, .tooltipwrapper, #tooltipwrapper { display: none !important; }';
      document.head.appendChild(style);
      const icon = document.querySelector('.battle .teamicons .picon.has-tooltip');
      const r = icon?.getBoundingClientRect();
      if (!r) return;
      const div = document.createElement('div');
      div.id = 'psa-fake-tooltip';
      div.style.cssText =
        `position:fixed; left:${Math.max(0, r.x - 30)}px; top:${Math.max(0, r.y - 175)}px; ` +
        'width:300px; background:#2a2f3a; color:#fff; font:13px/1.5 Verdana,sans-serif; ' +
        'padding:10px; z-index:99999; border-radius:6px;';
      div.innerHTML =
        '<div style="font-weight:bold;font-size:15px">Raging Bolt</div>' +
        '<div>Ability: Protosynthesis</div>' +
        '<div>Item: Booster Energy</div>' +
        '<div style="margin-top:4px">• Dragon Pulse (15/16)</div>' +
        '<div>• Thunderbolt (15/16)</div>';
      document.body.appendChild(div);
    });
    await sleep(600);

    const sel = '.battle .teamicons .picon.has-tooltip';
    await page.hover(sel);

    await page.waitForFunction(
      () =>
        Number(document.getElementById('psa-overlay')?.dataset.psaOcr ?? 0) >= 1 &&
        (Number(document.getElementById('psa-overlay')?.dataset.psaObserved ?? 0) >= 1 ||
          Number(document.getElementById('psa-overlay')?.dataset.psaHover ?? 0) >= 1),
      { timeout: 60000 }
    );
    await page.waitForFunction(
      () => (document.getElementById('psa-overlay')?.innerText ?? '').includes('Dragon Pulse (15/16)'),
      { timeout: 30000 }
    );
    results.ocrFallback = await page.evaluate(() => {
      const ov = document.getElementById('psa-overlay');
      const text = ov?.innerText ?? '';
      return {
        ocr: ov?.dataset.psaOcr,
        observed: ov?.dataset.psaObserved,
        hasDragonPulsePp: text.includes('Dragon Pulse (15/16)'),
        hasThunderPp: text.includes('Thunderbolt (15/16)'),
      };
    });
    if (!results.ocrFallback.hasDragonPulsePp) {
      throw new Error(`OCR fallback did not surface PP: ${JSON.stringify(results.ocrFallback)}`);
    }
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

  // 5a. Compact mode: the ▤ header button collapses the reasoning list and
  // the matchup table to one line each (and tucks the full-calc panel away).
  // The E2E replay has finished (winner set, no active matchup), so feed the
  // reader a fresh matchup through the same live stepQueue the client uses —
  // the panel then renders a real matchup to collapse. The preference
  // persists across a page reload (localStorage).
  await step('compact', async () => {
    await page.evaluate(() => {
      const battle = window.app?.curRoom?.battle;
      if (!battle || !Array.isArray(battle.stepQueue)) throw new Error('no battle stepQueue');
      battle.stepQueue.push('|switch|p1a: Snorlax|Snorlax|100/100');
      battle.stepQueue.push('|switch|p2a: Blissey|Blissey|100/100');
    });
    await page.waitForFunction(
      () => !!document.querySelector('#psa-overlay .psa-matchup'),
      { timeout: 15000 }
    );
    await page.evaluate(() => {
      const btn = document.querySelector('#psa-overlay .psa-compact');
      if (!btn) throw new Error('no compact toggle button');
      btn.click();
    });
    await page.waitForFunction(
      () => document.querySelector('#psa-overlay .psa-panel')?.classList.contains('psa-compact'),
      { timeout: 10000 }
    );
    const state = await page.evaluate(() => {
      const panel = document.querySelector('#psa-overlay .psa-panel');
      const visible = (el) => !!el && getComputedStyle(el).display !== 'none';
      const lis = [...(panel?.querySelectorAll('.psa-reasoning li') ?? [])];
      const trs = [...(panel?.querySelectorAll('.psa-match-table tr') ?? [])];
      const dmg = panel?.querySelector('.psa-match-row-dmg');
      return {
        compact: panel?.classList.contains('psa-compact') ?? false,
        hasMatchup: !!panel?.querySelector('.psa-matchup'),
        matchTrs: trs.length,
        visibleReasoning: lis.filter(visible).length,
        visibleMatchRows: trs.filter(visible).length,
        dmgDisplay: dmg ? getComputedStyle(dmg).display : 'no-dmg-row',
        calcHidden: !visible(panel?.querySelector('.psa-calc-panel')),
        // Snorlax vs Blissey both at full HP = an even board, so auto risk
        // mode resolves to balanced and no risk badge should render.
        riskBadge: !!panel?.querySelector('.psa-rec-risk'),
        panelSample: (panel?.innerText ?? '').slice(0, 180),
      };
    });
    results.compact = state;
    if (!state.compact || !state.hasMatchup || state.visibleMatchRows !== 1 || state.visibleReasoning > 1 || !state.calcHidden) {
      throw new Error(`compact mode did not collapse to one line: ${JSON.stringify(state)}`);
    }
    if (state.riskBadge) {
      throw new Error(`even board should not render a risk badge: ${JSON.stringify(state)}`);
    }
    // The preference survives a page reload.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () =>
        document.getElementById('psa-overlay')?.dataset.psaTurn != null &&
        document.querySelector('#psa-overlay .psa-panel')?.classList.contains('psa-compact'),
      { timeout: 30000 }
    );
    results.compactPersisted = true;
  });

  // 5b. Item-condition plays surface in the matchup Damage row, not just the
  // reasoning: feed the reader a matchup where our best move KOs their
  // full-HP active holding a revealed Focus Sash (the row must say the Sash
  // survives it), then one where our super-effective click would trigger a
  // revealed Weakness Policy (the row must warn). Same live stepQueue the
  // compact step uses to fabricate a matchup.
  await step('itemNotes', async () => {
    // Focus Sash: our Kyurem's Ice Beam KOs their full-HP Garchomp, but the
    // revealed Sash eats the KO — the Damage row must say so.
    await page.evaluate(() => {
      const battle = window.app?.curRoom?.battle;
      if (!battle || !Array.isArray(battle.stepQueue)) throw new Error('no battle stepQueue');
      battle.stepQueue.push(
        '|switch|p1a: Kyurem|Kyurem|100/100',
        '|switch|p2a: Garchomp|Garchomp|100/100',
        '|move|p1a: Kyurem|Ice Beam|p2a: Garchomp',
        '|move|p2a: Garchomp|Earthquake|p1a: Kyurem',
        '|item|p2a: Garchomp|Focus Sash'
      );
    });
    await page.waitForFunction(
      () => (document.getElementById('psa-overlay')?.innerText ?? '').includes('their Focus Sash survives it'),
      { timeout: 20000 }
    );
    const sashRow = await page.evaluate(() => {
      const panel = document.querySelector('#psa-overlay .psa-panel');
      const row = panel?.querySelector('.psa-match-row-dmg');
      return row?.innerText ?? '';
    });
    if (!sashRow.includes('their Focus Sash survives it')) {
      throw new Error(`sash note missing from the Damage row: ${JSON.stringify(sashRow)}`);
    }
    results.itemSashNote = true;

    // Weakness Policy: our Iron Treads' Ice Spinner is 4× on their Garchomp
    // but doesn't KO (~63% with real spreads) — clicking it triggers the +2,
    // and the row must warn. (Milotic vs Dragonite used to fit here, but with
    // real-set spreads Milotic's Ice Beam now OHKOs a 0-SpD Dragonite, which
    // skips the note entirely.)
    await page.evaluate(() => {
      const battle = window.app?.curRoom?.battle;
      if (!battle || !Array.isArray(battle.stepQueue)) throw new Error('no battle stepQueue');
      battle.stepQueue.push(
        '|switch|p1a: Iron Treads|Iron Treads|100/100',
        '|switch|p2a: Garchomp|Garchomp|100/100',
        '|move|p1a: Iron Treads|Ice Spinner|p2a: Garchomp',
        '|move|p2a: Garchomp|Earthquake|p1a: Iron Treads',
        '|item|p2a: Garchomp|Weakness Policy'
      );
    });
    await page.waitForFunction(
      () => (document.getElementById('psa-overlay')?.innerText ?? '').includes('triggers their Weakness Policy (+2)'),
      { timeout: 20000 }
    );
    const wpRow = await page.evaluate(() => {
      const panel = document.querySelector('#psa-overlay .psa-panel');
      const row = panel?.querySelector('.psa-match-row-dmg');
      return row?.innerText ?? '';
    });
    if (!wpRow.includes('triggers their Weakness Policy (+2)')) {
      throw new Error(`WP note missing from the Damage row: ${JSON.stringify(wpRow)}`);
    }
    results.itemWpNote = true;
  });

  // 5c. The confidence badge's tooltip shows the engine-committee breakdown:
  // feed a matchup where the best move clearly wins (Garchomp's Earthquake
  // is 4× on Heatran), then read the badge's title attribute — it must carry
  // the calc / KO / speed / context votes, not just "how strongly preferred".
  await step('engineVotes', async () => {
    await page.evaluate(() => {
      const battle = window.app?.curRoom?.battle;
      if (!battle || !Array.isArray(battle.stepQueue)) throw new Error('no battle stepQueue');
      battle.stepQueue.push(
        '|switch|p1a: Garchomp|Garchomp|100/100',
        '|switch|p2a: Heatran|Heatran|100/100',
        '|move|p1a: Garchomp|Earthquake|p2a: Heatran',
        '|move|p2a: Heatran|Lava Plume|p1a: Garchomp'
      );
    });
    // Wait for the NEW matchup to render (the badge from the previous WP
    // step would otherwise satisfy an early wait): Earthquake must be the
    // recommended move before reading the tooltip.
    await page.waitForFunction(
      () => {
        const row = document.querySelector('#psa-overlay .psa-rec-row');
        return (row?.innerText ?? '').includes('Earthquake');
      },
      { timeout: 20000 }
    );
    const tip = await page.evaluate(() => {
      const panel = document.querySelector('#psa-overlay .psa-panel');
      const badge = panel?.querySelector('.psa-rec-conf');
      const row = panel?.querySelector('.psa-rec-row');
      const lis = [...(panel?.querySelectorAll('.psa-reasoning li') ?? [])];
      return {
        badgeText: badge?.textContent?.trim() ?? '',
        title: badge?.getAttribute('title') ?? '',
        bestMoveText: row?.innerText ?? '',
        reasoningText: lis.map((li) => li.innerText).join(' | '),
      };
    });
    results.engineVotes = tip;
    // The badge must name the moves and the tooltip must break the score into
    // the committee's votes — a 4× Earthquake should be the confident pick.
    if (!tip.bestMoveText.includes('Earthquake')) {
      throw new Error(`Earthquake should be the recommended move: ${JSON.stringify(tip)}`);
    }
    if (!/\d+%/.test(tip.badgeText)) {
      throw new Error(`no confidence percentage on the best move: ${JSON.stringify(tip)}`);
    }
    for (const vote of ['calc', 'KO', 'speed', 'context', 'response']) {
      if (!tip.title.includes(vote)) {
        throw new Error(`tooltip missing the ${vote} engine vote: ${JSON.stringify(tip)}`);
      }
      // The same breakdown must ALSO be in the reasoning list, not just the
      // tooltip — the votes are part of the visible advice.
      if (!tip.reasoningText.includes(vote)) {
        throw new Error(`reasoning list missing the ${vote} engine vote: ${JSON.stringify(tip)}`);
      }
    }
    if (!tip.reasoningText.includes('Committee on Earthquake')) {
      throw new Error(`reasoning list missing the committee line: ${JSON.stringify(tip)}`);
    }
  });

  // 6. Friend aliases: seed a profile named "John" with "vkhss" as an alias;
  // the next battle (replay re-records on load) must land in John's profile,
  // not a fresh "vkhss" one.
  await step('aliasProfile', async () => {
    const friendProfile = {
      opponent: 'John',
      aliases: ['vkhss'],
      battles: [],
      totalBattles: 0,
      record: { win: 0, loss: 0, tie: 0 },
      commonLeads: {},
      switchIns: {},
      moveUsage: {},
      sets: {},
      lowHpSwitches: 0,
      lowHpFaints: 0,
    };
    await page.evaluate(setStorage, 'profiles', { john: friendProfile });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    let aliasResult = { text: '', opp: '', turn: '', observed: '' };
    try {
      await page.waitForFunction(
        () => {
          const text = document.getElementById('psa-overlay')?.innerText ?? '';
          return text.includes('vs John') && text.includes('1 battle');
        },
        { timeout: 45000 }
      );
    } catch (err) {
      await new Promise((r) => setTimeout(r, 1500));
      aliasResult = await page.evaluate(() => {
        const ov = document.getElementById('psa-overlay');
        return {
          text: (ov?.innerText ?? '').slice(0, 220),
          opp: ov?.dataset.psaOpponent,
          turn: ov?.dataset.psaTurn,
          observed: ov?.dataset.psaObserved,
        };
      });
      throw new Error(`alias wait failed; state=${JSON.stringify(aliasResult)}`);
    }
    results.aliasProfile = await page.evaluate(() => {
      const text = document.getElementById('psa-overlay')?.innerText ?? '';
      return {
        hasFriendName: text.includes('vs John'),
        oneBattle: text.includes('1 battle'),
        noRawUsername: !text.includes('vs vkhss'),
      };
    });
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
