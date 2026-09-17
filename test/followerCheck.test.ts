import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFollowerEligibility } from '../src/integrations/twitch/followerCheck.ts';

const baseCfg = {
  broadcasterId: 'b1',
  userId: 'u1',
  clientId: 'cid',
  getAccessToken: async () => 'mod-token',
};

test('фолловер от 5 дней проходит порог в 3 дня', async () => {
  const followedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ data: [{ followed_at: followedAt }] }), { status: 200 })) as typeof fetch;

  const result = await checkFollowerEligibility(baseCfg, 3, fakeFetch);
  assert.equal(result.isFollower, true);
  assert.equal(result.isEligible, true);
});

test('фолловер от 1 дня не проходит порог в 3 дня', async () => {
  const followedAt = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ data: [{ followed_at: followedAt }] }), { status: 200 })) as typeof fetch;

  const result = await checkFollowerEligibility(baseCfg, 3, fakeFetch);
  assert.equal(result.isFollower, true);
  assert.equal(result.isEligible, false);
});

test('не-фолловер невалиден', async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;
  const result = await checkFollowerEligibility(baseCfg, 3, fakeFetch);
  assert.equal(result.isFollower, false);
  assert.equal(result.isEligible, false);
});

test('бросает ошибку при неуспешном ответе Twitch API', async () => {
  const fakeFetch = (async () => new Response('forbidden', { status: 403 })) as typeof fetch;
  await assert.rejects(() => checkFollowerEligibility(baseCfg, 3, fakeFetch), /HTTP 403/);
});
