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
import usage from './data/usage-lite.js';
import { damagePercent, effectivenessOf, fieldSig, round1 } from './calc.js';
import { isRandomBattle, randomsMoves } from './randoms.js';

// Recovery moves — a side's ability to heal off chip and stall. Shared by the
// move scorer (recommend.js) and the positional eval (position.js), so the
// two engines agree on what "can recover" means.
export const RECOVERY_MOVES = new Set([
  'Recover', 'Roost', 'Soft-Boiled', 'Slack Off', 'Synthesis', 'Moonlight',
  'Morning Sun', 'Shore Up', 'Strength Sap', 'Rest', 'Heal Order',
]);

const toID = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const moveMemo = new Map();
// The moves the species can know (display names). In a Random Battle that's
// the bounded template movepool — a random team can ONLY roll those moves, so
// "could have" analysis is far tighter than the full Gen 9 learnset. Outside
// randoms it's the full learnset as before. Memoized per species + format so
// switching between a random and a ladder battle never mixes pools.
export function potentialMoves(species) {
  const key = species + (isRandomBattle() ? '|R' : '|L');
  if (moveMemo.has(key)) return moveMemo.get(key);
  const list = isRandomBattle()
    ? randomsMoves(species)
    : (learnsets[toID(species)]?.split(',') ?? []);
  moveMemo.set(key, list);
  return list;
}

// Smogon usage % (0-100) for a move on a species, from the monthly usage stats
// (usage-lite.js). Returns null when the species or move isn't in the data —
// callers fall back to another ranking (e.g. base power).
const usageMemo = new Map();
function usageTable(species) {
  if (usageMemo.has(species)) return usageMemo.get(species);
  const raw = usage[toID(species)];
  const table = {};
  if (raw) {
    for (const entry of raw.split(',')) {
      const [name, pct] = entry.split(':');
      if (name && pct != null) table[name] = parseFloat(pct);
    }
  }
  usageMemo.set(species, table);
  return table;
}

export function usageWeight(species, moveName) {
  // Smogon usage stats describe OU sets — in a Random Battle every move in the
  // template pool is (roughly) equally likely, so usage says nothing.
  if (isRandomBattle()) return null;
  const w = usageTable(species)[moveName];
  return w != null ? w : null;
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

// Hidden-move damage reads for `theirMon` vs `target` — computed in ONE pass
// so the worst-case (risk floor) and the usage-weighted expected value share
// the same candidate scoring and the same damage calls:
//   worst     — the single strongest hidden move (the "if they have it" read,
//               used for warnings and the defense-first gates).
//   expected  — the usage-weighted mean of the likely hidden moves (the honest
//               EV read: a 90%-usage move weighs 90× a 1% theorymon slot, so
//               a rare-but-lethal coverage move stops over-penalizing switches
//               into mons whose real sets are known).
// Returns null when there's nothing hidden to reason about.
function hiddenThreatRead(theirMon, target, gen, field, calcOpts = {}) {
  if (!theirMon || !target) return null;
  // A Pokémon can only know 4 moves — if all 4 are revealed, there is no
  // hidden threat left to warn about.
  if ((theirMon.moves ?? []).length >= 4) return null;
  const revealed = new Set(theirMon.moves ?? []);
  const moves = potentialMoves(theirMon.species).filter((m) => !revealed.has(m));
  if (!moves.length) return null;

  const cacheKey = JSON.stringify([
    stateSig(theirMon),
    stateSig(target),
    String(gen),
    calcOpts.statAssumption ?? 'max',
    fieldSig(field),
    // The hidden-move pool differs by format (random template vs full
    // learnset) — keep battle-to-battle cache flips honest.
    isRandomBattle() ? 'R' : 'L',
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
  // bp 0 like Seismic Toss are treated as ~100 bp — the real calc handles
  // them), then weighted by how often people actually run the move (Smogon
  // usage stats) so "could have" threats reflect real sets, not theorymon.
  const scored = [];
  for (const name of moves) {
    const data = moves9[name];
    if (!data || data.category === 'Status') continue;
    const eff = effectivenessOf(gen, data.type, targetTypes);
    if (eff === 0) continue;
    const stab = attackerTypes.includes(data.type) ? 1.5 : 1;
    const bp = data.bp ?? 0;
    const usage = usageWeight(theirMon.species, name) ?? 0;
    // Usage is a strong prior: a move run on 80% of sets is far more likely
    // than one on 2%, even if both would deal similar damage. Blend it in.
    scored.push({ name, usage, score: (bp || 100) * eff * stab * (0.4 + 0.6 * Math.min(1, usage / 50)) });
  }
  scored.sort((a, b) => b.score - a.score);

  // Run the real damage calc on the top few candidates; keep every scored hit
  // (with its damage) so the EV can weight by usage, and track the worst.
  const top = scored.slice(0, 4);
  const hits = [];
  let best = null;
  for (const cand of top) {
    const d = damagePercent(gen, theirMon, target, cand.name, field, calcOpts);
    if (!d) continue;
    hits.push({ name: cand.name, usage: cand.usage, pct: d.mean, max: d.max, eff: d.effectiveness, type: d.type });
    if (!best || d.mean > best.pct) {
      best = { move: cand.name, pct: d.mean, max: d.max, eff: d.effectiveness, type: d.type };
    }
  }
  if (!best) {
    threatCache.set(cacheKey, null);
    return null;
  }

  // Expected value: usage-weighted mean of the likely hidden hits. Moves with
  // no usage data (off-meta theorymon) get a small floor weight so they nudge
  // the read without dominating it; when the species has NO usage table at
  // all, every hit weighs equally (a plain average of the top candidates).
  let weightSum = 0;
  let dmgSum = 0;
  for (const h of hits) {
    const w = h.usage > 0 ? h.usage : 1;
    weightSum += w;
    dmgSum += w * h.pct;
  }
  const expected = {
    move: hits.reduce((a, b) => (b.usage > a.usage ? b : a)).name,
    pct: weightSum ? round1(dmgSum / weightSum) : best.pct,
    max: Math.max(...hits.map((h) => h.max)),
    eff: best.eff,
    type: best.type,
  };

  const out = { worst: best, expected };
  if (threatCache.size >= MAX_CACHE) threatCache.clear();
  threatCache.set(cacheKey, out);
  return out;
}

// Worst hidden-move damage % their active could deal to `target`, or null.
// The risk floor: warnings and the defense-first gates price what they COULD
// have, so a speculative-but-lethal move still shows up.
export function worstThreat(theirMon, target, gen, field, calcOpts = {}) {
  return hiddenThreatRead(theirMon, target, gen, field, calcOpts)?.worst ?? null;
}

// Usage-weighted expected hidden-move damage % vs `target`, or null. The
// honest EV read for scoring: an unlikely coverage nuke stops outweighing the
// moves they actually run, so mons whose real sets are known stop being
// over-penalized for theorymon. (Worst-case stays the risk floor above.)
export function expectedThreat(theirMon, target, gen, field, calcOpts = {}) {
  return hiddenThreatRead(theirMon, target, gen, field, calcOpts)?.expected ?? null;
}

// A short, human-readable sample of what a species could be running — the top
// `n` moves by Smogon usage %, falling back to base power for species with no
// usage data. Used by the panel to show "could have:" on opponent slots whose
// full set isn't known yet.
export function topPotentialMoves(species, n = 4, gen = 9) {
  const moves = potentialMoves(species);
  const moves9 = MOVES[String(gen)] ?? {};
  const table = usageTable(species);
  // In a Random Battle the pool is the template itself, so there is no usage
  // ranking to apply — order by base power instead.
  const hasUsage = !isRandomBattle() && Object.keys(table).length > 0;
  return moves
    .map((name) => ({
      name,
      bp: moves9[name]?.bp ?? 0,
      category: moves9[name]?.category,
      usage: table[name] ?? 0,
    }))
    .filter((m) => m.category !== 'Status' && m.bp > 0)
    .sort((a, b) => {
      if (hasUsage) {
        // Usage first; base power breaks ties between equally-run moves.
        if (b.usage !== a.usage) return b.usage - a.usage;
      }
      return b.bp - a.bp;
    })
    .slice(0, n)
    .map((m) => m.name);
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
