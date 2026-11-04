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
  const server = startNowPlayingOverlay({
    port: 0, getNowPlaying: () => null, spotifyApp: null, getSpotifyPlayback: null, yandexToken: undefined,
    control: {
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
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
