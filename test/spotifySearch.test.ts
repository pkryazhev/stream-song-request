import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchSpotifyTrackByText } from '../src/music/spotifySearch.ts';
import { resetSpotifyAppTokenCache } from '../src/music/spotifyAuth.ts';

interface RawItem {
  id: string;
  uri: string;
  name: string;
  artists: Array<{ name: string }>;
  duration_ms: number;
}

function fakeFetchFactory(items: RawItem[]): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.includes('accounts.spotify.com')) {
      return new Response(JSON.stringify({ access_token: 'app-token', expires_in: 3600 }), { status: 200 });
    }
    if (u.includes('api.spotify.com/v1/search')) {
      // limit=1 в реальном запросе и так просит у Spotify только один
      // результат — здесь просто отдаём то, что передали в тест.
      return new Response(JSON.stringify({ tracks: { items } }), { status: 200 });
    }
    throw new Error(`Неожиданный URL в тесте: ${u}`);
  }) as typeof fetch;
}

test('единственный результат — возвращает трек', async () => {
  resetSpotifyAppTokenCache();
  const details = await searchSpotifyTrackByText(
    'Bohemian Rhapsody',
    'cid',
    'secret',
    fakeFetchFactory([
      { id: '1', uri: 'spotify:track:1', name: 'Bohemian Rhapsody', artists: [{ name: 'Queen' }], duration_ms: 355_000 },
    ]),
  );
  assert.ok(details);
  assert.equal(details?.trackId, '1');
  assert.equal(details?.title, 'Bohemian Rhapsody');
  assert.equal(details?.artist, 'Queen');
});

test('несколько результатов от Spotify — берётся первый (самый релевантный по мнению самого Spotify), а не "точное" совпадение', async () => {
  resetSpotifyAppTokenCache();
  const details = await searchSpotifyTrackByText(
    'Yesterday',
    'cid',
    'secret',
    fakeFetchFactory([
      { id: '1', uri: 'spotify:track:1', name: 'Yesterday', artists: [{ name: 'The Beatles' }], duration_ms: 125_000 },
      { id: '2', uri: 'spotify:track:2', name: 'Yesterday', artists: [{ name: 'Cover Band' }], duration_ms: 130_000 },
    ]),
  );
  assert.ok(details);
  assert.equal(details?.trackId, '1');
});

test('запрос, не совпадающий точь-в-точь с названием (например неполное название) — всё равно берётся первый найденный результат', async () => {
  resetSpotifyAppTokenCache();
  const details = await searchSpotifyTrackByText(
    'Bohemian',
    'cid',
    'secret',
    fakeFetchFactory([
      { id: '1', uri: 'spotify:track:1', name: 'Bohemian Rhapsody', artists: [{ name: 'Queen' }], duration_ms: 355_000 },
    ]),
  );
  assert.ok(details);
  assert.equal(details?.trackId, '1');
});

test('пустой результат поиска — null', async () => {
  resetSpotifyAppTokenCache();
  const details = await searchSpotifyTrackByText('что-то несуществующее', 'cid', 'secret', fakeFetchFactory([]));
  assert.equal(details, null);
});

test('пустой запрос — null, без обращения к сети', async () => {
  resetSpotifyAppTokenCache();
  const fetchImpl = (async () => {
    throw new Error('не должно вызываться для пустого запроса');
  }) as typeof fetch;
  const details = await searchSpotifyTrackByText('   ', 'cid', 'secret', fetchImpl);
  assert.equal(details, null);
});

test('HTTP-ошибка от Spotify API пробрасывается наружу', async () => {
  resetSpotifyAppTokenCache();
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes('accounts.spotify.com')) {
      return new Response(JSON.stringify({ access_token: 'app-token', expires_in: 3600 }), { status: 200 });
    }
    return new Response('server error', { status: 500 });
  }) as typeof fetch;
  await assert.rejects(() => searchSpotifyTrackByText('запрос', 'cid', 'secret', fetchImpl), /HTTP 500/);
});
