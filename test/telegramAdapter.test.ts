import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAnnouncement, sendTelegramMessage } from '../src/integrations/telegram/telegramAdapter.ts';

const sampleEvent = {
  streamId: '1',
  broadcasterLogin: 'pavel_streams',
  title: 'Играем в что-то интересное',
  gameName: 'Just Chatting',
  thumbnailUrl: '',
  startedAt: new Date().toISOString(),
};

test('formatAnnouncement включает название, категорию и ссылку на канал', () => {
  const text = formatAnnouncement(sampleEvent);
  assert.match(text, /Играем в что-то интересное/);
  assert.match(text, /Just Chatting/);
  assert.match(text, /twitch\.tv\/pavel_streams/);
});

test('formatAnnouncement не падает без категории', () => {
  const text = formatAnnouncement({ ...sampleEvent, gameName: '' });
  assert.doesNotMatch(text, /Категория:/);
});

test('sendTelegramMessage отправляет POST с корректным телом на Bot API', async () => {
  let capturedUrl: string | undefined;
  let capturedBody: { chat_id: string; text: string } | undefined;

  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  await sendTelegramMessage({ botToken: 'TESTTOKEN', chatId: '12345' }, 'привет', fakeFetch);

  assert.equal(capturedUrl, 'https://api.telegram.org/botTESTTOKEN/sendMessage');
  assert.equal(capturedBody?.chat_id, '12345');
  assert.equal(capturedBody?.text, 'привет');
});

test('sendTelegramMessage бросает ошибку при неуспешном ответе Telegram', async () => {
  const fakeFetch = (async () => new Response('bad request', { status: 400 })) as typeof fetch;

  await assert.rejects(
    () => sendTelegramMessage({ botToken: 'x', chatId: 'y' }, 'test', fakeFetch),
    /HTTP 400/,
  );
});
