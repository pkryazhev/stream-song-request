import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventBus } from '../src/core/eventBus.ts';
import { registerSkipVoteHandler, type SkipableOrchestrator } from '../src/music/skipVoteHandler.ts';
import type { ChatMessageEvent } from '../src/core/events.ts';

const cfg = { commandName: '!skip', thresholdPercent: 30, activeWindowMs: 10 * 60 * 1000 };

class FakeOrchestrator implements SkipableOrchestrator {
  mode: 'default' | 'request' = 'request';
  skipCalls = 0;

  getMode(): 'default' | 'request' {
    return this.mode;
  }

  skip(): boolean {
    this.skipCalls += 1;
    return this.mode === 'request';
  }
}

function makeMsg(overrides: Partial<ChatMessageEvent> = {}): ChatMessageEvent {
  return {
    userId: 'viewer-1',
    login: 'viewer1',
    displayName: 'Viewer1',
    text: '!skip',
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

test('broadcaster скипает трек сразу, без учёта порога голосования', () => {
  const orchestrator = new FakeOrchestrator();
  const { tracker: _tracker, unregister } = registerSkipVoteHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg({ isBroadcaster: true }));
    assert.equal(orchestrator.skipCalls, 1);
    assert.match(replies[0], /скипнут/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('одного голоса зрителя недостаточно, если активных зрителей много', () => {
  const orchestrator = new FakeOrchestrator();
  const { unregister } = registerSkipVoteHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    for (let i = 0; i < 10; i += 1) {
      eventBus.emit('chat.message', makeMsg({ userId: `u${i}`, text: 'привет' }));
    }
    eventBus.emit('chat.message', makeMsg({ userId: 'u0', text: '!skip' }));

    assert.equal(orchestrator.skipCalls, 0);
    assert.match(replies.at(-1) ?? '', /голос за скип принят \(1\/3\)/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('после накопления достаточного числа голосов трек скипается', () => {
  const orchestrator = new FakeOrchestrator();
  const { unregister } = registerSkipVoteHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    for (let i = 0; i < 10; i += 1) {
      eventBus.emit('chat.message', makeMsg({ userId: `u${i}`, text: 'привет' }));
    }
    eventBus.emit('chat.message', makeMsg({ userId: 'u0', text: '!skip' }));
    eventBus.emit('chat.message', makeMsg({ userId: 'u1', text: '!skip' }));
    eventBus.emit('chat.message', makeMsg({ userId: 'u2', text: '!skip' }));

    assert.equal(orchestrator.skipCalls, 1);
    assert.match(replies.at(-1) ?? '', /скипнут голосованием \(3\/3\)/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('пока играет дефолтный плейлист — скипать нечего, голос не учитывается', () => {
  const orchestrator = new FakeOrchestrator();
  orchestrator.mode = 'default';
  const { unregister } = registerSkipVoteHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg({ isBroadcaster: true }));
    assert.equal(orchestrator.skipCalls, 0);
    assert.match(replies[0], /нечего скипать/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('song.now_playing сбрасывает накопленные голоса — старые голоса не переносятся на новый трек', () => {
  const orchestrator = new FakeOrchestrator();
  const { unregister } = registerSkipVoteHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    for (let i = 0; i < 10; i += 1) {
      eventBus.emit('chat.message', makeMsg({ userId: `u${i}`, text: 'привет' }));
    }
    eventBus.emit('chat.message', makeMsg({ userId: 'u0', text: '!skip' }));
    eventBus.emit('chat.message', makeMsg({ userId: 'u1', text: '!skip' }));

    // Новый трек начал играть — голоса за предыдущий должны сброситься.
    eventBus.emit('song.now_playing', { title: 'Next', provider: 'youtube', requestedById: 'nobody' });

    eventBus.emit('chat.message', makeMsg({ userId: 'u2', text: '!skip' }));

    // Если бы голоса не сбросились, u0+u1+u2 = 3 голоса уже хватило бы раньше.
    assert.equal(orchestrator.skipCalls, 0);
    assert.match(replies.at(-1) ?? '', /голос за скип принят \(1\/3\)/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('зритель, заказавший текущий трек, скипает его сразу — без голосования', () => {
  const orchestrator = new FakeOrchestrator();
  const { unregister } = registerSkipVoteHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('song.now_playing', { title: 'Requester track', provider: 'youtube', requestedById: 'viewer-1' });

    eventBus.emit('chat.message', makeMsg({ userId: 'viewer-1', text: '!skip' }));

    assert.equal(orchestrator.skipCalls, 1);
    assert.match(replies.at(-1) ?? '', /скипнут.*твой заказ/s);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('зритель, который трек НЕ заказывал, не может скипнуть его сразу — обычное голосование', () => {
  const orchestrator = new FakeOrchestrator();
  const { unregister } = registerSkipVoteHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('song.now_playing', { title: 'Someone else track', provider: 'youtube', requestedById: 'author-1' });
    // 10 активных зрителей — порог 3 голоса.
    for (let i = 0; i < 10; i += 1) {
      eventBus.emit('chat.message', makeMsg({ userId: `u${i}`, text: 'привет' }));
    }

    eventBus.emit('chat.message', makeMsg({ userId: 'u0', text: '!skip' }));

    assert.equal(orchestrator.skipCalls, 0);
    assert.match(replies.at(-1) ?? '', /голос за скип принят \(1\/3\)/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('право мгновенного скипа не переносится на следующий трек, если его заказал кто-то другой', () => {
  const orchestrator = new FakeOrchestrator();
  const { unregister } = registerSkipVoteHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('song.now_playing', { title: 'First', provider: 'youtube', requestedById: 'viewer-1' });
    eventBus.emit('song.now_playing', { title: 'Second', provider: 'youtube', requestedById: 'someone-else' });
    for (let i = 0; i < 10; i += 1) {
      eventBus.emit('chat.message', makeMsg({ userId: `u${i}`, text: 'привет' }));
    }

    // viewer-1 заказывал предыдущий (First), а не текущий (Second) трек —
    // мгновенного скипа для него больше нет, только обычное голосование.
    eventBus.emit('chat.message', makeMsg({ userId: 'viewer-1', text: '!skip' }));

    assert.equal(orchestrator.skipCalls, 0);
    assert.match(replies.at(-1) ?? '', /голос за скип принят/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('повторный !skip того же зрителя не учитывается дважды', () => {
  const orchestrator = new FakeOrchestrator();
  const { unregister } = registerSkipVoteHandler(orchestrator, cfg);
  const { unsubscribe } = collectReplies();
  try {
    for (let i = 0; i < 10; i += 1) {
      eventBus.emit('chat.message', makeMsg({ userId: `u${i}`, text: 'привет' }));
    }
    eventBus.emit('chat.message', makeMsg({ userId: 'u0', text: '!skip' }));
    eventBus.emit('chat.message', makeMsg({ userId: 'u0', text: '!skip' }));
    eventBus.emit('chat.message', makeMsg({ userId: 'u0', text: '!skip' }));

    assert.equal(orchestrator.skipCalls, 0);
  } finally {
    unsubscribe();
    unregister();
  }
});
