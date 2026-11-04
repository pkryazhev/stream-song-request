import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpotifyVolume } from '../src/music/spotifyVolume.ts';
import { SpotifyPlaybackController } from '../src/music/spotifyProvider.ts';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('Spotify volume selects configured device, sends authenticated PUT and reads capabilities', async () => {
  const writes: Array<{ url: URL; init?: RequestInit }> = [];
  const api = new SpotifyPlaybackController({ getValidAccessToken: async () => 'token' }, (async (url, init) => {
    if (String(url).endsWith('/devices')) return Response.json({ devices: [
      { id: 'phone', name: 'Phone', is_active: true, supports_volume: false, volume_percent: 10 },
      { id: 'desktop', name: 'Desktop', is_active: false, supports_volume: true, volume_percent: 65 },
    ] });
    writes.push({ url: new URL(String(url)), init });
    return new Response(null, { status: 204 });
  }) as typeof fetch, 'desktop');
  const volume = new SpotifyVolume(api);
  assert.equal(volume.getState().supported, false);
  await tick();
  assert.equal(volume.getState().level, 65);
  assert.equal(volume.getState().supported, true);
  assert.equal(volume.getState().target, 'spotify:desktop');
  await volume.set(35, false, 'spotify:desktop');
  assert.equal(writes[0].url.pathname, '/v1/me/player/volume');
  assert.equal(writes[0].url.searchParams.get('device_id'), 'desktop');
  assert.equal(writes[0].url.searchParams.get('volume_percent'), '35');
  assert.equal(writes[0].init?.method, 'PUT');
  assert.deepEqual(writes[0].init?.headers, { Authorization: 'Bearer token' });
  await volume.set(35, true, 'spotify:desktop');
  assert.equal(writes[1].url.searchParams.get('volume_percent'), '0');
  assert.equal(volume.getState().level, 35);
  assert.equal(volume.getState().muted, true);
  await volume.set(35, false, 'spotify:desktop');
  assert.equal(writes[2].url.searchParams.get('volume_percent'), '35');
  await assert.rejects(volume.set(80, false, 'spotify:phone'), /сменилось/);
  await assert.rejects(api.setVolume(101, 'desktop'), /Некорректная/);
});

test('Spotify volume blocks unsupported, restricted or missing device and avoids repeated polling', async () => {
  for (const device of [null,
    { id: 'd', name: 'D', isActive: true, supportsVolume: false },
    { id: 'd', name: 'D', isActive: true, supportsVolume: true, isRestricted: true },
  ]) {
    let reads = 0;
    const volume = new SpotifyVolume({ getVolumeDevice: async () => { reads++; return device; },
      setVolume: async () => { assert.fail('unsupported write'); } });
    volume.getState(); await tick();
    assert.equal(volume.getState().supported, false);
    assert.ok(volume.getState().error);
    await assert.rejects(volume.set(20, false, 'spotify:d'));
    volume.getState(); volume.getState();
    assert.equal(reads, 1);
  }
});

test('Spotify volume serializes writes and retains previous state after API failure', async () => {
  const writes: number[] = [];
  const pending: Array<() => void> = [];
  const saved: number[] = [];
  const volume = new SpotifyVolume({
    getVolumeDevice: async () => ({ id: 'd', name: 'D', isActive: true, supportsVolume: true, volumePercent: 60 }),
    setVolume: async (level) => {
      writes.push(level);
      if (level === 90) throw new Error('Spotify HTTP 403');
      await new Promise<void>((resolve) => pending.push(resolve));
    },
  }, 50, (level) => saved.push(level));
  volume.getState(); await tick();
  const first = volume.set(20, false, 'spotify:d');
  const second = volume.set(40, false, 'spotify:d');
  await tick();
  assert.deepEqual(writes, [20]);
  pending.shift()!(); await first; await tick();
  assert.deepEqual(writes, [20, 40]);
  pending.shift()!(); await second;
  assert.deepEqual(saved, [20, 40]);
  await assert.rejects(volume.set(90, false, 'spotify:d'), /403/);
  assert.equal(volume.getState().level, 40);
  assert.equal(volume.getState().supported, false);
  assert.match(volume.getState().error!, /403/);
});

test('Spotify volume errors explain Premium, auth, rate limits and absent device', async () => {
  for (const [status, message] of [[403, /Premium/], [401, /auth:spotify/], [429, /частоту/], [404, /активного устройства/]] as const) {
    const api = new SpotifyPlaybackController({ getValidAccessToken: async () => 'token' },
      (async () => new Response(null, { status })) as typeof fetch);
    await assert.rejects(api.setVolume(50, 'd'), message);
  }
});
