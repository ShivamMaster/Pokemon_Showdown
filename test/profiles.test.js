// test/profiles.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  summarizeBattle,
  updateProfile,
  profileForEngine,
  profileForDisplay,
  findProfileKey,
  renameProfile,
  addProfileAlias,
  removeProfileAlias,
  exportProfilesText,
} from '../src/profiles/index.js';
import { loadProfiles, saveProfiles } from '../src/profiles/store.js';
import { parseLog } from '../src/reader/reader.js';
import { buildPanelHtml } from '../src/ui/panel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const realLog = readFileSync(path.join(__dirname, 'fixtures', 'real-battle.log'), 'utf8');

// ---------------------------------------------------------------------------
// Helpers for hand-built states
// ---------------------------------------------------------------------------

const mon = (ident, species, over = {}) => ({
  ident,
  species,
  moves: [],
  item: null,
  itemRevealed: false,
  ability: null,
  hpPercent: 100,
  fainted: false,
  active: false,
  ...over,
});

// A tiny state with the minimum the summarizer needs: both sides, a journal,
// and a winner. hpPercent on switch actions is the HP the *incoming* mon
// carries; the summarizer reads the outgoing mon's last known HP from prior
// damage/heal actions on that ident.
const makeState = ({ winner = null, turn = 3, actions = [] } = {}) => ({
  format: '[Gen 9] OU',
  turn,
  winner,
  actions,
  sides: {
    p1: {
      playerName: 'BaddyGames',
      pokemon: [mon('p1a: Rillaboom', 'Rillaboom')],
    },
    p2: {
      playerName: 'vkhss',
      pokemon: [mon('p2a: Great Tusk', 'Great Tusk'), mon('p2b: Glimmora', 'Glimmora')],
    },
  },
});

const action = (over) => ({ turn: 1, side: 'p2', ident: 'p2a: Great Tusk', type: 'move', ...over });

// ---------------------------------------------------------------------------
// summarizeBattle on the real fixture
// ---------------------------------------------------------------------------

test('summarizeBattle: real fixture yields opponent, result, leads, and revealed info', () => {
  const state = parseLog(realLog);
  const s = summarizeBattle(state, 'p1');

  assert.equal(s.opponent, 'vkhss');
  assert.equal(s.result, 'win'); // we are p1 (BaddyGames) and they lost
  assert.equal(s.turns, 22);
  assert.equal(s.theirLead, 'Great Tusk');
  assert.equal(s.ourLead, 'Raging Bolt');

  // Voluntary switch-ins only: Dragonite entered 4 times, but one was forced.
  assert.equal(s.switchIns['Dragonite'], 2);
  assert.equal(s.switchIns['Glimmora'], 3);
  assert.equal(s.switchIns['Great Tusk'], 1);

  // Move usage per species, in reveal order.
  assert.deepEqual(s.movesUsed['Dragonite'], ['Encore', 'Scale Shot']);
  assert.deepEqual(s.movesUsed['Roaring Moon'], ['Knock Off', 'Dragon Dance']);

  // Revealed sets include item/ability when known.
  assert.equal(s.sets['Great Tusk'].item, 'Leftovers');
  assert.equal(s.sets['Glimmora'].ability, 'Toxic Debris');
  assert.equal(s.sets['Dragonite'].item, 'Loaded Dice');
  assert.deepEqual(s.sets['Dragonite'].moves, ['Encore', 'Scale Shot']);
});

test('summarizeBattle: records the random-battle flag and a per-turn move log', () => {
  const state = parseLog(realLog);
  const s = summarizeBattle(state, 'p1');
  // The fixture is an OU ladder battle.
  assert.equal(s.random, false);

  // The log covers both sides in turn order: our side is 'you', theirs 'them'.
  assert.ok(Array.isArray(s.log) && s.log.length > 10, `expected a real log, got ${s.log?.length}`);
  assert.ok(s.log.some((l) => l.startsWith('T1 you ') && l.includes('used ')), 'our first turn move should be logged');
  assert.ok(s.log.some((l) => l.startsWith('T1 them ') && l.includes('used ')), 'their first turn move should be logged');
  assert.ok(s.log.some((l) => l.includes('fainted')), 'KOs should be logged');
  assert.ok(s.log.some((l) => l.includes('sent in')), 'switches should be logged');

  // A random-battle tier sets the flag.
  const randomState = makeState({ winner: 'BaddyGames', actions: [action({ type: 'move', move: 'Earthquake' })] });
  randomState.format = '[Gen 9] Random Battle';
  assert.equal(summarizeBattle(randomState, 'p1').random, true);
});

test('updateProfile: keeps the battle log in the stored history', () => {
  const s = summarizeBattle(parseLog(realLog), 'p1');
  const p = updateProfile(null, s);
  assert.equal(p.battles.length, 1);
  assert.deepEqual(p.battles[0].log, s.log);
  assert.equal(p.battles[0].random, false);
});

// ---------------------------------------------------------------------------
// txt backup export
// ---------------------------------------------------------------------------

test('exportProfilesText: renders readable profiles + battle logs + restorable JSON', () => {
  const s = summarizeBattle(parseLog(realLog), 'p1');
  const p = updateProfile(null, s);
  const txt = exportProfilesText({ vkhss: p });

  // Readable header and profile block.
  assert.match(txt, /SHOWDOWN BATTLE ASSISTANT — PROFILE BACKUP/);
  assert.match(txt, /Profile: vkhss/);
  assert.match(txt, /Record: 1-0/);
  assert.match(txt, /Common leads: Great Tusk/);
  assert.match(txt, /Revealed sets:.*Dragonite/);

  // The per-battle log shows up with moves and KOs.
  assert.match(txt, /Battle 1 —/);
  assert.match(txt, /T1 you .* used /);
  assert.match(txt, /fainted/);

  // The RAW JSON payload is present and round-trips back to the same store.
  const rawIdx = txt.indexOf('RAW JSON');
  assert.ok(rawIdx >= 0);
  const payload = txt.slice(txt.indexOf('{', rawIdx));
  const parsed = JSON.parse(payload);
  assert.deepEqual(parsed, { vkhss: p });
});

test('exportProfilesText: empty store says so and still exports a valid JSON payload', () => {
  const txt = exportProfilesText({});
  assert.match(txt, /No profiles yet/);
  const payload = txt.slice(txt.indexOf('{', txt.indexOf('RAW JSON')));
  assert.deepEqual(JSON.parse(payload), {});
});

// ---------------------------------------------------------------------------
// summarizeBattle: switch / faint accounting
// ---------------------------------------------------------------------------

test('summarizeBattle: voluntary switches count, forced ones (faint-follow, drag) do not', () => {
  const state = makeState({
    actions: [
      action({ type: 'faint', ident: 'p2b: Glimmora' }), // p2 lost their active -> next switch is forced
      action({ type: 'switch', ident: 'p2a: Great Tusk', species: 'Great Tusk', forced: false, hpPercent: 100 }), // follows a faint -> forced
      action({ type: 'switch', ident: 'p2b: Glimmora', species: 'Glimmora', forced: true, hpPercent: 100 }), // drag
      action({ type: 'switch', ident: 'p2a: Great Tusk', species: 'Great Tusk', forced: false, hpPercent: 100 }), // free choice
    ],
  });
  const s = summarizeBattle(state, 'p1');
  assert.equal(s.switchIns['Great Tusk'], 1, 'only the free-choice switch counts');
  assert.equal(s.switchIns['Glimmora'], undefined, 'forced switch-in must not count as voluntary');
});

test('summarizeBattle: low-HP switches and low-HP faints are counted', () => {
  const state = makeState({
    actions: [
      // Glimmora enters as the lead (the lead-in switch is a real log action,
      // and it is what lets the summarizer know who is active).
      action({ type: 'switch', ident: 'p2b: Glimmora', species: 'Glimmora', forced: false, hpPercent: 100 }),
      // Glimmora takes damage down to 25% (below the 40% threshold)...
      action({ type: 'damage', ident: 'p2b: Glimmora', hpPercent: 25 }),
      // ...then switches out voluntarily -> lowHpSwitch
      action({ type: 'switch', ident: 'p2a: Great Tusk', species: 'Great Tusk', forced: false, hpPercent: 100 }),
      // Great Tusk gets chunked to 35%, then faints -> lowHpFaint
      action({ type: 'damage', ident: 'p2a: Great Tusk', hpPercent: 35 }),
      action({ type: 'faint', ident: 'p2a: Great Tusk' }),
      // A healthy 60% mon fainting does not count
      action({ type: 'damage', ident: 'p2a: Great Tusk', hpPercent: 60 }),
      action({ type: 'faint', ident: 'p2a: Great Tusk' }),
    ],
  });
  const s = summarizeBattle(state, 'p1');
  assert.equal(s.lowHpSwitches, 1);
  assert.equal(s.lowHpFaints, 1);
});

test('summarizeBattle: incomplete battle (no winner) reports result incomplete', () => {
  const s = summarizeBattle(makeState({ winner: null }), 'p1');
  assert.equal(s.result, 'incomplete');
});

// ---------------------------------------------------------------------------
// updateProfile: aggregation across battles
// ---------------------------------------------------------------------------

test('updateProfile: aggregates record, leads, switch-ins, move usage, and sets', () => {
  const base = summarizeBattle(parseLog(realLog), 'p1');
  let p = updateProfile(null, base);
  p = updateProfile(p, { ...base, result: 'loss', theirLead: 'Landorus-Therian' });

  assert.equal(p.totalBattles, 2);
  assert.deepEqual(p.record, { win: 1, loss: 1, tie: 0 });
  assert.deepEqual(p.commonLeads, { 'Great Tusk': 1, 'Landorus-Therian': 1 });

  // switchIns accumulate across battles
  assert.equal(p.switchIns['Glimmora'], 6); // 3 + 3
  assert.equal(p.switchIns['Dragonite'], 4); // 2 + 2

  // move usage accumulates per species
  assert.equal(p.moveUsage['Dragonite']['Encore'], 2);
  assert.equal(p.moveUsage['Great Tusk']['Earthquake'], 2);

  // sets merge moves without duplicating, item/ability carry over
  const dn = p.sets['Dragonite'];
  assert.equal(dn.timesSeen, 2);
  assert.deepEqual(dn.moves, ['Encore', 'Scale Shot']);
  assert.equal(dn.item, 'Loaded Dice');

  // the battles log keeps the last 20
  assert.equal(p.battles.length, 2);
  for (let i = 0; i < 25; i++) p = updateProfile(p, { ...base, result: 'win' });
  assert.equal(p.battles.length, 20);
});

// ---------------------------------------------------------------------------
// profileForEngine / profileForDisplay projections
// ---------------------------------------------------------------------------

test('profileForEngine: switchTendency.atLowHp ratio and commonSwitchIns', () => {
  const p = updateProfile(null, {
    opponent: 'vkhss',
    result: 'win',
    lowHpSwitches: 1,
    lowHpFaints: 3, // 1 of 4 low-HP situations ended in a switch
    switchIns: { 'Great Tusk': 2, 'Glimmora': 1 },
    movesUsed: {},
    sets: {},
  });
  assert.deepEqual(profileForEngine(p), {
    switchTendency: { atLowHp: 0.25 },
    commonSwitchIns: { 'Great Tusk': 2, 'Glimmora': 1 },
  });
});

test('profileForEngine: returns null when there is nothing learned', () => {
  assert.equal(profileForEngine(null), null);
  const empty = updateProfile(null, { opponent: 'x', result: 'incomplete', switchIns: {}, movesUsed: {}, sets: {} });
  assert.equal(profileForEngine(empty), null);
});

test('summarizeBattle: records their tera timing and species', () => {
  const s = summarizeBattle(
    makeState({
      actions: [
        action({ turn: 3, type: 'tera', ident: 'p2a: Great Tusk', teraType: 'Steel' }),
      ],
    }),
    'p1'
  );
  assert.equal(s.teraTurn, 3);
  assert.equal(s.teraSpecies, 'Great Tusk');

  // No tera -> nulls
  const noTera = summarizeBattle(makeState({ actions: [] }), 'p1');
  assert.equal(noTera.teraTurn, null);
  assert.equal(noTera.teraSpecies, null);
});

test('updateProfile: aggregates tera habits (count, species, earliest turn)', () => {
  const base = { opponent: 'vkhss', result: 'win', switchIns: {}, movesUsed: {}, sets: {}, teraTurn: 5, teraSpecies: 'Great Tusk' };
  let p = updateProfile(null, base);
  p = updateProfile(p, { ...base, teraTurn: 3, teraSpecies: 'Great Tusk' });
  p = updateProfile(p, { ...base, teraTurn: 7, teraSpecies: 'Glimmora' });

  assert.equal(p.teraCount, 3);
  assert.deepEqual(p.teraSpecies, { 'Great Tusk': 2, Glimmora: 1 });
  assert.equal(p.teraEarliestTurn, 3);
});

test('profileForEngine: exposes moveUsage, commonLeads, and teraHabits', () => {
  const p = updateProfile(null, {
    opponent: 'vkhss',
    result: 'win',
    theirLead: 'Great Tusk',
    switchIns: { 'Great Tusk': 2, Glimmora: 1 },
    movesUsed: { 'Great Tusk': ['Earthquake', 'Headlong Rush'] }, // 2+ moves = a habit
    sets: { 'Great Tusk': { moves: ['Earthquake', 'Headlong Rush'] } },
    teraTurn: 4,
    teraSpecies: 'Great Tusk',
  });
  const ep = profileForEngine(p);
  assert.deepEqual(ep.moveUsage, { 'Great Tusk': { Earthquake: 1, 'Headlong Rush': 1 } });
  assert.deepEqual(ep.commonLeads, { 'Great Tusk': 1 });
  assert.equal(ep.teraHabits.count, 1);
  assert.deepEqual(ep.teraHabits.species, { 'Great Tusk': 1 });
  assert.equal(ep.teraHabits.earliestTurn, 4);

  // A single move on a species is not yet a habit — no moveUsage exposed.
  const thin = updateProfile(null, {
    opponent: 'vkhss',
    result: 'win',
    movesUsed: { 'Great Tusk': ['Earthquake'] },
    sets: {},
    switchIns: {},
  });
  assert.equal(profileForEngine(thin)?.moveUsage, undefined);
});

test('profileForDisplay: record text, common lead %, low-HP switch rate', () => {
  let p = updateProfile(null, {
    opponent: 'vkhss',
    result: 'win',
    theirLead: 'Great Tusk',
    lowHpSwitches: 2,
    lowHpFaints: 2,
    switchIns: {},
    movesUsed: {},
    sets: {},
  });
  p = updateProfile(p, { ...p.battles[0], result: 'loss' }); // second battle, same lead
  assert.deepEqual(profileForDisplay(p), {
    opponent: 'vkhss',
    battles: 2,
    recordText: '1-1',
    commonLead: { species: 'Great Tusk', pct: 100 },
    lowHpSwitchRate: 50,
  });
});

test('profileForDisplay: tie shows in record, and empty profile is null', () => {
  const p = updateProfile(null, {
    opponent: 'vkhss',
    result: 'tie',
    lowHpSwitches: 0,
    lowHpFaints: 0,
    switchIns: {},
    movesUsed: {},
    sets: {},
  });
  assert.equal(profileForDisplay(p).recordText, '0-0-1');
  assert.equal(profileForDisplay(p).lowHpSwitchRate, null);
  assert.equal(profileForDisplay(null), null);
});

// ---------------------------------------------------------------------------
// Storage adapter (memory fallback, as used in Node/tests)
// ---------------------------------------------------------------------------

test('store: save/load round-trips profiles through the memory fallback', async () => {
  const p = updateProfile(null, summarizeBattle(parseLog(realLog), 'p1'));
  await saveProfiles({ vkhss: p });
  const loaded = await loadProfiles();
  assert.equal(loaded.vkhss.totalBattles, 1);
  assert.equal(loaded.vkhss.record.win, 1);
  assert.deepEqual(loaded.vkhss.battles[0].movesUsed['Dragonite'], ['Encore', 'Scale Shot']);
});

// ---------------------------------------------------------------------------
// Friend naming + username aliases
// ---------------------------------------------------------------------------

test('findProfileKey matches by display name and by alias', () => {
  const profiles = {
    john: {
      opponent: 'John',
      aliases: ['vkhss', 'baddygames'],
      battles: [],
      totalBattles: 3,
      record: { win: 2, loss: 1, tie: 0 },
    },
    alice: { opponent: 'alice', aliases: [], battles: [], totalBattles: 1, record: { win: 0, loss: 1, tie: 0 } },
  };
  assert.equal(findProfileKey(profiles, 'John'), 'john');
  assert.equal(findProfileKey(profiles, 'JOHN'), 'john');
  assert.equal(findProfileKey(profiles, 'vkhss'), 'john');
  assert.equal(findProfileKey(profiles, 'Vkhss'), 'john');
  assert.equal(findProfileKey(profiles, 'alice'), 'alice');
  assert.equal(findProfileKey(profiles, 'stranger'), null);
  assert.equal(findProfileKey(profiles, ''), null);
  assert.equal(findProfileKey({}, 'vkhss'), null);
});

test('renameProfile sets the display name and keeps the old name as an alias', () => {
  let p = { opponent: 'vkhss', aliases: [], battles: [], totalBattles: 2, record: { win: 1, loss: 1, tie: 0 } };
  p = renameProfile(p, 'John');
  assert.equal(p.opponent, 'John');
  assert.deepEqual(p.aliases, ['vkhss']);
  assert.equal(findProfileKey({ john: p }, 'vkhss'), 'john');
  // Renaming again keeps both old names as aliases.
  p = renameProfile(p, 'Johnny');
  assert.deepEqual(p.aliases, ['vkhss', 'john']);
  assert.equal(renameProfile(p, '   '), p); // blank rename is a no-op
});

test('addProfileAlias / removeProfileAlias dedupe and normalize', () => {
  let p = { opponent: 'John', aliases: [], battles: [], totalBattles: 0, record: { win: 0, loss: 0, tie: 0 } };
  p = addProfileAlias(p, 'Vkhss');
  p = addProfileAlias(p, 'vkhss');
  assert.deepEqual(p.aliases, ['vkhss']);
  p = addProfileAlias(p, 'BaddyGames');
  assert.deepEqual(p.aliases, ['vkhss', 'baddygames']);
  // The display name itself is already an implicit match — not added.
  assert.equal(addProfileAlias(p, 'John'), p);
  p = removeProfileAlias(p, 'vkhss');
  assert.deepEqual(p.aliases, ['baddygames']);
});

test('updateProfile preserves aliases set on the profile', () => {
  let p = { opponent: 'John', aliases: ['vkhss'], battles: [], totalBattles: 0, record: { win: 0, loss: 0, tie: 0 }, commonLeads: {}, switchIns: {}, moveUsage: {}, sets: {}, lowHpSwitches: 0, lowHpFaints: 0 };
  const summary = summarizeBattle(parseLog(realLog), 'p1');
  p = updateProfile(p, summary);
  assert.equal(p.opponent, 'John');
  assert.deepEqual(p.aliases, ['vkhss']);
  assert.equal(p.totalBattles, 1);
});

test('loadProfiles normalizes aliases and re-keys old-format entries', async () => {
  // Simulate old stored data: keyed by username, no aliases field.
  await saveProfiles({
    vkhss: {
      opponent: 'John', // renamed display name, old key still points at it
      battles: [],
      totalBattles: 2,
      record: { win: 1, loss: 1, tie: 0 },
      commonLeads: {},
      switchIns: {},
      moveUsage: {},
      sets: {},
      lowHpSwitches: 0,
      lowHpFaints: 0,
    },
  });
  const loaded = await loadProfiles();
  assert.ok(loaded.john, 'should be re-keyed to the display name');
  assert.equal(loaded.john.opponent, 'John');
  assert.deepEqual(loaded.john.aliases, []);
  assert.equal(loaded.john.totalBattles, 2);
  assert.equal(loaded.vkhss, undefined);
});

// ---------------------------------------------------------------------------
// Panel profile strip
// ---------------------------------------------------------------------------

test('panel: renders the vs-opponent profile strip', () => {
  const p = updateProfile(null, summarizeBattle(parseLog(realLog), 'p1'));
  const html = buildPanelHtml(parseLog(realLog), { ourSideId: 'p1', profile: profileForDisplay(p) });
  assert.ok(html.includes('psa-profile'));
  assert.ok(html.includes('vs <strong>vkhss</strong>'));
  assert.ok(html.includes('1 battle'));
  assert.ok(html.includes('record 1-0'));
  assert.ok(html.includes('lead Great Tusk 100%'));
  assert.match(html, /switches when low \d+%/);
});

test('panel: no profile strip when no profile is passed', () => {
  const html = buildPanelHtml(parseLog(realLog), { ourSideId: 'p1' });
  assert.ok(!html.includes('psa-profile'));
});
