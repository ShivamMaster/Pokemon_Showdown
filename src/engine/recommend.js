// src/engine/recommend.js
// The recommendation engine: given a reader BattleState (plus optional
// per-opponent profile), decide the best move and whether to switch.
//
// Scoring model (all in % of max HP):
//   - Each of our moves is scored as expected damage against their active
//     Pokémon weighted by P(they stay), plus expected damage against each of
//     their benched Pokémon weighted by P(switch-in to that mon).
//   - Expected damage is capped at the target's remaining HP (no credit for
//     overkill), with a bonus if the move can KO.
//   - Status/setup/recovery moves get fixed utility scores (0-50).
//   - Switching is scored by how much less damage the candidate takes from
//     their active's best move than our current mon would, plus a small
//     offensive bonus. A switch is recommended when it clearly saves HP and
//     our current options are weak or we're in danger.
//
// The switch predictions (P stay / P switch-in) use profile data when
// available: profile.switchTendency.atLowHp and profile.commonSwitchIns
// (species -> weight). Without a profile, sensible defaults apply.

import { damagePercent, buildField, round1 } from './calc.js';

const clamp01 = (n) => Math.max(0, Math.min(1, n));

const SETUP_MOVES = new Set([
  'Swords Dance', 'Dragon Dance', 'Nasty Plot', 'Calm Mind', 'Bulk Up',
  'Quiver Dance', 'Agility', 'Iron Defense', 'Tail Glow', 'Shell Smash',
]);
const RECOVERY_MOVES = new Set([
  'Recover', 'Roost', 'Soft-Boiled', 'Slack Off', 'Synthesis', 'Moonlight',
  'Morning Sun', 'Shore Up', 'Strength Sap', 'Rest', 'Heal Order',
]);
const STATUS_MOVES = new Set([
  'Will-O-Wisp', 'Thunder Wave', 'Toxic', 'Spore', 'Sleep Powder',
  'Hypnosis', 'Glare',
]);
const HAZARD_MOVES = new Set(['Stealth Rock', 'Spikes', 'Toxic Spikes', 'Sticky Web']);
const PIVOT_MOVES = new Set(['U-turn', 'Volt Switch', 'Flip Turn', 'Teleport', 'Parting Shot']);

export function utilityScore(moveName) {
  if (RECOVERY_MOVES.has(moveName)) return { value: 0.5, note: 'recovery' };
  if (SETUP_MOVES.has(moveName)) return { value: 0.3, note: 'setup' };
  if (STATUS_MOVES.has(moveName)) return { value: 0.35, note: 'status' };
  if (HAZARD_MOVES.has(moveName)) return { value: 0.3, note: 'hazards' };
  if (PIVOT_MOVES.has(moveName)) return { value: 0.15, note: 'pivot' };
  if (moveName === 'Protect') return { value: 0.1, note: 'protect' };
  if (moveName === 'Substitute') return { value: 0.2, note: 'substitute' };
  if (moveName === 'Rapid Spin' || moveName === 'Defog') return { value: 0.3, note: 'hazard removal' };
  return null;
}

export function activeMon(side) {
  for (const ident of side?.active ?? []) {
    const mon = side.pokemon?.find((p) => p.ident === ident);
    if (mon && !mon.fainted) return mon;
  }
  return null;
}

const alivePokemon = (side) => (side?.pokemon ?? []).filter((m) => !m.fainted);

export function effLabel(effectiveness) {
  const key = effectiveness >= 4 ? 4 : effectiveness >= 2 ? 2 : effectiveness <= 0 ? 0 : effectiveness <= 0.25 ? 0.25 : effectiveness <= 0.5 ? 0.5 : 1;
  if (key === 0) return 'immune';
  if (key === 0.25) return '¼×';
  if (key === 0.5) return '½×';
  if (key === 1) return '';
  return `${key}×`;
}

// ---------------------------------------------------------------------------
// Switch prediction (profile-aware)
// ---------------------------------------------------------------------------

export function predictStayProb(theirActive, profile = null) {
  const hp = theirActive?.hpPercent ?? 100;
  let p;
  if (hp < 25) p = 0.35;
  else if (hp < 50) p = 0.6;
  else p = 0.8;
  if (profile?.switchTendency?.atLowHp != null && hp < 40) {
    p = 1 - profile.switchTendency.atLowHp;
  }
  return Math.round(clamp01(p) * 100) / 100;
}

export function predictSwitchProbs(theirActive, theirTeam, stayProb, profile = null) {
  const bench = theirTeam.filter((m) => m.ident !== theirActive?.ident);
  if (!bench.length) return {};
  const weights = bench.map((m) => Math.max(0, profile?.commonSwitchIns?.[m.species] ?? 1));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const probs = {};
  bench.forEach((m, i) => {
    probs[m.ident] = (1 - stayProb) * (weights[i] / total);
  });
  return probs;
}

export function mostLikelySwitchIn(team, profile = null) {
  let best = team[0];
  let bestW = -1;
  for (const m of team) {
    const w = profile?.commonSwitchIns?.[m.species] ?? 0;
    if (w > bestW) {
      best = m;
      bestW = w;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Move evaluation
// ---------------------------------------------------------------------------

export function evaluateMove(attacker, moveName, theirTarget, theirTeam, stayProb, switchProbs, gen, field, calcOpts = {}) {
  const vsTarget = damagePercent(gen, attacker, theirTarget, moveName, field, calcOpts);
  if (!vsTarget) return null;

  if (vsTarget.category === 'Status') {
    const util = utilityScore(moveName);
    if (!util) return null;
    return {
      move: moveName,
      score: round1(util.value * 100),
      kind: 'status',
      note: `${moveName}: ${util.note} (utility ${Math.round(util.value * 100)}/100)`,
    };
  }

  const bench = theirTeam.filter((m) => m.ident !== theirTarget.ident);
  const benchDmg = bench.map((m) => {
    const d = damagePercent(gen, attacker, m, moveName, field, calcOpts);
    return { ident: m.ident, dmg: d?.mean ?? 0, eff: d?.effectiveness ?? 1 };
  });

  const targetHp = theirTarget.hpPercent ?? 100;
  // Cap damage at remaining HP so overkill gets no credit.
  const cappedActive = Math.min(vsTarget.mean, targetHp);
  let score = stayProb * cappedActive;
  for (const b of benchDmg) {
    const capped = Math.min(b.dmg, b.dmg > 0 ? (theirTeam.find((m) => m.ident === b.ident)?.hpPercent ?? 100) : 0);
    score += (switchProbs[b.ident] ?? 0) * capped;
  }

  const ko = vsTarget.max >= targetHp;
  const koGuaranteed = vsTarget.min >= targetHp;
  if (ko) score += 10;

  const effText = effLabel(vsTarget.effectiveness);
  const seHits = benchDmg.filter((b) => b.eff >= 2).map((b) => b.ident.split(': ')[1]).slice(0, 2);
  const parts = [`~${vsTarget.mean}% vs ${theirTarget.species}`];
  if (effText) parts.push(effText);
  if (ko) parts.push(koGuaranteed ? 'guaranteed KO' : 'can KO');
  if (seHits.length) parts.push(`also hits ${seHits.join(', ')} super effectively`);
  const note = `${moveName}: ${parts.join(' · ')}`;

  return {
    move: moveName,
    score: round1(score),
    kind: 'damage',
    ko,
    koGuaranteed,
    expected: { min: vsTarget.min, max: vsTarget.max, mean: vsTarget.mean, effectiveness: vsTarget.effectiveness },
    note,
  };
}

// ---------------------------------------------------------------------------
// Switch evaluation
// ---------------------------------------------------------------------------

// Max expected damage % their active's best known move deals to `target`.
export function incomingPercent(theirActive, target, gen, field, calcOpts = {}) {
  if (!theirActive?.moves?.length) return { pct: 0, move: null };
  let max = 0;
  let move = null;
  for (const moveName of theirActive.moves) {
    const d = damagePercent(gen, theirActive, target, moveName, field, calcOpts);
    if (!d) continue;
    if (d.mean > max) {
      max = d.mean;
      move = moveName;
    }
  }
  return { pct: max, move };
}

export function ownBestDamage(candidate, theirTarget, gen, field, calcOpts = {}) {
  let max = 0;
  for (const moveName of candidate?.moves ?? []) {
    const d = damagePercent(gen, candidate, theirTarget, moveName, field, calcOpts);
    if (d?.mean && d.mean > max) max = d.mean;
  }
  return max;
}

export function evaluateSwitch(ourActive, candidate, theirActive, gen, field, calcOpts = {}) {
  const now = incomingPercent(theirActive, ourActive, gen, field, calcOpts);
  const cand = incomingPercent(theirActive, candidate, gen, field, calcOpts);
  const candOff = ownBestDamage(candidate, theirActive, gen, field, calcOpts);
  const net = (now.pct - cand.pct) + candOff * 0.15;
  if (net <= 0) return null;
  const theirMove = now.move ?? cand.move ?? 'their moves';
  const note =
    `Switch to ${candidate.species}: takes ~${round1(cand.pct)}% from ${theirMove} ` +
    `(vs ~${round1(now.pct)}% for ${ourActive.species})` +
    (candOff ? `, hits back for ~${round1(candOff)}%` : '');
  return {
    ident: candidate.ident,
    species: candidate.species,
    nowIn: round1(now.pct),
    candIn: round1(cand.pct),
    candOff: round1(candOff),
    net: round1(net),
    note,
  };
}

export function bestSwitchIn(ourTeam, theirActive, gen, field, profile = null, calcOpts = {}) {
  let best = null;
  let bestScore = -Infinity;
  for (const candidate of ourTeam) {
    const cand = incomingPercent(theirActive, candidate, gen, field, calcOpts);
    const candOff = ownBestDamage(candidate, theirActive, gen, field, calcOpts);
    const score = candOff - cand.pct * 0.2;
    if (score > bestScore) {
      bestScore = score;
      best = {
        ident: candidate.ident,
        species: candidate.species,
        candIn: round1(cand.pct),
        candOff: round1(candOff),
        net: round1(score),
        note: `Send in ${candidate.species}: takes ~${round1(cand.pct)}% from their ${cand.move ?? 'moves'}${candOff ? `, hits back for ~${round1(candOff)}%` : ''}`,
      };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function recommend(state, opts = {}) {
  const ourSideId = opts.ourSideId ?? 'p1';
  const theirSideId = ourSideId === 'p1' ? 'p2' : 'p1';
  const ourSide = state?.sides?.[ourSideId];
  const theirSide = state?.sides?.[theirSideId];
  const gen = state?.gen ?? 9;
  const profile = opts.profile ?? null;
  const calcOpts = opts.statAssumption ? { statAssumption: opts.statAssumption } : {};
  const reasoning = [];

  if (state?.winner) {
    const text = state.winner === 'tie' ? 'Tie game' : `${state.winner} wins`;
    return { bestMove: null, switchTo: null, reasoning: [text], note: text };
  }

  const field = buildField(state);
  const ourTeam = alivePokemon(ourSide);
  const theirTeam = alivePokemon(theirSide);

  if (!ourTeam.length) {
    const revealed = ourSide?.pokemon?.length ?? 0;
    const fainted = (ourSide?.pokemon ?? []).filter((m) => m.fainted).length;
    const msg =
      revealed === 0
        ? 'Your team has not been revealed yet in this log.'
        : `All ${fainted} revealed Pokémon are down — this log has not shown your remaining team yet (the live extension will know it).`;
    return { bestMove: null, switchTo: null, reasoning: [msg], note: null };
  }

  let ourActive = activeMon(ourSide);

  // Our active is down — must send in a replacement.
  if (!ourActive) {
    const s = bestSwitchIn(ourTeam, activeMon(theirSide), gen, field, profile, calcOpts);
    return {
      bestMove: null,
      switchTo: s,
      reasoning: ['Your active Pokémon is down — send in a replacement.', ...(s ? [s.note] : [])],
      note: null,
    };
  }

  let theirTarget = activeMon(theirSide);
  let stayProb;
  let switchProbs;
  if (!theirTarget) {
    // Their active is down — they must send someone; predict the most likely.
    const predicted = mostLikelySwitchIn(theirTeam, profile);
    theirTarget = predicted;
    stayProb = 1;
    switchProbs = {};
    reasoning.push(`${predicted?.species ?? 'A new Pokémon'} is the most likely switch-in (their active is down).`);
  } else {
    stayProb = predictStayProb(theirTarget, profile);
    switchProbs = predictSwitchProbs(theirTarget, theirTeam, stayProb, profile);
  }

  const bench = ourTeam.filter((m) => m.ident !== ourActive.ident);

  const moveEvals = [];
  for (const moveName of ourActive.moves) {
    const ev = evaluateMove(ourActive, moveName, theirTarget, theirTeam, stayProb, switchProbs, gen, field, calcOpts);
    if (ev) moveEvals.push(ev);
  }
  moveEvals.sort((a, b) => b.score - a.score);

  const switchEvals = bench
    .map((m) => evaluateSwitch(ourActive, m, theirTarget, gen, field, calcOpts))
    .filter(Boolean)
    .sort((a, b) => b.net - a.net);

  const bestMove = moveEvals[0] ?? null;
  const bestSwitch = switchEvals[0] ?? null;

  let switchTo = null;
  const moveIsWeak = !bestMove || bestMove.score < 30;
  const inDanger = (ourActive.hpPercent ?? 100) < 25;
  if (bestSwitch && bestSwitch.net > 12 && (moveIsWeak || inDanger)) {
    switchTo = { ident: bestSwitch.ident, species: bestSwitch.species, score: bestSwitch.net, note: bestSwitch.note };
  }
  if (!bestMove && bestSwitch) {
    switchTo = { ident: bestSwitch.ident, species: bestSwitch.species, score: bestSwitch.net, note: bestSwitch.note };
  }

  if (bestMove) {
    reasoning.push(bestMove.note);
    if (bestMove.ko) {
      reasoning.push(bestMove.koGuaranteed
        ? `The move guarantees a KO on ${theirTarget.species}.`
        : `The move can KO ${theirTarget.species} — worth the risk.`);
    }
  } else if (!switchTo) {
    reasoning.push('No usable moves are known — consider switching.');
  }

  if (switchTo) reasoning.push(switchTo.note);

  const unknown = theirTarget.moves?.length ?? 0;
  if (unknown < 4) {
    reasoning.push(`Their ${theirTarget.species} has ${unknown}/4 moves revealed — expect an unknown move.`);
  }
  if (ourActive.moves.length < 4) {
    reasoning.push(`Your ${ourActive.species} has ${ourActive.moves.length} moves known from this log.`);
  }

  return {
    bestMove: bestMove
      ? { move: bestMove.move, score: bestMove.score, note: bestMove.note, expected: bestMove.expected }
      : null,
    switchTo,
    reasoning: reasoning.slice(0, 6),
    note: null,
  };
}
