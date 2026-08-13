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
  <button type="button" id="psa-open-options" class="psa-popup-link">Options…</button>
</div>`;

export async function main() {
  const root = document.getElementById('psa-root');
  if (!root) return;
  root.innerHTML = PANEL_TEMPLATE;

  const checkbox = root.querySelector('#psa-panel-enabled');
  const openOptions = root.querySelector('#psa-open-options');

  const settings = normalizeSettings(await loadSettings());
  checkbox.checked = settings.panelEnabled;

  checkbox.addEventListener('change', async () => {
    settings.panelEnabled = checkbox.checked;
    await saveSettings(settings);
  });

  openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
}

// Auto-run in the browser (module script); no-op when imported in Node tests.
if (typeof document !== 'undefined') main();
