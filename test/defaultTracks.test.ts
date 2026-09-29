import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb } from '../src/db/index.ts';
import {
  replaceDefaultTracks,
  peekNextDefaultTrack,
  removeDefaultTrack,
  countDefaultTracks,
  type NewDefaultTrack,
} from '../src/db/defaultTracks.ts';

beforeEach(() => {
  initDb(':memory:');
});

const t = (n: number): NewDefaultTrack => ({
  provider: 'spotify',
  playUri: `spotify:track:${n}`,
  title: `T${n}`,
  author: 'A',
  durationSec: n,
});

test('треки выдаются в порядке загрузки, удалённый трек больше не выдаётся', () => {
  replaceDefaultTracks([t(3), t(1), t(2)]);
  assert.equal(countDefaultTracks(), 3);
  const first = peekNextDefaultTrack()!;
  assert.deepEqual({ ...first, id: undefined }, { ...t(3), id: undefined });
  removeDefaultTrack(first.id);
  assert.equal(peekNextDefaultTrack()!.playUri, 'spotify:track:1');
  assert.equal(countDefaultTracks(), 2);
});

test('replaceDefaultTracks полностью заменяет старое содержимое', () => {
  replaceDefaultTracks([t(1), t(2)]);
  replaceDefaultTracks([t(5)]);
  assert.equal(countDefaultTracks(), 1);
  assert.equal(peekNextDefaultTrack()!.playUri, 'spotify:track:5');
});

test('пустая таблица — undefined', () => {
  assert.equal(peekNextDefaultTrack(), undefined);
});
