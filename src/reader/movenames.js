// src/reader/movenames.js
// Maps Showdown move IDs ('dragonpulse') to display names ('Dragon Pulse').
//
// The live |request| sends our own team's moves as lowercase IDs, while the
// battle log and hover tooltips use display names. Everything downstream (the
// damage calc, the panel, profile learning) expects display names, so the
// request handler converts at ingestion using @smogon/calc's per-gen move
// table (already bundled with the engine).

import { MOVES, ABILITIES, ITEMS } from '@smogon/calc';

const idToName = new Map(); // String(gen) -> Map(id -> display name)

function idToNameMap(gen) {
  const key = String(gen);
  if (!idToName.has(key)) {
    const map = new Map();
    for (const display of Object.keys(MOVES[key] ?? {})) {
      const id = display.toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (!map.has(id)) map.set(id, display);
    }
    idToName.set(key, map);
  }
  return idToName.get(key);
}

export function displayMoveName(gen, name) {
  if (!name || typeof name !== 'string') return name;
  if (MOVES[gen]?.[name]) return name; // already a display name
  const map = idToNameMap(gen);
  return map.get(name.toLowerCase().replace(/[^a-z0-9]+/g, '')) ?? name;
}

// The live |request| sends abilities as lowercase ids ('protosynthesis'); the
// log/tooltips use display names ('Protosynthesis'). The damage calc matches
// display names, so convert ids at ingestion.
export function displayAbilityName(gen, name) {
  if (!name || typeof name !== 'string') return name;
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const list = ABILITIES[String(gen)] ?? ABILITIES[String(gen ?? 9)];
  if (!list) return name;
  for (const display of list) {
    if (display.toLowerCase().replace(/[^a-z0-9]+/g, '') === id) return display;
  }
  return name;
}

export function displayItemName(gen, name) {
  if (!name || typeof name !== 'string') return name;
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const list = ITEMS[String(gen)] ?? ITEMS[String(gen ?? 9)];
  if (!list) return name;
  for (const display of list) {
    if (display.toLowerCase().replace(/[^a-z0-9]+/g, '') === id) return display;
  }
  return name;
}
