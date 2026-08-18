// test/engine.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { calculate, Pokemon, Move, Field } from '@smogon/calc';
import { createBattleState, createPokemon, addMove } from '../src/reader/state.js';
import { parseLog } from '../src/reader/reader.js';
import { damagePercent, buildField } from '../src/engine/calc.js';
import {
  recommend,
  evaluateMove,
  evaluateSwitch,
  predictStayProb,
  predictSwitchProbs,
  utilityScore,
  hazardDamageOnEntry,
  entryHazardNotes,
  chipPerTurn,
  moveConditionalSwitchProbs,
  teamWincon,
  sweepPotential,
  endgameLocks,
  endgameCheckmate,
  boardAdvantage,
  resolveRiskMode,
  RISK_MODES,
  engineAgreement,
  positionalWinProb,
} from '../src/engine/index.js';
import { buildPanelModel } from '../src/ui/panel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const realLog = readFileSync(path.join(__dirname, 'fixtures', 'real-battle.log'), 'utf8');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Build a BattleState directly (no log) so scenarios are fully controlled.
function makeState({ ourActive, theirActive, ourBench = [], theirBench = [], gen = 9, winner = null }) {
  const state = createBattleState();
  state.gen = gen;
  state.turn = 3;
  state.winner = winner;
  state.gametype = 'singles';
  state.sides.p1.playerName = 'Me';
  state.sides.p2.playerName = 'Rival';

  const add = (sideId, specs, activeSpecies) => {
    const side = state.sides[sideId];
    const letters = 'abcdef';
    side.pokemon = specs.map((spec, i) => {
      const rec = createPokemon({
        ident: `${sideId}${letters[i]}: ${spec.species}`,
        side: sideId,
        species: spec.species,
        level: spec.level ?? 100,
      });
      rec.hpPercent = spec.hpPercent ?? 100;
      rec.hp = { cur: spec.hpPercent ?? 100, max: 100 };
      if (spec.status) rec.status = spec.status;
      if (spec.item) {
        rec.item = spec.item;
        rec.itemRevealed = true;
      }
      if (spec.ability) rec.ability = spec.ability;
      if (spec.boosts) Object.assign(rec.boosts, spec.boosts);
      for (const mv of spec.moves ?? []) addMove(rec, mv);
      if (spec.fainted) rec.fainted = true;
      if (spec.teraType) rec.teraType = spec.teraType;
      if (spec.terastallized) rec.terastallized = true;
      if (spec.canTera != null) rec.canTera = spec.canTera;
      return rec;
    });
    const active = side.pokemon.find((p) => p.species === activeSpecies);
    if (active) {
      side.active = [active.ident];
      active.active = true;
    }
  };

  add('p1', [...(ourActive ? [ourActive] : []), ...ourBench], ourActive?.species);
  add('p2', [...(theirActive ? [theirActive] : []), ...theirBench], theirActive?.species);
  return state;
}

const fullIvs = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };

// ---------------------------------------------------------------------------
// Move ranking
// ---------------------------------------------------------------------------

test('engine: super-effective move is recommended (Charizard vs Ferrothorn)', () => {
  const state = makeState({
    ourActive: { species: 'Charizard', moves: ['Fire Blast', 'Air Slash', 'Dragon Pulse'] },
    theirActive: { species: 'Ferrothorn', moves: ['Power Whip', 'Gyro Ball', 'Leech Seed'] },
  });
  const rec = recommend(state);
  assert.equal(rec.bestMove.move, 'Fire Blast');
  assert.equal(rec.bestMove.expected.effectiveness, 4); // Fire vs Grass/Steel
  assert.ok(rec.reasoning.some((r) => r.includes('4×')), 'reasoning should mention 4×');
  assert.ok(rec.reasoning.some((r) => r.includes('KO')), 'Fire Blast should threaten a KO at full HP');
  assert.equal(rec.switchTo, null, 'no switch when the matchup is won');
});

test('engine: KO callout when their mon is low', () => {
  const state = makeState({
    ourActive: { species: 'Charizard', moves: ['Fire Blast', 'Dragon Pulse'] },
    theirActive: { species: 'Venusaur', hpPercent: 20, moves: ['Sludge Bomb'] },
  });
  const rec = recommend(state);
  assert.equal(rec.bestMove.move, 'Fire Blast');
  assert.ok(rec.bestMove.expected.max >= 20);
  assert.ok(rec.reasoning.some((r) => r.includes('KO')));
});

test('engine: weaker neutral move loses to coverage', () => {
  const state = makeState({
    ourActive: { species: 'Garchomp', moves: ['Earthquake', 'Dragon Claw'] },
    theirActive: { species: 'Heatran', moves: ['Lava Plume', 'Flash Cannon'] },
  });
  const rec = recommend(state);
  // Earthquake is 4x vs Fire/Steel Heatran (Fire is weak to Ground);
  // Dragon Claw is resisted (0.5x by Steel).
  assert.equal(rec.bestMove.move, 'Earthquake');
  assert.equal(rec.bestMove.expected.effectiveness, 4);
});

// ---------------------------------------------------------------------------
// Switch advice
// ---------------------------------------------------------------------------

test('engine: no switch right after we bring in a mon (anti ping-pong)', () => {
  const state = makeState({
    ourActive: { species: 'Scizor', moves: ['Bullet Punch'] },
    ourBench: [{ species: 'Tyranitar', moves: ['Stone Edge'] }],
    theirActive: { species: 'Charizard', moves: ['Flamethrower', 'Air Slash', 'Fire Blast', 'Dragon Pulse'] },
  });
  // Control: Scizor is 4x weak to Fire, so the switch is normally called out.
  assert.equal(recommend(state).switchTo.species, 'Tyranitar');
  // But we just brought Scizor in this turn — switching again right away would
  // hand them a free turn. No switch advice in that window.
  const scizor = state.sides.p1.pokemon.find((m) => m.species === 'Scizor');
  scizor.justSwitchedIn = true;
  const rec = recommend(state);
  assert.equal(rec.switchTo, null);
  assert.ok(rec.reasoning.some((r) => r.includes('free turn')));
});

test('engine: a mon that just left the field is not recommended as a switch-in', () => {
  const state = makeState({
    ourActive: { species: 'Scizor', moves: ['Bullet Punch'] },
    ourBench: [
      { species: 'Tyranitar', moves: ['Stone Edge'] },
      { species: 'Garchomp', moves: ['Earthquake'] },
    ],
    theirActive: { species: 'Charizard', moves: ['Flamethrower', 'Air Slash', 'Fire Blast', 'Dragon Pulse'] },
  });
  // Control: Tyranitar is the best switch-in.
  assert.equal(recommend(state).switchTo.species, 'Tyranitar');
  // Tyranitar left the field last turn (we just switched away from it) — the
  // engine must not immediately recommend switching straight back (the pivot
  // ping-pong). It can still suggest a different mon.
  const ttar = state.sides.p1.pokemon.find((m) => m.species === 'Tyranitar');
  ttar.switchedOutTurn = state.turn - 1;
  const rec = recommend(state);
  assert.notEqual(rec.switchTo?.species, 'Tyranitar');
});

test('engine: a forced send-in avoids a mon weak to their (unrevealed) active', () => {
  const state = makeState({
    ourActive: { species: 'Ferrothorn', fainted: true, moves: ['Gyro Ball'] },
    ourBench: [
      // Raging Bolt hits harder (2x Dragon Pulse vs Garchomp) but is 2x-weak
      // to Garchomp's likely hidden moves; Corviknight walls all of them.
      { species: 'Raging Bolt', moves: ['Dragon Pulse', 'Thunderbolt'] },
      { species: 'Corviknight', moves: ['Iron Head', 'Brave Bird'] },
    ],
    theirActive: { species: 'Garchomp', moves: [] }, // nothing revealed yet
  });
  // sets: false keeps the flat 252-EV model — with real sets Raging Bolt's
  // Dragon Pulse guaranteed-KOs a 0-SpD Garchomp, so the KO-trade exception
  // (correctly) fires and this gate test couldn't pin the defensive pick.
  const rec = recommend(state, { sets: false });
  assert.equal(rec.switchTo.species, 'Corviknight');
});

test('engine: recommends switching when the current mon is doomed', () => {
  const state = makeState({
    ourActive: { species: 'Scizor', hpPercent: 5, moves: ['Bullet Punch', 'U-turn'] },
    ourBench: [{ species: 'Tyranitar', moves: ['Stone Edge', 'Crunch'] }],
    theirActive: { species: 'Charizard', moves: ['Flamethrower', 'Air Slash'] },
  });
  const rec = recommend(state);
  assert.equal(rec.switchTo.species, 'Tyranitar');
  assert.ok(rec.reasoning.some((r) => r.includes('Tyranitar')));
});

test('engine: does not over-recommend switching when the matchup is won', () => {
  const state = makeState({
    ourActive: { species: 'Tyranitar', hpPercent: 90, moves: ['Stone Edge', 'Crunch'] },
    ourBench: [{ species: 'Garchomp', moves: ['Earthquake'] }],
    // All 4 moves revealed: no hidden threat to speculate about.
    theirActive: { species: 'Charizard', moves: ['Flamethrower', 'Air Slash', 'Dragon Pulse', 'Fire Blast'] },
  });
  const rec = recommend(state);
  assert.equal(rec.switchTo, null, 'staying is clearly right — no switch');
  assert.equal(rec.bestMove.move, 'Stone Edge'); // 4x vs Charizard
});

test('engine: a hidden threat to our lead makes the switch worth it at battle start', () => {
  const state = makeState({
    ourActive: { species: 'Raging Bolt', hpPercent: 100, moves: ['Dragon Pulse', 'Thunderbolt'] },
    theirActive: { species: 'Garchomp', moves: [] }, // nothing revealed yet
    ourBench: [{ species: 'Corviknight', hpPercent: 100, moves: ['Brave Bird', 'Iron Head'] }],
  });
  const rec = recommend(state);
  // Their Garchomp could hit Raging Bolt for ~79% with a hidden move while
  // Corviknight walls it — the switch should be called out even though our
  // moves are decent and we're at full HP.
  assert.equal(rec.switchTo.species, 'Corviknight');
  assert.ok(rec.reasoning.some((r) => r.includes('could hit Raging Bolt')));
});

test('damagePercent returns null for a missing defender (e.g. opponent not revealed yet)', () => {
  const gen = 9;
  const attacker = { species: 'Raging Bolt', moves: ['Dragon Pulse'], level: 100 };
  // The crash this guards: buildPokemon(null) -> new Pokemon(gen, undefined)
  // throws "Cannot read properties of undefined (reading 'hp')" inside the
  // calc, which previously froze the whole panel at team preview.
  assert.equal(damagePercent(gen, attacker, null, 'Dragon Pulse', new Field()), null);
  assert.equal(damagePercent(gen, null, attacker, 'Dragon Pulse', new Field()), null);
  assert.equal(damagePercent(gen, null, null, 'Dragon Pulse', new Field()), null);
  // Unknown species is also skipped gracefully instead of throwing.
  assert.equal(
    damagePercent(gen, { species: 'Totally Fake Mon', moves: ['Tackle'] }, attacker, 'Tackle', new Field()),
    null
  );
});

test('engine: team preview (no actives on either side) shows waiting state, no crash', () => {
  // A fresh live battle: our request has landed (team known) but neither side
  // has been switched in yet. Previously recommend() crashed here because
  // bestSwitchIn ran against a null target.
  const state = makeState({
    ourActive: null,
    theirActive: null,
    ourBench: [
      { species: 'Raging Bolt', moves: ['Dragon Pulse', 'Thunderbolt'] },
      { species: 'Kingambit', moves: ['Sucker Punch'] },
      { species: 'Rillaboom', moves: ['Wood Hammer'] },
    ],
  });
  const rec = recommend(state);
  assert.equal(rec.bestMove, null);
  assert.equal(rec.switchTo, null);
  assert.ok(rec.reasoning.some((r) => r.includes('team preview') || r.includes('not started')));
});

test('engine: must send in a replacement when our active is down', () => {
  const state = makeState({
    ourActive: { species: 'Garchomp', fainted: true, moves: ['Earthquake'] },
    ourBench: [
      { species: 'Gliscor', moves: ['Earthquake', 'Roost'] },
      { species: 'Togekiss', moves: ['Air Slash'] },
    ],
    theirActive: { species: 'Great Tusk', moves: ['Earthquake', 'Ice Spinner'] },
  });
  const rec = recommend(state);
  assert.equal(rec.bestMove, null);
  // Gliscor is 4x weak to Ice Spinner; Togekiss is the safer send-in.
  assert.equal(rec.switchTo.species, 'Togekiss');
  assert.ok(rec.reasoning.some((r) => r.includes('down')));
});

test('engine: forced send-in does not pick a mon their SHOWN move hits harder (defense-first gate)', () => {
  // Our Garchomp fainted. Their Garchomp's shown Outrage 2×-hits our
  // Dragonite (~91%) — worse than Blissey's ~59%. Dragonite hits back hard
  // (85%), but without the gate its offense would mask the weakness. The
  // forced send-in must pick the safer wall instead.
  const state = makeState({
    ourActive: { species: 'Garchomp', fainted: true, moves: ['Earthquake'] },
    ourBench: [
      { species: 'Dragonite', hpPercent: 100, moves: ['Outrage', 'Extreme Speed'] },
      { species: 'Blissey', hpPercent: 100, moves: ['Soft-Boiled'] },
    ],
    theirActive: { species: 'Garchomp', hpPercent: 100, moves: ['Outrage', 'Earthquake'] },
  });
  const rec = recommend(state);
  assert.equal(rec.bestMove, null);
  assert.equal(rec.switchTo?.species, 'Blissey', 'the safer send-in must win over the masked offense');
  assert.ok(rec.switchTo.note.includes('takes ~'), `got: ${rec.switchTo.note}`);
});

test('engine: the forced send-in gate still allows a KO-trade into a bad matchup', () => {
  // Our Garchomp fainted. Weavile is 4×-weak to their shown Earthquake, but
  // its Icicle Crash is a guaranteed KO on their Garchomp — the KO justifies
  // the trade, and the note must say so.
  const state = makeState({
    ourActive: { species: 'Garchomp', fainted: true, moves: ['Earthquake'] },
    ourBench: [
      { species: 'Weavile', hpPercent: 100, moves: ['Icicle Crash'] },
      { species: 'Blissey', hpPercent: 100, moves: ['Soft-Boiled'] },
    ],
    theirActive: { species: 'Garchomp', hpPercent: 100, moves: ['Earthquake'] },
  });
  // sets: false — with real spreads Garchomp's def-phys bulk makes Weavile's
  // Icicle Crash a roll KO (not guaranteed), which is a different scenario;
  // this test pins the gate's KO-trade exception on the controlled model.
  const rec = recommend(state, { sets: false });
  assert.equal(rec.bestMove, null);
  assert.equal(rec.switchTo?.species, 'Weavile', 'the guaranteed KO still wins over the gate');
  assert.ok(rec.switchTo.note.includes('guaranteed KO'), `got: ${rec.switchTo.note}`);
  assert.ok(rec.switchTo.note.includes('only the KO justifies'), `got: ${rec.switchTo.note}`);
});

test('engine: predicts their switch-in when their active is down', () => {
  const state = makeState({
    ourActive: { species: 'Charizard', moves: ['Fire Blast', 'Air Slash'] },
    theirActive: { species: 'Venusaur', fainted: true, moves: ['Sludge Bomb'] },
    theirBench: [{ species: 'Blissey', moves: ['Seismic Toss'] }],
  });
  const rec = recommend(state);
  // Venusaur is down -> predict Blissey switch-in -> Fire Blast is weak vs it.
  assert.ok(rec.bestMove);
  assert.ok(rec.reasoning.some((r) => r.includes('most likely switch-in')));
});

// ---------------------------------------------------------------------------
// Utility moves
// ---------------------------------------------------------------------------

test('engine: recovery is chosen when low and attacks are weak', () => {
  const state = makeState({
    ourActive: { species: 'Ferrothorn', hpPercent: 20, moves: ['Recover', 'Power Whip'] },
    theirActive: { species: 'Blissey', moves: ['Seismic Toss', 'Soft-Boiled'] },
  });
  const rec = recommend(state);
  assert.equal(rec.bestMove.move, 'Recover');
  assert.ok(rec.bestMove.note.includes('recovery'));
});

test('utilityScore: known utility moves score, damaging moves do not', () => {
  assert.equal(utilityScore('Recover').value, 0.5);
  assert.equal(utilityScore('Swords Dance').value, 0.3);
  assert.equal(utilityScore('Earthquake'), null);
});

test('engine: a status move is not recommended when the target is already statused', () => {
  const state = makeState({
    ourActive: { species: 'Chansey', hpPercent: 100, moves: ['Thunder Wave', 'Soft-Boiled', 'Seismic Toss'] },
    theirActive: { species: 'Gliscor', hpPercent: 100, status: 'par', moves: ['Earthquake', 'Roost'] },
  });
  const rec = recommend(state);
  assert.notEqual(rec.bestMove.move, 'Thunder Wave', 'paralyzed target — Thunder Wave does nothing');
});

test('engine: status-then-switch pivot is recommended for a status wall', () => {
  const state = makeState({
    ourActive: { species: 'Chansey', hpPercent: 100, moves: ['Thunder Wave', 'Soft-Boiled'] },
    theirActive: { species: 'Gliscor', hpPercent: 100, moves: ['Earthquake', 'Roost'] },
    ourBench: [{ species: 'Garchomp', hpPercent: 100, moves: ['Earthquake', 'Stone Edge'] }],
  });
  // Force normal mode: this state is a 2v1 (ahead), so auto would pick safe
  // and reach the switch through the main gate instead of the pivot framing.
  // The pivot note is what this test pins, so keep the mode fixed.
  const rec = recommend(state, { riskMode: 'normal' });
  // Thunder Wave is the move this turn, and the switch is the follow-up plan.
  assert.equal(rec.bestMove.move, 'Thunder Wave');
  assert.equal(rec.switchTo.species, 'Garchomp');
  assert.ok(rec.switchTo.note.startsWith('After Thunder Wave on Gliscor'));
  assert.ok(rec.reasoning.some((r) => r.includes('pivot to Garchomp next turn')));
});

test('engine: move confidence is the share vs the runner-up (100% when alone)', () => {
  const solo = makeState({
    ourActive: { species: 'Chansey', hpPercent: 100, moves: ['Thunder Wave'] },
    theirActive: { species: 'Gliscor', hpPercent: 100, moves: ['Earthquake'] },
  });
  assert.equal(recommend(solo).bestMove.confidence, 100);

  const paired = makeState({
    ourActive: { species: 'Charizard', hpPercent: 100, moves: ['Fire Blast', 'Air Slash'] },
    theirActive: { species: 'Ferrothorn', hpPercent: 100, moves: ['Gyro Ball'] },
  });
  const rec = recommend(paired);
  // Fire Blast (4× vs Grass/Steel) should vastly outrank Air Slash (1×).
  assert.ok(rec.bestMove.confidence >= 80, `expected high confidence, got ${rec.bestMove.confidence}`);
  assert.ok(rec.bestMove.confidence <= 100);
});

test('engine: switch confidence never exceeds 100% even with a bad best move', () => {
  const state = makeState({
    ourActive: { species: 'Scizor', hpPercent: 30, moves: ['Bullet Punch'] }, // weak, slow, outsped
    ourBench: [{ species: 'Tyranitar', moves: ['Stone Edge'] }],
    theirActive: { species: 'Charizard', moves: ['Flamethrower', 'Air Slash', 'Fire Blast', 'Dragon Pulse'] },
  });
  const rec = recommend(state);
  assert.ok(rec.switchTo, 'the switch should be recommended');
  assert.ok(rec.switchTo.confidence <= 100, `confidence must be capped, got ${rec.switchTo.confidence}%`);
  assert.ok(rec.bestMove.confidence <= 100, 'move confidence is also capped');
});

test('engine: switch confidence is its share vs the best move', () => {
  const state = makeState({
    ourActive: { species: 'Chansey', hpPercent: 100, moves: ['Thunder Wave', 'Soft-Boiled'] },
    theirActive: { species: 'Gliscor', hpPercent: 100, moves: ['Earthquake', 'Roost'] },
    ourBench: [{ species: 'Garchomp', hpPercent: 100, moves: ['Earthquake', 'Stone Edge'] }],
  });
  const rec = recommend(state);
  assert.ok(rec.switchTo.confidence > 0 && rec.switchTo.confidence < 100, 'switch shares the split with the move');
  // When there is no move at all, the switch is the only option: 100%.
  const forced = makeState({
    ourActive: { species: 'Chansey', hpPercent: 100, moves: ['Thunder Wave'] },
    theirActive: { species: 'Gliscor', hpPercent: 100, status: 'par', moves: ['Earthquake'] },
    ourBench: [{ species: 'Garchomp', hpPercent: 100, moves: ['Earthquake'] }],
  });
  assert.equal(recommend(forced).switchTo.confidence, 100);
});

test('engine: recovery is not recommended at full HP', () => {
  const state = makeState({
    ourActive: { species: 'Empoleon', hpPercent: 100, moves: ['Roost', 'Hydro Pump', 'Ice Beam'] },
    theirActive: { species: 'Garchomp', moves: ['Earthquake'] },
  });
  const rec = recommend(state);
  assert.notEqual(rec.bestMove.move, 'Roost', 'healing at full HP is pointless');
});

test('engine: recovery scores scale with missing HP', () => {
  const low = makeState({
    ourActive: { species: 'Empoleon', hpPercent: 20, moves: ['Roost'] },
    theirActive: { species: 'Garchomp', moves: ['Earthquake'] },
  });
  const mid = makeState({
    ourActive: { species: 'Empoleon', hpPercent: 70, moves: ['Roost'] },
    theirActive: { species: 'Garchomp', moves: ['Earthquake'] },
  });
  const field = new Field();
  const evLow = evaluateMove(low.sides.p1.pokemon[0], 'Roost', low.sides.p2.pokemon[0], [low.sides.p2.pokemon[0]], 1, {}, 9, field);
  const evMid = evaluateMove(mid.sides.p1.pokemon[0], 'Roost', mid.sides.p2.pokemon[0], [mid.sides.p2.pokemon[0]], 1, {}, 9, field);
  assert.ok(evLow.score > evMid.score, `recovery should be worth more at 20% HP (${evLow.score}) than at 70% (${evMid.score})`);
});

test('engine: an out-of-PP move is not recommended and is called out', () => {
  const state = makeState({
    ourActive: { species: 'Empoleon', hpPercent: 20, moves: ['Roost', 'Hydro Pump'] },
    theirActive: { species: 'Garchomp', moves: ['Earthquake'] },
  });
  state.sides.p1.pokemon[0].movePp = { Roost: { cur: 0, max: 8 }, 'Hydro Pump': { cur: 5, max: 8 } };
  const rec = recommend(state);
  assert.notEqual(rec.bestMove.move, 'Roost', 'a 0-PP move must not be recommended');
  assert.ok(rec.reasoning.some((r) => r.includes('Roost is out of PP')));
});

test('engine: a decisively better switch is recommended even when moves are fine', () => {
  const state = makeState({
    ourActive: { species: 'Raging Bolt', hpPercent: 100, moves: ['Dragon Pulse', 'Thunderbolt'] },
    theirActive: { species: 'Garchomp', moves: ['Earthquake'] },
    ourBench: [{ species: 'Corviknight', hpPercent: 100, moves: ['Brave Bird'] }],
  });
  const rec = recommend(state);
  // Raging Bolt's best hit (Dragon Pulse, 2× dragon) is a decent move, and HP
  // is full — the old logic would never switch here. Corviknight is immune to
  // Earthquake and hits back hard, so the switch should be called out.
  assert.ok(rec.bestMove && rec.bestMove.score >= 30, `moves should be decent: ${JSON.stringify(rec.bestMove)}`);
  assert.equal(rec.switchTo.species, 'Corviknight');
  assert.ok(rec.reasoning.some((r) => r.includes('Corviknight')));
});

// ---------------------------------------------------------------------------
// Consistency with @smogon/calc
// ---------------------------------------------------------------------------

test('engine: damage numbers match @smogon/calc directly', () => {
  const state = makeState({
    ourActive: { species: 'Charizard', moves: ['Fire Blast'] },
    theirActive: { species: 'Venusaur', moves: ['Sludge Bomb'] },
  });
  const ourMon = state.sides.p1.pokemon[0];
  const theirMon = state.sides.p2.pokemon[0];

  const atk = new Pokemon(9, 'Charizard', { level: 100, nature: 'Serious', evs: { spa: 252 }, ivs: fullIvs });
  const def = new Pokemon(9, 'Venusaur', { level: 100, nature: 'Serious', evs: { hp: 252, spd: 252 }, ivs: fullIvs });
  const res = calculate(9, atk, def, new Move(9, 'Fire Blast'), new Field());
  const directMean = Math.round((res.damage.reduce((a, b) => a + b, 0) / res.damage.length / def.maxHP()) * 1000) / 10;

  // sets: false so both sides use the same flat 252-EV model — this test
  // pins wrapper-vs-library consistency, not real-set priors (covered in
  // statestimate.test.js).
  const engine = damagePercent(9, ourMon, theirMon, 'Fire Blast', new Field(), { sets: false });
  assert.equal(engine.mean, directMean);
  assert.equal(engine.effectiveness, 2); // Fire vs Grass/Poison Venusaur
});

// ---------------------------------------------------------------------------
// Switch prediction / profile plumbing
// ---------------------------------------------------------------------------

test('predictStayProb: HP-based defaults and profile override', () => {
  assert.equal(predictStayProb({ hpPercent: 90 }), 0.8);
  assert.equal(predictStayProb({ hpPercent: 40 }), 0.6);
  assert.equal(predictStayProb({ hpPercent: 20 }), 0.35);
  assert.equal(predictStayProb({ hpPercent: 20 }, { switchTendency: { atLowHp: 0.9 } }), 0.1);
});

test('predictStayProb: a just-switched-in mon is treated as a commitment', () => {
  // Low HP normally lowers the stay probability...
  assert.equal(predictStayProb({ hpPercent: 44 }), 0.6);
  assert.equal(predictStayProb({ hpPercent: 20 }), 0.35);
  // ...but they just brought this mon in this turn — they will keep it.
  assert.equal(predictStayProb({ hpPercent: 44 }, null, true), 0.9);
  assert.equal(predictStayProb({ hpPercent: 20 }, null, true), 0.9);
  // The profile's low-HP switch tendency is also skipped while they're
  // committed to the mon they just switched in.
  assert.equal(predictStayProb({ hpPercent: 20 }, { switchTendency: { atLowHp: 0.9 } }, true), 0.9);
});

test('recommend: notes when the opponent just switched and targets the new active', () => {
  const state = makeState({
    ourActive: { species: 'Iron Treads', hpPercent: 100, moves: ['Ice Spinner', 'Earthquake'] },
    theirActive: { species: 'Glimmora', hpPercent: 44, moves: ['Mortal Spin'] },
  });
  // Simulate the opponent having just switched Glimmora in this turn.
  state.sides.p2.pokemon[0].justSwitchedIn = true;
  const rec = recommend(state);
  assert.ok(
    rec.reasoning.some((r) => r.includes('They just brought in Glimmora')),
    `expected a just-switched note, got: ${JSON.stringify(rec.reasoning)}`
  );
  // The stay probability is boosted, so the move that best hits the new
  // active wins — Earthquake is 4× vs Glimmora.
  assert.equal(rec.bestMove.move, 'Earthquake');
});

test('recommend: a counter switch-in triggers a switch to the better answer', () => {
  const state = makeState({
    ourActive: { species: 'Kingambit', hpPercent: 100, moves: ['Sucker Punch', 'Iron Head'] },
    theirActive: { species: 'Garchomp', moves: ['Earthquake', 'Stone Edge'] },
    ourBench: [{ species: 'Corviknight', hpPercent: 100, moves: ['Brave Bird', 'Iron Head'] }],
  });
  const rec = recommend(state);
  // Kingambit is hit for ~60% by Earthquake and its best hit only deals ~28%
  // (and Garchomp outspeeds it); Corviknight is immune to Earthquake and
  // hits back hard — staying to chip is worse than switching.
  assert.ok(rec.bestMove, 'there should still be a move option shown');
  assert.equal(rec.switchTo.species, 'Corviknight');
  assert.ok(rec.reasoning.some((r) => r.includes('Corviknight')));
});

test('recommend: a threatening counter that resists us is a clear switch call', () => {
  const state = makeState({
    ourActive: { species: 'Garchomp', hpPercent: 100, moves: ['Earthquake', 'Stone Edge'] },
    theirActive: { species: 'Great Tusk', moves: ['Ice Spinner', 'Rapid Spin'] },
    ourBench: [{ species: 'Corviknight', hpPercent: 100, moves: ['Iron Head', 'Body Press'] }],
  });
  const rec = recommend(state);
  // Ice Spinner hits Garchomp for ~75% while Corviknight shrugs it off — the
  // switch must be recommended even though our moves are usable.
  assert.equal(rec.switchTo.species, 'Corviknight');
});

test('predictSwitchProbs: leftover probability is split by profile weights', () => {
  const team = [
    { ident: 'p2b: A', species: 'A' },
    { ident: 'p2c: B', species: 'B' },
  ];
  const probs = predictSwitchProbs({ ident: 'p2a: X', hpPercent: 100 }, team, 0.8, {
    commonSwitchIns: { A: 1, B: 3 },
  });
  const total = probs['p2b: A'] + probs['p2c: B'];
  assert.ok(Math.abs(total - 0.2) < 1e-9, `switch probability should sum to 0.2, got ${total}`);
  assert.ok(Math.abs(probs['p2c: B'] - 0.15) < 1e-9, 'B is 3x as likely as A');
});

// ---------------------------------------------------------------------------
// Real fixture
// ---------------------------------------------------------------------------

test('fixture: final state -> battle over note', () => {
  const state = parseLog(realLog);
  const rec = recommend(state);
  assert.equal(rec.bestMove, null);
  assert.equal(rec.switchTo, null);
  assert.ok(rec.note.includes('BaddyGames wins'));
});

test('fixture: mid-battle state produces a sensible move', () => {
  const lines = realLog.split('\n');
  const prefix = lines.slice(0, lines.indexOf('|turn|2')).join('\n');
  const state = parseLog(prefix);
  const rec = recommend(state);
  // Turn 1: Raging Bolt vs Great Tusk; only Dragon Pulse is revealed for us.
  assert.equal(rec.bestMove.move, 'Dragon Pulse');
  assert.ok(rec.reasoning.length > 0);
  assert.ok(rec.reasoning.some((r) => r.includes('Dragon Pulse')));
});

test('recommend: reasoning quotes the same revealed damage as the matchup Damage row', () => {
  const lines = realLog.split('\n');
  const state = parseLog(lines.slice(0, lines.indexOf('|turn|2')).join('\n'));
  const rec = recommend(state);
  const dmg = buildPanelModel(state).matchup.damage;
  assert.ok(dmg?.theirs, 'the Damage row has their best hit');
  // The reasoning line and the Damage row both come from matchupDamage — the
  // move name and figure must describe the same hit. (The bench-threat line
  // also contains 'hits your', so match the revealed-damage phrasing exactly.)
  const line = rec.reasoning.find((r) => /^Their .+ hits your .+ for ~\d/.test(r));
  assert.ok(line, `expected a revealed-damage line, got: ${JSON.stringify(rec.reasoning)}`);
  assert.ok(line.includes(dmg.theirs.move), 'the reasoning names the same move as the row');
  assert.ok(line.includes(`~${dmg.theirs.pct.toFixed(1)}%`), 'the reasoning quotes the same damage figure');
});

test('recommend: no damage claim against a predicted switch-in', () => {
  const state = makeState({
    ourActive: { species: 'Raging Bolt', moves: ['Dragon Pulse'] },
    theirActive: { species: 'Great Tusk', moves: ['Earthquake'], fainted: true },
    theirBench: [{ species: 'Corviknight', moves: ['Body Press'] }],
  });
  const rec = recommend(state);
  assert.ok(
    !rec.reasoning.some((r) => /^Their .+ hits your .+ for ~\d/.test(r)),
    'against a predicted switch-in the reasoning must not claim revealed damage'
  );
});

test('recommend: a revealed physical attacker is called out and priced accordingly', () => {
  // Their Garchomp has shown only physical moves (3-1 with one special
  // coverage move) — the engine should read it as Atk-invested and say so.
  const state = makeState({
    ourActive: { species: 'Umbreon', moves: ['Foul Play', 'Dark Pulse'] },
    theirActive: { species: 'Garchomp', hpPercent: 100, moves: ['Earthquake', 'Outrage', 'Stone Edge', 'Fire Blast'] },
  });
  const rec = recommend(state);
  assert.ok(
    rec.reasoning.some((r) => r.includes('reads as a physical attacker') && r.includes('Foul Play would punish it')),
    `expected the physical-attacker read, got: ${JSON.stringify(rec.reasoning)}`
  );
});

test('fixture: full recommendation at the last decision point (turn 22)', () => {
  const lines = realLog.split('\n');
  const prefix = lines.slice(0, lines.indexOf('|turn|22')).join('\n');
  const state = parseLog(prefix);
  const rec = recommend(state);
  assert.equal(rec.bestMove.move, 'Knock Off'); // best neutral hit vs Dragonite
  assert.ok(rec.reasoning.length > 0);
  assert.ok(
    rec.reasoning.some((r) => /unknown move|not yet revealed|hidden/.test(r)),
    'should flag Dragonite\'s hidden moves'
  );
});

// ---------------------------------------------------------------------------
// Tera
// ---------------------------------------------------------------------------

test('damagePercent is tera-aware for a terastallized defender', () => {
  const garchomp = createPokemon({ ident: 'p1a: Garchomp', side: 'p1', species: 'Garchomp' });
  addMove(garchomp, 'Earthquake');
  const dragonite = createPokemon({ ident: 'p2a: Dragonite', side: 'p2', species: 'Dragonite' });
  dragonite.terastallized = true;
  dragonite.teraType = 'Grass';
  const d = damagePercent(9, garchomp, dragonite, 'Earthquake', new Field());
  assert.equal(d.effectiveness, 0.5); // Earthquake vs a tera-Grass defender
  assert.ok(d.mean < 50, `expected a resisted hit, got ${d.mean}%`);
});

test('attackerTera simulation boosts STAB in damagePercent', () => {
  const garchomp = createPokemon({ ident: 'p1a: Garchomp', side: 'p1', species: 'Garchomp' });
  addMove(garchomp, 'Fire Blast');
  const scizor = createPokemon({ ident: 'p2a: Scizor', side: 'p2', species: 'Scizor' });
  const plain = damagePercent(9, garchomp, scizor, 'Fire Blast', new Field());
  const tera = damagePercent(9, garchomp, scizor, 'Fire Blast', new Field(), { attackerTera: 'Fire' });
  assert.equal(plain.effectiveness, 4); // Fire vs Bug/Steel
  assert.ok(tera.mean > plain.mean, `tera STAB should boost damage (${tera.mean} vs ${plain.mean})`);
});

test('recommend suggests terastallizing when it meaningfully improves our options', () => {
  const state = makeState({
    ourActive: { species: 'Garchomp', moves: ['Fire Blast', 'Earthquake'], teraType: 'Fire', canTera: true },
    theirActive: { species: 'Scizor', moves: ['Bullet Punch', 'U-turn', 'Swords Dance', 'Roost'] },
  });
  const rec = recommend(state);
  assert.ok(
    rec.reasoning.some((r) => r.includes('terastalliz')),
    `expected a tera suggestion, got: ${JSON.stringify(rec.reasoning)}`
  );
});

test('recommend does not suggest tera when canTera is unknown (replay/log state)', () => {
  const state = makeState({
    ourActive: { species: 'Garchomp', moves: ['Fire Blast'], teraType: 'Fire' }, // canTera unknown
    theirActive: { species: 'Scizor', moves: ['Bullet Punch'] },
  });
  const rec = recommend(state);
  assert.ok(!rec.reasoning.some((r) => r.includes('terastalliz')));
});

test('recommend notes when the opponent has terastallized', () => {
  const state = makeState({
    ourActive: { species: 'Togekiss', moves: ['Air Slash', 'Roost'] },
    theirActive: { species: 'Dragonite', moves: ['Outrage', 'Earthquake'], teraType: 'Grass', terastallized: true },
  });
  const rec = recommend(state);
  assert.ok(
    rec.reasoning.some((r) => r.includes('terastallized') && r.includes('Grass')),
    `expected a tera note, got: ${JSON.stringify(rec.reasoning)}`
  );
});

test('recommend warns about a specific hidden-move threat', () => {
  const state = makeState({
    ourActive: { species: 'Flutter Mane', moves: ['Moonblast', 'Shadow Ball', 'Calm Mind'] },
    theirActive: { species: 'Glimmora', moves: ['Mortal Spin'] }, // only 1/4 revealed
  });
  const rec = recommend(state);
  const threat = rec.reasoning.find((r) => r.includes('not yet revealed'));
  assert.ok(threat, `expected a hidden-threat warning, got: ${JSON.stringify(rec.reasoning)}`);
  assert.ok(!threat.includes('Mortal Spin'), 'revealed moves must not appear as hidden threats');
});

test('recommend uses observed move order to resolve a close speed matchup', () => {
  // Raging Bolt (base 85) vs Great Tusk (base 85) — identical ranges, so the
  // engine would normally hedge "Speed is close". But the log showed Great
  // Tusk acting first, and nothing speed-affecting has changed since.
  const state = makeState({
    ourActive: { species: 'Raging Bolt', moves: ['Thunderclap', 'Dragon Pulse'] },
    theirActive: { species: 'Great Tusk', moves: ['Earthquake', 'Ice Spinner'] },
  });
  const ours = state.sides.p1.pokemon[0];
  const theirs = state.sides.p2.pokemon[0];
  state.speedEvidence.push({
    turn: 1,
    fasterSide: 'p2',
    p1Ident: ours.ident,
    p2Ident: theirs.ident,
    p1Move: 'Dragon Pulse',
    p2Move: 'Earthquake',
    clean: true,
    trickRoom: false,
    ver: { p1: 0, p2: 0, field: 0, side1: 0, side2: 0 },
  });
  const rec = recommend(state, { ourSideId: 'p1' });
  const line = rec.reasoning.find((r) => r.includes('outspeeds'));
  assert.ok(line, `expected an observed speed line, got: ${JSON.stringify(rec.reasoning)}`);
  assert.match(line, /observed: it moved first when you last traded moves/);
});

test('recommend: a Choice-locked mon is only advised to use its locked move', () => {
  const state = makeState({
    ourActive: { species: 'Garchomp', moves: ['Outrage', 'Earthquake', 'Swords Dance'], item: 'Choice Band' },
    theirActive: { species: 'Corviknight', moves: ['Body Press'] },
  });
  // The reader sets this after the first move use; simulate it here.
  state.sides.p1.pokemon.find((m) => m.species === 'Garchomp').lockedMove = 'Outrage';
  const rec = recommend(state);
  assert.equal(rec.bestMove.move, 'Outrage', 'only the locked move may be recommended');
  assert.ok(
    rec.reasoning.some((r) => r.includes('locked into Outrage') && r.includes("can't be used")),
    'the lock is explained and the unusable moves flagged'
  );
});

test('recommend: notes when the opponent is Choice-locked (expect the repeat)', () => {
  const state = makeState({
    ourActive: { species: 'Garchomp', moves: ['Outrage'] },
    theirActive: { species: 'Corviknight', moves: ['Body Press'], item: 'Choice Band' },
  });
  state.sides.p2.pokemon.find((m) => m.species === 'Corviknight').lockedMove = 'Body Press';
  const rec = recommend(state);
  assert.ok(
    rec.reasoning.some((r) => r.includes('locked into Body Press')),
    `expected a their-lock note, got: ${JSON.stringify(rec.reasoning)}`
  );
});

// ---------------------------------------------------------------------------
// Tier 1a: entry hazards & screens
// ---------------------------------------------------------------------------

test('hazardDamageOnEntry: Stealth Rock by type effectiveness, Spikes by layer', () => {
  const sr = { effects: { 'Stealth Rock': true } };
  // Charizard (Fire/Flying): Rock is 2x vs Fire and 2x vs Flying → 4x → 50%.
  assert.equal(hazardDamageOnEntry({ species: 'Charizard' }, sr, 9), 50);
  // Corviknight (Flying/Steel): 2x (Flying) × 0.5 (Steel) → 1x → 12.5%.
  assert.equal(hazardDamageOnEntry({ species: 'Corviknight' }, sr, 9), 12.5);
  // Corviknight with Heavy-Duty Boots is immune — the reader records no
  // damage, so a boots-carrying mon is charged 0.
  assert.equal(hazardDamageOnEntry({ species: 'Corviknight', item: 'Heavy-Duty Boots' }, sr, 9), 12.5);
  const spikes = { effects: { Spikes: 2 } };
  assert.equal(hazardDamageOnEntry({ species: 'Garchomp' }, spikes, 9), 16.7); // 2 layers = 1/6 (rounded)
  // No hazards → nothing.
  assert.equal(hazardDamageOnEntry({ species: 'Garchomp' }, { effects: {} }, 9), 0);
});

test('entryHazardNotes: Sticky Web slowdown and Toxic Spikes poison on entry', () => {
  const web = { effects: { 'Sticky Web': true } };
  const note = entryHazardNotes({ species: 'Garchomp' }, web, 9);
  assert.ok(note && note.includes('slowed by Sticky Web'), `got: ${note}`);
  // Flying types (and Levitate) are not grounded — no slowdown.
  assert.equal(entryHazardNotes({ species: 'Corviknight' }, web, 9), null);
  const ts = { effects: { 'Toxic Spikes': 1 } };
  const tsNote = entryHazardNotes({ species: 'Garchomp' }, ts, 9);
  assert.ok(tsNote && tsNote.includes('poisoned'), `got: ${tsNote}`);
  assert.ok(entryHazardNotes({ species: 'Gengar' }, ts, 9).includes('absorbs'), 'Poison types absorb Toxic Spikes');
});

test('recommend: hazards are charged into switch evaluation and called out', () => {
  const makeHazardState = (srUp) => {
    const st = makeState({
      ourActive: { species: 'Charizard', hpPercent: 30, moves: ['Flamethrower', 'Air Slash', 'Roost'] },
      ourBench: [{ species: 'Rillaboom', hpPercent: 100, moves: ['Wood Hammer', 'Grassy Glide', 'Knock Off'] }],
      theirActive: { species: 'Garchomp', hpPercent: 100, moves: ['Earthquake', 'Outrage', 'Fire Fang'] },
    });
    if (srUp) st.sides.p1.effects = { 'Stealth Rock': true };
    return st;
  };
  const withSR = recommend(makeHazardState(true));
  assert.ok(withSR.switchTo, 'the switch should still be recommended');
  assert.ok(
    withSR.switchTo.note.includes('hazards on entry'),
    `the SR cost should be called out, got: ${withSR.switchTo.note}`
  );
  const withoutSR = recommend(makeHazardState(false));
  assert.ok(
    !withoutSR.switchTo.note.includes('hazards on entry'),
    'no hazards → no hazard charge mentioned'
  );
  // Rillaboom is not weak to Rock, so SR costs it 12.5% — the note states it.
  assert.ok(withSR.switchTo.note.includes('12.5%'), `got: ${withSR.switchTo.note}`);
});

// ---------------------------------------------------------------------------
// Tier 1b: residual damage
// ---------------------------------------------------------------------------

test('chipPerTurn: burn/poison drain, Leftovers heals, sand/snow spare immune types', () => {
  assert.equal(chipPerTurn({ species: 'Garchomp', status: 'brn' }, 9, null), -6.2);
  assert.equal(chipPerTurn({ species: 'Garchomp', status: 'psn' }, 9, null), -6.2);
  assert.equal(chipPerTurn({ species: 'Corviknight', item: 'Leftovers', itemRevealed: true }, 9, null), 6.3);
  // Sandstorm chips everything but Rock/Ground/Steel.
  assert.equal(chipPerTurn({ species: 'Garchomp' }, 9, { weather: 'Sandstorm' }), 0); // Ground
  assert.equal(chipPerTurn({ species: 'Corviknight' }, 9, { weather: 'Sandstorm' }), 0); // Steel
  assert.equal(chipPerTurn({ species: 'Gengar' }, 9, { weather: 'Sandstorm' }), -6.2);
  // Hail/Snow chips everything but Ice.
  assert.equal(chipPerTurn({ species: 'Glaceon' }, 9, { weather: 'Snow' }), 0);
  assert.equal(chipPerTurn({ species: 'Garchomp' }, 9, { weather: 'Snow' }), -6.2);
});

test('evaluateMove: burn chip turns a non-KO hit into a KO and is called out', () => {
  // Great Tusk Earthquake vs Garchomp rolls 32.1-37.9%. At exactly 40% HP a
  // fresh target survives; a burned one (chip 6.25%/turn) dies to the chip.
  const mk = (hpPercent, status) => ({
    ident: hpPercent === 40 ? 'p2a: Garchomp' : 'p2a: Garchomp',
    side: 'p2',
    species: 'Garchomp',
    hpPercent,
    moves: ['Earthquake'],
    ...(status ? { status } : {}),
  });
  const atk = { ident: 'p1a: Great Tusk', side: 'p1', species: 'Great Tusk', hpPercent: 100, moves: ['Earthquake', 'Headlong Rush'] };
  const fresh = evaluateMove(atk, 'Earthquake', mk(40, null), [mk(40, null)], 1, {}, 9, new Field());
  assert.equal(fresh.ko, false, 'without chip the hit does not KO at 40%');
  const burned = evaluateMove(atk, 'Earthquake', mk(40, 'brn'), [mk(40, 'brn')], 1, {}, 9, new Field());
  assert.equal(burned.ko, true, 'with burn chip the same hit becomes a KO');
  assert.ok(burned.note.includes('chip finishes it'), `note should credit the chip, got: ${burned.note}`);
});

// ---------------------------------------------------------------------------
// Tier 2a: threat-based switch prediction (the double)
// ---------------------------------------------------------------------------

test('moveConditionalSwitchProbs: resists/immunities draw the switch, 4x-weak mons shed it', () => {
  const team = [
    { ident: 'p2b: Landorus', species: 'Landorus' },
    { ident: 'p2c: Charizard', species: 'Charizard' },
    { ident: 'p2d: Garchomp', species: 'Garchomp' },
  ];
  const base = { 'p2b: Landorus': 0.06, 'p2c: Charizard': 0.06, 'p2d: Garchomp': 0.06 };
  const total = 0.18;

  const eq = moveConditionalSwitchProbs('Earthquake', base, team, 9, null, {});
  const eqSum = Object.values(eq).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(eqSum - total) < 0.01, `total switch mass must be preserved (${eqSum})`);
  // Landorus and Charizard are both immune to Ground (Flying) — they draw the
  // switch; Garchomp is neutral so its share drops.
  assert.ok(eq['p2b: Landorus'] > 0.06, 'the immune mon becomes the likely switch-in');
  assert.ok(eq['p2c: Charizard'] > 0.06, 'the other Flying type also draws the double');
  assert.ok(eq['p2d: Garchomp'] < 0.06, 'a neutral mon sheds probability to the answers');

  const ice = moveConditionalSwitchProbs('Ice Beam', base, team, 9, null, {});
  // Charizard (Fire/Flying) resists Ice 0.5x — it becomes the natural answer;
  // Landorus and Garchomp are 4x weak and would never be sent in.
  assert.ok(ice['p2c: Charizard'] > 0.12, 'the Ice-resisting mon draws the double');
  assert.ok(ice['p2b: Landorus'] < 0.03 && ice['p2d: Garchomp'] < 0.03, '4x-weak mons shed the switch');
});

test('recommend: clicking a move weights the reactive switch-in answer', () => {
  // If we click Earthquake, the opponent's Landorus (immune) is the natural
  // switch-in — the engine should weight that read into the move's score
  // rather than treating the bench split as fixed.
  const state = makeState({
    ourActive: { species: 'Great Tusk', hpPercent: 100, moves: ['Earthquake', 'Ice Spinner', 'Headlong Rush'] },
    theirActive: { species: 'Gliscor', hpPercent: 70, moves: ['Earthquake', 'Roost'] },
    theirBench: [{ species: 'Landorus', hpPercent: 100, moves: ['Earth Power', 'U-turn'] }],
  });
  const rec = recommend(state);
  // The conditional read must actually run (no crash) and produce advice.
  assert.ok(rec.bestMove, 'a move should still be recommended');
});

// ---------------------------------------------------------------------------
// Tier 2b/2c/2d: win conditions, setup sweeps, endgame locks
// ---------------------------------------------------------------------------

test('teamWincon: the mon that threatens the most of the opposing team wins', () => {
  const ourTeam = [
    { ident: 'p1a: Rillaboom', species: 'Rillaboom', hpPercent: 100, moves: ['Wood Hammer', 'Knock Off'] },
    { ident: 'p1b: Clefable', species: 'Clefable', hpPercent: 100, moves: ['Moonblast', 'Stealth Rock'] },
  ];
  const theirTeam = [
    { ident: 'p2a: Garchomp', species: 'Garchomp', hpPercent: 100, moves: ['Earthquake'] },
    { ident: 'p2b: Wobbuffet', species: 'Wobbuffet', hpPercent: 100, moves: ['Counter', 'Mirror Coat'] },
  ];
  const wincon = teamWincon(ourTeam, theirTeam, 9, null, {});
  assert.ok(wincon && wincon.mon.species === 'Clefable', 'Clefable threatens both opposing mons super effectively');
  assert.ok(wincon.value > 0);
});

test('sweepPotential: boosted damage counts 1HKOs and 2HKOs of the remaining team', () => {
  const rill = { ident: 'p1a: Rillaboom', species: 'Rillaboom', hpPercent: 100, moves: ['Wood Hammer', 'Knock Off', 'Swords Dance'] };
  const opp = [
    { ident: 'p2a: Landorus', species: 'Landorus', hpPercent: 100 },
    { ident: 'p2b: Garchomp', species: 'Garchomp', hpPercent: 100 },
    { ident: 'p2c: Corviknight', species: 'Corviknight', hpPercent: 100 },
  ];
  const base = sweepPotential(rill, opp, 9, null, {}, 0);
  const boosted = sweepPotential(rill, opp, 9, null, {}, 2);
  assert.ok(boosted.score > base.score, `+2 should unlock more of the team (${base.score} → ${boosted.score})`);
  assert.ok(boosted.move, 'the boosted best move is named');
});

test('recommend: setup is recommended when the sweep is real and the active is walled', () => {
  // Garchomp at full HP: Wood Hammer 2HKOs it, so the boost first (then
  // 2HKO everything) is the call. (At 40% HP Wood Hammer guaranteed-KOs it
  // AND Knock Off beats the likely Dragapult switch-in — the 2-ply response
  // engine correctly prefers that KO, so the setup demo needs a target that
  // survives the first hit.)
  const state = makeState({
    ourActive: { species: 'Rillaboom', hpPercent: 70, moves: ['Wood Hammer', 'Grassy Glide', 'Knock Off', 'Swords Dance'] },
    ourBench: [{ species: 'Corviknight', hpPercent: 100, moves: ['Roost', 'Brave Bird', 'Body Press'] }],
    theirActive: { species: 'Garchomp', hpPercent: 100, status: 'brn', moves: ['Earthquake', 'Outrage', 'Fire Fang'] },
    theirBench: [{ species: 'Dragapult', hpPercent: 100, moves: ['Draco Meteor', 'Shadow Ball'] }],
  });
  const rec = recommend(state, { ourSideId: 'p1' });
  assert.equal(rec.bestMove.move, 'Swords Dance', 'the setup into a sweep should be the call');
  const line = rec.reasoning.find((r) => r.includes('setup:'));
  assert.ok(line && line.includes('1HKOs'), `setup reasoning should quantify the sweep, got: ${line}`);
});

test('recommend: at low HP with the KO already on the table, take the KO instead of setting up', () => {
  // Garchomp @20% vs Heatran @30%: Earthquake is 4x and guaranteed — Swords
  // Dance would waste the turn and hand them the free hit. (Healthy, the same
  // setup can be the sweep — that's the test above; this is the low-HP case.)
  const state = makeState({
    ourActive: { species: 'Garchomp', hpPercent: 20, moves: ['Swords Dance', 'Earthquake'] },
    theirActive: { species: 'Heatran', hpPercent: 30, moves: ['Lava Plume'] },
  });
  const rec = recommend(state);
  assert.equal(rec.bestMove.move, 'Earthquake', 'finish the low target instead of boosting');
  assert.ok(rec.bestMove.note.includes('guaranteed KO'), `got: ${rec.bestMove.note}`);
  const atk = state.sides.p1.pokemon[0];
  const tgt = state.sides.p2.pokemon[0];
  const sd = evaluateMove(atk, 'Swords Dance', tgt, [tgt], 1, {}, 9, null);
  assert.ok(sd.note.includes('just take the KO'), `setup should say to take the KO, got: ${sd.note}`);
});

test('recommend: setup at low HP is risky even when the KO is not available (they 2HKO us)', () => {
  // Garchomp @30% vs Blissey: Seismic Toss chips ~24%/turn, so they 2HKO us
  // and the boost needs a second turn we don't have — setup is deflated as
  // risky, not recommended. (At 20% they'd 1HKO us, which the one-shot branch
  // already covers.)
  const state = makeState({
    ourActive: { species: 'Garchomp', hpPercent: 30, moves: ['Swords Dance', 'Earthquake'] },
    theirActive: { species: 'Blissey', hpPercent: 100, moves: ['Seismic Toss'] },
  });
  const rec = recommend(state);
  assert.equal(rec.bestMove.move, 'Earthquake', 'attack — we do not have a free turn to boost');
  const atk = state.sides.p1.pokemon[0];
  const tgt = state.sides.p2.pokemon[0];
  const sd = evaluateMove(atk, 'Swords Dance', tgt, [tgt], 1, {}, 9, null);
  assert.ok(sd.note.includes('risky'), `setup should be flagged risky at low HP, got: ${sd.note}`);
  assert.ok(sd.note.includes('finishes you'), `the note should name the 2HKO problem, got: ${sd.note}`);
});

test('recommend: endgame locks and win-condition reads appear in reasoning', () => {
  const state = makeState({
    ourActive: { species: 'Rillaboom', hpPercent: 70, moves: ['Wood Hammer', 'Grassy Glide', 'Knock Off'] },
    ourBench: [{ species: 'Corviknight', hpPercent: 100, moves: ['Roost', 'Brave Bird', 'Body Press'] }],
    theirActive: { species: 'Garchomp', hpPercent: 40, status: 'brn', moves: ['Earthquake', 'Outrage', 'Fire Fang'] },
    theirBench: [{ species: 'Dragapult', hpPercent: 100, moves: ['Draco Meteor', 'Shadow Ball'] }],
  });
  state.turn = 8;
  const rec = recommend(state, { ourSideId: 'p1' });
  assert.ok(
    rec.reasoning.some((r) => r.includes('locked in')),
    `expected an endgame lock line, got: ${JSON.stringify(rec.reasoning)}`
  );
  assert.ok(
    rec.reasoning.some((r) => r.includes('win condition')),
    `expected a win-condition read, got: ${JSON.stringify(rec.reasoning)}`
  );

  // The lock list itself: Rillaboom 1HKOs the burned 40% Garchomp while
  // taking a 4HKO back — a locked win for us.
  const locks = endgameLocks(state.sides.p1.pokemon, state.sides.p2.pokemon, 9, new Field(), {}, state, 'p1');
  const vsChomp = locks.find((l) => l.ours === 'Rillaboom' && l.theirs === 'Garchomp');
  assert.equal(vsChomp.verdict, 'win');
  assert.equal(vsChomp.ourTurns, 1);
});

// ---------------------------------------------------------------------------
// Risk modes (safe / normal / aggressive)
// ---------------------------------------------------------------------------

test('boardAdvantage: remaining HP plus a per-body bonus', () => {
  const team = (hpList) => hpList.map((hp) => ({ hpPercent: hp }));
  // Even teams: identical HP and counts.
  assert.equal(boardAdvantage(team([100, 100]), team([100, 100])), 0);
  // One extra full body on our side: +100 HP plus +40 per-body bonus.
  assert.equal(boardAdvantage(team([100, 100, 100]), team([100, 100])), 140);
  // Same count, we're healthier.
  assert.equal(boardAdvantage(team([100, 50]), team([50, 50])), 50);
  // Unknown HP counts as full (the default at battle start).
  assert.equal(boardAdvantage(team([100]), team([null])), 0);
});

test('resolveRiskMode: auto derives from the board, explicit modes win', () => {
  assert.equal(resolveRiskMode({}, 0), 'normal');
  assert.equal(resolveRiskMode({}, 99), 'normal');
  assert.equal(resolveRiskMode({}, 100), 'safe');
  assert.equal(resolveRiskMode({}, 500), 'safe');
  assert.equal(resolveRiskMode({}, -100), 'aggressive');
  assert.equal(resolveRiskMode({}, -500), 'aggressive');
  // Explicit modes override the board read.
  assert.equal(resolveRiskMode({ riskMode: 'safe' }, -500), 'safe');
  assert.equal(resolveRiskMode({ riskMode: 'aggressive' }, 500), 'aggressive');
  assert.equal(resolveRiskMode({ riskMode: 'normal' }, 500), 'normal');
});

test('recommend: auto picks safe when clearly ahead, aggressive when behind', () => {
  const ahead = makeState({
    ourActive: { species: 'Garchomp', hpPercent: 100, moves: ['Earthquake', 'Dragon Claw'] },
    ourBench: [{ species: 'Corviknight', hpPercent: 100, moves: ['Brave Bird'] }],
    theirActive: { species: 'Gliscor', hpPercent: 10, moves: ['Earthquake'] },
  });
  const ra = recommend(ahead);
  assert.equal(ra.risk.mode, 'safe');
  assert.ok(ra.risk.advantage >= 100, `advantage should be a clear lead, got ${ra.risk.advantage}`);
  assert.ok(
    ra.reasoning.some((r) => r.includes('ahead') && r.includes('playing safe')),
    `expected a safe-mode line, got: ${JSON.stringify(ra.reasoning)}`
  );

  const behind = makeState({
    ourActive: { species: 'Garchomp', hpPercent: 10, moves: ['Earthquake'] },
    theirActive: { species: 'Gliscor', hpPercent: 100, moves: ['Earthquake', 'Roost'] },
    theirBench: [{ species: 'Landorus', hpPercent: 100, moves: ['Earth Power'] }],
  });
  const rb = recommend(behind);
  assert.equal(rb.risk.mode, 'aggressive');
  assert.ok(rb.risk.advantage <= -100, `advantage should be a clear deficit, got ${rb.risk.advantage}`);
  assert.ok(
    rb.reasoning.some((r) => r.includes('behind') && r.includes('playing aggressive')),
    `expected an aggressive-mode line, got: ${JSON.stringify(rb.reasoning)}`
  );

  // Even board -> balanced, no mode line at all.
  const even = makeState({
    ourActive: { species: 'Garchomp', hpPercent: 100, moves: ['Earthquake'] },
    theirActive: { species: 'Gliscor', hpPercent: 100, moves: ['Earthquake'] },
  });
  const re = recommend(even);
  assert.equal(re.risk.mode, 'normal');
  assert.ok(!re.reasoning.some((r) => r.includes('playing ')), 'balanced play adds no mode line');
});

// Positional win-probability eval (game-level "who wins" read)
// ---------------------------------------------------------------------------

const plainMon = (species, hpPercent = 100, moves = []) => {
  const m = createPokemon({ ident: 'x', side: 'p1', species, level: 100 });
  m.hpPercent = hpPercent;
  for (const mv of moves) addMove(m, mv);
  return m;
};

test('positionalWinProb: material dominance reads ahead, even boards hover near 0.5', () => {
  const field = buildField(createBattleState());
  const garchomp = plainMon('Garchomp', 100, ['Earthquake']);
  const gliscor = plainMon('Gliscor', 100, ['Earthquake']);
  // Even 1v1 hovers near even (the contrived EQ-vs-Gliscor immunity drags it
  // a little below 0.5, but nowhere near a mode threshold).
  const even = positionalWinProb([garchomp], [gliscor], 9, field, {}, { active: { ours: garchomp, theirs: gliscor } });
  assert.ok(even.winProb > 0.34 && even.winProb < 0.66, `even board should hover near 0.5, got ${even.winProb}`);

  // Three full mons vs one at 10% HP is a decided game.
  const three = [plainMon('Garchomp'), plainMon('Corviknight', 100, ['Brave Bird']), plainMon('Blissey', 100, ['Seismic Toss'])];
  const one = plainMon('Gliscor', 10, ['Earthquake']);
  const threeToOne = positionalWinProb(three, [one], 9, field, {}, { active: { ours: three[0], theirs: one } });
  assert.ok(threeToOne.winProb >= 0.66, `3v1 should read as a clear lead, got ${threeToOne.winProb}`);

  // And the mirror is a clear deficit.
  const oneVsThree = positionalWinProb([one], three, 9, field, {}, { active: { ours: one, theirs: three[0] } });
  assert.ok(oneVsThree.winProb <= 0.34, `1v3 should read as a clear deficit, got ${oneVsThree.winProb}`);
});

test('positionalWinProb: firepower, speed and the active 1v1 tilt an even-HP board', () => {
  const field = buildField(createBattleState());
  // Same HP, same body count — but one side is pure walls and the other
  // sweeps it. Position alone has to call that game.
  const walls = [plainMon('Blissey', 100, ['Thunder Wave']), plainMon('Ferrothorn', 100, ['Leech Seed'])];
  const sweepers = [plainMon('Iron Treads', 100, ['Ice Spinner', 'Iron Head']), plainMon('Garchomp', 100, ['Earthquake', 'Outrage'])];
  const behind = positionalWinProb(walls, sweepers, 9, field, {}, { active: { ours: walls[0], theirs: sweepers[0] } });
  assert.ok(behind.winProb <= 0.34, `walls vs sweepers should read behind, got ${behind.winProb}`);
  const ahead = positionalWinProb(sweepers, walls, 9, field, {}, { active: { ours: sweepers[0], theirs: walls[0] } });
  assert.ok(ahead.winProb >= 0.66, `sweepers vs walls should read ahead, got ${ahead.winProb}`);
});

test('positionalWinProb: hazards and recovery move the read', () => {
  const field = buildField(createBattleState());
  const a = plainMon('Garchomp', 100, ['Earthquake']);
  const b = plainMon('Gliscor', 100, ['Earthquake']);
  const act = { active: { ours: a, theirs: b } };
  const base = positionalWinProb([a], [b], 9, field, {}, act);
  const theirHazards = positionalWinProb([a], [b], 9, field, {}, { ...act, hazards: { ours: 0, theirs: 2 } });
  assert.ok(theirHazards.winProb > base.winProb, 'their hazards hurt them → we read ahead');
  const ourHazards = positionalWinProb([a], [b], 9, field, {}, { ...act, hazards: { ours: 2, theirs: 0 } });
  assert.ok(ourHazards.winProb < base.winProb, 'our hazards hurt us → we read behind');

  // A recovery move at missing HP is worth real value over the same board
  // without it.
  const low = plainMon('Toxapex', 40, ['Recover', 'Liquidation']);
  const lowNoRec = plainMon('Toxapex', 40, ['Liquidation']);
  const them = plainMon('Gliscor', 40, ['Earthquake']);
  const withRec = positionalWinProb([low], [them], 9, field, {}, { active: { ours: low, theirs: them } });
  const noRec = positionalWinProb([lowNoRec], [them], 9, field, {}, { active: { ours: lowNoRec, theirs: them } });
  assert.ok(withRec.winProb > noRec.winProb, 'recovery at missing HP reads ahead of the same board without it');
});

test('positionalWinProb: their active being down is a tempo swing', () => {
  const field = buildField(createBattleState());
  const a = plainMon('Garchomp', 100, ['Earthquake']);
  const b = plainMon('Gliscor', 100, ['Earthquake']);
  const down = positionalWinProb([a], [b], 9, field, {}, { active: { ours: a, theirs: null } });
  const up = positionalWinProb([a], [b], 9, field, {}, { active: { ours: a, theirs: b } });
  assert.ok(down.winProb > up.winProb, 'their active down → tempo in our favor');
});

test('resolveRiskMode: the win-probability read resolves the band edges, explicit wins', () => {
  // Even HP but the position is decided → the read decides the mode.
  assert.equal(resolveRiskMode({}, 0, 0.7), 'safe');
  assert.equal(resolveRiskMode({}, 0, 0.3), 'aggressive');
  assert.equal(resolveRiskMode({}, 0, 0.5), 'normal');
  // The raw HP advantage still resolves when the read is inconclusive.
  assert.equal(resolveRiskMode({}, 100, 0.5), 'safe');
  assert.equal(resolveRiskMode({}, -100, 0.5), 'aggressive');
  // An explicit mode beats both reads.
  assert.equal(resolveRiskMode({ riskMode: 'normal' }, 500, 0.9), 'normal');
  assert.equal(resolveRiskMode({ riskMode: 'safe' }, -500, 0.1), 'safe');
});

test('recommend: auto flips to aggressive on position alone (even HP, their team sweeps)', () => {
  const state = makeState({
    ourActive: { species: 'Blissey', hpPercent: 90, moves: ['Thunder Wave'] },
    ourBench: [{ species: 'Ferrothorn', hpPercent: 90, moves: ['Leech Seed'] }],
    theirActive: { species: 'Iron Treads', hpPercent: 100, moves: ['Ice Spinner', 'Iron Head'] },
    theirBench: [{ species: 'Garchomp', hpPercent: 100, moves: ['Earthquake', 'Outrage'] }],
  });
  const rec = recommend(state);
  assert.equal(rec.risk.mode, 'aggressive');
  assert.ok(rec.risk.advantage > -100 && rec.risk.advantage < 100, 'the HP board alone would read normal');
  assert.ok(rec.risk.winProb <= 34, `the win read should be clearly behind, got ${rec.risk.winProb}`);
  assert.ok(
    rec.reasoning.some((r) => r.includes('playing aggressive') && r.includes('% to win')),
    `expected an aggressive line with the win read, got: ${JSON.stringify(rec.reasoning)}`
  );
});

test('recommend: auto flips to safe on position alone (even HP, we sweep)', () => {
  const state = makeState({
    ourActive: { species: 'Iron Treads', hpPercent: 100, moves: ['Ice Spinner', 'Iron Head'] },
    ourBench: [{ species: 'Garchomp', hpPercent: 100, moves: ['Earthquake', 'Outrage'] }],
    theirActive: { species: 'Blissey', hpPercent: 90, moves: ['Thunder Wave'] },
    theirBench: [{ species: 'Ferrothorn', hpPercent: 90, moves: ['Leech Seed'] }],
  });
  const rec = recommend(state);
  assert.equal(rec.risk.mode, 'safe');
  assert.ok(rec.risk.winProb >= 66, `the win read should be clearly ahead, got ${rec.risk.winProb}`);
  assert.ok(
    rec.reasoning.some((r) => r.includes('playing safe') && r.includes('% to win')),
    `expected a safe line with the win read, got: ${JSON.stringify(rec.reasoning)}`
  );
});

test('recommend: the switch bar is tempered by position in auto mode, untouched with explicit modes', () => {
  // A decided 3v1: auto reads safe (winProb ≥ 0.66) and tightens the switch
  // bar to preserve the lead; explicit safe keeps its exact threshold.
  const state = makeState({
    ourActive: { species: 'Garchomp', hpPercent: 100, moves: ['Earthquake'] },
    ourBench: [
      { species: 'Corviknight', hpPercent: 100, moves: ['Brave Bird'] },
      { species: 'Blissey', hpPercent: 100, moves: ['Seismic Toss'] },
    ],
    theirActive: { species: 'Gliscor', hpPercent: 10, moves: ['Earthquake'] },
  });
  const auto = recommend(state);
  assert.equal(auto.risk.mode, 'safe');
  assert.equal(auto.risk.switchBar, 6, 'deep ahead, the bar tightens (safe 8 × 0.75)');
  const explicit = recommend(state, { riskMode: 'safe' });
  assert.equal(explicit.risk.switchBar, 8, 'explicit modes keep their exact thresholds');
});

// 2-ply opponent response engine (Phase 4)
// ---------------------------------------------------------------------------

// The response engine looks at the turn after each candidate move: if it
// doesn't KO, what does their active do back (KO us, set up, or nothing)? If
// it does KO, what comes in and can we handle it? Each branch is pinned below
// with the votes it produces.

const respMon = (species, hpPercent = 100, moves = [], ident = 'x') => {
  const m = createPokemon({ ident, side: 'p1', species, level: 100 });
  m.hpPercent = hpPercent;
  for (const mv of moves) addMove(m, mv);
  return m;
};
const respField = buildField(createBattleState());

const evalResp = (us, moveName, them, bench = [], switchProbs = {}) =>
  evaluateMove(us, moveName, them, [them, ...bench], 1, switchProbs, 9, respField, {});

test('evaluateMove: the 2-ply engine penalizes a move that lets their active KO us back', () => {
  // Seismic Toss (~31%, fixed) can't finish a full Dragonite; its Outrage
  // KOs our 30% Blissey the turn after — a losing trade even if we move
  // first.
  const us = respMon('Blissey', 30, ['Seismic Toss']);
  const them = respMon('Dragonite', 100, ['Outrage']);
  const ev = evalResp(us, 'Seismic Toss', them);
  assert.ok(ev.votes.response < 0, `the KO-back should read as a bad trade, got ${ev.votes.response}`);
  assert.ok(ev.note.includes('KOs you back'), `the note names the counter, got: ${ev.note}`);
});

test('evaluateMove: the 2-ply engine penalizes a move that lets their active set up', () => {
  // Earthquake is immune vs Dragonite (no KO); it survives and Dragon Dance
  // is revealed and unused — the sweep is coming.
  const us = respMon('Garchomp', 100, ['Earthquake']);
  const them = respMon('Dragonite', 100, ['Dragon Dance', 'Outrage']);
  const ev = evalResp(us, 'Earthquake', them);
  assert.ok(ev.votes.response < 0, `the setup reply should be penalized, got ${ev.votes.response}`);
  assert.ok(ev.note.includes('sets up (Dragon Dance revealed)'), `the note names the setup, got: ${ev.note}`);
  // No setup move, no KO-back, no weak reply → no response vote at all.
  // (Their Garchomp's EQ trades ~33% back — mid-threat, not punishable-free
  // and not a KO.)
  const neutral = respMon('Garchomp', 100, ['Earthquake']);
  const ev2 = evalResp(us, 'Earthquake', neutral);
  assert.equal(ev2.votes.response, 0, 'a mid-threat reply reads neutral');
});

test('evaluateMove: the 2-ply engine rewards a move they cannot punish', () => {
  // Blissey only has Thunder Wave shown — nothing to hit back with.
  const us = respMon('Garchomp', 100, ['Earthquake']);
  const them = respMon('Blissey', 100, ['Thunder Wave']);
  const ev = evalResp(us, 'Earthquake', them);
  assert.ok(ev.votes.response > 0, `a free hit should read positive, got ${ev.votes.response}`);
  assert.ok(ev.note.includes("can't punish it"), `the note says we're free, got: ${ev.note}`);
});

test('evaluateMove: the 2-ply engine discounts a KO that brings in a counter', () => {
  // Wood Hammer KOs Garchomp, but their most likely replacement Tornadus
  // threatens Rillaboom for ~163% — the KO trades into a worse spot.
  const us = respMon('Rillaboom', 100, ['Wood Hammer']);
  const bench = respMon('Tornadus', 100, ['Hurricane'], 'p2b: Tornadus');
  const them = respMon('Garchomp', 10, ['Earthquake'], 'p2a: Garchomp');
  const ev = evalResp(us, 'Wood Hammer', them, [bench], { 'p2b: Tornadus': 1 });
  assert.ok(ev.ko, 'the move does KO the active');
  assert.ok(ev.votes.response < 0, `the counter should discount the KO, got ${ev.votes.response}`);
  assert.ok(ev.note.includes('brings in Tornadus'), `the note names the counter, got: ${ev.note}`);
});

test('evaluateMove: the 2-ply engine rewards a KO whose likely replacement we beat', () => {
  // Fire Blast KOs Ferrothorn; their likely switch-in Scizor is 4× weak to
  // it — the KO sets up a favorable position.
  const us = respMon('Charizard', 100, ['Fire Blast']);
  const bench = respMon('Scizor', 100, ['Bullet Punch'], 'p2b: Scizor');
  const them = respMon('Ferrothorn', 30, ['Gyro Ball'], 'p2a: Ferrothorn');
  const ev = evalResp(us, 'Fire Blast', them, [bench], { 'p2b: Scizor': 1 });
  assert.ok(ev.ko, 'the move does KO the active');
  assert.ok(ev.votes.response > 0, `beating the replacement should read positive, got ${ev.votes.response}`);
  assert.ok(ev.note.includes('beats the likely Scizor'), `the note names the beat, got: ${ev.note}`);
});

test('recommend: the 2-ply read surfaces in the reasoning (KO brings in a counter)', () => {
  const state = makeState({
    ourActive: { species: 'Rillaboom', hpPercent: 100, moves: ['Wood Hammer'] },
    theirActive: { species: 'Garchomp', hpPercent: 10, moves: ['Earthquake'] },
    theirBench: [{ species: 'Tornadus', hpPercent: 100, moves: ['Hurricane'] }],
  });
  const rec = recommend(state);
  assert.equal(rec.bestMove.move, 'Wood Hammer');
  assert.ok(
    rec.reasoning.some((r) => r.includes('brings in Tornadus')),
    `the counter read should be in the reasoning, got: ${JSON.stringify(rec.reasoning)}`
  );
  assert.ok(rec.bestMove.votes.response != null, 'the committee votes carry the response engine');
});

test('evaluateMove: risky KO is rewarded by aggressive, discounted by safe', () => {
  // Gengar Thunderbolt vs Toxapex at 45%: rolls 40.1-47.4, so the KO is real
  // but NOT guaranteed (min 40.1 < 45).
  const state = makeState({
    ourActive: { species: 'Gengar', hpPercent: 100, moves: ['Thunderbolt'] },
    theirActive: { species: 'Toxapex', hpPercent: 45, moves: ['Liquidation'] },
  });
  const atk = state.sides.p1.pokemon[0];
  const tgt = state.sides.p2.pokemon[0];
  const ev = (mode) => evaluateMove(atk, 'Thunderbolt', tgt, [tgt], 1, {}, 9, null, {}, null, null, RISK_MODES[mode]);
  const safe = ev('safe');
  const normal = ev('normal');
  const aggressive = ev('aggressive');
  assert.equal(safe.ko, true);
  assert.equal(safe.koGuaranteed, false);
  // A risky (non-guaranteed) KO: safe values it least, aggressive most.
  assert.ok(safe.score < normal.score, `safe should discount the gamble (${safe.score} < ${normal.score})`);
  assert.ok(aggressive.score > normal.score, `aggressive should prize the swing (${aggressive.score} > ${normal.score})`);
});

test('evaluateMove: a guaranteed KO is valued most by safe mode', () => {
  // Gengar Thunderbolt vs Toxapex at 30%: min 40.1 >= 30 -> guaranteed KO.
  const state = makeState({
    ourActive: { species: 'Gengar', hpPercent: 100, moves: ['Thunderbolt'] },
    theirActive: { species: 'Toxapex', hpPercent: 30, moves: ['Liquidation'] },
  });
  const atk = state.sides.p1.pokemon[0];
  const tgt = state.sides.p2.pokemon[0];
  const ev = (mode) => evaluateMove(atk, 'Thunderbolt', tgt, [tgt], 1, {}, 9, null, {}, null, null, RISK_MODES[mode]);
  const safe = ev('safe');
  const normal = ev('normal');
  assert.equal(safe.koGuaranteed, true);
  assert.ok(safe.score > normal.score, `safe should prize the sure thing (${safe.score} > ${normal.score})`);
});

test('evaluateMove: risky setup is acceptable when aggressive, near-useless when safe', () => {
  // Garchomp Swords Dance into Weavile, which KOs it (~111%): normally a
  // throw — but when we're behind, the sweep is the comeback.
  const state = makeState({
    ourActive: { species: 'Garchomp', hpPercent: 60, moves: ['Swords Dance', 'Earthquake'] },
    theirActive: { species: 'Weavile', hpPercent: 100, moves: ['Icicle Crash', 'Ice Shard'] },
  });
  const atk = state.sides.p1.pokemon[0];
  const tgt = state.sides.p2.pokemon[0];
  const ev = (mode) => evaluateMove(atk, 'Swords Dance', tgt, [tgt], 1, {}, 9, null, {}, null, null, RISK_MODES[mode]);
  const safe = ev('safe');
  const aggressive = ev('aggressive');
  assert.ok(aggressive.score > safe.score, `aggressive accepts the risky setup (${aggressive.score} > ${safe.score})`);
  assert.ok(safe.note.includes('risky'), 'safe still flags the setup as risky');
});

test('recommend: the switch bar depends on the mode (safe switches eagerly, aggressive stays)', () => {
  // Gliscor vs Dragonite (all 4 revealed) with Toxapex on the bench: the
  // switch nets ~15.5 (the revealed Outrage/Fire Punch count against it) —
  // above safe's bar (8) and normal's (12), below aggressive's (16). Under
  // the EV hidden-move read this stays genuinely marginal: everything is
  // revealed, so the net is the honest defensive gain, not speculative.
  const state = makeState({
    ourActive: { species: 'Gliscor', hpPercent: 100, moves: ['Earthquake', 'Knock Off'] },
    ourBench: [{ species: 'Toxapex', hpPercent: 100, moves: ['Liquidation', 'Toxic'] }],
    theirActive: { species: 'Dragonite', hpPercent: 100, moves: ['Outrage', 'Earthquake', 'Fire Punch', 'Ice Spinner'] },
    theirBench: [{ species: 'Garchomp', hpPercent: 100, moves: ['Earthquake'] }],
  });
  const rec = (mode) => recommend(state, { riskMode: mode });
  const safe = rec('safe');
  const normal = rec('normal');
  const aggressive = rec('aggressive');
  assert.equal(safe.switchTo?.species, 'Toxapex', 'safe plays to preserve HP and takes the switch');
  assert.equal(normal.switchTo?.species, 'Toxapex', 'balanced play takes a decent switch too');
  assert.equal(aggressive.switchTo, null, 'aggressive avoids burning tempo on a marginal switch');
});

test('recommend: a switch-in that KOs their active with a super-effective move is suggested over a wall', () => {
  // Snorlax is dying; Weavile outspeeds Garchomp and its Icicle Crash is a
  // GUARANTEED 4x KO, so it wins over Skarmory's pure walling in every mode.
  const state = makeState({
    ourActive: { species: 'Snorlax', hpPercent: 30, moves: ['Body Slam'] },
    ourBench: [
      { species: 'Skarmory', moves: ['Iron Head'] },
      { species: 'Weavile', moves: ['Icicle Crash'] },
    ],
    theirActive: { species: 'Garchomp', hpPercent: 100, moves: ['Earthquake'] },
  });
  // sets: false — real-spread Garchomp (0 SpD for the def-phys read would
  // actually make this a roll KO; the controlled model pins the guaranteed
  // 4× KO that this test's framing depends on.
  const rec = recommend(state, { riskMode: 'normal', sets: false });
  assert.equal(rec.switchTo?.species, 'Weavile', 'the guaranteed KO is the play, not the wall');
  assert.ok(rec.switchTo.note.includes('guaranteed KO'), `got: ${rec.switchTo.note}`);
});

test('evaluateSwitch: the roll-KO reward is mode-aware (aggressive swings for it, safe does not)', () => {
  // Tyranitar's Stone Edge vs a 85% Zapdos is a roll KO (76.6-90.6%) — the
  // aggressive mode prizes the swing that wins if it lands; safe mode only
  // trusts guaranteed rolls, so the same switch nets less for it.
  const state = makeState({
    ourActive: { species: 'Snorlax', hpPercent: 30, moves: ['Body Slam'] },
    ourBench: [{ species: 'Tyranitar', moves: ['Stone Edge'] }],
    theirActive: { species: 'Zapdos', hpPercent: 85, moves: ['Thunderbolt'] },
  });
  const snorlax = state.sides.p1.pokemon[0];
  const ttar = state.sides.p1.pokemon[1];
  const zapdos = state.sides.p2.pokemon[0];
  const safe = evaluateSwitch(snorlax, ttar, zapdos, 9, null, {}, null, null, RISK_MODES.safe);
  const aggressive = evaluateSwitch(snorlax, ttar, zapdos, 9, null, {}, null, null, RISK_MODES.aggressive);
  assert.ok(safe && aggressive, 'the switch should be available to both modes');
  assert.ok(aggressive.net > safe.net, `aggressive should value the roll KO more (${aggressive.net} vs ${safe.net})`);
  assert.match(aggressive.note, /can KO/);
});

test('recommend: a candidate 4x-weak to a REVEALED move is passed over', () => {
  // Zapdos has Thunderbolt revealed — Gyarados is 4x weak to it, so even with
  // its Waterfall offense the engine must pick the safe Tyranitar instead.
  const state = makeState({
    ourActive: { species: 'Snorlax', hpPercent: 30, moves: ['Body Slam'] },
    ourBench: [
      { species: 'Gyarados', moves: ['Waterfall', 'Outrage'] },
      { species: 'Tyranitar', moves: ['Stone Edge'] },
    ],
    theirActive: { species: 'Zapdos', hpPercent: 100, moves: ['Thunderbolt'] },
  });
  const rec = recommend(state);
  assert.equal(rec.switchTo?.species, 'Tyranitar', 'the revealed 4x weakness rules Gyarados out');
});

test('recommend: forced riskMode overrides the board read', () => {
  // Clearly ahead on the board, but forced aggressive -> gamble line.
  const state = makeState({
    ourActive: { species: 'Garchomp', hpPercent: 100, moves: ['Earthquake'] },
    theirActive: { species: 'Gliscor', hpPercent: 10, moves: ['Earthquake'] },
  });
  const rec = recommend(state, { riskMode: 'aggressive' });
  assert.equal(rec.risk.mode, 'aggressive');
  assert.ok(rec.reasoning.some((r) => r.includes('playing aggressive')));
});

test('endgameLocks stays quiet outside the endgame (teams still full)', () => {
  const state = makeState({
    ourActive: { species: 'Rillaboom', moves: ['Wood Hammer'] },
    ourBench: [
      { species: 'Corviknight', moves: ['Brave Bird'] },
      { species: 'Clefable', moves: ['Moonblast'] },
      { species: 'Dragonite', moves: ['Outrage'] },
      { species: 'Garchomp', moves: ['Earthquake'] },
      { species: 'Tyranitar', moves: ['Stone Edge'] },
    ],
    theirActive: { species: 'Dragapult', moves: ['Shadow Ball'] },
    theirBench: [
      { species: 'Great Tusk', moves: ['Earthquake'] },
      { species: 'Kingambit', moves: ['Iron Head'] },
      { species: 'Gholdengo', moves: ['Make It Rain'] },
      { species: 'Ogerpon', moves: ['Ivy Cudgel'] },
      { species: 'Landorus', moves: ['Earth Power'] },
    ],
  });
  assert.equal(endgameLocks(state.sides.p1.pokemon, state.sides.p2.pokemon, 9, new Field(), {}, state, 'p1').length, 0);
  const rec = recommend(state);
  assert.ok(!rec.reasoning.some((r) => r.includes('Endgame')), 'no endgame talk with full teams');
});

// ---------------------------------------------------------------------------
// Endgame checkmate search
// ---------------------------------------------------------------------------

// All checkmate scenarios reveal all 4 moves of both sides: the checkmate
// search prices their hidden worst case (duelRace uses theirBestHit, which
// folds in worstThreat), so an unrevealed coverage nuke correctly blocks a
// false "forced win" claim. Tests that want the forcing line to fire must
// therefore fully reveal the opponent.

test('checkmate: ko-now when their last mon falls to our active', () => {
  const state = makeState({
    ourActive: { species: 'Rillaboom', hpPercent: 70, moves: ['Wood Hammer', 'Grassy Glide', 'Knock Off', 'U-turn'], ability: 'Grassy Surge' },
    theirActive: { species: 'Garchomp', hpPercent: 40, status: 'brn', moves: ['Earthquake', 'Outrage', 'Fire Fang', 'Swords Dance'], ability: 'Rough Skin', item: 'Leftovers' },
  });
  const cm = endgameCheckmate(state.sides.p1.pokemon, state.sides.p2.pokemon, state.sides.p1.pokemon[0], 9, new Field(), {}, state, 'p1');
  assert.equal(cm?.mate?.kind, 'ko-now');
  assert.equal(cm.mate.target, 'Garchomp');
  assert.ok(cm.mate.note.includes('Checkmate'), 'note should flag the forced win');
  assert.equal(cm.threat, null, 'no threat read when we have the mate');
});

test('checkmate: duel when a bench piece wins the 1v1 after the entry hit', () => {
  const state = makeState({
    ourActive: { species: 'Corviknight', hpPercent: 30, moves: ['Body Press', 'Roost', 'Brave Bird', 'U-turn'], ability: 'Pressure' },
    ourBench: [{ species: 'Clefable', hpPercent: 100, moves: ['Moonblast', 'Thunder Wave', 'Soft-Boiled', 'Stealth Rock'], ability: 'Magic Guard' }],
    theirActive: { species: 'Dragapult', hpPercent: 100, moves: ['Draco Meteor', 'Shadow Ball', 'U-turn', 'Thunderbolt'], ability: 'Infiltrator' },
  });
  const cm = endgameCheckmate(state.sides.p1.pokemon, state.sides.p2.pokemon, state.sides.p1.pokemon[0], 9, new Field(), {}, state, 'p1');
  assert.equal(cm?.mate?.kind, 'duel');
  assert.equal(cm.mate.piece, 'Clefable');
  assert.ok(cm.mate.note.includes('switch to Clefable'), 'note should name the switch-in');
});

test('checkmate: ko-then when the replacement is beaten by a piece of ours', () => {
  const state = makeState({
    ourActive: { species: 'Rillaboom', hpPercent: 70, moves: ['Wood Hammer', 'Grassy Glide', 'Knock Off', 'U-turn'], ability: 'Grassy Surge' },
    ourBench: [{ species: 'Weavile', hpPercent: 100, moves: ['Icicle Crash', 'Knock Off', 'Ice Shard', 'Low Kick'] }],
    theirActive: { species: 'Garchomp', hpPercent: 40, status: 'brn', moves: ['Earthquake', 'Outrage', 'Fire Fang', 'Swords Dance'], ability: 'Rough Skin', item: 'Leftovers' },
    theirBench: [{ species: 'Gliscor', hpPercent: 100, moves: ['Earthquake', 'Knock Off', 'Protect', 'Toxic'], ability: 'Poison Heal', item: 'Toxic Orb' }],
  });
  const cm = endgameCheckmate(state.sides.p1.pokemon, state.sides.p2.pokemon, state.sides.p1.pokemon[0], 9, new Field(), {}, state, 'p1');
  assert.equal(cm?.mate?.kind, 'ko-then');
  assert.equal(cm.mate.target, 'Garchomp');
  assert.equal(cm.mate.replacement, 'Gliscor');
  assert.ok(cm.mate.note.includes('KO their Garchomp now'), 'note should order the KO now');
});

test('checkmate: sac when our active chips their current into a bench mate range', () => {
  const state = makeState({
    ourActive: { species: 'Corviknight', hpPercent: 100, moves: ['Body Press', 'Brave Bird', 'Roost', 'U-turn'], ability: 'Pressure', item: 'Leftovers' },
    ourBench: [{ species: 'Garchomp', hpPercent: 100, moves: ['Earthquake', 'Dragon Claw', 'Stone Edge', 'Swords Dance'], ability: 'Rough Skin', item: 'Choice Scarf' }],
    theirActive: { species: 'Garchomp', hpPercent: 55, moves: ['Earthquake', 'Dragon Claw', 'Stone Edge', 'Swords Dance'], ability: 'Rough Skin', item: 'Leftovers' },
    theirBench: [{ species: 'Dragapult', hpPercent: 100, moves: ['Draco Meteor', 'Shadow Ball', 'U-turn', 'Thunderbolt'], ability: 'Infiltrator' }],
  });
  const cm = endgameCheckmate(state.sides.p1.pokemon, state.sides.p2.pokemon, state.sides.p1.pokemon[0], 9, new Field(), {}, state, 'p1');
  assert.equal(cm?.mate?.kind, 'sac');
  assert.equal(cm.mate.piece, 'Garchomp');
  assert.ok(cm.mate.note.includes('sac your Corviknight'), 'note should order the sac');
});

test('checkmate: threat when their current KOs our active and their last mon beats everyone', () => {
  const state = makeState({
    ourActive: { species: 'Weavile', hpPercent: 100, moves: ['Icicle Crash', 'Knock Off', 'Ice Shard', 'Low Kick'], ability: 'Pressure', item: 'Focus Sash' },
    ourBench: [{ species: 'Gliscor', hpPercent: 100, moves: ['Earthquake', 'Knock Off', 'Protect', 'Toxic'], ability: 'Poison Heal', item: 'Toxic Orb' }],
    theirActive: { species: 'Garchomp', hpPercent: 100, moves: ['Earthquake', 'Outrage', 'Fire Fang', 'Swords Dance'], ability: 'Rough Skin', item: 'Leftovers' },
    theirBench: [{ species: 'Dragonite', hpPercent: 100, moves: ['Outrage', 'Earthquake', 'Fire Punch', 'Roost'], ability: 'Multiscale', item: 'Leftovers' }],
  });
  const cm = endgameCheckmate(state.sides.p1.pokemon, state.sides.p2.pokemon, state.sides.p1.pokemon[0], 9, new Field(), {}, state, 'p1');
  assert.equal(cm?.mate, null, 'no mate when their line is the forcing one');
  assert.equal(cm?.threat?.sweeper, 'Dragonite');
  assert.ok(cm.threat.note.includes("you're on a clock"), 'note should warn of the clock');
});

test('checkmate: hidden-move honesty — an unrevealed nuke blocks a false forced-win claim', () => {
  // Same board as the ko-then test, but their Gliscor's fourth move is
  // UNREVEALED. worstThreat finds hidden hits (Brick Break ~114% on Weavile,
  // Gunk Shot ~57% on Rillaboom), so the search must refuse to claim the
  // forced win entirely — a mate it would have claimed with full knowledge.
  const state = makeState({
    ourActive: { species: 'Rillaboom', hpPercent: 70, moves: ['Wood Hammer', 'Grassy Glide', 'Knock Off', 'U-turn'], ability: 'Grassy Surge' },
    ourBench: [{ species: 'Weavile', hpPercent: 100, moves: ['Icicle Crash', 'Knock Off', 'Ice Shard', 'Low Kick'] }],
    theirActive: { species: 'Garchomp', hpPercent: 40, status: 'brn', moves: ['Earthquake', 'Outrage', 'Fire Fang', 'Swords Dance'], ability: 'Rough Skin', item: 'Leftovers' },
    theirBench: [{ species: 'Gliscor', hpPercent: 100, moves: ['Earthquake', 'Knock Off', 'Protect'], ability: 'Poison Heal', item: 'Toxic Orb' }],
  });
  const cm = endgameCheckmate(state.sides.p1.pokemon, state.sides.p2.pokemon, state.sides.p1.pokemon[0], 9, new Field(), {}, state, 'p1');
  assert.equal(cm, null, 'the unrevealed nuke must block the mate the fully-revealed board claimed');
});

test('checkmate: quiet outside the endgame (4+ of their mons alive)', () => {
  const state = makeState({
    ourActive: { species: 'Rillaboom', hpPercent: 70, moves: ['Wood Hammer', 'Grassy Glide', 'Knock Off', 'U-turn'] },
    ourBench: [{ species: 'Weavile', hpPercent: 100, moves: ['Icicle Crash', 'Knock Off', 'Ice Shard', 'Low Kick'] }],
    theirActive: { species: 'Garchomp', hpPercent: 40, status: 'brn', moves: ['Earthquake', 'Outrage', 'Fire Fang', 'Swords Dance'] },
    theirBench: [
      { species: 'Gliscor', hpPercent: 100, moves: ['Earthquake', 'Knock Off', 'Protect', 'Toxic'] },
      { species: 'Dragapult', hpPercent: 100, moves: ['Draco Meteor', 'Shadow Ball', 'U-turn', 'Thunderbolt'] },
      { species: 'Kingambit', hpPercent: 100, moves: ['Sucker Punch', 'Iron Head', 'Kowtow Cleave', 'Swords Dance'] },
    ],
  });
  assert.equal(endgameCheckmate(state.sides.p1.pokemon, state.sides.p2.pokemon, state.sides.p1.pokemon[0], 9, new Field(), {}, state, 'p1'), null);
  const rec = recommend(state);
  assert.ok(!rec.reasoning.some((r) => r.includes('Checkmate')), 'no checkmate talk with full teams');
});

test('recommend: checkmate line surfaces in the reasoning', () => {
  const state = makeState({
    ourActive: { species: 'Rillaboom', hpPercent: 70, moves: ['Wood Hammer', 'Grassy Glide', 'Knock Off', 'U-turn'], ability: 'Grassy Surge' },
    theirActive: { species: 'Garchomp', hpPercent: 40, status: 'brn', moves: ['Earthquake', 'Outrage', 'Fire Fang', 'Swords Dance'], ability: 'Rough Skin', item: 'Leftovers' },
  });
  state.turn = 8;
  const rec = recommend(state);
  assert.ok(
    rec.reasoning.some((r) => r.includes('Checkmate')),
    `expected a checkmate line, got: ${JSON.stringify(rec.reasoning)}`
  );
});

// ---------------------------------------------------------------------------
// Weather & terrain
// ---------------------------------------------------------------------------

test('buildField: Showdown weather/terrain names normalize to calc names', () => {
  // The reader records what the log sends ('RainDance', 'Grassy Terrain');
  // the calc silently ignores anything but its own names ('Rain', 'Grassy').
  // Without the normalization, every weather/terrain damage roll was inert.
  const s = makeState({
    ourActive: { species: 'Gyarados', moves: ['Hydro Pump'] },
    theirActive: { species: 'Toxapex', moves: ['Liquidation'] },
  });
  const gyar = s.sides.p1.pokemon[0];
  const pex = s.sides.p2.pokemon[0];
  s.field.weather = null;
  const dry = damagePercent(9, gyar, pex, 'Hydro Pump', buildField(s));
  s.field.weather = 'RainDance'; // what the log actually sends
  const rain = damagePercent(9, gyar, pex, 'Hydro Pump', buildField(s));
  assert.ok(rain.mean > dry.mean, `RainDance should boost Hydro Pump (${dry.mean}% → ${rain.mean}%)`);
  // Terrain: Grassy Terrain boosts Grass moves.
  s.field.weather = null;
  const rill = createPokemon({ ident: 'p1a: Rillaboom', side: 'p1', species: 'Rillaboom' });
  addMove(rill, 'Wood Hammer');
  s.sides.p1.pokemon = [rill];
  s.sides.p1.active = [rill.ident];
  s.field.terrain = null;
  const plain = damagePercent(9, rill, pex, 'Wood Hammer', buildField(s));
  s.field.terrain = 'Grassy Terrain';
  const grassy = damagePercent(9, rill, pex, 'Wood Hammer', buildField(s));
  assert.ok(grassy.mean > plain.mean, `Grassy Terrain should boost Wood Hammer (${plain.mean}% → ${grassy.mean}%)`);
});

test('chipPerTurn: Grassy Terrain heals grounded mons only', () => {
  assert.equal(chipPerTurn({ species: 'Garchomp' }, 9, { terrain: 'Grassy' }), 6.3);
  assert.equal(chipPerTurn({ species: 'Corviknight' }, 9, { terrain: 'Grassy' }), 0); // Flying
  assert.equal(chipPerTurn({ species: 'Gengar', ability: 'Levitate' }, 9, { terrain: 'Grassy' }), 0);
  assert.equal(chipPerTurn({ species: 'Garchomp' }, 9, null), 0); // no terrain
});

test('recommend: a weather move that unlocks damage is recommended and explains it', () => {
  // Gyarados with Rain Dance + Hydro Pump vs a team Water hits hard: setting
  // Rain first turns Hydro Pump into a near-KO and should be the call.
  const state = makeState({
    ourActive: { species: 'Gyarados', hpPercent: 100, moves: ['Rain Dance', 'Hydro Pump', 'Waterfall', 'Earthquake'] },
    theirActive: { species: 'Great Tusk', hpPercent: 100, moves: ['Earthquake', 'Ice Spinner'] },
    theirBench: [{ species: 'Gliscor', hpPercent: 100, moves: ['Earthquake'] }],
  });
  const rec = recommend(state);
  assert.equal(rec.bestMove.move, 'Rain Dance');
  assert.ok(rec.bestMove.note.includes('Hydro Pump'), 'the note names the move it unlocks');
  assert.match(rec.bestMove.note, /→/, 'the note shows the before/after damage');
});

test('recommend: setting the active weather again is a wasted turn (never recommended)', () => {
  const state = makeState({
    ourActive: { species: 'Gyarados', hpPercent: 100, moves: ['Rain Dance', 'Hydro Pump'] },
    theirActive: { species: 'Great Tusk', hpPercent: 100, moves: ['Earthquake'] },
  });
  state.field.weather = 'RainDance'; // rain is already up
  const rec = recommend(state);
  assert.notEqual(rec.bestMove.move, 'Rain Dance', 'never recommend re-setting the active weather');
});

test('recommend: weather that would help their speed abuser is flagged and devalued', () => {
  // Kingdra (Swift Swim) sits on their bench — setting Rain gives it the
  // outspeed, so Rain Dance should carry the warning even when it still wins.
  const state = makeState({
    ourActive: { species: 'Gyarados', hpPercent: 100, moves: ['Rain Dance', 'Hydro Pump', 'Waterfall'] },
    theirActive: { species: 'Great Tusk', hpPercent: 100, moves: ['Earthquake'] },
    theirBench: [{ species: 'Kingdra', hpPercent: 100, moves: ['Surf'], ability: 'Swift Swim' }],
  });
  const rec = recommend(state);
  // With the abuser present, the boost is risky: the direct 2× Hydro Pump
  // (63.8%) should outrank setting Rain (which helps Kingdra too).
  assert.equal(rec.bestMove.move, 'Hydro Pump');
  const rainNote = evaluateMove(
    state.sides.p1.pokemon[0], 'Rain Dance', state.sides.p2.pokemon[0],
    state.sides.p2.pokemon, 1, {}, 9, buildField(state), {}, null, null, null
  );
  assert.ok(rainNote.note.includes('Swift Swim'), `the Rain Dance note warns about the abuser, got: ${rainNote.note}`);
});

test('recommend: counter-weather (replacing their Sun with our Rain) is called out', () => {
  // Their Ninetales has Sun up; our Rain Dance replaces it — the note should
  // say their boosts stop, and setting the counter is worth more than usual.
  const state = makeState({
    ourActive: { species: 'Gyarados', hpPercent: 100, moves: ['Rain Dance', 'Hydro Pump', 'Waterfall'] },
    theirActive: { species: 'Ninetales', hpPercent: 100, moves: ['Fire Blast', 'Solar Beam'] },
  });
  state.field.weather = 'SunnyDay';
  const rec = recommend(state);
  assert.equal(rec.bestMove.move, 'Rain Dance');
  assert.ok(rec.bestMove.note.includes('replaces their Sun'), `counter-weather should be named, got: ${rec.bestMove.note}`);
});

test('recommend: warns when their active can flip the field with a weather move', () => {
  const state = makeState({
    ourActive: { species: 'Garchomp', hpPercent: 100, moves: ['Earthquake', 'Dragon Claw'] },
    theirActive: { species: 'Pelipper', hpPercent: 100, moves: ['Rain Dance', 'Hurricane', 'Surf'] },
  });
  const rec = recommend(state);
  assert.ok(
    rec.reasoning.some((r) => r.includes('Pelipper has Rain Dance') && r.includes('flip to Rain')),
    `expected a flip-to-Rain warning, got: ${JSON.stringify(rec.reasoning)}`
  );
});

test('recommend: warns when their ability summons weather on switch-in', () => {
  const active = makeState({
    ourActive: { species: 'Garchomp', hpPercent: 100, moves: ['Earthquake'] },
    theirActive: { species: 'Pelipper', hpPercent: 100, moves: ['Surf'], ability: 'Drizzle' },
  });
  const rActive = recommend(active);
  assert.ok(
    rActive.reasoning.some((r) => r.includes('Drizzle sets Rain')),
    `expected a Drizzle warning for the active, got: ${JSON.stringify(rActive.reasoning)}`
  );

  // A weather ability on the BENCH is a switch-in warning too.
  const bench = makeState({
    ourActive: { species: 'Garchomp', hpPercent: 100, moves: ['Earthquake'] },
    theirActive: { species: 'Toxapex', hpPercent: 100, moves: ['Liquidation'] },
    theirBench: [{ species: 'Torkoal', hpPercent: 100, moves: ['Lava Plume'], ability: 'Drought' }],
  });
  const rBench = recommend(bench);
  assert.ok(
    rBench.reasoning.some((r) => r.includes('Torkoal has Drought') && r.includes('sets Sun')),
    `expected a bench Drought warning, got: ${JSON.stringify(rBench.reasoning)}`
  );
});

test('recommend: no weather warnings when the field is already that weather', () => {
  const state = makeState({
    ourActive: { species: 'Garchomp', hpPercent: 100, moves: ['Earthquake'] },
    theirActive: { species: 'Pelipper', hpPercent: 100, moves: ['Rain Dance', 'Surf'] },
  });
  state.field.weather = 'RainDance'; // it's raining already
  const rec = recommend(state);
  assert.ok(
    !rec.reasoning.some((r) => r.includes('flip to Rain')),
    'no warning when their weather move would just re-set what is already up'
  );
});

// ---------------------------------------------------------------------------
// Their setup prediction
// ---------------------------------------------------------------------------

test('setup: a healthy setup-holder is staying to boost (P stay rises)', () => {
  const dn = createPokemon({ ident: 'p2a: Dragonite', side: 'p2', species: 'Dragonite', level: 100 });
  dn.hpPercent = 80;
  addMove(dn, 'Dragon Dance');
  addMove(dn, 'Outrage');
  const plain = createPokemon({ ident: 'p2a: Garchomp', side: 'p2', species: 'Garchomp', level: 100 });
  plain.hpPercent = 80;
  addMove(plain, 'Earthquake');
  assert.ok(predictStayProb(dn) > predictStayProb(plain), 'a revealed setup move should make them likelier to stay');
});

test('setup: warns when their active is about to set up and we cannot KO it', () => {
  const state = makeState({
    ourActive: { species: 'Ferrothorn', moves: ['Gyro Ball'] },
    theirActive: { species: 'Dragonite', hpPercent: 100, moves: ['Dragon Dance', 'Outrage'] },
  });
  const rec = recommend(state);
  assert.ok(
    rec.reasoning.some((r) => r.includes('Dragon Dance') && r.includes('about to set up')),
    `expected an about-to-set-up warning, got: ${JSON.stringify(rec.reasoning)}`
  );
});

test('setup: says KO it NOW when our best move already finishes the setup threat', () => {
  const state = makeState({
    ourActive: { species: 'Deoxys-Attack', moves: ['Superpower', 'Ice Beam'] },
    theirActive: { species: 'Dragonite', hpPercent: 100, moves: ['Dragon Dance', 'Outrage'] },
  });
  const rec = recommend(state);
  assert.ok(
    rec.reasoning.some((r) => r.includes('Dragon Dance') && r.includes('KO it NOW')),
    `expected a KO-it-now warning, got: ${JSON.stringify(rec.reasoning)}`
  );
});

test('setup: no warning once they already boosted', () => {
  const state = makeState({
    ourActive: { species: 'Ferrothorn', moves: ['Gyro Ball'] },
    theirActive: { species: 'Dragonite', hpPercent: 100, moves: ['Dragon Dance', 'Outrage'], boosts: { atk: 1 } },
  });
  const rec = recommend(state);
  assert.ok(
    !rec.reasoning.some((r) => r.includes('about to set up')),
    'an already-boosted mon is a live threat, not an incoming boost'
  );
});

// ---------------------------------------------------------------------------
// Item-condition plays (Focus Sash / Weakness Policy)
// ---------------------------------------------------------------------------

test('items: a revealed Focus Sash eats the KO call at full HP', () => {
  const state = makeState({
    ourActive: { species: 'Kyurem', moves: ['Ice Beam'] },
    theirActive: { species: 'Garchomp', hpPercent: 100, moves: ['Earthquake'], item: 'Focus Sash' },
  });
  const rec = recommend(state);
  assert.ok(rec.bestMove, 'a move should still be recommended');
  assert.ok(
    rec.reasoning.some((r) => r.includes('Focus Sash survives it (1 HP)')),
    `expected a sash note, got: ${JSON.stringify(rec.reasoning)}`
  );
  assert.ok(
    !rec.bestMove.note.includes('guaranteed KO') && !rec.bestMove.note.includes('can KO'),
    `a full-HP sash holder cannot be KO'd by one hit: ${rec.bestMove.note}`
  );
  assert.ok(!rec.reasoning.some((r) => r.includes('guarantees a KO')), 'no KO callout through the sash');
});

test('items: clicking a super-effective move into a revealed Weakness Policy is flagged', () => {
  const state = makeState({
    ourActive: { species: 'Milotic', moves: ['Ice Beam', 'Scald'] },
    theirActive: { species: 'Dragonite', hpPercent: 100, moves: ['Outrage', 'Earthquake'], item: 'Weakness Policy' },
  });
  // sets: false — real-spread Dragonite runs 0 SpD, so Milotic's Ice Beam
  // OHKOs it (121%) and the WP never triggers; the flat model's 2HKO is what
  // exercises the warning. (The real-set OHKO is covered by the KO test.)
  const rec = recommend(state, { sets: false });
  assert.ok(
    rec.reasoning.some((r) => r.includes('triggers their Weakness Policy')),
    `expected a Weakness Policy warning, got: ${JSON.stringify(rec.reasoning)}`
  );
});

test('items: a move that KOs the WP holder never triggers it', () => {
  const state = makeState({
    ourActive: { species: 'Kyurem', moves: ['Ice Beam'] },
    theirActive: { species: 'Dragonite', hpPercent: 100, moves: ['Outrage'], item: 'Weakness Policy' },
  });
  const rec = recommend(state);
  assert.ok(
    !rec.reasoning.some((r) => r.includes('triggers their Weakness Policy')),
    'a faint cannot activate Weakness Policy'
  );
});

// ---------------------------------------------------------------------------
// Tera timing
// ---------------------------------------------------------------------------

test('tera: recommends terastallizing when it is the difference between dying and surviving', () => {
  // Aggron is 4×-weak to Earthquake; tera Grass turns it into a ½× resist —
  // at 30% HP that is the difference between dying and surviving.
  const state = makeState({
    ourActive: { species: 'Aggron', hpPercent: 30, moves: ['Heavy Slam'], teraType: 'Grass', canTera: true },
    theirActive: { species: 'Garchomp', moves: ['Earthquake'] },
  });
  const rec = recommend(state);
  assert.ok(
    rec.reasoning.some((r) => r.includes('terastallizing your Aggron') && r.includes('survive')),
    `expected a tera-save suggestion, got: ${JSON.stringify(rec.reasoning)}`
  );
});

test('tera: warns when their revealed tera type would flip our best move', () => {
  const state = makeState({
    ourActive: { species: 'Rillaboom', moves: ['Wood Hammer', 'Knock Off'] },
    theirActive: { species: 'Great Tusk', hpPercent: 100, moves: ['Earthquake', 'Headlong Rush'], teraType: 'Grass' },
  });
  const rec = recommend(state);
  assert.ok(
    rec.reasoning.some((r) => r.includes('can terastallize into Grass') && r.includes('Wood Hammer drops')),
    `expected a tera-flip warning, got: ${JSON.stringify(rec.reasoning)}`
  );
});

// ---------------------------------------------------------------------------
// 2-turn lookahead (race projection)
// ---------------------------------------------------------------------------

test('race: warns when they finish us faster than we finish them', () => {
  const state = makeState({
    ourActive: { species: 'Ferrothorn', hpPercent: 40, moves: ['Gyro Ball'] },
    theirActive: { species: 'Garchomp', hpPercent: 100, moves: ['Earthquake', 'Outrage'] },
  });
  const rec = recommend(state);
  assert.ok(
    rec.reasoning.some((r) => r.includes('Race check') && r.includes('finishes you in ~1 turn')),
    `expected a race warning, got: ${JSON.stringify(rec.reasoning)}`
  );
});

test('race: no warning when our move already KOs this turn', () => {
  // Superpower only does ~35% at full HP — but on a 30% Garchomp it KOs, so
  // the race is over before it matters and no warning should appear.
  const state = makeState({
    ourActive: { species: 'Deoxys-Attack', moves: ['Superpower'] },
    theirActive: { species: 'Garchomp', hpPercent: 30, moves: ['Earthquake'] },
  });
  const rec = recommend(state);
  assert.ok(
    !rec.reasoning.some((r) => r.includes('Race check')),
    'a KO this turn ends the race before it matters'
  );
});

test('race: counts their hidden worst move (full, not discounted) in per-turn damage', () => {
  // Their Garchomp has only Earthquake revealed (~53% vs Weavile), but its
  // learnset hides a 4×-effective Brick Break (~108%) — the race must run on
  // that full worst-case number, and name the move so the player knows.
  const state = makeState({
    ourActive: { species: 'Weavile', hpPercent: 40, moves: ['Ice Shard'] },
    theirActive: { species: 'Garchomp', hpPercent: 100, moves: ['Earthquake'] },
  });
  const rec = recommend(state);
  const line = rec.reasoning.find((r) => r.includes('Race check'));
  assert.ok(line, `expected a race warning, got: ${JSON.stringify(rec.reasoning)}`);
  assert.ok(line.includes('Brick Break'), `the race should name the hidden move: ${line}`);
  // The point is the race runs on the FULL hidden hit, not the discounted
  // ~53% revealed Earthquake alone.
  assert.ok(line.includes('~107.6%'), `the per-turn damage should be the FULL hidden hit: ${line}`);
  assert.ok(
    line.includes('1 turn'),
    `at ~108%/turn on 40% HP the finish is immediate: ${line}`
  );
});

test('engine: votes sum to the score and carry the calc engine (the committee)', () => {
  // The score is the blend of the committee's votes — the calc (damage)
  // engine, KO, speed, and context. They must sum exactly to the score and
  // the calc vote must be the dominant term for a damage move.
  const state = makeState({
    ourActive: { species: 'Charizard', hpPercent: 100, moves: ['Fire Blast'] },
    theirActive: { species: 'Ferrothorn', hpPercent: 100, moves: ['Gyro Ball'] },
  });
  const field = buildField(state);
  const us = state.sides.p1.pokemon[0];
  const them = state.sides.p2.pokemon[0];
  const ev = evaluateMove(us, 'Fire Blast', them, [them], 1, {}, 9, field, {});
  assert.ok(ev.votes, 'damage moves carry committee votes');
  assert.equal(
    Math.round((ev.votes.calc + ev.votes.ko + ev.votes.speed + ev.votes.context) * 10) / 10,
    ev.score,
    'the blended votes must equal the score'
  );
  assert.ok(ev.votes.calc > 0, 'the calc engine carries the damage');
  assert.ok(ev.votes.calc >= ev.votes.ko, 'the calc engine dominates the KO vote');
  // A status move routes its whole value through the context engine.
  const status = makeState({
    ourActive: { species: 'Chansey', hpPercent: 100, moves: ['Thunder Wave'] },
    theirActive: { species: 'Gliscor', hpPercent: 100, moves: ['Earthquake'] },
  });
  const fieldS = buildField(status);
  const usS = status.sides.p1.pokemon[0];
  const themS = status.sides.p2.pokemon[0];
  const evS = evaluateMove(usS, 'Thunder Wave', themS, [themS], 1, {}, 9, fieldS, {});
  assert.equal(evS.votes.calc, 0, 'status moves have no damage vote');
  assert.ok(evS.votes.context > 0, 'status value lives in the context vote');
});

test('engine: agreement is engine-weight-weighted (calc engine has the biggest say)', () => {
  // Two moves where only the calc engine differs — the winner must read as a
  // strong agreement because the calc vote is weighted 3× the speed/context.
  const a = { votes: { calc: 60, ko: 10, speed: 0, context: 0, response: 0 } };
  const b = { votes: { calc: 40, ko: 10, speed: 0, context: 0, response: 0 } };
  // a wins calc (weight 3), ties ko/speed/context/response (half each):
  // (3 + 2.5) / 8 = 0.6875 — calc weight dominates.
  assert.equal(engineAgreement(a, b), 5.5 / 8, 'a wins calc, ties the rest — calc weight dominates');
  // Disagree everywhere: split votes should read as half agreement.
  const c = { votes: { calc: 60, ko: 10, speed: 0, context: 0, response: 0 } };
  const d = { votes: { calc: 40, ko: 20, speed: 5, context: 5, response: 5 } };
  const agree = engineAgreement(c, d);
  assert.ok(agree > 0 && agree < 1, `a mixed verdict should read partial: ${agree}`);
  // A pure tie on every engine is half credit.
  assert.equal(engineAgreement(a, { ...a }), 0.5);
});

test('engine: confidence reflects committee agreement, not raw score share', () => {
  // Two strong moves where one clearly wins: Fire Blast (4×) vs Air Slash
  // (1×) on Ferrothorn. Old share formula gave ~78%; a 90-vs-85 pair would
  // have read 51% despite an obvious winner. Agreement must push it high.
  const state = makeState({
    ourActive: { species: 'Charizard', hpPercent: 100, moves: ['Fire Blast', 'Air Slash'] },
    theirActive: { species: 'Ferrothorn', hpPercent: 100, moves: ['Gyro Ball'] },
  });
  const rec = recommend(state);
  assert.ok(
    rec.bestMove.confidence >= 85,
    `a 4× winner should read high confidence, got ${rec.bestMove.confidence}`
  );
  assert.ok(rec.bestMove.confidence <= 100);
  assert.ok(rec.bestMove.votes, 'the recommended move carries its committee votes');
});

test('engine: the committee votes appear in the reasoning list, not just the tooltip', () => {
  const state = makeState({
    ourActive: { species: 'Charizard', hpPercent: 100, moves: ['Fire Blast', 'Air Slash'] },
    theirActive: { species: 'Ferrothorn', hpPercent: 100, moves: ['Gyro Ball'] },
  });
  const rec = recommend(state);
  const line = rec.reasoning.find((r) => r.startsWith('Committee on Fire Blast:'));
  assert.ok(line, `expected a committee line, got: ${JSON.stringify(rec.reasoning)}`);
  assert.ok(line.includes('calc '), `the line names the calc engine: ${line}`);
  assert.ok(line.includes('KO '), `the line names the KO engine: ${line}`);
  assert.ok(line.includes('speed '), `the line names the speed engine: ${line}`);
  assert.ok(line.includes('context '), `the line names the context engine: ${line}`);
  assert.ok(line.includes('response '), `the line names the 2-ply response engine: ${line}`);
  // The line must live inside the 9-line budget (not sliced off) and its
  // calc vote must match the move's own committee votes.
  assert.ok(rec.reasoning.length <= 9);
  assert.ok(line.includes(`score ${rec.bestMove.score}`), `the line ends with the blended score: ${line}`);
});

test('engine: a genuine coin flip between equal moves reads middling, not 100%', () => {
  // Air Slash vs Aerial Ace on a neutral target are nearly identical — the
  // engine should NOT claim a confident pick (and the panel tooltip shows
  // why via the votes).
  const state = makeState({
    ourActive: { species: 'Charizard', hpPercent: 100, moves: ['Air Slash', 'Aerial Ace'] },
    theirActive: { species: 'Umbreon', hpPercent: 100, moves: ['Foul Play'] },
  });
  const rec = recommend(state);
  assert.ok(
    rec.bestMove.confidence < 90,
    `a near-tie should not read as a sure thing, got ${rec.bestMove.confidence}`
  );
  assert.ok(
    rec.bestMove.confidence >= 50,
    `the top option still reads as preferred, got ${rec.bestMove.confidence}`
  );
});

test('recommend: no switch into a mon their SHOWN move hits harder (defense-first gate)', () => {
  // Blissey tanks Outrage (~59%); the benched Garchomp is 2×-weak to the
  // same shown Outrage (~83%) — trading into that is a worse matchup. The
  // offense bonus must not mask it: no switch.
  const state = makeState({
    ourActive: { species: 'Blissey', hpPercent: 100, moves: ['Soft-Boiled', 'Ice Beam'] },
    ourBench: [{ species: 'Garchomp', hpPercent: 100, moves: ['Earthquake', 'Outrage'] }],
    theirActive: { species: 'Garchomp', hpPercent: 100, moves: ['Outrage', 'Earthquake'] },
  });
  const rec = recommend(state);
  assert.equal(rec.switchTo, null, 'a mon their shown move 2×-hits must not be sent in');
});

test('recommend: the defense-first gate still allows a KO-trade into a worse matchup', () => {
  // Snorlax is dying and Weavile gets mauled by Earthquake too — but its
  // Icicle Crash is a guaranteed 4× KO. A KO justifies the trade; the gate
  // must not block it.
  const state = makeState({
    ourActive: { species: 'Snorlax', hpPercent: 30, moves: ['Body Slam'] },
    ourBench: [{ species: 'Weavile', hpPercent: 100, moves: ['Icicle Crash'] }],
    theirActive: { species: 'Garchomp', hpPercent: 100, moves: ['Earthquake'] },
  });
  const rec = recommend(state, { riskMode: 'normal', sets: false });
  assert.equal(rec.switchTo?.species, 'Weavile', 'the guaranteed KO still wins over the gate');
  assert.ok(rec.switchTo.note.includes('guaranteed KO'), `got: ${rec.switchTo.note}`);
});

test('engine: injectable committee weights change the blend (the tuning harness)', () => {
  // Gengar's Shadow Ball KOs a low Clefable (the KO engine votes +10); a
  // heavy KO weight must amplify that vote and shift the blended score.
  // The exact ranking doesn't matter — what matters is that passing a
  // different weight set CHANGES the scores, proving the harness can move
  // the needle (scripts/tune-weights.js replays real battles across these).
  const state = makeState({
    ourActive: { species: 'Gengar', hpPercent: 100, moves: ['Shadow Ball', 'Sludge Bomb'] },
    theirActive: { species: 'Clefable', hpPercent: 15, moves: ['Moonblast'] },
  });
  const base = recommend(state);
  const boosted = recommend(state, {
    engineWeights: { blend: { calc: 1, ko: 10, speed: 1, context: 1 }, agree: { calc: 3, ko: 2, speed: 1, context: 1 } },
    rankedMoves: true,
  });
  // The scores must actually shift with the weights (the whole point of
  // tunable weights) — and the default (all-1s blend) must equal the plain
  // sum, i.e. the pre-committee behavior.
  const baseScore = base.bestMove?.score ?? 0;
  const boostedScore = boosted.bestMove?.score ?? 0;
  assert.ok(boostedScore !== baseScore, 'changing the blend weights must change the scores');
  // rankedMoves exposes the top-3 so the harness can measure containment.
  assert.ok(Array.isArray(boosted.rankedMoves), 'rankedMoves is exposed when requested');
  assert.ok(boosted.rankedMoves.length <= 3);
  assert.equal(boosted.rankedMoves[0].move, boosted.bestMove.move, 'top-1 is the best move');
  // Without the flag, no ranking leaks into the payload.
  const plain = recommend(state);
  assert.equal(plain.rankedMoves, undefined, 'rankedMoves stays hidden unless requested');
});
