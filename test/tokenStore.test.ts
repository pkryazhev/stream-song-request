import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore } from '../src/core/tokenStore.ts';

function tmpTokenPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'token-store-test-'));
  return join(dir, 'token.json');
}

test('load() возвращает false, если файла ещё нет', () => {
  const store = new TokenStore(tmpTokenPath(), async () => {
    throw new Error('не должен вызываться');
  });
  assert.equal(store.load(), false);
  assert.equal(store.hasToken(), false);
});

test('getValidAccessToken возвращает сохранённый токен без рефреша, пока он не истёк', async () => {
  const path = tmpTokenPath();
  let refreshCalls = 0;
  const store = new TokenStore(path, async () => {
    refreshCalls += 1;
    return { accessToken: 'new', refreshToken: 'new-refresh', expiresInSec: 3600 };
  });

  store.saveInitial('initial-access', 'initial-refresh', 3600);
  const token = await store.getValidAccessToken();

  assert.equal(token, 'initial-access');
  assert.equal(refreshCalls, 0);
});

test('getValidAccessToken обновляет токен через refresh, если он истёк, и сохраняет на диск', async () => {
  const path = tmpTokenPath();
  let refreshCalls = 0;
  const store = new TokenStore(path, async (refreshToken) => {
    refreshCalls += 1;
    assert.equal(refreshToken, 'initial-refresh');
    return { accessToken: 'refreshed-access', refreshToken: 'refreshed-refresh', expiresInSec: 3600 };
  });

  // отрицательный expiresInSec гарантированно делает токен "уже истёкшим"
  store.saveInitial('initial-access', 'initial-refresh', -10);

  const token = await store.getValidAccessToken();
  assert.equal(token, 'refreshed-access');
  assert.equal(refreshCalls, 1);

  // новый инстанс, читающий тот же файл, должен увидеть обновлённый токен
  const reloaded = new TokenStore(path, async () => {
    throw new Error('не должен понадобиться — токен свежий');
  });
  reloaded.load();
  const reloadedToken = await reloaded.getValidAccessToken();
  assert.equal(reloadedToken, 'refreshed-access');
});

test('getValidAccessToken бросает понятную ошибку, если токена ещё нет', async () => {
  const store = new TokenStore(tmpTokenPath(), async () => {
    throw new Error('не должен вызываться');
  });
  await assert.rejects(() => store.getValidAccessToken(), /Нет сохранённого токена/);
});
