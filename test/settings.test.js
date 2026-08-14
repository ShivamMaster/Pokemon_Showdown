// test/settings.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS, normalizeSettings, loadSettings, saveSettings } from '../src/settings.js';

test('settings: defaults are sane', () => {
  assert.deepEqual(DEFAULT_SETTINGS, { panelEnabled: true, statAssumption: 'max', riskMode: 'auto' });
});

test('settings: normalizeSettings fills missing keys with defaults', () => {
  assert.deepEqual(normalizeSettings(undefined), { ...DEFAULT_SETTINGS });
  assert.deepEqual(normalizeSettings({}), { ...DEFAULT_SETTINGS });
  assert.deepEqual(normalizeSettings({ panelEnabled: false }), { panelEnabled: false, statAssumption: 'max', riskMode: 'auto' });
  assert.deepEqual(normalizeSettings({ statAssumption: 'base' }), { panelEnabled: true, statAssumption: 'base', riskMode: 'auto' });
  assert.deepEqual(normalizeSettings({ riskMode: 'aggressive' }), { panelEnabled: true, statAssumption: 'max', riskMode: 'aggressive' });
});

test('settings: loadSettings returns defaults when nothing is stored', async () => {
  assert.deepEqual(await loadSettings(), { ...DEFAULT_SETTINGS });
});

test('settings: save/load round-trips through the storage driver', async () => {
  await saveSettings({ panelEnabled: false, statAssumption: 'base', riskMode: 'safe' });
  assert.deepEqual(await loadSettings(), { panelEnabled: false, statAssumption: 'base', riskMode: 'safe' });
});

test('settings: partial stored values are normalized on load', async () => {
  await saveSettings({ panelEnabled: false });
  assert.deepEqual(await loadSettings(), { panelEnabled: false, statAssumption: 'max', riskMode: 'auto' });
});
