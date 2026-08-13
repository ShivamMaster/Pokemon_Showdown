// scripts/probe-client.js
// Probe the Showdown client for patchable entry points that expose the raw
// battle protocol: battle.receive / parseLine and the stepQueue contents.
//
//   node scripts/probe-client.js

import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const REPLAY = process.argv[2] ?? 'https://play.pokemonshowdown.com/battle-gen9ou-2104765130-8jjmu80p6yi3y3ndho3b0w1yepcl8dppw';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
});

try {
  const page = await browser.newPage();
  await page.goto(REPLAY, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 10000));

  const info = await page.evaluate(() => {
    const out = {};
    const battle = window.app?.curRoom?.battle;
    if (!battle) return { error: 'no battle' };
    out.receiveType = typeof battle.receive;
    out.parseLineType = typeof battle.parseLine;
    out.parseRequestType = typeof battle.parseRequest;
    out.addType = typeof battle.add;
    out.logMethodType = typeof battle.log;
    out.parseSwitchType = typeof battle.parseSwitch;
    out.parseMoveType = typeof battle.parseMove;
    out.stepQueueIsArray = Array.isArray(battle.stepQueue);
    out.stepQueueLength = battle.stepQueue?.length ?? null;
    if (Array.isArray(battle.stepQueue)) {
      const s = battle.stepQueue.find((x) => x && typeof x === 'object');
      out.stepQueueSample = battle.stepQueue.slice(0, 4).map((x) => {
        if (typeof x === 'string') return x.slice(0, 120);
        if (x && typeof x === 'object') {
          const keys = Object.keys(x).slice(0, 10);
          const mini = {};
          for (const k of keys) {
            const v = x[k];
            mini[k] = typeof v === 'string' ? v.slice(0, 60) : Array.isArray(v) ? `Array(${v.length})` : typeof v;
          }
          return { stepType: x.type, mini };
        }
        return String(x).slice(0, 120);
      });
    }
    // message-log DOM structure
    const ml = document.querySelector('.message-log');
    out.messageLogChildren = ml
      ? Array.from(ml.children).slice(0, 10).map((c) => ({
          tag: c.tagName,
          cls: c.className,
          text: (c.innerText ?? '').slice(0, 70),
        }))
      : null;
    return out;
  });
  console.log(JSON.stringify(info, null, 2));
} finally {
  await browser.close();
}
