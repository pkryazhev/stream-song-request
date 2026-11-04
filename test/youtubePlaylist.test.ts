import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchYoutubePlaylistTracks, parseYoutubePlaylistUrl } from '../src/music/youtubePlaylist.ts';

test('YouTube playlist links: playlist, watch, short and music links', () => {
  for (const link of [
    'https://www.youtube.com/playlist?list=PL_example',
    'https://www.youtube.com/watch?v=kXYiU_JCYtU&list=PL_example',
    'https://youtu.be/kXYiU_JCYtU?list=PL_example',
    'https://music.youtube.com/playlist?list=PL_example',
  ]) assert.equal(parseYoutubePlaylistUrl(link), 'PL_example');
  for (const link of ['garbage', 'https://evil.com/playlist?list=PL_example',
    'https://youtube.com/watch?v=kXYiU_JCYtU', 'https://youtube.com/playlist?list=WL',
    'https://youtube.com/playlist?list=RDkXYiU_JCYtU']) assert.equal(parseYoutubePlaylistUrl(link), null);
});

const videoId = (n: number) => String(n).padStart(11, '0');
const video = (id: string) => ({
  id, snippet: { title: id, channelTitle: 'Channel', liveBroadcastContent: 'none' },
  contentDetails: { duration: 'PT3M' }, status: { privacyStatus: 'public', uploadStatus: 'processed' },
});
const response = (data: unknown) => new Response(JSON.stringify(data));

test('imports more than 50 entries, batches metadata, preserves order and skips unavailable videos', async () => {
  const calls: URL[] = [];
  const fakeFetch = (async (input: URL) => {
    const url = new URL(input);
    calls.push(url);
    if (url.pathname.endsWith('/playlistItems')) {
      const second = url.searchParams.get('pageToken') === 'next';
      return response({
        items: Array.from({ length: second ? 5 : 50 }, (_, i) => ({ contentDetails: { videoId: videoId(i + (second ? 50 : 0)) } })),
        nextPageToken: second ? undefined : 'next',
      });
    }
    const ids = url.searchParams.get('id')!.split(',');
    assert.ok(ids.length <= 50);
    return response({ items: ids.filter((id) => id !== videoId(2)).reverse().map(video) });
  }) as typeof fetch;
  const tracks = await fetchYoutubePlaylistTracks('PL_example', 'fake-key', fakeFetch);
  assert.equal(calls.length, 4);
  assert.equal(tracks.length, 54);
  assert.deepEqual(tracks.map((t) => t.title), Array.from({ length: 55 }, (_, i) => videoId(i)).filter((id) => id !== videoId(2)));
  assert.equal(tracks[0].durationSec, 180);
  assert.equal(tracks[0].playUri, `https://www.youtube.com/watch?v=${videoId(0)}`);
  assert.equal(tracks[0].provider, 'youtube');
});

test('failed later page rejects the entire import without leaking API key', async () => {
  let calls = 0;
  const fakeFetch = (async () => ++calls === 1
    ? response({ items: [{ contentDetails: { videoId: videoId(1) } }], nextPageToken: 'next' })
    : new Response('', { status: 403 })) as typeof fetch;
  await assert.rejects(fetchYoutubePlaylistTracks('PL_example', 'secret-key', fakeFetch), (error: Error) => {
    assert.match(error.message, /HTTP 403/);
    assert.ok(!error.message.includes('secret-key'));
    return true;
  });
});

test('skips private videos, live broadcasts and videos without duration', async () => {
  const fakeFetch = (async (url: URL) => url.pathname.endsWith('/playlistItems')
    ? response({ items: [0, 1, 2, 3].map((i) => ({ contentDetails: { videoId: videoId(i) } })) })
    : response({ items: [video(videoId(0)),
      { ...video(videoId(1)), status: { privacyStatus: 'private' } },
      { ...video(videoId(2)), snippet: { liveBroadcastContent: 'live' } },
      { ...video(videoId(3)), contentDetails: { duration: 'PT0S' } },
    ] })) as typeof fetch;
  assert.equal((await fetchYoutubePlaylistTracks('PL_example', 'key', fakeFetch)).length, 1);
});

test('deduplicates videos and rejects repeating pagination tokens', async () => {
  const fakeFetch = (async (url: URL) => url.pathname.endsWith('/playlistItems')
    ? response({ items: [1, 1].map((i) => ({ contentDetails: { videoId: videoId(i) } })) })
    : response({ items: [video(videoId(1))] })) as typeof fetch;
  assert.equal((await fetchYoutubePlaylistTracks('PL_example', 'key', fakeFetch)).length, 1);
  const repeated = (async () => response({ items: [], nextPageToken: 'same' })) as typeof fetch;
  await assert.rejects(fetchYoutubePlaylistTracks('PL_example', 'key', repeated), /повторяющуюся страницу/);
});
