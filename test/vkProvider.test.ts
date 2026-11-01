import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateVkVideoInfo, VK_MATCH_FILTER, VK_PLUGIN_DIR, vkThumbnailFromInfo, describeVkExtractionError } from '../src/music/vkProvider.ts';
import { parseRequestLink } from '../src/music/linkParser.ts';
import { buildYtdlpAudioArgs, buildYtdlpInfoArgs } from '../src/music/youtubePlayer.ts';

const video = { extractor_key: 'VK', title: 'Song', uploader: 'Channel', duration: 180,
  formats: [{ url: 'https://cdn.example/video.mp4' }] };

test('VK accepts native video, including combined audio/video', () => {
  assert.deepEqual(validateVkVideoInfo(video), { title: 'Song', author: 'Channel', durationSec: 180 });
});

test('VK rejects external embeds, playlists, live streams, missing duration and unusable audio', () => {
  for (const override of [
    { extractor_key: 'Youtube' }, { _type: 'url' }, { _type: 'playlist' },
    { is_live: true }, { live_status: 'is_upcoming' }, { duration: undefined },
    { duration: 0 }, { duration: NaN }, { duration: Infinity },
    { formats: [] }, { formats: [{ url: 'https://cdn.example/a', acodec: 'none' }] },
    { formats: [{ url: 'https://cdn.example/a', has_drm: true }] },
  ]) assert.throws(() => validateVkVideoInfo({ ...video, ...override }));
});

test('VK direct URLs preserve signed owner and access list, discard tracking and time', () => {
  for (const host of ['vk.com', 'vk.ru', 'vkvideo.ru', 'm.vk.com']) {
    assert.deepEqual(parseRequestLink(`https://${host}/video-123_456?list=abc123&t=60&foo=bar`), {
      type: 'vk', videoId: '-123_456', url: `https://${host}/video-123_456?list=abc123`,
    });
  }
  for (const url of ['https://vk.com/clip-123_456', 'https://vk.com/videos-123',
    'https://vk.com/feed?z=video-123_456', 'https://vk.com.evil/video-123_456',
    'https://vk.com/video-123_456extra', 'https://vk.com:123/video-123_456']) {
    assert.equal(parseRequestLink(url).type, 'invalid');
  }
});

test('VK extraction and playback both ignore local config and forbid other extractors', () => {
  for (const args of [buildYtdlpAudioArgs('https://vk.com/video1_2', { allowedExtractors: 'vk', matchFilter: VK_MATCH_FILTER, pluginDirs: VK_PLUGIN_DIR }),
    buildYtdlpInfoArgs('https://vk.com/video1_2', { allowedExtractors: 'vk', matchFilter: VK_MATCH_FILTER, pluginDirs: VK_PLUGIN_DIR })]) {
    assert.ok(args.includes('--ignore-config'));
    assert.equal(args[args.indexOf('--ies') + 1], 'vk');
    assert.equal(args[args.indexOf('--match-filter') + 1], VK_MATCH_FILTER);
    assert.equal(args[args.indexOf('--plugin-dirs') + 1], VK_PLUGIN_DIR);
    assert.ok(!args.includes('--cookies'));
    assert.ok(!args.includes('--cookies-from-browser'));
  }
});

test('VK thumbnails use metadata and reject unexpected hosts and protocols', () => {
  assert.equal(vkThumbnailFromInfo({ thumbnail: 'https://sun9-1.userapi.com/preview.jpg?x=1' }), 'https://sun9-1.userapi.com/preview.jpg?x=1');
  assert.equal(vkThumbnailFromInfo({ thumbnail: 'https://iv.okcdn.ru/getVideoPreview?id=123' }), 'https://iv.okcdn.ru/getVideoPreview?id=123');
  assert.equal(vkThumbnailFromInfo({ thumbnails: [{ url: 'https://vk.com/small.jpg' }, { url: 'https://vk.com/big.jpg' }] }), 'https://vk.com/big.jpg');
  for (const thumbnail of ['http://127.0.0.1/a', 'file:///a', 'https://userapi.com.evil/a', 'https://evil/a', 'https://user:pass@vk.com/a']) {
    assert.equal(vkThumbnailFromInfo({ thumbnail }), null);
  }
});

test('VK errors distinguish missing executable, subtitles bug and timeout from authorization', () => {
  assert.match(describeVkExtractionError({ code: 'ENOENT' }, ''), /не найден yt-dlp/);
  assert.match(describeVkExtractionError({ code: 1 }, "ERROR: 'NoneType' object has no attribute 'split'"), /субтитров/);
  assert.match(describeVkExtractionError({ killed: true }, ''), /не ответил вовремя/);
  assert.doesNotMatch(describeVkExtractionError({ code: 1 }, 'ERROR: internal failure'), /без авторизации/);
});
