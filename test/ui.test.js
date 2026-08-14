// test/ui.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseLog } from '../src/reader/reader.js';
import { createPokemon } from '../src/reader/state.js';
import { buildPanelModel, renderPanel, buildPanelHtml, escapeHtml } from '../src/ui/panel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const realLog = readFileSync(path.join(__dirname, 'fixtures', 'real-battle.log'), 'utf8');
const state = parseLog(realLog);

// ---------------------------------------------------------------------------
// Display model
// ---------------------------------------------------------------------------

test('model: metadata, teams, and active mons', () => {
  const m = buildPanelModel(state);
  assert.equal(m.meta.format, '[Gen 9] OU');
  assert.equal(m.meta.turn, 22);
  assert.equal(m.meta.winner, 'BaddyGames');
  assert.equal(m.meta.ourName, 'BaddyGames');
  assert.equal(m.meta.oppName, 'vkhss');
  assert.equal(m.empty, false);
  assert.equal(m.us.team.length, 6);
  assert.equal(m.them.team.length, 6);

  const usActive = m.us.team.filter((c) => c.active);
  const themActive = m.them.team.filter((c) => c.active);
  assert.equal(usActive.length, 1);
  assert.equal(themActive.length, 1);
  assert.equal(usActive[0].species, 'Rillaboom'); // last one standing
  assert.equal(themActive[0].species, 'Dragonite');
});

test('model: HP, status, moves, hidden counts, items', () => {
  const m = buildPanelModel(state);
  const us = (s) => m.us.team.find((c) => c.species === s);
  const them = (s) => m.them.team.find((c) => c.species === s);

  // Rillaboom alive at 1% with poison.
  assert.equal(us('Rillaboom').hpPercent, 1);
  assert.equal(us('Rillaboom').status, 'psn');
  assert.equal(us('Rillaboom').fainted, false);
  assert.equal(us('Rillaboom').item, null);
  assert.equal(us('Rillaboom').itemKnown, false);

  // Dragonite: 2 moves revealed -> 2 hidden; item was knocked off.
  assert.deepEqual(them('Dragonite').moves, ['Encore', 'Scale Shot']);
  assert.equal(them('Dragonite').hiddenCount, 2);
  assert.equal(them('Dragonite').item, 'Loaded Dice');
  assert.equal(them('Dragonite').itemKnown, true);
  assert.equal(them('Dragonite').itemConsumed, true);

  // Great Tusk still holding Leftovers.
  assert.equal(them('Great Tusk').item, 'Leftovers');
  assert.equal(them('Great Tusk').itemConsumed, false);

  // Boosts surfaced.
  assert.deepEqual(them('Roaring Moon').boosts, { atk: 1, spe: 1 });
  assert.deepEqual(us('Iron Treads').boosts, { spe: 1, spd: -1 });

  // Whole opponent team fainted.
  assert.equal(m.them.team.every((c) => c.fainted), true);
  assert.equal(m.us.team.filter((c) => c.fainted).length, 5);
});

test('model: our exact stats come from the live request / hover (points)', () => {
  const st = parseLog(realLog);
  const rill = st.sides.p1.pokemon.find((m) => m.species === 'Rillaboom');
  rill.stats = { atk: 172, def: 111, spa: 81, spd: 101, spe: 141 };
  const m = buildPanelModel(st);
  const card = m.us.team.find((c) => c.species === 'Rillaboom');
  assert.equal(card.statsExact, true);
  assert.deepEqual(
    card.stats.map((s) => [s.key, s.text, s.exact]),
    [
      ['A', '172', true],
      ['D', '111', true],
      ['SA', '81', true],
      ['SD', '101', true],
      ['S', '141', true],
    ]
  );
});

test('model: opponent stats are estimated ranges, narrowed by hover + learned EV', () => {
  const st = parseLog(realLog);
  const dn = st.sides.p2.pokemon.find((m) => m.species === 'Dragonite');
  dn.speedRange = { min: 109, max: 205 }; // hovered Spe bounds
  dn.evEstimate = { atk: [200, 252], spa: [0, 252], def: [0, 252], spd: [0, 252], hp: [0, 252] };
  const m = buildPanelModel(st);
  const card = m.them.team.find((c) => c.species === 'Dragonite');
  assert.equal(card.statsExact, false);
  const byKey = Object.fromEntries(card.stats.map((s) => [s.key, s.text]));
  // The learned Atk EV range [200,252] narrows the calc range to a point-ish
  // band; the hovered Spe range replaces the generic estimate.
  assert.equal(byKey.S, '109-205');
  assert.notEqual(byKey.A, '203-310'); // default 0-252 EV range for base-134 Atk
  assert.equal(byKey.A, '354-367');
});

test('model: stats are omitted for species the calc does not know', () => {
  const st = parseLog(realLog);
  st.sides.p2.pokemon.push(createPokemon({ ident: 'p2x: Missingno', side: 'p2', species: 'Missingno' }));
  const m = buildPanelModel(st);
  const card = m.them.team.find((c) => c.species === 'Missingno');
  assert.equal(card.stats, null);
});

test('model: field, side effects, and the action journal', () => {
  const m = buildPanelModel(state);
  assert.ok(m.field.includes('terrain: Grassy Terrain'));
  assert.ok(m.field.includes('weather: none'));
  assert.deepEqual(m.us.sideEffects, ['Toxic Spikes']);
  assert.deepEqual(m.them.sideEffects, []);

  assert.ok(m.recentActions.length > 0);
  const first = m.recentActions[0];
  assert.equal(first.turn, 22);
  assert.ok(first.text.includes('p2a: Dragonite'));
});

test('model: recommendation slot is a clean contract for the engine', () => {
  const rec = {
    bestMove: { move: 'Earthquake' },
    switchTo: { species: 'Rillaboom' },
    reasoning: ['Strong vs their team', 'Covers their likely switch-in'],
    note: null,
  };
  const m = buildPanelModel(state, { recommendation: rec });
  const html = renderPanel(m);
  assert.ok(html.includes('Earthquake'));
  assert.ok(html.includes('Rillaboom'));
  assert.ok(html.includes('Strong vs their team'));
  assert.ok(html.includes('Covers their likely switch-in'));
});

test('render: recommendation confidence badges are shown', () => {
  const rec = {
    bestMove: { move: 'Thunder Wave', confidence: 72 },
    switchTo: { species: 'Garchomp', confidence: 28 },
    reasoning: [],
    note: null,
  };
  const html = renderPanel(buildPanelModel(state, { recommendation: rec }));
  assert.ok(html.includes('Thunder Wave'), 'move name shown');
  assert.ok(html.includes('psa-rec-conf'), 'confidence badge markup present');
  assert.ok(html.includes('>72%<'), 'move confidence rendered');
  assert.ok(html.includes('>28%<'), 'switch confidence rendered');
  // No confidence -> no badge.
  const plain = renderPanel(buildPanelModel(state, { recommendation: { bestMove: { move: 'Earthquake' }, switchTo: null, reasoning: [], note: null } }));
  assert.ok(!plain.includes('psa-rec-conf'));
});

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

test('render: stats row shows exact values for us and ranges for them', () => {
  const st = parseLog(realLog);
  const rill = st.sides.p1.pokemon.find((m) => m.species === 'Rillaboom');
  rill.stats = { atk: 172, def: 111, spa: 81, spd: 101, spe: 141 };
  const dn = st.sides.p2.pokemon.find((m) => m.species === 'Dragonite');
  dn.speedRange = { min: 109, max: 205 };
  const html = renderPanel(buildPanelModel(st));
  // Our exact stats render with the exact-tint class.
  assert.ok(html.includes('class="psa-stat psa-stat-exact">A 172</span>'));
  assert.ok(html.includes('>S 141</span>'));
  // Their Spe uses the hovered range and renders as a plain estimate.
  assert.ok(html.includes('class="psa-stat">S 109-205</span>'));
});

test('render: full panel output for the real battle', () => {
  const html = buildPanelHtml(state);
  assert.ok(html.startsWith('<div class="psa-panel"'));
  assert.ok(html.includes('data-opp="vkhss"'));
  assert.ok(html.includes('data-turn="22"'));
  assert.ok(html.includes('Turn 22'));
  assert.ok(html.includes('BaddyGames wins'));
  assert.ok(html.includes('Dragonite'));
  assert.ok(html.includes('Scale Shot'));
  assert.ok(html.includes('(+2 hidden)'));
  assert.ok(html.includes('item: ?')); // Rillaboom's unrevealed item
  assert.ok(html.includes('Toxic Spikes'));
  assert.ok(html.includes('psa-hpfill'));
  assert.ok(html.includes('width:1%')); // Rillaboom HP bar
  assert.ok(html.includes('psa-status-psn'));
  assert.ok(html.includes('psa-collapse'));
  assert.ok(html.includes('psa-log'));
  // Fainted styling on opponent cards.
  assert.ok((html.match(/psa-fainted/g) ?? []).length >= 6);
});

test('render: active mon is highlighted and fainted mons are tagged', () => {
  const html = buildPanelHtml(state);
  assert.ok(html.includes('psa-active'));
  assert.ok(html.includes('on field'));
  assert.ok(html.includes('fainted'));
});

test('render: escaping — no raw HTML from battle data', () => {
  const evil = parseLog(realLog);
  evil.sides.p2.pokemon[0].species = '<img src=x onerror=alert(1)>';
  const html = buildPanelHtml(evil);
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
  assert.equal(escapeHtml('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
});

test('render: mid-battle state (partial log) works', () => {
  const lines = realLog.split('\n');
  const prefix = lines.slice(0, lines.indexOf('|turn|2')).join('\n');
  const partial = parseLog(prefix);
  const m = buildPanelModel(partial);
  assert.equal(m.meta.turn, 1);
  assert.equal(m.meta.winner, null);
  const usActive = m.us.team.find((c) => c.active);
  const themActive = m.them.team.find((c) => c.active);
  assert.equal(usActive.species, 'Raging Bolt');
  assert.equal(usActive.hpPercent, 7);
  assert.equal(themActive.species, 'Great Tusk');
  assert.equal(themActive.hpPercent, 21);
  const html = renderPanel(m);
  assert.ok(html.includes('7%'));
  assert.ok(html.includes('21%'));
  assert.ok(!html.includes('wins'));
});

test('render: empty / no-battle state', () => {
  const html = buildPanelHtml(parseLog(''));
  assert.ok(html.includes('No battle data yet'));
  assert.ok(html.includes('psa-collapse'));
});

test('render: our-side selection (we are p2)', () => {
  const m = buildPanelModel(state, { ourSideId: 'p2' });
  assert.equal(m.meta.ourName, 'vkhss');
  assert.equal(m.meta.oppName, 'BaddyGames');
  assert.equal(m.us.team.filter((c) => c.active)[0].species, 'Dragonite');
});

test('model+render: watching status row and observed tags', () => {
  // Default: the hint is shown, no count yet.
  const m0 = buildPanelModel(state);
  assert.equal(m0.watching.count, 0);
  assert.equal(m0.watching.last, null);
  const html0 = renderPanel(m0);
  assert.ok(html0.includes('watching your screen — hover a Pokémon to read it'));
  assert.ok(!html0.includes('read 1 tooltip'));

  // After hovers: the counter and last-read species appear.
  const m = buildPanelModel(state, { watching: { count: 2, last: 'Rillaboom' } });
  assert.equal(m.watching.count, 2);
  const html = renderPanel(m);
  assert.ok(html.includes('read 2 tooltips · last: Rillaboom'));
  assert.ok(html.includes('psa-watch'));

  // Observed cards carry a 👁 tag.
  const tagged = parseLog(realLog);
  const dn = tagged.sides.p2.pokemon.find((p) => p.species === 'Dragonite');
  dn.observed = true;
  const htmlTagged = renderPanel(buildPanelModel(tagged));
  assert.ok(htmlTagged.includes('psa-tag-observed'));
  assert.ok(htmlTagged.includes('👁'));
});

test('model+render: six-slot grid per side with placeholders', () => {
  const m = buildPanelModel(state);
  // Both teams show exactly 6 slots.
  assert.equal(m.us.slots.length, 6);
  assert.equal(m.them.slots.length, 6);
  // The fixture has full teams, so every slot is filled.
  assert.equal(m.us.slots.filter((s) => s.empty).length, 0);
  assert.equal(m.them.slots.filter((s) => s.empty).length, 0);

  const html = renderPanel(m);
  assert.ok(html.includes('psa-slot-grid'));
  // Six cards per side in the grid.
  assert.equal((html.match(/psa-card/g) ?? []).length >= 12, true);

  // A partially-revealed side keeps the 6 slots: species are known from team
  // preview (|poke|) and shown as preview cards, not blank placeholders.
  const partial = parseLog(realLog.split('\n').slice(0, 60).join('\n'));
  const mp = buildPanelModel(partial);
  assert.equal(mp.us.slots.length, 6);
  const previews = mp.us.slots.filter((s) => s.preview);
  assert.ok(previews.length >= 3, 'preview cards show roster species before reveal');
  assert.ok(previews.some((s) => s.species === 'Kingambit'));
  const htmlP = renderPanel(mp);
  assert.ok(htmlP.includes('psa-preview'));
  assert.ok(htmlP.includes('Kingambit'));
  // Slots beyond the known roster stay empty placeholders.
  const emptyOnly = buildPanelModel(parseLog('|player|p1|A|lucas|\n|player|p2|B|ethan|\n|gen|9|'));
  assert.ok(emptyOnly.us.slots.every((s) => s.empty));
});

test('model+render: potential moves shown for the opponent only', () => {
  const fake = { species: 'Dragonite' };
  const m = buildPanelModel(state, {
    getPotentialMoves: (s) => (s === 'Dragonite' ? ['Hurricane', 'Earthquake', 'Fire Punch'] : []),
  });
  // Dragonite has 2 revealed moves -> 2 hidden -> potential list populated.
  const themDn = m.them.slots.find((c) => !c.empty && c.species === 'Dragonite');
  assert.deepEqual(themDn.potential, ['Hurricane', 'Earthquake', 'Fire Punch']);
  // Our side never gets potential moves (we know our own sets).
  const usRb = m.us.slots.find((c) => !c.empty && c.species === 'Raging Bolt');
  assert.equal(usRb.potential.length, 0);

  const html = renderPanel(m);
  assert.ok(html.includes('psa-potential'));
  assert.ok(html.includes('could have: Hurricane · Earthquake · Fire Punch'));
});

test('model+render: capture status row', () => {
  // Idle: the watch row hints at hover-reading only.
  const m0 = buildPanelModel(state, { capture: { active: false, frames: 0, changes: 0 } });
  const html0 = renderPanel(m0);
  assert.ok(html0.includes('watching your screen'));
  assert.ok(!html0.includes('capturing screen'));
  assert.ok(!html0.includes('psa-watch-live'));

  // Live: the row reports frames/changes and gets the live class + ● icon.
  const m1 = buildPanelModel(state, { capture: { active: true, frames: 42, changes: 7 } });
  assert.equal(m1.capture.active, true);
  const html1 = renderPanel(m1);
  assert.ok(html1.includes('● capturing screen · 42 frames · 7 changes seen'));
  assert.ok(html1.includes('psa-watch-live'));

  // Frames increment renders (partial state).
  const m2 = buildPanelModel(state, { capture: { active: true, frames: 43, changes: 8 } });
  const html2 = renderPanel(m2);
  assert.ok(html2.includes('43 frames · 8 changes'));
});
