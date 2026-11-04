import { test } from 'node:test';
import assert from 'node:assert/strict';
import { YandexRatings, type RatingEvent } from '../src/music/yandexRatings.ts';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('Яндекс: читает отметки, меняет и снимает их, передаёт события волне', async () => {
  const posts: string[] = [];
  const ratings = new YandexRatings('token', (async (url, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'OAuth token');
    const path = new URL(String(url)).pathname;
    if (path === '/account/status') return Response.json({ result: { account: { uid: 123 } } });
    if (init?.method === 'GET') return Response.json({ result: { library: { tracks: path.includes('/likes/') ? [{ id: '1' }] : [] } } });
    assert.equal(String(init?.body), 'track-ids=1');
    posts.push(path);
    return Response.json({ result: { revision: 10 } });
  }) as typeof fetch);
  assert.equal(ratings.getState('1').ready, false);
  await tick();
  assert.equal(ratings.getState('1').rating, 'like');
  const events: RatingEvent[] = [];
  const feedback = async (event: RatingEvent) => { events.push(event); };
  await ratings.set('1', 'dislike', feedback);
  assert.equal(ratings.getState('1').rating, 'dislike');
  await ratings.set('1', null, feedback);
  await ratings.set('1', 'like', feedback);
  await ratings.set('1', null, feedback);
  assert.deepEqual(events, ['unlike', 'dislike', 'undislike', 'like', 'unlike']);
  assert.deepEqual(posts, ['/users/123/dislikes/tracks/add-multiple', '/users/123/dislikes/tracks/remove',
    '/users/123/likes/tracks/add-multiple', '/users/123/likes/tracks/remove']);
  const result = await ratings.set('1', 'like', async () => { throw new Error('session expired'); });
  assert.match(result.warning!, /сохранена/);
  assert.equal(ratings.getState('1').rating, 'like');
});

test('Яндекс: ошибка сохранения не меняет отметку и не отправляет событие', async () => {
  const ratings = new YandexRatings('token', (async (url, init) => {
    if (init?.method === 'POST') return new Response(null, { status: 403 });
    return Response.json({ result: String(url).endsWith('/account/status')
      ? { account: { uid: 1 } } : { library: { tracks: [] } } });
  }) as typeof fetch);
  ratings.getState('1'); await tick();
  await assert.rejects(ratings.set('1', 'like', async () => { assert.fail('feedback on failed save'); }), /токен/);
  assert.equal(ratings.getState('1').rating, null);
  assert.equal(ratings.getState('1').busy, false);
});
