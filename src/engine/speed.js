// src/engine/speed.js
// Speed-order awareness for the recommendation engine.
//
// Damage calcs don't care who moves first, but in real battles it decides
// everything: an outspeeding attacker lands its KO before the defender can
// act, and a slower attacker risks being KO'd before it moves. This module
// computes each side's effective Speed — as a RANGE, because EV investment
// isn't visible (0 EVs up to 252 + a speed-boosting nature) — and applies the
// modifiers the reader does know: boost stages, paralysis, Choice Scarf,
// weather-based speed abilities, Tailwind, and Trick Room.

import { Pokemon, SPECIES } from '@smogon/calc';

// Abilities that double Speed in a specific weather/terrain.
const SPEED_ABILITIES = {
  'Swift Swim': 'RainDance',
  'Chlorophyll': 'SunnyDay',
  'Sand Rush': 'Sandstorm',
  'Slush Rush': 'Snow',
  'Surge Surfer': 'Electric Terrain',
};

// Boost-stage multiplier for Speed (stage -6..+6).
function boostMult(stage) {
  if (stage >= 0) return (2 + stage) / 2;
  return 2 / (2 - stage);
}

// Effective Speed range for a mon, using the info the reader knows.
// `sideId` is the mon's side ('p1'/'p2') so per-side effects (Tailwind) apply.
export function effectiveSpeedRange(gen, mon, state, sideId) {
  if (!mon?.species || !SPECIES[String(gen)]?.[mon.species]) return { min: 0, max: 0 };
  const level = mon.level ?? 100;
  const minBase = new Pokemon(gen, mon.species, {
    level, evs: { spe: 0 }, nature: 'Serious',
  }).stats.spe;
  const maxBase = new Pokemon(gen, mon.species, {
    level, evs: { spe: 252 }, nature: 'Timid',
  }).stats.spe;

  const stage = mon.boosts?.spe ?? 0;
  const mult = boostMult(stage);
  let min = minBase * mult;
  let max = maxBase * mult;

  // Paralysis quarters... halves Speed.
  if (mon.status === 'par') {
    min *= 0.5;
    max *= 0.5;
  }

  // Choice Scarf doubles Speed (only if actually carried and not consumed).
  if (mon.itemRevealed && !mon.itemConsumed && mon.item === 'Choice Scarf') {
    min *= 1.5;
    max *= 1.5;
  }

  // Weather / terrain abilities (only when the ability itself is revealed).
  const weather = state?.field?.weather ?? null;
  const terrain = state?.field?.terrain ?? null;
  if (mon.ability && SPEED_ABILITIES[mon.ability] === (weather ?? terrain)) {
    min *= 2;
    max *= 2;
  }

  // Tailwind doubles that side's Speed.
  if (state?.sides?.[sideId]?.effects?.Tailwind) {
    min *= 2;
    max *= 2;
  }

  return { min: Math.round(min), max: Math.round(max) };
}

// Who moves first between two actives. Returns one of:
//   { weMoveFirst: true  }  — we outspeed them even at their max investment
//   { weMoveFirst: false }  — they outspeed us even at our max investment
//   { weMoveFirst: null  }  — ranges overlap, order depends on their spread
// Also reports the ranges and whether Trick Room is active (slower moves first).
export function speedOrder(ours, theirs, gen, state, ourSideId) {
  const theirSideId = ourSideId === 'p1' ? 'p2' : 'p1';
  const oursRange = effectiveSpeedRange(gen, ours, state, ourSideId);
  const theirsRange = effectiveSpeedRange(gen, theirs, state, theirSideId);
  const trickRoom = !!(state?.field?.effects?.['Trick Room']);

  // Trick Room flips the comparison: the slower mon moves first, so a mon
  // whose range is entirely BELOW theirs outspeeds under the field effect.
  let weMoveFirst;
  if (trickRoom) {
    if (oursRange.max < theirsRange.min) weMoveFirst = true;
    else if (oursRange.min > theirsRange.max) weMoveFirst = false;
    else weMoveFirst = null;
  } else {
    if (oursRange.min > theirsRange.max) weMoveFirst = true;
    else if (oursRange.max < theirsRange.min) weMoveFirst = false;
    else weMoveFirst = null;
  }

  return { weMoveFirst, oursRange, theirsRange, trickRoom };
}

// A short human line describing the speed situation, e.g.
//   "You outspeed their Great Tusk (248-342 vs 210-300)."
//   "Their Iron Treads outspeeds you (248-342 vs 196-284) — they move first."
//   "Speed is close (248-342 vs 240-340) — order could go either way."
// Returns null when there's no speed data to reason about.
export function speedLine(ours, theirs, gen, state, ourSideId) {
  const order = speedOrder(ours, theirs, gen, state, ourSideId);
  const { oursRange, theirsRange, trickRoom } = order;
  const fmt = (r) => `${r.min}-${r.max}`;
  if (order.weMoveFirst === true) {
    return `You outspeed their ${theirs?.species} (${fmt(oursRange)} vs ${fmt(theirsRange)}) — you move first${trickRoom ? ' (Trick Room: slower moves first)' : ''}.`;
  }
  if (order.weMoveFirst === false) {
    return `Their ${theirs?.species} outspeeds you (${fmt(theirsRange)} vs ${fmt(oursRange)}) — they move first${trickRoom ? ' (Trick Room: slower moves first)' : ''}.`;
  }
  return `Speed is close (you ${fmt(oursRange)}, them ${fmt(theirsRange)})${trickRoom ? ' — Trick Room is active (slower moves first)' : ' — order could go either way'}.`;
}
