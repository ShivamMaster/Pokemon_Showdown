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
  boardAdvantage,
  resolveRiskMode,
  RISK_MODES,
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
  const rec = recommend(state);
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

  const engine = damagePercent(9, ourMon, theirMon, 'Fire Blast', new Field());
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
  const state = makeState({
    ourActive: { species: 'Rillaboom', hpPercent: 70, moves: ['Wood Hammer', 'Grassy Glide', 'Knock Off', 'Swords Dance'] },
    ourBench: [{ species: 'Corviknight', hpPercent: 100, moves: ['Roost', 'Brave Bird', 'Body Press'] }],
    theirActive: { species: 'Garchomp', hpPercent: 40, status: 'brn', moves: ['Earthquake', 'Outrage', 'Fire Fang'] },
    theirBench: [{ species: 'Dragapult', hpPercent: 100, moves: ['Draco Meteor', 'Shadow Ball'] }],
  });
  const rec = recommend(state, { ourSideId: 'p1' });
  assert.equal(rec.bestMove.move, 'Swords Dance', 'the setup into a sweep should be the call');
  const line = rec.reasoning.find((r) => r.includes('setup:'));
  assert.ok(line && line.includes('1HKOs'), `setup reasoning should quantify the sweep, got: ${line}`);
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
  // Scizor vs Dragonite with Toxapex on the bench: the switch nets ~15.7 —
  // above safe's bar (8) and normal's (12), below aggressive's (16).
  const state = makeState({
    ourActive: { species: 'Scizor', hpPercent: 100, moves: ['Bullet Punch', 'U-turn'] },
    ourBench: [{ species: 'Toxapex', hpPercent: 100, moves: ['Liquidation', 'Toxic'] }],
    theirActive: { species: 'Dragonite', hpPercent: 100, moves: ['Outrage', 'Earthquake', 'Ice Spinner'] },
    theirBench: [{ species: 'Gliscor', hpPercent: 100, moves: ['Earthquake'] }],
  });
  const rec = (mode) => recommend(state, { riskMode: mode });
  const safe = rec('safe');
  const aggressive = rec('aggressive');
  assert.equal(safe.switchTo?.species, 'Toxapex', 'safe plays to preserve HP and takes the switch');
  assert.equal(aggressive.switchTo, null, 'aggressive avoids burning tempo on a marginal switch');
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
