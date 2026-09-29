import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYandexPlaylistUrl, fetchYandexPlaylistTracks } from '../src/music/yandexPlaylist.ts';

test('parseYandexPlaylistUrl: ссылка "Поделиться" с utm-хвостом', () => {
  assert.deepEqual(
    parseYandexPlaylistUrl(
      'https://music.yandex.ru/playlists/bbe860b2-e226-67c4-987f-e196f649047c?utm_source=web&utm_medium=copy_link',
    ),
    { uuid: 'bbe860b2-e226-67c4-987f-e196f649047c' },
  );
});

test('parseYandexPlaylistUrl: старый формат /users/<владелец>/playlists/<kind> и голый uuid', () => {
  assert.deepEqual(parseYandexPlaylistUrl('https://music.yandex.ru/users/music-blog/playlists/2127'), {
    owner: 'music-blog',
    kind: '2127',
  });
  assert.deepEqual(parseYandexPlaylistUrl('bbe860b2-e226-67c4-987f-e196f649047c'), {
    uuid: 'bbe860b2-e226-67c4-987f-e196f649047c',
  });
});

test('parseYandexPlaylistUrl: не плейлист — null', () => {
  assert.equal(parseYandexPlaylistUrl('https://music.yandex.ru/album/5307396/track/38633712'), null);
  assert.equal(parseYandexPlaylistUrl('https://open.spotify.com/playlist/abc'), null);
  assert.equal(parseYandexPlaylistUrl('просто текст'), null);
});

const REF = { uuid: 'bbe860b2-e226-67c4-987f-e196f649047c' };

test('fetchYandexPlaylistTracks: треки в порядке плейлиста, без недоступных и без неполных записей', async () => {
  let url = '';
  let auth: string | null = null;
  const fetchImpl = (async (u: string | URL, init?: RequestInit) => {
    url = String(u);
    auth = new Headers(init?.headers).get('Authorization');
    return new Response(
      JSON.stringify({
        result: {
          tracks: [
            { id: 1, track: { id: '1', title: 'One', version: 'Live', durationMs: 180_400, artists: [{ name: 'A' }, { name: 'B' }] } },
            { id: 2, track: { id: '2', title: 'Two', available: false, artists: [] } },
            { id: 3 },
            { id: 4, track: { id: 4, title: 'Four', durationMs: 1000, artists: [{ name: 'C' }] } },
          ],
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  const tracks = await fetchYandexPlaylistTracks(REF, 'ya-token', fetchImpl);

  assert.equal(url, 'https://api.music.yandex.net/playlist/bbe860b2-e226-67c4-987f-e196f649047c');
  assert.equal(auth, 'OAuth ya-token');
  assert.deepEqual(tracks, [
    { provider: 'yandex', playUri: 'yandex:track:1', title: 'One (Live)', author: 'A, B', durationSec: 180 },
    { provider: 'yandex', playUri: 'yandex:track:4', title: 'Four', author: 'C', durationSec: 1 },
  ]);
});

test('fetchYandexPlaylistTracks: старый формат ссылки и ошибка HTTP', async () => {
  let url = '';
  const fetchImpl = (async (u: string | URL) => {
    url = String(u);
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  await assert.rejects(fetchYandexPlaylistTracks({ owner: 'music-blog', kind: '2127' }, 't', fetchImpl), /HTTP 404/);
  assert.equal(url, 'https://api.music.yandex.net/users/music-blog/playlists/2127');
});
