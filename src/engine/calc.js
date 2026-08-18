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
import { isRandomBattle, randomsLevel } from './randoms.js';
import { spreadFor } from './sets.js';

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

// Overlay a mon's back-calculated EV ranges onto the caller's EV set. Only
// stats with a narrowed range are used (midpoint). The estimator disables
// this via `useEstimates: false` so its pinned-EV probes stay exact.
function estimatedEvs(mon) {
  const est = mon?.evEstimate;
  if (!est) return {};
  const out = {};
  for (const s of ['atk', 'spa', 'def', 'spd', 'hp']) {
    const r = est[s];
    if (!r) continue;
    const width = r[1] - r[0];
    if (width > 48) continue; // too wide to trust
    out[s] = Math.max(0, Math.min(252, Math.round((r[0] + r[1]) / 2 / 4) * 4));
  }
  return out;
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
export function buildPokemon(gen, mon, evs = {}, teraType = null, useEstimates = true, nature = 'Serious') {
  // Randoms use per-species levels (79-88), not 100: an unrevealed mon in a
  // random battle should be calc'd at its template level, not a level it can
  // never actually be. Revealed levels (from the log's L79) always win.
  const defaultLevel = isRandomBattle() ? (randomsLevel(mon?.species) ?? 100) : 100;
  const opts = {
    level: mon?.level ?? defaultLevel,
    nature,
    evs: useEstimates ? { ...baseEvs(), ...evs, ...estimatedEvs(mon) } : { ...baseEvs(), ...evs },
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

// Per-side effects (hazards, screens, Tailwind) from a side's `effects` map
// into the shape @smogon/calc expects on Field.attackerSide/defenderSide.
function sideEffectsToField(eff = {}) {
  return {
    isSR: !!eff['Stealth Rock'],
    spikes: eff['Spikes'] ?? 0,
    isReflect: !!eff['Reflect'],
    isLightScreen: !!eff['Light Screen'],
    isAuroraVeil: !!eff['Aurora Veil'],
    isTailwind: !!eff['Tailwind'],
  };
}

// The reader records field conditions as the Showdown log names them
// (RainDance, SunnyDay, 'Grassy Terrain', …) but the calc only honors its own
// canonical names (Rain, Sun, Grassy, …) — anything else is silently ignored,
// which made every weather/terrain damage roll inert. Normalize at the
// boundary so both the reader's raw names and already-canonical names work.
export const WEATHER_NAMES = {
  RainDance: 'Rain',
  Rain: 'Rain',
  SunnyDay: 'Sun',
  Sun: 'Sun',
  Sandstorm: 'Sandstorm',
  Hail: 'Hail',
  Snow: 'Snow',
  Snowscape: 'Snow',
};
export const TERRAIN_NAMES = {
  'Electric Terrain': 'Electric',
  Electric: 'Electric',
  'Grassy Terrain': 'Grassy',
  Grassy: 'Grassy',
  'Misty Terrain': 'Misty',
  Misty: 'Misty',
  'Psychic Terrain': 'Psychic',
  Psychic: 'Psychic',
};

// Infer a mon's likely offensive investment from its revealed move categories:
// a mon that has revealed mostly physical damaging moves is almost certainly
// Atk-invested (mostly special moves → SpA-invested). Returns 'atk' | 'spa' |
// null (null = no signal — nothing revealed, a true mixed set, or too little
// evidence).
//
// Evidence threshold: the majority category needs ≥2 moves AND at least 3×
// the minority. A single revealed move proves nothing (a special attacker's
// physical coverage is common); a 2-1 or 2-2 split is a genuinely mixed set;
// and a 2-0 split (only physical moves shown) or classic 3-1 set (physical
// attacker with one special coverage move) DOES infer. Status moves don't
// count either way — they say nothing about offensive investment.
//
// This only fills the no-observation gap — it biases the DEFAULT EV
// assumption, and a narrowed evEstimate range still wins over it.
export function inferOffensiveStat(mon, gen = 9) {
  const moves = mon?.moves ?? [];
  if (!moves.length) return null;
  let physical = 0;
  let special = 0;
  for (const name of moves) {
    let category;
    try {
      category = new Move(gen, name).category;
    } catch {
      continue; // unknown move — no signal from it
    }
    if (category === 'Physical') physical += 1;
    else if (category === 'Special') special += 1;
  }
  if (physical >= 2 && physical >= special * 3) return 'atk';
  if (special >= 2 && special >= physical * 3) return 'spa';
  return null;
}

export const canonicalWeather = (name) => WEATHER_NAMES[name] ?? null;
export const canonicalTerrain = (name) => TERRAIN_NAMES[name] ?? null;

// Compact signature of everything in a Field that affects damage, for cache
// keys (weather, terrain, and both sides' hazards/screens).
export function fieldSig(field) {
  if (!field) return '';
  const side = (s) =>
    s
      ? `${s.isSR ? 'R' : ''}${s.spikes ?? 0}${s.isReflect ? 'r' : ''}${s.isLightScreen ? 'L' : ''}${s.isAuroraVeil ? 'A' : ''}${s.isTailwind ? 'T' : ''}`
      : '';
  return `${field.weather ?? ''}|${field.terrain ?? ''}|${side(field.attackerSide)}|${side(field.defenderSide)}`;
}

export function buildField(state) {
  const opts = {};
  if (state?.field?.weather) opts.weather = canonicalWeather(state.field.weather) ?? state.field.weather;
  if (state?.field?.terrain) opts.terrain = canonicalTerrain(state.field.terrain) ?? state.field.terrain;
  // The calc's Field carries per-side effects: the attacker's screens don't
  // help it attack, they protect IT when it defends. Canonical orientation is
  // p1 attacks p2 (attackerSide = p1, defenderSide = p2); damagePercent flips
  // it for the other direction.
  opts.attackerSide = sideEffectsToField(state?.sides?.p1?.effects);
  opts.defenderSide = sideEffectsToField(state?.sides?.p2?.effects);
  return new Field(opts);
}

// A new Field identical to `field` but with weather/terrain replaced — how the
// engine simulates "what if we set Rain Dance / Grassy Terrain now" when
// scoring those moves.
export function fieldAfter(field, { weather = null, terrain = null } = {}) {
  if (!field) return null;
  return new Field({
    weather: weather ?? field.weather,
    terrain: terrain ?? field.terrain,
    attackerSide: field.attackerSide,
    defenderSide: field.defenderSide,
  });
}

// The calc's screens/hazards apply to whichever side is DEFENDING. buildField
// orients the field as p1-attacks-p2, so a p2-attacks-p1 calculation needs the
// sides swapped. Unknown sides keep the canonical orientation (matches the
// pre-hazard behavior, where the field had no side info at all).
export function directedField(field, atkSideId, defSideId) {
  if (!field || !field.attackerSide || !field.defenderSide) return field;
  if (atkSideId === 'p2' && defSideId === 'p1') {
    return new Field({
      weather: field.weather,
      terrain: field.terrain,
      attackerSide: field.defenderSide,
      defenderSide: field.attackerSide,
    });
  }
  return field;
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
  // The estimator pins one stat to a candidate EV while everything else stays
  // at defaults: `opts.attackerEvs` / `opts.defenderEvs` fully override the
  // category-based defaults for that side.
  //
  // Foul Play is the exception: the calc swaps the attack source to the
  // TARGET (its own gen789 mechanics do `attackSource = defender`), so the
  // defender's Atk — not the attacker's — powers the move. The standard
  // "attacker is 252-invested" assumption therefore belongs on the
  // defender's Atk (it's the stat the move runs off), and the attacker's own
  // attacking stat is irrelevant (its EVs only matter for other moves).
  const isFoulPlay = move.name === 'Foul Play';
  // Physical/special inference: a mon that has only revealed physical moves is
  // almost certainly Atk-invested (only special moves → SpA-invested). Bias
  // the default EV assumption accordingly — a known physical attacker's
  // special coverage is priced at ~0 SpA (they put the EVs in Atk), not 252,
  // and vice versa. This matters most for hidden-move threats (a physical
  // Garchomp's unrevealed Fire Blast shouldn't be treated as a 252-SpA nuke)
  // and for Foul Play, which runs off the defender's Atk: a known special
  // attacker's Atk is ~0, so Foul Play against it hits for much less.
  const atkInfer = inferOffensiveStat(atkMon, gen);
  const defInfer = inferOffensiveStat(defMon, gen);
  // Real competitive spreads (sets.js): replace the flat "252 EVs in the stat
  // the move uses, neutral nature" defaults with the species' top Smogon
  // spread when the data exists (gen-9 pre-made battles only). Explicit
  // attackerEvs/defenderEvs still fully override — statestimate's pinned-EV
  // probes pass their own, so the estimator is unaffected. The spread also
  // makes the physical/special inference redundant for data species: a
  // physical Garchomp's spread IS 252 Atk / 0 SpA, so its hidden Fire Blast
  // is priced as a coverage tick by the data itself, not a special-case rule.
  const useSets = opts.sets !== false && gen === 9 && !isRandomBattle();
  const neutral = statAssumption !== 'base'; // 'base' = 0 EVs, no nature
  let atkNature = null;
  let defNature = null;
  let atkEvs;
  let defEvs;
  if (isFoulPlay) {
    // Foul Play runs off the TARGET's Attack — the defender's Atk EV and
    // nature come from the spread matching its inferred offense: a known
    // special attacker's spread has ~0 Atk (Foul Play hits it soft), a
    // physical attacker's has 252 (full price).
    const fpRole = defInfer === 'spa' ? 'atk-spec' : 'atk-phys';
    const fpSpread = useSets ? spreadFor(defMon?.species, gen, fpRole) : null;
    atkEvs = opts.attackerEvs ?? {};
    defEvs = opts.defenderEvs ?? (fpSpread
      ? { hp: fpSpread.evs.hp, def: fpSpread.evs.def, atk: fpSpread.evs.atk }
      : { hp: 252, def: 252, atk: defInfer === 'spa' ? 0 : 252 });
    defNature = neutral ? fpSpread?.nature ?? null : null;
  } else {
    // Attacker: pick the spread matching the mon's inferred offense — a mon
    // that reads physical gets the max-Atk spread (its special coverage is
    // priced at the 0 SpA that spread runs, and vice versa). Unknown
    // inference uses the move's own category, so the species' dominant
    // offense drives the read.
    const atkRole =
      atkInfer === 'spa' ? 'atk-spec' : move.category === 'Physical' ? 'atk-phys' : 'atk-spec';
    const defRole = move.category === 'Physical' ? 'def-phys' : 'def-spec';
    const atkSpread = useSets ? spreadFor(atkMon?.species, gen, atkRole) : null;
    const defSpread = useSets ? spreadFor(defMon?.species, gen, defRole) : null;
    atkEvs = opts.attackerEvs ?? (atkSpread
      ? { atk: atkSpread.evs.atk, spa: atkSpread.evs.spa }
      : (move.category === 'Physical'
          ? { atk: atkInfer === 'spa' ? 0 : 252 }
          : { spa: atkInfer === 'atk' ? 0 : 252 }));
    defEvs = opts.defenderEvs ?? (defSpread
      ? { hp: defSpread.evs.hp, def: defSpread.evs.def, spd: defSpread.evs.spd }
      : (move.category === 'Physical' ? { hp: 252, def: 252 } : { hp: 252, spd: 252 }));
    atkNature = neutral ? atkSpread?.nature ?? null : null;
    defNature = neutral ? defSpread?.nature ?? null : null;
  }
  const useEstimates = opts.useEstimates !== false;
  let attacker;
  let defender;
  try {
    attacker = buildPokemon(gen, atkMon, statAssumption === 'base' && !opts.attackerEvs ? {} : atkEvs, opts.attackerTera ?? null, useEstimates, atkNature ?? 'Serious');
    defender = buildPokemon(gen, defMon, statAssumption === 'base' && !opts.defenderEvs ? {} : defEvs, opts.defenderTera ?? null, useEstimates, defNature ?? 'Serious');
  } catch {
    // Unknown species the calc can't build — skip this matchup.
    return null;
  }
  let result;
  try {
    // Screens (Reflect/Light Screen/Aurora Veil) protect the DEFENDER's side:
    // point the field at the actual attacking/defending sides for this call.
    result = calculate(gen, attacker, defender, move, directedField(field, atkMon.side, defMon.side));
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
