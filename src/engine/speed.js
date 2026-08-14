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

// Items that halve the holder's Speed while held (EV-training / gimmick items
// plus Iron Ball).
const SPEED_HALVING_ITEMS = new Set([
  'Iron Ball', 'Macho Brace',
  'Power Anklet', 'Power Band', 'Power Belt', 'Power Bracer', 'Power Lens', 'Power Weight',
]);

// Lagging Tail is different: it doesn't touch the Speed stat at all — it
// makes the holder move LAST within its priority bracket (priority -0.1), no
// matter how fast it is or whether Trick Room is active.
export function holdsLaggingTail(mon) {
  return !!mon && mon.itemRevealed && !mon.itemConsumed && mon.item === 'Lagging Tail';
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
  let source = null;
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
    // Species-keyed speed memory: a previous same-turn trade against a mon
    // with an exactly known Speed pinned rough bounds on this mon's base
    // Speed (see the reader's _recordSpeedEvidence). The memory survives
    // switch-outs, so a mon that leaves and comes back keeps "roughly how
    // fast it might be" instead of returning to the full 0-252 guess.
    const mem = state?.speedMemory?.[sideId]?.[mon.species];
    if (mem && (mem.min != null || mem.max != null)) {
      const lo = mem.min != null ? Math.max(min, mem.min) : min;
      const hi = mem.max != null ? Math.min(max, mem.max) : max;
      // A bound that contradicts the species' possible Speed (which would
      // invert the range) can only come from a bad observation — discard it
      // and keep the plain calc estimate.
      if (lo <= hi) {
        min = lo;
        max = hi;
        source = 'memory';
      }
    }
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

  // Item multipliers while actually held: Choice Scarf ×1.5, halving items
  // ×0.5, Quick Powder ×2 for an untransformed Ditto. (Room Service is not
  // here: its Speed drop arrives as a normal -1 Spe boost line in the log,
  // which the reader tracks and the boost multiplier above applies.)
  if (mon.itemRevealed && !mon.itemConsumed) {
    if (mon.item === 'Choice Scarf') {
      min *= 1.5;
      max *= 1.5;
    } else if (SPEED_HALVING_ITEMS.has(mon.item)) {
      min *= 0.5;
      max *= 0.5;
    } else if (mon.item === 'Quick Powder' && mon.species === 'Ditto') {
      min *= 2;
      max *= 2;
    }
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

  const out = { min: Math.round(min), max: Math.round(max) };
  if (source) out.source = source;
  return out;
}

// Find the most recent speed observation for this active pair that is still
// valid: same idents (or, for a mon that switched out and back in under a new
// slot letter, the same species), nothing speed-affecting changed on either
// mon (speVersion), on the field (weather/terrain/Trick Room), or on either
// side (Tailwind), and the same Trick Room state. Returns null when no
// observation applies — the ranges must speak for themselves.
export function findSpeedEvidence(state, ours, theirs, ourSideId) {
  const theirSideId = ourSideId === 'p1' ? 'p2' : 'p1';
  const evs = state?.speedEvidence ?? [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const ev = evs[i];
    if (!ev.clean) continue;
    // A mon that left and came back keeps its record (species match) but gets
    // a new slot ident (p2a -> p2b), so an exact ident match fails even though
    // the observation is still valid. Accept a species match when the mon has
    // re-entered (switchCount > 1). Its speVersion is preserved on the reused
    // record, so the version checks below still hold. Each side matches
    // independently (exact ident, or species on a re-entered mon).
    const oursMatch =
      ev[`${ourSideId}Ident`] === ours?.ident ||
      (ours?.switchCount > 1 && ev[`${ourSideId}Species`] === ours?.species);
    const theirsMatch =
      ev[`${theirSideId}Ident`] === theirs?.ident ||
      (theirs?.switchCount > 1 && ev[`${theirSideId}Species`] === theirs?.species);
    if (!oursMatch || !theirsMatch) continue;
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

  // Lagging Tail: the holder moves last within its priority bracket, so if
  // exactly one side holds it, that decides the order outright — regardless
  // of Speed, boosts, items, or Trick Room. (If both hold it, Speed decides
  // between them, so the calculation above stands.)
  const ourLag = holdsLaggingTail(ours);
  const theirLag = holdsLaggingTail(theirs);
  const laggingTail = ourLag || theirLag;
  if (ourLag !== theirLag) {
    weMoveFirst = ourLag ? false : true;
  }

  return { weMoveFirst, oursRange, theirsRange, trickRoom, observed, laggingTail };
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
  const ourLag = holdsLaggingTail(ours);
  const theirLag = holdsLaggingTail(theirs);
  // Lagging Tail overrides everything — say so plainly instead of quoting
  // speed numbers that no longer decide the order.
  if (ourLag !== theirLag) {
    if (ourLag) {
      return `You hold Lagging Tail — their ${theirs?.species} moves first regardless of Speed.`;
    }
    return `Their ${theirs?.species} holds Lagging Tail — you move first regardless of Speed.`;
  }
  // A range narrowed by the species-keyed speed memory (a mon that left and
  // came back) deserves a note so the reader knows the figure is remembered,
  // not freshly revealed.
  const remembered = oursRange.source === 'memory' || theirsRange.source === 'memory';
  const rem = remembered ? ' (speed remembered from earlier trades)' : '';
  if (order.weMoveFirst === true) {
    const obs = observed ? ' — observed: you moved first when you last traded moves' : '';
    return `You outspeed their ${theirs?.species} (${fmt(oursRange)} vs ${fmt(theirsRange)}) — you move first${obs}${tr}${rem}.`;
  }
  if (order.weMoveFirst === false) {
    const obs = observed ? ' — observed: it moved first when you last traded moves' : '';
    return `Their ${theirs?.species} outspeeds you (${fmt(theirsRange)} vs ${fmt(oursRange)}) — they move first${obs}${tr}${rem}.`;
  }
  return `Speed is close (you ${fmt(oursRange)}, them ${fmt(theirsRange)})${trickRoom ? ' — Trick Room is active (slower moves first)' : ' — order could go either way'}${rem}.`;
}
