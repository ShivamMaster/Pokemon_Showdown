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
//
// Priority of knowledge:
//   1. `statsEffective.spe` (hover tooltip "(After stat modifiers:)" line) —
//      every modifier is already baked in, return it as-is.
//   2. `stats.spe` (live request / hover tooltip raw line) — exact EVs+nature,
//      so a point, but still "before external modifiers": apply boosts,
//      paralysis, items, weather abilities, Tailwind below.
//   3. `speedRange` (opponent's hover tooltip Spe range) — exact EV/nature
//      bounds, same "before external modifiers" semantics.
//   4. Calc-based 0→252 EV estimate (nothing revealed).
export function effectiveSpeedRange(gen, mon, state, sideId) {
  if (!mon?.species || !SPECIES[String(gen)]?.[mon.species]) return { min: 0, max: 0 };
  const level = mon.level ?? 100;

  if (mon.statsEffective?.spe != null) {
    return { min: mon.statsEffective.spe, max: mon.statsEffective.spe };
  }

  let min, max;
  if (mon.stats?.spe != null) {
    min = mon.stats.spe;
    max = mon.stats.spe;
  } else if (mon.speedRange?.min != null && mon.speedRange?.max != null) {
    min = mon.speedRange.min;
    max = mon.speedRange.max;
  } else {
    min = new Pokemon(gen, mon.species, {
      level, evs: { spe: 0 }, nature: 'Serious',
    }).stats.spe;
    max = new Pokemon(gen, mon.species, {
      level, evs: { spe: 252 }, nature: 'Timid',
    }).stats.spe;
  }

  const stage = mon.boosts?.spe ?? 0;
  const mult = boostMult(stage);
  min *= mult;
  max *= mult;

  // Paralysis quarters... halves Speed.
  if (mon.status === 'par') {
    min *= 0.5;
    max *= 0.5;
  }

  // Choice Scarf multiplies Speed by 1.5 and Iron Ball halves it (only while
  // actually held).
  if (mon.itemRevealed && !mon.itemConsumed && mon.item === 'Choice Scarf') {
    min *= 1.5;
    max *= 1.5;
  } else if (mon.itemRevealed && !mon.itemConsumed && mon.item === 'Iron Ball') {
    min *= 0.5;
    max *= 0.5;
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

// Find the most recent speed observation for this exact active pair that is
// still valid: same idents, nothing speed-affecting changed on either mon
// (speVersion), on the field (weather/terrain/Trick Room), or on either side
// (Tailwind), and the same Trick Room state. Returns null when no observation
// applies — the ranges must speak for themselves.
export function findSpeedEvidence(state, ours, theirs, ourSideId) {
  const theirSideId = ourSideId === 'p1' ? 'p2' : 'p1';
  const evs = state?.speedEvidence ?? [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const ev = evs[i];
    if (!ev.clean) continue;
    if (ev[`${ourSideId}Ident`] !== ours?.ident || ev[`${theirSideId}Ident`] !== theirs?.ident) continue;
    if (ev.ver[ourSideId] !== ours?.speVersion || ev.ver[theirSideId] !== theirs?.speVersion) continue;
    if (ev.ver.field !== (state?.field?.speVersion ?? 0)) continue;
    if (ev.ver.side1 !== (state?.sides?.p1?.speVersion ?? 0)) continue;
    if (ev.ver.side2 !== (state?.sides?.p2?.speVersion ?? 0)) continue;
    if (!!ev.trickRoom !== !!(state?.field?.effects?.['Trick Room'])) continue;
    return ev;
  }
  return null;
}

// Who moves first between two actives. Returns one of:
//   { weMoveFirst: true  }  — we outspeed them even at their max investment
//   { weMoveFirst: false }  — they outspeed us even at our max investment
//   { weMoveFirst: null  }  — ranges overlap, order depends on their spread
// Also reports the ranges, whether Trick Room is active (slower moves first),
// and whether the order was directly observed (both sides traded moves this
// battle with nothing speed-affecting changing since). A direct observation
// beats the range estimate: the ranges are a guess, the trade was real.
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

  // Directly observed order wins over the guess whenever it's still valid.
  const evidence = findSpeedEvidence(state, ours, theirs, ourSideId);
  const observed = !!evidence;
  if (evidence) {
    weMoveFirst = evidence.fasterSide === ourSideId;
  }

  return { weMoveFirst, oursRange, theirsRange, trickRoom, observed };
}

// A short human line describing the speed situation, e.g.
//   "You outspeed their Great Tusk (248-342 vs 210-300)."
//   "Their Iron Treads outspeeds you (248-342 vs 196-284) — they move first."
//   "Speed is close (248-342 vs 240-340) — order could go either way."
// When the order was directly observed (a same-turn move trade), the line
// says so instead of hedging. Exact known speeds render as a point (165,
// not 165-165). Returns null when there's no speed data to reason about.
export function speedLine(ours, theirs, gen, state, ourSideId) {
  const order = speedOrder(ours, theirs, gen, state, ourSideId);
  const { oursRange, theirsRange, trickRoom, observed } = order;
  const fmt = (r) => (r.min === r.max ? String(r.min) : `${r.min}-${r.max}`);
  const tr = trickRoom ? ' (Trick Room: slower moves first)' : '';
  if (order.weMoveFirst === true) {
    const obs = observed ? ' — observed: you moved first when you last traded moves' : '';
    return `You outspeed their ${theirs?.species} (${fmt(oursRange)} vs ${fmt(theirsRange)}) — you move first${obs}${tr}.`;
  }
  if (order.weMoveFirst === false) {
    const obs = observed ? ' — observed: it moved first when you last traded moves' : '';
    return `Their ${theirs?.species} outspeeds you (${fmt(theirsRange)} vs ${fmt(oursRange)}) — they move first${obs}${tr}.`;
  }
  return `Speed is close (you ${fmt(oursRange)}, them ${fmt(theirsRange)})${trickRoom ? ' — Trick Room is active (slower moves first)' : ' — order could go either way'}.`;
}
