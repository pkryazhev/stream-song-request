import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb } from '../src/db/index.ts';
import { enqueueSongRequest, peekNextPending, markPlaying, markDone, countPending } from '../src/db/musicQueue.ts';

function sampleTrack(overrides: Partial<Parameters<typeof enqueueSongRequest>[0]> = {}) {
  return {
    provider: 'youtube' as const,
    externalId: 'abc',
    playUri: 'https://www.youtube.com/watch?v=abc',
    title: 'Track',
    author: 'Author',
    durationSec: 120,
    requestedById: 'u1',
    requestedByLogin: 'viewer1',
    ...overrides,
  };
}

test('заказы обрабатываются строго по очереди (FIFO), без приоритетов', () => {
  initDb(':memory:');

  const first = enqueueSongRequest(sampleTrack({ title: 'First' }));
  const second = enqueueSongRequest(sampleTrack({ title: 'Second' }));
  const third = enqueueSongRequest(sampleTrack({ title: 'Third' }));

  assert.equal(first.position, 1);
  assert.equal(second.position, 2);
  assert.equal(third.position, 3);

  const next1 = peekNextPending();
  assert.equal(next1?.title, 'First');
  markPlaying(next1!.id);
  markDone(next1!.id);

  const next2 = peekNextPending();
  assert.equal(next2?.title, 'Second');
  markPlaying(next2!.id);
  markDone(next2!.id);

  const next3 = peekNextPending();
  assert.equal(next3?.title, 'Third');
});

test('peekNextPending возвращает undefined для пустой очереди', () => {
  initDb(':memory:');
  assert.equal(peekNextPending(), undefined);
});

test('countPending учитывает только статус pending', () => {
  initDb(':memory:');
  enqueueSongRequest(sampleTrack({ title: 'A' }));
  const b = enqueueSongRequest(sampleTrack({ title: 'B' }));
  assert.equal(countPending(), 2);

  markPlaying(b.id);
  assert.equal(countPending(), 1);

  markDone(b.id);
  assert.equal(countPending(), 1); // A всё ещё pending
});

test('заказ сохраняет провайдера и данные заказчика', () => {
  initDb(':memory:');
  enqueueSongRequest(
    sampleTrack({ provider: 'spotify', playUri: 'spotify:track:xyz', requestedByLogin: 'someviewer' }),
  );
  const next = peekNextPending();
  assert.equal(next?.provider, 'spotify');
  assert.equal(next?.playUri, 'spotify:track:xyz');
  assert.equal(next?.requestedByLogin, 'someviewer');
  assert.equal(next?.status, 'pending');
});
