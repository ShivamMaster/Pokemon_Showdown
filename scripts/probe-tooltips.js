// scripts/probe-tooltips.js
// Opens the fixture replay battle page and inspects:
//   1. whether the client exposes global battle data (BattleLearnsets,
//      BattleMovedex, BattlePokedex) usable from the main world,
//   2. the DOM structure of the hover tooltip that appears when hovering a
//      Pokémon in the battle scene (the thing the content script will read).
//
//   node scripts/probe-tooltips.js

import puppeteer from 'puppeteer-core';
import { findChrome } from './lib/chrome.js';

const REPLAY = process.argv[2] ?? 'https://play.pokemonshowdown.com/battle-gen9ou-2104765130-8jjmu80p6yi3y3ndho3b0w1yepcl8dppw';

const CHROME = findChrome();
if (!CHROME) {
  console.error('No Chrome found.');
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
});

const page = await browser.newPage();
await page.goto(REPLAY, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => {
  return (document.querySelector('.battle') || window.app?.curRoom?.battle) && document.body.innerText.length > 200;
}, { timeout: 45000 });
await new Promise((r) => setTimeout(r, 3000));

const globals = await page.evaluate(() => {
  const out = {};
  for (const g of ['BattleLearnsets', 'BattleMovedex', 'BattlePokedex', 'BattleItems', 'BattleAbilities', 'Dex']) {
    out[g] = typeof window[g];
  }
  return out;
});
console.log('globals:', JSON.stringify(globals));

if (typeof globals.BattleLearnsets === 'object') {
  const sample = await page.evaluate(() => {
    const L = window.BattleLearnsets;
    const keys = Object.keys(L);
    const dn = L['dragonite'];
    const rr = L['rillaboom'];
    return {
      totalSpecies: keys.length,
      dragoniteHas: !!dn,
      dragoniteLearnsetSize: dn ? Object.keys(dn.learnset ?? {}).length : 0,
      dragoniteMoves: dn ? Object.keys(dn.learnset ?? {}).slice(0, 15) : [],
      rillaboomLearnsetSize: rr ? Object.keys(rr.learnset ?? {}).length : 0,
    };
  });
  console.log('learnsets sample:', JSON.stringify(sample, null, 2));
}

// Find hover targets and dump tooltips.
const sceneDump = await page.evaluate(() => {
  const scene = document.querySelector('.battle');
  if (!scene) return { missing: true };
  // list sprite-ish elements and their classes
  const spriteEls = [...scene.querySelectorAll('[class*=p1], [class*=p2]')]
    .filter((el) => el.className && /\bp[12][abf]?\b/.test(String(el.className)))
    .slice(0, 12)
    .map((el) => ({ cls: el.className, tag: el.tagName }));
  const html = scene.innerHTML.slice(0, 2500);
  return { spriteEls, html };
});
console.log('scene:', JSON.stringify(sceneDump, null, 2).slice(0, 3500));

const hoverInfo = await page.evaluate(() => {
  const candidates = [];
  for (const sel of ['.battle .p1 .picon', '.battle .p2 .picon', '.battle .sprites [class*="p1"]',
    '.battle .sprites [class*="p2"]', '.battle .statbar', '.battle .hpbar', '.battle .sprites img']) {
    const els = document.querySelectorAll(sel);
    if (els.length) candidates.push({ sel, count: els.length, tag: els[0].outerHTML.slice(0, 160) });
  }
  return candidates;
});
console.log('hover candidates:', JSON.stringify(hoverInfo, null, 2));

// Try real mouse hovers on team icons and dump any .tooltip that appears.
for (const sel of ['.battle .teamicons .picon.has-tooltip', '.battle .sprites [class*="p1"]']) {
  try {
    await page.hover(sel);
  } catch {
    continue;
  }
  await new Promise((r) => setTimeout(r, 500));
  const res = await page.evaluate((s) => {
    const tip = document.querySelector('.tooltip');
    if (!tip) return { sel: s, tooltip: false };
    return {
      sel: s,
      tooltip: true,
      cls: tip.className,
      text: (tip.innerText ?? '').slice(0, 400),
      html: tip.outerHTML.slice(0, 1400),
    };
  }, sel);
  console.log('--- hover result ---');
  console.log(JSON.stringify(res, null, 2));
  if (res.tooltip) break;
}

// Client pokemon identity: sides[sideIndex].pokemon[slotIndex] -> ident?
const clientMons = await page.evaluate(() => {
  const b = window.app?.curRoom?.battle;
  if (!b) return { missing: true };
  const out = { mySide: b.mySide?.sideid ?? b.mySide?.id ?? null };
  out.sides = (b.sides ?? []).map((s) => ({
    id: s.id ?? s.sideid ?? null,
    pokemon: (s.pokemon ?? []).map((p) => ({
      ident: p.ident ?? null,
      species: p.species ?? p.name ?? null,
      moveCount: (p.moves ?? []).length,
    })),
  }));
  return out;
});
console.log('client mons:', JSON.stringify(clientMons, null, 2).slice(0, 1600));

// Can the client fetch the full learnsets data file?
const fetchCheck = await page.evaluate(async () => {
  const out = {};
  for (const url of ['https://play.pokemonshowdown.com/js/data/learnsets.js',
    'https://play.pokemonshowdown.com/data/learnsets.js']) {
    try {
      const res = await fetch(url);
      const text = await res.text();
      out[url] = { status: res.status, bytes: text.length, head: text.slice(0, 80) };
    } catch (e) {
      out[url] = { error: String(e) };
    }
  }
  return out;
});
console.log('learnsets fetch:', JSON.stringify(fetchCheck, null, 2));

await browser.close();
