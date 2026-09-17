import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCurrentStream } from '../src/integrations/twitch/streamWatcher.ts';
import { resetTokenCache } from '../src/integrations/twitch/authClient.ts';

test('fetchCurrentStream возвращает null, когда канал офлайн', async () => {
  resetTokenCache();
  const fakeFetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes('id.twitch.tv')) {
      return new Response(JSON.stringify({ access_token: 'fake-token', expires_in: 3600 }), { status: 200 });
    }
    if (u.includes('helix/streams')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    throw new Error(`Неожиданный URL в тесте: ${u}`);
  }) as typeof fetch;

  const result = await fetchCurrentStream(
    { clientId: 'cid', clientSecret: 'secret', broadcasterLogin: 'pavel_streams' },
    fakeFetch,
  );
  assert.equal(result, null);
});

test('fetchCurrentStream возвращает данные стрима, когда канал онлайн', async () => {
  resetTokenCache();
  const fakeFetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes('id.twitch.tv')) {
      return new Response(JSON.stringify({ access_token: 'fake-token', expires_in: 3600 }), { status: 200 });
    }
    if (u.includes('helix/streams')) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'stream-1',
              user_login: 'pavel_streams',
              title: 'Играем',
              game_name: 'Just Chatting',
              thumbnail_url: '',
              started_at: '2026-08-20T10:00:00Z',
            },
          ],
        }),
        { status: 200 },
      );
    }
    throw new Error(`Неожиданный URL в тесте: ${u}`);
  }) as typeof fetch;

  const result = await fetchCurrentStream(
    { clientId: 'cid', clientSecret: 'secret', broadcasterLogin: 'pavel_streams' },
    fakeFetch,
  );
  assert.ok(result);
  assert.equal(result?.id, 'stream-1');
  assert.equal(result?.user_login, 'pavel_streams');
});
