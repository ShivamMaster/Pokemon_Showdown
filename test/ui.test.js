// test/ui.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseLog } from '../src/reader/reader.js';
import { createPokemon, addMove } from '../src/reader/state.js';
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

test('model: the speed memory narrows the opponent Spe range on their card', () => {
  const st = parseLog(realLog);
  const defaultCard = buildPanelModel(st).them.team.find((c) => c.species === 'Dragonite');
  assert.equal(defaultCard.stats.find((s) => s.key === 'S').text, '196-284');
  assert.equal(defaultCard.stats.find((s) => s.key === 'S').remembered, false);

  // Remembered from earlier trades: slower than a 220-Speed mon, faster than
  // a 205-Speed mon — the Spe range tightens from both ends.
  st.speedMemory.p2.Dragonite = { min: 205, max: 220, turn: 3 };
  const m = buildPanelModel(st);
  const card = m.them.team.find((c) => c.species === 'Dragonite');
  const s = card.stats.find((x) => x.key === 'S');
  assert.equal(s.text, '205-220');
  assert.equal(s.remembered, true);
  assert.equal(s.exact, false, 'a remembered range is still an estimate');
  assert.equal(card.statsExact, false);

  // A memory that contradicts the species' possible Speed is discarded.
  st.speedMemory.p2.Dragonite = { min: 400, max: 500, turn: 3 };
  const fallback = buildPanelModel(st).them.team.find((c) => c.species === 'Dragonite');
  assert.equal(fallback.stats.find((x) => x.key === 'S').text, '196-284');
  assert.equal(fallback.stats.find((x) => x.key === 'S').remembered, false);
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

test('render: a remembered Spe range is visibly marked on the card', () => {
  const st = parseLog(realLog);
  st.speedMemory.p2.Dragonite = { min: null, max: 220, turn: 3 };
  const html = renderPanel(buildPanelModel(st));
  // The narrowed range renders with the remembered class + explaining tooltip.
  assert.ok(html.includes('psa-stat-remembered'));
  assert.ok(html.includes('S 196-220'));
  assert.ok(html.includes('title="Speed narrowed from observed move order — remembered from earlier trades"'));
  // No memory -> no marker.
  const plain = renderPanel(buildPanelModel(parseLog(realLog)));
  assert.ok(!plain.includes('psa-stat-remembered'));
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
  assert.ok(html.includes('psa-compact')); // compact-mode toggle
  assert.ok(html.includes('psa-resize')); // corner drag handle
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

// ---------------------------------------------------------------------------
// Active-matchup comparison (our lead vs their lead)
// ---------------------------------------------------------------------------

test('model: matchup shows both actives with stats and a speed line', () => {
  const lines = realLog.split('\n');
  const partial = parseLog(lines.slice(0, lines.indexOf('|turn|2')).join('\n'));
  const m = buildPanelModel(partial);
  assert.ok(m.matchup, 'both actives exist at turn 1 — the matchup must render');
  assert.equal(m.matchup.ours.species, 'Raging Bolt');
  assert.equal(m.matchup.theirs.species, 'Great Tusk');
  assert.equal(m.matchup.ours.hpPercent, 7);
  assert.equal(m.matchup.theirs.hpPercent, 21);
  // Five stats each (ranges here — a log-only state has no exact request data).
  assert.deepEqual(m.matchup.ours.stats.map((s) => s.key), ['A', 'D', 'SA', 'SD', 'S']);
  assert.deepEqual(m.matchup.theirs.stats.map((s) => s.key), ['A', 'D', 'SA', 'SD', 'S']);
  assert.ok(m.matchup.speed.includes('Speed') || m.matchup.speed.includes('outspeed'));
});

test('render: stat cells tint green on the side that certainly wins the stat', () => {
  const lines = realLog.split('\n');
  const partial = parseLog(lines.slice(0, lines.indexOf('|turn|2')).join('\n'));
  // Our Raging Bolt: exact stats known (live request). Atk/Def/SpD/Spe are
  // clearly below Great Tusk's ranges; SpA (160) overlaps 142-205 so it stays
  // neutral until more is known.
  partial.sides.p1.pokemon.find((m) => m.species === 'Raging Bolt').stats = {
    atk: 110, def: 110, spa: 160, spd: 110, spe: 165,
  };
  const html = renderPanel(buildPanelModel(partial));
  const table = html.slice(html.indexOf('<table class="psa-match-table"'), html.indexOf('</table>'));
  // Their wins are green on their column, ours dimmed (lose).
  assert.ok(table.includes('psa-match-them-col psa-match-win">21%'), 'HP: their higher % is green');
  assert.ok(table.includes('psa-match-us-col psa-match-lose">7%'), 'HP: our lower % is dimmed');
  assert.ok(table.includes('psa-match-them-col psa-match-win">298-361'), 'Atk: their higher range is green');
  assert.ok(table.includes('psa-match-them-col psa-match-win">210-300'), 'Spe: their higher range is green');
  // Overlapping range (ours 160 vs theirs 142-205) gets no tint at all.
  assert.ok(table.includes('psa-match-us-col ">160</td>'), 'SpA overlap stays neutral (no tint)');
  assert.ok(table.includes('psa-match-them-col ">142-205'), 'their overlapping SpA stays neutral');
  // The Spe row keeps its highlight on top of the tint.
  assert.ok(table.includes('psa-match-row-spe'), 'Spe row still highlighted');
  assert.ok(table.includes('psa-match-row-spe .psa-match-win') || table.includes('psa-match-row-spe'), 'Spe row marker present');
});

test('model+render: a stat inside the opponent range stays neutral (honest)', () => {
  const lines = realLog.split('\n');
  const partial = parseLog(lines.slice(0, lines.indexOf('|turn|2')).join('\n'));
  // Our exact Atk (300) falls inside their 298-361 range → too close to call.
  // Our exact Spe (165) is below their 210-300 → a certain loss.
  partial.sides.p1.pokemon.find((m) => m.species === 'Raging Bolt').stats = {
    atk: 300, def: 110, spa: 160, spd: 110, spe: 165,
  };
  const html = renderPanel(buildPanelModel(partial));
  const table = html.slice(html.indexOf('<table class="psa-match-table"'), html.indexOf('</table>'));
  assert.ok(table.includes('psa-match-us-col ">300</td>'), 'Atk inside their range stays neutral');
  assert.ok(!table.includes('psa-match-us-col psa-match-win">300'), 'no tint for an overlapping exact stat');
  assert.ok(table.includes('psa-match-us-col psa-match-lose">165'), 'Spe below their range dims ours');
  assert.ok(table.includes('psa-match-them-col psa-match-win">210-300'), 'their higher Spe tints green');
});

test('model: type edge — who hits whom super effectively at turn 1', () => {
  const lines = realLog.split('\n');
  const partial = parseLog(lines.slice(0, lines.indexOf('|turn|2')).join('\n'));
  const m = buildPanelModel(partial);
  const te = m.matchup.typeEdge;
  assert.ok(te, 'typeEdge is present when both actives exist');
  // Their revealed Earthquake is 2× against our Electric/Dragon Raging Bolt.
  assert.deepEqual(te.theirSE, [{ move: 'Earthquake', mult: 2 }]);
  // Our Dragon Pulse is neutral vs their Ground/Fighting — no SE coverage yet.
  assert.deepEqual(te.ourSE, []);
  // Likely-but-unrevealed threats from their learnset.
  const pot = te.theirPotentialSE.map((x) => x.move);
  assert.ok(pot.includes('Headlong Rush') && pot.includes('Ice Spinner'), 'potential SE threats listed');
});

test('model+render: our SE coverage shows up, and tera changes the math', () => {
  const lines = realLog.split('\n');
  const partial = parseLog(lines.slice(0, lines.indexOf('|turn|2')).join('\n'));
  const us = partial.sides.p1.pokemon.find((m) => m.species === 'Raging Bolt');
  // Ice Beam is 2× vs their Ground/Fighting — our SE coverage appears.
  us.moves = [...us.moves, 'Ice Beam'];
  const m = buildPanelModel(partial);
  assert.deepEqual(m.matchup.typeEdge.ourSE, [{ move: 'Ice Beam', mult: 2 }]);
  // If we tera to Flying, their Ground moves become immune — but Ice Spinner
  // (Ice vs Flying = 2×) becomes the hidden threat instead.
  us.terastallized = true;
  us.teraType = 'Flying';
  const te2 = buildPanelModel(partial).matchup.typeEdge;
  assert.deepEqual(te2.theirSE, [], 'Ground moves no longer hit a Flying tera');
  assert.ok(te2.theirPotentialSE.some((x) => x.move === 'Ice Spinner'), 'Ice Spinner is the new SE threat');
  const html = renderPanel(buildPanelModel(partial));
  assert.ok(html.includes('psa-match-row-type'), 'Type row renders');
  assert.ok(html.includes('psa-match-se'), 'SE cell is amber-highlighted');
});

test('render: type row shows revealed and possible SE hits side by side', () => {
  const lines = realLog.split('\n');
  const partial = parseLog(lines.slice(0, lines.indexOf('|turn|2')).join('\n'));
  const html = renderPanel(buildPanelModel(partial));
  assert.ok(html.includes('psa-match-row-type'), 'Type row present');
  // Their revealed Earthquake is 2×; the likely hidden ones are marked 'could:'.
  assert.ok(html.includes('Earthquake 2×'), 'revealed SE move named');
  assert.ok(html.includes('could:') && html.includes('Headlong Rush'), 'potential SE moves named as could-haves');
  // Ours: Dragon Pulse is neutral, so the cell says no coverage (muted).
  assert.ok(html.includes('no SE coverage'), 'our cell notes the lack of SE coverage');
  assert.ok(html.includes('psa-match-type-none'), 'no-coverage cell uses the muted style');
});

test('model: predicted damage for each side\'s best move', () => {
  const lines = realLog.split('\n');
  const partial = parseLog(lines.slice(0, lines.indexOf('|turn|2')).join('\n'));
  const d = buildPanelModel(partial).matchup.damage;
  assert.equal(d.ours.move, 'Dragon Pulse');
  assert.ok(Math.abs(d.ours.pct - 41.6) < 0.1, 'our best hit is ~42%');
  assert.equal(d.theirs.move, 'Earthquake');
  assert.ok(Math.abs(d.theirs.pct - 66.2) < 0.1, 'their best hit is ~66%');
  // The likely-but-unrevealed threat is kept when it genuinely threatens.
  assert.equal(d.theirHidden.move, 'Headlong Rush');
  assert.ok(d.theirHidden.pct > 75, 'hidden threat is ~80%');
});

test('render: damage row with win/dim tinting and the hidden-move warning', () => {
  const lines = realLog.split('\n');
  const partial = parseLog(lines.slice(0, lines.indexOf('|turn|2')).join('\n'));
  const html = renderPanel(buildPanelModel(partial));
  const row = html.slice(html.indexOf('psa-match-row-dmg'), html.indexOf('</tr>', html.indexOf('psa-match-row-dmg')));
  assert.ok(row.includes('psa-match-row-dmg'), 'damage row present');
  assert.ok(row.includes('~42% Dragon Pulse'), 'our best hit shown');
  assert.ok(row.includes('~66% Earthquake'), 'their best hit shown');
  assert.ok(row.includes('could: ~80% Headlong Rush'), 'hidden threat flagged as could-have');
  assert.ok(row.includes('psa-match-lose'), 'our lower damage is dimmed');
  assert.ok(row.includes('psa-match-win'), 'their higher damage is tinted green');
  // Roll range in the tooltip.
  assert.ok(row.includes('38.2-45.2% roll'), 'our roll range is in the tooltip');
  // Mini chunk bars next to each damage figure.
  assert.ok(row.includes('psa-mini-bar'), 'a chunk bar renders next to each damage cell');
  assert.ok(row.includes('width:66%') && row.includes('width:42%'), 'bar width matches the chunk size');
  assert.ok(row.includes('psa-mini-fill-warn'), 'a 40-70% chunk is amber');
  // Their hidden threat (Headlong Rush ~80%) shows as a dashed segment on
  // their bar: from the known 66% out to 80%.
  assert.ok(row.includes('psa-mini-pot'), 'the hidden threat is a dashed overlay on the bar');
  assert.ok(row.includes('left:66%;width:14%'), 'the dashed segment spans the known hit to the hidden hit');
  // The dashed segment is clickable and carries the hidden move's name in a
  // hidden badge, revealed on click (content script toggles psa-pot-revealed).
  assert.ok(row.includes('class="psa-mini-pot"') && row.includes('data-pot-key="matchup-hidden"'), 'the dashed segment is a clickable button with a stable key');
  assert.ok(row.includes('psa-pot-name">⚠ Headlong Rush ~80%'), 'the badge holds the move name, hidden until revealed');
  assert.ok(!row.includes('psa-pot-revealed'), 'the badge starts hidden (no reveal class)');
  assert.ok(row.includes('could reach ~80%'), 'the bar tooltip names the hidden ceiling');
  // We're at 7% HP and Headlong Rush maxes at ~86% — the dashed segment
  // crosses the KO line, so a tiny label sits over it.
  assert.ok(row.includes('psa-mini-ko') && row.includes('would KO'), 'hidden threat crossing our HP gets a would-KO label');
  assert.ok(row.includes('left:80%'), 'the label sits at the end of the dashed segment');
  assert.ok(row.includes('max roll (~86%) exceeds the 7% HP remaining'), 'the label explains the KO math');
});

test('render: a potential OHKO on us shows red in the damage row', () => {
  const lines = realLog.split('\n');
  const partial = parseLog(lines.slice(0, lines.indexOf('|turn|2')).join('\n'));
  // Gengar (Ghost/Poison) takes a 2× Earthquake for >100% — a likely OHKO.
  const us = partial.sides.p1.pokemon.find((m) => m.species === 'Raging Bolt');
  us.species = 'Gengar';
  const html = renderPanel(buildPanelModel(partial));
  const row = html.slice(html.indexOf('psa-match-row-dmg'), html.indexOf('</tr>', html.indexOf('psa-match-row-dmg')));
  assert.ok(row.includes('psa-match-danger'), 'an OHKO threat on us is red, not green');
  assert.ok(!row.includes('psa-match-win'), 'danger overrides the green win tint');
});

test('model: every bench candidate carries the predicted-damage comparison', () => {
  const lines = realLog.split('\n');
  const partial = parseLog(lines.slice(0, lines.indexOf('|turn|2')).join('\n'));
  const mk = (species, moves, opts = {}) => {
    const mon = createPokemon({ ident: 'p1b: ' + species, side: 'p1', species, level: 100 });
    for (const mv of moves) addMove(mon, mv);
    mon.hpPercent = opts.hpPercent ?? 100;
    mon.hp = { cur: mon.hpPercent, max: 100 };
    if (opts.fainted) mon.fainted = true;
    return mon;
  };
  partial.sides.p1.pokemon.push(
    mk('Garchomp', ['Outrage']),
    mk('Corviknight', ['Body Press']),
    mk('Chansey', ['Seismic Toss']),
    mk('Gengar', ['Shadow Ball'], { fainted: true })
  );
  const m = buildPanelModel(partial);
  const byName = Object.fromEntries(m.us.team.map((c) => [c.species, c]));
  // The active mon is on the field — not a switch candidate.
  assert.equal(byName['Raging Bolt'].vsActive, null);
  // A fainted mon can't switch in.
  assert.equal(byName['Gengar'].vsActive, null);
  const g = byName['Garchomp'].vsActive;
  assert.equal(g.species, 'Great Tusk', 'comparison is against their active');
  assert.equal(g.takes.move, 'Earthquake');
  assert.equal(g.deals.move, 'Outrage');
  assert.equal(g.hidden.move, 'Ice Spinner', 'the likely hidden threat is flagged per candidate');
  // A wall shows ~0% — the immune matchup, not 'unknown'.
  assert.equal(byName['Corviknight'].vsActive.takes.move, 'Earthquake');
  assert.equal(byName['Corviknight'].vsActive.takes.pct, 0);
  // Team-preview slots (species known, no battle record) get no comparison.
  const preview = byName['Iron Treads'] ?? byName['Rillaboom'];
  if (preview && preview.preview) assert.equal(preview.vsActive, null);
});

test('render: damage comparison line on switch candidates, with threat coloring', () => {
  const lines = realLog.split('\n');
  const partial = parseLog(lines.slice(0, lines.indexOf('|turn|2')).join('\n'));
  const mk = (species, moves) => {
    const mon = createPokemon({ ident: 'p1b: ' + species, side: 'p1', species, level: 100 });
    for (const mv of moves) addMove(mon, mv);
    mon.hpPercent = 100;
    mon.hp = { cur: 100, max: 100 };
    return mon;
  };
  partial.sides.p1.pokemon.push(mk('Garchomp', ['Outrage']), mk('Corviknight', ['Body Press']), mk('Chansey', ['Seismic Toss']));
  const html = renderPanel(buildPanelModel(partial));
  assert.ok(html.includes('psa-card-vs'), 'the comparison line renders on candidates');
  assert.ok(html.includes('vs Great Tusk:'), 'names the opponent active');
  assert.ok(html.includes('takes ~35% (Earthquake)'), 'incoming damage shown');
  assert.ok(html.includes('deals ~32% (Outrage)'), 'return damage shown');
  assert.ok(html.includes('could take ~75% (Ice Spinner)'), 'hidden threat shown as could-have');
  assert.ok(html.includes('takes ~0% (Earthquake)'), 'an immune wall shows ~0%, not unknown');
  assert.ok(html.includes('psa-card-vs-warn'), "Chansey's 55% incoming is amber-warned");
  // Chunk bars on the takes/deals figures too.
  assert.ok(html.includes('width:35%') && html.includes('width:32%'), 'bench chunk bars match the hits');
  assert.ok(html.includes('psa-mini-fill-warn') && html.includes('psa-mini-fill-ok'), 'bar color scales with chunk size');
  // Garchomp's hidden Ice Spinner (~75%) is a dashed segment on its takes bar
  // (35% -> 75%); the immune Corviknight has no hidden threat, so no segment.
  assert.ok(html.includes('left:35%;width:40%'), 'bench takes bar shows the hidden threat as a dashed segment');
  const corv = html.slice(html.indexOf('vs Great Tusk: takes ~0%'));
  assert.ok(!corv.includes('psa-mini-pot'), 'no dashed segment when there is no hidden threat');
  // Garchomp is at full HP, so the 75% hidden hit can't KO — no label.
  const g100 = html.slice(html.indexOf('psa-card-vs'), html.indexOf('deals ~32%'));
  assert.ok(!g100.includes('psa-mini-ko'), 'healthy candidate: no would-KO label');
  // Drop Garchomp to 30% HP and the hidden Ice Spinner (max ~81%) crosses
  // the KO line — the label appears on its takes bar.
  partial.sides.p1.pokemon.find((m) => m.species === 'Garchomp').hpPercent = 30;
  const html30 = renderPanel(buildPanelModel(partial));
  const g30 = html30.slice(html30.indexOf('psa-card-vs'), html30.indexOf('deals ~32%'));
  assert.ok(g30.includes('psa-mini-ko') && g30.includes('would KO'), 'low-HP candidate: hidden threat gets the would-KO label');
  // The active card must NOT carry the comparison (it's covered by the matchup).
  const activeCard = html.slice(html.indexOf('Raging Bolt'), html.indexOf('psa-card', html.indexOf('Raging Bolt') + 1));
  assert.ok(!activeCard.includes('psa-card-vs'), 'no comparison on the active card');
});

test('model: matchup carries a full per-move calc breakdown', () => {
  const lines = realLog.split('\n');
  const partial = parseLog(lines.slice(0, lines.indexOf('|turn|2')).join('\n'));
  const calc = buildPanelModel(partial).matchup.calc;
  assert.ok(calc, 'calc breakdown present when both actives exist');
  assert.deepEqual(
    calc.ours.map((m) => m.move),
    ['Dragon Pulse'],
    'our revealed damaging moves, best first'
  );
  assert.equal(calc.ours[0].mean, 41.6);
  assert.equal(calc.ours[0].ko, true, 'a hit that can exceed their remaining HP is a KO threat');
  assert.equal(calc.ours[0].koGuaranteed, true);
  assert.deepEqual(calc.theirs.map((m) => m.move), ['Earthquake']);
  assert.equal(calc.theirs[0].effectiveness, 2, 'effectiveness carried into the breakdown');
});

test('render: Damage bars are clickable and expand the full damage calc', () => {
  const lines = realLog.split('\n');
  const partial = parseLog(lines.slice(0, lines.indexOf('|turn|2')).join('\n'));
  const html = renderPanel(buildPanelModel(partial));
  assert.equal((html.match(/psa-bar-btn/g) || []).length, 2, 'both Damage-row bars are clickable buttons');
  assert.ok(html.includes('psa-calc-panel'), 'the full calc panel is rendered');
  assert.ok(!html.includes('psa-calc-open'), 'it starts collapsed — the content script opens it on click');
  assert.ok(html.includes('Full damage calc — Raging Bolt vs Great Tusk'), 'the panel names the matchup');
  assert.ok(html.includes('Your moves on Great Tusk'), 'our column titled');
  assert.ok(html.includes('Their moves on Raging Bolt'), 'their column titled');
  assert.ok(html.includes('~42% (38.2-45.2)') && html.includes('guaranteed KO'), 'roll range and KO label shown');
  assert.ok(
    html.includes('psa-calc-move-hidden') && html.includes('⚠ Headlong Rush') && html.includes('~80% hidden'),
    'the likely hidden threat is its own row'
  );
  assert.ok(html.includes('left:0%;width:80%'), 'the hidden threat row uses a fully-dashed bar');
  assert.ok(html.includes('psa-mini-ko'), 'the hidden row flags the KO crossing too');
  // Status moves never appear in the breakdown (the team cards still list
  // them, so assert on the calc's move-row form, not a bare name).
  partial.sides.p1.pokemon.find((m) => m.species === 'Raging Bolt').moves = ['Dragon Pulse', 'Thunder Wave'];
  const html2 = renderPanel(buildPanelModel(partial));
  assert.ok(!html2.includes('psa-calc-move-name">Thunder Wave'), 'status moves are skipped in the calc');
});

test('render: team-card HP bars use the chunk-bar style, scaled to current HP', () => {
  const lines = realLog.split('\n');
  const partial = parseLog(lines.slice(0, lines.indexOf('|turn|2')).join('\n'));
  const us = partial.sides.p1.pokemon.find((m) => m.species === 'Raging Bolt');
  // Same 35/70 scale as the damage bars: healthy green, mid amber, sliver red.
  for (const [hp, cls] of [[90, 'psa-hp-high'], [55, 'psa-hp-mid'], [20, 'psa-hp-low']]) {
    us.hpPercent = hp;
    const html = renderPanel(buildPanelModel(partial));
    assert.ok(html.includes(cls), `${hp}% HP renders ${cls}`);
    assert.ok(html.includes(`style="width:${hp}%"`), `bar is scaled to ${hp}% HP`);
    assert.ok(html.includes(`Current HP: ${hp}%`), 'the bar tooltip shows the exact HP');
  }
});

test('model: matchup is null when a side has no active (battle over)', () => {
  const m = buildPanelModel(state); // full log — their whole team fainted
  assert.equal(m.matchup, null);
  // Team preview: no actives either.
  const preview = buildPanelModel(parseLog('|player|p1|Me|\n|player|p2|Rival|\n|poke|p1|Pikachu|\n|poke|p2|Gengar|'));
  assert.equal(preview.matchup, null);
});

test('model+render: matchup shows our exact stats and the highlighted Spe row', () => {
  const lines = realLog.split('\n');
  const partial = parseLog(lines.slice(0, lines.indexOf('|turn|2')).join('\n'));
  // Live request data makes our stats exact points.
  partial.sides.p1.pokemon.find((m) => m.species === 'Raging Bolt').stats = {
    atk: 110, def: 110, spa: 160, spd: 110, spe: 165,
  };
  const m = buildPanelModel(partial);
  assert.equal(m.matchup.ours.stats.find((s) => s.key === 'S').text, '165');
  assert.equal(m.matchup.ours.stats.find((s) => s.key === 'S').exact, true);
  const html = renderPanel(m);
  assert.ok(html.includes('psa-matchup'));
  assert.ok(html.includes('Raging Bolt'));
  assert.ok(html.includes('Great Tusk'));
  assert.ok(html.includes('psa-match-row-spe'), 'the Spe row is highlighted');
  assert.ok(html.includes('>165</td>'), 'our exact Speed renders in the table');
  assert.ok(html.includes('psa-match-speed'), 'the speed line banner is present');
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
  assert.ok(html.includes('psa-match-table'), 'the matchup table renders mid-battle');
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
