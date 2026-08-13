// src/content/content.js
// Extension orchestrator: pulls live protocol lines from the Showdown client,
// feeds them through the BattleReader, runs the recommendation engine, and
// renders the panel overlay. Also learns per-opponent profiles: the opponent's
// profile is loaded at battle start (used to sharpen switch prediction) and
// the finished battle is recorded into it.
//
// Bundled to a single IIFE by esbuild (MV3 content scripts can't use ES
// modules or bare imports). Runs in the MAIN world (the isolated world cannot
// see the client's page globals).
//
// Instrumentation: DOM attributes on the overlay (data-psa-turn, data-psa-lines,
// data-psa-error, data-psa-opponent) expose internal state to E2E tests.

import { BattleReader } from '../reader/index.js';
import { buildPanelModel, renderPanel } from '../ui/panel.js';
import { recommend } from '../engine/index.js';
import {
  summarizeBattle,
  updateProfile,
  profileForEngine,
  profileForDisplay,
  loadProfiles,
  saveProfiles,
} from '../profiles/index.js';
import { loadSettings, normalizeSettings, onStorageChanged } from '../settings.js';
import { createBattleSource } from './source.js';
import { ensureOverlay, ensureReopenButton, mountPanel, hidePanel, showPanel } from './overlay.js';
import { createTooltipObserver, resolveMon } from './tooltips.js';

const source = createBattleSource();
const reader = new BattleReader();
const overlay = ensureOverlay();
const POLL_MS = 600;
const RENDER_THROTTLE_MS = 400;

let lastRenderAt = 0;
let mounted = false;
let linesSeen = 0;
let battleEnded = false;
let observedCount = 0;

const profiles = {}; // keyed by lowercased opponent name
let currentOpponentKey = null;
let currentProfile = null;

let settings = { ...normalizeSettings() };
let settingsTicks = 0;

loadProfiles().then((loaded) => Object.assign(profiles, loaded));
loadSettings().then((s) => {
  settings = s;
  applyPanelVisibility();
});
// Settings changed elsewhere (e.g. the options page) apply immediately.
onStorageChanged('settings', (value) => {
  settings = normalizeSettings(value);
  applyPanelVisibility();
});

function applyPanelVisibility() {
  if (settings.panelEnabled) showPanel();
  else hidePanel();
}

function theirSideId() {
  const our = source.ourSideId();
  return our === 'p1' ? 'p2' : 'p1';
}

function refreshOpponent() {
  const name = reader.state.sides[theirSideId()]?.playerName ?? null;
  if (!name) return;
  const key = name.toLowerCase();
  if (key !== currentOpponentKey) {
    currentOpponentKey = key;
    currentProfile = profiles[key] ?? null;
  }
}

async function recordBattle() {
  const name = reader.state.sides[theirSideId()]?.playerName;
  if (!name) return;
  const key = name.toLowerCase();
  const summary = summarizeBattle(reader.state, source.ourSideId());
  currentProfile = updateProfile(currentProfile, summary);
  profiles[key] = currentProfile;
  try {
    await saveProfiles(profiles);
  } catch {
    // profiles stay in memory for this session
  }
  render(true);
}

function render(force = false) {
  const now = Date.now();
  if (!force && now - lastRenderAt < RENDER_THROTTLE_MS) return;
  lastRenderAt = now;

  const state = reader.state;
  const ourSideId = source.ourSideId();
  const recommendation = recommend(state, {
    ourSideId,
    profile: profileForEngine(currentProfile),
    statAssumption: settings.statAssumption,
  });
  const model = buildPanelModel(state, {
    ourSideId,
    recommendation,
    profile: profileForDisplay(currentProfile),
  });
  mountPanel(renderPanel(model));
  overlay.dataset.psaTurn = String(state.turn);
  overlay.dataset.psaLines = String(linesSeen);
  overlay.dataset.psaRendered = 'true';
  overlay.dataset.psaOpponent = currentProfile?.opponent ?? '';
  mounted = true;
}

function tick() {
  try {
    overlay.dataset.psaHasApp = String(typeof window.app);
    // Re-check settings periodically (e.g. changed before the storage-change
    // event, or on a battle reset) — cheap and keeps the toggle responsive.
    if (++settingsTicks % 10 === 0) {
      loadSettings().then((s) => {
        if (JSON.stringify(s) !== JSON.stringify(settings)) {
          settings = s;
          applyPanelVisibility();
        }
      });
    }
    const { lines, reset } = source.poll();
    if (reset) {
      reader.reset();
      linesSeen = 0;
      battleEnded = false;
      loadSettings().then((s) => {
        settings = s;
        applyPanelVisibility();
      });
    }
    if (lines.length) {
      for (const line of lines) {
        reader.applyLine(line);
        linesSeen += 1;
      }
      render();
    } else if (!mounted) {
      render(); // mount the panel up front with the waiting state
    }
    refreshOpponent();
    if (reader.state.winner && !battleEnded) {
      battleEnded = true;
      recordBattle();
    }
  } catch (err) {
    overlay.dataset.psaError = String(err?.stack ?? err);
  }
}

ensureReopenButton();
setInterval(tick, POLL_MS);
tick();

// Watch the user's hover tooltips: whatever the player inspects on screen
// (their own sets at team preview, or either side's revealed info mid-battle)
// gets merged into the battle state and the panel. Failures here are
// non-fatal — the log-based pipeline keeps working regardless.
createTooltipObserver({
  onObservation: (obs) => {
    try {
      const mon = resolveMon(reader.state, obs);
      if (!mon) return;
      const changes = reader.applyObservation(mon, obs);
      if (changes) {
        observedCount += 1;
        overlay.dataset.psaObserved = String(observedCount);
        render(true);
      }
    } catch (err) {
      overlay.dataset.psaError = String(err?.stack ?? err);
    }
  },
});
