import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb } from '../src/db/index.ts';
import { getSetting, setSetting } from '../src/db/settings.ts';

beforeEach(() => {
  initDb(':memory:');
});

test('незаданная настройка — undefined', () => {
  assert.equal(getSetting('points.reward_id'), undefined);
});

test('настройка сохраняется и перезаписывается', () => {
  setSetting('points.reward_id', 'r-1');
  assert.equal(getSetting('points.reward_id'), 'r-1');
  setSetting('points.reward_id', 'r-2');
  assert.equal(getSetting('points.reward_id'), 'r-2');
});
