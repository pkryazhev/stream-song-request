import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startNowPlayingOverlay } from '../src/overlay/nowPlayingOverlay.ts';

test('control API: local page, protected POST, stale and duplicate skips', async () => {
  let playbackId = 1;
  let canSkip = true;
  let skips = 0;
  let volume = { level: 50, muted: false, supported: true, error: null };
  let volumeTarget: string | undefined;
  let failVolume = false;
  let rating: 'like' | 'dislike' | null = null;
  let yandex = true;
  let spotify = false;
  const server = startNowPlayingOverlay({
    port: 0, getNowPlaying: () => null, spotifyApp: null, getSpotifyPlayback: null, yandexToken: undefined,
    control: {
      spotifyRating: {
        getState: () => spotify ? { rating: null, ready: true, busy: false, error: null } : null,
        set: async () => ({ warning: null }),
      },
      yandexRating: {
        getState: () => yandex ? { rating, ready: true, busy: false, error: null } : null,
        set: async (_id, value) => { rating = value; return { warning: null }; },
      },
      volume: {
        getState: () => ({ ...volume, target: volumeTarget }),
        set: async (level, muted) => {
          await new Promise((resolve) => setImmediate(resolve));
          if (failVolume) throw new Error('Spotify отказал в управлении');
          volume = { ...volume, level, muted };
        },
      },
      getState: () => ({ playbackId, canSkip }),
      skip: (id) => {
        if (id !== playbackId || !canSkip) return false;
        canSkip = false;
        skips++;
        return true;
      },
    },
  });
  if (!server.listening) await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const page = await fetch(`${base}/control`);
    const html = await page.text();
    const token = /const token = '([a-f0-9]{64})'/.exec(html)![1];
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(`${base}/control/skip`)).status, 405);
    assert.equal((await fetch(`${base}/control/skip`, { method: 'POST' })).status, 403);
    assert.equal((await fetch(`${base}/control`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(`${base}/control`, { headers: { Host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.equal(foreignHostStatus, 403);
    const post = (id: string, origin = base) => fetch(`${base}/control/skip`, {
      method: 'POST', headers: { 'X-Control-Token': token, 'X-Playback-Id': id, Origin: origin },
    });
    assert.equal((await post('1', 'https://evil.example')).status, 403);
    assert.equal((await post('wat')).status, 400);
    assert.equal((await post('0')).status, 409);
    const state = await (await fetch(`${base}/control/state`)).json();
    assert.equal(state.playbackId, 1);
    assert.equal(state.track.playing, false);
    assert.equal((await post('1')).status, 200);
    assert.equal((await post('1')).status, 409);
    playbackId = 2;
    canSkip = true;
    assert.equal((await post('1')).status, 409);
    assert.equal(skips, 1);
    assert.equal((await post('2')).status, 200);
    assert.equal(skips, 2);
    const rate = (id: number, value: string, auth = token) => fetch(`${base}/control/yandex-rating`, {
      method: 'POST', headers: { 'X-Control-Token': auth, 'X-Playback-Id': String(id), 'X-Rating': value },
    });
    assert.equal((await rate(2, 'like', 'bad')).status, 403);
    assert.equal((await rate(1, 'like')).status, 409);
    assert.equal((await rate(2, 'invalid')).status, 400);
    assert.equal((await rate(2, 'like')).status, 200);
    assert.equal(rating, 'like');
    assert.equal((await rate(2, 'none')).status, 200);
    assert.equal(rating, null);
    yandex = false;
    assert.equal((await rate(2, 'dislike')).status, 409);
    const spotifyRate = (id: number, value: string, auth = token) => fetch(`${base}/control/spotify-rating`, {
      method: 'POST', headers: { 'X-Control-Token': auth, 'X-Playback-Id': String(id), 'X-Rating': value },
    });
    assert.equal((await spotifyRate(2, 'like')).status, 409);
    spotify = true;
    assert.equal((await spotifyRate(2, 'like', 'bad')).status, 403);
    assert.equal((await spotifyRate(1, 'like')).status, 409);
    assert.equal((await spotifyRate(2, 'dislike')).status, 400);
    assert.equal((await spotifyRate(2, 'like')).status, 200);
    assert.equal((await spotifyRate(2, 'none')).status, 200);
    const setVolume = (level: string, muted = 'false', auth = token) => fetch(`${base}/control/volume`, {
      method: 'POST', headers: { 'X-Control-Token': auth, 'X-Volume': level, 'X-Muted': muted },
    });
    assert.equal((await fetch(`${base}/control/volume`)).status, 405);
    assert.equal((await setVolume('20', 'false', 'bad')).status, 403);
    assert.equal((await setVolume('101')).status, 400);
    assert.equal((await setVolume('-1')).status, 400);
    assert.equal((await setVolume('NaN')).status, 400);
    assert.equal((await setVolume('30', 'maybe')).status, 400);
    assert.equal((await setVolume('30', 'true')).status, 200);
    assert.equal(volume.level, 30);
    assert.equal(volume.muted, true);
    volume.supported = false;
    assert.equal((await setVolume('90')).status, 409);
    assert.equal(volume.level, 30);
    volume.supported = true;
    volumeTarget = 'spotify:desktop';
    assert.equal((await setVolume('70')).status, 409, 'старый запрос mpv не меняет Spotify');
    const spotifyPost = () => fetch(`${base}/control/volume`, { method: 'POST', headers: {
      'X-Control-Token': token, 'X-Volume': '70', 'X-Muted': 'false', 'X-Volume-Target': 'spotify:desktop',
    } });
    assert.equal((await spotifyPost()).status, 200);
    assert.equal(volume.level, 70, 'сервер дождался Spotify');
    failVolume = true;
    const failed = await spotifyPost();
    assert.equal(failed.status, 502);
    assert.match((await failed.json()).error, /Spotify/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
