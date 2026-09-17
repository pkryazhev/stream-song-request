import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eventBus } from '../src/core/eventBus.ts';
import {
  registerRequestsToggleHandler,
  type DefaultPlaylistControllable,
} from '../src/music/requestsToggleHandler.ts';
import { isRequestsPaused, setRequestsPaused } from '../src/music/requestsGate.ts';
import type { ChatMessageEvent } from '../src/core/events.ts';

const cfg = { pauseCommand: '!pr', resumeCommand: '!rr' };

class FakeOrchestrator implements DefaultPlaylistControllable {
  haltCalls = 0;
  tickCalls = 0;

  async haltDefaultPlaylist(): Promise<void> {
    this.haltCalls += 1;
  }

  async tick(): Promise<void> {
    this.tickCalls += 1;
  }
}

function makeMsg(overrides: Partial<ChatMessageEvent> = {}): ChatMessageEvent {
  return {
    userId: 'viewer-1',
    login: 'viewer1',
    displayName: 'Viewer1',
    text: '!pr',
    isModerator: false,
    isBroadcaster: false,
    ...overrides,
  };
}

function collectReplies(): { replies: string[]; unsubscribe: () => void } {
  const replies: string[] = [];
  const listener = ({ text }: { text: string }): void => {
    replies.push(text);
  };
  eventBus.on('chat.reply', listener);
  return { replies, unsubscribe: () => eventBus.off('chat.reply', listener) };
}

beforeEach(() => {
  setRequestsPaused(false);
});

test('broadcaster приостанавливает заказы через !pr — гасит дефолтный плейлист сразу', async () => {
  const orchestrator = new FakeOrchestrator();
  const unregister = registerRequestsToggleHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg({ isBroadcaster: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(isRequestsPaused(), true);
    assert.equal(orchestrator.haltCalls, 1);
    assert.match(replies[0], /приостановлены/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('модератор тоже может приостанавливать и возобновлять заказы', async () => {
  const orchestrator = new FakeOrchestrator();
  const unregister = registerRequestsToggleHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg({ isModerator: true, text: '!pr' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(isRequestsPaused(), true);

    eventBus.emit('chat.message', makeMsg({ isModerator: true, text: '!rr' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(isRequestsPaused(), false);
    assert.equal(orchestrator.tickCalls, 1);
    assert.match(replies.at(-1) ?? '', /снова доступны/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('обычный зритель не может приостановить заказы', async () => {
  const orchestrator = new FakeOrchestrator();
  const unregister = registerRequestsToggleHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(isRequestsPaused(), false);
    assert.equal(orchestrator.haltCalls, 0);
    assert.equal(replies.length, 0);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('повторный !pr, когда уже приостановлено — сообщение без повторной остановки', async () => {
  const orchestrator = new FakeOrchestrator();
  setRequestsPaused(true);
  const unregister = registerRequestsToggleHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg({ isBroadcaster: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(orchestrator.haltCalls, 0);
    assert.match(replies[0], /уже приостановлены/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('!rr, когда заказы и так доступны — сообщение без лишнего tick()', async () => {
  const orchestrator = new FakeOrchestrator();
  const unregister = registerRequestsToggleHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg({ isBroadcaster: true, text: '!rr' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(orchestrator.tickCalls, 0);
    assert.match(replies[0], /и так доступны/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('другие команды/сообщения игнорируются', async () => {
  const orchestrator = new FakeOrchestrator();
  const unregister = registerRequestsToggleHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg({ isBroadcaster: true, text: 'привет' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(replies.length, 0);
    assert.equal(isRequestsPaused(), false);
  } finally {
    unsubscribe();
    unregister();
  }
});
