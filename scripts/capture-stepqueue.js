// scripts/capture-stepqueue.js
// Captures the raw protocol array (battle.stepQueue) from a real battle page
// and saves it as a test fixture, so tests can parse the exact data the live
// client exposes.
//
//   node scripts/capture-stepqueue.js [replay-url]

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const REPLAY = process.argv[2] ?? 'https://play.pokemonshowdown.com/battle-gen9ou-2104765130-8jjmu80p6yi3y3ndho3b0w1yepcl8dppw';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'live-stepqueue.json');

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
});

try {
  const page = await browser.newPage();
  await page.goto(REPLAY, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Wait until the battle has progressed (turn 1 present in the queue).
  await page.waitForFunction(() => {
    const q = window.app?.curRoom?.battle?.stepQueue;
    return Array.isArray(q) && q.some((l) => String(l).startsWith('|turn|'));
  }, { timeout: 30000 });

  const data = await page.evaluate(() => {
    const battle = window.app.curRoom.battle;
    return {
      battleId: battle.id,
      turn: battle.turn,
      gen: battle.gen,
      tier: battle.tier,
      stepQueue: battle.stepQueue.map((l) => String(l)),
    };
  });
  writeFileSync(OUT, JSON.stringify(data, null, 1));
  console.log(`captured ${data.stepQueue.length} lines (turn ${data.turn}) -> ${OUT}`);
} finally {
  await browser.close();
}
