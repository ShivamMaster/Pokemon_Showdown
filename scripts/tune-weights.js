// scripts/tune-weights.js
// Replays a batch of real battle logs turn-by-turn under different engine
// committee weight configs and compares the recommendations: for every turn
// where our side has a usable move recommendation, does the engine's top pick
// match the move the player actually made in the replay?
//
// This is the tuning harness for ENGINE_WEIGHTS in src/engine/recommend.js.
// The winner (highest match rate, with a stability bonus for agreeing with
// the current default) is what the engine should ship with. There's no
// ground truth in a log beyond "what a real player did", so match-rate vs
// the replay's actual moves is the honest signal we have.
//
// Usage:
//   node scripts/tune-weights.js [dir] [ourSideId]
//
//   dir       — directory of real battle logs (default test/fixtures/tune)
//   ourSideId — which side the engine advises (default p1)

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BattleReader } from '../src/reader/reader.js';
import { recommend } from '../src/engine/recommend.js';
import { setBattleFormat } from '../src/engine/randoms.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = process.argv[2] ?? path.join(ROOT, 'test', 'fixtures', 'tune');
const OUR_SIDE = process.argv[3] ?? 'p1';
const THEIR_SIDE = OUR_SIDE === 'p1' ? 'p2' : 'p1';

// Candidate weight sets. `blend` scales each engine's vote into the score
// (calc is the anchor), `agree` weights the confidence read. The first one
// is the current shipped default (all-1s blend = plain sum).
const CONFIGS = [
  { name: 'current', blend: { calc: 1, ko: 1, speed: 1, context: 1, response: 1 }, agree: { calc: 3, ko: 2, speed: 1, context: 1, response: 1 } },
  // Lean harder on the established damage engine: KO/speed/context move the
  // needle less relative to the calc read.
  { name: 'calc-heavy', blend: { calc: 1, ko: 0.5, speed: 0.5, context: 0.5, response: 0.5 }, agree: { calc: 4, ko: 1, speed: 1, context: 1, response: 1 } },
  { name: 'calc-max', blend: { calc: 1, ko: 0.1, speed: 0.1, context: 0.1, response: 0.1 }, agree: { calc: 5, ko: 1, speed: 1, context: 1, response: 1 } },
  // Prize the KO read more (finishing the target is worth more than raw chip).
  { name: 'ko-heavy', blend: { calc: 1, ko: 2, speed: 1, context: 1, response: 1 }, agree: { calc: 3, ko: 3, speed: 1, context: 1, response: 1 } },
  { name: 'ko-max', blend: { calc: 1, ko: 4, speed: 1, context: 1, response: 1 }, agree: { calc: 3, ko: 4, speed: 1, context: 1, response: 1 } },
  // Respect the speed/priority read more (who acts first matters).
  { name: 'speed-heavy', blend: { calc: 1, ko: 1, speed: 2, context: 1, response: 1 }, agree: { calc: 3, ko: 2, speed: 2, context: 1, response: 1 } },
  // Let the situational/utility read weigh in more (status, setup, items).
  { name: 'context-heavy', blend: { calc: 1, ko: 1, speed: 1, context: 2, response: 1 }, agree: { calc: 3, ko: 2, speed: 1, context: 2, response: 1 } },
  // Let the supporting engines REALLY matter: scale the calc read DOWN so
  // KO/speed/context have room to move the ranking.
  { name: 'balanced-up', blend: { calc: 0.6, ko: 1.4, speed: 1.4, context: 1.4, response: 1.4 }, agree: { calc: 2, ko: 2, speed: 2, context: 2, response: 2 } },
  // Prize the 2-ply response read (what their reply does to the position).
  { name: 'response-heavy', blend: { calc: 1, ko: 1, speed: 1, context: 1, response: 2 }, agree: { calc: 3, ko: 2, speed: 1, context: 1, response: 2 } },
  { name: 'response-max', blend: { calc: 1, ko: 1, speed: 1, context: 1, response: 4 }, agree: { calc: 3, ko: 2, speed: 1, context: 1, response: 4 } },
  // Finer sweep around the plateau: small nudges to KO (the most common
  // bonus) and to calc, to confirm the current all-1s blend is the optimum.
  { name: 'ko-0.75', blend: { calc: 1, ko: 0.75, speed: 1, context: 1, response: 1 }, agree: { calc: 3, ko: 1.5, speed: 1, context: 1, response: 1 } },
  { name: 'calc-0.8', blend: { calc: 0.8, ko: 1, speed: 1, context: 1, response: 1 }, agree: { calc: 2.5, ko: 2, speed: 1, context: 1, response: 1 } },
  { name: 'context-0.5', blend: { calc: 1, ko: 1, speed: 1, context: 0.5, response: 1 }, agree: { calc: 3, ko: 2, speed: 1, context: 0.5, response: 1 } },
  { name: 'ko-1.5', blend: { calc: 1, ko: 1.5, speed: 1, context: 1, response: 1 }, agree: { calc: 3, ko: 3, speed: 1, context: 1, response: 1 } },
];

// Replays one log. Returns an array of decision points:
//   { turn, ourMove, theirMove, ourSwitch, theirSwitch }
// — the moves actually made by each side that turn (null when the side
// switched or did nothing), captured by watching |move| / |switch| events.
function replayTurnMoves(logText) {
  const reader = new BattleReader();
  const points = [];
  let current = null;
  const lines = logText.split(/\r?\n/);
  for (const line of lines) {
    const ev = reader.applyLine(line);
    if (!ev) continue;
    if (ev.type === 'turn') {
      current = { turn: ev.args[0], ourMove: null, ourSwitch: null, theirMove: null, theirSwitch: null };
      points.push(current);
    } else if (current && ev.type === 'move') {
      // |move|p1a: Species|Move|p2a: Species
      const ident = ev.args[0];
      const move = ev.args[1];
      if (ident?.startsWith(OUR_SIDE)) current.ourMove = move;
      else if (ident?.startsWith(THEIR_SIDE)) current.theirMove = move;
    } else if (current && ev.type === 'switch') {
      // |switch|p1a: Species|Species, M|hp
      const ident = ev.args[0];
      const species = ev.args[1]?.split(',')[0];
      if (ident?.startsWith(OUR_SIDE)) current.ourSwitch = species;
      else if (ident?.startsWith(THEIR_SIDE)) current.theirSwitch = species;
    }
  }
  return points;
}

// At each turn, run every config against the pre-move state and see whether
// the top move matches the move that was actually played that turn. Also
// track how often each config's top move DIFFERS from the current default
// (flips) — those are the decisions where the weights actually matter, so
// the flip details are printed for manual inspection.
function evaluateConfigs(logs) {
  const stats = Object.fromEntries(CONFIGS.map((c) => [c.name, { turns: 0, matches: 0, moves: 0, top3: 0, flips: 0 }]));
  let totalDecisionTurns = 0;
  let knownTurns = 0; // turns where the actual move was already known to the engine
  const flipLog = []; // { turn, ourActive, actual, picks: {cfg: move} }

  for (const log of logs) {
    const moves = replayTurnMoves(log);
    const reader = new BattleReader();
    const lines = log.split(/\r?\n/);
    let turnIdx = 0;
    for (const line of lines) {
      const ev = reader.applyLine(line);
      if (ev?.type === 'turn') {
        const point = moves[turnIdx];
        turnIdx += 1;
        if (!point || !point.ourMove) continue; // no move made / battle over
        totalDecisionTurns += 1;
        const state = reader.state;
        if (!state?.sides?.[OUR_SIDE]?.pokemon?.length) continue;
        setBattleFormat(state.format);
        // Fairness: the engine can only recommend moves already revealed. If
        // the player's actual pick isn't known yet, no config could match it
        // — count those turns only toward the denominator, not the skill
        // comparison.
        const ourActive = state.sides?.[OUR_SIDE]?.pokemon?.find((p) => p.active);
        const actualKnown = !!ourActive && (ourActive.moves ?? []).includes(point.ourMove);
        if (actualKnown) knownTurns += 1;
        const picks = {};
        for (const cfg of CONFIGS) {
          const rec = recommend(state, { ourSideId: OUR_SIDE, engineWeights: cfg, rankedMoves: true });
          picks[cfg.name] = rec;
          const s = stats[cfg.name];
          s.turns += 1;
          if (rec.bestMove) {
            s.moves += 1;
            if (actualKnown && rec.bestMove.move === point.ourMove) s.matches += 1;
            if (actualKnown && (rec.rankedMoves ?? []).some((m) => m.move === point.ourMove)) s.top3 += 1;
          }
        }
        const base = picks.current?.bestMove?.move ?? null;
        const diverge = CONFIGS.filter((cfg) => {
          const rec = picks[cfg.name];
          return rec.bestMove && base && rec.bestMove.move !== base;
        });
        if (diverge.length) {
          for (const cfg of diverge) stats[cfg.name].flips += 1;
          const theirActive = state.sides?.[THEIR_SIDE]?.pokemon?.find((p) => p.active)?.species ?? '?';
          flipLog.push({
            turn: point.turn,
            ourActive: ourActive?.species ?? '?',
            theirActive,
            actual: point.ourMove,
            picks: Object.fromEntries(CONFIGS.map((c) => [c.name, picks[c.name]?.bestMove?.move ?? '-'])),
          });
        }
      }
    }
  }
  return { stats, totalDecisionTurns, knownTurns, flipLog };
}

// ---- main ----
const files = readdirSync(DIR).filter((f) => f.endsWith('.log'));
if (!files.length) {
  console.error(`No .log files in ${DIR}`);
  process.exit(1);
}
const logs = files.map((f) => readFileSync(path.join(DIR, f), 'utf8'));
console.log(`Tuning over ${files.length} battles (${logs.reduce((n, l) => n + l.split(/\r?\n/).length, 0)} lines), advising ${OUR_SIDE}:\n`);

const { stats, totalDecisionTurns, knownTurns, flipLog } = evaluateConfigs(logs);
console.log(
  `Decision turns with an actual move: ${totalDecisionTurns} (actual move already known to the engine: ${knownTurns})`
);
console.log('\nMatch = exact top pick; top-3 = actual move within the engine\'s top 3 — both only on known-move turns.');
console.log('config         | turns | moves | match |  rate | top-3 | flips');
for (const cfg of CONFIGS) {
  const s = stats[cfg.name];
  const rate = s.moves ? ((s.matches / knownTurns) * 100).toFixed(1) : '-';
  const top3 = s.moves ? ((s.top3 / knownTurns) * 100).toFixed(1) : '-';
  console.log(
    `${cfg.name.padEnd(14)} | ${String(s.turns).padStart(5)} | ${String(s.moves).padStart(5)} | ${String(s.matches).padStart(5)} | ${String(rate).padStart(5)}% | ${String(top3).padStart(5)}% | ${String(s.flips).padStart(5)}`
  );
}

// Agreement with the current default: how often does a candidate pick the
// same top move? A config that wins matches but diverges wildly from the
// shipped behavior is riskier to adopt.
const baseline = stats.current.matches / Math.max(1, stats.current.moves);
console.log('\nDelta vs current default:');
for (const cfg of CONFIGS.slice(1)) {
  const s = stats[cfg.name];
  const rate = s.moves ? s.matches / s.moves : 0;
  const d = ((rate - baseline) * 100).toFixed(1);
  console.log(`  ${cfg.name.padEnd(14)} ${d >= 0 ? '+' : ''}${d} pts (flips: ${s.flips})`);
}

if (flipLog.length) {
  console.log(`\nDecisions where a config disagreed with current (${flipLog.length}):`);
  for (const f of flipLog) {
    console.log(`  T${f.turn} ${f.ourActive} vs ${f.theirActive} | actual: ${f.actual}`);
    for (const [name, pick] of Object.entries(f.picks)) {
      if (pick !== '-' && pick !== f.picks.current) console.log(`      ${name}: ${pick}`);
    }
  }
}
