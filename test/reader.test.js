// test/reader.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseLog, parseDetails, parseHp, sideOf, BattleReader } from '../src/reader/reader.js';
import { parseLine } from '../src/reader/parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const realLog = readFileSync(path.join(__dirname, 'fixtures', 'real-battle.log'), 'utf8');

// ---------------------------------------------------------------------------
// Low-level parsing
// ---------------------------------------------------------------------------

test('parseLine classifies event types', () => {
  assert.deepEqual(parseLine('|turn|3'), { type: 'turn', rawType: 'turn', args: ['3'], line: '|turn|3' });
  assert.equal(parseLine('|-damage|p1a: X|7/100').type, 'damage');
  assert.equal(parseLine('|switch|p1a: X|X|100/100').type, 'switch');
  assert.equal(parseLine('|c|☆X|hi').type, 'ignored');
  assert.equal(parseLine('|t:|12345').type, 'ignored');
  assert.equal(parseLine('|html|<b>x</b>').type, 'ignored');
  assert.equal(parseLine(''), null);
  assert.equal(parseLine('|'), null);
});

test('parseDetails handles level/gender/tera/shiny flags', () => {
  assert.deepEqual(parseDetails('Dragonite, M'), { species: 'Dragonite', level: null, gender: 'M', teraType: null, shiny: false });
  assert.deepEqual(parseDetails('Deoxys-Speed'), { species: 'Deoxys-Speed', level: null, gender: null, teraType: null, shiny: false });
  assert.deepEqual(parseDetails('Rillaboom, F, tera:Grass'), { species: 'Rillaboom', level: null, gender: 'F', teraType: 'Grass', shiny: false });
  assert.deepEqual(parseDetails('Pikachu, L50, M, shiny'), { species: 'Pikachu', level: 50, gender: 'M', teraType: null, shiny: true });
});

test('parseHp handles percentages, real HP, faints, and statuses', () => {
  assert.deepEqual(parseHp('100/100'), { cur: 100, max: 100, fainted: false, status: null });
  assert.deepEqual(parseHp('7/100'), { cur: 7, max: 100, fainted: false, status: null });
  assert.deepEqual(parseHp('120/281'), { cur: 120, max: 281, fainted: false, status: null });
  assert.deepEqual(parseHp('0 fnt'), { cur: 0, max: null, fainted: true, status: null });
  assert.deepEqual(parseHp('88/100 psn'), { cur: 88, max: 100, fainted: false, status: 'psn' });
  assert.equal(parseHp(undefined), null);
});

test('sideOf extracts the side id from an ident', () => {
  assert.equal(sideOf('p2a: Great Tusk'), 'p2');
  assert.equal(sideOf('p1a: Deoxys'), 'p1');
  assert.equal(sideOf('garbage'), null);
});

// ---------------------------------------------------------------------------
// Real battle log: full parse
// ---------------------------------------------------------------------------

test('real log: metadata is parsed', () => {
  const s = parseLog(realLog);
  assert.equal(s.gen, 9);
  assert.equal(s.format, '[Gen 9] OU');
  assert.equal(s.gametype, 'singles');
  assert.equal(s.sides.p1.playerName, 'BaddyGames');
  assert.equal(s.sides.p2.playerName, 'vkhss');
  assert.equal(s.sides.p1.teamSize, 6);
  assert.equal(s.sides.p2.teamSize, 6);
  assert.equal(s.turn, 22);
  assert.equal(s.winner, 'BaddyGames');
  assert.equal(s.started, true);
});

test('real log: team preview rosters are built and linked to field idents', () => {
  const s = parseLog(realLog);
  assert.deepEqual(s.sides.p1.roster.map((r) => r.species), [
    'Raging Bolt', 'Kingambit', 'Deoxys-Speed', 'Gouging Fire', 'Iron Treads', 'Rillaboom',
  ]);
  assert.deepEqual(s.sides.p2.roster.map((r) => r.species), [
    'Glimmora', 'Gholdengo', 'Roaring Moon', 'Great Tusk', 'Dragonite', 'Raging Bolt',
  ]);
  // Every roster slot should have been assigned a field ident by the end.
  for (const side of [s.sides.p1, s.sides.p2]) {
    for (const slot of side.roster) assert.notEqual(slot.ident, null, `${side.id} slot ${slot.species} unlinked`);
  }
  // Roster gender carried through.
  const kingambit = s.sides.p1.roster.find((r) => r.species === 'Kingambit');
  assert.equal(kingambit.gender, 'F');
});

test('real log: revealed moves are tracked per Pokémon, in reveal order', () => {
  const s = parseLog(realLog);
  const p2 = (species) => s.sides.p2.pokemon.find((m) => m.species === species);
  const p1 = (species) => s.sides.p1.pokemon.find((m) => m.species === species);

  assert.deepEqual(p2('Great Tusk').moves, ['Earthquake', 'Ice Spinner']);
  assert.deepEqual(p2('Dragonite').moves, ['Encore', 'Scale Shot']);
  assert.deepEqual(p2('Roaring Moon').moves, ['Knock Off', 'Dragon Dance']);
  assert.deepEqual(p2('Gholdengo').moves, ['Shadow Ball']);
  assert.deepEqual(p2('Glimmora').moves, ['Earth Power']);
  assert.deepEqual(p2('Raging Bolt').moves, ['Dragon Pulse', 'Thunderclap']);
  assert.deepEqual(p1('Iron Treads').moves, ['Ice Spinner', 'Earthquake', 'Rapid Spin']);
  assert.deepEqual(p1('Rillaboom').moves, ['Grassy Glide', 'Knock Off']);
  assert.deepEqual(p1('Deoxys-Speed').moves, ['Psycho Boost', 'Knock Off']);
  // Kingambit never attacked.
  assert.deepEqual(p1('Kingambit').moves, []);
});

test('real log: items are revealed and marked consumed/not', () => {
  const s = parseLog(realLog);
  const p2 = (species) => s.sides.p2.pokemon.find((m) => m.species === species);
  const p1 = (species) => s.sides.p1.pokemon.find((m) => m.species === species);

  // Consumed at switch-in (Booster Energy) or knocked off / eaten.
  assert.equal(p1('Raging Bolt').item, 'Booster Energy');
  assert.equal(p1('Raging Bolt').itemRevealed, true);
  assert.equal(p1('Raging Bolt').itemConsumed, true);
  assert.equal(p1('Iron Treads').item, 'Booster Energy');
  assert.equal(p1('Iron Treads').itemConsumed, true);
  assert.equal(p1('Deoxys-Speed').item, 'Life Orb'); // revealed via [from] item: on damage
  assert.equal(p1('Deoxys-Speed').itemConsumed, false);
  assert.equal(p1('Kingambit').item, 'Leftovers'); // revealed via [from] item: on heal
  assert.equal(p1('Kingambit').itemConsumed, false);
  assert.equal(p1('Gouging Fire').item, 'Covert Cloak');
  assert.equal(p1('Gouging Fire').itemConsumed, true);

  assert.equal(p2('Great Tusk').item, 'Leftovers');
  assert.equal(p2('Great Tusk').itemConsumed, false);
  assert.equal(p2('Gholdengo').item, 'Custap Berry');
  assert.equal(p2('Gholdengo').itemConsumed, true);
  assert.equal(p2('Roaring Moon').item, 'Booster Energy');
  assert.equal(p2('Roaring Moon').itemConsumed, true);
  assert.equal(p2('Dragonite').item, 'Loaded Dice');
  assert.equal(p2('Dragonite').itemConsumed, true);
  assert.equal(p2('Glimmora').item, 'Red Card');
  assert.equal(p2('Glimmora').itemConsumed, true);

  // Rillaboom's item was never revealed.
  assert.equal(p1('Rillaboom').item, null);
  assert.equal(p1('Rillaboom').itemRevealed, false);
});

test('real log: HP and statuses are tracked', () => {
  const s = parseLog(realLog);
  const p2 = (species) => s.sides.p2.pokemon.find((m) => m.species === species);
  const p1 = (species) => s.sides.p1.pokemon.find((m) => m.species === species);

  // Great Tusk: 100 -> 15 -> healed to 21 -> 27 -> 0 fnt
  assert.equal(p2('Great Tusk').hp.cur, 0);
  assert.equal(p2('Great Tusk').hpPercent, 0);
  assert.equal(p2('Great Tusk').fainted, true);

  // Dragonite switches back in with carried-over HP.
  assert.equal(p2('Dragonite').hpPercent, 0);
  assert.equal(p2('Dragonite').fainted, true);

  // Rillaboom ends the battle alive at 1% with poison.
  assert.equal(p1('Rillaboom').hp.cur, 1);
  assert.equal(p1('Rillaboom').hpPercent, 1);
  assert.equal(p1('Rillaboom').status, 'psn');
  assert.equal(p1('Rillaboom').fainted, false);

  // Poisoned but fainted later.
  assert.equal(p1('Deoxys-Speed').status, 'psn');
  assert.equal(p1('Gouging Fire').status, 'psn');
  assert.equal(p1('Raging Bolt').status, null);

  // The whole opponent team is down; we have one left.
  for (const species of ['Glimmora', 'Gholdengo', 'Roaring Moon', 'Great Tusk', 'Dragonite', 'Raging Bolt']) {
    assert.equal(p2(species).fainted, true, `${species} should be fainted`);
  }
});

test('real log: boosts are tracked and clamped', () => {
  const s = parseLog(realLog);
  const p2 = (species) => s.sides.p2.pokemon.find((m) => m.species === species);
  const p1 = (species) => s.sides.p1.pokemon.find((m) => m.species === species);

  // Two Dragon Dances, but boosts reset when it switched out and back in
  // (turn 15: DD -> out; turn 17: re-entry resets; turn 18: DD once more).
  assert.equal(p2('Roaring Moon').boosts.atk, 1);
  assert.equal(p2('Roaring Moon').boosts.spe, 1);
  // Scale Shot: -1 def, +1 spe on Dragonite.
  assert.equal(p2('Dragonite').boosts.def, -1);
  assert.equal(p2('Dragonite').boosts.spe, 1);
  // Rapid Spin +1 spe, Earth Power -1 spd on Iron Treads.
  assert.equal(p1('Iron Treads').boosts.spe, 1);
  assert.equal(p1('Iron Treads').boosts.spd, -1);
  // Breaking Swipe -1 atk on the second Raging Bolt.
  assert.equal(p2('Raging Bolt').boosts.atk, -1);
  // Kingambit never boosted.
  assert.equal(p1('Kingambit').boosts.atk, 0);
});

test('real log: abilities are revealed', () => {
  const s = parseLog(realLog);
  const p2 = (species) => s.sides.p2.pokemon.find((m) => m.species === species);
  const p1 = (species) => s.sides.p1.pokemon.find((m) => m.species === species);

  assert.equal(p1('Raging Bolt').ability, 'Protosynthesis');
  assert.equal(p1('Iron Treads').ability, 'Quark Drive');
  assert.equal(p1('Deoxys-Speed').ability, 'Pressure');
  assert.equal(p1('Kingambit').ability, 'Supreme Overlord');
  assert.equal(p1('Rillaboom').ability, 'Grassy Surge'); // via fieldstart [from] ability
  assert.equal(p1('Gouging Fire').ability, 'Protosynthesis'); // via -end ability line
  assert.equal(p2('Roaring Moon').ability, 'Protosynthesis');
  assert.equal(p2('Raging Bolt').ability, 'Protosynthesis');
  assert.equal(p2('Glimmora').ability, 'Toxic Debris');
});

test('real log: tera types are recorded', () => {
  const s = parseLog(realLog);
  const rm = s.sides.p2.pokemon.find((m) => m.species === 'Roaring Moon');
  const rillaboom = s.sides.p1.pokemon.find((m) => m.species === 'Rillaboom');
  assert.equal(rm.teraType, 'Flying');
  assert.equal(rm.terastallized, true);
  assert.equal(rillaboom.teraType, 'Grass');
  assert.equal(rillaboom.terastallized, true);
});

test('real log: field conditions and side effects', () => {
  const s = parseLog(realLog);
  // Grassy Terrain is up at the end (Rillaboom's Grassy Surge).
  assert.equal(s.field.terrain, 'Grassy Terrain');
  assert.equal(s.field.weather, null);
  // Toxic Spikes were set twice, cleared by Rapid Spin, then set once more.
  assert.equal(s.sides.p1.effects['Toxic Spikes'], 1);
  assert.deepEqual(s.sides.p2.effects, {});
});

test('real log: switch tracking (counts, forced switches)', () => {
  const s = parseLog(realLog);
  const p2 = (species) => s.sides.p2.pokemon.find((m) => m.species === species);
  const p1 = (species) => s.sides.p1.pokemon.find((m) => m.species === species);

  assert.equal(p1('Iron Treads').switchCount, 3);
  assert.equal(p2('Dragonite').switchCount, 4); // turns 3, 7, 16, 22
  assert.equal(p2('Glimmora').switchCount, 3);
  assert.equal(p2('Gholdengo').switchCount, 2);
  assert.equal(p1('Rillaboom').switchCount, 2);
  // Deoxys-Speed was dragged in by Red Card.
  assert.equal(p1('Deoxys-Speed').switchCount, 1);
  assert.equal(p1('Deoxys-Speed').forcedSwitchIns, 1);
  assert.equal(p1('Iron Treads').forcedSwitchIns, 0);
});

test('real log: the action journal ends with the winning faint', () => {
  const s = parseLog(realLog);
  assert.ok(s.actions.length > 50);
  const last = s.actions[s.actions.length - 1];
  assert.equal(last.type, 'faint');
  assert.equal(last.ident, 'p2a: Dragonite');
  assert.equal(last.turn, 22);
  const forcedSwitch = s.actions.find((a) => a.type === 'switch' && a.ident === 'p1a: Deoxys');
  assert.equal(forcedSwitch.forced, true);
  const voluntarySwitch = s.actions.find((a) => a.type === 'switch' && a.ident === 'p2a: Dragonite');
  assert.equal(voluntarySwitch.forced, false);
});

// ---------------------------------------------------------------------------
// Hand-crafted log: edge cases not present in the real fixture
// ---------------------------------------------------------------------------

const HANDCRAFTED = `|player|p1|Me|
|player|p2|Rival|
|gametype|singles
|gen|9
|clearpoke
|poke|p1|Pikachu|
|poke|p1|Snorlax|
|poke|p2|Gengar|
|poke|p2|Blissey|
|teampreview
|start
|switch|p1a: Pikachu|Pikachu|100/100
|switch|p2a: Gengar|Gengar|100/100
|turn|1
|move|p1a: Pikachu|Volt Switch|p2a: Gengar
|-supereffective|p2a: Gengar
|-damage|p2a: Gengar|120/281
|move|p2a: Gengar|Shadow Ball|p1a: Pikachu
|-damage|p1a: Pikachu|72/100
|upkeep
|turn|2
|switch|p1a: Snorlax|Snorlax|100/100
|move|p2a: Gengar|Sludge Bomb|p1a: Snorlax
|-damage|p1a: Snorlax|85/100
|switch|p2a: Blissey|Blissey|100/100
|-item|p2a: Blissey|Leftovers
|upkeep
|turn|3
|-weather|RainDance
|-status|p2a: Blissey|brn
|-curestatus|p2a: Blissey|brn
|-boost|p2a: Blissey|atk|4
|-boost|p2a: Blissey|atk|4
|-boost|p2a: Blissey|atk|4
|-weather|none
|win|Me
`;

test('handcrafted: real HP values (non-percentage mod)', () => {
  const s = parseLog(HANDCRAFTED);
  const gengar = s.sides.p2.pokemon.find((m) => m.species === 'Gengar');
  assert.deepEqual(gengar.hp, { cur: 120, max: 281 });
  assert.equal(gengar.hpPercent, 42.7);
  assert.deepEqual(gengar.moves, ['Shadow Ball', 'Sludge Bomb']);
  assert.equal(s.sides.p2.pokemon.find((m) => m.species === 'Blissey').hpPercent, 100);
});

test('handcrafted: pivot moves mark the follow-up switch as forced', () => {
  const s = parseLog(HANDCRAFTED);
  const pikachu = s.sides.p1.pokemon.find((m) => m.species === 'Pikachu');
  const snorlax = s.sides.p1.pokemon.find((m) => m.species === 'Snorlax');
  assert.equal(pikachu.switchCount, 1);
  assert.equal(snorlax.switchCount, 1);
  const snorlaxSwitch = s.actions.find((a) => a.type === 'switch' && a.ident === snorlax.ident);
  assert.equal(snorlaxSwitch.forced, true, 'switch right after Volt Switch should be marked forced');
  const pikachuSwitch = s.actions.find((a) => a.type === 'switch' && a.ident === pikachu.ident);
  assert.equal(pikachuSwitch.forced, false);
});

test('handcrafted: item reveal, status cure, boost clamp, weather', () => {
  const s = parseLog(HANDCRAFTED);
  const blissey = s.sides.p2.pokemon.find((m) => m.species === 'Blissey');
  assert.equal(blissey.item, 'Leftovers');
  assert.equal(blissey.itemRevealed, true);
  assert.equal(blissey.itemConsumed, false);
  assert.equal(blissey.status, null); // brn then cured
  assert.equal(blissey.boosts.atk, 6); // 12 raw -> clamped
  assert.equal(s.field.weather, null); // RainDance then none
  assert.equal(s.winner, 'Me');
});

test('BattleReader can process events incrementally (live mode)', () => {
  const reader = new BattleReader();
  reader.applyLine('|player|p1|Me|');
  reader.applyLine('|switch|p1a: Pikachu|Pikachu|100/100');
  reader.applyLine('|-damage|p1a: Pikachu|50/100');
  reader.applyLine('|turn|1');
  const s = reader.state;
  assert.equal(s.sides.p1.playerName, 'Me');
  const pikachu = s.sides.p1.pokemon.find((m) => m.species === 'Pikachu');
  assert.equal(pikachu.hpPercent, 50);
  assert.equal(s.turn, 1);
});
