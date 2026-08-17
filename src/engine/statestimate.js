// src/engine/statestimate.js
// Back-calculate the opponent's EV investment from observed damage.
//
// Every time a move connects, the reader records { attacker, defender, move,
// damagePct } (see reader.js `_applyHpChange`). Damage is monotonic in EVs:
// more attacker EVs in the move's offensive stat → more damage; more defender
// EVs in its defensive stat → less. So for one observation, the set of EV
// values whose predicted damage range brackets the observed damage is a single
// contiguous interval — found by binary-searching the two monotonic roll-range
// boundaries (the damage high end and low end each cross the observation
// exactly once).
//
// While searching one side, the OTHER side is held at its current best
// estimate (midpoint of any narrowed range, else the standard assumption:
// 252 in the attacking stat for attackers, 252 HP + defending stat for
// defenders). Each new observation intersects with what we already know, so
// the ranges narrow over the course of a battle.
//
// The result lives on each mon as `evEstimate = { atk:[lo,hi], spa:[lo,hi],
// def:[lo,hi], spd:[lo,hi], hp:[lo,hi] }` (EV points, multiples of 4) or null.
// `buildPokemon` then uses the midpoint of a narrowed range instead of the
// blanket 252-EV assumption, so damage calcs get more accurate as we learn.

import { Move, SPECIES } from '@smogon/calc';
import { damagePercent, buildField } from './calc.js';

const EV_MIN = 0;
const EV_MAX = 252;
const EV_STEP = 4;

// How far (in damage %) an observation may sit outside the predicted roll
// range before we call it inconsistent. Damage is displayed rounded to whole
// HP and the calc's rolls span 85-100% of the raw number, so a small slack
// absorbs rounding and roll-resolution noise.
const TOL = 2;

// The widest EV range we still trust enough to feed the calc (12 stat points).
const MAX_TRUSTED_WIDTH = 48;

// "Working" EV set for each side during a search: current estimates where
// known, else the standard assumption (attacker: 252 in the relevant
// offensive stat; defender: 252 HP + 252 in the relevant defensive stat).
function workingEvs(attacker, defender, atkStat, defStat) {
  const pick = (mon, stat, fallback) => {
    const r = mon?.evEstimate?.[stat];
    if (!r) return fallback;
    const width = r[1] - r[0];
    if (width > MAX_TRUSTED_WIDTH) return fallback;
    return Math.max(0, Math.min(252, Math.round((r[0] + r[1]) / 2 / EV_STEP) * EV_STEP));
  };
  return {
    attacker: { [atkStat]: pick(attacker, atkStat, 252) },
    defender: { hp: pick(defender, 'hp', 252), [defStat]: pick(defender, defStat, 252) },
  };
}

// Predicted damage roll range [min, max] % for this matchup with the pinned
// stat set to `ev` and everything else at the working EVs.
function rollRange(gen, attacker, defender, moveName, field, pinned, stat, ev, heldEvs) {
  const attackerEvs = pinned === 'attacker' ? { ...heldEvs.attacker, [stat]: ev } : heldEvs.attacker;
  const defenderEvs = pinned === 'defender' ? { ...heldEvs.defender, [stat]: ev } : heldEvs.defender;
  const d = damagePercent(gen, attacker, defender, moveName, field, {
    attackerEvs,
    defenderEvs,
    useEstimates: false,
  });
  if (!d) return null;
  return { min: d.min, max: d.max };
}

// Generic monotonic boundary search over the EV axis (step 4).
// `pred(ev)` must be monotonic (false→true). Returns the first EV where it's
// true, or null.
function firstTrue(pred) {
  let lo = EV_MIN;
  let hi = EV_MAX;
  let ans = null;
  while (lo <= hi) {
    const mid = Math.round((lo + hi) / 2 / EV_STEP) * EV_STEP;
    if (pred(mid)) {
      ans = mid;
      hi = mid - EV_STEP;
    } else {
      lo = mid + EV_STEP;
    }
  }
  return ans;
}

// `pred(ev)` must be monotonic (true→false). Returns the last EV where it's
// true, or null.
function lastTrue(pred) {
  let lo = EV_MIN;
  let hi = EV_MAX;
  let ans = null;
  while (lo <= hi) {
    const mid = Math.round((lo + hi) / 2 / EV_STEP) * EV_STEP;
    if (pred(mid)) {
      ans = mid;
      lo = mid + EV_STEP;
    } else {
      hi = mid - EV_STEP;
    }
  }
  return ans;
}

// ---------------------------------------------------------------------------
// HP EVs from a revealed absolute max HP (e.g. `|switch|...|281/281`, the live
// request's `condition`, or a hover tooltip). The calc computes max HP from
// base HP, IVs, and HP EVs, so we can solve for the HP EV exactly. Returns
// [lo, hi] EV range or null when HP was only shown as a percentage.
// ---------------------------------------------------------------------------
export function hpEvFromMaxHp(gen, species, level, maxHp) {
  if (!species || !maxHp || maxHp <= 100) return null;
  const bs = SPECIES[String(gen)]?.[species]?.bs;
  if (!bs?.hp) return null;
  const lvl = level ?? 100;
  // maxHP = floor((2*base + IV + floor(EV/4)) * level/100) + level + 10
  // with 31 IVs and neutral nature. Search floor(EV/4) = 0..63 for a match.
  const found = [];
  for (let k = 0; k <= EV_MAX / EV_STEP; k++) {
    const hp = Math.floor(((2 * bs.hp + 31 + k) * lvl) / 100) + lvl + 10;
    if (hp === maxHp) found.push(k);
  }
  if (!found.length) return null;
  const lo = found[0] * EV_STEP;
  const hi = Math.min(found[found.length - 1] * EV_STEP + 3, EV_MAX);
  return [lo, hi];
}

// Narrow a mon's EV estimate for one stat with a new observation. Intersects
// the new consistent interval with the existing one; returns the merged
// [lo, hi] or the previous range when nothing narrowed.
//
// `atkStat`/`defStat` are the move's relevant stats (physical: atk/def,
// special: spa/spd) and `stat` is the one being pinned — the held side must
// use the move's actual defensive stat, not one derived from the pinned stat.
export function narrowStat(
  gen, attacker, defender, moveName, field, stat, atkStat, defStat, damagePct, prev, pinned
) {
  if (damagePct <= 0 || damagePct > 100) return prev ?? null;
  const held = workingEvs(attacker, defender, atkStat, defStat);
  const range = (ev) => rollRange(gen, attacker, defender, moveName, field, pinned, stat, ev, held);
  if (!range(EV_MIN) || !range(EV_MAX)) return prev ?? null; // move/species calc failed

  // Attacker offensive stat: damage grows with EV.
  //   lo = first EV whose high roll reaches the observation
  //   hi = last EV whose low roll stays under the observation
  // Defender defensive stat: damage shrinks with EV (same boundary tests work
  // because both roll edges are monotonic in the opposite direction).
  if (pinned === 'attacker') {
    const lo = firstTrue((ev) => range(ev).max >= damagePct - TOL);
    const hi = lastTrue((ev) => range(ev).min <= damagePct + TOL);
    if (lo == null || hi == null || lo > hi) return prev ?? null;
    const next = [lo, hi];
    if (!prev) return next;
    const merged = [Math.max(prev[0], next[0]), Math.min(prev[1], next[1])];
    return merged[0] <= merged[1] ? merged : prev;
  }
  // Defender: damage decreases with EV (the roll range moves DOWN as EVs
  // grow). The consistent interval is where the range contains the
  // observation:
  //   lo = first EV whose LOW roll has dropped to the observation (damage
  //        stops being strictly too high)
  //   hi = last EV whose HIGH roll still reaches the observation (damage
  //        hasn't dropped strictly too low yet)
  const lo = firstTrue((ev) => range(ev).min <= damagePct + TOL);
  const hi = lastTrue((ev) => range(ev).max >= damagePct - TOL);
  if (lo == null || hi == null || lo > hi) return prev ?? null;
  const next = [lo, hi];
  if (!prev) return next;
  const merged = [Math.max(prev[0], next[0]), Math.min(prev[1], next[1])];
  return merged[0] <= merged[1] ? merged : prev;
}

// Resolve a (possibly narrowed) EV range to a concrete EV for the calc.
export function evFromRange(range, fallback) {
  if (!range) return fallback;
  return Math.max(0, Math.min(252, Math.round((range[0] + range[1]) / 2 / EV_STEP) * EV_STEP));
}

// Narrow ONE of the defender's stats from a Foul Play hit. Foul Play runs off
// the defender's Atk (growing in EV) and hits against the defender's own Def
// (shrinking in EV) — so both axes are the defender's, and the stat being
// searched is pinned while the other is held at its current estimate (252
// default). Monotonic in both directions, so the same binary-search machinery
// as narrowStat applies, just over a custom EV layout.
function narrowFoulPlayStat(gen, attacker, defender, moveName, field, stat, damagePct, prev) {
  const pick = (mon, s, fallback) => {
    const r = mon?.evEstimate?.[s];
    if (!r) return fallback;
    const width = r[1] - r[0];
    if (width > MAX_TRUSTED_WIDTH) return fallback;
    return Math.max(0, Math.min(252, Math.round((r[0] + r[1]) / 2 / EV_STEP) * EV_STEP));
  };
  const held = {
    hp: pick(defender, 'hp', 252),
    atk: pick(defender, 'atk', 252),
    def: pick(defender, 'def', 252),
  };
  const range = (ev) => {
    const d = damagePercent(gen, attacker, defender, moveName, field, {
      defenderEvs: { ...held, [stat]: ev },
      useEstimates: false,
    });
    if (!d) return null;
    return { min: d.min, max: d.max };
  };
  if (!range(EV_MIN) || !range(EV_MAX)) return prev ?? null; // move/species calc failed
  // Atk is the attack source (damage GROWS with EV — use the attacker-side
  // boundary tests); Def is the defensive stat (damage SHRINKS — defender-side
  // tests).
  const lo = stat === 'atk'
    ? firstTrue((ev) => range(ev).max >= damagePct - TOL)
    : firstTrue((ev) => range(ev).min <= damagePct + TOL);
  const hi = stat === 'atk'
    ? lastTrue((ev) => range(ev).min <= damagePct + TOL)
    : lastTrue((ev) => range(ev).max >= damagePct - TOL);
  if (lo == null || hi == null || lo > hi) return prev ?? null;
  const next = [lo, hi];
  if (!prev) return next;
  const merged = [Math.max(prev[0], next[0]), Math.min(prev[1], next[1])];
  return merged[0] <= merged[1] ? merged : prev;
}

// Apply a damage observation to both mon records (mutates mon.evEstimate).
// The attacker's offensive stat and the defender's defensive stat are
// narrowed: first the attacker (defender held at its current estimate), then
// the defender (attacker held at its just-updated estimate).
export function applyObservation(state, obs, gen = state?.gen ?? 9) {
  const attacker = findMon(state, obs.attacker);
  const defender = findMon(state, obs.defender);
  if (!attacker || !defender || !obs.move) return;
  // The observation carries the weather/terrain at hit time (the reader
  // snapshots it, even as null when none was up) — fit the damage against
  // THAT field, since weather and terrain change how much a move deals (Rain
  // boosts Water, Grassy halves Earthquake). Hand-built observations (tests)
  // have no snapshot keys at all and fall back to the current field.
  const hasSnapshot = Object.prototype.hasOwnProperty.call(obs, 'weather') || Object.prototype.hasOwnProperty.call(obs, 'terrain');
  const field = hasSnapshot
    ? buildField({ ...state, field: { ...state.field, weather: obs.weather ?? null, terrain: obs.terrain ?? null } })
    : buildField(state);

  let category = null;
  try {
    category = new Move(gen, obs.move).category;
  } catch {
    return; // unknown move — can't estimate
  }
  if (!category || category === 'Status') return;

  // Foul Play uses the TARGET's Attack stat: the damage depends on the
  // defender's Atk (grows with EV) and the defender's Def (shrinks with EV)
  // — the battle attacker's stats don't matter at all. So a Foul Play hit is
  // evidence about the DEFENDER's investment, not the attacker's. The generic
  // path pins the calc's attacker-side offensive stat, which Foul Play
  // ignores, so search the defender's Atk/Def directly.
  if (obs.move === 'Foul Play') {
    if (!(obs.damagePct > 0 && obs.damagePct <= 100)) return;
    defender.evEstimate ??= {};
    defender.evEstimate.atk = narrowFoulPlayStat(
      gen, attacker, defender, obs.move, field, 'atk', obs.damagePct, defender.evEstimate.atk
    );
    defender.evEstimate.def = narrowFoulPlayStat(
      gen, attacker, defender, obs.move, field, 'def', obs.damagePct, defender.evEstimate.def
    );
    return;
  }

  const atkStat = category === 'Physical' ? 'atk' : 'spa';
  const defStat = category === 'Physical' ? 'def' : 'spd';
  // Reject impossible observations before creating any estimate state.
  if (!(obs.damagePct > 0 && obs.damagePct <= 100)) return;

  attacker.evEstimate ??= {};
  defender.evEstimate ??= {};

  attacker.evEstimate[atkStat] = narrowStat(
    gen, attacker, defender, obs.move, field, atkStat, atkStat, defStat, obs.damagePct,
    attacker.evEstimate[atkStat], 'attacker'
  );
  defender.evEstimate[defStat] = narrowStat(
    gen, attacker, defender, obs.move, field, defStat, atkStat, defStat, obs.damagePct,
    defender.evEstimate[defStat], 'defender'
  );
}

// Consume every not-yet-processed observation in state.observations.
export function applyObservations(state, gen = state?.gen ?? 9) {
  const obs = state?.observations ?? [];
  for (let i = state?.obsProcessed ?? 0; i < obs.length; i++) {
    try {
      applyObservation(state, obs[i], gen);
    } catch {
      // one bad observation must never break the pipeline
    }
  }
  if (state) state.obsProcessed = obs.length;
}

function findMon(state, ident) {
  for (const side of [state.sides.p1, state.sides.p2]) {
    const mon = side.pokemon.find((p) => p.ident === ident);
    if (mon) return mon;
  }
  return null;
}

// Human-readable label for a mon's learned EV info, e.g. "spa 252" / "def ~120".
// Returns null when nothing has been narrowed enough to report.
export function evLabel(mon) {
  const est = mon?.evEstimate;
  if (!est) return null;
  const parts = [];
  for (const stat of ['atk', 'spa', 'def', 'spd', 'hp']) {
    const r = est[stat];
    if (!r) continue;
    const width = r[1] - r[0];
    if (width > MAX_TRUSTED_WIDTH) continue;
    const val = evFromRange(r, 0);
    parts.push(`${stat} ${width <= EV_STEP ? val : `~${val}`}`);
  }
  return parts.length ? parts.join(' · ') : null;
}
