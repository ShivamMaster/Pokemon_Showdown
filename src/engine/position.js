// src/engine/position.js
// The positional win-probability eval: a "who wins this game" read from the
// whole board, not just the current matchup. The recommendation engine is
// move-centric (score each move, score each switch); this module answers a
// different question — how far ahead or behind the game actually is — so the
// risk mode and switch aggression can follow the position instead of the
// local 1v1.
//
// Components (each in [-1, 1], all in HP-equivalent units):
//   material  — remaining HP plus a per-body bonus (mirrors boardAdvantage in
//               recommend.js), normalized by the total value on the field.
//               The anchor: a body's worth of HP is the biggest single fact.
//   firepower — each side's total offensive RATE against the other team (best
//               move per target, uncapped — the raw per-turn output; the
//               "overkill doesn't count" cap belongs to the win-condition
//               read, not the positional rate). Normalized; only counted once
//               BOTH sides have revealed moves — with nothing revealed,
//               firepower is unknown, not zero.
//   speed     — each side's fastest effective Speed (revealed stats first,
//               then the species' top set as a prior, then a max-plausible
//               calc estimate). Same rule both sides, so unknown speeds read
//               neutral instead of flattering whoever revealed more.
//   hazards   — entry-hazard differential: their layers hurt them, ours hurt
//               us. Worth ~10% of a body per layer, capped.
//   recovery  — how much missing HP each side's revealed recovery moves can
//               actually heal (a full-HP mon with Recover has no healing to
//               do, so it only counts against missing HP).
//   active    — the current 1v1 trade rate: our active's best hit on theirs
//               vs theirs on ours, capped by remaining HP. Their active being
//               down is a big swing in our favor (they can't attack this
//               turn). Only counted once both actives have revealed moves.
//
// The score is a weighted sum (material anchors, the refinements have teeth:
// with even material, a team that outguns the other ~7:1, controls the tempo
// and wins the active 1v1 reaches the mode thresholds on position alone),
// mapped to a 0-1 win probability. `recommend` uses it to resolve the risk
// mode (and to temper the switch bar) — see resolveRiskMode and the auto-mode
// temper there.

import { Pokemon } from '@smogon/calc';
import { damagePercent, round1 } from './calc.js';
import { RECOVERY_MOVES } from './movepool.js';
import { spreadFor } from './sets.js';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Effective Speed for the positional read. Exact stats when the reader knows
// them, the species' top set's Speed as a prior, else the max-plausible calc
// estimate (252 Spe / Timid). Both sides get the same rule, so an unknown
// Speed just reads neutral.
function speedOf(mon, gen) {
  if (!mon?.species) return 0;
  const level = mon.level ?? 100;
  if (mon.stats?.spe != null) return mon.stats.spe;
  if (mon.statsEffective?.spe != null) return mon.statsEffective.spe;
  if (mon.speedRange?.max != null) return mon.speedRange.max;
  const spread = spreadFor(mon.species, gen);
  if (spread?.evs?.spe != null) {
    try {
      return new Pokemon(gen, mon.species, { level, evs: spread.evs, nature: spread.nature }).stats.spe;
    } catch {
      /* fall through to the estimate */
    }
  }
  try {
    return new Pokemon(gen, mon.species, { level, evs: { spe: 252 }, nature: 'Timid' }).stats.spe;
  } catch {
    return 0;
  }
}

// A mon's raw offensive output against one opposing team: best move per
// target as a % of max HP. Deliberately NOT capped at the target's remaining
// HP — recommend.offensiveValue caps (overkill doesn't count toward a win
// condition), but the positional read needs the RATE: a target at 10% HP is
// nearly dead, so "we can only deal 10 more damage to it" is not a weakness,
// it's the material term's job to value that 10%. Capping here would make
// the short side look stronger than the healthy side (a single 10%-HP mon
// would "outgun" three full ones), which inverts the signal.
function monFirepower(mon, oppTeam, gen, field, calcOpts) {
  let total = 0;
  for (const target of oppTeam ?? []) {
    let best = 0;
    for (const moveName of mon.moves ?? []) {
      const d = damagePercent(gen, mon, target, moveName, field, calcOpts);
      if (d?.mean && d.mean > best) best = d.mean;
    }
    total += best;
  }
  return total;
}

const teamFirepower = (team, oppTeam, gen, field, calcOpts) =>
  (team ?? []).reduce((sum, m) => sum + monFirepower(m, oppTeam, gen, field, calcOpts), 0);

// "Who wins this game" read. Returns { winProb, score, components } where
// winProb is 0-1 (0.5 = even). `opts.hazards` is the { ours, theirs } layer
// count the engine already computes; `opts.active` is { ours, theirs } with
// the active mons (theirs may be null when their active is down).
export function positionalWinProb(ourTeam, theirTeam, gen, field, calcOpts = {}, opts = {}) {
  const hazards = opts.hazards ?? null;
  const active = opts.active ?? null;
  const ours = ourTeam ?? [];
  const theirs = theirTeam ?? [];
  if (!ours.length && !theirs.length) {
    return { winProb: 0.5, score: 0, components: {} };
  }


  // Material: remaining HP + per-body bonus, normalized by what's at stake.
  const value = (t) => t.reduce((sum, m) => sum + (m.hpPercent ?? 100), 0) + t.length * 40;
  const ourValue = value(ours);
  const theirValue = value(theirs);
  const material = (ourValue - theirValue) / Math.max(1, ourValue + theirValue);

  // Firepower: only meaningful once both sides have shown moves.
  const revealedMoves = (t) => t.reduce((n, m) => n + (m.moves?.length ?? 0), 0);
  let firepower = 0;
  if (revealedMoves(ours) > 0 && revealedMoves(theirs) > 0) {
    const ourFire = teamFirepower(ours, theirs, gen, field, calcOpts);
    const theirFire = teamFirepower(theirs, ours, gen, field, calcOpts);
    // A 7:1 output ratio (clamp ±0.75) is a genuinely one-sided game — walls
    // vs sweepers at even HP. That must be able to swing the mode on its own.
    firepower = clamp((ourFire - theirFire) / Math.max(1, ourFire + theirFire), -0.75, 0.75);
  }

  // Speed: who controls the tempo.
  const ourFast = Math.max(0, ...ours.map((m) => speedOf(m, gen)));
  const theirFast = Math.max(0, ...theirs.map((m) => speedOf(m, gen)));
  const speed = ourFast + theirFast > 0 ? clamp((ourFast - theirFast) / Math.max(ourFast, theirFast), -0.3, 0.3) : 0;

  // Hazards: their layers hurt them, ours hurt us. ~10% of a body per layer.
  const hazardsTerm = clamp(((hazards?.theirs ?? 0) - (hazards?.ours ?? 0)) * 0.1, -0.15, 0.15);

  // Recovery: revealed recovery moves × how much HP is actually missing.
  const healPotential = (t) =>
    t.reduce((sum, m) => {
      const hasRec = (m.moves ?? []).some((mv) => RECOVERY_MOVES.has(mv));
      return hasRec ? sum + (100 - (m.hpPercent ?? 100)) : sum;
    }, 0);
  const ourHeal = healPotential(ours);
  const theirHeal = healPotential(theirs);
  const recovery = ourHeal + theirHeal > 0 ? clamp((ourHeal - theirHeal) / Math.max(1, ourHeal + theirHeal), -0.3, 0.3) : 0;

  // Active 1v1: the current trade rate. Their active being down is a swing in
  // our favor (they can't attack this turn).
  let activeTerm = 0;
  const ourAct = active?.ours;
  const theirAct = active?.theirs;
  const ourMoves = ourAct?.moves?.length ?? 0;
  const theirMoves = theirAct?.moves?.length ?? 0;
  if (ourAct && ourMoves > 0 && theirAct && theirMoves > 0) {
    const ourOut = Math.min(monFirepower(ourAct, [theirAct], gen, field, calcOpts), theirAct.hpPercent ?? 100);
    const theirOut = Math.min(monFirepower(theirAct, [ourAct], gen, field, calcOpts), ourAct.hpPercent ?? 100);
    activeTerm = clamp((ourOut - theirOut) / Math.max(1, ourOut + theirOut), -0.4, 0.4);
  } else if (ourAct && ourMoves > 0 && !theirAct) {
    activeTerm = 0.3;
  }

  const components = {
    material: round1(material),
    firepower: round1(firepower),
    speed: round1(speed),
    hazards: round1(hazardsTerm),
    recovery: round1(recovery),
    active: round1(activeTerm),
  };
  // Material anchors (a body's worth of HP is the biggest single fact), but
  // the refinements get real teeth: with even material, a team that outguns
  // the other 7:1, controls the tempo, and wins the active 1v1 reaches the
  // mode thresholds on position alone.
  const score =
    0.4 * material +
    0.25 * firepower +
    0.1 * speed +
    0.05 * hazardsTerm +
    0.05 * recovery +
    0.15 * activeTerm;
  const winProb = clamp(0.5 + 0.6 * score, 0, 1);
  return { winProb, score: round1(score), components };
}
