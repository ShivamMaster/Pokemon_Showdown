// test/speed.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBattleState, createPokemon, addMove } from '../src/reader/state.js';
import { buildField } from '../src/engine/calc.js';
import {
  effectiveSpeedRange,
  speedOrder,
  speedLine,
  findSpeedEvidence,
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

test('speed: exact raw stats make the range a point and modifiers still apply', () => {
  const state = baseState();
  const mon = makeMon('Raging Bolt');
  mon.stats = { atk: 120, def: 100, spa: 150, spd: 100, spe: 165 }; // exact EVs+nature
  const r = effectiveSpeedRange(9, mon, state, 'p1');
  assert.deepEqual(r, { min: 165, max: 165 });
  // A +1 Speed stage still applies on top of the exact raw stat.
  mon.boosts.spe = 1;
  assert.deepEqual(effectiveSpeedRange(9, mon, state, 'p1'), { min: Math.round(165 * 1.5), max: Math.round(165 * 1.5) });
});

test('speed: fully-modified stats are used as-is (no double application)', () => {
  const state = baseState();
  const mon = makeMon('Raging Bolt', { boosts: { spe: 1 } });
  mon.status = 'par';
  // The tooltip "(After stat modifiers:)" value already includes the boost AND
  // the paralysis halving — the engine must not apply either again.
  mon.statsEffective = { atk: 120, def: 100, spa: 150, spd: 100, spe: 124 };
  assert.deepEqual(effectiveSpeedRange(9, mon, state, 'p1'), { min: 124, max: 124 });
});

test('speed: the opponent hover Spe range is used as the base', () => {
  const state = baseState();
  const mon = makeMon('Raging Bolt');
  mon.speedRange = { min: 139, max: 273 }; // real tooltip bounds (before modifiers)
  assert.deepEqual(effectiveSpeedRange(9, mon, state, 'p1'), { min: 139, max: 273 });
  // Modifiers still apply on top (e.g. Choice Scarf).
  mon.item = 'Choice Scarf';
  mon.itemRevealed = true;
  const r = effectiveSpeedRange(9, mon, state, 'p1');
  assert.equal(r.min, Math.round(139 * 1.5));
  assert.equal(r.max, Math.round(273 * 1.5));
});

test('speed: Iron Ball halves speed', () => {
  const state = baseState();
  const iron = makeMon('Raging Bolt', { item: 'Iron Ball' });
  const r = effectiveSpeedRange(9, iron, state, 'p1');
  assert.equal(r.min, Math.round(186 * 0.5));
  assert.equal(r.max, Math.round(273 * 0.5));
});

test('speed: exact stat + Iron Ball = point', () => {
  const state = baseState();
  const mon = makeMon('Raging Bolt');
  mon.stats = { atk: 120, def: 100, spa: 150, spd: 100, spe: 165 };
  mon.item = 'Iron Ball';
  mon.itemRevealed = true;
  assert.deepEqual(effectiveSpeedRange(9, mon, state, 'p1'), { min: Math.round(165 * 0.5), max: Math.round(165 * 0.5) });
});

test('speed: Macho Brace and Power items halve speed like Iron Ball', () => {
  const state = baseState();
  for (const item of ['Macho Brace', 'Power Anklet', 'Power Band', 'Power Belt', 'Power Bracer', 'Power Lens', 'Power Weight']) {
    const mon = makeMon('Raging Bolt', { item });
    const r = effectiveSpeedRange(9, mon, state, 'p1');
    assert.equal(r.min, Math.round(186 * 0.5), `${item} should halve speed`);
    assert.equal(r.max, Math.round(273 * 0.5), `${item} should halve speed`);
  }
  // Consumed = no effect (same as Choice Scarf).
  const eaten = makeMon('Raging Bolt', { item: 'Macho Brace', itemConsumed: true });
  assert.equal(effectiveSpeedRange(9, eaten, state, 'p1').min, 186);
});

test('speed: Quick Powder doubles an untransformed Ditto only', () => {
  const state = baseState();
  const ditto = makeMon('Ditto', { item: 'Quick Powder' });
  const base = effectiveSpeedRange(9, makeMon('Ditto'), state, 'p1');
  const r = effectiveSpeedRange(9, ditto, state, 'p1');
  assert.equal(r.min, base.min * 2);
  assert.equal(r.max, base.max * 2);
  // Any other species: no effect.
  const notDitto = makeMon('Raging Bolt', { item: 'Quick Powder' });
  assert.equal(effectiveSpeedRange(9, notDitto, state, 'p1').min, 186);
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

test('speed: observed move order resolves an overlapping range matchup', () => {
  const state = baseState();
  const ours = makeMon('Raging Bolt');   // base 85
  const theirs = makeMon('Great Tusk');  // base 85 — identical ranges
  // Ranges overlap, so without evidence the order is unknown…
  assert.equal(speedOrder(ours, theirs, 9, state, 'p1').weMoveFirst, null);
  // …but the log showed Great Tusk (p2) acting first: that observation wins.
  state.speedEvidence.push({
    turn: 1,
    fasterSide: 'p2',
    p1Ident: ours.ident,
    p2Ident: theirs.ident,
    p1Move: 'Dragon Pulse',
    p2Move: 'Earthquake',
    clean: true,
    trickRoom: false,
    ver: { p1: 0, p2: 0, field: 0, side1: 0, side2: 0 },
  });
  const order = speedOrder(ours, theirs, 9, state, 'p1');
  assert.equal(order.weMoveFirst, false);
  assert.equal(order.observed, true);
  assert.ok(findSpeedEvidence(state, ours, theirs, 'p1'));
});

test('speed: evidence is ignored when anything speed-affecting changed since', () => {
  // Fresh mons per case so the recorded versions always match the evidence.
  const fresh = () => [makeMon('Raging Bolt'), makeMon('Great Tusk')];
  const push = (state, ours, theirs, mutate) => {
    state.speedEvidence.push({
      turn: 1,
      fasterSide: 'p2',
      p1Ident: ours.ident,
      p2Ident: theirs.ident,
      p1Move: 'Dragon Pulse',
      p2Move: 'Earthquake',
      clean: true,
      trickRoom: false,
      ver: { p1: 0, p2: 0, field: 0, side1: 0, side2: 0 },
    });
    mutate();
    return speedOrder(ours, theirs, 9, state, 'p1');
  };
  // A Speed boost on either mon invalidates the observation.
  let state = baseState();
  let [ours, theirs] = fresh();
  let order = push(state, ours, theirs, () => { ours.boosts.spe = 1; ours.speVersion += 1; });
  assert.equal(order.observed, false);
  assert.equal(order.weMoveFirst, null);
  // A weather change (Swift Swim/Chlorophyll toggle) invalidates it too.
  state = baseState();
  [ours, theirs] = fresh();
  order = push(state, ours, theirs, () => { state.field.weather = 'RainDance'; state.field.speVersion += 1; });
  assert.equal(order.observed, false);
  // An unrelated change (e.g. Reflect on our side) does not.
  state = baseState();
  [ours, theirs] = fresh();
  order = push(state, ours, theirs, () => { state.sides.p1.effects.Reflect = 1; });
  assert.equal(order.observed, true);
  assert.equal(order.weMoveFirst, false);
});

test('speed: Lagging Tail makes the holder move last regardless of Speed', () => {
  const state = baseState();
  const fast = makeMon('Deoxys-Speed');   // base 150
  const slow = makeMon('Ferrothorn');     // base 20
  // Normally Deoxys decisively outspeeds Ferrothorn…
  assert.equal(speedOrder(fast, slow, 9, state, 'p1').weMoveFirst, true);
  // …but if the FAST one holds Lagging Tail, it moves last anyway.
  const laggingFast = makeMon('Deoxys-Speed', { item: 'Lagging Tail' });
  const order = speedOrder(laggingFast, slow, 9, state, 'p1');
  assert.equal(order.weMoveFirst, false);
  assert.equal(order.laggingTail, true);
  // The slow non-holder holding it changes nothing about the fast one winning.
  const laggingSlow = makeMon('Ferrothorn', { item: 'Lagging Tail' });
  assert.equal(speedOrder(fast, laggingSlow, 9, state, 'p1').weMoveFirst, true);
  // Both holding it: Speed decides between them again.
  assert.equal(speedOrder(laggingFast, laggingSlow, 9, state, 'p1').weMoveFirst, true);
  // Trick Room does NOT rescue the Lagging Tail holder — it still moves last.
  state.field.effects['Trick Room'] = 1;
  state.field.speVersion += 1;
  assert.equal(speedOrder(laggingFast, slow, 9, state, 'p1').weMoveFirst, false);
});

test('speed: Lagging Tail overrides a decisive edge and the line says so', () => {
  const state = baseState();
  const ours = makeMon('Ferrothorn');
  const theirs = makeMon('Deoxys-Speed', { item: 'Lagging Tail' });
  const line = speedLine(ours, theirs, 9, state, 'p1');
  assert.match(line, /Their Deoxys-Speed holds Lagging Tail — you move first regardless of Speed/);
  const line2 = speedLine(theirs, ours, 9, state, 'p1');
  assert.match(line2, /You hold Lagging Tail — their Ferrothorn moves first regardless of Speed/);
});

test('speed: observed order also wins under Trick Room', () => {
  const state = baseState();
  state.field.effects['Trick Room'] = 1;
  state.field.speVersion += 1;
  const ours = makeMon('Ferrothorn');
  const theirs = makeMon('Deoxys-Speed');
  // Under Trick Room the log showed Ferrothorn (p1) acting first (it's slower).
  state.speedEvidence.push({
    turn: 1,
    fasterSide: 'p1',
    p1Ident: ours.ident,
    p2Ident: theirs.ident,
    p1Move: 'Gyro Ball',
    p2Move: 'Psycho Boost',
    clean: true,
    trickRoom: true,
    ver: { p1: 0, p2: 0, field: 1, side1: 0, side2: 0 },
  });
  const order = speedOrder(ours, theirs, 9, state, 'p1');
  assert.equal(order.weMoveFirst, true, 'the slower mon acts first under Trick Room');
  assert.equal(order.observed, true);
});

test('speed: a mon that left and came back keeps its observed order (species fallback)', () => {
  const state = baseState();
  // Ours never left (switchCount 1, exact ident); theirs re-entered under a new
  // slot letter (p2a -> p2b, switchCount 2). The evidence was recorded while
  // theirs was p2a, so an exact ident match fails — species must carry it.
  const ours = makeMon('Raging Bolt');
  ours.ident = 'p1a: Raging Bolt';
  const theirs = makeMon('Great Tusk');
  theirs.ident = 'p2b: Great Tusk';
  theirs.side = 'p2';
  theirs.switchCount = 2;
  state.speedEvidence.push({
    turn: 3,
    fasterSide: 'p2',
    p1Ident: 'p1a: Raging Bolt',
    p2Ident: 'p2a: Great Tusk',
    p1Species: 'Raging Bolt',
    p2Species: 'Great Tusk',
    p1Move: 'Dragon Pulse',
    p2Move: 'Earthquake',
    clean: true,
    trickRoom: false,
    ver: { p1: 0, p2: 0, field: 0, side1: 0, side2: 0 },
  });
  const ev = findSpeedEvidence(state, ours, theirs, 'p1');
  assert.ok(ev, 'evidence must be found after the opponent re-entered');
  const order = speedOrder(ours, theirs, 9, state, 'p1');
  assert.equal(order.observed, true);
  assert.equal(order.weMoveFirst, false, 'their re-entered mon still outspeeds us');
  // And without a re-entry (switchCount 1), the old ident never matches.
  const neverLeft = makeMon('Great Tusk');
  neverLeft.ident = 'p2b: Great Tusk';
  neverLeft.side = 'p2';
  assert.equal(findSpeedEvidence(state, ours, neverLeft, 'p1'), null);
});

test('speed: species-keyed memory narrows the base range and survives re-entry', () => {
  const state = baseState();
  // No stats revealed — the plain calc guess is the full 240-333 for Garchomp.
  const garchomp = makeMon('Garchomp');
  assert.deepEqual(effectiveSpeedRange(9, garchomp, state, 'p2'), { min: 240, max: 333 });
  // The reader learned (from an earlier trade vs a 295-Speed mon) that
  // Garchomp's base Speed is at most 295 — the memory applies regardless of
  // which ident the mon currently holds.
  state.speedMemory.p2.Garchomp = { min: null, max: 295, turn: 1 };
  assert.deepEqual(effectiveSpeedRange(9, garchomp, state, 'p2'), { min: 240, max: 295, source: 'memory' });
  // Bounds on both sides narrow from both ends.
  state.speedMemory.p2.Garchomp = { min: 260, max: 290, turn: 2 };
  assert.deepEqual(effectiveSpeedRange(9, garchomp, state, 'p2'), { min: 260, max: 290, source: 'memory' });
  // Modifiers still apply on top of the remembered base (e.g. paralysis).
  garchomp.status = 'par';
  const par = effectiveSpeedRange(9, garchomp, state, 'p2');
  assert.equal(par.min, Math.round(260 * 0.5));
  assert.equal(par.max, Math.round(290 * 0.5));
  assert.equal(par.source, 'memory');
});

test('speed: a memory that contradicts the species is discarded', () => {
  const state = baseState();
  const garchomp = makeMon('Garchomp');
  // Bounds above the species' possible Speed can't be real — fall back to the
  // plain calc range with no source marker.
  state.speedMemory.p2.Garchomp = { min: 350, max: 400, turn: 1 };
  assert.deepEqual(effectiveSpeedRange(9, garchomp, state, 'p2'), { min: 240, max: 333 });
});

test('speed: a remembered range is labelled in the line', () => {
  const state = baseState();
  const ours = makeMon('Raging Bolt');
  const theirs = makeMon('Garchomp');
  theirs.side = 'p2';
  state.speedMemory.p2.Garchomp = { min: null, max: 290, turn: 1 };
  const line = speedLine(ours, theirs, 9, state, 'p1');
  assert.match(line, /240-290/);
  assert.match(line, /\(speed remembered from earlier trades\)/);
  // Not remembered -> no label.
  delete state.speedMemory.p2.Garchomp;
  assert.doesNotMatch(speedLine(ours, theirs, 9, state, 'p1'), /\(speed remembered from earlier trades\)/);
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

test('speed: line text says when the order was observed and shows points', () => {
  const state = baseState();
  const ours = makeMon('Raging Bolt');
  const theirs = makeMon('Great Tusk');
  ours.stats = { atk: 120, def: 100, spa: 150, spd: 100, spe: 165 };
  theirs.speedRange = { min: 139, max: 273 };
  state.speedEvidence.push({
    turn: 1,
    fasterSide: 'p2',
    p1Ident: ours.ident,
    p2Ident: theirs.ident,
    p1Move: 'Dragon Pulse',
    p2Move: 'Earthquake',
    clean: true,
    trickRoom: false,
    ver: { p1: 0, p2: 0, field: 0, side1: 0, side2: 0 },
  });
  const line = speedLine(ours, theirs, 9, state, 'p1');
  assert.match(line, /Their Great Tusk outspeeds you/);
  assert.match(line, /observed: it moved first when you last traded moves/);
  // Point ranges render as a single number, not "165-165".
  assert.match(line, /vs 165\)/);
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
  // Offense is now weighted 0.6 (was 0.15) and capped at the target's HP —
  // Ferrothorn is at full HP here and neither the KO bonus nor the revealed-
  // move penalty apply (Gyro Ball hits Garchomp for well under 40%).
  const candOff = ownBestDamage(candidate, theirActive, 9, field);
  const baseNet = (now - cand) + Math.min(candOff, 100) * 0.6;

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
