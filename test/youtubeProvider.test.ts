import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIso8601DurationToSeconds, fetchYoutubeVideoDetails } from '../src/music/youtubeProvider.ts';

test('parseIso8601DurationToSeconds: минуты и секунды', () => {
  assert.equal(parseIso8601DurationToSeconds('PT10M13S'), 613);
});

test('parseIso8601DurationToSeconds: только секунды', () => {
  assert.equal(parseIso8601DurationToSeconds('PT45S'), 45);
});

test('parseIso8601DurationToSeconds: часы, минуты, секунды', () => {
  assert.equal(parseIso8601DurationToSeconds('PT1H2M10S'), 3600 + 120 + 10);
});

test('parseIso8601DurationToSeconds: некорректная строка -> 0', () => {
  assert.equal(parseIso8601DurationToSeconds('garbage'), 0);
});

test('fetchYoutubeVideoDetails возвращает метаданные и длительность в секундах', async () => {
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({
        items: [
          {
            snippet: { title: 'Test video', channelTitle: 'Test Channel' },
            contentDetails: { duration: 'PT3M33S' },
          },
        ],
      }),
      { status: 200 },
    )) as typeof fetch;

  const details = await fetchYoutubeVideoDetails('dQw4w9WgXcQ', 'fake-key', fakeFetch);
  assert.ok(details);
  assert.equal(details?.title, 'Test video');
  assert.equal(details?.channelTitle, 'Test Channel');
  assert.equal(details?.durationSec, 213);
});

test('fetchYoutubeVideoDetails возвращает null, если видео не найдено', async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({ items: [] }), { status: 200 })) as typeof fetch;
  const details = await fetchYoutubeVideoDetails('nonexistent', 'fake-key', fakeFetch);
  assert.equal(details, null);
});

test('fetchYoutubeVideoDetails бросает ошибку при неуспешном ответе API', async () => {
  const fakeFetch = (async () => new Response('quota exceeded', { status: 403 })) as typeof fetch;
  await assert.rejects(() => fetchYoutubeVideoDetails('x', 'fake-key', fakeFetch), /HTTP 403/);
});
