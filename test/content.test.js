// test/content.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createBattleSource, ourSideIdFromBattle, ourSideIdFromRoom } from '../src/content/source.js';
import { parseLog } from '../src/reader/reader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const liveQueue = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'live-stepqueue.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Battle source
// ---------------------------------------------------------------------------

test('source.poll: returns new lines once, then nothing new', () => {
  const queue = ['|start', '|turn|1', '|move|p1a: X|Tackle|p2a: Y'];
  let battle = { id: 'b1', stepQueue: [...queue] };
  const source = createBattleSource({ getBattleFn: () => battle });

  const first = source.poll();
  assert.deepEqual(first.lines, queue);
  assert.equal(first.reset, false);
  assert.equal(first.battleId, 'b1');

  const second = source.poll();
  assert.deepEqual(second.lines, []);

  // New lines appended -> only the new ones come back.
  battle.stepQueue.push('|turn|2');
  const third = source.poll();
  assert.deepEqual(third.lines, ['|turn|2']);
});

test('source.poll: no battle yet -> empty, and recovers when battle appears', () => {
  let battle = null;
  const source = createBattleSource({ getBattleFn: () => battle });
  assert.deepEqual(source.poll().lines, []);
  battle = { id: 'b1', stepQueue: ['|start'] };
  assert.deepEqual(source.poll().lines, ['|start']);
});

test('source.poll: signals reset when the battle changes', () => {
  const source = createBattleSource({
    getBattleFn: () => ({ id: current.id, stepQueue: current.queue }),
  });
  let current = { id: 'battle-1', queue: ['|start', '|turn|1'] };
  assert.equal(source.poll().reset, false);
  assert.equal(source.poll().reset, false);
  current = { id: 'battle-2', queue: ['|start'] };
  const poll = source.poll();
  assert.equal(poll.reset, true, 'new battle id must signal a reader reset');
  assert.deepEqual(poll.lines, ['|start']);
});

test('source.poll: re-syncs if the queue is cleared/replaced', () => {
  const source = createBattleSource({ getBattleFn: () => battle });
  let battle = { id: 'b1', stepQueue: ['|a', '|b', '|c'] };
  assert.equal(source.poll().lines.length, 3);
  battle = { id: 'b1', stepQueue: ['|d'] }; // replaced (e.g. replay restart)
  assert.deepEqual(source.poll().lines, ['|d']);
});

test('ourSideIdFromBattle: detects p2 when we are the second player', () => {
  const battle = {
    sides: [
      { sideid: 'p1', id: 'baddygames', name: 'BaddyGames' },
      { sideid: 'p2', id: 'vkhss', name: 'vkhss' },
    ],
    mySide: { id: 'vkhss' },
  };
  assert.equal(ourSideIdFromBattle(battle), 'p2');
});

test('source.poll: surfaces the live request when it changes (once)', () => {
  let request = { side: { id: 'p1', name: 'Me', pokemon: [{ ident: 'p1: X', moves: ['tackle'] }] } };
  let battle = { id: 'b1', stepQueue: ['|start'] };
  const source = createBattleSource({
    getBattleFn: () => battle,
    getRequestFn: () => request,
  });

  const first = source.poll();
  assert.equal(first.requestChanged, true, 'first sight of the request');
  assert.equal(first.request, request);

  const second = source.poll();
  assert.equal(second.requestChanged, false, 'unchanged request is not re-applied');

  request = { side: { id: 'p1', name: 'Me', pokemon: [{ ident: 'p1: X', moves: ['tackle', 'growl'] }] } };
  const third = source.poll();
  assert.equal(third.requestChanged, true, 'updated request is surfaced again');

  // A new battle forgets the previous request fingerprint.
  battle = { id: 'b2', stepQueue: ['|start'] };
  request = { side: { id: 'p1', name: 'Me', pokemon: [{ ident: 'p1: X', moves: ['tackle'] }] } };
  const poll = source.poll();
  assert.equal(poll.reset, true);
  assert.equal(poll.requestChanged, true);
});

test('source.poll: no live request -> requestChanged stays false', () => {
  const source = createBattleSource({ getBattleFn: () => ({ id: 'b1', stepQueue: ['|start'] }) });
  assert.equal(source.poll().request, null);
  assert.equal(source.poll().requestChanged, false);
});

test('ourSideId: prefers the room side id over log inference', () => {
  const battle = {
    sides: [{ sideid: 'p1' }, { sideid: 'p2' }],
    mySide: { id: 'vkhss' },
  };
  const source = createBattleSource({ getBattleFn: () => battle });
  // Without a room, falls back to log inference.
  assert.equal(source.ourSideId(), 'p1');
});

test('ourSideIdFromRoom: reads the client room side id', () => {
  const original = globalThis.window;
  globalThis.window = { app: { curRoom: { side: 'p2' } } };
  try {
    assert.equal(ourSideIdFromRoom(), 'p2');
  } finally {
    globalThis.window = original;
  }
  assert.equal(ourSideIdFromRoom(), null, 'no room -> null');
});

test('ourSideIdFromBattle: defaults to p1 when unknown', () => {
  assert.equal(ourSideIdFromBattle(null), 'p1');
  assert.equal(ourSideIdFromBattle({ sides: [{ sideid: 'p1' }] }), 'p1');
  assert.equal(
    ourSideIdFromBattle({ sides: [{ sideid: 'p1' }], mySide: { id: 'somebody-else' } }),
    'p1'
  );
});

// ---------------------------------------------------------------------------
// Live protocol (captured from the real client) parses identically
// ---------------------------------------------------------------------------

test('live stepQueue (client protocol) parses to the same battle state', () => {
  const state = parseLog(liveQueue.stepQueue.join('\n'));

  assert.equal(state.gen, 9);
  assert.equal(state.turn, 22);
  assert.equal(state.winner, 'BaddyGames');
  assert.equal(state.format, '[Gen 9] OU');

  const p2 = (species) => state.sides.p2.pokemon.find((m) => m.species === species);
  const p1 = (species) => state.sides.p1.pokemon.find((m) => m.species === species);

  // The exact reveals the engine needs.
  assert.deepEqual(p2('Dragonite').moves, ['Encore', 'Scale Shot']);
  assert.deepEqual(p2('Great Tusk').moves, ['Earthquake', 'Ice Spinner']);
  assert.equal(p2('Dragonite').item, 'Loaded Dice');
  assert.equal(p2('Dragonite').itemConsumed, true);
  assert.equal(p2('Great Tusk').item, 'Leftovers');
  assert.equal(p2('Roaring Moon').teraType, 'Flying');
  assert.equal(p1('Rillaboom').hpPercent, 1);
  assert.equal(p1('Rillaboom').status, 'psn');
  assert.equal(p2('Dragonite').switchCount, 4);
  assert.equal(state.sides.p1.effects['Toxic Spikes'], 1);
  assert.equal(state.field.terrain, 'Grassy Terrain');
});
