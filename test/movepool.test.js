// test/movepool.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPokemon, addMove } from '../src/reader/state.js';
import { potentialMoves, worstThreat, teamThreats } from '../src/engine/movepool.js';

function makeMon(species, { moves = [], teraType = null, terastallized = false } = {}) {
  const rec = createPokemon({ ident: `p1a: ${species}`, side: 'p1', species });
  for (const m of moves) addMove(rec, m);
  if (teraType) rec.teraType = teraType;
  if (terastallized) rec.terastallized = true;
  return rec;
}

test('potentialMoves returns the Gen 9-legal learnset for a species', () => {
  const moves = potentialMoves('Dragonite');
  assert.ok(moves.length > 40, `expected a real learnset, got ${moves.length}`);
  for (const probe of ['Outrage', 'Dragon Dance', 'Earthquake', 'Extreme Speed', 'Hurricane']) {
    assert.ok(moves.includes(probe), `Dragonite should be able to learn ${probe}`);
  }
  assert.deepEqual(potentialMoves('Dragonite'), moves); // memoized
  assert.deepEqual(potentialMoves('Totally-Not-A-Species'), []);
});

test('worstThreat finds the strongest hidden move and excludes revealed ones', () => {
  // Their Glimmora has only revealed Mortal Spin; Charizard (Fire/Flying) is
  // 4× weak to Rock — the engine should flag the hidden Rock coverage.
  const glimmora = makeMon('Glimmora', { moves: ['Mortal Spin'] });
  const charizard = makeMon('Charizard');
  const threat = worstThreat(glimmora, charizard, 9, null);
  assert.ok(threat, 'expected a hidden threat');
  assert.equal(threat.eff, 4);
  assert.ok(['Meteor Beam', 'Stone Edge', 'Power Gem'].includes(threat.move), `got ${threat.move}`);
  assert.ok(threat.pct > 30, `hidden Rock move should hurt, got ${threat.pct}%`);
  // The revealed move must never be reported as a "hidden" threat.
  assert.notEqual(threat.move, 'Mortal Spin');
});

test('worstThreat returns null when the whole learnset is revealed', () => {
  // Reveal everything the species can know — nothing is hidden anymore.
  const venusaur = makeMon('Venusaur', { moves: potentialMoves('Venusaur') });
  const dnite = makeMon('Dragonite');
  assert.equal(worstThreat(venusaur, dnite, 9, null), null);
});

test('teamThreats ranks hidden threats across the team, filtered by minPct', () => {
  const glimmora = makeMon('Glimmora', { moves: ['Mortal Spin'] });
  const charizard = makeMon('Charizard');
  const togekiss = makeMon('Togekiss');
  const threats = teamThreats(glimmora, [togekiss, charizard], 9, null, {}, { top: 2, minPct: 30 });
  assert.ok(threats.length >= 1);
  assert.equal(threats[0].target, 'Charizard'); // 4× weak to the hidden Rock moves
  assert.ok(threats.every((t) => t.pct >= 30));
});

test('worstThreat accounts for a terastallized attacker', () => {
  // Same Ogerpon, same revealed moves, but one is terastallized (Grass): the
  // tera STAB boost (1.5× → 2×) should make its hidden Grass coverage hit
  // Rhyperior (Ground/Rock, 4× weak to Grass) noticeably harder.
  const ogerpon = makeMon('Ogerpon', { moves: ['Stomping Tantrum'] });
  const ogerponTera = makeMon('Ogerpon', { moves: ['Stomping Tantrum'], teraType: 'Grass', terastallized: true });
  const rhyperior = makeMon('Rhyperior');
  const plain = worstThreat(ogerpon, rhyperior, 9, null);
  const tera = worstThreat(ogerponTera, rhyperior, 9, null);
  assert.ok(plain && tera, 'expected hidden threats in both cases');
  assert.equal(plain.eff, 4);
  assert.equal(tera.eff, 4);
  assert.ok(tera.pct > plain.pct, `tera should amplify the threat (${tera.pct} vs ${plain.pct})`);
});
