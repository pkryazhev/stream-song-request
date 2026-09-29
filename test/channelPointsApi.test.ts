import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureReward,
  getTokenOwnerId,
  listUnfulfilledRedemptions,
  updateRedemptionStatus,
  type ChannelPointsApiConfig,
} from '../src/integrations/twitch/channelPointsApi.ts';

const apiCfg: ChannelPointsApiConfig = {
  clientId: 'tw-cid',
  broadcasterId: 'broadcaster-1',
  getAccessToken: async () => 'broadcaster-token',
};

interface RecordedRequest {
  method: string;
  url: URL;
  body: unknown;
  headers: Record<string, string>;
}

function recordingFetch(respond: (req: RecordedRequest) => Response): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const req: RecordedRequest = {
      method: init?.method ?? 'GET',
      url: new URL(String(url)),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    requests.push(req);
    return respond(req);
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status });

test('getTokenOwnerId возвращает user_id владельца токена', async () => {
  const { fetchImpl, requests } = recordingFetch(() => json({ user_id: '42', scopes: [] }));
  assert.equal(await getTokenOwnerId('tok', fetchImpl), '42');
  assert.equal(requests[0].headers.Authorization, 'OAuth tok');
});

const requiredFields = {
  is_enabled: true,
  is_paused: false,
  is_user_input_required: true,
  should_redemptions_skip_request_queue: false,
};

test('ensureReward: награда найдена по названию (без учёта регистра) — меняются только обязательные поля, название/цена/подсказка не перезаписываются', async () => {
  const { fetchImpl, requests } = recordingFetch((req) =>
    req.method === 'GET' ? json({ data: [{ id: 'other', title: 'Другое' }, { id: 'r-1', title: 'заказ МУЗЫКИ' }] }) : json({ data: [] }),
  );
  const reward = await ensureReward(apiCfg, { title: 'Заказ музыки', cost: 300, prompt: 'ссылка' }, undefined, fetchImpl);

  assert.deepEqual(reward, { id: 'r-1', title: 'заказ МУЗЫКИ', created: false });
  assert.equal(requests[0].url.searchParams.get('only_manageable_rewards'), 'true');
  const patch = requests[1];
  assert.equal(patch.method, 'PATCH');
  assert.equal(patch.url.searchParams.get('id'), 'r-1');
  assert.deepEqual(patch.body, requiredFields);
  assert.equal(patch.headers.Authorization, 'Bearer broadcaster-token');
  assert.equal(patch.headers['Client-Id'], 'tw-cid');
});

test('ensureReward: награду переименовали в панели — находится по сохранённому id, новая не создаётся', async () => {
  const { fetchImpl, requests } = recordingFetch((req) =>
    req.method === 'GET' ? json({ data: [{ id: 'r-1', title: 'Музыка от зрителей' }] }) : json({ data: [] }),
  );
  const reward = await ensureReward(apiCfg, { title: 'Заказ музыки', cost: 300, prompt: 'ссылка' }, 'r-1', fetchImpl);

  assert.deepEqual(reward, { id: 'r-1', title: 'Музыка от зрителей', created: false });
  assert.deepEqual(
    requests.map((r) => r.method),
    ['GET', 'PATCH'],
  );
});

test('ensureReward: награды нет — создаётся с названием/ценой/подсказкой из настроек, активации НЕ выполняются автоматически', async () => {
  const { fetchImpl, requests } = recordingFetch((req) =>
    req.method === 'GET' ? json({ data: [] }) : json({ data: [{ id: 'new-reward', title: 'Заказ музыки' }] }),
  );
  const reward = await ensureReward(apiCfg, { title: 'Заказ музыки', cost: 500, prompt: 'ссылка' }, 'deleted-id', fetchImpl);

  assert.deepEqual(reward, { id: 'new-reward', title: 'Заказ музыки', created: true });
  assert.equal(requests[1].method, 'POST');
  assert.deepEqual(requests[1].body, { title: 'Заказ музыки', cost: 500, prompt: 'ссылка', ...requiredFields });
});

test('ensureReward: награда с таким названием создана вручную — понятная ошибка', async () => {
  const { fetchImpl } = recordingFetch((req) =>
    req.method === 'GET'
      ? json({ data: [] })
      : json({ error: 'Bad Request', status: 400, message: 'CREATE_CUSTOM_REWARD_DUPLICATE_REWARD' }, 400),
  );
  await assert.rejects(
    ensureReward(apiCfg, { title: 'Заказ музыки', cost: 500, prompt: 'ссылка' }, undefined, fetchImpl),
    /создана вручную/,
  );
});

test('listUnfulfilledRedemptions проходит по всем страницам', async () => {
  const { fetchImpl, requests } = recordingFetch((req) =>
    req.url.searchParams.get('after')
      ? json({ data: [{ id: 'b', user_name: 'B', user_input: 'y' }], pagination: {} })
      : json({ data: [{ id: 'a', user_name: 'A', user_input: 'x' }], pagination: { cursor: 'next' } }),
  );
  const list = await listUnfulfilledRedemptions(apiCfg, 'r-1', fetchImpl);
  assert.deepEqual(
    list.map((r) => r.id),
    ['a', 'b'],
  );
  assert.equal(requests[0].url.searchParams.get('status'), 'UNFULFILLED');
  assert.equal(requests[1].url.searchParams.get('after'), 'next');
});

test('updateRedemptionStatus: больше 50 активаций — разбивается на несколько запросов', async () => {
  const { fetchImpl, requests } = recordingFetch(() => json({ data: [] }));
  const ids = Array.from({ length: 51 }, (_, i) => `id-${i}`);
  await updateRedemptionStatus(apiCfg, 'r-1', ids, 'CANCELED', fetchImpl);

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url.searchParams.getAll('id').length, 50);
  assert.deepEqual(requests[1].url.searchParams.getAll('id'), ['id-50']);
  assert.deepEqual(requests[0].body, { status: 'CANCELED' });
  assert.equal(requests[0].url.searchParams.get('reward_id'), 'r-1');
});

test('updateRedemptionStatus: ошибка Twitch пробрасывается', async () => {
  const { fetchImpl } = recordingFetch(() => json({ message: 'nope' }, 403));
  await assert.rejects(updateRedemptionStatus(apiCfg, 'r-1', ['a'], 'FULFILLED', fetchImpl), /HTTP 403/);
});
