import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function readConfig(extra: Record<string, string>) {
  const configUrl = new URL('../src/core/config.ts', import.meta.url).href;
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    process.loadEnvFile = () => {};
    const { config } = await import(${JSON.stringify(configUrl)});
    console.log('RESULT:' + JSON.stringify({
      id: config.youtube.defaultPlaylistId,
      spotifyPlaylist: config.spotify?.defaultPlaylistUri,
      shuffle: config.playback.shuffleDefaultPlaylist,
    }));
  `], {
    encoding: 'utf8',
    env: {
      SystemRoot: process.env.SystemRoot,
      YOUTUBE_API_KEY: 'test-key',
      TWITCH_CLIENT_ID: 'test', TWITCH_CLIENT_SECRET: 'test',
      TWITCH_BROADCASTER_LOGIN: 'test', TWITCH_CHAT_BOT_USERNAME: 'test', TWITCH_BROADCASTER_ID: '1',
      YOUTUBE_DEFAULT_PLAYLIST_URL: 'https://youtube.com/playlist?list=PL_example',
      ...extra,
    },
  });
}

test('YouTube background config enables shuffle and permits Spotify requests without Spotify background', () => {
  const result = readConfig({ SPOTIFY_CLIENT_ID: 'test', SPOTIFY_CLIENT_SECRET: 'test' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.split('RESULT:')[1]);
  assert.deepEqual(output, { id: 'PL_example', spotifyPlaylist: null, shuffle: true });
});

test('YouTube background config rejects conflicting sources, invalid links and missing API key', () => {
  for (const [extra, message] of [
    [{ SPOTIFY_DEFAULT_PLAYLIST_URI: 'spotify:playlist:example' }, /только один/],
    [{ YANDEX_DEFAULT_PLAYLIST_URL: 'WAVE' }, /только один/],
    [{ YOUTUBE_DEFAULT_PLAYLIST_URL: 'https://youtube.com/playlist?list=WL' }, /нужна ссылка/],
    [{ YOUTUBE_API_KEY: '' }, /нет YOUTUBE_API_KEY/],
  ] as Array<[Record<string, string>, RegExp]>) {
    const result = readConfig(extra);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
  }
});
