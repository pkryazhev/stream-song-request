import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIrcLine } from '../src/integrations/twitch/ircParser.ts';

test('парсит PING', () => {
  const result = parseIrcLine('PING :tmi.twitch.tv');
  assert.deepEqual(result, { command: 'PING', payload: ':tmi.twitch.tv' });
});

test('парсит PRIVMSG с тегами', () => {
  const line =
    '@badge-info=;badges=broadcaster/1;display-name=Pavel;mod=0;user-id=123456;' +
    'tmi-sent-ts=1700000000000 :pavel!pavel@pavel.tmi.twitch.tv PRIVMSG #pavel :!sr https://youtu.be/dQw4w9WgXcQ';

  const result = parseIrcLine(line);
  assert.equal(result.command, 'PRIVMSG');
  if (result.command !== 'PRIVMSG') return;

  assert.equal(result.channel, 'pavel');
  assert.equal(result.text, '!sr https://youtu.be/dQw4w9WgXcQ');
  assert.equal(result.userLogin, 'pavel');
  assert.equal(result.tags['display-name'], 'Pavel');
  assert.equal(result.tags['user-id'], '123456');
  assert.equal(result.tags.mod, '0');
  assert.equal(result.tags.badges, 'broadcaster/1');
});

test('декодирует экранированные значения тегов (\\s -> пробел)', () => {
  const line = '@display-name=Pavel\\sStreams :pavel!pavel@pavel.tmi.twitch.tv PRIVMSG #pavel :hello';
  const result = parseIrcLine(line);
  assert.equal(result.command, 'PRIVMSG');
  if (result.command !== 'PRIVMSG') return;
  assert.equal(result.tags['display-name'], 'Pavel Streams');
});

test('распознаёт мод-флаг для модератора', () => {
  const line = '@mod=1;user-id=1 :someone!someone@someone.tmi.twitch.tv PRIVMSG #pavel :test';
  const result = parseIrcLine(line);
  assert.equal(result.command, 'PRIVMSG');
  if (result.command !== 'PRIVMSG') return;
  assert.equal(result.tags.mod, '1');
});

test('прочие строки (JOIN, 001 и т.п.) считаются OTHER', () => {
  const result = parseIrcLine(':tmi.twitch.tv 001 pavel :Welcome, GLHF!');
  assert.equal(result.command, 'OTHER');
});
