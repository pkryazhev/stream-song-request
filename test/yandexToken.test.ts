import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractYandexToken, upsertEnvVar } from '../scripts/lib/yandexToken.ts';

const TOKEN = 'y0_AgAAAAAAbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

test('extractYandexToken: из адреса после входа', () => {
  assert.equal(
    extractYandexToken(`https://music.yandex.ru/#access_token=${TOKEN}&token_type=bearer&expires_in=31535645`),
    TOKEN,
  );
});

test('extractYandexToken: голый токен и мусор', () => {
  assert.equal(extractYandexToken(`  ${TOKEN}  `), TOKEN);
  assert.equal(extractYandexToken('https://music.yandex.ru/'), null);
  assert.equal(extractYandexToken('привет'), null);
});

test('upsertEnvVar: заменяет существующую строку, не трогая остальные', () => {
  const env = 'A=1\nYANDEX_MUSIC_TOKEN=\nB=2\n';
  assert.equal(upsertEnvVar(env, 'YANDEX_MUSIC_TOKEN', 'tok'), 'A=1\nYANDEX_MUSIC_TOKEN=tok\nB=2\n');
});

test('upsertEnvVar: раскомментирует закомментированную строку, CRLF сохраняется', () => {
  const env = 'A=1\r\n# YANDEX_MUSIC_TOKEN=old\r\nB=2\r\n';
  assert.equal(upsertEnvVar(env, 'YANDEX_MUSIC_TOKEN', 'tok'), 'A=1\r\nYANDEX_MUSIC_TOKEN=tok\r\nB=2\r\n');
});

test('upsertEnvVar: переменной нет — дописывает в конец', () => {
  assert.equal(upsertEnvVar('A=1', 'YANDEX_MUSIC_TOKEN', 'tok'), 'A=1\nYANDEX_MUSIC_TOKEN=tok\n');
  assert.equal(upsertEnvVar('', 'YANDEX_MUSIC_TOKEN', 'tok'), 'YANDEX_MUSIC_TOKEN=tok\n');
});
