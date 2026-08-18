// test/randoms.test.js
// Random Battle awareness: format detection, template movepool restriction,
// per-species default levels, and OU usage-weight neutralization.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  setBattleFormat,
  isRandomBattle,
  randomsMoves,
  randomsLevel,
  randomsAbilities,
  randomsTeraTypes,
  potentialMoves,
  usageWeight,
  topPotentialMoves,
  worstThreat,
  buildPokemon,
  damagePercent,
} from '../src/engine/index.js';

// Never leak the current-format global into other suites.
after(() => setBattleFormat(null));

test('isRandomBattle: detects the tier display name and the room id', () => {
  setBattleFormat(null, null);
  assert.equal(isRandomBattle(), false);

  setBattleFormat('[Gen 9] OU');
  assert.equal(isRandomBattle(), false);

  setBattleFormat('[Gen 9] Random Battle');
  assert.equal(isRandomBattle(), true);

  // Random Doubles has its own room id but the tier also says random.
  setBattleFormat('[Gen 9] Random Doubles Battle');
  assert.equal(isRandomBattle(), true);

  // Room-id fallback (the tier line can arrive late).
  setBattleFormat(null, 'battle-gen9randombattle-123456');
  assert.equal(isRandomBattle(), true);

  setBattleFormat(null, 'battle-gen9ou-123456');
  assert.equal(isRandomBattle(), false);

  setBattleFormat(null, null);
  assert.equal(isRandomBattle(), false);
});

test('randomsEntry: template level, movepool, abilities, and tera types', () => {
  setBattleFormat('[Gen 9] Random Battle');
  assert.equal(randomsLevel('Weavile'), 79);
  assert.deepEqual(randomsMoves('Weavile'), ['Ice Shard', 'Knock Off', 'Low Kick', 'Swords Dance', 'Triple Axel']);
  assert.deepEqual(randomsAbilities('Weavile'), ['Pickpocket']);
  assert.deepEqual(randomsTeraTypes('Weavile'), ['Dark', 'Fighting', 'Ice']);
  assert.equal(randomsLevel('MissingNo'), null);
  assert.deepEqual(randomsMoves('MissingNo'), []);
});

test('potentialMoves: random battles use the template pool, not the full learnset', () => {
  // Outside randoms, Weavile can know its whole Gen 9 learnset (~70 moves).
  setBattleFormat(null);
  const full = potentialMoves('Weavile');
  assert.ok(full.length > 50, `full learnset should be large, got ${full.length}`);

  // In randoms, only the template pool — the 5 moves a random team can roll.
  setBattleFormat('[Gen 9] Random Battle');
  const pool = potentialMoves('Weavile');
  assert.deepEqual(pool, ['Ice Shard', 'Knock Off', 'Low Kick', 'Swords Dance', 'Triple Axel']);

  // The memo must not leak pools across formats.
  setBattleFormat(null);
  assert.equal(potentialMoves('Weavile').length, full.length);
});

test('usageWeight: OU usage is neutralized in random battles', () => {
  setBattleFormat(null);
  assert.equal(typeof usageWeight('Garchomp', 'Earthquake'), 'number');

  setBattleFormat('[Gen 9] Random Battle');
  assert.equal(usageWeight('Garchomp', 'Earthquake'), null);
});

test('topPotentialMoves: in randoms only template moves appear, ordered by power', () => {
  setBattleFormat('[Gen 9] Random Battle');
  const top = topPotentialMoves('Garchomp', 4, 9);
  assert.ok(top.length > 0);
  for (const m of top) {
    assert.ok(randomsMoves('Garchomp').includes(m), `${m} should be in Garchomp's random pool`);
  }
});

test('worstThreat: hidden threats are limited to the random template pool', () => {
  setBattleFormat('[Gen 9] Random Battle');
  const theirChomp = { ident: 'p2a: Garchomp', species: 'Garchomp', moves: [] };
  const ourWeavile = { ident: 'p1a: Weavile', species: 'Weavile', moves: ['Knock Off'] };
  const t = worstThreat(theirChomp, ourWeavile, 9, null);
  assert.ok(t, 'there should be a hidden threat in randoms');
  assert.ok(
    randomsMoves('Garchomp').includes(t.move),
    `hidden threat ${t.move} must be in the random pool (got ${randomsMoves('Garchomp').join(', ')})`
  );
});

test('buildPokemon: unrevealed mons default to the template level in randoms, 100 otherwise', () => {
  setBattleFormat(null);
  assert.equal(buildPokemon(9, { species: 'Weavile' }, {}, null).level, 100);

  setBattleFormat('[Gen 9] Random Battle');
  assert.equal(buildPokemon(9, { species: 'Weavile' }, {}, null).level, 79);

  // A revealed level always wins over the template default.
  assert.equal(buildPokemon(9, { species: 'Weavile', level: 90 }, {}, null).level, 90);

  // Species outside the random pool still default to 100.
  assert.equal(buildPokemon(9, { species: 'Unown' }, {}, null).level, 100);
});

test('damagePercent: randoms levels change the numbers (L79 vs L100 Weavile)', () => {
  setBattleFormat(null);
  // Real-set spreads are a gen-9 pre-made feature (and Garchomp's random
  // template level is 74, not 100) — isolate the LEVEL effect by comparing
  // both sides under the same controlled EV model.
  const d100 = damagePercent(9, { species: 'Weavile', moves: ['Icicle Crash'] }, { species: 'Garchomp' }, 'Icicle Crash', null, { sets: false });
  setBattleFormat('[Gen 9] Random Battle');
  const dRandom = damagePercent(9, { species: 'Weavile', moves: ['Icicle Crash'] }, { species: 'Garchomp' }, 'Icicle Crash', null);
  assert.notEqual(dRandom.mean, d100.mean, `randoms levels should change damage (${dRandom.mean} vs ${d100.mean})`);
});
