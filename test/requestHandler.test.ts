import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eventBus } from '../src/core/eventBus.ts';
import { handleChatMessage, registerMusicRequestHandler, type RequestHandlerConfig } from '../src/music/requestHandler.ts';
import { initDb } from '../src/db/index.ts';
import { peekNextPending } from '../src/db/musicQueue.ts';
import { resetSpotifyAppTokenCache } from '../src/music/spotifyAuth.ts';
import { setRequestsPaused } from '../src/music/requestsGate.ts';
import type { ChatMessageEvent } from '../src/core/events.ts';

const baseCfg: RequestHandlerConfig = {
  commandName: '!sr',
  minFollowerDays: 3,
  maxYoutubeDurationSec: 600,
  youtubeApiKey: 'yt-key',
  spotify: { clientId: 'sp-cid', clientSecret: 'sp-secret' },
  twitchClientId: 'tw-cid',
  twitchBroadcasterId: 'broadcaster-1',
  getTwitchAccessToken: async () => 'mod-token',
};

/** Тот же cfg, но без Spotify — для тестов режима "только YouTube" (см. #3). */
const noSpotifyCfg: RequestHandlerConfig = { ...baseCfg, spotify: undefined };

function makeMsg(overrides: Partial<ChatMessageEvent> = {}): ChatMessageEvent {
  return {
    userId: 'viewer-1',
    login: 'viewer1',
    displayName: 'Viewer1',
    text: '',
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

interface RawSpotifySearchItem {
  id: string;
  uri: string;
  name: string;
  artists: Array<{ name: string }>;
  duration_ms: number;
}

function fakeFetchFactory(opts: {
  followedDaysAgo: number | null; // null = не фолловер
  youtube?: { durationIso: string; title?: string };
  spotify?: { title?: string; durationMs?: number };
  spotifySearchItems?: RawSpotifySearchItem[];
}): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);

    if (u.includes('api.twitch.tv/helix/channels/followers')) {
      if (opts.followedDaysAgo === null) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      const followedAt = new Date(Date.now() - opts.followedDaysAgo * 24 * 60 * 60 * 1000).toISOString();
      return new Response(JSON.stringify({ data: [{ followed_at: followedAt }] }), { status: 200 });
    }

    if (u.includes('googleapis.com/youtube/v3/videos')) {
      if (!opts.youtube) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      return new Response(
        JSON.stringify({
          items: [
            {
              snippet: { title: opts.youtube.title ?? 'YT Video', channelTitle: 'Channel' },
              contentDetails: { duration: opts.youtube.durationIso },
            },
          ],
        }),
        { status: 200 },
      );
    }

    if (u.includes('accounts.spotify.com/api/token')) {
      return new Response(JSON.stringify({ access_token: 'app-token', expires_in: 3600 }), { status: 200 });
    }

    if (u.includes('api.spotify.com/v1/tracks/')) {
      if (!opts.spotify) return new Response('not found', { status: 404 });
      return new Response(
        JSON.stringify({
          uri: 'spotify:track:abc',
          name: opts.spotify.title ?? 'Spotify Track',
          artists: [{ name: 'Artist' }],
          duration_ms: opts.spotify.durationMs ?? 180_000,
        }),
        { status: 200 },
      );
    }

    if (u.includes('api.spotify.com/v1/search')) {
      return new Response(JSON.stringify({ tracks: { items: opts.spotifySearchItems ?? [] } }), { status: 200 });
    }

    throw new Error(`Неожиданный URL в тесте: ${u}`);
  }) as typeof fetch;
}

beforeEach(() => {
  initDb(':memory:');
  resetSpotifyAppTokenCache();
  setRequestsPaused(false);
});

test('сообщение без команды игнорируется', async () => {
  const { replies, unsubscribe } = collectReplies();
  try {
    await handleChatMessage(makeMsg({ text: 'просто привет' }), baseCfg, fakeFetchFactory({ followedDaysAgo: 10 }));
    assert.equal(replies.length, 0);
  } finally {
    unsubscribe();
  }
});

test('не-фолловер получает отказ, ничего не ставится в очередь', async () => {
  const { replies, unsubscribe } = collectReplies();
  try {
    await handleChatMessage(
      makeMsg({ text: '!sr https://youtu.be/dQw4w9WgXcQ' }),
      baseCfg,
      fakeFetchFactory({ followedDaysAgo: null }),
    );
    assert.equal(replies.length, 1);
    assert.match(replies[0], /фолловеры канала от 3 дн/);
    assert.equal(peekNextPending(), undefined);
  } finally {
    unsubscribe();
  }
});

test('фолловер младше порога (1 день < 3 дней) получает отказ', async () => {
  const { replies, unsubscribe } = collectReplies();
  try {
    await handleChatMessage(
      makeMsg({ text: '!sr https://youtu.be/dQw4w9WgXcQ' }),
      baseCfg,
      fakeFetchFactory({ followedDaysAgo: 1 }),
    );
    assert.match(replies[0], /фолловеры канала от 3 дн/);
  } finally {
    unsubscribe();
  }
});

test('невалидная ссылка (не youtube/spotify) — отказ с понятным текстом', async () => {
  const { replies, unsubscribe } = collectReplies();
  try {
    await handleChatMessage(makeMsg({ text: '!sr включи битлз' }), baseCfg, fakeFetchFactory({ followedDaysAgo: 10 }));
    assert.match(replies[0], /ссылка невалидная/);
    assert.equal(peekNextPending(), undefined);
  } finally {
    unsubscribe();
  }
});

test('валидный youtube-заказ ставится в очередь и подтверждается в чат', async () => {
  const { replies, unsubscribe } = collectReplies();
  try {
    await handleChatMessage(
      makeMsg({ text: '!sr https://youtu.be/dQw4w9WgXcQ' }),
      baseCfg,
      fakeFetchFactory({ followedDaysAgo: 10, youtube: { durationIso: 'PT3M0S', title: 'Cool video' } }),
    );
    assert.match(replies[0], /трек добавлен в очередь.*Cool video.*позиция 1/s);
    const queued = peekNextPending();
    assert.equal(queued?.provider, 'youtube');
    assert.equal(queued?.title, 'Cool video');
  } finally {
    unsubscribe();
  }
});

test('youtube-заказ длиннее 10 минут — невалиден', async () => {
  const { replies, unsubscribe } = collectReplies();
  try {
    await handleChatMessage(
      makeMsg({ text: '!sr https://youtu.be/dQw4w9WgXcQ' }),
      baseCfg,
      fakeFetchFactory({ followedDaysAgo: 10, youtube: { durationIso: 'PT10M1S' } }),
    );
    assert.match(replies[0], /ссылка невалидная.*длиннее 10 мин/s);
    assert.equal(peekNextPending(), undefined);
  } finally {
    unsubscribe();
  }
});

test('youtube-заказ ровно 10 минут — валиден (граница включительно)', async () => {
  const { replies, unsubscribe } = collectReplies();
  try {
    await handleChatMessage(
      makeMsg({ text: '!sr https://youtu.be/dQw4w9WgXcQ' }),
      baseCfg,
      fakeFetchFactory({ followedDaysAgo: 10, youtube: { durationIso: 'PT10M0S' } }),
    );
    assert.match(replies[0], /трек добавлен в очередь/);
  } finally {
    unsubscribe();
  }
});

test('валидный spotify-заказ ставится в очередь и подтверждается в чат — с исполнителем ("Исполнитель - Название")', async () => {
  const { replies, unsubscribe } = collectReplies();
  try {
    await handleChatMessage(
      makeMsg({ text: '!sr https://open.spotify.com/track/6habFhsOp2NvshLv26DqMb' }),
      baseCfg,
      // fakeFetchFactory всегда подставляет artists: [{ name: 'Artist' }] (см. ниже)
      fakeFetchFactory({ followedDaysAgo: 10, spotify: { title: 'Cool track' } }),
    );
    assert.match(replies[0], /трек добавлен в очередь: "Artist - Cool track" \(позиция 1\)/);
    const queued = peekNextPending();
    assert.equal(queued?.provider, 'spotify');
  } finally {
    unsubscribe();
  }
});

test('вторая заявка встаёт в очередь на позицию 2 — без приоритетов, строго по порядку', async () => {
  const { unsubscribe } = collectReplies();
  try {
    const fetchImpl = fakeFetchFactory({ followedDaysAgo: 10, youtube: { durationIso: 'PT2M0S' } });
    await handleChatMessage(makeMsg({ text: '!sr https://youtu.be/aaaaaaaaaaa' }), baseCfg, fetchImpl);

    const { replies: replies2, unsubscribe: unsub2 } = collectReplies();
    try {
      await handleChatMessage(makeMsg({ text: '!sr https://youtu.be/bbbbbbbbbbb' }), baseCfg, fetchImpl);
      assert.match(replies2[0], /позиция 2/);
    } finally {
      unsub2();
    }
  } finally {
    unsubscribe();
  }
});

test('broadcaster может заказывать музыку даже без фолловинга (сам себя фолловить не может)', async () => {
  const { replies, unsubscribe } = collectReplies();
  try {
    await handleChatMessage(
      makeMsg({ text: '!sr https://youtu.be/dQw4w9WgXcQ', isBroadcaster: true }),
      baseCfg,
      // followedDaysAgo: null — как и должно быть у broadcaster'а, он не фолловер
      fakeFetchFactory({ followedDaysAgo: null, youtube: { durationIso: 'PT3M0S', title: 'Cool video' } }),
    );
    assert.match(replies[0], /трек добавлен в очередь.*Cool video.*позиция 1/s);
    const queued = peekNextPending();
    assert.equal(queued?.provider, 'youtube');
  } finally {
    unsubscribe();
  }
});

test('broadcaster: проверка фолловера не вызывается вовсе (даже без сети запрос проходит)', async () => {
  const { replies, unsubscribe } = collectReplies();
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes('api.twitch.tv/helix/channels/followers')) {
      throw new Error('checkFollowerEligibility не должен вызываться для broadcaster');
    }
    if (u.includes('googleapis.com/youtube/v3/videos')) {
      return new Response(
        JSON.stringify({
          items: [{ snippet: { title: 'Video', channelTitle: 'Ch' }, contentDetails: { duration: 'PT1M0S' } }],
        }),
        { status: 200 },
      );
    }
    throw new Error(`Неожиданный URL в тесте: ${u}`);
  }) as typeof fetch;

  try {
    await handleChatMessage(
      makeMsg({ text: '!sr https://youtu.be/dQw4w9WgXcQ', isBroadcaster: true }),
      baseCfg,
      fetchImpl,
    );
    assert.match(replies[0], /трек добавлен в очередь/);
  } finally {
    unsubscribe();
  }
});

test('Spotify не настроен — ссылка на Spotify отклоняется понятным сообщением, ничего не заказывается', async () => {
  const { replies, unsubscribe } = collectReplies();
  try {
    await handleChatMessage(
      makeMsg({ text: '!sr https://open.spotify.com/track/6habFhsOp2NvshLv26DqMb' }),
      noSpotifyCfg,
      fakeFetchFactory({ followedDaysAgo: 10 }),
    );
    assert.match(replies[0], /Spotify.*недоступен/s);
    assert.equal(peekNextPending(), undefined);
  } finally {
    unsubscribe();
  }
});

test('YouTube не настроен — ссылка на YouTube отклоняется, подсказка не упоминает YouTube', async () => {
  const { replies, unsubscribe } = collectReplies();
  try {
    const noYoutubeCfg: RequestHandlerConfig = { ...baseCfg, youtubeApiKey: undefined };
    const fetchImpl = fakeFetchFactory({ followedDaysAgo: 10, youtube: { durationIso: 'PT3M' } });
    await handleChatMessage(makeMsg({ text: '!sr https://youtu.be/dQw4w9WgXcQ' }), noYoutubeCfg, fetchImpl);
    await handleChatMessage(makeMsg({ text: '!sr' }), noYoutubeCfg, fetchImpl);
    assert.match(replies[0], /YouTube.*недоступен/s);
    assert.doesNotMatch(replies[1], /YouTube/);
    assert.equal(peekNextPending(), undefined);
  } finally {
    unsubscribe();
  }
});

test('Spotify не настроен — YouTube-заказы всё равно работают', async () => {
  const { replies, unsubscribe } = collectReplies();
  try {
    await handleChatMessage(
      makeMsg({ text: '!sr https://youtu.be/dQw4w9WgXcQ' }),
      noSpotifyCfg,
      fakeFetchFactory({ followedDaysAgo: 10, youtube: { durationIso: 'PT3M0S', title: 'Cool video' } }),
    );
    assert.match(replies[0], /трек добавлен в очередь.*Cool video/s);
  } finally {
    unsubscribe();
  }
});

test('текстовый запрос трека в Spotify — единственный результат заказывается', async () => {
  const { replies, unsubscribe } = collectReplies();
  try {
    await handleChatMessage(
      makeMsg({ text: '!sr Never Gonna Give You Up' }),
      baseCfg,
      fakeFetchFactory({
        followedDaysAgo: 10,
        spotifySearchItems: [
          {
            id: 'abc123',
            uri: 'spotify:track:abc123',
            name: 'Never Gonna Give You Up',
            artists: [{ name: 'Rick Astley' }],
            duration_ms: 213_000,
          },
        ],
      }),
    );
    assert.match(replies[0], /трек добавлен в очередь: "Rick Astley - Never Gonna Give You Up" \(позиция 1\)/);
    const queued = peekNextPending();
    assert.equal(queued?.provider, 'spotify');
    assert.equal(queued?.title, 'Never Gonna Give You Up');
  } finally {
    unsubscribe();
  }
});

test('текстовый запрос трека — несколько результатов поиска — заказывается первый (самый релевантный по Spotify)', async () => {
  const { replies, unsubscribe } = collectReplies();
  try {
    await handleChatMessage(
      makeMsg({ text: '!sr Yesterday' }),
      baseCfg,
      fakeFetchFactory({
        followedDaysAgo: 10,
        spotifySearchItems: [
          { id: '1', uri: 'spotify:track:1', name: 'Yesterday', artists: [{ name: 'The Beatles' }], duration_ms: 125_000 },
          { id: '2', uri: 'spotify:track:2', name: 'Yesterday', artists: [{ name: 'Cover Band' }], duration_ms: 130_000 },
        ],
      }),
    );
    assert.match(replies[0], /трек добавлен в очередь: "The Beatles - Yesterday" \(позиция 1\)/);
    const queued = peekNextPending();
    assert.equal(queued?.provider, 'spotify');
    assert.equal(queued?.author, 'The Beatles');
  } finally {
    unsubscribe();
  }
});

test('текстовый запрос трека — нет совпадений в Spotify — отказ, упоминающий возможность текстового поиска', async () => {
  const { replies, unsubscribe } = collectReplies();
  try {
    await handleChatMessage(
      makeMsg({ text: '!sr совершенно случайный несуществующий трек 12345' }),
      baseCfg,
      fakeFetchFactory({ followedDaysAgo: 10, spotifySearchItems: [] }),
    );
    assert.match(replies[0], /ссылка невалидная.*название трека для поиска в Spotify/s);
  } finally {
    unsubscribe();
  }
});

test('заказы приостановлены (!pr) — заказ отклоняется понятным сообщением, ничего не ставится в очередь', async () => {
  const { replies, unsubscribe } = collectReplies();
  setRequestsPaused(true);
  try {
    await handleChatMessage(
      makeMsg({ text: '!sr https://youtu.be/dQw4w9WgXcQ' }),
      baseCfg,
      fakeFetchFactory({ followedDaysAgo: 10, youtube: { durationIso: 'PT3M0S', title: 'Cool video' } }),
    );
    assert.equal(replies.length, 1);
    assert.match(replies[0], /заказы музыки сейчас недоступны/);
    assert.equal(peekNextPending(), undefined);
  } finally {
    unsubscribe();
    setRequestsPaused(false);
  }
});

test('registerMusicRequestHandler подключает обработчик к eventBus', async () => {
  const { replies, unsubscribe } = collectReplies();
  try {
    registerMusicRequestHandler(baseCfg, fakeFetchFactory({ followedDaysAgo: null }));
    eventBus.emit('chat.message', makeMsg({ text: '!sr https://youtu.be/dQw4w9WgXcQ' }));
    // обработчик асинхронный (await внутри) — даём event loop прокрутиться
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(replies.length, 1);
    assert.match(replies[0], /фолловеры канала от 3 дн/);
  } finally {
    unsubscribe();
  }
});
