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
import { topPotentialMoves } from '../engine/movepool.js';
import { createCapture } from './capture.js';
import {
  summarizeBattle,
  updateProfile,
  profileForEngine,
  profileForDisplay,
  loadProfiles,
  saveProfiles,
  findProfileKey,
  toProfileKey,
  emptyProfile,
} from '../profiles/index.js';
import { loadSettings, normalizeSettings, onStorageChanged } from '../settings.js';
import { createBattleSource, getBattle } from './source.js';
import { ensureOverlay, ensureReopenButton, mountPanel, hidePanel, showPanel } from './overlay.js';
import { createTooltipObserver, resolveMon, parseTooltipText } from './tooltips.js';
import { ocrCanvas } from './ocr.js';

const source = createBattleSource();
const reader = new BattleReader();
const overlay = ensureOverlay();
const capture = createCapture();
capture.setOnUpdate(() => {
  if (capture.isCapturing()) render();
});
const POLL_MS = 600;
const RENDER_THROTTLE_MS = 400;

let lastRenderAt = 0;
let mounted = false;
let linesSeen = 0;
let battleEnded = false;
let observedCount = 0; // tooltips read that added NEW info
let seenCount = 0;      // every tooltip hover we visually acknowledged
let ocrCount = 0;       // tooltips recovered via pixel OCR
let lastReadSpecies = null;
let ocrBusy = false;    // serialize OCR jobs (tesseract is slow; drop overlaps)
let flashTimer = null;
let lastBadgeState = null; // 'battle' | 'idle' — only reported to the worker on change

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
  // Resolve the opponent through their profile's aliases, so a friend's
  // alternate usernames all share one profile.
  const name = reader.state.sides[theirSideId()]?.playerName ?? null;
  if (!name) return;
  const key = findProfileKey(profiles, name) ?? toProfileKey(name);
  if (key !== currentOpponentKey) {
    currentOpponentKey = key;
    currentProfile = profiles[key] ?? null;
  }
}

async function recordBattle() {
  const name = reader.state.sides[theirSideId()]?.playerName;
  if (!name) return;
  let key = findProfileKey(profiles, name);
  let profile = key ? profiles[key] : null;
  if (!profile) {
    key = toProfileKey(name);
    profile = emptyProfile(name);
  }
  const summary = summarizeBattle(reader.state, source.ourSideId());
  profile = updateProfile(profile, summary);
  profiles[key] = profile;
  currentProfile = profile;
  currentOpponentKey = key;
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
    watching: { count: seenCount, last: lastReadSpecies, ocrCount },
    capture: capture.getStats(),
    getPotentialMoves: (species) => topPotentialMoves(species, 3, state.gen ?? 9),
  });
  mountPanel(renderPanel(model));
  overlay.dataset.psaTurn = String(state.turn);
  overlay.dataset.psaLines = String(linesSeen);
  overlay.dataset.psaRendered = 'true';
  overlay.dataset.psaOpponent = currentProfile?.opponent ?? '';
  overlay.dataset.psaCapturing = String(capture.isCapturing());
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
    const { lines, reset, battleId, request, requestChanged } = source.poll();
    // Keep the toolbar LIVE badge in sync: visible Chrome-level indicator
    // that the assistant is watching a battle.
    const badgeState = battleId ? 'battle' : 'idle';
    if (badgeState !== lastBadgeState) {
      lastBadgeState = badgeState;
      window.postMessage({ psa: 'psa-badge-req', state: badgeState }, '*');
    }
    if (reset) {
      reader.reset();
      linesSeen = 0;
      battleEnded = false;
      loadSettings().then((s) => {
        settings = s;
        applyPanelVisibility();
      });
    }
    let didRender = false;
    if (lines.length) {
      for (const line of lines) {
        reader.applyLine(line);
        linesSeen += 1;
      }
      didRender = true;
    }
    // Live-only: the client intercepts `|request|` so it never lands in the
    // log — apply the parsed request directly (moves, items, PP, HP, tera).
    if (requestChanged && request) {
      reader.applyRequest(request);
      didRender = true;
    }
    if (didRender) {
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

// Real screen capture: the popup (user gesture) obtains the tab's capture
// stream id, the worker + isolated-world bridge relay it here, and we start
// the stream — Chrome then shows its screen-sharing indicator and the panel
// reports live frame stats.
window.addEventListener('message', async (ev) => {
  if (ev.source !== window) return;
  if (ev.data?.psa === 'psa-capture-start') {
    try {
      await capture.start(ev.data.streamId);
      render(true);
    } catch (err) {
      overlay.dataset.psaError = String(err?.stack ?? err);
    }
  } else if (ev.data?.psa === 'psa-capture-stop') {
    capture.stop();
    render(true);
  }
});

// Flash the panel so every hover gives instant, visible feedback that the
// assistant is watching — even when the tooltip adds nothing new.
function acknowledgeHover(obs) {
  const panel = overlay.querySelector('.psa-panel');
  if (!panel) return;
  panel.classList.add('psa-flash');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => panel.classList.remove('psa-flash'), 700);
  overlay.dataset.psaHover = String(++seenCount);
  if (obs?.species) lastReadSpecies = obs.species;
  render(true);
}

// Merge an observation into the battle state (shared by the DOM and OCR
// paths) and report whether anything new was learned.
function mergeObservation(obs) {
  const mon = resolveMon(reader.state, obs);
  if (!mon) return false;
  const changes = reader.applyObservation(mon, obs);
  if (changes) {
    observedCount += 1;
    overlay.dataset.psaObserved = String(observedCount);
    render(true);
  }
  return !!changes;
}

// Watch the user's hover tooltips: whatever the player inspects on screen
// (their own sets at team preview, or either side's revealed info mid-battle)
// gets merged into the battle state and the panel. Failures here are
// non-fatal — the log-based pipeline keeps working regardless.
createTooltipObserver({
  // Instant feedback on every hover — the panel flashes and the status row
  // shows what the assistant is reading.
  onTooltipSeen: (obs) => {
    try {
      // Only acknowledge Pokémon tooltips, not move/ability ones.
      if (!obs.species || (!obs.moves.length && !obs.ability && !obs.item && !obs.hpText)) return;
      acknowledgeHover(obs);
    } catch (err) {
      overlay.dataset.psaError = String(err?.stack ?? err);
    }
  },
  // Merge NEW information into the battle state.
  onObservation: (obs) => {
    try {
      mergeObservation(obs);
    } catch (err) {
      overlay.dataset.psaError = String(err?.stack ?? err);
    }
  },

  // OCR fallback: the client rendered NO tooltip DOM for this hover (a
  // canvas-rendered tooltip, a client change, or a slow render). If the tab
  // capture is live, grab the pixels around the cursor, OCR them, and feed
  // the recognized text through the same observation pipeline.
  onHoverNoTooltip: (info) => {
    // Only meaningful while we have real frames to read.
    if (!capture.isCapturing() || ocrBusy) return;
    // The client draws the tooltip near the hovered icon (usually above-left
    // of it), so sample that area from the live video. Keep the box tooltip-
    // sized so it doesn't sweep in unrelated on-screen text.
    const rect = info.rect ?? { x: 0, y: 0, w: 40, h: 30 };
    const region = capture.grabRegion({
      x: rect.x - 40,
      y: rect.y - 250,
      w: rect.w + 340,
      h: 240,
      scale: 2,
    });
    if (!region) return;
    ocrBusy = true;
    overlay.dataset.psaOcr = String(++ocrCount); // count every OCR attempt
    ocrCanvas(region)
      .then((text) => {
        if (!text) return;
        const obs = parseTooltipText(text);
        if (!obs.species) return;
        // Attach the hovered side/slot so the species resolves even when both
        // teams have the same Pokémon (Raging Bolt appears on both here).
        const battle = getBattle();
        const side = battle?.sides?.[info.sideIndex] ?? null;
        const sidePokemon = side?.pokemon?.[info.slotIndex] ?? null;
        // The reader keys sides by 'p1'/'p2' (side.sideid), not the username.
        obs.sideId = side?.sideid ?? side?.id ?? null;
        obs.slotIndex = info.slotIndex ?? null;
        obs.slotSpecies = sidePokemon?.species ?? null;
        acknowledgeHover(obs);
        mergeObservation(obs);
      })
      .catch(() => {})
      .finally(() => {
        ocrBusy = false;
      });
  },
});
