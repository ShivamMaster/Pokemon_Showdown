// src/options/options.js
// Extension options page: manages the assistant settings (panel on/off, stat
// assumption) and the learned per-opponent profiles (view, delete, clear).
//
// The render functions are pure (DOM-free) so they run in Node tests; main()
// wires them to the page. Bundled by esbuild into extension/dist/options.js.

import { loadProfiles, saveProfiles } from '../profiles/index.js';
import { profileForDisplay } from '../profiles/index.js';
import { loadSettings, saveSettings, normalizeSettings } from '../settings.js';
import { escapeHtml } from '../ui/panel.js';

// ---------------------------------------------------------------------------
// Pure rendering
// ---------------------------------------------------------------------------

// Display rows for every learned profile, most-played first.
export function profileRows(profiles) {
  return Object.values(profiles ?? {})
    .map((p) => ({ key: (p.opponent ?? '').toLowerCase(), ...profileForDisplay(p) }))
    .filter((r) => r.opponent)
    .sort((a, b) => b.battles - a.battles);
}

export function renderOptionsHtml(profiles, settings) {
  const s = normalizeSettings(settings);
  const rows = profileRows(profiles);

  const rowsHtml = rows.length
    ? rows
        .map(
          (r) => `<li class="psa-row" data-opp-key="${escapeHtml(r.key)}">
  <span class="psa-row-name">${escapeHtml(r.opponent)}</span>
  <span class="psa-row-stat">${r.battles} battle${r.battles === 1 ? '' : 's'}</span>
  ${r.recordText ? `<span class="psa-row-stat">record ${escapeHtml(r.recordText)}</span>` : ''}
  ${r.commonLead ? `<span class="psa-row-stat">lead ${escapeHtml(r.commonLead.species)} ${r.commonLead.pct}%</span>` : ''}
  ${r.lowHpSwitchRate != null ? `<span class="psa-row-stat">switches when low ${r.lowHpSwitchRate}%</span>` : ''}
  <button class="psa-delete" type="button" data-delete="${escapeHtml(r.key)}">Delete</button>
</li>`
        )
        .join('')
    : '<li class="psa-empty">No profiles yet — play a few battles and they will appear here.</li>';

  return `<main class="psa-options">
  <h1>⚡ Showdown Battle Assistant</h1>

  <section class="psa-section">
    <h2>Settings</h2>
    <label class="psa-setting">
      <input type="checkbox" id="psa-panel-enabled" ${s.panelEnabled ? 'checked' : ''} />
      <span>Show the assistant panel over battles</span>
    </label>
    <label class="psa-setting">
      <span>Assume the opponent runs typical competitive builds</span>
      <select id="psa-stat-assumption">
        <option value="max" ${s.statAssumption === 'max' ? 'selected' : ''}>Max EVs (252 in key stats)</option>
        <option value="base" ${s.statAssumption === 'base' ? 'selected' : ''}>Base stats (no EVs)</option>
      </select>
    </label>
    <p class="psa-hint">Stat assumptions only matter for damage estimates — hidden EVs/natures are never known for sure.</p>
  </section>

  <section class="psa-section">
    <h2>Opponent profiles <span class="psa-count">${rows.length}</span></h2>
    <p class="psa-hint">Learned from finished battles against each player: leads, switching habits, and move usage. Used to predict switch-ins.</p>
    <ul class="psa-rows">${rowsHtml}</ul>
    ${rows.length ? '<button class="psa-clear-all" type="button">Clear all profiles</button>' : ''}
  </section>
</main>`;
}

// ---------------------------------------------------------------------------
// Page wiring
// ---------------------------------------------------------------------------

export async function main() {
  const root = document.getElementById('psa-root');
  if (!root) return;

  let profiles = {};
  let settings = normalizeSettings();

  const render = () => {
    root.innerHTML = renderOptionsHtml(profiles, settings);
    wireEvents();
  };

  const refresh = async () => {
    [profiles, settings] = await Promise.all([loadProfiles(), loadSettings()]);
    render();
  };

  const wireEvents = () => {
    const enabled = root.querySelector('#psa-panel-enabled');
    enabled?.addEventListener('change', async () => {
      settings = normalizeSettings(settings);
      settings.panelEnabled = enabled.checked;
      await saveSettings(settings);
    });

    const stat = root.querySelector('#psa-stat-assumption');
    stat?.addEventListener('change', async () => {
      settings = normalizeSettings(settings);
      settings.statAssumption = stat.value;
      await saveSettings(settings);
    });

    for (const btn of root.querySelectorAll('[data-delete]')) {
      btn.addEventListener('click', async () => {
        delete profiles[btn.getAttribute('data-delete')];
        await saveProfiles(profiles);
        render();
      });
    }

    root.querySelector('.psa-clear-all')?.addEventListener('click', async () => {
      if (!confirm('Delete all learned profiles?')) return;
      profiles = {};
      await saveProfiles(profiles);
      render();
    });
  };

  await refresh();
}

// Auto-run in the browser (module script); no-op when imported in Node tests.
if (typeof document !== 'undefined') main();
