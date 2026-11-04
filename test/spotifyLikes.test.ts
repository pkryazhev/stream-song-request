import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpotifyPlaybackController } from '../src/music/spotifyProvider.ts';
import { SpotifyLikes } from '../src/music/spotifyLikes.ts';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('Spotify likes: library endpoints, current state, add, remove, failed save preserves state', async () => {
  const calls: Array<{ url: URL; method?: string }> = [];
  let fail = false;
  const api = new SpotifyPlaybackController({ getValidAccessToken: async () => 'token' }, (async (url, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer token');
    calls.push({ url: new URL(String(url)), method: init?.method });
    if (fail) return new Response(null, { status: 403 });
    if (init?.method === 'GET') return Response.json([true]);
    return new Response(null, { status: 200 });
  }) as typeof fetch);
  const likes = new SpotifyLikes(api);
  const uri = 'spotify:track:abc';
  assert.equal(likes.getState(uri).ready, false);
  await tick();
  assert.equal(likes.getState(uri).rating, 'like');
  assert.equal(calls[0].url.pathname, '/v1/me/library/contains');
  await likes.set(uri, null);
  assert.equal(likes.getState(uri).rating, null);
  await likes.set(uri, 'like');
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'DELETE', 'PUT']);
  for (const call of calls) assert.equal(call.url.searchParams.get('uris'), uri);
  fail = true;
  await assert.rejects(likes.set(uri, null), /auth:spotify/);
  assert.equal(likes.getState(uri).rating, 'like');
  assert.equal(likes.getState(uri).busy, false);
});

test('Spotify likes: late result remains attached to original track; duplicate write rejected', async () => {
  let release!: () => void;
  const writes: string[] = [];
  const likes = new SpotifyLikes({ isTrackSaved: async () => false,
    setTrackSaved: async (uri) => { writes.push(uri); await new Promise<void>((resolve) => { release = resolve; }); },
  });
  likes.getState('spotify:track:first'); await tick();
  const write = likes.set('spotify:track:first', 'like');
  await assert.rejects(likes.set('spotify:track:first', null), /выполняется/);
  likes.getState('spotify:track:second'); await tick();
  release(); await write;
  assert.equal(likes.getState('spotify:track:second').rating, null);
  assert.equal(likes.getState('spotify:track:first').rating, 'like');
  assert.deepEqual(writes, ['spotify:track:first']);
});
