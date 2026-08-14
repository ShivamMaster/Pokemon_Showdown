// src/options/options.js
// Extension options page: manages the assistant settings (panel on/off, stat
// assumption) and the learned per-opponent profiles (view, delete, clear).
//
// The render functions are pure (DOM-free) so they run in Node tests; main()
// wires them to the page. Bundled by esbuild into extension/dist/options.js.

import {
  loadProfiles,
  saveProfiles,
  profileForDisplay,
  toProfileKey,
  renameProfile,
  addProfileAlias,
  removeProfileAlias,
} from '../profiles/index.js';
import { loadSettings, saveSettings, normalizeSettings } from '../settings.js';
import { escapeHtml } from '../ui/panel.js';

// ---------------------------------------------------------------------------
// Pure rendering
// ---------------------------------------------------------------------------

// Display rows for every learned profile, most-played first.
export function profileRows(profiles) {
  return Object.values(profiles ?? {})
    .map((p) => ({ key: toProfileKey(p?.opponent), aliases: [...(p?.aliases ?? [])], ...profileForDisplay(p) }))
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
  <div class="psa-row-head">
    <input class="psa-row-name" value="${escapeHtml(r.opponent)}" data-opp-key="${escapeHtml(r.key)}" title="Click to rename (e.g. your friend's real name)" />
    <span class="psa-row-stat">${r.battles} battle${r.battles === 1 ? '' : 's'}</span>
    ${r.recordText ? `<span class="psa-row-stat">record ${escapeHtml(r.recordText)}</span>` : ''}
    ${r.commonLead ? `<span class="psa-row-stat">lead ${escapeHtml(r.commonLead.species)} ${r.commonLead.pct}%</span>` : ''}
    ${r.lowHpSwitchRate != null ? `<span class="psa-row-stat">switches when low ${r.lowHpSwitchRate}%</span>` : ''}
    <button class="psa-delete" type="button" data-delete="${escapeHtml(r.key)}">Delete</button>
  </div>
  <div class="psa-row-aliases">
    <span class="psa-alias-label">Also plays as:</span>
    ${(r.aliases ?? [])
      .map(
        (a) => `<span class="psa-alias">${escapeHtml(a)}<button class="psa-alias-remove" type="button" data-remove-alias="${escapeHtml(r.key)}|${escapeHtml(a)}" title="Remove username">×</button></span>`
      )
      .join('')}
    <form class="psa-alias-add" data-opp-key="${escapeHtml(r.key)}">
      <input class="psa-alias-input" placeholder="username…" aria-label="Add username" />
      <button type="submit" class="psa-alias-btn">Add</button>
    </form>
  </div>
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
    <label class="psa-setting">
      <span>Risk mode</span>
      <select id="psa-risk-mode">
        <option value="auto" ${s.riskMode === 'auto' ? 'selected' : ''}>Auto — adapt to who's ahead</option>
        <option value="safe" ${s.riskMode === 'safe' ? 'selected' : ''}>Safe — protect the lead</option>
        <option value="normal" ${s.riskMode === 'normal' ? 'selected' : ''}>Balanced</option>
        <option value="aggressive" ${s.riskMode === 'aggressive' ? 'selected' : ''}>Aggressive — gamble for the win</option>
      </select>
    </label>
    <p class="psa-hint">Auto reads the board each turn: ahead → play safe and take the sure line; behind → play aggressive and take the gamble that wins if it lands.</p>
  </section>

  <section class="psa-section">
    <h2>Opponent profiles <span class="psa-count">${rows.length}</span></h2>
    <p class="psa-hint">Learned from finished battles against each player: leads, switching habits, and move usage. Give a profile your friend's name and add their alternate usernames — battles under any of them count toward the same profile.</p>
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

    const risk = root.querySelector('#psa-risk-mode');
    risk?.addEventListener('change', async () => {
      settings = normalizeSettings(settings);
      settings.riskMode = risk.value;
      await saveSettings(settings);
    });

    for (const btn of root.querySelectorAll('[data-delete]')) {
      btn.addEventListener('click', async () => {
        delete profiles[btn.getAttribute('data-delete')];
        await saveProfiles(profiles);
        render();
      });
    }

    // Rename a profile (commit on Enter / blur). The old name becomes an
    // alias so battles under it still map to this profile.
    for (const input of root.querySelectorAll('.psa-row-name')) {
      const commit = async () => {
        const oldKey = input.getAttribute('data-opp-key');
        const profile = profiles[oldKey];
        if (!profile) return;
        const newName = input.value.trim();
        if (!newName || newName === profile.opponent) {
          render(); // revert to the stored name
          return;
        }
        const newKey = toProfileKey(newName);
        if (newKey !== oldKey && profiles[newKey]) {
          alert(`A profile named "${newName}" already exists.`);
          render();
          return;
        }
        const renamed = renameProfile(profile, newName);
        delete profiles[oldKey];
        profiles[newKey] = renamed;
        await saveProfiles(profiles);
        render();
      };
      input.addEventListener('change', commit);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') input.blur();
      });
    }

    // Add an alternate username to a profile.
    for (const form of root.querySelectorAll('.psa-alias-add')) {
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const key = form.getAttribute('data-opp-key');
        const profile = profiles[key];
        const input = form.querySelector('.psa-alias-input');
        const alias = input?.value?.trim();
        if (!profile || !alias) return;
        const updated = addProfileAlias(profile, alias);
        if (updated !== profile) {
          profiles[key] = updated;
          await saveProfiles(profiles);
        }
        render();
      });
    }

    // Remove an alternate username from a profile.
    for (const btn of root.querySelectorAll('[data-remove-alias]')) {
      btn.addEventListener('click', async () => {
        const [key, alias] = String(btn.getAttribute('data-remove-alias')).split('|');
        const profile = profiles[key];
        if (!profile) return;
        profiles[key] = removeProfileAlias(profile, alias);
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
