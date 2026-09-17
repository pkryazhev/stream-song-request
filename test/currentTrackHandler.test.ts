import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventBus } from '../src/core/eventBus.ts';
import { registerCurrentTrackHandler, type CurrentTrackProvider } from '../src/music/currentTrackHandler.ts';
import type { CurrentTrackInfo } from '../src/music/playbackOrchestrator.ts';
import type { ChatMessageEvent } from '../src/core/events.ts';

const cfg = { commandName: '!s' };

class FakeOrchestrator implements CurrentTrackProvider {
  track: CurrentTrackInfo | null = null;
  shouldThrow = false;

  async getCurrentTrack(): Promise<CurrentTrackInfo | null> {
    if (this.shouldThrow) throw new Error('boom');
    return this.track;
  }
}

function makeMsg(overrides: Partial<ChatMessageEvent> = {}): ChatMessageEvent {
  return {
    userId: 'viewer-1',
    login: 'viewer1',
    displayName: 'Viewer1',
    text: '!s',
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

test('!s показывает YouTube-трек — только название, как при добавлении в очередь', async () => {
  const orchestrator = new FakeOrchestrator();
  orchestrator.track = { provider: 'youtube', title: 'Never Gonna Give You Up', author: 'Rick Astley' };
  const unregister = registerCurrentTrackHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(replies[0], 'Сейчас играет: "Never Gonna Give You Up"');
  } finally {
    unsubscribe();
    unregister();
  }
});

test('!s показывает Spotify-трек как "исполнитель - название", как при добавлении в очередь', async () => {
  const orchestrator = new FakeOrchestrator();
  orchestrator.track = { provider: 'spotify', title: 'Bohemian Rhapsody', author: 'Queen' };
  const unregister = registerCurrentTrackHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(replies[0], 'Сейчас играет: "Queen - Bohemian Rhapsody"');
  } finally {
    unsubscribe();
    unregister();
  }
});

test('!s без текущего трека сообщает, что ничего не играет', async () => {
  const orchestrator = new FakeOrchestrator();
  orchestrator.track = null;
  const unregister = registerCurrentTrackHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(replies[0], 'Сейчас ничего не играет');
  } finally {
    unsubscribe();
    unregister();
  }
});

test('другая команда игнорируется', async () => {
  const orchestrator = new FakeOrchestrator();
  orchestrator.track = { provider: 'youtube', title: 'Track', author: 'Author' };
  const unregister = registerCurrentTrackHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg({ text: '!другое' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(replies.length, 0);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('ошибка при получении текущего трека не роняет обработчик — отдаётся понятное сообщение', async () => {
  const orchestrator = new FakeOrchestrator();
  orchestrator.shouldThrow = true;
  const unregister = registerCurrentTrackHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(replies[0], /не получилось узнать текущий трек/);
  } finally {
    unsubscribe();
    unregister();
  }
});
