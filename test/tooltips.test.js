// test/tooltips.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTooltipText, resolveMon } from '../src/content/tooltips.js';
import { createBattleState, createPokemon, addMove } from '../src/reader/state.js';

// The real tooltip text captured from a battle page (hovering Raging Bolt in
// the team sidebar of the fixture replay — see scripts/probe-tooltips.js).
const REAL_TOOLTIP = `Raging Bolt
 
HP: (fainted)

Ability: Protosynthesis

Item: None (Booster Energy was consumed)

Spe 139–186–249–273
(before external modifiers)

• Dragon Pulse (15/16)
`;

test('parseTooltipText reads species, labels, and moves with PP', () => {
  const obs = parseTooltipText(REAL_TOOLTIP);
  assert.equal(obs.species, 'Raging Bolt');
  assert.equal(obs.hpText, '(fainted)');
  assert.equal(obs.ability, 'Protosynthesis');
  assert.equal(obs.item, null); // 'None (… consumed)'
  assert.equal(obs.itemConsumed, true);
  assert.deepEqual(obs.moves, [{ name: 'Dragon Pulse', pp: 15, maxpp: 16 }]);
});

test('parseTooltipText handles a normal item, tera type, and no-PP moves', () => {
  const obs = parseTooltipText(
    `Togekiss

HP: 100/100

Ability: Serene Grace

Item: Leftovers

Tera Type: Fire

• Air Slash
• Roost (4/8)
`
  );
  assert.equal(obs.species, 'Togekiss');
  assert.equal(obs.item, 'Leftovers');
  assert.equal(obs.itemConsumed, undefined);
  assert.equal(obs.teraType, 'Fire');
  assert.deepEqual(obs.moves, [
    { name: 'Air Slash', pp: null, maxpp: null },
    { name: 'Roost', pp: 4, maxpp: 8 },
  ]);
});

test('parseTooltipText returns a safe empty shape for junk input', () => {
  assert.deepEqual(parseTooltipText(''), { moves: [] });
  assert.deepEqual(parseTooltipText(null), { moves: [] });
  assert.deepEqual(parseTooltipText('   \n \n'), { moves: [] });
});

// ---------------------------------------------------------------------------
// resolveMon
// ---------------------------------------------------------------------------

function makeState() {
  const state = createBattleState();
  const mk = (side, ident, species) => {
    const rec = createPokemon({ ident, side, species });
    if (side === 'p1') state.sides.p1.pokemon.push(rec);
    else state.sides.p2.pokemon.push(rec);
    return rec;
  };
  mk('p1', 'p1a: Rillaboom', 'Rillaboom');
  const dn = mk('p2', 'p2a: Dragonite', 'Dragonite');
  addMove(dn, 'Outrage');
  return state;
}

test('resolveMon uses sideId + species first', () => {
  const state = makeState();
  const mon = resolveMon(state, { sideId: 'p2', species: 'Dragonite', slotSpecies: 'Dragonite' });
  assert.equal(mon?.ident, 'p2a: Dragonite');
});

test('resolveMon falls back to a species search across sides', () => {
  const state = makeState();
  const mon = resolveMon(state, { species: 'Rillaboom' }); // no sideId
  assert.equal(mon?.ident, 'p1a: Rillaboom');
});

test('resolveMon returns null when nothing matches', () => {
  const state = makeState();
  assert.equal(resolveMon(state, { species: 'Missingno' }), null);
  assert.equal(resolveMon(state, { species: 'Missingno', sideId: 'p2' }), null);
  assert.equal(resolveMon(state, {}), null);
});
