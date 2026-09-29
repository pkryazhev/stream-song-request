import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { eventBus } from '../src/core/eventBus.ts';
import { handleChatMessage, type RequestHandlerConfig } from '../src/music/requestHandler.ts';
import { initDb } from '../src/db/index.ts';
import { peekNextPending } from '../src/db/musicQueue.ts';
import { setRequestsPaused } from '../src/music/requestsGate.ts';
import {
  buildYandexDirectUrl,
  fetchYandexTrackDetails,
  resolveYandexStreamUrl,
  parseYandexPlayUri,
  computeLoudnessGainDb,
  resolveYandexPlayback,
} from '../src/music/yandexMusicProvider.ts';
import { playYandexTrack, buildMpvUrlArgs } from '../src/music/yandexPlayer.ts';
import type { PlaybackSession } from '../src/music/youtubePlayer.ts';

const cfg: RequestHandlerConfig = {
  commandName: '!sr',
  minFollowerDays: 0,
  maxYoutubeDurationSec: 600,
  youtubeApiKey: 'yt-key',
  yandex: { token: 'ya-token' },
  twitchClientId: 'tw-cid',
  twitchBroadcasterId: 'broadcaster-1',
  getTwitchAccessToken: async () => 'mod-token',
};

const TRACK_JSON = {
  id: '38633712',
  title: 'Группа крови',
  durationMs: 235_100,
  available: true,
  artists: [{ name: 'КИНО' }],
};

function fakeYandexFetch(opts: { track?: object | null; fullDownload?: boolean }): {
  fetchImpl: typeof fetch;
  yandexAuthHeaders: Array<string | null>;
} {
  const yandexAuthHeaders: Array<string | null> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);

    if (u.includes('api.twitch.tv/helix/channels/followers')) {
      return new Response(JSON.stringify({ data: [{ followed_at: '2020-01-01T00:00:00Z' }] }), { status: 200 });
    }

    yandexAuthHeaders.push(new Headers(init?.headers).get('Authorization'));

    if (u.endsWith('/download-info')) {
      return new Response(
        JSON.stringify({
          result: [
            { codec: 'mp3', preview: true, bitrateInKbps: 128, downloadInfoUrl: 'https://storage.test/preview?sign=x' },
            ...(opts.fullDownload
              ? [
                  { codec: 'mp3', preview: false, bitrateInKbps: 192, downloadInfoUrl: 'https://storage.test/full192?sign=x' },
                  { codec: 'mp3', preview: false, bitrateInKbps: 320, downloadInfoUrl: 'https://storage.test/full320?sign=x' },
                ]
              : []),
          ],
        }),
        { status: 200 },
      );
    }
    if (u.startsWith('https://storage.test/full320')) {
      assert.match(u, /format=json/);
      return new Response(JSON.stringify({ host: 'cdn.test', path: '/rmusic/abc/def', ts: '0001', s: 'salt' }), {
        status: 200,
      });
    }
    if (u.includes('api.music.yandex.net/tracks/')) {
      if (opts.track === null) return new Response('{"error":{}}', { status: 400 });
      return new Response(JSON.stringify({ result: [opts.track ?? TRACK_JSON] }), { status: 200 });
    }
    throw new Error(`Неожиданный запрос в тесте: ${u}`);
  }) as typeof fetch;
  return { fetchImpl, yandexAuthHeaders };
}

function collectReplies(): { replies: string[]; unsubscribe: () => void } {
  const replies: string[] = [];
  const listener = ({ text }: { text: string }): void => {
    replies.push(text);
  };
  eventBus.on('chat.reply', listener);
  return { replies, unsubscribe: () => eventBus.off('chat.reply', listener) };
}

const msg = (text: string) => ({
  userId: 'viewer-1',
  login: 'viewer1',
  displayName: 'Viewer1',
  text,
  isModerator: false,
  isBroadcaster: false,
});

beforeEach(() => {
  initDb(':memory:');
  setRequestsPaused(false);
});

test('fetchYandexTrackDetails: исполнители через запятую, версия в скобках, длительность в секундах', async () => {
  const { fetchImpl } = fakeYandexFetch({
    track: {
      ...TRACK_JSON,
      version: 'Remastered',
      artists: [{ name: 'A' }, { name: 'B' }],
      r128: { i: -11.4, tp: -1.09 },
    },
  });
  const details = await fetchYandexTrackDetails('38633712', undefined, fetchImpl);
  assert.deepEqual(details, {
    trackId: '38633712',
    title: 'Группа крови (Remastered)',
    artist: 'A, B',
    durationSec: 235,
    available: true,
    loudness: { integratedLufs: -11.4, truePeakDb: -1.09 },
  });
});

test('computeLoudnessGainDb: громкий трек приглушается до цели', () => {
  assert.equal(computeLoudnessGainDb({ integratedLufs: -11.4, truePeakDb: -1.09 }, -14), -2.6);
});

test('computeLoudnessGainDb: тихий трек поднимается, но пик не выше -1 дБ', () => {
  // Нужно +6 дБ, но пик -4 дБ позволяет только +3.
  assert.equal(computeLoudnessGainDb({ integratedLufs: -20, truePeakDb: -4 }, -14), 3);
  // Пик уже выше -1 дБ — не поднимаем вовсе.
  assert.equal(computeLoudnessGainDb({ integratedLufs: -20, truePeakDb: -0.5 }, -14), 0);
  // Запаса хватает — поднимаем полностью.
  assert.equal(computeLoudnessGainDb({ integratedLufs: -16, truePeakDb: -6 }, -14), 2);
});

test('resolveYandexPlayback: ссылка + поправка из r128; выравнивание выключено — без поправки', async () => {
  const { fetchImpl } = fakeYandexFetch({ fullDownload: true, track: { ...TRACK_JSON, r128: { i: -11.4, tp: -1.09 } } });
  const on = await resolveYandexPlayback('38633712', 'ya-token', -14, fetchImpl);
  assert.equal(on.gainDb, -2.6);
  assert.match(on.streamUrl, /^https:\/\/cdn\.test\/get-mp3\//);
  const off = await resolveYandexPlayback('38633712', 'ya-token', null, fetchImpl);
  assert.equal(off.gainDb, undefined);
});

test('resolveYandexPlayback: Яндекс не отдал r128 — играем без поправки', async () => {
  const { fetchImpl } = fakeYandexFetch({ fullDownload: true });
  assert.equal((await resolveYandexPlayback('38633712', 'ya-token', -14, fetchImpl)).gainDb, undefined);
});

test('fetchYandexTrackDetails: несуществующий трек (HTTP 400) — null', async () => {
  const { fetchImpl } = fakeYandexFetch({ track: null });
  assert.equal(await fetchYandexTrackDetails('1', undefined, fetchImpl), null);
});

test('buildYandexDirectUrl подписывает путь md5(соль + path без "/" + s)', () => {
  const url = buildYandexDirectUrl({ host: 'cdn.test', path: '/rmusic/abc', ts: '0001', s: 'salt' });
  const sign = createHash('md5').update('XGRlBW9FXlekgbPrRHuSiA' + 'rmusic/abc' + 'salt').digest('hex');
  assert.equal(url, `https://cdn.test/get-mp3/${sign}/0001/rmusic/abc`);
});

test('resolveYandexStreamUrl берёт полный mp3 с максимальным битрейтом и шлёт OAuth-токен', async () => {
  const { fetchImpl, yandexAuthHeaders } = fakeYandexFetch({ fullDownload: true });
  const url = await resolveYandexStreamUrl('38633712', 'ya-token', fetchImpl);
  assert.match(url, /^https:\/\/cdn\.test\/get-mp3\/[0-9a-f]{32}\/0001\/rmusic\/abc\/def$/);
  assert.ok(yandexAuthHeaders.every((h) => h === 'OAuth ya-token'));
});

test('resolveYandexStreamUrl: доступно только превью — ошибка', async () => {
  const { fetchImpl } = fakeYandexFetch({ fullDownload: false });
  await assert.rejects(resolveYandexStreamUrl('38633712', 'ya-token', fetchImpl), /только превью/);
});

test('заказ по ссылке Яндекс Музыки ставится в очередь как yandex:track:<id>', async () => {
  const { replies, unsubscribe } = collectReplies();
  try {
    const { fetchImpl } = fakeYandexFetch({ fullDownload: true });
    await handleChatMessage(msg('!sr https://music.yandex.ru/album/5307396/track/38633712'), cfg, fetchImpl);
    assert.equal(replies[0], '@Viewer1 трек добавлен в очередь: "КИНО - Группа крови" (позиция 1)');
    const queued = peekNextPending();
    assert.equal(queued?.provider, 'yandex');
    assert.equal(parseYandexPlayUri(queued!.playUri), '38633712');
  } finally {
    unsubscribe();
  }
});

test('трек Яндекс Музыки без полного доступа (нет Плюса) — отказ, в очередь не попадает', async () => {
  const { replies, unsubscribe } = collectReplies();
  try {
    const { fetchImpl } = fakeYandexFetch({ fullDownload: false });
    await handleChatMessage(msg('!sr https://music.yandex.ru/track/38633712'), cfg, fetchImpl);
    assert.match(replies[0], /недоступен для прослушивания/);
    assert.equal(peekNextPending(), undefined);
  } finally {
    unsubscribe();
  }
});

test('Яндекс Музыка не настроена — ссылка отклоняется', async () => {
  const { replies, unsubscribe } = collectReplies();
  try {
    const { fetchImpl } = fakeYandexFetch({ fullDownload: true });
    await handleChatMessage(msg('!sr https://music.yandex.ru/track/38633712'), { ...cfg, yandex: undefined }, fetchImpl);
    assert.match(replies[0], /Яндекс Музыку сейчас недоступен/);
    assert.equal(peekNextPending(), undefined);
  } finally {
    unsubscribe();
  }
});

test('buildMpvUrlArgs: громкость, устройство, поправка громкости, без видео, ссылка последней', () => {
  assert.deepEqual(
    buildMpvUrlArgs({ streamUrl: 'https://x/y.mp3', gainDb: -2.6 }, { volume: 40, audioDevice: 'wasapi/abc' }),
    ['--volume=40', '--audio-device=wasapi/abc', '--af=lavfi=[volume=-2.6dB]', '--no-video', 'https://x/y.mp3'],
  );
});

test('buildMpvUrlArgs: нет поправки (или она нулевая) — фильтр не добавляется', () => {
  assert.deepEqual(buildMpvUrlArgs({ streamUrl: 'https://x/y.mp3' }, {}), ['--no-video', 'https://x/y.mp3']);
  assert.deepEqual(buildMpvUrlArgs({ streamUrl: 'https://x/y.mp3', gainDb: 0 }, {}), ['--no-video', 'https://x/y.mp3']);
});

test('playYandexTrack запускает mpv с полученной ссылкой и ждёт его завершения', async () => {
  const spawned: string[][] = [];
  const session = playYandexTrack(async () => ({ streamUrl: 'https://x/y.mp3' }), 'mpv', {}, (cmd, args) => {
    spawned.push([cmd, ...args]);
    return { finished: Promise.resolve(), stop: () => {} };
  });
  await session.finished;
  assert.deepEqual(spawned, [['mpv', '--no-video', 'https://x/y.mp3']]);
});

test('playYandexTrack: скип до того, как ссылка получена — mpv не запускается', async () => {
  let resolvePlayback!: (playback: { streamUrl: string }) => void;
  let spawnedCount = 0;
  const session = playYandexTrack(
    () => new Promise<{ streamUrl: string }>((r) => (resolvePlayback = r)),
    'mpv',
    {},
    (): PlaybackSession => {
      spawnedCount++;
      return { finished: Promise.resolve(), stop: () => {} };
    },
  );
  session.stop();
  resolvePlayback({ streamUrl: 'https://x/y.mp3' });
  await session.finished;
  assert.equal(spawnedCount, 0);
});

test('playYandexTrack: скип во время воспроизведения останавливает mpv', async () => {
  let stopped = false;
  let finishMpv!: () => void;
  const session = playYandexTrack(async () => ({ streamUrl: 'https://x/y.mp3' }), 'mpv', {}, () => ({
    finished: new Promise<void>((r) => (finishMpv = r)),
    stop: () => {
      stopped = true;
      finishMpv();
    },
  }));
  await new Promise((r) => setImmediate(r));
  session.stop();
  await session.finished;
  assert.equal(stopped, true);
});
