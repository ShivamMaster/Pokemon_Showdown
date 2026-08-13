// src/engine/calc.js
// Thin wrapper around @smogon/calc (the official Smogon damage calculator).
//
// The reader only knows partial info about a Pokémon (species, level, revealed
// moves/items, HP). @smogon/calc needs full stats, so we fill the gaps with
// documented assumptions:
//   - level from the log (default 100)
//   - 31 IVs, neutral nature
//   - 'max' assumption (default): 252 EVs in the stats relevant to the move
//     being calculated (attacker: attacking stat; defender: HP + defending
//     stat). This mirrors how real teams are usually built.
//   - 'base' assumption: 0 EVs (raw base-stat damage) — available via opts.

import { calculate, Pokemon, Move, Field, TYPE_CHART } from '@smogon/calc';

const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

export const round1 = (n) => Math.round(n * 10) / 10;

// Type effectiveness for a move against a defender's types, straight from the
// calc package's type chart (0 = immune, 0.25/0.5 = resisted, 1, 2/4 = SE).
// The chart is keyed by generation (tiers '1'..'9' have per-gen matchups; gen 1
// even differs, e.g. Ice->Fire is neutral there), so we look up the right tier.
export function effectivenessOf(gen, moveType, defenderTypes) {
  const chart =
    TYPE_CHART[String(gen)] ??
    TYPE_CHART[Object.keys(TYPE_CHART).filter((k) => /^\d+$/.test(k)).sort((a, b) => +b - +a)[0]];
  let mult = 1;
  for (const t of defenderTypes ?? []) {
    mult *= chart?.[moveType]?.[t] ?? 1;
  }
  return mult;
}

function baseEvs() {
  const evs = {};
  for (const s of STATS) evs[s] = 0;
  return evs;
}

function baseIvs() {
  const ivs = {};
  for (const s of STATS) ivs[s] = 31;
  return ivs;
}

// Build a calc Pokemon from a reader mon record. Only known info is passed
// (revealed, unconsumed item; known ability; current status; current boosts;
// tera type if already terastallized).
//
// `teraType` overrides the tera type when the mon has NOT terastallized yet —
// this is how the engine simulates "what if we terastallize now" (the calc
// treats a set teraType as the terastallized state).
export function buildPokemon(gen, mon, evs = {}, teraType = null) {
  const opts = {
    level: mon?.level ?? 100,
    nature: 'Serious',
    evs: { ...baseEvs(), ...evs },
    ivs: baseIvs(),
  };
  if (mon?.itemRevealed && !mon?.itemConsumed && mon?.item) opts.item = mon.item;
  if (mon?.ability) opts.ability = mon.ability;
  if (mon?.status) opts.status = mon.status;
  if (mon?.boosts && Object.values(mon.boosts).some((v) => v !== 0)) opts.boosts = { ...mon.boosts };
  const tera = mon?.terastallized && mon?.teraType ? mon.teraType : (teraType ?? null);
  if (tera) opts.teraType = tera;
  return new Pokemon(gen, mon?.species, opts);
}

export function buildField(state) {
  const opts = {};
  if (state?.field?.weather) opts.weather = state.field.weather;
  if (state?.field?.terrain) opts.terrain = state.field.terrain;
  return new Field(opts);
}

// Expected damage of moveName from atkMon against defMon, as a percentage of
// defMon's max HP. Returns null if the calc can't handle it (unknown species
// or move), so callers can skip those moves gracefully.
export function damagePercent(gen, atkMon, defMon, moveName, field, opts = {}) {
  const statAssumption = opts.statAssumption ?? 'max';
  // Missing mons (e.g. an opponent not revealed yet at team preview) can't be
  // calculated — return null so callers skip them instead of crashing the
  // whole recommendation render.
  if (!atkMon?.species || !defMon?.species) return null;
  let move;
  try {
    move = new Move(gen, moveName);
  } catch {
    return null;
  }
  const atkEvs = move.category === 'Physical' ? { atk: 252 } : { spa: 252 };
  const defEvs = move.category === 'Physical' ? { hp: 252, def: 252 } : { hp: 252, spd: 252 };
  let attacker;
  let defender;
  try {
    attacker = buildPokemon(gen, atkMon, statAssumption === 'base' ? {} : atkEvs, opts.attackerTera ?? null);
    defender = buildPokemon(gen, defMon, statAssumption === 'base' ? {} : defEvs, opts.defenderTera ?? null);
  } catch {
    // Unknown species the calc can't build — skip this matchup.
    return null;
  }
  let result;
  try {
    result = calculate(gen, attacker, defender, move, field);
  } catch {
    return null;
  }
  const maxHp = defender.maxHP();
  // result.damage is an array of roll values, but immune moves return the bare
  // number 0 — normalize both to an array.
  const raw = result?.damage;
  const rolls = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const pct = rolls.map((r) => (r / maxHp) * 100);
  let desc = String(result?.rawDesc ?? '');
  try {
    if (typeof result.desc === 'function') desc = result.desc();
  } catch {
    // desc() throws for immune (0-damage) results — rawDesc is fine.
  }
  // Tera-aware effectiveness: a terastallized (or simulated) defender's typing
  // collapses to its tera type. The calc applies this internally, but the
  // Pokemon's `.types` still reports the species types, so we mirror it here.
  const defTera =
    defMon?.terastallized && defMon?.teraType ? defMon.teraType : (opts.defenderTera ?? null);
  return {
    move: moveName,
    category: move.category,
    type: move.type,
    effectiveness: defTera
      ? effectivenessOf(gen, move.type, [defTera])
      : effectivenessOf(gen, move.type, defender.types),
    min: pct.length ? round1(Math.min(...pct)) : 0,
    max: pct.length ? round1(Math.max(...pct)) : 0,
    mean: pct.length ? round1(pct.reduce((a, b) => a + b, 0) / pct.length) : 0,
    desc,
  };
}
