// test/engine.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { calculate, Pokemon, Move, Field } from '@smogon/calc';
import { createBattleState, createPokemon, addMove } from '../src/reader/state.js';
import { parseLog } from '../src/reader/reader.js';
import { damagePercent } from '../src/engine/calc.js';
import {
  recommend,
  evaluateMove,
  predictStayProb,
  predictSwitchProbs,
  utilityScore,
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
  const rec = recommend(state);
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
