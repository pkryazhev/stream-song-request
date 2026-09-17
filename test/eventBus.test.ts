import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TypedEventBus } from '../src/core/eventBus.ts';

test('eventBus доставляет payload подписчику', () => {
  const bus = new TypedEventBus();
  let received: unknown = null;

  bus.on('stream.went_live', (payload) => {
    received = payload;
  });

  bus.emit('stream.went_live', {
    streamId: '1',
    broadcasterLogin: 'pavel_streams',
    title: 'test',
    gameName: 'Just Chatting',
    thumbnailUrl: '',
    startedAt: new Date().toISOString(),
  });

  assert.ok(received);
  assert.equal((received as { streamId: string }).streamId, '1');
});

test('off() отписывает слушателя', () => {
  const bus = new TypedEventBus();
  let callCount = 0;
  const listener = () => {
    callCount += 1;
  };

  bus.on('stream.went_live', listener);
  bus.off('stream.went_live', listener);
  bus.emit('stream.went_live', {
    streamId: '2',
    broadcasterLogin: 'x',
    title: 't',
    gameName: 'g',
    thumbnailUrl: '',
    startedAt: 'now',
  });

  assert.equal(callCount, 0);
});
