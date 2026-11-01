import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb } from '../src/db/index.ts';
import { peekNextPending } from '../src/db/musicQueue.ts';
import { processSongRequest, type RequestHandlerConfig } from '../src/music/requestHandler.ts';
import { handleRedemption } from '../src/music/pointsRequestHandler.ts';
import { looksLikeRequestLink } from '../src/music/linkParser.ts';
import { setRequestsPaused } from '../src/music/requestsGate.ts';
import { resetSpotifyAppTokenCache } from '../src/music/spotifyAuth.ts';

const cfg: RequestHandlerConfig = {
  commandName: '!sr', minFollowerDays: 0, maxYoutubeDurationSec: 600,
  spotify: { clientId: 'id', clientSecret: 'secret' }, yandex: { token: 'token' },
  textSearchProvider: 'yandex', twitchClientId: 'id', twitchBroadcasterId: 'owner',
  getTwitchAccessToken: async () => 'token',
};
const requester = { userId: 'owner', login: 'owner', displayName: 'Owner', isBroadcaster: true };
const options = { requireFollower: false, emptyArgHint: 'укажи трек' };
beforeEach(() => { initDb(':memory:'); setRequestsPaused(false); resetSpotifyAppTokenCache(); });

function mockSearch(mode: 'full' | 'preview' | 'unavailable' | 'empty' | 'error' = 'full') {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    if (url.hostname === 'accounts.spotify.com') return Response.json({ access_token: 'token', expires_in: 3600 });
    if (url.hostname === 'api.spotify.com') return Response.json({ tracks: { items: [
      { id: 'sp1', uri: 'spotify:track:sp1', name: 'Song', artists: [{ name: 'Artist' }], duration_ms: 120000 },
    ] } });
    assert.equal(new Headers(init?.headers).get('Authorization'), 'OAuth token');
    if (url.pathname === '/search') {
      assert.equal(url.searchParams.get('type'), 'track');
      assert.equal(url.searchParams.get('nocorrect'), 'false');
      assert.equal(url.searchParams.get('text'), 'Кино группа крови');
      if (mode === 'error') return new Response('', { status: 503 });
      return Response.json({ result: { tracks: { results: mode === 'empty' ? [] : [{ id: 123 }, { id: 456 }] } } });
    }
    if (url.pathname === '/tracks/123') return Response.json({ result: [
      { id: 123, title: 'Группа крови', artists: [{ name: 'Кино' }], durationMs: 120000, available: mode !== 'unavailable' },
    ] });
    if (url.pathname === '/tracks/123/download-info') return Response.json({ result: [
      { codec: 'mp3', preview: mode === 'preview', bitrateInKbps: 320, downloadInfoUrl: 'https://audio.test' },
    ] });
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test('Яндекс выбран при включённых обоих сервисах; первый трек проверяется до очереди', async () => {
  const { calls, fetchImpl } = mockSearch();
  const result = await processSongRequest(requester, 'Кино группа крови', cfg, options, fetchImpl);
  assert.equal(result.provider, 'yandex');
  assert.equal(peekNextPending()?.externalId, '123');
  assert.equal(calls.length, 3);
});

for (const mode of ['preview', 'unavailable', 'empty'] as const) {
  test(`Яндекс ${mode}: отказ без очереди и перехода в Spotify`, async () => {
    const { calls, fetchImpl } = mockSearch(mode);
    const result = await processSongRequest(requester, 'Кино группа крови', cfg, options, fetchImpl);
    assert.equal(result.queued, false);
    assert.equal(peekNextPending(), undefined);
    assert.ok(calls.every(url => url.includes('api.music.yandex.net')));
  });
}

test('Spotify выбран при включённых обоих сервисах', async () => {
  const { calls, fetchImpl } = mockSearch();
  const result = await processSongRequest(requester, 'Song', { ...cfg, textSearchProvider: 'spotify' }, options, fetchImpl);
  assert.equal(result.provider, 'spotify');
  assert.ok(calls.every(url => !url.includes('yandex')));
});

test('без дефолтного источника: один сервис ищет, два требуют ссылку', async () => {
  const { fetchImpl } = mockSearch();
  const ambiguous = await processSongRequest(requester, 'Кино группа крови', { ...cfg, textSearchProvider: undefined }, options, fetchImpl);
  assert.equal(ambiguous.queued, false);
  const single = await processSongRequest(requester, 'Кино группа крови', { ...cfg, spotify: undefined, textSearchProvider: undefined }, options, fetchImpl);
  assert.equal(single.provider, 'yandex');
});

test('адреса и повреждённые ссылки не запускают поиск', async () => {
  for (const arg of ['https://example.com/song', 'music.yandex.ru/track/123', 'www.example.com', 'https:/broken', 'spotify:album:123', 'https://music.yandex.ru/album/123']) {
    assert.equal(looksLikeRequestLink(arg), true, arg);
    const result = await processSongRequest(requester, arg, cfg, options, (async () => { throw new Error('Сеть не ожидается'); }) as typeof fetch);
    assert.equal(result.queued, false);
  }
  assert.equal(looksLikeRequestLink('Кино группа крови'), false);
});

for (const mode of ['full', 'preview', 'empty', 'error'] as const) {
  test(`заказ за баллы ${mode}: подтверждение при старте или возврат при отказе`, async () => {
    const statuses: string[] = [];
    const { fetchImpl } = mockSearch(mode);
    await handleRedemption({ redemptionId: 'red', rewardId: 'reward', rewardTitle: 'Музыка', userId: 'viewer', userLogin: 'viewer', userName: 'Viewer', userInput: 'Кино группа крови' }, {
      request: cfg,
      setRedemptionStatus: async (_, status) => { statuses.push(status); },
    }, fetchImpl);
    assert.deepEqual(statuses, mode === 'full' ? [] : ['CANCELED']);
    assert.equal(peekNextPending()?.provider, mode === 'full' ? 'yandex' : undefined);
  });
}
