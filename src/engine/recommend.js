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

import { SPECIES, MOVES, Move } from '@smogon/calc';
import { damagePercent, buildField, fieldAfter, round1, effectivenessOf, inferOffensiveStat } from './calc.js';
import { worstThreat, expectedThreat, teamThreats, RECOVERY_MOVES } from './movepool.js';
import { positionalWinProb } from './position.js';
import { speedOrder, speedLine, movePriority } from './speed.js';

const clamp01 = (n) => Math.max(0, Math.min(1, n));

// Engine committee weights. Two shapes, one set of knobs:
//   blend — how each engine's vote scales into the move's final score
//           (the ranking). `calc` is the anchor (its 0-100 damage vote is
//           the base), so the other weights tune how much the supporting
//           engines move the needle relative to the damage read. All 1s =
//           the plain unweighted sum (the pre-committee behavior).
//   agree — how much each engine's independent vote counts toward the
//           confidence read (ties split half credit).
// The engines: calc (damage), ko (finishing reward), speed (order/priority
// risk), context (situational: items, chip, utility), response (the 2-ply
// read: what their best reply does to the resulting position). Missing keys
// default to 1 in the blend, so the tuning script's older 4-key configs
// stay valid — they implicitly weight the response engine at 1.
// The default was chosen by replaying a batch of real battles under
// different settings and keeping the one that matched what the players
// actually did most often (see scripts/tune-weights.js).
const ENGINE_WEIGHTS = {
  blend: { calc: 1, ko: 1, speed: 1, context: 1, response: 1 },
  agree: { calc: 3, ko: 2, speed: 1, context: 1, response: 1 },
};

// Share of engine weight that ranks move `a` above move `b` (ties split
// half credit). Returns 1 when every engine prefers `a`, ~0.5 when they
// disagree or tie, 0 when none do. `weights` defaults to the tuned set but
// is injectable so the tuning script can compare candidates.
export function engineAgreement(a, b, weights = ENGINE_WEIGHTS.agree) {
  let agree = 0;
  let total = 0;
  for (const [name, w] of Object.entries(weights)) {
    const av = a?.votes?.[name] ?? 0;
    const bv = b?.votes?.[name] ?? 0;
    total += w;
    if (av > bv) agree += w;
    else if (av === bv) agree += w / 2; // tie → half credit
  }
  return total > 0 ? agree / total : 0;
}

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
  // A healthy mon with a revealed setup move is staying to boost — pros set
  // up on the switch-in, and they didn't bring this mon out to leave.
  if (hp >= 50 && (theirActive?.moves ?? []).some((m) => SETUP_MOVES.has(m)) && !(theirActive.boosts?.atk || theirActive.boosts?.spa)) {
    p = Math.min(0.95, p + 0.1);
  }
  if (profile?.switchTendency?.atLowHp != null && hp < 40 && !justSwitched) {
    p = 1 - profile.switchTendency.atLowHp;
  }
  return Math.round(clamp01(p) * 100) / 100;
}

export function predictSwitchProbs(theirActive, theirTeam, stayProb, profile = null) {
  const bench = theirTeam.filter((m) => m.ident !== theirActive?.ident);
  if (!bench.length) return {};
  // Switch-in history dominates (it's the directly relevant behavior); lead
  // tendencies only fill in when there's no switch-in data for the bench.
  const switchIns = profile?.commonSwitchIns ?? {};
  const leads = profile?.commonLeads ?? {};
  const hasSwitchData = bench.some((m) => (switchIns[m.species] ?? 0) > 0);
  const weights = bench.map(
    (m) => (hasSwitchData ? switchIns[m.species] ?? 0 : leads[m.species] ?? 0) || 1
  );
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const probs = {};
  bench.forEach((m, i) => {
    probs[m.ident] = (1 - stayProb) * (weights[i] / total);
  });
  return probs;
}

export function mostLikelySwitchIn(team, profile = null) {
  if (!team?.length) return null;
  // Their common switch-ins are the best signal for a mid-battle replacement.
  // With no switch-in history at all, fall back to their habitual LEAD (the
  // species they open with most) — better than a coin flip when we have no
  // other evidence about who they bring in. Switch-ins dominate when present:
  // they're the directly relevant behavior, leads are only a proxy.
  const switchIns = profile?.commonSwitchIns ?? {};
  const leads = profile?.commonLeads ?? {};
  const hasSwitchData = team.some((m) => (switchIns[m.species] ?? 0) > 0);
  let best = team[0];
  let bestW = -1;
  for (const m of team) {
    const w = hasSwitchData ? switchIns[m.species] ?? 0 : leads[m.species] ?? 0;
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

export function evaluateMove(attacker, moveName, theirTarget, theirTeam, stayProb, switchProbs, gen, field, calcOpts = {}, speed = null, hazards = null, risk = null, weights = null) {
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
  // The status engine's whole vote lives in `context` (the utility value)
  // — it has no damage, KO, speed, or 2-ply response component, so the
  // committee sees a status move as "context engine only", which is exactly
  // right.
  votes: { calc: 0, ko: 0, speed: 0, context: Math.round(value * 100), response: 0 },
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
  // The engine committee: each independent engine votes on this move on its
  // own scale, and the final score is the blend. Keeping the votes lets the
  // confidence read be derived from how much the engines AGREE (see the
  // confidence block in recommend), not just from raw score share.
  //   calc    — the damage engine (@smogon/calc): expected damage vs the
  //             active + predicted switch-ins, capped at remaining HP.
  //   ko       — the KO engine: risk-aware reward for finishing the target.
  //   speed    — the speed/priority engine: KO-first safety, outspeed risk.
  //   context  — the situational engine: item plays, chip-finish, etc.
  //   response — the 2-ply engine: their best reply to this move and what
  //              the resulting position does to us (see the block below).
  const votes = { calc: 0, ko: 0, speed: 0, context: 0, response: 0 };
  votes.calc = stayProb * cappedActive;
  for (const b of benchDmg) {
    const capped = Math.min(b.dmg, b.dmg > 0 ? (theirTeam.find((m) => m.ident === b.ident)?.hpPercent ?? 100) : 0);
    votes.calc += (benchProbs[b.ident] ?? 0) * capped;
  }

  // Residual chip (burn/poison/weather) finishes a low target off without
  // another hit — a hit that brings them into chip range is effectively a KO.
  // chip is negative for drains, so the effective HP is targetHp + chip
  // (healing like Leftovers only raises it and never helps a KO).
  const chip = chipPerTurn(theirTarget, gen, field);
  const effHp = targetHp + Math.min(0, chip);
  let ko = vsTarget.max >= effHp;
  let koGuaranteed = vsTarget.min >= effHp;
  // Item-condition plays: a revealed, unconsumed item on their active changes
  // what a hit actually accomplishes.
  const theirItem = theirTarget.itemRevealed && !theirTarget.itemConsumed ? theirTarget.item : null;
  // Focus Sash: at full HP, the first hit always leaves them at 1 HP — a
  // "KO" is really "survives on the Sash". The damage still lands, but the
  // KO (and its reward) don't exist, and the chip the hit applies is capped
  // at leaving them alive.
  const sashAlive = theirItem === 'Focus Sash' && (theirTarget.hpPercent ?? 100) >= 99;
  if (sashAlive) {
    ko = false;
    koGuaranteed = false;
  }
  // Weakness Policy: clicking a super-effective move on a revealed WP holder
  // hands them +2 Atk/SpA (unless the move KOs them — a faint can't boost).
  // The boosted counter is priced into the move's score so the "click the SE
  // move" read doesn't blindly feed their WP.
  const wpTrigger = theirItem === 'Weakness Policy' && vsTarget.effectiveness >= 2 && !ko;
  let wpPenalty = 0;
  let wpNote = null;
  if (wpTrigger) {
    const boosted = {
      ...theirTarget,
      boosts: {
        ...(theirTarget.boosts ?? {}),
        atk: (theirTarget.boosts?.atk ?? 0) + 2,
        spa: (theirTarget.boosts?.spa ?? 0) + 2,
      },
    };
    const boostedIn = incomingPercent(boosted, attacker, gen, field, calcOpts).pct;
    const nowIn = incomingPercent(theirTarget, attacker, gen, field, calcOpts).pct;
    if (boostedIn > nowIn) {
      wpPenalty = Math.min(10, (boostedIn - nowIn) * 0.2);
      wpNote = `⚠ ${moveName} triggers their Weakness Policy — their ${theirTarget.species} gets +2 and hits for ~${round1(boostedIn)}%`;
    }
  }
  votes.context -= wpPenalty;
  // Risk-aware KO reward: safe mode prefers the guaranteed roll (a gamble on
  // a non-guaranteed KO could hand the lead back), aggressive mode prefers
  // the swing (the 60% roll that wins if it lands is the comeback play).
  const r = risk ?? RISK_MODES.normal;
  if (ko) votes.ko += r.koBonus(koGuaranteed);

  // Speed-order awareness: going for the KO is much safer when we move first,
  // and much riskier when they outspeed us and can hit back before we act.
  // How much that risk matters depends on the mode — when ahead we avoid the
  // bad trade, when behind we accept it to take the swing.
  // Priority beats Speed: if their active holds a revealed priority move that
  // can KO us, "we outspeed" doesn't save the KO — they strike first. And a
  // priority move of OUR OWN lands its KO even when they're faster. Both
  // override the plain Speed read below.
  const ourPrio = movePriority(gen, moveName, field);
  const theirPrio = bestPriorityMove(theirTarget, attacker, gen, field, calcOpts);
  const ourHp = attacker.hpPercent ?? 100;
  const theirPrioKO = !!theirPrio && theirPrio.max >= ourHp;
  let speedNote = null;
  if (speed) {
    if (speed.weMoveFirst === true && ko) {
      // We're faster — the KO is safe unless their priority move jumps the
      // queue and finishes us first.
      if (theirPrioKO && ourPrio < theirPrio.priority) {
        votes.speed -= r.koedFirstPenalty;
        speedNote = `you outspeed, but their ${theirPrio.move} can KO you first (priority)`;
      } else {
        votes.speed += r.koFirstBonus;
        speedNote = 'you outspeed — safe to go for the KO';
      }
    } else if (speed.weMoveFirst === false) {
      const theirDmg = incomingPercent(theirTarget, attacker, gen, field, calcOpts).pct;
      // Our priority move strikes before their Speed advantage — the KO lands.
      if (ko && ourPrio > 0 && ourPrio >= (theirPrio?.priority ?? 1)) {
        votes.speed += r.koFirstBonus;
        speedNote = `they outspeed you, but ${moveName} has priority — you strike first`;
      } else if (theirPrioKO) {
        votes.speed -= r.koedFirstPenalty;
        speedNote = `their ${theirPrio.move} can KO you first (priority beats Speed)`;
      } else if (theirDmg >= ourHp) {
        votes.speed -= r.koedFirstPenalty;
        speedNote = `they outspeed and can KO you first (~${round1(theirDmg)}%)`;
      } else if (theirDmg >= 40) {
        votes.speed -= r.outspeedHitPenalty;
        speedNote = `they outspeed — expect ~${round1(theirDmg)}% back before you move`;
      }
    } else if (theirPrioKO) {
      // Speed is a toss-up, but their priority move isn't: it acts first
      // either way and can finish us.
      votes.speed -= r.koedFirstPenalty;
      speedNote = `their ${theirPrio.move} can KO you first (priority)`;
    }
  }

  // 2-ply response engine: what does their BEST reply to this move do to the
  // resulting position? A one-ply engine scores "how good is this hit"; the
  // response engine looks at the turn after. Two branches:
  //   KO      — they send in their most likely replacement. If it threatens
  //             us hard, the KO "brings in a counter" (a KO into a bad spot
  //             is worth less than a clean one); if our next hit beats it,
  //             the KO sets up a favorable position (bonus).
  //   no KO   — their active survives. If it KOs us back, the move is a
  //             losing trade even when we move first; if it sets up, we just
  //             handed them the sweep; if it can't punish us, we're free.
  // Scale is context-sized (±9) so the read nudges close calls without
  // overpowering the damage anchor.
  const theirIncoming = incomingPercent(theirTarget, attacker, gen, field, calcOpts).pct;
  let response = 0;
  let responseNote = null;
  if (ko) {
    // Their most likely replacement: the bench mon with the highest switch
    // probability (the conditional split after a KO), falling back to the
    // first bench mon when no probabilities are known.
    const replacement =
      bench.reduce((best, m) => {
        const wp = switchProbs[m.ident] ?? 0;
        return !best || wp > (switchProbs[best.ident] ?? 0) ? m : best;
      }, null) ?? bench[0];
    if (replacement) {
      // expectedIncoming returns the % directly (a number), unlike
      // incomingPercent's { pct } shape.
      const repThreat = expectedIncoming(replacement, attacker, gen, field, calcOpts);
      if (repThreat >= 50) {
        response -= Math.min(8, (repThreat - 50) * 0.12);
        responseNote = `brings in ${replacement.species} which threatens you ~${round1(repThreat)}%`;
      }
      const ourHit = bestDamageMove(attacker, replacement, gen, field, calcOpts);
      if (ourHit && (ourHit.effectiveness >= 2 || ourHit.mean >= 60)) {
        response += Math.min(4, ourHit.mean * 0.05);
        responseNote = responseNote
          ? `${responseNote} · but ${ourHit.move} beats it (~${round1(ourHit.mean)}%)`
          : `and ${ourHit.move} beats the likely ${replacement.species} (~${round1(ourHit.mean)}%)`;
      }
    }
  } else {
    const theirSetupMove = (theirTarget.moves ?? []).find((m) => SETUP_MOVES.has(m));
    const alreadyBoosted = (theirTarget.boosts?.atk ?? 0) >= 1 || (theirTarget.boosts?.spa ?? 0) >= 1;
    if (theirIncoming >= ourHp) {
      response -= Math.min(9, 4 + (theirIncoming - ourHp) * 0.15);
      responseNote = `it survives and KOs you back (~${round1(theirIncoming)}%)`;
    } else if (theirSetupMove && !alreadyBoosted) {
      // Setting up into a mon that survives is handing them the sweep — the
      // "KO it NOW before it sets up" warning, priced into the move.
      response -= 6;
      responseNote = `it survives and sets up (${theirSetupMove} revealed)`;
    } else if ((theirTarget.moves?.length ?? 0) > 0 && theirIncoming < 25) {
      // Only claimed when they've shown enough to justify it — an unrevealed
      // mon could still be hiding a nuke.
      response += 3;
      responseNote = `they can't punish it (~${round1(theirIncoming)}% back)`;
    }
  }
  votes.response = response;

  const effText = effLabel(vsTarget.effectiveness);
  const seHits = benchDmg.filter((b) => b.eff >= 2).map((b) => b.ident.split(': ')[1]).slice(0, 2);
  const parts = [`~${vsTarget.mean}% vs ${theirTarget.species}`];
  if (effText) parts.push(effText);
  // Foul Play runs off the TARGET's Attack — the calc already prices that in
  // (the defender's Atk feeds the damage), but the note makes the read
  // explicit: it's a physical-attacker answer, weak against special walls.
  if (moveName === 'Foul Play') parts.push('uses their Attack');
  if (sashAlive) parts.push('their Focus Sash survives it (1 HP) — chip it first');
  if (ko) parts.push(koGuaranteed ? 'guaranteed KO' : chip < 0 ? 'can KO (chip finishes it)' : 'can KO');
  if (speedNote) parts.push(speedNote);
  if (wpNote) parts.push(wpNote);
  if (responseNote) parts.push(responseNote);
  if (seHits.length) parts.push(`also hits ${seHits.join(', ')} super effectively`);
  const note = `${moveName}: ${parts.join(' · ')}`;
  // The committee blend: each engine's vote scales into the final score by
  // its weight. `calc` is the anchor (its 0-100 damage vote is the base), so
  // a weight >1 on a supporting engine amplifies its say and <1 dampens it.
  // Weights default to all-1s (the plain unweighted sum).
  const w = weights?.blend ?? null;
  const score = w
    ? votes.calc +
      (w.ko ?? 1) * votes.ko +
      (w.speed ?? 1) * votes.speed +
      (w.context ?? 1) * votes.context +
      (w.response ?? 1) * votes.response
    : votes.calc + votes.ko + votes.speed + votes.context + votes.response;

  return {
    move: moveName,
    score: round1(score),
    kind: 'damage',
    ko,
    koGuaranteed,
    expected: { min: vsTarget.min, max: vsTarget.max, mean: vsTarget.mean, effectiveness: vsTarget.effectiveness },
    note,
    votes: {
      calc: round1(votes.calc),
      ko: round1(votes.ko),
      speed: round1(votes.speed),
      context: round1(votes.context),
      response: round1(votes.response),
    },
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

// The strongest revealed priority move `mon` has against `target` (highest
// mean damage), or null when it has none. Priority moves act before normal
// ones regardless of Speed — so a revealed Aqua Jet/Sucker Punch/Extreme
// Speed on their active means an "outspeeding" KO call is NOT safe, and a
// priority move of ours can steal a KO we'd otherwise lose to their Speed.
// Field-aware (Grassy Glide only counts on Grassy Terrain).
export function bestPriorityMove(mon, target, gen, field, calcOpts = {}) {
  if (!mon?.moves?.length || !target?.species) return null;
  let best = null;
  for (const moveName of mon.moves) {
    const prio = movePriority(gen, moveName, field);
    if (prio <= 0) continue;
    const d = damagePercent(gen, mon, target, moveName, field, calcOpts);
    if (!d || d.category === 'Status' || d.max <= 0) continue;
    if (!best || d.mean > best.pct) {
      best = { move: moveName, pct: d.mean, max: d.max, priority: prio };
    }
  }
  return best;
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

// Usage-weighted EXPECTED incoming damage % (revealed best + hidden EV), for
// scoring nets. Unlike effectiveIncoming (the worst-case risk floor), this
// prices hidden moves by how likely they actually are — a 2%-usage theorymon
// coverage nuke stops outweighing the moves the species really runs, so
// switches/moves into mons with known sets stop being over-penalized. The
// worst case stays the floor for gates and warnings (effectiveIncoming /
// worstThreat); this is the honest EV read for ranking.
export function expectedIncoming(theirActive, target, gen, field, calcOpts = {}) {
  const now = incomingPercent(theirActive, target, gen, field, calcOpts);
  const ev = expectedThreat(theirActive, target, gen, field, calcOpts);
  return Math.max(now.pct, ev?.pct ?? 0);
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

  // Item-condition plays: annotate when an item changes what a hit
  // accomplishes. These show in the matchup Damage row so the player
  // sees them at a glance, not buried in the reasoning.
  const notes = [];
  // Our hit vs their Focus Sash: at full HP, the Sash eats the KO.
  if (ours && theirs) {
    const theirItem = theirMon.itemRevealed && !theirMon.itemConsumed ? theirMon.item : null;
    const theirHp = theirMon.hpPercent ?? 100;
    if (theirItem === 'Focus Sash' && ours.max >= theirHp && theirHp >= 99) {
      notes.push({ side: 'us', text: `their Focus Sash survives it`, kind: 'sash' });
    }
    // Our SE hit triggers their Weakness Policy: price in the +2 counter.
    if (theirItem === 'Weakness Policy' && ours.effectiveness >= 2 && ours.max < theirHp) {
      notes.push({ side: 'us', text: `triggers their Weakness Policy (+2)`, kind: 'wp' });
    }
  }
  // Their hit vs our Focus Sash: same mirror for their side.
  if (theirs) {
    const ourItem = ourMon.itemRevealed && !ourMon.itemConsumed ? ourMon.item : null;
    const ourHp = ourMon.hpPercent ?? 100;
    if (ourItem === 'Focus Sash' && theirs.max >= ourHp && ourHp >= 99) {
      notes.push({ side: 'them', text: `your Focus Sash survives it`, kind: 'sash' });
    }
    if (ourItem === 'Weakness Policy' && theirs.effectiveness >= 2 && theirs.max < ourHp) {
      notes.push({ side: 'them', text: `triggers your Weakness Policy (+2)`, kind: 'wp' });
    }
  }

  return {
    ours,
    theirs,
    theirHidden: hidden && hidden.pct >= 50 ? { move: hidden.move, pct: hidden.pct, max: hidden.max } : null,
    notes: notes.length ? notes : null,
  };
}

export function evaluateSwitch(ourActive, candidate, theirActive, gen, field, calcOpts = {}, speedCtx = null, ourSide = null, risk = null) {
  const now = incomingPercent(theirActive, ourActive, gen, field, calcOpts);
  const cand = incomingPercent(theirActive, candidate, gen, field, calcOpts);
  // Both sides of the comparison use the FULL threat — revealed moves plus
  // the worst discounted hidden move. Staying risks what they *could* have;
  // so does switching in, and a candidate that a hidden move mauls is exactly
  // the "sends in a Pokémon that is also weak" trap this guards against.
  // The worst-case read (effectiveIncoming) drives the defense-first gate
  // below — the risk floor. The net itself prices hidden moves by their
  // usage-weighted EXPECTED damage (expectedIncoming), so a candidate only
  // threatened by a 2%-usage theorymon coverage nuke isn't over-penalized
  // when the species' real sets are known.
  const effectiveNow = effectiveIncoming(theirActive, ourActive, gen, field, calcOpts);
  const candEff = effectiveIncoming(theirActive, candidate, gen, field, calcOpts);
  const evNow = expectedIncoming(theirActive, ourActive, gen, field, calcOpts);
  const evCand = expectedIncoming(theirActive, candidate, gen, field, calcOpts);
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
  // A candidate that threatens a KO is exempt: the defense-first rule already
  // carves out the KO trade ("only a KO justifies the trade"), so charging
  // the certainty penalty on top would double-count the punishment for a
  // case the design has already decided is acceptable.
  const revealedPenalty = cand.pct >= 40 && !candKo ? cand.pct * 0.3 : 0;
  // Defense-first rule: if the candidate's TOTAL exposure (revealed best +
  // discounted hidden worst) is meaningfully worse than our current mon's
  // AND genuinely threatening, the switch makes the matchup worse — the
  // offense bonus can't paper over that. Only a KO threat justifies trading
  // into a worse position (the KO reward below still carries the swing); a
  // non-KO switch into a worse matchup is exactly the "sends in a mon their
  // coverage wrecks" trap this stops, even when the candidate hits back hard.
  // (A small regression — taking 8% more while hitting back for 80% — is a
  // fine trade, not this bug.)
  const worseMatchup = candEff > effectiveNow + 5 && candEff >= 40;
  let offCredit = candOff * 0.6;
  if (worseMatchup && !candKo) offCredit = 0;
  // The net trades on the expected (usage-weighted) incoming damage; the gate
  // above stays on the worst case so the defense-first rule never weakens.
  let net = (evNow - evCand) + offCredit + koReward - hazardDmg - revealedPenalty;
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
  if (worseMatchup && candKo) {
    note += `; their ${cand.move ?? 'moves'} hit ${candidate.species} harder than ${ourActive.species} (~${round1(cand.pct)}%) — only the KO justifies the trade`;
  } else if (worseMatchup) {
    note += `; but their ${theirMove} hits ${candidate.species} harder than ${ourActive.species} (~${round1(cand.pct)}%) — this switch loses the matchup`;
  }

  // Their active is a setup threat: a revealed setup move it hasn't used yet
  // means switching hands it the free turn it needs to boost. If the
  // candidate can't even wall the CURRENT threat (still eating a big hit),
  // the switch just delays the sweep — nudge it down.
  const theirSetupMove = (theirActive?.moves ?? []).find((m) => SETUP_MOVES.has(m));
  if (theirSetupMove && !(theirActive?.boosts?.atk || theirActive?.boosts?.spa)) {
    if (cand.pct >= 40) {
      net -= 4;
      note += `; their ${theirActive.species} has ${theirSetupMove} — switching gives it a free turn to set up`;
    }
  }

  // Speed awareness: an incoming mon that outspeeds their active gets to act
  // first (much safer); one that's outsped while taking heavy damage is risky.
  // Priority overrides the speed read entirely: their revealed priority move
  // can pick the candidate off before it acts no matter how fast it is, and
  // the candidate's own priority move can steal the KO when outsped.
  if (speedCtx?.state && theirActive) {
    const theirPrio = bestPriorityMove(theirActive, candidate, gen, field, calcOpts);
    const candPrio = bestPriorityMove(candidate, theirActive, gen, field, calcOpts);
    const candHp = candidate.hpPercent ?? 100;
    const theirPrioKo = theirPrio && theirPrio.max >= candHp;
    const candPrioKo = candPrio && candPrio.max >= (theirActive?.hpPercent ?? 100);
    const order = speedOrder(candidate, theirActive, speedCtx.state.gen ?? gen, speedCtx.state, speedCtx.ourSideId);
    if (theirPrioKo) {
      net -= 8;
      note += `; but their ${theirActive.species}'s ${theirPrio.move} can KO ${candidate.species} before it acts (priority)`;
    } else if (candPrioKo) {
      net += 5;
      note += `; ${candidate.species}'s ${candPrio.move} can KO their ${theirActive.species} first (priority)`;
    } else if (order.weMoveFirst === true) {
      net += 5;
      note += `; ${candidate.species} outspeeds their ${theirActive.species} — moves first`;
    } else if (order.weMoveFirst === false && cand.pct >= 40) {
      net -= 8;
      note += `; but their ${theirActive.species} outspeeds ${candidate.species} — it hits first`;
    } else if (theirPrio && theirPrio.pct >= 40) {
      net -= 6;
      note += `; their ${theirActive.species}'s ${theirPrio.move} hits ${candidate.species} for ~${round1(theirPrio.pct)}% before it acts (priority)`;
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
    const evIn = expectedIncoming(theirActive, candidate, gen, field, calcOpts);
    // Entry hazards on our side hit every send-in before it acts.
    const hazardDmg = hazardDamageOnEntry(candidate, ourSide, gen);
    // Same KO exemption as the optional switch: a candidate that threatens a
    // KO is already allowed through the defense-first gate, so charging the
    // certainty penalty on top would double-count (see evaluateSwitch).
    const revealedPenalty = cand.pct >= 40 && !candKo ? cand.pct * 0.3 : 0;
    // Defense-first gate (forced send-in mirror of the optional switch): with
    // no current mon to compare against, the rule is absolute — a candidate
    // whose TOTAL exposure is genuinely threatening (≥40%, shown + hidden) is
    // trading into a bad matchup, and the offense bonus can't paper over that
    // unless it threatens a KO (the KO reward below still carries the swing).
    // Otherwise the offense credit is zeroed, so the safest send-in wins.
    // (Gate on the worst case; the net below prices the EXPECTED hidden
    // damage, so a candidate threatened only by theorymon isn't tanked.)
    const threatened = effIn >= 40;
    let offCredit = candOff;
    if (threatened && !candKo) offCredit = 0;
    // A forced send-in has no move this turn, so the KO is the whole play —
    // a candidate that can finish their active gets the balanced-mode reward.
    const score = offCredit + (candKo ? 13 : 0) - evIn - hazardDmg - revealedPenalty;
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
        candOff: round1(offCredit),
        net: round1(score),
        note: `Send in ${candidate.species}: takes ~${round1(effIn)}% from ${threatName}` +
          `${hazardDmg > 0 ? `, plus ~${round1(hazardDmg)}% to hazards on entry` : ''}` +
          `${offCredit ? `, hits back for ~${round1(offCredit)}%` : ''}` +
          `${candKo ? (candKoGuaranteed ? ' — guaranteed KO' : ' — can KO') : ''}` +
          // A KO-trade into a bad matchup is a deliberate call, not a blind
          // send-in — say so (mirrors the optional switch's note). A pick
          // that merely survives the threat best needs no such caveat.
          `${threatened && candKo ? ` — only the KO justifies the ~${round1(effIn)}% it takes` : ''}`,
      };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 2-turn lookahead (the race projection)
// ---------------------------------------------------------------------------

// Rough projection of how many turns each active takes to finish the other,
// counting their best hit (revealed + FULL hidden worst) against us, our chip
// drain per turn (burn/poison/weather), and the same for them. Returns null
// when neither side can realistically finish the other. Used to call out
// races the player is losing: "they finish you in 2 turns — win now or
// switch".
//
// Unlike effectiveIncoming (which discounts hidden moves at 0.6× because
// they're speculative), the race projection uses full worst-case damage —
// a race is a survival calculation, and you need to plan for the strongest
// move they COULD have, not the most likely one.
export function raceProjection(ourActive, theirActive, gen, field, calcOpts = {}, ourSide = null) {
  if (!ourActive?.species || !theirActive?.species) return null;
  const theirRevealed = incomingPercent(theirActive, ourActive, gen, field, calcOpts);
  const theirHidden = worstThreat(theirActive, ourActive, gen, field, calcOpts);
  // Full worst-case: use the hidden move at 100% (not discounted) when it's
  // stronger than their best revealed move.
  const theirHit = Math.max(theirRevealed.pct, theirHidden && theirHidden.pct >= 50 ? theirHidden.pct : 0);
  const raceHidden = theirHidden && theirHidden.pct > theirRevealed.pct ? theirHidden : null;
  const ourHit = ownBestDamage(ourActive, theirActive, gen, field, calcOpts);
  const ourHp = ourActive.hpPercent ?? 100;
  const theirHp = theirActive.hpPercent ?? 100;
  const ourChip = chipPerTurn(ourActive, gen, field); // negative = drain
  const theirChip = chipPerTurn(theirActive, gen, field);
  const ourDrain = ourChip < 0 ? -ourChip : 0;
  const theirDrain = theirChip < 0 ? -theirChip : 0;
  const theirDps = round1(theirHit + ourDrain); // what we lose per turn staying
  const ourDps = round1(ourHit + theirDrain); // what they lose per turn
  const ourTurns = theirDps > 0 ? Math.ceil(ourHp / theirDps) : Infinity;
  const theirTurns = ourDps > 0 ? Math.ceil(theirHp / ourDps) : Infinity;
  if (ourTurns === Infinity && theirTurns === Infinity) return null;
  return { ourTurns, theirTurns, theirHit: round1(theirHit), ourHit: round1(ourHit), ourDrain, raceHidden };
}

// ---------------------------------------------------------------------------
// Risk modes (safe / normal / aggressive)
// ---------------------------------------------------------------------------

// How far ahead (in %-HP equivalents) we must be to play safe / aggressive.
const AHEAD_THRESHOLD = 100;
const BEHIND_THRESHOLD = -100;
// Positional mode thresholds: when the win-probability eval is this clearly
// one-sided, play to the position even if the raw HP board looks even.
const WIN_SAFE_AT = 0.66;
const WIN_AGGRESSIVE_AT = 0.34;

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

// 'auto' derives the mode from the position: clearly ahead → safe, clearly
// behind → aggressive, otherwise balanced. An explicit mode wins. The
// positional read (winProb, from the game-level eval) is sharper than raw
// HP — an even-HP board where their active dominates ours is still a losing
// position — so it is consulted first, with the HP advantage as the fallback
// so the mode resolves even with minimal information.
export function resolveRiskMode(opts = {}, advantage = 0, winProb = null) {
  const requested = opts.riskMode ?? 'auto';
  if (requested === 'safe' || requested === 'normal' || requested === 'aggressive') return requested;
  if (winProb != null) {
    if (winProb >= WIN_SAFE_AT) return 'safe';
    if (winProb <= WIN_AGGRESSIVE_AT) return 'aggressive';
  }
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
      // Priority moves act before normal ones regardless of Speed: a revealed
      // priority KO on either side decides the duel outright (their Aqua Jet
      // finishes us before our faster move lands — and vice versa).
      const theirPrioKo = (() => {
        const p = bestPriorityMove(theirs, ours, gen, field, calcOpts);
        return p && p.max >= ourHp ? p.move : null;
      })();
      const ourPrioKo = (() => {
        const p = bestPriorityMove(ours, theirs, gen, field, calcOpts);
        return p && p.max >= theirHp ? p.move : null;
      })();
      let verdict;
      if (theirPrioKo) verdict = 'lose';
      else if (ourPrioKo) verdict = 'win';
      else if (ourDmg <= 0 && theirDmg > 0) verdict = 'lose';
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
        priority: theirPrioKo ? 'theirs' : ourPrioKo ? 'ours' : null,
        verdict,
      });
    }
  }
  return out;
}

// Their FULL damage on us for the endgame search: revealed best + hidden
// worst at full strength (like the race projection). A "forced win" claim
// must survive the strongest move they COULD have — an unrevealed nuke
// (Gliscor's Brick Break, Dragonite's Focus Punch on a wall) breaks the mate.
function theirBestHit(theirs, ours, gen, field, calcOpts) {
  const hidden = worstThreat(theirs, ours, gen, field, calcOpts);
  return Math.max(ownBestDamage(theirs, ours, gen, field, calcOpts), hidden && hidden.pct >= 50 ? hidden.pct : 0);
}

// A 1v1 race verdict for the endgame search, mirroring endgameLocks' race
// logic but with HP overrides (so we can price a mon that just took an entry
// hit or a target already chipped this turn). Returns the verdict plus the
// numbers that justify it.
function duelRace(ours, theirs, gen, field, calcOpts, state, ourSideId, ourHp = null, theirHp = null) {
  const ourDmg = ownBestDamage(ours, theirs, gen, field, calcOpts);
  const theirDmg = theirBestHit(theirs, ours, gen, field, calcOpts);
  const ourH = ourHp ?? ours.hpPercent ?? 100;
  const theirH = theirHp ?? theirs.hpPercent ?? 100;
  const order = state ? speedOrder(ours, theirs, gen, state, ourSideId) : null;
  const weFirst = order?.weMoveFirst === true;
  const theirPrioKo = (() => {
    const p = bestPriorityMove(theirs, ours, gen, field, calcOpts);
    return p && p.max >= ourH ? p.move : null;
  })();
  const ourPrioKo = (() => {
    const p = bestPriorityMove(ours, theirs, gen, field, calcOpts);
    return p && p.max >= theirH ? p.move : null;
  })();
  const ourTurns = ourDmg > 0 ? Math.ceil(theirH / ourDmg) : Infinity;
  const theirTurns = theirDmg > 0 ? Math.ceil(ourH / theirDmg) : Infinity;
  let verdict;
  if (theirPrioKo) verdict = 'lose';
  else if (ourPrioKo) verdict = 'win';
  else if (ourDmg <= 0 && theirDmg > 0) verdict = 'lose';
  else if (theirDmg <= 0 && ourDmg > 0) verdict = 'win';
  else if (ourTurns === Infinity && theirTurns === Infinity) verdict = 'stall';
  else if (ourTurns < theirTurns) verdict = 'win';
  else if (theirTurns < ourTurns) verdict = 'lose';
  else verdict = weFirst ? 'win' : 'close';
  return { verdict, ourTurns, theirTurns, theirDmg, weFirst, theirPrioKo, ourPrioKo };
}

// Endgame checkmate search: when the battle is down to a few mons, find a
// FORCING win line (a sequence we can execute regardless of their reply)
// instead of leaving it to the per-move evaluation — the difference between
// "this move is okay" and "the game is won from here". Runs only in the
// endgame (≤2 of their mons, ≤4 total) so mid-game cost is zero. Lines:
//   ko-now   — our active KOs their current this turn (and they can't kill
//              us before our move lands): game over.
//   duel     — some mon of ours wins the 1v1 race vs their current (priced
//              with the entry hit for a bench piece): keep attacking or
//              switch to it, the win is forced.
//   ko-then  — our active KOs their current, and when the replacement comes
//              in, a mon of ours beats it 1v1: KO now, win after.
//   sac      — our active can't finish, but chips their current into a bench
//              mate's range; the mate wins even after the entry hit: sac and
//              clean up.
// The mirror threat (their line against us) is surfaced when their current
// KOs our active and their last mon beats every one of ours 1v1.
export function endgameCheckmate(ourTeam, theirTeam, ourActive, gen, field, calcOpts = {}, state = null, ourSideId = 'p1') {
  const ours = (ourTeam ?? []).filter((m) => !m.fainted);
  const theirs = (theirTeam ?? []).filter((m) => !m.fainted);
  if (!ours.length || !theirs.length) return null;
  if (theirs.length > 2 || ours.length + theirs.length > 4) return null;

  const theirSideId = ourSideId === 'p1' ? 'p2' : 'p1';
  const theirActive = activeMon(state?.sides?.[theirSideId]);
  const current = theirActive ?? mostLikelySwitchIn(theirs);
  if (!current) return null;
  const predicted = !theirActive;
  const theirBench = theirs.filter((m) => m.ident !== current.ident);
  const ourActive_ = ourActive ?? null;
  const oursBench = ours.filter((m) => m.ident !== ourActive_?.ident);
  const out = { mate: null, threat: null };

  const currentHp = current.hpPercent ?? 100;
  const ourHp = ourActive_?.hpPercent ?? 100;
  const activeDmg = ourActive_ ? ownBestDamage(ourActive_, current, gen, field, calcOpts) : 0;
  const activeKOs = activeDmg >= currentHp;
  const inNote = predicted ? ` (when ${current.species} comes in)` : '';

  if (theirs.length === 1) {
    // Their last mon. Mate: our active finishes it now, or any mon of ours
    // wins the 1v1 race (a bench piece priced with the hit it takes on entry).
    if (ourActive_ && activeKOs) {
      const race = duelRace(ourActive_, current, gen, field, calcOpts, state, ourSideId);
      const theyKillFirst = race.theirPrioKo || (race.weFirst === false && race.theirDmg >= ourHp);
      if (!theyKillFirst) {
        out.mate = {
          kind: 'ko-now',
          piece: ourActive_.species,
          target: current.species,
          note: `Checkmate: your ${ourActive_.species} KOs their ${current.species} this turn${inNote} — game over.`,
        };
      }
    } else {
      for (const m of ours) {
        const entry = m.ident === ourActive_?.ident ? null : theirBestHit(current, m, gen, field, calcOpts);
        const race = duelRace(
          m, current, gen, field, calcOpts, state, ourSideId,
          entry != null ? Math.max(1, (m.hpPercent ?? 100) - entry) : null
        );
        if (race.verdict === 'win') {
          const via = m.ident === ourActive_?.ident ? 'keep attacking' : `switch to ${m.species}`;
          out.mate = {
            kind: 'duel',
            piece: m.species,
            target: current.species,
            note: `Checkmate: your ${m.species} beats their ${current.species} 1v1 (${race.ourTurns}HKO vs their ${race.theirTurns}HKO)${inNote} — ${via}, it's forced.`,
          };
          break;
        }
      }
    }
  } else if (theirs.length === 2 && ourActive_) {
    // KO-now line: our active finishes their current; their one replacement
    // comes in and some mon of ours beats it 1v1 → forced.
    if (activeKOs) {
      const rep = theirBench[0];
      const piece = [ourActive_, ...oursBench].find(
        (m) => duelRace(m, rep, gen, field, calcOpts, state, ourSideId)?.verdict === 'win'
      );
      if (piece) {
        const race = duelRace(piece, rep, gen, field, calcOpts, state, ourSideId);
        out.mate = {
          kind: 'ko-then',
          piece: piece.species,
          target: current.species,
          replacement: rep.species,
          note: `Checkmate: KO their ${current.species} now — when ${rep.species} comes in, your ${piece.species} beats it 1v1 (${race.ourTurns}HKO vs their ${race.theirTurns}HKO).`,
        };
      }
    } else {
      // Sac line: a bench mate wins the 1v1 even after the entry hit AND our
      // active's chip this turn brings their current into range.
      const piece = oursBench.find((m) => {
        const entry = theirBestHit(current, m, gen, field, calcOpts);
        const race = duelRace(
          m, current, gen, field, calcOpts, state, ourSideId,
          Math.max(1, (m.hpPercent ?? 100) - entry),
          Math.max(1, currentHp - activeDmg)
        );
        return race.verdict === 'win';
      });
      if (piece && activeDmg > 0) {
        const entry = theirBestHit(current, piece, gen, field, calcOpts);
        const race = duelRace(
          piece, current, gen, field, calcOpts, state, ourSideId,
          Math.max(1, (piece.hpPercent ?? 100) - entry),
          Math.max(1, currentHp - activeDmg)
        );
        out.mate = {
          kind: 'sac',
          piece: piece.species,
          target: current.species,
          note: `Checkmate: sac your ${ourActive_.species} to chip their ${current.species}, then ${piece.species} cleans up (${race.ourTurns}HKO vs their ${race.theirTurns}HKO) — forced win.`,
        };
      }
    }
  }

  // Their forcing line against us: their current reliably KOs our active this
  // turn, and their remaining mon beats every one of ours 1v1 — we're mated
  // unless we take a gamble.
  if (!out.mate && ourActive_ && theirBench.length && theirs.length === 2) {
    const theirDmg = theirBestHit(current, ourActive_, gen, field, calcOpts);
    if (theirDmg >= ourHp) {
      const sweeper = theirBench[0];
      const allLose = ours.every((m) => duelRace(m, sweeper, gen, field, calcOpts, state, ourSideId)?.verdict !== 'win');
      if (allLose) {
        out.threat = {
          piece: current.species,
          sweeper: sweeper.species,
          note: `⚠ their ${current.species} KOs your ${ourActive_.species}, then ${sweeper.species} beats ${ours.map((m) => m.species).join(', ')} 1v1 — you're on a clock; take the gamble or deny the KO.`,
        };
      }
    }
  }

  return out.mate || out.threat ? out : null;
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
  // Real-set EV/nature priors (sets.js) are ON by default; tests that pin
  // behavior under the controlled 252-EV model opt out with { sets: false }.
  if (opts.sets != null) calcOpts.sets = opts.sets;
  // Per-opponent behavioral model: the profile's moveUsage (species → move →
  // count of times this opponent has run that move on that species) re-weights
  // hidden-move pricing away from Smogon theorymon and toward what THIS
  // opponent actually plays. Threaded through calcOpts so every
  // worstThreat/expectedThreat call picks it up.
  if (opts.personalUsage) calcOpts.personalUsage = opts.personalUsage;
  // Engine committee weights: injectable so the tuning script can compare
  // candidates against real battles (scripts/tune-weights.js). Defaults to
  // the tuned set — a passed-in object replaces it wholesale.
  const engineWeights = opts.engineWeights ?? ENGINE_WEIGHTS;
  const reasoning = [];

  if (state?.winner) {
    const text = state.winner === 'tie' ? 'Tie game' : `${state.winner} wins`;
    return { bestMove: null, switchTo: null, reasoning: [text], note: text };
  }

  const field = buildField(state);
  const hazards = { ours: hazardCount(ourSide), theirs: hazardCount(theirSide) };
  const ourTeam = alivePokemon(ourSide);
  const theirTeam = alivePokemon(theirSide);

  const advantage = boardAdvantage(ourTeam, theirTeam);
  let ourActive = activeMon(ourSide);
  const theirActive = activeMon(theirSide);

  // Positional read: a game-level "who wins this game" eval (material,
  // firepower, speed tiers, hazards, recovery, the active 1v1). It resolves
  // the risk mode below and tempers the switch bar when the position is
  // extreme — the board, not just the current matchup, decides how we play.
  const positional = positionalWinProb(ourTeam, theirTeam, gen, field, calcOpts, {
    hazards,
    active: { ours: ourActive, theirs: theirActive },
  });

  // Risk mode: who's ahead and how we should play it. The advantage is a
  // board read (total remaining HP + a per-body bonus); auto resolves the
  // mode from the positional win-probability (sharper than raw HP — an
  // even-HP board where their active dominates ours reads behind), falling
  // back to the HP read when the eval is inconclusive.
  const riskMode = resolveRiskMode(opts, advantage, positional.winProb);
  let risk = RISK_MODES[riskMode];
  // Auto mode only: extreme positions temper the switch bar continuously on
  // top of the 3-mode ladder. Deep in a winning position, switching to dodge
  // a hit is cheap when the game is basically won — lower the bar to preserve
  // the lead. Deep behind, a switch bleeds tempo we don't have — raise the
  // bar so we only leave when it's clearly right. (Explicit modes keep their
  // exact thresholds, so pinned behavior is untouched.)
  if ((opts.riskMode ?? 'auto') === 'auto') {
    const p = positional.winProb;
    const mult = p >= WIN_SAFE_AT ? 0.75 : p <= WIN_AGGRESSIVE_AT ? 1.5 : 1;
    if (mult !== 1) {
      risk = {
        ...risk,
        switchThreshold: risk.switchThreshold * mult,
        pivotGate: risk.pivotGate * mult,
        threatenedAt: risk.threatenedAt * mult,
      };
    }
  }

  if (!ourTeam.length) {
    const revealed = ourSide?.pokemon?.length ?? 0;
    const fainted = (ourSide?.pokemon ?? []).filter((m) => m.fainted).length;
    const msg =
      revealed === 0
        ? 'Your team has not been revealed yet in this log.'
        : `All ${fainted} revealed Pokémon are down — this log has not shown your remaining team yet (the live extension will know it).`;
    return { bestMove: null, switchTo: null, reasoning: [msg], note: null };
  }

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
    // A revealed priority move on their active ignores the Speed read above:
    // if it can pick us off first, the outspeed line doesn't apply to it.
    const prioThreat = bestPriorityMove(theirTarget, ourActive, gen, field, calcOpts);
    if (prioThreat && prioThreat.max >= (ourActive.hpPercent ?? 100)) {
      reasoning.push(`⚠ their ${theirTarget.species}'s ${prioThreat.move} can KO you first — priority beats Speed.`);
    }
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
    const ev = evaluateMove(ourActive, moveName, theirTarget, theirTeam, stayProb, switchProbs, gen, field, calcOpts, speed, hazards, risk, engineWeights);
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

  // Move confidence: how clearly the committee prefers the top move over the
  // runner-up. Blends (a) how much engine weight agrees it wins (the engines
  // vote independently, so agreement is a real signal, not a score artifact)
  // with (b) how large the blended-score lead is. A move every engine ranks
  // first with a big lead reads ~95%; two genuinely close moves read ~55%; a
  // lone option is 100%. Computed here (not at the end) so a middling read
  // can surface a close-call note inside the reasoning budget.
  let moveConfidence = 100;
  const runnerUp = moveEvals[1] ?? null;
  if (bestMove && runnerUp && runnerUp.score > 0) {
    const margin = bestMove.score - runnerUp.score;
    const agreement = engineAgreement(bestMove, runnerUp, engineWeights.agree);
    const marginNorm = clamp01(margin / 25);
    moveConfidence = Math.round(clamp01(0.5 + 0.5 * (0.6 * agreement + 0.4 * marginNorm)) * 100);
    if (moveConfidence < 68 && margin < 8) {
      reasoning.push(`Close call between ${bestMove.move} (${bestMove.score}) and ${runnerUp.move} (${runnerUp.score}) — either is defensible.`);
    }
  }
  // Surface the committee votes in the reasoning itself (not just the badge
  // tooltip): the move's score is the blend of the engines, and this line
  // shows where it came from. Pushed here with the confidence computation so
  // it survives the 9-line reasoning budget. The breakdown mirrors the
  // tooltip, but visible at a glance in the list.
  if (bestMove?.votes) {
    const v = bestMove.votes;
    const fmt = (n) => (n > 0 ? `+${n}` : `${n}`);
    reasoning.push(
      `Committee on ${bestMove.move}: calc ${v.calc} · KO ${fmt(v.ko)} · speed ${fmt(v.speed)} · context ${fmt(v.context)} · response ${fmt(v.response)} → score ${bestMove.score}`
    );
  }

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

  // Endgame checkmate search: with few mons left, is the win FORCED? Finds a
  // forcing line (KO now, a 1v1 piece to switch to, a sac-then-clean, or a
  // KO-then-beat-the-replacement) instead of leaving it to per-move
  // evaluation — and warns when their line against us is the forcing one.
  const checkmate = endgameCheckmate(ourTeam, theirTeam, ourActive, gen, field, calcOpts, state, ourSideId);
  if (checkmate?.mate) {
    reasoning.push(checkmate.mate.note);
  } else if (checkmate?.threat) {
    reasoning.push(checkmate.threat.note);
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
        `Endgame: your ${w.ours} beats their ${w.theirs} 1v1 (${w.ourTurns}HKO vs their ${w.theirTurns}HKO${w.weFirst && w.priority !== 'ours' ? ', you move first' : ''}${w.priority === 'ours' ? ' — priority KO' : ''}) — locked in.`
      );
    }
    if (theirWins.length && !ourWins.some((w) => w.theirs === theirWins[0].theirs)) {
      const l = theirWins[0];
      reasoning.push(`Endgame: their ${l.theirs} beats your ${l.ours} 1v1${l.priority === 'theirs' ? ' (priority KO)' : ''} — avoid that pairing.`);
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

  // Their setup prediction: a revealed setup move on their active that it
  // hasn't used yet is a boost-incoming — pros set up on the switch-in. If
  // our best move can KO it now, that's the moment; otherwise it sweeps.
  if (theirTarget && !targetIsPredicted) {
    const theirSetup = (theirTarget.moves ?? []).find((m) => SETUP_MOVES.has(m));
    const boosted = (theirTarget.boosts?.atk ?? 0) >= 1 || (theirTarget.boosts?.spa ?? 0) >= 1;
    if (theirSetup && !boosted) {
      if (bestMove?.ko) {
        reasoning.push(`Their ${theirTarget.species} has ${theirSetup} revealed — KO it NOW before it sets up.`);
      } else {
        reasoning.push(`Their ${theirTarget.species} has ${theirSetup} — it's about to set up. KO it now or switch before it sweeps.`);
      }
    }
  }

  // 2-turn lookahead: if they finish us faster than we finish them, staying is
  // a slow loss — call the race so the play (KO now, status, or switch) gets
  // made before the projection comes due.
  if (theirTarget && !targetIsPredicted) {
    const race = raceProjection(ourActive, theirTarget, gen, field, calcOpts, ourSide);
    if (race && race.ourTurns <= 2 && race.theirTurns > race.ourTurns && !bestMove?.ko) {
      const chipNote = race.ourDrain > 0 ? ` (incl. ~${round1(race.ourDrain)}%/turn chip)` : '';
      const hiddenNote = race.raceHidden ? ` (includes likely ${race.raceHidden.move} ~${round1(race.raceHidden.pct)}%)` : '';
      reasoning.push(
        `Race check: their ${theirTarget.species} finishes you in ~${race.ourTurns} turn${race.ourTurns === 1 ? '' : 's'} at ~${race.theirHit}%/turn${chipNote}${hiddenNote} — you can't outlast it; win this turn or switch.`
      );
    }
  }

  // Tera awareness.
  if (theirTarget?.terastallized) {
    reasoning.push(`Their ${theirTarget.species} is terastallized (tera ${theirTarget.teraType}) — effectiveness above accounts for it.`);
  }
  // Their revealed-but-unused tera type can flip OUR matchup: it may resist
  // the move we're about to click, and their hits on us can jump with the new
  // Per-opponent tera habit: they've tera'd before — on what and how early.
  // When their active is a species they habitually tera, or they tera very
  // early, say so; the plan should hold the tera.
  const teraHabit = profile?.teraHabits ?? null;
  if (teraHabit && theirTarget?.teraType && !theirTarget.terastallized && !targetIsPredicted) {
    const onThis = (teraHabit.species?.[theirTarget.species] ?? 0) > 0;
    const habitBits = [];
    if (onThis) {
      const n = teraHabit.species[theirTarget.species];
      habitBits.push(`they've tera'd this one in ${n} past battle${n === 1 ? '' : 's'}`);
    }
    if (teraHabit.earliestTurn != null && teraHabit.earliestTurn <= 6) {
      habitBits.push(`they tera early (as soon as turn ${teraHabit.earliestTurn})`);
    }
    if (habitBits.length) {
      reasoning.push(`⚠ ${theirTarget.species} can terastallize into ${theirTarget.teraType} — ${habitBits.join('; ')}.`);
    }
  }
  // typing. Warn so the plan holds the tera.
  if (theirTarget?.teraType && !theirTarget.terastallized && !targetIsPredicted) {
    const t = theirTarget.teraType;
    const flips = [];
    if (bestMove && bestMove.kind === 'damage') {
      const dNow = bestMove.expected.mean;
      const dTera = damagePercent(gen, ourActive, theirTarget, bestMove.move, field, {
        ...calcOpts,
        defenderTera: t,
      })?.mean;
      if (dTera != null && dTera < dNow - 15) {
        flips.push(`your ${bestMove.move} drops ~${round1(dNow)}% → ~${round1(dTera)}%`);
      }
    }
    const tInNow = incomingPercent(theirTarget, ourActive, gen, field, calcOpts).pct;
    const tInTera = incomingPercent(theirTarget, ourActive, gen, field, { ...calcOpts, attackerTera: t }).pct;
    if (tInTera > tInNow + 15) {
      flips.push(`their hits on you rise ~${round1(tInNow)}% → ~${round1(tInTera)}%`);
    }
    if (flips.length) {
      reasoning.push(`Their ${theirTarget.species} can terastallize into ${t}: ${flips.join('; ')} — plan around it.`);
    }
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
    const ourHp = ourActive.hpPercent ?? 100;
    // The "flip the matchup" read: their hit KOs us and tera makes us
    // survive it — that's the moment to press the button, not a marginal
    // damage trade. (Also catches the plain damage-cut case below.)
    if (inNow >= ourHp && inTera < ourHp) {
      gains.push(`tera-${tera} turns their ~${round1(inNow)}% hit into ~${round1(inTera)}% — you survive it`);
    } else if (inTera < inNow - 20) {
      gains.push(`tera-${tera} cuts incoming damage ~${round1(inNow)}% → ~${round1(inTera)}%`);
    }
    if (gains.length) {
      reasoning.push(`Consider terastallizing your ${ourActive.species} into ${tera}: ${gains.join('; ')}.`);
    }
  }

  // Risk-mode callout: who's ahead (the positional read plus the raw HP
  // margin), and how that shapes the recommendation. Only worth a line when
  // it actually changes how we play (not balanced).
  if (riskMode !== 'normal') {
    const advTxt = advantage >= 0 ? `+${Math.round(advantage)}` : String(Math.round(advantage));
    const wpTxt = `, ~${Math.round(positional.winProb * 100)}% to win`;
    reasoning.push(
      riskMode === 'safe'
        ? `You're ahead (~${advTxt}% HP${wpTxt}) — ${risk.label}: take the sure line, protect the lead.`
        : `You're behind (~${advTxt}% HP${wpTxt}) — ${risk.label}: take the gamble that wins if it lands.`
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

  // Their best revealed move's damage on us — the same number the matchup
  // view's Damage row shows (both come from matchupDamage), so the panel and
  // the reasoning always agree. Skipped against a predicted switch-in.
  if (!targetIsPredicted) {
    const dmg = matchupDamage(gen, ourActive, theirTarget, field, calcOpts);
    if (dmg.theirs && dmg.theirs.pct >= 25) {
      reasoning.push(`Their ${theirTarget.species} hits your ${ourActive.species} for ~${round1(dmg.theirs.pct)}% (${dmg.theirs.move}).`);
    }
    // Physical/special inference: a mon that has only revealed physical moves
    // is almost certainly Atk-invested (only special moves → SpA). Make the
    // read explicit — it explains why their physical hits are priced high
    // (and Foul Play hits them hard) or their special ones are (and their
    // physical coverage is weak).
    const invest = inferOffensiveStat(theirTarget, gen);
    if (invest && !theirTarget.terastallized) {
      const nPhys = (theirTarget.moves ?? []).filter((m) => {
        try { return new Move(gen, m).category === 'Physical'; } catch { return false; }
      }).length;
      const nSpec = (theirTarget.moves ?? []).length - nPhys;
      reasoning.push(
        invest === 'atk'
          ? `Their ${theirTarget.species} reads as a physical attacker (${nPhys} physical / ${nSpec} special moves shown) — its hits are priced at 252 Atk EV, and Foul Play would punish it.`
          : `Their ${theirTarget.species} reads as a special attacker (${nSpec} special / ${nPhys} physical moves shown) — its special hits are priced at 252 SpA EV, its physical coverage is weak, and Foul Play hits it soft.`
      );
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

  // Switch confidence: how far the switch's net clears the mode's own switch
  // bar (that's the engine's decision rule — the same threshold that decided
  // to recommend it at all). A switch that just clears the bar is a judgment
  // call (~55%); one that crushes it is a clear call (~95%). A forced switch
  // (no move to compare against) is 100%.
  let switchConfidence = null;
  if (switchTo) {
    if (!bestMove) {
      switchConfidence = 100;
    } else {
      const bar = risk.switchThreshold;
      const excess = switchTo.score - bar;
      switchConfidence = Math.round(clamp01(0.55 + 0.4 * clamp01(excess / 25)) * 100);
    }
  }

  return {
    bestMove: bestMove
      ? { move: bestMove.move, score: bestMove.score, note: bestMove.note, expected: bestMove.expected, confidence: moveConfidence, votes: bestMove.votes }
      : null,
    // Full ranking (top-3 by score) — the tuning harness uses it to measure
    // how often the actual move lands in the engine's top options, not just
    // the exact pick (players often take the second-best play).
    rankedMoves: opts.rankedMoves ? moveEvals.slice(0, 3).map((m) => ({ move: m.move, score: m.score })) : undefined,
    switchTo: switchTo ? { ...switchTo, confidence: switchConfidence } : null,
    reasoning: reasoning.slice(0, 9),
    note: null,
    risk: {
      mode: riskMode,
      label: risk.label,
      advantage: Math.round(advantage),
      // The game-level read, 0-100: how likely we are to win this game.
      winProb: Math.round(positional.winProb * 100),
      // The effective switch bar after the auto-mode temper (what the engine
      // actually compares the switch's net against).
      switchBar: risk.switchThreshold,
    },
  };
}
