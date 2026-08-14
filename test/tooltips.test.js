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

test('parseTooltipText reads the opponent Spe range (min–ev0–ev252–max)', () => {
  const obs = parseTooltipText(REAL_TOOLTIP);
  // "Spe 139–186–249–273 / (before external modifiers)" — the opponent's
  // tooltip shows their exact EV/nature speed bounds, not exact stats.
  assert.deepEqual(obs.speedRange, { min: 139, max: 273 });
  assert.equal(obs.stats, undefined);
});

test('parseTooltipText reads the exact stat line for our own Pokémon', () => {
  // The client shows raw stats (EVs + nature) for our own mons. This is the
  // tooltip text as rendered from the client's markup (innerText).
  const obs = parseTooltipText(
    `Dragonite\n\nHP: 100/100\n\nAbility: Multiscale\n\nItem: Leftovers\n\nAtk 147 / Def 100 / SpA 70 / SpD 80 / Spe 122\n\n• Outrage (10/10)`
  );
  assert.deepEqual(obs.stats, { atk: 147, def: 100, spa: 70, spd: 80, spe: 122 });
  assert.equal(obs.statsEffective, undefined);
});

test('parseTooltipText reads the boosted "(After stat modifiers:)" line', () => {
  // With a +1 Speed stage the client adds a second, modified stat line.
  const obs = parseTooltipText(
    `Dragonite\n\nHP: 100/100\n\nAtk 147 / Def 100 / SpA 70 / SpD 80 / Spe 122\n(After stat modifiers:)\nAtk 147 / Def 100 / SpA 70 / SpD 80 / Spe 183`
  );
  assert.deepEqual(obs.stats, { atk: 147, def: 100, spa: 70, spd: 80, spe: 122 });
  assert.deepEqual(obs.statsEffective, { atk: 147, def: 100, spa: 70, spd: 80, spe: 183 });
});

test('parseTooltipText handles OCR-dash noise in the Spe range', () => {
  const obs = parseTooltipText('Spe 100-122 (before external modifiers)');
  assert.deepEqual(obs.speedRange, { min: 100, max: 122 });
  const obs2 = parseTooltipText('Spe 100 to 122');
  assert.deepEqual(obs2.speedRange, { min: 100, max: 122 });
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

test('parseTooltipText tolerates noisy OCR output (stray scene text above the tooltip)', () => {
  // Real OCR output from a captured frame: battle-scene text bleeds into the
  // top of the crop, then the tooltip lines follow. The species must be the
  // first name-like line, not the noise, and OCR bullet glyphs («, *) are
  // accepted alongside •.
  const obs = parseTooltipText(
    `Grassy Terrain (4 or 7 turns)\nRaging Bolt\nAbility: Protosynthesis\nItem: Booster Energy\n« Dragon Pulse (15/16)\n* Thunderbolt (15/16)`
  );
  assert.equal(obs.species, 'Raging Bolt');
  assert.equal(obs.ability, 'Protosynthesis');
  assert.equal(obs.item, 'Booster Energy');
  assert.deepEqual(obs.moves, [
    { name: 'Dragon Pulse', pp: 15, maxpp: 16 },
    { name: 'Thunderbolt', pp: 15, maxpp: 16 },
  ]);
});

test('parseTooltipText ignores parenthesized/noise lines when picking the species', () => {
  const obs = parseTooltipText(`Turn 22 (some banner)\nTogekiss\nAbility: Serene Grace`);
  assert.equal(obs.species, 'Togekiss');
  // A line with digits or colons never becomes the species.
  const junk = parseTooltipText('2 , Tee\nTogekiss\nAbility: Serene Grace');
  assert.equal(junk.species, 'Togekiss');
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
