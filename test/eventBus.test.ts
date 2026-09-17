import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TypedEventBus } from '../src/core/eventBus.ts';

test('eventBus доставляет payload подписчику', () => {
  const bus = new TypedEventBus();
  let received: unknown = null;

  bus.on('song.now_playing', (payload) => {
    received = payload;
  });

  bus.emit('song.now_playing', {
    title: 'test',
    provider: 'youtube',
    requestedById: '1',
  });

  assert.ok(received);
  assert.equal((received as { title: string }).title, 'test');
});

test('off() отписывает слушателя', () => {
  const bus = new TypedEventBus();
  let callCount = 0;
  const listener = () => {
    callCount += 1;
  };

  bus.on('song.now_playing', listener);
  bus.off('song.now_playing', listener);
  bus.emit('song.now_playing', {
    title: 't',
    provider: 'youtube',
    requestedById: '2',
  });

  assert.equal(callCount, 0);
});
