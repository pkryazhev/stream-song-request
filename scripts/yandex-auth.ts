#!/usr/bin/env node
/**
 * Одноразовое получение токена Яндекс Музыки (YANDEX_MUSIC_TOKEN).
 * Запуск: npm run auth:yandex
 *
 * В отличие от Twitch/Spotify, токен нельзя поймать локальным сервером:
 * используется client_id самого приложения Яндекс Музыки (своего публичного
 * API у неё нет), а его адрес возврата жёстко задан — music.yandex.ru. Поэтому
 * скрипт просит вставить адрес, на который перебросит браузер, достаёт из него
 * access_token, проверяет его и записывает в .env.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { extractYandexToken, upsertEnvVar } from './lib/yandexToken.ts';

const ENV_PATH = '.env';
const ENV_VAR = 'YANDEX_MUSIC_TOKEN';
// client_id официального приложения Яндекс Музыки — тот же, что использует yandex-music-api.
const AUTHORIZE_URL =
  'https://oauth.yandex.ru/authorize?response_type=token&client_id=23cabbbdc6cd418abb4b39c32c41195d';

function openInBrowser(url: string): void {
  // rundll32 вместо "start": у start в cmd ломаются ссылки с "&".
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  execFile(cmd, args, () => {
    // Не открылся — не страшно, ссылка всё равно напечатана.
  });
}

async function checkToken(token: string): Promise<{ login: string; hasPlus: boolean | null }> {
  const res = await fetch('https://api.music.yandex.net/account/status', {
    headers: { Authorization: `OAuth ${token}` },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('Яндекс не принял токен — скорее всего, скопирован не целиком. Попробуй ещё раз.');
  }
  if (!res.ok) throw new Error(`Яндекс Музыка вернула HTTP ${res.status} при проверке токена`);
  const data = (await res.json()) as {
    result?: { account?: { login?: string; uid?: number }; plus?: { hasPlus?: boolean } };
  };
  const account = data.result?.account;
  if (!account?.uid) {
    throw new Error('Токен не привязан к аккаунту — похоже, вход в Яндекс не был выполнен.');
  }
  return { login: account.login ?? String(account.uid), hasPlus: data.result?.plus?.hasPlus ?? null };
}

async function main(): Promise<void> {
  console.log('Открываю страницу входа Яндекса. Если браузер не открылся — открой ссылку вручную:\n');
  console.log(AUTHORIZE_URL);
  console.log('');
  console.log('1. Войди в аккаунт Яндекса с подпиской Плюс и разреши доступ.');
  console.log('2. Браузер перейдёт на адрес вида https://music.yandex.ru/#access_token=...');
  console.log('3. Скопируй этот адрес из адресной строки ЦЕЛИКОМ и вставь сюда.\n');
  openInBrowser(AUTHORIZE_URL);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let token: string | null = null;
  try {
    while (!token) {
      const answer = await rl.question('Адрес (или сам токен): ');
      if (!answer.trim()) {
        console.log('Ничего не введено, отменяю.');
        process.exitCode = 1;
        return;
      }
      token = extractYandexToken(answer);
      if (!token) console.log('Не нашёл в этом тексте access_token — нужен адрес с "#access_token=...". Попробуй ещё раз.');
    }
  } finally {
    rl.close();
  }

  const { login, hasPlus } = await checkToken(token);
  console.log(`\nТокен рабочий, аккаунт: ${login}`);
  if (hasPlus === false) {
    console.log(
      'ВНИМАНИЕ: у этого аккаунта нет подписки Плюс — Яндекс будет отдавать только 30-секундные превью,\n' +
        'и заказы/дефолтный плейлист из Яндекс Музыки играть не смогут.',
    );
  }

  const content = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  writeFileSync(ENV_PATH, upsertEnvVar(content, ENV_VAR, token));
  console.log(`Готово! Токен записан в ${ENV_PATH} (${ENV_VAR}). Перезапусти приложение, если оно запущено.`);
}

main().catch((err: unknown) => {
  console.error(`\nОшибка: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
