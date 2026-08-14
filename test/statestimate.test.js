// test/statestimate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { Field } from '@smogon/calc';
import { createBattleState, createPokemon, addMove } from '../src/reader/state.js';
import { BattleReader } from '../src/reader/reader.js';
import { damagePercent, buildPokemon, buildField } from '../src/engine/calc.js';
import {
  applyObservation,
  applyObservations,
  narrowStat,
  hpEvFromMaxHp,
  evFromRange,
  evLabel,
} from '../src/engine/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const realLog = readFileSync(path.join(__dirname, 'fixtures', 'real-battle.log'), 'utf8');

// Build a battle state with a Raging Bolt (p1) vs Dragonite (p2) matchup.
function makeMatchup() {
  const state = createBattleState();
  state.gen = 9;
  state.gametype = 'singles';
  const atk = createPokemon({ ident: 'p1a: Raging Bolt', side: 'p1', species: 'Raging Bolt', level: 100 });
  const def = createPokemon({ ident: 'p2a: Dragonite', side: 'p2', species: 'Dragonite', level: 100 });
  addMove(atk, 'Dragon Pulse');
  state.sides.p1.pokemon.push(atk);
  state.sides.p2.pokemon.push(def);
  return { state, atk, def };
}

// The damage an attacker with `atkEvs` deals to a defender with `defEvs` at the
// midpoint roll — the value the estimator would observe in battle.
function observedDamage(atk, def, atkEvs, defEvs) {
  const d = damagePercent(9, atk, def, 'Dragon Pulse', new Field(), {
    attackerEvs: atkEvs,
    defenderEvs: defEvs,
    useEstimates: false,
  });
  return Math.round(((d.min + d.max) / 2) * 10) / 10;
}

// ---------------------------------------------------------------------------
// HP EV solving
// ---------------------------------------------------------------------------

test('hpEvFromMaxHp: solves 0 HP EV exactly', () => {
  // Raging Bolt base HP 125; level 100, 31 IV, 0 HP EV -> 391 max HP.
  assert.deepEqual(hpEvFromMaxHp(9, 'Raging Bolt', 100, 391), [0, 3]);
});

test('hpEvFromMaxHp: solves max HP EV (252) exactly', () => {
  assert.deepEqual(hpEvFromMaxHp(9, 'Raging Bolt', 100, 454), [252, 252]);
});

test('hpEvFromMaxHp: percentage HP (100) returns null', () => {
  assert.equal(hpEvFromMaxHp(9, 'Raging Bolt', 100, 100), null);
});

test('hpEvFromMaxHp: unknown species returns null', () => {
  assert.equal(hpEvFromMaxHp(9, 'Totally Fake Mon', 100, 300), null);
});

// ---------------------------------------------------------------------------
// Range narrowing recovers known EV spreads
// ---------------------------------------------------------------------------

test('narrowStat: max-invested attacker is pinned high by its own damage', () => {
  const { atk, def } = makeMatchup();
  const obs = observedDamage(atk, def, { spa: 252 }, { hp: 252, spd: 252 });
  const range = narrowStat(9, atk, def, 'Dragon Pulse', buildField(), 'spa', 'spa', 'spd', obs, null, 'attacker');
  // A max-SpA hit can't be produced by a 0-EV attacker, so the lower bound
  // must be well above zero.
  assert.ok(range[0] >= 100, `expected high lower bound, got ${range}`);
  assert.equal(range[1], 252);
});

test('narrowStat: zero-invested attacker stays clearly lower than max-invested', () => {
  const { atk, def } = makeMatchup();
  const obsLow = observedDamage(atk, def, { spa: 0 }, { hp: 252, spd: 252 });
  const low = narrowStat(9, atk, def, 'Dragon Pulse', buildField(), 'spa', 'spa', 'spd', obsLow, null, 'attacker');
  const obsHigh = observedDamage(atk, def, { spa: 252 }, { hp: 252, spd: 252 });
  const high = narrowStat(9, atk, def, 'Dragon Pulse', buildField(), 'spa', 'spa', 'spd', obsHigh, null, 'attacker');
  // A weak hit is consistent with fewer EVs than a strong one, and both
  // observations are consistent with the true value.
  assert.ok(low[1] < high[1], `low upper ${low[1]} should be < high upper ${high[1]}`);
  assert.equal(low[0], 0);
  assert.ok(high[0] >= 100, `high lower bound, got ${high[0]}`);
});

test('narrowStat: defender SpD is estimated from how much it soaks', () => {
  const { atk, def } = makeMatchup();
  const obs = observedDamage(atk, def, { spa: 252 }, { hp: 252, spd: 252 });
  const range = narrowStat(9, atk, def, 'Dragon Pulse', buildField(), 'spd', 'spa', 'spd', obs, null, 'defender');
  // A bulky max-SpD Dragonite tanks it — the low bound must be high.
  assert.ok(range[0] >= 100, `expected bulky defender range, got ${range}`);
});

test('applyObservation: fits the hit against the field snapshot at hit time', () => {
  // Same hit, same observed damage — but Grassy Terrain halves Earthquake for
  // a grounded defender, so the same damage needs more attacker EVs there.
  const state = createBattleState();
  state.gen = 9;
  state.gametype = 'singles';
  const atk = createPokemon({ ident: 'p1a: Raging Bolt', side: 'p1', species: 'Raging Bolt', level: 100 });
  const def = createPokemon({ ident: 'p2a: Toxapex', side: 'p2', species: 'Toxapex', level: 100 });
  addMove(atk, 'Earthquake');
  state.sides.p1.pokemon.push(atk);
  state.sides.p2.pokemon.push(def);
  // Observe a mid-roll hit from a 100-atk-EV attacker under Grassy Terrain
  // (which halves Earthquake), so the same damage is consistent under both
  // the grassy snapshot and a clear field — but implies different EVs.
  const d = damagePercent(9, atk, def, 'Earthquake', new Field({ terrain: 'Grassy' }), {
    attackerEvs: { atk: 100 },
    defenderEvs: { hp: 252, def: 252 },
    useEstimates: false,
  });
  const mid = Math.round(((d.min + d.max) / 2) * 10) / 10;
  const base = { attacker: atk.ident, defender: def.ident, move: 'Earthquake', damagePct: mid, turn: 1 };

  // Fitted with the correct Grassy snapshot, the damage is consistent and an
  // atk estimate comes out (Grassy halves EQ, so the spread is wider than it
  // would be on a clear field — but it exists).
  applyObservation(state, { ...base, weather: null, terrain: 'Grassy' });
  const grassy = atk.evEstimate?.atk;
  delete atk.evEstimate;
  delete def.evEstimate;
  // Fitted as if the field were clear, the SAME damage is impossible: full-
  // power EQ on a max-def defender cannot deal as little as the terrain-
  // halved hit, so no EV range brackets it. The snapshot decides whether the
  // observation is even sane — that's the regression this guards.
  applyObservation(state, { ...base, weather: null, terrain: null });
  const plain = atk.evEstimate?.atk;
  assert.ok(grassy, `the Grassy snapshot should make the hit consistent, got ${grassy}`);
  assert.equal(plain, null, 'the same hit is impossible under a clear field — the snapshot matters');

  // A hand-built observation with NO snapshot keys uses the state's current
  // field — set Grassy on the state and the same hit becomes consistent again.
  state.field.terrain = 'Grassy Terrain'; // the reader's raw name
  delete atk.evEstimate;
  delete def.evEstimate;
  applyObservation(state, { ...base });
  assert.ok(atk.evEstimate?.atk, 'no-snapshot observations fall back to the current field');
});

test('applyObservation: intersecting observations narrow the range', () => {
  const { state, atk, def } = makeMatchup();
  const mid = observedDamage(atk, def, { spa: 252 }, { hp: 252, spd: 252 });
  applyObservation(state, { attacker: atk.ident, defender: def.ident, move: 'Dragon Pulse', damagePct: mid, turn: 1 });
  const first = atk.evEstimate.spa;
  // A second, higher observation (near max roll) keeps the intersection sane.
  applyObservation(state, { attacker: atk.ident, defender: def.ident, move: 'Dragon Pulse', damagePct: mid + 4, turn: 2 });
  const second = atk.evEstimate.spa;
  assert.ok(second[0] >= first[0], 'intersection should not widen the lower bound');
});

test('applyObservation: junk observation (unknown move) does not crash', () => {
  const { state, atk, def } = makeMatchup();
  applyObservation(state, { attacker: atk.ident, defender: def.ident, move: 'Not A Real Move', damagePct: 50, turn: 1 });
  applyObservation(state, { attacker: atk.ident, defender: def.ident, move: null, damagePct: 50, turn: 2 });
  assert.equal(atk.evEstimate, null);
  assert.equal(def.evEstimate, null);
});

test('applyObservation: damage over 100% is ignored', () => {
  const { state, atk, def } = makeMatchup();
  applyObservation(state, { attacker: atk.ident, defender: def.ident, move: 'Dragon Pulse', damagePct: 140, turn: 1 });
  assert.equal(atk.evEstimate, null);
});

test('applyObservation: status moves are ignored (no damage)', () => {
  const { state, atk, def } = makeMatchup();
  addMove(atk, 'Thunder Wave');
  applyObservation(state, { attacker: atk.ident, defender: def.ident, move: 'Thunder Wave', damagePct: 0, turn: 1 });
  assert.equal(atk.evEstimate, null);
});

test('evFromRange: midpoint used for the calc, clamped to EV bounds', () => {
  assert.equal(evFromRange([0, 252], 0), 128);
  assert.equal(evFromRange([252, 252], 0), 252);
  assert.equal(evFromRange(null, 100), 100);
});

test('evLabel: only reports narrowed stats', () => {
  assert.equal(evLabel({ evEstimate: null }), null);
  assert.equal(evLabel({ evEstimate: { spa: [0, 252] } }), null); // too wide
  assert.equal(evLabel({ evEstimate: { spa: [252, 252] } }), 'spa 252');
  assert.equal(evLabel({ evEstimate: { def: [4, 12] } }), 'def ~8');
});

// ---------------------------------------------------------------------------
// buildPokemon consumes the learned EVs
// ---------------------------------------------------------------------------

test('buildPokemon: learned EV overrides the default assumption', () => {
  const { state, atk, def } = makeMatchup();
  assert.equal(buildPokemon(9, atk, { spa: 252 }).evs.spa, 252); // no estimate yet
  atk.evEstimate = { spa: [252, 252] };
  assert.equal(buildPokemon(9, atk, { spa: 252 }).evs.spa, 252);
  atk.evEstimate = { spa: [0, 0] };
  assert.equal(buildPokemon(9, atk, { spa: 252 }).evs.spa, 0);
});

test('buildPokemon: wide estimates are ignored (fall back to default)', () => {
  const { atk } = makeMatchup();
  atk.evEstimate = { spa: [0, 252] };
  assert.equal(buildPokemon(9, atk, { spa: 252 }).evs.spa, 252);
});

test('buildPokemon: useEstimates=false keeps the caller EVs exact (estimator probes)', () => {
  const { atk } = makeMatchup();
  atk.evEstimate = { spa: [252, 252] };
  assert.equal(buildPokemon(9, atk, { spa: 0 }, null, false).evs.spa, 0);
});

// ---------------------------------------------------------------------------
// Reader records observations from a real battle log
// ---------------------------------------------------------------------------

test('reader: damage observations recorded from the fixture battle', () => {
  const r = new BattleReader();
  r.read(realLog);
  assert.ok(r.state.observations.length >= 10, `expected many observations, got ${r.state.observations.length}`);
  const first = r.state.observations[0];
  assert.ok(first.attacker && first.defender && first.move, 'observation has attacker/defender/move');
  assert.ok(first.damagePct > 0 && first.damagePct <= 100, `damagePct in range, got ${first.damagePct}`);
  // The field at hit time is snapshotted so the estimator fits the damage
  // against the right weather/terrain (the fixture's first hit has neither).
  assert.ok('weather' in first && 'terrain' in first, 'observation snapshots the field');
  assert.equal(first.terrain, null, 'turn-1 hit lands before Grassy Terrain starts');
});

test('reader: status/hazard damage ([from] extras) is not recorded', () => {
  // The fixture has poison and Life Orb recoil damage with [from] extras.
  const r = new BattleReader();
  r.read(realLog);
  // Every recorded observation must be a clean move hit — none carry [from].
  // (The reader only records when there are no [from] extras, so the count of
  // clean hits should be below the total number of damage lines.)
  const totalDamageLines = realLog.split('\n').filter((l) => l.includes('|-damage|')).length;
  assert.ok(r.state.observations.length < totalDamageLines, 'subsets of damage lines');
});

test('reader+estimator: fixture battle produces plausible learned ranges', () => {
  const r = new BattleReader();
  r.read(realLog);
  applyObservations(r.state);
  // p1 Raging Bolt ate Great Tusk Earthquakes -> low Def EVs expected.
  const rag = r.state.sides.p1.pokemon.find((m) => m.species === 'Raging Bolt');
  assert.ok(rag.evEstimate?.def, 'Raging Bolt should have a def estimate');
  assert.ok(rag.evEstimate.def[1] <= 100, `frail Raging Bolt, got ${rag.evEstimate.def}`);
  // p2 Glimmora (special attacker) -> high SpA expected.
  const glim = r.state.sides.p2.pokemon.find((m) => m.species === 'Glimmora');
  assert.ok(glim.evEstimate?.spa, 'Glimmora should have a spa estimate');
  assert.ok(glim.evEstimate.spa[0] >= 150, `offensive Glimmora, got ${glim.evEstimate.spa}`);
});
