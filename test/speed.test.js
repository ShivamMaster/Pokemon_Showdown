// test/speed.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBattleState, createPokemon, addMove } from '../src/reader/state.js';
import { buildField } from '../src/engine/calc.js';
import {
  effectiveSpeedRange,
  speedOrder,
  speedLine,
} from '../src/engine/speed.js';
import {
  evaluateMove,
  evaluateSwitch,
  recommend,
  incomingPercent,
  ownBestDamage,
} from '../src/engine/recommend.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMon(species, extra = {}) {
  const rec = createPokemon({
    ident: `p1a: ${species}`,
    side: 'p1',
    species,
    level: extra.level ?? 100,
  });
  rec.hpPercent = extra.hpPercent ?? 100;
  rec.hp = { cur: extra.hpPercent ?? 100, max: 100 };
  for (const mv of extra.moves ?? []) addMove(rec, mv);
  if (extra.boosts) Object.assign(rec.boosts, extra.boosts);
  if (extra.status) rec.status = extra.status;
  if (extra.item) {
    rec.item = extra.item;
    rec.itemRevealed = true;
  }
  if (extra.itemConsumed) rec.itemConsumed = true;
  if (extra.ability) rec.ability = extra.ability;
  return rec;
}

function baseState() {
  const state = createBattleState();
  state.gen = 9;
  return state;
}

// ---------------------------------------------------------------------------
// effectiveSpeedRange modifiers
// ---------------------------------------------------------------------------

test('speed: base range is 0 EV (neutral) to 252 EV (timid)', () => {
  const state = baseState();
  const mon = makeMon('Raging Bolt'); // base 85
  const r = effectiveSpeedRange(9, mon, state, 'p1');
  assert.equal(r.min, 186);
  assert.equal(r.max, 273);
});

test('speed: boost stages multiply speed', () => {
  const state = baseState();
  const boosted = makeMon('Raging Bolt', { boosts: { spe: 2 } });
  const r = effectiveSpeedRange(9, boosted, state, 'p1');
  assert.equal(r.min, 186 * 2);
  assert.equal(r.max, 273 * 2);
});

test('speed: paralysis halves speed', () => {
  const state = baseState();
  const par = makeMon('Iron Treads', { status: 'par' });
  const r = effectiveSpeedRange(9, par, state, 'p1');
  assert.equal(r.min, 124);
  assert.equal(r.max, 171);
});

test('speed: Choice Scarf multiplies speed (only while held)', () => {
  const state = baseState();
  const scarfed = makeMon('Raging Bolt', { item: 'Choice Scarf' });
  const r = effectiveSpeedRange(9, scarfed, state, 'p1');
  assert.equal(r.min, Math.round(186 * 1.5));
  assert.equal(r.max, Math.round(273 * 1.5));

  const consumed = makeMon('Raging Bolt', { item: 'Choice Scarf', itemConsumed: true });
  const rc = effectiveSpeedRange(9, consumed, state, 'p1');
  assert.equal(rc.min, 186);
});

test('speed: Swift Swim doubles speed in rain', () => {
  const state = baseState();
  state.field.weather = 'RainDance';
  const swift = makeMon('Barraskewda', { ability: 'Swift Swim' });
  const r = effectiveSpeedRange(9, swift, state, 'p1');
  const base = effectiveSpeedRange(9, makeMon('Barraskewda'), state, 'p1');
  assert.equal(r.min, base.min * 2);
});

test('speed: Tailwind doubles that side only', () => {
  const state = baseState();
  state.sides.p1.effects.Tailwind = 1;
  const ours = makeMon('Raging Bolt');
  const theirs = makeMon('Iron Treads');
  assert.equal(effectiveSpeedRange(9, ours, state, 'p1').min, 186 * 2);
  assert.equal(effectiveSpeedRange(9, theirs, state, 'p2').min, 248); // no boost
});

test('speed: unknown species yields a zero range instead of crashing', () => {
  const state = baseState();
  const r = effectiveSpeedRange(9, makeMon('Totally Fake Mon'), state, 'p1');
  assert.deepEqual(r, { min: 0, max: 0 });
});

// ---------------------------------------------------------------------------
// speedOrder decisiveness
// ---------------------------------------------------------------------------

test('speed: overlapping ranges mean the order is unknown', () => {
  const state = baseState();
  const order = speedOrder(makeMon('Raging Bolt'), makeMon('Iron Treads'), 9, state, 'p1');
  assert.equal(order.weMoveFirst, null);
  assert.equal(order.trickRoom, false);
});

test('speed: a big gap is decisive both ways', () => {
  const state = baseState();
  const fast = makeMon('Deoxys-Speed'); // base 150
  const slow = makeMon('Ferrothorn');   // base 20
  assert.equal(speedOrder(fast, slow, 9, state, 'p1').weMoveFirst, true);
  assert.equal(speedOrder(slow, fast, 9, state, 'p1').weMoveFirst, false);
});

test('speed: Trick Room flips a decisive gap', () => {
  const state = baseState();
  state.field.effects['Trick Room'] = 1;
  const fast = makeMon('Deoxys-Speed');
  const slow = makeMon('Ferrothorn');
  // Under Trick Room the slower mon moves first, so "we move first" flips.
  assert.equal(speedOrder(slow, fast, 9, state, 'p1').weMoveFirst, true);
  assert.equal(speedOrder(fast, slow, 9, state, 'p1').weMoveFirst, false);
  assert.equal(speedOrder(slow, fast, 9, state, 'p1').trickRoom, true);
});

test('speed: a boost can turn an overlap into a decisive edge', () => {
  const state = baseState();
  const boosted = makeMon('Raging Bolt', { boosts: { spe: 2 } });
  assert.equal(speedOrder(boosted, makeMon('Iron Treads'), 9, state, 'p1').weMoveFirst, true);
});

// ---------------------------------------------------------------------------
// speedLine text
// ---------------------------------------------------------------------------

test('speed: line text covers all three outcomes', () => {
  const state = baseState();
  assert.match(
    speedLine(makeMon('Deoxys-Speed'), makeMon('Ferrothorn'), 9, state, 'p1'),
    /You outspeed their Ferrothorn/
  );
  assert.match(
    speedLine(makeMon('Ferrothorn'), makeMon('Deoxys-Speed'), 9, state, 'p1'),
    /Their Deoxys-Speed outspeeds you/
  );
  assert.match(
    speedLine(makeMon('Raging Bolt'), makeMon('Iron Treads'), 9, state, 'p1'),
    /Speed is close/
  );
});

// ---------------------------------------------------------------------------
// evaluateMove speed adjustments
// ---------------------------------------------------------------------------

test('speed: outspeeding and KO-ing is rewarded', () => {
  const state = baseState();
  const field = buildField(state);
  const fast = makeMon('Deoxys-Speed', { moves: ['Psycho Boost'] });
  const slow = makeMon('Ferrothorn', { hpPercent: 15 });
  const speed = speedOrder(fast, slow, 9, state, 'p1');
  assert.equal(speed.weMoveFirst, true);

  const withSpeed = evaluateMove(fast, 'Psycho Boost', slow, [slow], 1, {}, 9, field, {}, speed);
  const without = evaluateMove(fast, 'Psycho Boost', slow, [slow], 1, {}, 9, field, {}, null);
  assert.ok(withSpeed.score > without.score);
  assert.match(withSpeed.note, /you outspeed — safe to go for the KO/);
});

test('speed: being outsped and KO-able is penalized', () => {
  const state = baseState();
  const field = buildField(state);
  // Ferrothorn at 30% HP: their outsped hit (~43%) now KOs us.
  const slow = makeMon('Ferrothorn', { hpPercent: 30, moves: ['Gyro Ball'] });
  const fast = makeMon('Deoxys-Speed', { moves: ['Superpower'] });
  const speed = speedOrder(slow, fast, 9, state, 'p1');
  assert.equal(speed.weMoveFirst, false);

  const withSpeed = evaluateMove(slow, 'Gyro Ball', fast, [fast], 1, {}, 9, field, {}, speed);
  const without = evaluateMove(slow, 'Gyro Ball', fast, [fast], 1, {}, 9, field, {}, null);
  assert.ok(withSpeed.score < without.score);
  assert.match(withSpeed.note, /they outspeed and can KO you first/);
});

test('speed: a close speed matchup leaves move scores unchanged', () => {
  const state = baseState();
  const field = buildField(state);
  const us = makeMon('Raging Bolt', { moves: ['Thunderbolt'] });
  const them = makeMon('Iron Treads', { moves: ['Earthquake'] });
  const speed = speedOrder(us, them, 9, state, 'p1');
  assert.equal(speed.weMoveFirst, null);

  const withSpeed = evaluateMove(us, 'Thunderbolt', them, [them], 1, {}, 9, field, {}, speed);
  const without = evaluateMove(us, 'Thunderbolt', them, [them], 1, {}, 9, field, {}, null);
  assert.equal(withSpeed.score, without.score);
});

// ---------------------------------------------------------------------------
// evaluateSwitch speed adjustments
// ---------------------------------------------------------------------------

test('speed: a switch-in that outspeeds their active is rewarded', () => {
  const state = baseState();
  const field = buildField(state);
  // Garchomp (base 102) decisively outspeeds Ferrothorn (base 20): even at
  // Garchomp's minimum speed it moves before Ferrothorn's maximum.
  const ourActive = makeMon('Deoxys-Speed', { moves: ['Psycho Boost'] });
  const candidate = makeMon('Garchomp', { moves: ['Earthquake'] });
  const theirActive = makeMon('Ferrothorn', { moves: ['Gyro Ball'] });
  assert.equal(speedOrder(candidate, theirActive, 9, state, 'p1').weMoveFirst, true);

  const now = incomingPercent(theirActive, ourActive, 9, field).pct;
  const cand = incomingPercent(theirActive, candidate, 9, field).pct;
  const candOff = ownBestDamage(candidate, theirActive, 9, field);
  const baseNet = (now - cand) + candOff * 0.15;

  const speedCtx = { state, ourSideId: 'p1' };
  const res = evaluateSwitch(ourActive, candidate, theirActive, 9, field, {}, speedCtx);
  assert.ok(res);
  assert.equal(res.net, Math.round((baseNet + 5) * 10) / 10);
  assert.match(res.note, /outspeeds their Ferrothorn — moves first/);
});

test('speed: a switch-in that is outsped while taking heavy damage is penalized', () => {
  const state = baseState();
  const field = buildField(state);
  const ourActive = makeMon('Deoxys-Speed', { moves: ['Psycho Boost'] });
  const candidate = makeMon('Ferrothorn', { moves: ['Gyro Ball'] });
  const theirActive = makeMon('Deoxys-Speed', { moves: ['Superpower'] });

  // Sanity: their Superpower hits Ferrothorn hard enough to trigger the penalty.
  assert.ok(incomingPercent(theirActive, candidate, 9, field).pct >= 40);

  const speedCtx = { state, ourSideId: 'p1' };
  const res = evaluateSwitch(ourActive, candidate, theirActive, 9, field, {}, speedCtx);
  if (res) {
    assert.match(res.note, /but their Deoxys-Speed outspeeds Ferrothorn — it hits first/);
  }
});

// ---------------------------------------------------------------------------
// recommend integration
// ---------------------------------------------------------------------------

function makeState({ ourActive, theirActive, ourBench = [], theirBench = [] }) {
  const state = createBattleState();
  state.gen = 9;
  state.turn = 3;
  state.gametype = 'singles';
  state.sides.p1.playerName = 'Me';
  state.sides.p2.playerName = 'Rival';
  const add = (sideId, specs, activeSpecies) => {
    const side = state.sides[sideId];
    const letters = 'abcdef';
    side.pokemon = specs.map((spec, i) => {
      const rec = makeMon(spec.species, spec);
      rec.ident = `${sideId}${letters[i]}: ${spec.species}`;
      rec.side = sideId;
      return rec;
    });
    const active = side.pokemon.find((p) => p.species === activeSpecies);
    if (active) {
      side.active = [active.ident];
      active.active = true;
    }
  };
  add('p1', [...(ourActive ? [ourActive] : []), ...ourBench], ourActive?.species);
  add('p2', [...(theirActive ? [theirActive] : []), ...theirBench], theirActive?.species);
  return state;
}

test('speed: recommend reports the speed situation in reasoning', () => {
  const state = makeState({
    ourActive: makeMon('Raging Bolt', { moves: ['Thunderclap'] }),
    theirActive: makeMon('Iron Treads', { moves: ['Earthquake'] }),
  });
  const r = recommend(state, { ourSideId: 'p1' });
  assert.ok(r.reasoning.some((x) => /Speed is close/.test(x)));
});

test('speed: recommend names a decisive speed edge', () => {
  const state = makeState({
    ourActive: makeMon('Deoxys-Speed', { moves: ['Psycho Boost'] }),
    theirActive: makeMon('Ferrothorn', { moves: ['Gyro Ball'] }),
  });
  const r = recommend(state, { ourSideId: 'p1' });
  assert.ok(r.reasoning.some((x) => /You outspeed their Ferrothorn/.test(x)));
});

test('speed: no crash when their whole team is down (pre-win screen)', () => {
  const state = makeState({
    ourActive: makeMon('Raging Bolt', { moves: ['Thunderclap'] }),
    theirActive: null,
    theirBench: [],
  });
  const r = recommend(state, { ourSideId: 'p1' });
  assert.match(r.reasoning[0], /All of their Pokémon are down/);
});
