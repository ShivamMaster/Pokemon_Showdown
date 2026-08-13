// src/engine/movepool.js
// Reasoning over moves a Pokémon *could* know but hasn't revealed yet.
//
// The reader only records moves the log/tooltips revealed. In live play the
// opponent's active often has 1-3 moves shown, so the engine can't rule out
// anything from the species' full (Gen 9-legal) learnset. This module finds
// the worst realistic hidden-move threat: for each of our Pokémon, the
// strongest move from the opponent's potential movepool that they have NOT
// revealed yet.
//
// To stay fast (it runs inside the 600ms poll loop) we pre-score the whole
// movepool with a cheap proxy (base power × type effectiveness × STAB), run
// the real damage calc on only the top few candidates, and memoize per state
// signature so re-renders within a turn are free.

import { MOVES, SPECIES } from '@smogon/calc';
import learnsets from './data/learnsets-lite.js';
import { damagePercent, effectivenessOf } from './calc.js';

const toID = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const moveMemo = new Map();
// Every Gen 9-legal move the species can know (display names).
export function potentialMoves(species) {
  if (moveMemo.has(species)) return moveMemo.get(species);
  const list = learnsets[toID(species)]?.split(',') ?? [];
  moveMemo.set(species, list);
  return list;
}

// Everything about a mon that affects damage, serialized for cache keys.
function stateSig(mon) {
  if (!mon) return 'null';
  const boosts = Object.entries(mon.boosts ?? {})
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `${k}${v}`)
    .sort()
    .join(',');
  return JSON.stringify([
    mon.species,
    mon.terastallized ? mon.teraType ?? '' : '',
    mon.itemRevealed ? mon.item ?? '' : '',
    mon.itemConsumed ? 'consumed' : '',
    mon.ability ?? '',
    mon.status ?? '',
    boosts,
  ]);
}

const threatCache = new Map();
const MAX_CACHE = 400;

// Worst hidden-move damage % their active could deal to `target`, or null.
// `theirMon.moves` (revealed moves) are excluded — we only care about what
// they have NOT shown yet.
export function worstThreat(theirMon, target, gen, field, calcOpts = {}) {
  if (!theirMon || !target) return null;
  const revealed = new Set(theirMon.moves ?? []);
  const moves = potentialMoves(theirMon.species).filter((m) => !revealed.has(m));
  if (!moves.length) return null;

  const cacheKey = JSON.stringify([
    stateSig(theirMon),
    stateSig(target),
    String(gen),
    calcOpts.statAssumption ?? 'max',
    field?.weather ?? '',
    field?.terrain ?? '',
  ]);
  if (threatCache.has(cacheKey)) return threatCache.get(cacheKey);

  const genKey = String(gen);
  const moves9 = MOVES[genKey] ?? MOVES[gen] ?? {};
  const attackerTypes =
    theirMon.terastallized && theirMon.teraType
      ? [theirMon.teraType]
      : (SPECIES[genKey]?.[theirMon.species]?.types ?? []);
  const targetTypes = (SPECIES[genKey]?.[target.species]?.types ?? target.types) ?? [];

  // Cheap proxy: base power × effectiveness × STAB (fixed-damage moves with
  // bp 0 like Seismic Toss are treated as ~100 bp — the real calc handles them).
  const scored = [];
  for (const name of moves) {
    const data = moves9[name];
    if (!data || data.category === 'Status') continue;
    const eff = effectivenessOf(gen, data.type, targetTypes);
    if (eff === 0) continue;
    const stab = attackerTypes.includes(data.type) ? 1.5 : 1;
    const bp = data.bp ?? 0;
    scored.push({ name, score: (bp || 100) * eff * stab });
  }
  scored.sort((a, b) => b.score - a.score);

  let best = null;
  for (const cand of scored.slice(0, 4)) {
    const d = damagePercent(gen, theirMon, target, cand.name, field, calcOpts);
    if (!d) continue;
    if (!best || d.mean > best.pct) {
      best = { move: cand.name, pct: d.mean, max: d.max, eff: d.effectiveness, type: d.type };
    }
  }

  if (threatCache.size >= MAX_CACHE) threatCache.clear();
  threatCache.set(cacheKey, best);
  return best;
}

// Hidden-move threats against a whole team, sorted by damage, filtered to the
// meaningful ones. Each entry: { target, move, pct, max, eff, type }.
export function teamThreats(theirMon, ourTeam, gen, field, calcOpts = {}, opts = {}) {
  const top = opts.top ?? 3;
  const minPct = opts.minPct ?? 25;
  const out = [];
  for (const target of ourTeam ?? []) {
    const t = worstThreat(theirMon, target, gen, field, calcOpts);
    if (t && t.pct >= minPct) out.push({ target: target.species, ...t });
  }
  out.sort((a, b) => b.pct - a.pct);
  return out.slice(0, top);
}
