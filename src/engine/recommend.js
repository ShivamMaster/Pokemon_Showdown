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
//   - Status/setup/recovery moves get utility scores (0-50). Recovery value
//     scales with how much HP is actually missing — at (near) full HP, healing
//     is never recommended. Moves that are out of PP are skipped entirely.
//   - Switching is scored by how much less damage the candidate takes from
//     their active's best move than our current mon would, plus a small
//     offensive bonus. A switch is recommended when it clearly saves HP and
//     our current options are weak, we're in danger, or the switch is
//     decisively better than any move we have.
//
// The switch predictions (P stay / P switch-in) use profile data when
// available: profile.switchTendency.atLowHp and profile.commonSwitchIns
// (species -> weight). Without a profile, sensible defaults apply.

import { damagePercent, buildField, round1 } from './calc.js';
import { worstThreat, teamThreats } from './movepool.js';
import { speedOrder, speedLine } from './speed.js';

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

export function predictStayProb(theirActive, profile = null, justSwitched = false) {
  const hp = theirActive?.hpPercent ?? 100;
  let p;
  if (hp < 25) p = 0.35;
  else if (hp < 50) p = 0.6;
  else p = 0.8;
  // They just brought this mon in this turn — switching twice in a row is
  // rare and hands us a free hit, so treat it as a commitment regardless of
  // its HP. (This is why a move recommendation right after their switch
  // should target the new active, not their bench.)
  if (justSwitched) p = Math.max(p, 0.9);
  if (profile?.switchTendency?.atLowHp != null && hp < 40 && !justSwitched) {
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
  if (!team?.length) return null;
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

export function evaluateMove(attacker, moveName, theirTarget, theirTeam, stayProb, switchProbs, gen, field, calcOpts = {}, speed = null) {
  const vsTarget = damagePercent(gen, attacker, theirTarget, moveName, field, calcOpts);
  if (!vsTarget) return null;

  if (vsTarget.category === 'Status') {
    const util = utilityScore(moveName);
    if (!util) return null;
    // A status-inflicting move (Thunder Wave, Will-O-Wisp, Toxic, …) does
    // nothing if the target is already statused — never keep recommending it.
    if (STATUS_MOVES.has(moveName) && theirTarget?.status) return null;
    let value = util.value;
    let note = util.note;
    if (RECOVERY_MOVES.has(moveName)) {
      // Recovery is only worth something when HP is actually missing — at
      // (near) full HP, healing is pointless and shouldn't outrank attacks.
      const hp = attacker.hpPercent ?? 50; // unknown HP → neutral middle
      const missing = clamp01((100 - hp) / 100);
      value = util.value * clamp01(missing / 0.7); // full value at ≤30% HP
      if (value <= 0.03) return null; // ≥~96% HP: don't suggest healing
      note = `recovery (at ${hp}% HP${missing < 0.15 ? ' — near full, low value' : ''})`;
    }
    return {
      move: moveName,
      score: round1(value * 100),
      kind: 'status',
      note: `${moveName}: ${note} (utility ${Math.round(value * 100)}/100)`,
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

  // Speed-order awareness: going for the KO is much safer when we move first,
  // and much riskier when they outspeed us and can hit back before we act.
  let speedNote = null;
  if (speed) {
    if (speed.weMoveFirst === true && ko) {
      score += 8;
      speedNote = 'you outspeed — safe to go for the KO';
    } else if (speed.weMoveFirst === false) {
      const theirDmg = incomingPercent(theirTarget, attacker, gen, field, calcOpts).pct;
      const ourHp = attacker.hpPercent ?? 100;
      if (theirDmg >= ourHp) {
        score -= 12;
        speedNote = `they outspeed and can KO you first (~${round1(theirDmg)}%)`;
      } else if (theirDmg >= 40) {
        score -= 5;
        speedNote = `they outspeed — expect ~${round1(theirDmg)}% back before you move`;
      }
    }
  }

  const effText = effLabel(vsTarget.effectiveness);
  const seHits = benchDmg.filter((b) => b.eff >= 2).map((b) => b.ident.split(': ')[1]).slice(0, 2);
  const parts = [`~${vsTarget.mean}% vs ${theirTarget.species}`];
  if (effText) parts.push(effText);
  if (ko) parts.push(koGuaranteed ? 'guaranteed KO' : 'can KO');
  if (speedNote) parts.push(speedNote);
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

export function evaluateSwitch(ourActive, candidate, theirActive, gen, field, calcOpts = {}, speedCtx = null) {
  const now = incomingPercent(theirActive, ourActive, gen, field, calcOpts);
  const cand = incomingPercent(theirActive, candidate, gen, field, calcOpts);
  const candOff = ownBestDamage(candidate, theirActive, gen, field, calcOpts);
  // Early in a battle (or against any mon with unrevealed slots) their moves
  // are largely unknown — staying also risks the moves they *could* have.
  // Evaluate the switch against the full threat: the worst hidden move their
  // active could hit our CURRENT mon with, not just what's been shown.
  // Potential moves are a possibility, not a certainty, so they're discounted
  // (and only counted when genuinely threatening) — a speculative threat alone
  // shouldn't override a strong move like a 4× KO.
  const nowPot = worstThreat(theirActive, ourActive, gen, field, calcOpts);
  const potIn = nowPot && nowPot.pct >= 50 ? nowPot.pct * 0.6 : 0;
  const effectiveNow = Math.max(now.pct, potIn);
  let net = (effectiveNow - cand.pct) + candOff * 0.15;
  if (net <= 0) return null;
  const theirMove = now.move ?? cand.move ?? 'their moves';
  let note =
    `Switch to ${candidate.species}: takes ~${round1(cand.pct)}% from ${theirMove} ` +
    `(vs ~${round1(effectiveNow)}% for ${ourActive.species})` +
    (candOff ? `, hits back for ~${round1(candOff)}%` : '');
  if (nowPot && nowPot.pct > now.pct) {
    note += `; their ${theirActive?.species} could hit ${ourActive.species} with ${nowPot.move} (~${round1(nowPot.pct)}%)`;
  }

  // Speed awareness: an incoming mon that outspeeds their active gets to act
  // first (much safer); one that's outsped while taking heavy damage is risky.
  if (speedCtx?.state && theirActive) {
    const order = speedOrder(candidate, theirActive, speedCtx.state.gen ?? gen, speedCtx.state, speedCtx.ourSideId);
    if (order.weMoveFirst === true) {
      net += 5;
      note += `; ${candidate.species} outspeeds their ${theirActive.species} — moves first`;
    } else if (order.weMoveFirst === false && cand.pct >= 40) {
      net -= 8;
      note += `; but their ${theirActive.species} outspeeds ${candidate.species} — it hits first`;
    }
  }
  // The switch assessment only sees their revealed moves. If their species
  // could know a hidden move that mauls this candidate, penalize the switch
  // and say so — the decision should account for what they might have.
  const threat = worstThreat(theirActive, candidate, gen, field, calcOpts);
  if (threat && threat.pct >= 60) {
    net -= threat.pct >= 80 ? 10 : 5;
    note += `; but their ${theirActive?.species} could have ${threat.move} (~${round1(threat.pct)}%) — hidden`;
  }
  return {
    ident: candidate.ident,
    species: candidate.species,
    nowIn: round1(effectiveNow),
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
  const theirActive = activeMon(theirSide);

  // Battle hasn't started yet (team preview / just loaded in): both sides are
  // off the field, so there's no move or switch advice to give — the panel
  // should say so instead of guessing a switch-in against no target.
  if (!ourActive && !theirActive) {
    const teamKnown = ourSide?.pokemon?.length ?? 0;
    return {
      bestMove: null,
      switchTo: null,
      reasoning: [
        teamKnown
          ? 'Battle not started — team preview in progress.'
          : 'Waiting for the battle to start…',
      ],
      note: null,
    };
  }

  // Our active is down — must send in a replacement.
  if (!ourActive) {
    const s = bestSwitchIn(ourTeam, theirActive, gen, field, profile, calcOpts);
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
    // No one left to predict (their whole team is down) — nothing to advise.
    if (!theirTarget) {
      return {
        bestMove: null,
        switchTo: null,
        reasoning: ['All of their Pokémon are down — awaiting the win screen.'],
        note: null,
      };
    }
  } else {
    const justSwitched = !!theirTarget?.justSwitchedIn;
    stayProb = predictStayProb(theirTarget, profile, justSwitched);
    switchProbs = predictSwitchProbs(theirTarget, theirTeam, stayProb, profile);
    if (justSwitched) {
      reasoning.push(`They just brought in ${theirTarget.species} — expect them to keep it this turn.`);
    }
    // Speed ordering only makes sense against their actual active — against a
    // predicted switch-in the match-up could change entirely.
    reasoning.push(speedLine(ourActive, theirTarget, gen, state, ourSideId));
  }

  const bench = ourTeam.filter((m) => m.ident !== ourActive.ident);

  const moveEvals = [];
  const speed = speedOrder(ourActive, theirTarget, gen, state, ourSideId);
  for (const moveName of ourActive.moves) {
    // A move that's already out of PP can't be used — don't keep recommending it.
    const pp = ourActive.movePp?.[moveName];
    if (pp && pp.cur <= 0) {
      reasoning.push(`${moveName} is out of PP.`);
      continue;
    }
    const ev = evaluateMove(ourActive, moveName, theirTarget, theirTeam, stayProb, switchProbs, gen, field, calcOpts, speed);
    if (ev) moveEvals.push(ev);
  }
  moveEvals.sort((a, b) => b.score - a.score);

  const speedCtx = { state, ourSideId };
  const switchEvals = bench
    .map((m) => evaluateSwitch(ourActive, m, theirTarget, gen, field, calcOpts, speedCtx))
    .filter(Boolean)
    .sort((a, b) => b.net - a.net);

  const bestMove = moveEvals[0] ?? null;
  const bestSwitch = switchEvals[0] ?? null;

  let switchTo = null;
  const moveIsWeak = !bestMove || bestMove.score < 30;
  const inDanger = (ourActive.hpPercent ?? 100) < 25;
  const switchValue = bestSwitch?.net ?? 0;
  // Their active threatens us for a big chunk of HP every turn — a switch that
  // clearly reduces that is worth it even when our moves score okay.
  const threatened = (bestSwitch?.nowIn ?? 0) >= 45;
  // Recommend a switch when it clearly saves HP and our options are weak, we're
  // in danger, the switch is clearly better than anything we can do, or their
  // active is threatening our current mon hard.
  if (bestSwitch && switchValue > 12 && (moveIsWeak || inDanger || switchValue > 20 || threatened)) {
    switchTo = { ident: bestSwitch.ident, species: bestSwitch.species, score: switchValue, note: bestSwitch.note };
  }
  if (!bestMove && bestSwitch) {
    switchTo = { ident: bestSwitch.ident, species: bestSwitch.species, score: switchValue, note: bestSwitch.note };
  }
  // Status-setup pivot: a status move (Thunder Wave, Toxic, …) deals no
  // damage, so when it's our best option the real play is "inflict the status
  // this turn, then switch to the damage dealer next turn". Recommend the
  // switch as that follow-up whenever a worthwhile pivot exists.
  if (!switchTo && bestMove?.kind === 'status' && STATUS_MOVES.has(bestMove.move) && bestSwitch && bestSwitch.net > 5) {
    switchTo = {
      ident: bestSwitch.ident,
      species: bestSwitch.species,
      score: bestSwitch.net,
      note: `After ${bestMove.move} on ${theirTarget.species}, ${bestSwitch.note.replace(/^Switch to /, 'switch to ')}`,
    };
  }

  if (bestMove) {
    reasoning.push(bestMove.note);
    if (bestMove.ko) {
      reasoning.push(bestMove.koGuaranteed
        ? `The move guarantees a KO on ${theirTarget.species}.`
        : `The move can KO ${theirTarget.species} — worth the risk.`);
    }
    if (STATUS_MOVES.has(bestMove.move) && switchTo) {
      reasoning.push(`Set up ${bestMove.move} on ${theirTarget.species} this turn, then pivot to ${switchTo.species} next turn.`);
    }
  } else if (!switchTo) {
    reasoning.push('No usable moves are known — consider switching.');
  }

  if (switchTo) reasoning.push(switchTo.note);

  // Tera awareness.
  if (theirTarget?.terastallized) {
    reasoning.push(`Their ${theirTarget.species} is terastallized (tera ${theirTarget.teraType}) — effectiveness above accounts for it.`);
  }
  if (ourActive.canTera && ourActive.teraType && !ourActive.terastallized) {
    const tera = ourActive.teraType;
    const gains = [];
    if (bestMove && bestMove.kind === 'damage') {
      const dNow = bestMove.expected.mean;
      const dTera = damagePercent(gen, ourActive, theirTarget, bestMove.move, field, {
        ...calcOpts,
        attackerTera: tera,
      })?.mean;
      if (dTera != null && dTera > dNow + 8) {
        gains.push(`tera-${tera} boosts ${bestMove.move} ~${round1(dNow)}% → ~${round1(dTera)}%`);
      }
    }
    const inNow = incomingPercent(theirTarget, ourActive, gen, field, calcOpts).pct;
    const inTera = incomingPercent(theirTarget, ourActive, gen, field, { ...calcOpts, defenderTera: tera }).pct;
    if (inTera < inNow - 20) {
      gains.push(`tera-${tera} cuts incoming damage ~${round1(inNow)}% → ~${round1(inTera)}%`);
    }
    if (gains.length) {
      reasoning.push(`Consider terastallizing your ${ourActive.species} into ${tera}: ${gains.join('; ')}.`);
    }
  }

  // Hidden moves: the opponent's active may know something we haven't seen.
  const unknown = theirTarget?.moves?.length ?? 0;
  if (unknown < 4) {
    const threat = worstThreat(theirTarget, ourActive, gen, field, calcOpts);
    if (threat && threat.pct >= 25) {
      reasoning.push(`⚠ their ${theirTarget.species} could have ${threat.move} — it hits your ${ourActive.species} for ~${round1(threat.pct)}% (not yet revealed).`);
    } else {
      reasoning.push(`Their ${theirTarget.species} has ${unknown}/4 moves revealed — expect an unknown move.`);
    }
    const benchThreat = teamThreats(theirTarget, bench, gen, field, calcOpts, { top: 1, minPct: 30 });
    if (benchThreat.length && benchThreat[0].target !== ourActive.species) {
      reasoning.push(`Watch out: their ${theirTarget.species} could have ${benchThreat[0].move} — it hits your ${benchThreat[0].target} for ~${round1(benchThreat[0].pct)}%.`);
    }
  }
  if (ourActive.moves.length < 4) {
    reasoning.push(`Your ${ourActive.species} has ${ourActive.moves.length} moves known from this log.`);
  }

  // Confidence: how strongly this option is preferred over its alternative.
  // The best move's confidence is its share vs the runner-up move (100% when
  // it's the only option); the switch's confidence is its share vs using the
  // best move (100% when there is no move to compare against).
  let moveConfidence = 100;
  const runnerUp = moveEvals[1] ?? null;
  if (bestMove && runnerUp && runnerUp.score > 0) {
    moveConfidence = Math.round((bestMove.score / (bestMove.score + runnerUp.score)) * 100);
  }
  let switchConfidence = null;
  if (switchTo) {
    const alt = bestMove?.score ?? 0;
    const total = switchTo.score + alt;
    switchConfidence = total > 0 ? Math.round((switchTo.score / total) * 100) : 100;
  }

  return {
    bestMove: bestMove
      ? { move: bestMove.move, score: bestMove.score, note: bestMove.note, expected: bestMove.expected, confidence: moveConfidence }
      : null,
    switchTo: switchTo ? { ...switchTo, confidence: switchConfidence } : null,
    reasoning: reasoning.slice(0, 6),
    note: null,
  };
}
