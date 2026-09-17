import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSpotifyTrackDetails, SpotifyPlaybackController } from '../src/music/spotifyProvider.ts';
import { resetSpotifyAppTokenCache } from '../src/music/spotifyAuth.ts';

test('fetchSpotifyTrackDetails возвращает метаданные трека', async () => {
  resetSpotifyAppTokenCache();
  const fakeFetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes('accounts.spotify.com')) {
      return new Response(JSON.stringify({ access_token: 'app-token', expires_in: 3600 }), { status: 200 });
    }
    if (u.includes('api.spotify.com/v1/tracks/')) {
      return new Response(
        JSON.stringify({
          uri: 'spotify:track:6habFhsOp2NvshLv26DqMb',
          name: 'Test Track',
          artists: [{ name: 'Artist A' }, { name: 'Artist B' }],
          duration_ms: 210000,
        }),
        { status: 200 },
      );
    }
    throw new Error(`Неожиданный URL: ${u}`);
  }) as typeof fetch;

  const details = await fetchSpotifyTrackDetails('6habFhsOp2NvshLv26DqMb', 'cid', 'secret', fakeFetch);
  assert.ok(details);
  assert.equal(details?.uri, 'spotify:track:6habFhsOp2NvshLv26DqMb');
  assert.equal(details?.title, 'Test Track');
  assert.equal(details?.artist, 'Artist A, Artist B');
  assert.equal(details?.durationMs, 210000);
});

test('fetchSpotifyTrackDetails возвращает null для 404', async () => {
  resetSpotifyAppTokenCache();
  const fakeFetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes('accounts.spotify.com')) {
      return new Response(JSON.stringify({ access_token: 'app-token', expires_in: 3600 }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const details = await fetchSpotifyTrackDetails('doesnotexist', 'cid', 'secret', fakeFetch);
  assert.equal(details, null);
});

test('SpotifyPlaybackController.getCurrentPlayback возвращает null при 204 (ничего не играет)', async () => {
  const fakeUserAuth = { getValidAccessToken: async () => 'user-token' };
  const fakeFetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
  const controller = new SpotifyPlaybackController(fakeUserAuth, fakeFetch);

  const state = await controller.getCurrentPlayback();
  assert.equal(state, null);
});

test('SpotifyPlaybackController.getCurrentPlayback парсит состояние воспроизведения', async () => {
  const fakeUserAuth = { getValidAccessToken: async () => 'user-token' };
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({
        is_playing: true,
        progress_ms: 1000,
        item: {
          duration_ms: 200000,
          uri: 'spotify:track:abc',
          name: 'Track Name',
          artists: [{ name: 'Artist One' }, { name: 'Artist Two' }],
        },
      }),
      { status: 200 },
    )) as typeof fetch;
  const controller = new SpotifyPlaybackController(fakeUserAuth, fakeFetch);

  const state = await controller.getCurrentPlayback();
  assert.deepEqual(state, {
    isPlaying: true,
    progressMs: 1000,
    durationMs: 200000,
    trackUri: 'spotify:track:abc',
    trackTitle: 'Track Name',
    trackArtist: 'Artist One, Artist Two',
  });
});

test('SpotifyPlaybackController.playTrackUri отправляет PUT с нужным телом', async () => {
  const fakeUserAuth = { getValidAccessToken: async () => 'user-token' };
  let capturedBody: unknown;
  let capturedMethod: string | undefined;
  const fakeFetch = (async (_url: string | URL, init?: RequestInit) => {
    capturedMethod = init?.method;
    capturedBody = JSON.parse(String(init?.body));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const controller = new SpotifyPlaybackController(fakeUserAuth, fakeFetch);

  await controller.playTrackUri('spotify:track:xyz');
  assert.equal(capturedMethod, 'PUT');
  assert.deepEqual(capturedBody, { uris: ['spotify:track:xyz'] });
});

test('playTrackUri без 404 бросает обычную ошибку, без подсказки про устройство', async () => {
  const fakeUserAuth = { getValidAccessToken: async () => 'user-token' };
  const fakeFetch = (async () => new Response('server error', { status: 500 })) as typeof fetch;
  const controller = new SpotifyPlaybackController(fakeUserAuth, fakeFetch);

  await assert.rejects(() => controller.playTrackUri('spotify:track:xyz'), (err: Error) => {
    assert.match(err.message, /HTTP 500/);
    assert.doesNotMatch(err.message, /активного устройства/);
    return true;
  });
});

test('playContext при HTTP 404 добавляет понятную подсказку про активное устройство', async () => {
  const fakeUserAuth = { getValidAccessToken: async () => 'user-token' };
  const fakeFetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;
  const controller = new SpotifyPlaybackController(fakeUserAuth, fakeFetch);

  await assert.rejects(
    () => controller.playContext('spotify:playlist:abc'),
    /HTTP 404.*активного устройства.*SPOTIFY_DEVICE_NAME/s,
  );
});

test('listDevices парсит список устройств', async () => {
  const fakeUserAuth = { getValidAccessToken: async () => 'user-token' };
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({
        devices: [
          { id: 'dev-1', name: 'PAVEL-PC', is_active: true },
          { id: 'dev-2', name: 'iPhone', is_active: false },
        ],
      }),
      { status: 200 },
    )) as typeof fetch;
  const controller = new SpotifyPlaybackController(fakeUserAuth, fakeFetch);

  const devices = await controller.listDevices();
  assert.deepEqual(devices, [
    { id: 'dev-1', name: 'PAVEL-PC', isActive: true },
    { id: 'dev-2', name: 'iPhone', isActive: false },
  ]);
});

test('с заданным deviceName playTrackUri сам находит device_id и подставляет его в запрос', async () => {
  const fakeUserAuth = { getValidAccessToken: async () => 'user-token' };
  let capturedUrl: string | undefined;
  const fakeFetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/devices')) {
      return new Response(
        JSON.stringify({
          devices: [
            { id: 'dev-1', name: 'PAVEL-PC', is_active: false },
            { id: 'dev-2', name: 'iPhone', is_active: false },
          ],
        }),
        { status: 200 },
      );
    }
    capturedUrl = u;
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  // регистр не важен — ищем без учёта регистра
  const controller = new SpotifyPlaybackController(fakeUserAuth, fakeFetch, 'pavel-pc');
  await controller.playTrackUri('spotify:track:xyz');

  assert.match(capturedUrl ?? '', /device_id=dev-1/);
});

test('с заданным deviceName, которого нет среди устройств — понятная ошибка со списком доступных', async () => {
  const fakeUserAuth = { getValidAccessToken: async () => 'user-token' };
  const fakeFetch = (async (url: string | URL) => {
    if (String(url).includes('/devices')) {
      return new Response(JSON.stringify({ devices: [{ id: 'dev-2', name: 'iPhone', is_active: false }] }), {
        status: 200,
      });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  const controller = new SpotifyPlaybackController(fakeUserAuth, fakeFetch, 'PAVEL-PC');

  await assert.rejects(() => controller.playTrackUri('spotify:track:xyz'), /PAVEL-PC.*iPhone/s);
});
