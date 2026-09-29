import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { runAuthorizationCodeFlow } from '../scripts/lib/runAuthorizationCodeFlow.ts';

// runAuthorizationCodeFlow печатает инструкцию (кириллицей) через console.log.
// Раннер node:test получает результаты тестов через тот же stdout дочернего
// процесса, и такой вывод при нагрузке изредка ломает ему разбор ("Unable to
// deserialize cloned data") — тест падает, хотя сами проверки прошли.
beforeEach(() => {
  mock.method(console, 'log', () => {});
});
afterEach(() => {
  mock.restoreAll();
});

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

test('runAuthorizationCodeFlow: успешный callback меняет code на токены и вызывает onSuccess', async () => {
  const port = 8931;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  let exchangedCode: string | undefined;
  let successTokens: { accessToken: string; refreshToken: string; expiresInSec: number } | undefined;

  runAuthorizationCodeFlow({
    authorizeUrl: new URL('https://example.com/authorize'),
    redirectUri,
    exchangeCode: async (code) => {
      exchangedCode = code;
      return { accessToken: 'access-1', refreshToken: 'refresh-1', expiresInSec: 3600 };
    },
    onSuccess: (tokens) => {
      successTokens = tokens;
    },
  });

  const response = await httpGet(`${redirectUri}?code=test-code-123&state=abc`);

  assert.equal(response.status, 200);
  assert.match(response.body, /Готово/);
  assert.equal(exchangedCode, 'test-code-123');
  assert.deepEqual(successTokens, { accessToken: 'access-1', refreshToken: 'refresh-1', expiresInSec: 3600 });
});

test('runAuthorizationCodeFlow: ошибка авторизации (error=...) не вызывает exchangeCode', async () => {
  const port = 8932;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  let exchangeCalled = false;

  runAuthorizationCodeFlow({
    authorizeUrl: new URL('https://example.com/authorize'),
    redirectUri,
    exchangeCode: async () => {
      exchangeCalled = true;
      return { accessToken: 'x', refreshToken: 'y', expiresInSec: 1 };
    },
    onSuccess: () => {
      throw new Error('не должен вызываться');
    },
  });

  const response = await httpGet(`${redirectUri}?error=access_denied`);

  assert.equal(response.status, 400);
  assert.equal(exchangeCalled, false);
});
