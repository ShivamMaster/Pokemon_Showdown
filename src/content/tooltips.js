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
// client's markup, so this is what unit tests exercise.
export function parseTooltipText(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const obs = { moves: [] };
  lines.forEach((line, i) => {
    if (line.startsWith('•')) {
      const m = /^•\s*(.+?)(?:\s*\((\d+)\/(\d+)\))?\s*$/.exec(line);
      if (m) {
        obs.moves.push({
          name: m[1],
          pp: m[2] != null ? parseInt(m[2], 10) : null,
          maxpp: m[3] != null ? parseInt(m[3], 10) : null,
        });
      }
      return;
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
      return;
    }
    // First plain line is the species name.
    if (i === 0 && !obs.species) obs.species = line;
  });
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

// Watches for tooltips appearing on screen and reports observations.
// `onObservation(obs)` receives the parsed tooltip plus { sideId, slotIndex,
// slotSpecies, clientIdent } resolved from the hovered element.
export function createTooltipObserver({ getBattleFn = getBattle, onObservation, dedupeMs = 1500 } = {}) {
  let hover = null;
  let lastFp = null;
  let lastAt = 0;
  let timer = null;
  let mo = null;

  const onMove = (ev) => {
    const target = ev.target;
    const el = target?.closest?.('.has-tooltip[data-tooltip^="pokemon|"]');
    if (!el) return;
    const parts = String(el.getAttribute('data-tooltip') ?? '').split('|');
    if (parts.length >= 3) {
      hover = { sideIndex: parseInt(parts[1], 10), slotIndex: parseInt(parts[2], 10) };
    }
  };

  const process = () => {
    const tip = document.querySelector('.tooltip.tooltip-pokemon');
    if (!tip) return;
    const obs = parseTooltip(tip);
    const fp = JSON.stringify(obs);
    const now = Date.now();
    if (fp === lastFp && now - lastAt < dedupeMs) return;
    lastFp = fp;
    lastAt = now;
    const battle = getBattleFn();
    const sidePokemon = battle?.sides?.[hover?.sideIndex]?.pokemon?.[hover?.slotIndex] ?? null;
    onObservation?.({
      ...obs,
      sideId: battle?.sides?.[hover?.sideIndex]?.id ?? null,
      slotIndex: hover?.slotIndex ?? null,
      slotSpecies: sidePokemon?.species ?? null,
      clientIdent: sidePokemon?.ident ?? null,
    });
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
