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

import { SPECIES, MOVES } from '@smogon/calc';
import { damagePercent, buildField, fieldAfter, round1, effectivenessOf } from './calc.js';
import { worstThreat, teamThreats } from './movepool.js';
import { speedOrder, speedLine } from './speed.js';

const clamp01 = (n) => Math.max(0, Math.min(1, n));

// Weather/terrain-setting moves -> the field condition they set (canonical
// calc names, matching what buildField normalizes the reader's names to).
const WEATHER_MOVES = {
  'Rain Dance': 'Rain',
  'Sunny Day': 'Sun',
  Sandstorm: 'Sandstorm',
  Hail: 'Hail',
  Snowscape: 'Snow',
};
const TERRAIN_MOVES = {
  'Electric Terrain': 'Electric',
  'Grassy Terrain': 'Grassy',
  'Misty Terrain': 'Misty',
  'Psychic Terrain': 'Psychic',
};
// Abilities that summon a weather/terrain on switch-in (so a mon on their
// team can flip the field without using a move turn).
const WEATHER_ABILITIES = {
  Drought: 'Sun',
  Drizzle: 'Rain',
  'Sand Stream': 'Sandstorm',
  'Snow Warning': 'Snow',
};
const TERRAIN_ABILITIES = {
  'Electric Surge': 'Electric',
  'Grassy Surge': 'Grassy',
  'Misty Surge': 'Misty',
  'Psychic Surge': 'Psychic',
};
// Speed abilities that a weather/terrain would turn on — setting that field
// helps their holder, not just us.
const WEATHER_SPEED_ABILITIES = {
  'Swift Swim': 'Rain',
  Chlorophyll: 'Sun',
  'Sand Rush': 'Sandstorm',
  'Slush Rush': 'Snow',
};
const TERRAIN_SPEED_ABILITIES = {
  'Surge Surfer': 'Electric',
};

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

// ---------------------------------------------------------------------------
// Entry hazards (the reader records them in side.effects; the engine charges
// them on switch-in and values hazard removal by what's actually up)
// ---------------------------------------------------------------------------

function monTypes(gen, species) {
  return SPECIES[String(gen)]?.[species]?.types ?? [];
}

const SPIKES_PCT = [0, 12.5, 100 / 6, 25]; // layers -> % of max HP (1/8, 1/6, 1/4)

// % of max HP a mon loses to entry hazards when switching in onto `side`
// (Stealth Rock / Steelsurge by type effectiveness, Spikes by layer count).
export function hazardDamageOnEntry(mon, side, gen = 9) {
  if (!mon?.species || !side) return 0;
  const eff = side.effects ?? {};
  const types = monTypes(gen, mon.species);
  let pct = 0;
  if (eff['Stealth Rock']) pct += 12.5 * effectivenessOf(gen, 'Rock', types);
  if (eff['Steelsurge']) pct += 12.5 * effectivenessOf(gen, 'Steel', types);
  const spikes = Math.min(3, eff['Spikes'] ?? 0);
  if (spikes > 0) pct += SPIKES_PCT[spikes];
  return round1(pct);
}

// Non-damaging entry effects to warn about (Sticky Web slowdown, Toxic Spikes
// poisoning). Returns a human note or null. Damage is covered by
// hazardDamageOnEntry, so only the side effects are reported here.
export function entryHazardNotes(mon, side, gen = 9) {
  if (!mon?.species || !side) return null;
  const eff = side.effects ?? {};
  const types = monTypes(gen, mon.species);
  const grounded = !types.includes('Flying') && mon.ability !== 'Levitate';
  const notes = [];
  if (eff['Sticky Web'] && grounded) notes.push('slowed by Sticky Web on entry (Speed ×2/3)');
  const ts = eff['Toxic Spikes'] ?? 0;
  if (ts > 0) {
    if (types.includes('Poison')) notes.push('absorbs the Toxic Spikes (Poison type)');
    else if (grounded) notes.push('will get poisoned by Toxic Spikes on entry');
  }
  return notes.length ? notes.join('; ') : null;
}

// How many hazard layers are currently up on a side (what removal is worth).
export function hazardCount(side) {
  const eff = side?.effects ?? {};
  let n = 0;
  if (eff['Stealth Rock']) n += 1;
  if (eff['Steelsurge']) n += 1;
  n += eff['Spikes'] ?? 0;
  n += eff['Toxic Spikes'] ?? 0;
  if (eff['Sticky Web']) n += 1;
  return n;
}

// ---------------------------------------------------------------------------
// Residual damage (status chip, weather, Leftovers)
// ---------------------------------------------------------------------------

// Net % of max HP this mon gains (positive) or loses (negative) each turn to
// status chip, weather, terrain, and Leftovers. Burn/poison tick 1/16;
// sand/hail chip everything but the immune types; Grassy Terrain heals
// grounded mons 1/16; Leftovers heals 1/16.
export function chipPerTurn(mon, gen = 9, field = null) {
  if (!mon) return 0;
  let net = 0;
  if (mon.status === 'brn' || mon.status === 'psn') net -= 6.25;
  const weather = field?.weather;
  if (weather === 'Sandstorm' || weather === 'Hail' || weather === 'Snow') {
    const types = monTypes(gen, mon.species);
    const immune =
      weather === 'Sandstorm'
        ? types.includes('Rock') || types.includes('Ground') || types.includes('Steel')
        : types.includes('Ice');
    if (types.length && !immune) net -= 6.25;
  }
  // Grassy Terrain heals grounded mons (not Flying types, not Levitate).
  if (field?.terrain === 'Grassy') {
    const types = monTypes(gen, mon.species);
    const grounded = !types.includes('Flying') && mon.ability !== 'Levitate';
    if (grounded) net += 6.25;
  }
  if (mon.item === 'Leftovers' && !mon.itemConsumed) net += 6.25;
  return round1(net);
}

export function utilityScore(moveName, hazards = null) {
  if (RECOVERY_MOVES.has(moveName)) return { value: 0.5, note: 'recovery' };
  if (SETUP_MOVES.has(moveName)) return { value: 0.3, note: 'setup' };
  if (STATUS_MOVES.has(moveName)) return { value: 0.35, note: 'status' };
  // Weather/terrain moves: the base value is low — the real value is computed
  // per-battle in evaluateMove (the damage delta the new field unlocks, chip,
  // counter-weather). The utility here just lets them through the gate.
  if (WEATHER_MOVES[moveName]) return { value: 0.2, note: 'weather' };
  if (TERRAIN_MOVES[moveName]) return { value: 0.2, note: 'terrain' };
  if (HAZARD_MOVES.has(moveName)) return { value: 0.3, note: 'hazards' };
  if (PIVOT_MOVES.has(moveName)) return { value: 0.15, note: 'pivot' };
  if (moveName === 'Protect') return { value: 0.1, note: 'protect' };
  if (moveName === 'Substitute') return { value: 0.2, note: 'substitute' };
  // Hazard removal is only worth something when there are actually hazards to
  // remove — with a clean field it's a wasted turn, so it scores near zero.
  // Rapid Spin/Mortal Spin/Tidy Up clear OUR side; Defog clears both sides.
  if (moveName === 'Rapid Spin' || moveName === 'Mortal Spin' || moveName === 'Tidy Up') {
    const n = hazards?.ours ?? 0;
    const value = n > 0 ? 0.15 + 0.4 * Math.min(1, n / 3) : 0.06;
    return { value, note: n > 0 ? `hazard removal (${n} layer${n === 1 ? '' : 's'} on your side)` : 'hazard removal (nothing to remove yet)' };
  }
  if (moveName === 'Defog') {
    const total = (hazards?.ours ?? 0) + (hazards?.theirs ?? 0);
    const value = total > 0 ? 0.15 + 0.4 * Math.min(1, total / 3) : 0.06;
    return { value, note: total > 0 ? `hazard removal (${total} on the field)` : 'hazard removal (nothing to remove yet)' };
  }
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
// Threat-based switch prediction (the "double" read)
// ---------------------------------------------------------------------------

// Reweight the bench split of `switchProbs` by how well each bench mon
// answers the move we're about to use: a mon that resists or absorbs the move
// becomes the likely reactive switch-in (so clicking Earthquake should weight
// the incoming Landorus heavily), and one the move would wreck becomes less
// likely. The total switch probability is preserved — only the split among
// bench mons changes, so P(stay) is untouched.
export function moveConditionalSwitchProbs(moveName, switchProbs, theirTeam, gen, field, calcOpts = {}) {
  const total = Object.values(switchProbs ?? {}).reduce((a, b) => a + b, 0);
  if (total <= 0) return switchProbs ?? {};
  const moveType = MOVES[String(gen)]?.[moveName]?.type;
  if (!moveType) return switchProbs;
  const out = {};
  let weighted = 0;
  for (const m of theirTeam ?? []) {
    const base = switchProbs[m.ident] ?? 0;
    if (!base) continue;
    let factor = 1;
    if (m.species) {
      const eff = effectivenessOf(gen, moveType, monTypes(gen, m.species));
      factor =
        eff === 0 ? 3 : eff <= 0.25 ? 2.5 : eff <= 0.5 ? 2 : eff >= 4 ? 0.15 : eff >= 2 ? 0.35 : 1;
    }
    out[m.ident] = base * factor;
    weighted += out[m.ident];
  }
  if (weighted <= 0) return switchProbs;
  // Keep three decimals: rounding to one would crush small probabilities to
  // zero and drift the total off its original mass.
  const scale = total / weighted;
  for (const k of Object.keys(out)) out[k] = Math.round(out[k] * scale * 1000) / 1000;
  return out;
}

// ---------------------------------------------------------------------------
// Move evaluation
// ---------------------------------------------------------------------------

export function evaluateMove(attacker, moveName, theirTarget, theirTeam, stayProb, switchProbs, gen, field, calcOpts = {}, speed = null, hazards = null, risk = null) {
  const vsTarget = damagePercent(gen, attacker, theirTarget, moveName, field, calcOpts);
  if (!vsTarget) return null;

  if (vsTarget.category === 'Status') {
    const util = utilityScore(moveName, hazards);
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
      // Residual chip makes healing more valuable: a burned mon bleeding
      // 6.25%/turn needs the heal just to break even; Leftovers already
      // covers that job, so it doesn't inflate the score.
      const chip = chipPerTurn(attacker, gen, field);
      if (chip < 0) value *= 1 + Math.min(0.5, (-chip / 6.25) * 0.3);
      if (value <= 0.03) return null; // ≥~96% HP: don't suggest healing
      note = `recovery (at ${hp}% HP${missing < 0.15 ? ' — near full, low value' : ''}${chip < 0 ? `, bleeding ${round1(-chip)}%/turn` : ''})`;
    } else if (SETUP_MOVES.has(moveName)) {
      // Score setup by the sweep it unlocks: how much of their remaining team
      // dies after one boost. Setting up into a threat that KOs us is throwing
      // the turn away, so a deadly active deflates the value hard.
      const stages = SETUP_STAGES[moveName] ?? 1;
      const sweep = sweepPotential(attacker, theirTeam, gen, field, calcOpts, stages);
      const incoming = incomingPercent(theirTarget, attacker, gen, field, calcOpts).pct;
      const ourHp = attacker.hpPercent ?? 100;
      value = util.value + Math.min(0.45, sweep.score * 0.15);
      // Setting up into a threat that can KO us is usually a throw — but how
      // much that scares us depends on the mode: ahead, never risk the lead;
      // behind, the sweep is the comeback, so the risk is acceptable.
      const setupRisk = (risk ?? RISK_MODES.normal).setupRiskMult;
      // The KO is already on the table AND we're too low to afford the setup
      // turn: setting up would just hand them the free hit. Just take the KO.
      const finish = bestDamageMove(attacker, theirTarget, gen, field, calcOpts);
      const targetHp = theirTarget?.hpPercent ?? 100;
      if (finish && finish.max >= targetHp && ourHp < 45) {
        value *= 0.15;
        note = `setup: ${finish.move} already finishes ${theirTarget?.species} — just take the KO`;
      } else if (incoming >= ourHp) {
        value *= setupRisk;
        note = `setup: risky — their ${theirTarget?.species} can KO you (~${round1(incoming)}%) before the boost pays off`;
      } else if (ourHp < 45 && incoming * 2 >= ourHp) {
        // They 2HKO us while we're low: the boost needs a second turn to pay
        // off, and we don't have one. Same risk treatment as the 1HKO case.
        value *= setupRisk;
        note = `setup: risky — at ${round1(ourHp)}% HP their ${theirTarget?.species} finishes you (~${round1(incoming)}%/turn) before the boost pays off`;
      } else if (incoming >= 40) {
        value *= 0.7;
        note = `setup: boosted ${sweep.move} clears ${sweep.oneHko ? `${sweep.oneHko} and 2HKOs ${sweep.twoHko}` : sweep.twoHko ? `2HKOs ${sweep.twoHko}` : 'nothing'} of their team — but you take ~${round1(incoming)}% setting up`;
      } else {
        note = `setup: boosted ${sweep.move} 1HKOs ${sweep.oneHko}${sweep.twoHko ? ` / 2HKOs ${sweep.twoHko}` : ''} of their remaining team — worth a turn`;
      }
      if (sweep.score <= 0.5) value *= 0.7; // nothing left to sweep — setup is a waste
    } else if (WEATHER_MOVES[moveName] || TERRAIN_MOVES[moveName]) {
      // Weather/terrain moves: score by what the new field unlocks.
      const weather = WEATHER_MOVES[moveName] ?? null;
      const terrain = TERRAIN_MOVES[moveName] ?? null;
      // Setting a condition that's already up is a wasted turn — never
      // recommend it (mirrors the "already statused" status-move rule).
      const already = (weather && field?.weather === weather) || (terrain && field?.terrain === terrain);
      if (already) return null;
      const after = fieldAfter(field, { weather, terrain });
      const delta = fieldDamageDelta(attacker, theirTeam, gen, field, after, calcOpts);
      // The damage unlock is the core value: every ~10% of extra damage is
      // worth a meaningful chunk of the turn, capped so one big move can't
      // dominate.
      value = util.value + Math.min(0.5, delta.total * 0.04);
      const notes = [];
      // Counter-weather: replacing THEIR active weather with ours denies their
      // boosts (their Sun-boosted Fire moves stop, our Rain starts).
      const theirWeather = field?.weather ?? null;
      if (weather && theirWeather && weather !== theirWeather) {
        value += 0.12;
        notes.push(`replaces their ${theirWeather} (their boosts stop)`);
      }
      // Weather chip: Sandstorm/Hail/Snow tick their team every turn.
      if (weather === 'Sandstorm' || weather === 'Hail' || weather === 'Snow') {
        const chips = (theirTeam ?? []).filter((m) => chipPerTurn(m, gen, after) < 0).length;
        if (chips > 0) {
          value += Math.min(0.25, chips * 0.06);
          notes.push(`chips ${chips} of their team ~6%/turn`);
        }
      }
      // Grassy Terrain heals our grounded mons every turn.
      if (terrain === 'Grassy') {
        const heal = chipPerTurn(attacker, gen, after);
        if (heal > 0) {
          value += Math.min(0.15, heal * 0.015);
          notes.push(`heals you ~${round1(heal)}%/turn`);
        }
      }
      // Danger: does the new field help THEIR speed abusers too? Setting Rain
      // when their Swift Swim mon sits on the bench gives them the outspeed.
      const theirAbuser = (theirTeam ?? []).find((m) =>
        m.ability && (WEATHER_SPEED_ABILITIES[m.ability] === weather || TERRAIN_SPEED_ABILITIES[m.ability] === terrain)
      );
      if (theirAbuser) {
        value *= 0.6;
        notes.push(`but their ${theirAbuser.species}'s ${theirAbuser.ability} benefits from it too`);
      }
      // No real unlock and no counter/chip value — setting it is a dead turn.
      if (delta.total < 5 && !notes.length) return null;
      // Speed order shifts: the weather may turn on OUR speed abusers too.
      const ourAbuser = attacker.ability && (WEATHER_SPEED_ABILITIES[attacker.ability] === weather || TERRAIN_SPEED_ABILITIES[attacker.ability] === terrain);
      if (delta.best) {
        notes.push(`${delta.best.move} on ${delta.best.target}: ${delta.best.before}% → ${delta.best.after}%`);
      }
      if (ourAbuser) {
        notes.push(notes.length ? `+ activates your ${attacker.ability} (outspeed)` : `activates your ${attacker.ability} (outspeed)`);
      }
      note = notes.join('; ');
    }
    return {
      move: moveName,
      score: round1(value * 100),
      kind: 'status',
      note: `${moveName}: ${note} (utility ${Math.round(value * 100)}/100)`,
    };
  }

  const bench = theirTeam.filter((m) => m.ident !== theirTarget.ident);
  // The bench split of the switch probability is conditioned on THIS move: a
  // mon that walls it becomes the likely reactive switch-in (the "double"
  // read), one it wrecks becomes unlikely. P(stay) is unchanged.
  const benchProbs = moveConditionalSwitchProbs(moveName, switchProbs, theirTeam, gen, field, calcOpts);
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
    score += (benchProbs[b.ident] ?? 0) * capped;
  }

  // Residual chip (burn/poison/weather) finishes a low target off without
  // another hit — a hit that brings them into chip range is effectively a KO.
  // chip is negative for drains, so the effective HP is targetHp + chip
  // (healing like Leftovers only raises it and never helps a KO).
  const chip = chipPerTurn(theirTarget, gen, field);
  const effHp = targetHp + Math.min(0, chip);
  const ko = vsTarget.max >= effHp;
  const koGuaranteed = vsTarget.min >= effHp;
  // Risk-aware KO reward: safe mode prefers the guaranteed roll (a gamble on
  // a non-guaranteed KO could hand the lead back), aggressive mode prefers
  // the swing (the 60% roll that wins if it lands is the comeback play).
  const r = risk ?? RISK_MODES.normal;
  if (ko) score += r.koBonus(koGuaranteed);

  // Speed-order awareness: going for the KO is much safer when we move first,
  // and much riskier when they outspeed us and can hit back before we act.
  // How much that risk matters depends on the mode — when ahead we avoid the
  // bad trade, when behind we accept it to take the swing.
  let speedNote = null;
  if (speed) {
    if (speed.weMoveFirst === true && ko) {
      score += r.koFirstBonus;
      speedNote = 'you outspeed — safe to go for the KO';
    } else if (speed.weMoveFirst === false) {
      const theirDmg = incomingPercent(theirTarget, attacker, gen, field, calcOpts).pct;
      const ourHp = attacker.hpPercent ?? 100;
      if (theirDmg >= ourHp) {
        score -= r.koedFirstPenalty;
        speedNote = `they outspeed and can KO you first (~${round1(theirDmg)}%)`;
      } else if (theirDmg >= 40) {
        score -= r.outspeedHitPenalty;
        speedNote = `they outspeed — expect ~${round1(theirDmg)}% back before you move`;
      }
    }
  }

  const effText = effLabel(vsTarget.effectiveness);
  const seHits = benchDmg.filter((b) => b.eff >= 2).map((b) => b.ident.split(': ')[1]).slice(0, 2);
  const parts = [`~${vsTarget.mean}% vs ${theirTarget.species}`];
  if (effText) parts.push(effText);
  if (ko) parts.push(koGuaranteed ? 'guaranteed KO' : chip < 0 ? 'can KO (chip finishes it)' : 'can KO');
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

// Best damaging move `attacker` has against `target` (by mean damage), with
// its roll range — used to spot when a KO is already on the table (setting
// up would waste the turn) and when a switch-in is a KO threat.
export function bestDamageMove(attacker, target, gen, field, calcOpts) {
  let best = null;
  for (const moveName of attacker?.moves ?? []) {
    const d = damagePercent(gen, attacker, target, moveName, field, calcOpts);
    if (!d || d.category === 'Status' || d.max <= 0) continue;
    if (!best || d.mean > best.mean) best = d;
  }
  return best;
}

// Damage % their active threatens `target` with, counting the worst hidden
// move as well as revealed ones. Potential moves are a possibility, not a
// certainty, so they're discounted (and only counted when genuinely
// threatening) — a speculative threat alone shouldn't override a strong move.
// Used symmetrically for our current mon and every switch candidate, so a
// forced send-in never picks a mon their active could wreck unseen.
export function effectiveIncoming(theirActive, target, gen, field, calcOpts = {}) {
  const now = incomingPercent(theirActive, target, gen, field, calcOpts);
  const pot = worstThreat(theirActive, target, gen, field, calcOpts);
  const potIn = pot && pot.pct >= 50 ? pot.pct * 0.6 : 0;
  return Math.max(now.pct, potIn);
}

export function ownBestDamage(candidate, theirTarget, gen, field, calcOpts = {}) {
  let max = 0;
  for (const moveName of candidate?.moves ?? []) {
    const d = damagePercent(gen, candidate, theirTarget, moveName, field, calcOpts);
    if (d?.mean && d.mean > max) max = d.mean;
  }
  return max;
}

// Best revealed move of each side against the other's active, plus the
// strongest likely-hidden move their mon could hit us with (kept only when it
// genuinely threatens, ≥50%). This is the SINGLE source for both the matchup
// view's Damage row (panel.js) and the recommendation reasoning, so the two
// can never disagree.
export function matchupDamage(gen, ourMon, theirMon, field, calcOpts = {}) {
  const bestOf = (atkMon, defMon) => {
    let best = null;
    let zero = null;
    for (const moveName of atkMon?.moves ?? []) {
      const d = damagePercent(gen, atkMon, defMon, moveName, field, calcOpts);
      if (!d) continue;
      if (d.mean > 0) {
        if (!best || d.mean > best.pct) {
          best = { pct: d.mean, min: d.min, max: d.max, move: moveName, effectiveness: d.effectiveness };
        }
      } else if (!zero) {
        // Keep a 0-damage move (immune/resisted wall) as a fallback so a mon
        // that walls the opponent shows "takes ~0%" instead of "unknown".
        zero = { pct: 0, min: 0, max: 0, move: moveName, effectiveness: d.effectiveness };
      }
    }
    return best ?? zero;
  };
  const ours = bestOf(ourMon, theirMon);
  const theirs = bestOf(theirMon, ourMon);
  const hidden = worstThreat(theirMon, ourMon, gen, field, calcOpts);
  return {
    ours,
    theirs,
    theirHidden: hidden && hidden.pct >= 50 ? { move: hidden.move, pct: hidden.pct, max: hidden.max } : null,
  };
}

export function evaluateSwitch(ourActive, candidate, theirActive, gen, field, calcOpts = {}, speedCtx = null, ourSide = null, risk = null) {
  const now = incomingPercent(theirActive, ourActive, gen, field, calcOpts);
  const cand = incomingPercent(theirActive, candidate, gen, field, calcOpts);
  // Both sides of the comparison use the FULL threat — revealed moves plus
  // the worst discounted hidden move. Staying risks what they *could* have;
  // so does switching in, and a candidate that a hidden move mauls is exactly
  // the "sends in a Pokémon that is also weak" trap this guards against.
  const effectiveNow = effectiveIncoming(theirActive, ourActive, gen, field, calcOpts);
  const candEff = effectiveIncoming(theirActive, candidate, gen, field, calcOpts);
  const nowPot = worstThreat(theirActive, ourActive, gen, field, calcOpts);
  // Offense is capped at the target's remaining HP (overkill gets no credit)
  // and weighed against the hits the candidate will eat — a switch-in that
  // threatens a KO on their active is an offensive play, not just a wall. The
  // KO reward is mode-aware (safe only trusts a guaranteed roll, aggressive
  // swings for the risky one), so a fragile-but-deadly pick becomes viable
  // exactly when the mode says to take that risk.
  const off = bestDamageMove(candidate, theirActive, gen, field, calcOpts);
  const candOff = Math.min(off?.mean ?? 0, theirActive?.hpPercent ?? 100);
  const targetHp = theirActive?.hpPercent ?? 100;
  const candKo = !!off && off.max >= targetHp;
  const candKoGuaranteed = !!off && off.min >= targetHp;
  const r = risk ?? RISK_MODES.normal;
  const koReward = candKo ? r.koSwitch(candKoGuaranteed) : 0;
  // Entry hazards on OUR side hit the incoming mon before it acts — charge
  // them into the comparison, and they can flip an otherwise-good send-in.
  const hazardDmg = hazardDamageOnEntry(candidate, ourSide, gen);
  // A revealed move is certain; a hidden one is speculative (discounted 0.6×
  // in effectiveIncoming). A candidate weak to something they've already
  // SHOWN pays an extra penalty so certainty outweighs speculation — this is
  // what stops the engine sending in a mon their known coverage wrecks.
  const revealedPenalty = cand.pct >= 40 ? cand.pct * 0.3 : 0;
  let net = (effectiveNow - candEff) + candOff * 0.6 + koReward - hazardDmg - revealedPenalty;
  if (net <= 0) return null;
  const theirMove = now.move ?? cand.move ?? 'their moves';
  let note =
    `Switch to ${candidate.species}: takes ~${round1(cand.pct)}% from ${theirMove} ` +
    `(vs ~${round1(effectiveNow)}% for ${ourActive.species})` +
    (hazardDmg > 0 ? `, plus ~${round1(hazardDmg)}% to hazards on entry` : '') +
    (candOff ? `, hits back for ~${round1(candOff)}%` : '') +
    (candKo ? (candKoGuaranteed ? ' — guaranteed KO' : ' — can KO') : '');
  const entryNotes = entryHazardNotes(candidate, ourSide, gen);
  if (entryNotes) note += `; ${entryNotes}`;
  // When the revealed threat to the CANDIDATE isn't the same move already
  // named in the lead-in, call it out — it's the certain hit, not a guess.
  if (revealedPenalty > 0 && cand.move && cand.move !== theirMove) {
    note += `; their revealed ${cand.move} hits it for ~${round1(cand.pct)}%`;
  }
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
  // If their species could know a hidden move that mauls this candidate, say
  // so — the discounted threat already counts in the net, but the note makes
  // the risk visible.
  const threat = worstThreat(theirActive, candidate, gen, field, calcOpts);
  if (threat && threat.pct >= 60 && threat.pct * 0.6 > cand.pct) {
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

export function bestSwitchIn(ourTeam, theirActive, gen, field, profile = null, calcOpts = {}, ourSide = null) {
  let best = null;
  let bestScore = -Infinity;
  for (const candidate of ourTeam) {
    const cand = incomingPercent(theirActive, candidate, gen, field, calcOpts);
    // Offense capped at the target's remaining HP (overkill gets no credit),
    // with a bonus when the send-in is a KO threat. Incoming damage counts
    // revealed moves plus the discounted worst hidden move — at battle start
    // nothing is revealed, and this is what stops the engine from sending in
    // a mon their active could wreck. A candidate weak to a move they've
    // already SHOWN pays the same certainty penalty as the optional switch.
    const off = bestDamageMove(candidate, theirActive, gen, field, calcOpts);
    const candOff = Math.min(off?.mean ?? 0, theirActive?.hpPercent ?? 100);
    const targetHp = theirActive?.hpPercent ?? 100;
    const candKo = !!off && off.max >= targetHp;
    const candKoGuaranteed = !!off && off.min >= targetHp;
    const effIn = effectiveIncoming(theirActive, candidate, gen, field, calcOpts);
    // Entry hazards on our side hit every send-in before it acts.
    const hazardDmg = hazardDamageOnEntry(candidate, ourSide, gen);
    const revealedPenalty = cand.pct >= 40 ? cand.pct * 0.3 : 0;
    // A forced send-in has no move this turn, so the KO is the whole play —
    // a candidate that can finish their active gets the balanced-mode reward.
    const score = candOff + (candKo ? 13 : 0) - effIn - hazardDmg - revealedPenalty;
    if (score > bestScore) {
      bestScore = score;
      // Name the move behind the incoming number: the revealed best, or the
      // hidden worst when that's what actually threatens the candidate.
      const hidden = worstThreat(theirActive, candidate, gen, field, calcOpts);
      const threatName =
        hidden && hidden.pct >= 50 && hidden.pct * 0.6 > cand.pct
          ? `their ${theirActive?.species} could hit it with ${hidden.move} (~${round1(hidden.pct)}%)`
          : `their ${cand.move ?? 'moves'}`;
      best = {
        ident: candidate.ident,
        species: candidate.species,
        candIn: round1(effIn),
        candOff: round1(candOff),
        net: round1(score),
        note: `Send in ${candidate.species}: takes ~${round1(effIn)}% from ${threatName}` +
          `${hazardDmg > 0 ? `, plus ~${round1(hazardDmg)}% to hazards on entry` : ''}` +
          `${candOff ? `, hits back for ~${round1(candOff)}%` : ''}` +
          `${candKo ? (candKoGuaranteed ? ' — guaranteed KO' : ' — can KO') : ''}`,
      };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Risk modes (safe / normal / aggressive)
// ---------------------------------------------------------------------------

// How far ahead (in %-HP equivalents) we must be to play safe / aggressive.
const AHEAD_THRESHOLD = 100;
const BEHIND_THRESHOLD = -100;

// Board advantage in %-HP equivalents: each side's total remaining HP across
// alive mons plus a per-body bonus (an extra alive mon is worth a lot even at
// low HP — it can still take hits, threaten, and switch around).
export function boardAdvantage(ourTeam, theirTeam) {
  const value = (team) =>
    (team ?? []).reduce((sum, m) => sum + (m.hpPercent ?? 100), 0) + (team?.length ?? 0) * 40;
  return round1(value(ourTeam) - value(theirTeam));
}

// Per-mode scoring knobs. `normal` must exactly match the pre-risk behavior
// (that's what the existing tests pin down). The philosophy:
//   safe       — ahead, protect the lead: reward the guaranteed KO, punish
//                gambling on a risky roll or eating a big hit back; switch
//                more readily to keep the wincon safe.
//   aggressive — behind, take the swing: a non-guaranteed KO roll is worth
//                MORE than the sure thing (the 60% gamble that wins if it
//                lands); tolerate being outsped; only switch when it's
//                clearly right (switching bleeds tempo when behind).
export const RISK_MODES = {
  safe: {
    label: 'playing safe',
    koBonus: (guaranteed) => (guaranteed ? 14 : 6),
    koFirstBonus: 10,
    koedFirstPenalty: 16,
    outspeedHitPenalty: 8,
    setupRiskMult: 0.2,
    switchThreshold: 8,
    threatenedAt: 40,
    pivotGate: 3,
    // A switch-in that KOs their active is an offensive play, not a wall —
    // how much we value it depends on the mode. Safe: only a GUARANTEED KO
    // is worth risking the switch (a fragile roll could hand the lead back);
    // normal: a KO is a KO; aggressive: the swing that wins if it lands is
    // the comeback, prized above even the sure thing.
    koSwitch: (guaranteed) => (guaranteed ? 16 : 4),
  },
  normal: {
    label: 'balanced play',
    koBonus: () => 10,
    koFirstBonus: 8,
    koedFirstPenalty: 12,
    outspeedHitPenalty: 5,
    setupRiskMult: 0.35,
    switchThreshold: 12,
    threatenedAt: 45,
    pivotGate: 5,
    koSwitch: () => 13,
  },
  aggressive: {
    label: 'playing aggressive',
    koBonus: (guaranteed) => (guaranteed ? 12 : 13),
    koFirstBonus: 6,
    koedFirstPenalty: 6,
    outspeedHitPenalty: 2,
    setupRiskMult: 0.6,
    switchThreshold: 16,
    threatenedAt: 55,
    pivotGate: 8,
    // The swing that wins if it lands is the comeback — worth more than the
    // sure thing, which is just a KO like any other.
    koSwitch: (guaranteed) => (guaranteed ? 18 : 22),
  },
};

// 'auto' derives the mode from the board: clearly ahead → safe, clearly
// behind → aggressive, otherwise balanced. An explicit mode wins.
export function resolveRiskMode(opts = {}, advantage = 0) {
  const requested = opts.riskMode ?? 'auto';
  if (requested === 'safe' || requested === 'normal' || requested === 'aggressive') return requested;
  if (advantage >= AHEAD_THRESHOLD) return 'safe';
  if (advantage <= BEHIND_THRESHOLD) return 'aggressive';
  return 'normal';
}

// ---------------------------------------------------------------------------
// Win conditions & setup sweeps
// ---------------------------------------------------------------------------

// A mon's offensive value against the opposing team: expected damage per turn
// across every alive member, capped at each target's remaining HP (overkill
// doesn't count). The team's win condition is the mon with the most of it.
export function offensiveValue(mon, oppTeam, gen, field, calcOpts = {}) {
  if (!mon) return 0;
  let total = 0;
  for (const target of oppTeam ?? []) {
    let best = 0;
    for (const moveName of mon.moves ?? []) {
      const d = damagePercent(gen, mon, target, moveName, field, calcOpts);
      if (d?.mean && d.mean > best) best = d.mean;
    }
    total += Math.min(best, target.hpPercent ?? 100);
  }
  return round1(total);
}

export function teamWincon(team, oppTeam, gen, field, calcOpts = {}) {
  let best = null;
  let bestVal = -Infinity;
  for (const m of team ?? []) {
    const val = offensiveValue(m, oppTeam, gen, field, calcOpts);
    if (val > bestVal) {
      bestVal = val;
      best = m;
    }
  }
  return best ? { mon: best, value: bestVal } : null;
}

const SETUP_STAGES = { 'Tail Glow': 2, 'Shell Smash': 2 };

// How much better our best move gets against each of their mons when the field
// changes from `field` to `after` (e.g. setting Rain Dance or Grassy Terrain).
// Sums the capped gain per target (a move that already 1HKOs gains nothing);
// returns the total and the single biggest unlock (move + target + before/after)
// so the reasoning can name it.
export function fieldDamageDelta(attacker, theirTeam, gen, field, after, calcOpts = {}) {
  let total = 0;
  let best = null;
  for (const target of theirTeam ?? []) {
    const hp = target.hpPercent ?? 100;
    let bestBefore = 0;
    let bestAfter = 0;
    let bestMove = null;
    for (const moveName of attacker?.moves ?? []) {
      const d1 = damagePercent(gen, attacker, target, moveName, field, calcOpts);
      const d2 = damagePercent(gen, attacker, target, moveName, after, calcOpts);
      if (!d1 || !d2 || d1.category === 'Status') continue;
      const before = Math.min(d1.mean, hp);
      const afterDmg = Math.min(d2.mean, hp);
      if (before > bestBefore) bestBefore = before;
      if (afterDmg > bestAfter) {
        bestAfter = afterDmg;
        bestMove = moveName;
      }
    }
    const gain = Math.max(0, bestAfter - bestBefore);
    if (gain >= 0.5) {
      total += gain;
      if (!best || gain > best.gain) {
        best = {
          move: bestMove,
          target: target.species,
          before: round1(bestBefore),
          after: round1(bestAfter),
          gain: round1(gain),
        };
      }
    }
  }
  return { total: round1(total), best };
}

// How many opposing mons a boosted mon would 1HKO / 2HKO with its best move.
export function sweepPotential(mon, oppTeam, gen, field, calcOpts = {}, stages = 1) {
  let oneHko = 0;
  let twoHko = 0;
  let move = null;
  let bestDmg = 0;
  for (const target of oppTeam ?? []) {
    let best = 0;
    let bestName = null;
    for (const moveName of mon.moves ?? []) {
      if (damagePercent(gen, mon, target, moveName, field, calcOpts)?.category === 'Status') continue;
      const boosted = {
        ...mon,
        boosts: {
          ...(mon.boosts ?? {}),
          atk: (mon.boosts?.atk ?? 0) + stages,
          spa: (mon.boosts?.spa ?? 0) + stages,
        },
      };
      const d = damagePercent(gen, boosted, target, moveName, field, calcOpts);
      if (d?.mean && d.mean > best) {
        best = d.mean;
        bestName = moveName;
      }
    }
    const hp = target.hpPercent ?? 100;
    if (best >= hp) oneHko += 1;
    else if (best >= hp / 2) twoHko += 1;
    if (best > bestDmg) {
      bestDmg = best;
      move = bestName;
    }
  }
  return { oneHko, twoHko, score: round1(oneHko + twoHko * 0.5), move };
}

// ---------------------------------------------------------------------------
// Endgame lock-in logic
// ---------------------------------------------------------------------------

// Pairwise 1v1 verdicts once the battle is down to a few mons (≤4 alive
// total): who wins each duel given best moves, remaining HP, and speed order.
export function endgameLocks(ourTeam, theirTeam, gen, field, calcOpts = {}, state = null, ourSideId = 'p1') {
  if (!ourTeam?.length || !theirTeam?.length) return [];
  if (ourTeam.length + theirTeam.length > 4) return [];
  const out = [];
  for (const ours of ourTeam) {
    for (const theirs of theirTeam) {
      const ourDmg = ownBestDamage(ours, theirs, gen, field, calcOpts);
      const theirDmg = ownBestDamage(theirs, ours, gen, field, calcOpts);
      const ourHp = ours.hpPercent ?? 100;
      const theirHp = theirs.hpPercent ?? 100;
      const ourTurns = ourDmg > 0 ? Math.ceil(theirHp / ourDmg) : Infinity;
      const theirTurns = theirDmg > 0 ? Math.ceil(ourHp / theirDmg) : Infinity;
      const order = state ? speedOrder(ours, theirs, gen, state, ourSideId) : null;
      const weFirst = order?.weMoveFirst === true;
      let verdict;
      if (ourDmg <= 0 && theirDmg > 0) verdict = 'lose';
      else if (theirDmg <= 0 && ourDmg > 0) verdict = 'win';
      else if (ourTurns === Infinity && theirTurns === Infinity) verdict = 'stall';
      else if (ourTurns < theirTurns) verdict = 'win';
      else if (theirTurns < ourTurns) verdict = 'lose';
      else verdict = weFirst ? 'win' : 'close';
      out.push({
        ours: ours.species,
        theirs: theirs.species,
        ourTurns: ourTurns === Infinity ? null : ourTurns,
        theirTurns: theirTurns === Infinity ? null : theirTurns,
        weFirst,
        verdict,
      });
    }
  }
  return out;
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
  const hazards = { ours: hazardCount(ourSide), theirs: hazardCount(theirSide) };
  const ourTeam = alivePokemon(ourSide);
  const theirTeam = alivePokemon(theirSide);

  // Risk mode: who's ahead and how we should play it. The advantage is a
  // board read (total remaining HP + a per-body bonus), and the mode adapts
  // the scoring so we protect a lead or gamble for a comeback.
  const advantage = boardAdvantage(ourTeam, theirTeam);
  const riskMode = resolveRiskMode(opts, advantage);
  const risk = RISK_MODES[riskMode];

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
    const s = bestSwitchIn(ourTeam, theirActive, gen, field, profile, calcOpts, ourSide);
    return {
      bestMove: null,
      switchTo: s,
      reasoning: ['Your active Pokémon is down — send in a replacement.', ...(s ? [s.note] : [])],
      note: null,
    };
  }

  let theirTarget = activeMon(theirSide);
  // Their target may be a *predicted* switch-in (their active is down) —
  // damage claims about it are speculative, so those are skipped below.
  const targetIsPredicted = !theirActive;
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
  // We just brought our active in this turn — switching again right away would
  // hand them a free turn (and is the pivot ping-pong: switch A→B, then the
  // engine says switch back to A). Suppress switch advice in that window.
  const justBroughtIn = !!ourActive?.justSwitchedIn;
  // A mon that left the field this turn or the previous one is also off the
  // table as a switch target — sending it straight back in is the same
  // flip-flop. (Fainted mons are never candidates anyway.)
  const recentlyLeft = (m) => m.switchedOutTurn != null && state.turn - m.switchedOutTurn <= 1;

  // Choice lock: a mon holding a Choice item is stuck on its first move after
  // entering the field until it switches out — the other moves literally can't
  // be selected, so never recommend them.
  const ourLock = ourActive.lockedMove ?? null;
  if (ourLock) {
    reasoning.push(`Your ${ourActive.species} is locked into ${ourLock} by its ${ourActive.item ?? 'Choice item'} — the other moves can't be used until it switches out.`);
  }

  const moveEvals = [];
  const speed = speedOrder(ourActive, theirTarget, gen, state, ourSideId);
  for (const moveName of ourActive.moves) {
    if (ourLock && moveName !== ourLock) continue; // physically unselectable

    // A move that's already out of PP can't be used — don't keep recommending it.
    const pp = ourActive.movePp?.[moveName];
    if (pp && pp.cur <= 0) {
      reasoning.push(`${moveName} is out of PP.`);
      continue;
    }
    const ev = evaluateMove(ourActive, moveName, theirTarget, theirTeam, stayProb, switchProbs, gen, field, calcOpts, speed, hazards, risk);
    if (ev) moveEvals.push(ev);
  }
  moveEvals.sort((a, b) => b.score - a.score);

  const speedCtx = { state, ourSideId };
  let switchEvals = [];
  if (!justBroughtIn) {
    switchEvals = bench
      .filter((m) => !recentlyLeft(m))
      .map((m) => evaluateSwitch(ourActive, m, theirTarget, gen, field, calcOpts, speedCtx, ourSide, risk))
      .filter(Boolean)
      .sort((a, b) => b.net - a.net);
  } else {
    reasoning.push(`You just brought in ${ourActive.species} — switching again immediately would give them a free turn.`);
  }

  const bestMove = moveEvals[0] ?? null;
  const bestSwitch = switchEvals[0] ?? null;

  let switchTo = null;
  const moveIsWeak = !bestMove || bestMove.score < 30;
  const inDanger = (ourActive.hpPercent ?? 100) < 25;
  const switchValue = bestSwitch?.net ?? 0;
  // Their active threatens us for a big chunk of HP every turn — a switch that
  // clearly reduces that is worth it even when our moves score okay. The bar
  // depends on the mode: ahead we preserve the lead more eagerly (lower bar),
  // behind we avoid burning tempo on marginal switches (higher bar).
  const threatened = (bestSwitch?.nowIn ?? 0) >= risk.threatenedAt;
  // A status-wall best move (Thunder Wave, Toxic, …) is the setup for the
  // switch, not a reason to switch early — those route through the dedicated
  // pivot branch below so the advice reads "status this turn, then switch".
  const statusPivotMove = bestMove?.kind === 'status' && STATUS_MOVES.has(bestMove.move);
  // Recommend a switch when it clearly saves HP and our options are weak, we're
  // in danger, the switch is clearly better than anything we can do, or their
  // active is threatening our current mon hard.
  if (bestSwitch && !statusPivotMove && switchValue > risk.switchThreshold && (moveIsWeak || inDanger || switchValue > 20 || threatened)) {
    switchTo = { ident: bestSwitch.ident, species: bestSwitch.species, score: switchValue, note: bestSwitch.note };
  }
  if (!bestMove && bestSwitch) {
    switchTo = { ident: bestSwitch.ident, species: bestSwitch.species, score: switchValue, note: bestSwitch.note };
  }
  // Status-setup pivot: a status move (Thunder Wave, Toxic, …) deals no
  // damage, so when it's our best option the real play is "inflict the status
  // this turn, then switch to the damage dealer next turn". Recommend the
  // switch as that follow-up whenever a worthwhile pivot exists.
  if (!switchTo && bestMove?.kind === 'status' && STATUS_MOVES.has(bestMove.move) && bestSwitch && bestSwitch.net > risk.pivotGate) {
    switchTo = {
      ident: bestSwitch.ident,
      species: bestSwitch.species,
      score: bestSwitch.net,
      note: `After ${bestMove.move} on ${theirTarget.species}, ${bestSwitch.note.replace(/^Switch to /, 'switch to ')}`,
    };
  }

  // Endgame lock-in: with few mons left, call out the pairings that are
  // decided — the wins to take and the losses to avoid.
  const locks = endgameLocks(ourTeam, theirTeam, gen, field, calcOpts, state, ourSideId);
  if (locks.length) {
    const ourWins = locks.filter((l) => l.verdict === 'win');
    const theirWins = locks.filter((l) => l.verdict === 'lose');
    if (ourWins.length) {
      const w = ourWins[0];
      reasoning.push(
        `Endgame: your ${w.ours} beats their ${w.theirs} 1v1 (${w.ourTurns}HKO vs their ${w.theirTurns}HKO${w.weFirst ? ', you move first' : ''}) — locked in.`
      );
    }
    if (theirWins.length && !ourWins.some((w) => w.theirs === theirWins[0].theirs)) {
      const l = theirWins[0];
      reasoning.push(`Endgame: their ${l.theirs} beats your ${l.ours} 1v1 — avoid that pairing.`);
    }
  }
  // Win-condition read: who ends the game for each side.
  const theirWincon = teamWincon(theirTeam, ourTeam, gen, field, calcOpts);
  if (theirWincon) {
    const t = theirWincon.mon;
    if (t.ident === theirTarget?.ident) {
      reasoning.push(
        bestMove?.ko
          ? `Their ${t.species} is their win condition — this move can KO it, take the shot.`
          : `Their ${t.species} is their win condition — play around it.`
      );
    } else if (theirTeam.length <= 3) {
      reasoning.push(`Their ${t.species} is their win condition (threatens your team for ~${theirWincon.value}% total).`);
    }
  }
  const ourWincon = teamWincon(ourTeam, theirTeam, gen, field, calcOpts);
  if (ourWincon && ourWincon.mon.ident !== ourActive.ident && ourTeam.length > 1) {
    reasoning.push(`Your ${ourWincon.mon.species} is your win condition — keep it out of danger.`);
  }

  // Risk-mode callout: who's ahead, and how that shapes the recommendation.
  // Only worth a line when it actually changes how we play (not balanced).
  if (riskMode !== 'normal') {
    const advTxt = advantage >= 0 ? `+${Math.round(advantage)}` : String(Math.round(advantage));
    reasoning.push(
      riskMode === 'safe'
        ? `You're ahead (~${advTxt}% HP) — ${risk.label}: take the sure line, protect the lead.`
        : `You're behind (~${advTxt}% HP) — ${risk.label}: take the gamble that wins if it lands.`
    );
  }

  if (bestMove) {
    reasoning.push(bestMove.note);
    // A choice-locked opponent can only repeat its locked move (or switch) —
    // useful intel: expect that move again, don't hedge across their bench.
    if (theirTarget?.lockedMove) {
      reasoning.push(`Their ${theirTarget.species} is locked into ${theirTarget.lockedMove} by its ${theirTarget.item ?? 'Choice item'} — expect it to repeat that move.`);
    }
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

  // Their best revealed move's damage on us — the same number the matchup
  // view's Damage row shows (both come from matchupDamage), so the panel and
  // the reasoning always agree. Skipped against a predicted switch-in.
  if (!targetIsPredicted) {
    const dmg = matchupDamage(gen, ourActive, theirTarget, field, calcOpts);
    if (dmg.theirs && dmg.theirs.pct >= 25) {
      reasoning.push(`Their ${theirTarget.species} hits your ${ourActive.species} for ~${round1(dmg.theirs.pct)}% (${dmg.theirs.move}).`);
    }
  }

  // Weather/terrain anticipation: if their active (or bench) can flip the
  // field with a revealed move or a weather/terrain ability, say so — a
  // weather-dependent plan only holds until they change it.
  if (theirTarget) {
    const theirWeatherMove = (theirTarget.moves ?? []).find((m) => WEATHER_MOVES[m] || TERRAIN_MOVES[m]);
    if (theirWeatherMove) {
      const sets = WEATHER_MOVES[theirWeatherMove] ?? TERRAIN_MOVES[theirWeatherMove];
      const alreadyUp =
        (WEATHER_MOVES[theirWeatherMove] && field?.weather === sets) ||
        (TERRAIN_MOVES[theirWeatherMove] && field?.terrain === sets);
      if (!alreadyUp) {
        reasoning.push(`Their ${theirTarget.species} has ${theirWeatherMove} — the field could flip to ${sets} this turn.`);
      }
    }
    const theirAbility = theirTarget.ability ? (WEATHER_ABILITIES[theirTarget.ability] ?? TERRAIN_ABILITIES[theirTarget.ability]) : null;
    if (theirAbility) {
      const alreadyUp =
        WEATHER_ABILITIES[theirTarget.ability] != null
          ? field?.weather === theirAbility
          : field?.terrain === theirAbility;
      if (!alreadyUp) {
        reasoning.push(`Their ${theirTarget.species}'s ${theirTarget.ability} sets ${theirAbility} on switch-in — expect ${theirAbility}.`);
      }
    } else {
      // A bench mon with a weather ability is a switch-in warning too.
      const benchSetter = theirTeam.find(
        (m) => m.ability && (WEATHER_ABILITIES[m.ability] || TERRAIN_ABILITIES[m.ability])
      );
      if (benchSetter) {
        const ability = WEATHER_ABILITIES[benchSetter.ability] ?? TERRAIN_ABILITIES[benchSetter.ability];
        const alreadyUp =
          WEATHER_ABILITIES[benchSetter.ability] != null ? field?.weather === ability : field?.terrain === ability;
        if (!alreadyUp) {
          reasoning.push(`Their benched ${benchSetter.species} has ${benchSetter.ability} — it sets ${ability} when switched in.`);
        }
      }
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
    moveConfidence = Math.round(clamp01(bestMove.score / (bestMove.score + runnerUp.score)) * 100);
  }
  let switchConfidence = null;
  if (switchTo) {
    // The alternative is "use the best move". A move that scores negative is
    // worse than useless, so it can't inflate the switch's share past 100%.
    const alt = Math.max(0, bestMove?.score ?? 0);
    const total = switchTo.score + alt;
    switchConfidence = total > 0 ? Math.round(clamp01(switchTo.score / total) * 100) : 100;
  }

  return {
    bestMove: bestMove
      ? { move: bestMove.move, score: bestMove.score, note: bestMove.note, expected: bestMove.expected, confidence: moveConfidence }
      : null,
    switchTo: switchTo ? { ...switchTo, confidence: switchConfidence } : null,
    reasoning: reasoning.slice(0, 9),
    note: null,
    risk: { mode: riskMode, label: risk.label, advantage: Math.round(advantage) },
  };
}
