// test/movepool.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPokemon, addMove } from '../src/reader/state.js';
import { potentialMoves, worstThreat, teamThreats, topPotentialMoves, usageWeight } from '../src/engine/movepool.js';

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

test('usageWeight returns Smogon usage % for common moves, null otherwise', () => {
  // Great Tusk runs Rapid Spin on ~92% of sets per the bundled stats.
  assert.equal(usageWeight('Great Tusk', 'Rapid Spin'), 92.0);
  assert.ok(usageWeight('Great Tusk', 'Headlong Rush') > 80);
  // A legal-but-uncommon move has no usage entry.
  assert.equal(usageWeight('Great Tusk', 'Tackle'), null);
  assert.equal(usageWeight('Totally-Not-A-Species', 'Tackle'), null);
});

test('topPotentialMoves ranks by usage stats, not raw base power', () => {
  // Great Tusk's most-used damaging moves are Rapid Spin (92%), Headlong
  // Rush (81.7%), Ice Spinner (77.6%) — while raw base power would put
  // Earthquake / Close Combat / Headlong Rush first.
  const top = topPotentialMoves('Great Tusk', 3);
  assert.equal(top[0], 'Rapid Spin');
  assert.equal(top[1], 'Headlong Rush');
  assert.equal(top[2], 'Ice Spinner');
});

test('topPotentialMoves falls back to base power for species without usage data', () => {
  const top = topPotentialMoves('Totally-Not-A-Species', 2);
  assert.deepEqual(top, []);
  // A species in the learnset but absent from usage stats (e.g. never used)
  // still gets a sensible list, just sorted by power.
  const moves = topPotentialMoves('Rillaboom', 2);
  assert.ok(moves.length >= 1);
});

test('topPotentialMoves excludes status moves and non-damaging moves', () => {
  const top = topPotentialMoves('Dragonite', 5);
  assert.ok(top.length >= 1);
  // Dragon Dance is Dragonite's #1 usage move, but it's status — the
  // "could have" list is for damage threats.
  assert.ok(!top.includes('Dragon Dance'), 'status moves excluded');
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

test('worstThreat returns null once all 4 moves are revealed', () => {
  // A Pokémon can only know 4 moves — once all 4 are seen there is nothing
  // left to speculate about, even though the species' learnset is larger.
  const dnite = makeMon('Dragonite', { moves: ['Outrage', 'Earthquake', 'Fire Punch', 'Ice Beam'] });
  const charizard = makeMon('Charizard');
  assert.equal(worstThreat(dnite, charizard, 9, null), null);
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
