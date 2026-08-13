// src/popup/popup.js
// Toolbar popup: quick on/off for the panel and a link to the options page.
// Runs in the extension context, so the unified storage driver uses
// chrome.storage.local directly.

import { loadSettings, saveSettings, normalizeSettings } from '../settings.js';

const PANEL_TEMPLATE = `
<div class="psa-popup">
  <div class="psa-popup-title">⚡ Battle Assistant</div>
  <label class="psa-popup-setting">
    <input type="checkbox" id="psa-panel-enabled" />
    <span>Panel over battles</span>
  </label>
  <button type="button" id="psa-start-capture" class="psa-popup-capture">▶ Start watching screen</button>
  <button type="button" id="psa-stop-capture" class="psa-popup-capture psa-popup-capture-stop" hidden>■ Stop watching screen</button>
  <p class="psa-popup-note">Start watching = real screen capture: Chrome shows a recording indicator, the panel flashes on every hover, and tooltips that don't render as DOM are read from the pixels (OCR).</p>
  <button type="button" id="psa-open-options" class="psa-popup-link">Options…</button>
</div>`;

async function sendToTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await chrome.runtime.sendMessage({ ...message, tabId: tab.id });
}

export async function main() {
  const root = document.getElementById('psa-root');
  if (!root) return;
  root.innerHTML = PANEL_TEMPLATE;

  const checkbox = root.querySelector('#psa-panel-enabled');
  const openOptions = root.querySelector('#psa-open-options');
  const startBtn = root.querySelector('#psa-start-capture');
  const stopBtn = root.querySelector('#psa-stop-capture');

  const settings = normalizeSettings(await loadSettings());
  checkbox.checked = settings.panelEnabled;

  checkbox.addEventListener('change', async () => {
    settings.panelEnabled = checkbox.checked;
    await saveSettings(settings);
  });

  // User gesture: obtain the tab's capture stream id (only allowed from the
  // action UI) and hand it to the battle page via the worker + bridge.
  startBtn.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      // consumerTabId must match the tab whose content script will consume the
      // stream — without it the stream id can only be used by extension pages.
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id, consumerTabId: tab.id });
      await sendToTab({ psa: 'psa-capture-start', streamId });
      startBtn.hidden = true;
      stopBtn.hidden = false;
    } catch (err) {
      console.error('capture start failed', err);
    }
  });

  stopBtn.addEventListener('click', async () => {
    await sendToTab({ psa: 'psa-capture-stop' });
    startBtn.hidden = false;
    stopBtn.hidden = true;
  });

  openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
}

// Auto-run in the browser (module script); no-op when imported in Node tests.
if (typeof document !== 'undefined') main();
