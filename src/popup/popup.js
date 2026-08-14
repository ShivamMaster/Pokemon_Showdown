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
  <p class="psa-popup-status" id="psa-capture-status" hidden></p>
  <p class="psa-popup-note">Start watching = real screen capture: Chrome shows a recording indicator, the panel flashes on every hover, and tooltips that don't render as DOM are read from the pixels (OCR).</p>
  <button type="button" id="psa-open-options" class="psa-popup-link">Options…</button>
</div>`;

async function sendToTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await chrome.runtime.sendMessage({ ...message, tabId: tab.id });
}

// The content script reports back whether the stream actually started
// (content → bridge → background → popup). We wait for that ack instead of
// optimistically flipping the buttons, so a failed start shows an error and
// a retry instead of pretending it worked.
let pendingStart = null;
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.psa !== 'psa-capture-status') return;
  if (pendingStart) {
    pendingStart.resolve(msg);
    pendingStart = null;
  }
});

function waitForStatus(timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingStart) pendingStart = null;
      resolve(null);
    }, timeoutMs);
    pendingStart = {
      resolve: (msg) => {
        clearTimeout(timer);
        resolve(msg);
      },
    };
  });
}

// Start watching with an ack handshake: the stream id from tabCapture is
// single-use and short-lived, and the page's content script may not be ready
// yet — so on a missed ack we grab a fresh id and retry a few times.
async function startCapture(startBtn, stopBtn, statusEl) {
  startBtn.disabled = true;
  statusEl.hidden = false;
  statusEl.className = 'psa-popup-status';
  statusEl.textContent = 'Starting screen watch…';
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        statusEl.textContent = 'No active tab found — open the Showdown battle tab first.';
        break;
      }
      // consumerTabId must match the tab whose content script consumes the
      // stream — without it the id can only be used by extension pages.
      const streamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: tab.id,
        consumerTabId: tab.id,
      });
      const sendRes = await chrome.runtime.sendMessage({ psa: 'psa-capture-start', streamId, tabId: tab.id }).catch(() => null);
      if (sendRes && sendRes.ok === false) {
        lastError = sendRes.error ?? 'Could not start watching.';
        break;
      }
      const ack = await waitForStatus(1500);
      if (ack?.ok) {
        statusEl.hidden = true;
        startBtn.hidden = true;
        stopBtn.hidden = false;
        return;
      }
      if (ack?.error) lastError = ack.error;
    } catch (err) {
      lastError = String(err?.message ?? err);
    }
    statusEl.textContent = `Starting screen watch… (retry ${attempt}/3)`;
  }
  statusEl.textContent = lastError
    ? `Couldn't start: ${lastError}`
    : "Couldn't start screen watch — open a Showdown battle tab (or reload it) and try again.";
  statusEl.className = 'psa-popup-status psa-popup-status-error';
  startBtn.disabled = false;
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
  const statusEl = root.querySelector('#psa-capture-status');

  checkbox.addEventListener('change', async () => {
    settings.panelEnabled = checkbox.checked;
    await saveSettings(settings);
  });

  // User gesture: obtain the tab's capture stream id (only allowed from the
  // action UI) and hand it to the battle page via the worker + bridge.
  startBtn.addEventListener('click', () => {
    startCapture(startBtn, stopBtn, statusEl);
  });

  stopBtn.addEventListener('click', async () => {
    await sendToTab({ psa: 'psa-capture-stop' });
    startBtn.hidden = false;
    stopBtn.hidden = true;
    statusEl.hidden = true;
  });

  openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
}

// Auto-run in the browser (module script); no-op when imported in Node tests.
if (typeof document !== 'undefined') main();
