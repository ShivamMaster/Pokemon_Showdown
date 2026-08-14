// src/content/tooltips.js
// Reads the Pokémon hover tooltips the Showdown client renders on screen
// (the same text the user sees when hovering) and turns them into structured
// observations for the reader.
//
// Verified against a real battle page: the client creates `div.tooltip
// .tooltip-pokemon` on hover, with the species in the first line, `Label:
// value` lines (HP, Ability, Item, Tera Type, ...), and moves as
// `• Move Name (pp/max)` lines. Which Pokémon is being hovered is tracked
// via `.has-tooltip[data-tooltip^="pokemon|"]` elements, whose
// `data-tooltip="pokemon|S|I"` maps to `battle.sides[S].pokemon[I]`.

import { getBattle } from './source.js';

// Pure text parser — the tooltip's rendered text is stable across the
// client's markup, so this is what unit tests exercise. Also tolerates the
// noisy output of pixel OCR (stray battle-scene text above the tooltip): the
// species is the first line that looks like a Pokémon name (letters/space/
// .-'), not necessarily the very first line.
const NAME_LIKE = /^[A-Za-z][A-Za-z .'’-]+$/;

// Stat labels in the tooltip's stat line are the client's short names
// ("Atk 147 / Def 100 / SpA 70 / SpD 80 / Spe 122"). Gen 1 uses Spc.
const STAT_KEYS = { Atk: 'atk', Def: 'def', SpA: 'spa', SpD: 'spd', Spe: 'spe', Spc: 'spa' };

// Our own Pokémon's tooltip shows the exact stat line (raw, before stat
// stages/items/status) when the client has server data for the mon.
function parseStatsLine(line) {
  const parts = String(line ?? '').split('/').map((s) => s.trim());
  if (parts.length < 5) return null;
  const stats = {};
  for (const part of parts) {
    const m = /^(Atk|Def|SpA|SpD|Spe|Spc)\s+(\d+)$/.exec(part);
    if (!m) return null;
    stats[STAT_KEYS[m[1]]] = parseInt(m[2], 10);
  }
  return Object.keys(stats).length >= 5 ? stats : null;
}

// The opponent's tooltip shows their Speed range instead of exact stats:
// "Spe 139–186–249–273 (before external modifiers)" (min–ev0–ev252–max with
// en-dashes; "to"/"or" appear in some tiers). The endpoints are the real
// EV/nature bounds, so we take min and max. Best-effort for OCR dash noise.
function parseSpeRange(line) {
  const m = /^Spe\s+(.+)$/.exec(String(line ?? '').trim());
  if (!m) return null;
  // Drop a trailing parenthetical ("(before external modifiers)") so its
  // words/numbers can't pollute the stat values.
  const rest = m[1].replace(/\s*\([^)]*\)\s*$/, '');
  const nums = (rest.match(/\d+/g) ?? []).map(Number);
  if (nums.length < 2) return null;
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

export function parseTooltipText(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const obs = { moves: [] };
  let afterModifiers = false; // next stat line is the boosted "(After stat modifiers:)" one
  for (const line of lines) {
    if (line.startsWith('•') || line.startsWith('*') || line.startsWith('«')) {
      const m = /^[•*«]\s*(.+?)(?:\s*\((\d+)\/(\d+)\))?\s*$/.exec(line);
      if (m) {
        obs.moves.push({
          name: m[1],
          pp: m[2] != null ? parseInt(m[2], 10) : null,
          maxpp: m[3] != null ? parseInt(m[3], 10) : null,
        });
      }
      continue;
    }
    if (/^\(after stat modifiers/i.test(line)) {
      afterModifiers = true;
      continue;
    }
    // Exact stat line(s) — ours, from the hover tooltip. The second one
    // (right after "(After stat modifiers:)") carries boosts/status/items.
    const stats = parseStatsLine(line);
    if (stats) {
      if (afterModifiers) obs.statsEffective = stats;
      else obs.stats = stats;
      afterModifiers = false;
      continue;
    }
    // Opponent Speed range ("Spe 139–186–249–273").
    const speedRange = parseSpeRange(line);
    if (speedRange) {
      obs.speedRange = speedRange;
      continue;
    }
    const label = /^([A-Za-z][A-Za-z ]*):\s*(.*)$/.exec(line);
    if (label) {
      const key = label[1].trim();
      const value = label[2].trim();
      if (key === 'HP') obs.hpText = value;
      else if (key === 'Ability') obs.ability = value || null;
      else if (key === 'Item') {
        if (value === 'None') {
          obs.item = null;
        } else if (/^None\b/.test(value)) {
          obs.item = null;
          if (/consumed/i.test(value)) obs.itemConsumed = true;
        } else {
          obs.item = value.replace(/\s*\(consumed\)\s*$/i, '');
          if (/consumed/i.test(value)) obs.itemConsumed = true;
        }
      } else if (key === 'Tera Type') {
        obs.teraType = value || null;
      } else {
        (obs.labels ??= {})[key] = value;
      }
      continue;
    }
    // A name-like plain line is the species. OCR may include stray scene
    // text above the tooltip, so prefer a line that actually looks like a
    // Pokémon name (no parentheses / digits / colons).
    if (!obs.species && NAME_LIKE.test(line)) obs.species = line;
  }
  return obs;
}

// Parse a live tooltip element (browser only — needs a real DOM).
export function parseTooltip(el) {
  if (!el) return { moves: [] };
  return parseTooltipText(el.innerText || el.textContent || '');
}

// Map a hovered client Pokémon (sideId/slot) plus the parsed tooltip to a
// reader Pokémon record. Pure — used by tests and by the content script.
export function resolveMon(state, obs = {}) {
  const wanted = obs.slotSpecies ?? obs.species;
  if (!wanted) return null;
  if (obs.sideId && state?.sides?.[obs.sideId]) {
    const side = state.sides[obs.sideId];
    const matches = (side.pokemon ?? []).filter((m) => m.species === wanted);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1 && obs.slotIndex != null) {
      const order = [...(side.roster ?? []), ...side.pokemon]
        .map((m) => m.species)
        .filter((s, idx, arr) => arr.indexOf(s) === idx);
      const pick = matches.find((m) => m.species === order[obs.slotIndex]);
      if (pick) return pick;
    }
  }
  for (const side of [state?.sides?.p1, state?.sides?.p2]) {
    const matches = (side?.pokemon ?? []).filter((m) => m.species === obs.species);
    if (matches.length === 1) return matches[0];
  }
  return null;
}

// Watches for tooltips appearing on screen.
//
// `onTooltipSeen(obs)` fires on *every* tooltip that appears (one per hover,
// no dedupe) so the UI can give instant visual feedback; `onObservation(obs)`
// fires only when the tooltip carries NEW information (deduped), so the
// reader isn't spammed with re-reads of the same hover.
//
// Both receive the parsed tooltip plus { sideId, slotIndex, slotSpecies,
// clientIdent } resolved from the hovered element.
export function createTooltipObserver({
  getBattleFn = getBattle,
  onObservation,
  onTooltipSeen,
  onHoverNoTooltip,
  dedupeMs = 1500,
  hoverWaitMs = 350,
} = {}) {
  let hover = null;
  let lastFp = null;
  let lastSeenFp = null;
  let lastAt = 0;
  let timer = null;
  let mo = null;
  let missTimer = null;
  let missCheckedAt = 0;

  const onMove = (ev) => {
    const target = ev.target;
    const el = target?.closest?.('.has-tooltip[data-tooltip^="pokemon|"]');
    if (!el) return;
    const parts = String(el.getAttribute('data-tooltip') ?? '').split('|');
    if (parts.length >= 3) {
      hover = { sideIndex: parseInt(parts[1], 10), slotIndex: parseInt(parts[2], 10) };
    }
    // A hover happened: if no DOM tooltip materializes shortly, report it so
    // the caller can fall back to pixel OCR of the captured frame. The client
    // positions the tooltip near the hovered element (usually above-left), so
    // pass the element's rect — that's where the pixels will be.
    clearTimeout(missTimer);
    missTimer = setTimeout(() => {
      const tip = document.querySelector('.tooltip.tooltip-pokemon');
      if (tip && tip.offsetParent !== null) return; // tooltip appeared — DOM path handles it
      if (Date.now() - missCheckedAt < 400) return; // already reported this miss
      missCheckedAt = Date.now();
      const r = el.getBoundingClientRect();
      onHoverNoTooltip?.({
        sideIndex: hover?.sideIndex ?? null,
        slotIndex: hover?.slotIndex ?? null,
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      });
    }, hoverWaitMs);
  };

  const resolve = (obs) => {
    const battle = getBattleFn();
    const sidePokemon = battle?.sides?.[hover?.sideIndex]?.pokemon?.[hover?.slotIndex] ?? null;
    return {
      ...obs,
      sideId: battle?.sides?.[hover?.sideIndex]?.id ?? null,
      slotIndex: hover?.slotIndex ?? null,
      slotSpecies: sidePokemon?.species ?? null,
      clientIdent: sidePokemon?.ident ?? null,
    };
  };

  const process = () => {
    const tip = document.querySelector('.tooltip.tooltip-pokemon');
    if (!tip || tip.offsetParent === null) {
      lastSeenFp = null; // tooltip gone — the next hover is a fresh appearance
      return;
    }
    clearTimeout(missTimer); // the DOM tooltip arrived — the OCR fallback isn't needed
    const obs = parseTooltip(tip);
    const fp = JSON.stringify(obs);
    const now = Date.now();
    // One "seen" report per hover, even when the content is identical.
    if (fp !== lastSeenFp) {
      lastSeenFp = fp;
      onTooltipSeen?.(resolve(obs));
    }
    // "New information" reports are deduped.
    if (fp === lastFp && now - lastAt < dedupeMs) return;
    lastFp = fp;
    lastAt = now;
    onObservation?.(resolve(obs));
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      process();
      timer = setTimeout(() => {
        process(); // second pass catches tooltips that render slightly late
        timer = null;
      }, 250);
    }, 120);
  };

  const start = () => {
    if (typeof MutationObserver !== 'undefined' && document?.body) {
      mo = new MutationObserver(() => schedule());
      mo.observe(document.body, { childList: true, subtree: true });
    } else {
      timer = setInterval(process, 300);
    }
    document.addEventListener('mouseover', onMove, true);
  };

  const stop = () => {
    mo?.disconnect();
    mo = null;
    clearTimeout(timer);
    clearInterval(timer);
    document.removeEventListener('mouseover', onMove, true);
  };

  start();
  return { start, stop, process };
}
