// test/options.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { profileRows, renderOptionsHtml } from '../src/options/options.js';
import { updateProfile, addProfileAlias } from '../src/profiles/index.js';

// A couple of learned profiles to render.
const profileOf = (opponent, battles, wins, lead, lowHpSwitches, lowHpFaints) => {
  let p = null;
  for (let i = 0; i < battles; i++) {
    const win = i < wins;
    p = updateProfile(p, {
      opponent,
      result: win ? 'win' : 'loss',
      theirLead: lead,
      lowHpSwitches,
      lowHpFaints,
      switchIns: {},
      movesUsed: {},
      sets: {},
    });
  }
  return p;
};

const profiles = {
  vkhss: profileOf('vkhss', 3, 2, 'Great Tusk', 1, 3),
  alice: profileOf('alice', 1, 0, 'Landorus-Therian', 0, 0),
};

// ---------------------------------------------------------------------------
// profileRows
// ---------------------------------------------------------------------------

test('profileRows: sorts by battles played, most first', () => {
  const rows = profileRows(profiles);
  assert.deepEqual(rows.map((r) => r.opponent), ['vkhss', 'alice']);
});

test('profileRows: rows carry display projections and the storage key', () => {
  const rows = profileRows(profiles);
  const vkhss = rows.find((r) => r.opponent === 'vkhss');
  assert.equal(vkhss.key, 'vkhss');
  assert.equal(vkhss.battles, 3);
  assert.equal(vkhss.recordText, '2-1');
  assert.deepEqual(vkhss.commonLead, { species: 'Great Tusk', pct: 100 });
  assert.equal(vkhss.lowHpSwitchRate, 25); // 1 switch of 4 low-HP situations
  assert.deepEqual(vkhss.aliases, []);
});

test('profileRows: aliases are carried into the rows', () => {
  const withAlias = { john: addProfileAlias(profileOf('John', 1, 1, 'Great Tusk', 0, 0), 'vkhss') };
  const rows = profileRows(withAlias);
  assert.equal(rows[0].key, 'john');
  assert.deepEqual(rows[0].aliases, ['vkhss']);
});

test('profileRows: ignores malformed entries without a name', () => {
  assert.deepEqual(profileRows({ bad: { battles: 9 } }), []);
  assert.deepEqual(profileRows({}), []);
  assert.deepEqual(profileRows(undefined), []);
});

// ---------------------------------------------------------------------------
// renderOptionsHtml
// ---------------------------------------------------------------------------

test('renderOptionsHtml: settings controls reflect the stored values', () => {
  const html = renderOptionsHtml(profiles, { panelEnabled: false, statAssumption: 'base', riskMode: 'safe' });
  assert.ok(html.includes('id="psa-panel-enabled"'));
  assert.ok(!/id="psa-panel-enabled" checked/.test(html), 'unchecked when disabled');
  assert.match(html, /<option value="base" selected>/);
  assert.match(html, /<option value="safe" selected>/);
});

test('renderOptionsHtml: defaults are applied for missing settings', () => {
  const html = renderOptionsHtml(profiles, undefined);
  assert.match(html, /id="psa-panel-enabled" checked/);
  assert.match(html, /<option value="max" selected>/);
  assert.match(html, /<option value="auto" selected>/);
});

test('renderOptionsHtml: renders a row per profile with its learned facts', () => {
  const html = renderOptionsHtml(profiles, {});
  assert.ok(html.includes('value="vkhss"'));
  assert.ok(html.includes('3 battles'));
  assert.ok(html.includes('record 2-1'));
  assert.ok(html.includes('lead Great Tusk 100%'));
  assert.ok(html.includes('switches when low 25%'));
  assert.ok(html.includes('data-delete="vkhss"'));
  assert.ok(html.includes('data-delete="alice"'));
  assert.ok(html.includes('class="psa-clear-all"'));
});

test('renderOptionsHtml: rename inputs and alias controls are wired per profile', () => {
  const withAlias = {
    john: addProfileAlias(profileOf('John', 2, 2, 'Great Tusk', 0, 0), 'Vkhss'),
  };
  const html = renderOptionsHtml(withAlias, {});
  // Rename input carries the profile key.
  assert.match(html, /class="psa-row-name" value="John" data-opp-key="john"/);
  // Alias chip + remove button + add form all carry the profile key.
  assert.ok(html.includes('class="psa-alias"'));
  assert.ok(html.includes('>vkhss<'));
  assert.match(html, /data-remove-alias="john\|vkhss"/);
  assert.match(html, /class="psa-alias-add" data-opp-key="john"/);
  assert.ok(html.includes('aria-label="Add username"'));
});

test('renderOptionsHtml: aliases are HTML-escaped', () => {
  const withEvil = { john: addProfileAlias(profileOf('John', 1, 1, 'Great Tusk', 0, 0), '<img src=x>') };
  const html = renderOptionsHtml(withEvil, {});
  assert.ok(!html.includes('<img src=x>'));
  assert.ok(html.includes('&lt;img src=x&gt;'));
});

test('renderOptionsHtml: empty state when no profiles exist', () => {
  const html = renderOptionsHtml({}, {});
  assert.ok(html.includes('No profiles yet'));
  assert.ok(!html.includes('psa-clear-all'));
});

test('renderOptionsHtml: opponent names are HTML-escaped', () => {
  const evil = profileOf('<img src=x onerror=alert(1)>', 1, 1, 'Great Tusk', 0, 0);
  const html = renderOptionsHtml({ evil }, {});
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});
