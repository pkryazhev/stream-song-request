import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { searchVkVideoByText, firstVkSearchVideo } from '../src/music/vkSearch.ts';
import { processSongRequest, type RequestHandlerConfig } from '../src/music/requestHandler.ts';
import { handleRedemption } from '../src/music/pointsRequestHandler.ts';
import { initDb } from '../src/db/index.ts';
import { peekNextPending } from '../src/db/musicQueue.ts';
import { setRequestsPaused } from '../src/music/requestsGate.ts';

const cfg: RequestHandlerConfig = {
  commandName: '!sr', minFollowerDays: 0, maxYoutubeDurationSec: 600,
  textSearchProvider: 'vk', vk: { maxDurationSec: 600 },
  twitchClientId: 'id', twitchBroadcasterId: 'owner', getTwitchAccessToken: async () => 'token',
  fetchVkDetails: async () => ({ title: 'Song', author: 'Channel', durationSec: 180 }),
};
const requester = { userId: 'owner', login: 'owner', displayName: 'Owner', isBroadcaster: true };
const options = { requireFollower: false, emptyArgHint: '' };
const block = (ids: string[]) => ({ data_type: 'catalog_videos', layout: { name: 'large_list' }, videos_ids: ids });
const catalog = (blocks: unknown[]) => ({ catalog: { default_section: 'search', sections: [{ id: 'search', blocks }] } });
const found = { response: catalog([block(['-12_34', '1_2'])]) };
function mock(search: () => Response | Promise<Response> = () => Response.json(found)) {
  let sessions = 0, searches = 0;
  const fetchImpl = (async (input, init) => {
    assert.equal(init?.method, 'POST');
    if (String(input) === 'https://login.vk.ru/?act=get_anonym_token') {
      sessions++;
      return Response.json({ type: 'okay', data: { access_token: 'anonymous-session', expired_at: Date.now() / 1000 + 3600 } });
    }
    assert.equal(String(input), 'https://api.vkvideo.ru/method/catalog.getVideoSearchWeb2');
    const body = init?.body as URLSearchParams;
    assert.equal(body.get('access_token'), 'anonymous-session');
    assert.equal(body.get('q'), 'Song');
    assert.equal(body.get('sort'), '2');
    assert.match(body.get('enabled_features')!, /safe_mode/);
    searches++;
    return search();
  }) as typeof fetch;
  return { fetchImpl, counts: () => ({ sessions, searches }) };
}
beforeEach(() => { initDb(':memory:'); setRequestsPaused(false); });

test('VK website search works without personal credentials and reuses anonymous session', async () => {
  const { fetchImpl, counts } = mock();
  assert.equal(await searchVkVideoByText(' Song ', fetchImpl), 'https://vkvideo.ru/video-12_34');
  await searchVkVideoByText('Song', fetchImpl);
  assert.deepEqual(counts(), { sessions: 1, searches: 2 });
});

test('Concurrent searches share session acquisition', async () => {
  const { fetchImpl, counts } = mock();
  await Promise.all([searchVkVideoByText('Song', fetchImpl), searchVkVideoByText('Song', fetchImpl)]);
  assert.deepEqual(counts(), { sessions: 1, searches: 2 });
});

test('Ordering comes from default search section, never metadata, clips or playlists', () => {
  const data = catalog([
    { data_type: 'albums', layout: { name: 'slider' }, videos_ids: ['1_99'] },
    { data_type: 'videos', layout: { name: 'short_video_slider' }, videos_ids: ['1_88'] },
    block(['-12_34', '1_2']),
  ]);
  data.catalog.sections.unshift({ id: 'unselected', blocks: [block(['1_77'])] });
  assert.equal(firstVkSearchVideo({ ...data, catalog_videos: [{ video: { id: 2, owner_id: 1 } }] }), 'https://vkvideo.ru/video-12_34');
  assert.equal(firstVkSearchVideo(catalog([block([])])), null);
  assert.equal(firstVkSearchVideo(catalog([{ data_type: 'videos', layout: { name: 'short_video_slider' }, videos_ids: ['1_88'] }])), null);
  for (const data of [{}, { catalog: { sections: [] } }, catalog([block(['bad'])]), catalog([block(['0_1'])])]) {
    assert.throws(() => firstVkSearchVideo(data));
  }
});

test('Search validates first video once and uses existing playback provider', async () => {
  let checks = 0;
  const { fetchImpl } = mock();
  const result = await processSongRequest(requester, 'Song', { ...cfg, fetchVkDetails: async (url) => {
    checks++;
    assert.equal(url, 'https://vkvideo.ru/video-12_34');
    return { title: 'Song', author: 'Channel', durationSec: 180 };
  } }, options, fetchImpl);
  assert.equal(result.provider, 'vk');
  assert.equal(checks, 1);
  assert.equal(peekNextPending()?.externalId, '-12_34');
});

test('Network search failures retry three times using same anonymous session', async () => {
  let calls = 0;
  const { fetchImpl, counts } = mock(() => {
    if (++calls < 3) throw new TypeError('fetch failed');
    return Response.json(found);
  });
  assert.equal((await processSongRequest(requester, 'Song', cfg, options, fetchImpl)).queued, true);
  assert.deepEqual(counts(), { sessions: 1, searches: 3 });
});

test('Failed session acquisition can retry instead of retaining a rejected promise', async () => {
  let calls = 0;
  const { fetchImpl } = mock();
  const flaky = (async (input, init) => {
    if (String(input).includes('get_anonym_token') && ++calls < 3) throw new TypeError('fetch failed');
    return fetchImpl(input, init);
  }) as typeof fetch;
  assert.equal((await processSongRequest(requester, 'Song', cfg, options, flaky)).queued, true);
  assert.equal(calls, 3);
});

test('API rejection does not retry; next order obtains a new anonymous session', async () => {
  const { fetchImpl, counts } = mock(() => Response.json({ error: { error_code: 5, request_params: ['private'] } }));
  assert.match((await processSongRequest(requester, 'Song', cfg, options, fetchImpl)).replyText, /Поиск ВК сейчас недоступен/);
  assert.deepEqual(counts(), { sessions: 1, searches: 1 });
  await processSongRequest(requester, 'Song', cfg, options, fetchImpl);
  assert.deepEqual(counts(), { sessions: 2, searches: 2 });
});

test('HTTP failures and malformed JSON do not retry or queue', async () => {
  for (const makeResponse of [() => new Response('', { status: 503 }), () => new Response('invalid JSON')]) {
    const { fetchImpl, counts } = mock(makeResponse);
    assert.equal((await processSongRequest(requester, 'Song', cfg, options, fetchImpl)).queued, false);
    assert.equal(counts().searches, 1);
    assert.equal(peekNextPending(), undefined);
  }
});

test('Disabled VK does not search; empty query does not request a session', async () => {
  const { fetchImpl, counts } = mock();
  await processSongRequest(requester, 'Song', { ...cfg, vk: undefined }, options, fetchImpl);
  assert.equal(await searchVkVideoByText(' ', fetchImpl), null);
  assert.deepEqual(counts(), { sessions: 0, searches: 0 });
});

for (const mode of ['success', 'empty', 'auth', 'duration', 'extraction'] as const) {
  test(`VK points search ${mode}: preserves redemption or refunds without choosing another video`, async () => {
    const statuses: string[] = [];
    let checks = 0;
    const { fetchImpl } = mock(() => Response.json(mode === 'empty' ? { response: catalog([block([])]) } : mode === 'auth' ? { error: { error_code: 5 } } : found));
    await handleRedemption({ redemptionId: 'red', rewardId: 'reward', rewardTitle: 'Music', userId: 'viewer', userLogin: 'viewer', userName: 'Viewer', userInput: 'Song' }, {
      request: { ...cfg, fetchVkDetails: async () => {
        checks++;
        if (mode === 'extraction') throw new Error('Видео недоступно');
        return { title: 'Song', author: 'Channel', durationSec: mode === 'duration' ? 601 : 180 };
      } },
      setRedemptionStatus: async (_, status) => { statuses.push(status); },
    }, fetchImpl);
    assert.deepEqual(statuses, mode === 'success' ? [] : ['CANCELED']);
    assert.equal(peekNextPending()?.redemption?.redemptionId, mode === 'success' ? 'red' : undefined);
    assert.ok(checks <= 1);
  });
}
