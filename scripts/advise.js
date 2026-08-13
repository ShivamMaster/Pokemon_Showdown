// scripts/advise.js
// Parses a Showdown battle log and prints the engine's recommendation.
//
// Usage:
//   node scripts/advise.js [logfile] [ourSideId]
//   node scripts/advise.js test/fixtures/real-battle.log p1

import { readFileSync } from 'node:fs';
import { parseLog } from '../src/reader/index.js';
import { recommend } from '../src/engine/index.js';

const file = process.argv[2] ?? 'test/fixtures/real-battle.log';
const ourSideId = process.argv[3] ?? 'p1';

const state = parseLog(readFileSync(file, 'utf8'));
const rec = recommend(state, { ourSideId });

console.log(`\nBattle: ${state.format ?? '?'} | turn ${state.turn} | winner: ${state.winner ?? 'in progress'}\n`);
console.log(`Best move: ${rec.bestMove?.move ?? '—'}${rec.bestMove?.note ? `  (${rec.bestMove.note})` : ''}`);
console.log(`Switch to: ${rec.switchTo?.species ?? '—'}${rec.switchTo?.note ? `  (${rec.switchTo.note})` : ''}`);
console.log('\nReasoning:');
for (const r of rec.reasoning) console.log(`  • ${r}`);
if (rec.note) console.log(`\n${rec.note}`);
console.log('');
