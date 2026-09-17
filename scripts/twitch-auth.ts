#!/usr/bin/env node
/**
 * Одноразовая авторизация Twitch-аккаунта, от имени которого бот будет
 * читать/писать в чат и проверять фолловеров (Authorization Code Flow).
 * Запуск: npm run auth:twitch
 *
 * Если аккаунт для чата — НЕ сам broadcaster, он должен быть модератором
 * канала, иначе скоуп moderator:read:followers не сработает (Twitch вернёт 401/403).
 *
 * Требует, чтобы TWITCH_CLIENT_ID/SECRET уже были заполнены в .env, и
 * чтобы redirect URI (по умолчанию http://localhost:8889/callback) был
 * добавлен в настройках приложения на https://dev.twitch.tv/console/apps.
 * Важно: у Twitch для http принимается только буквально "localhost" —
 * с "127.0.0.1" консоль вернёт ошибку "URL-адреса должны использовать
 * протокол HTTPS" (в отличие от Spotify, где всё наоборот).
 */
import { randomBytes } from 'node:crypto';
import { TokenStore } from '../src/core/tokenStore.ts';
import { runAuthorizationCodeFlow } from './lib/runAuthorizationCodeFlow.ts';

try {
  process.loadEnvFile();
} catch {
  // .env необязателен, если переменные заданы окружением
}

const clientId = process.env.TWITCH_CLIENT_ID;
const clientSecret = process.env.TWITCH_CLIENT_SECRET;
const redirectUri = process.env.TWITCH_CHAT_REDIRECT_URI ?? 'http://localhost:8889/callback';
const tokenFilePath = process.env.TWITCH_CHAT_TOKEN_FILE ?? './data/twitch-chat-token.json';

if (!clientId || !clientSecret) {
  console.error('Заполни TWITCH_CLIENT_ID и TWITCH_CLIENT_SECRET в .env перед авторизацией.');
  process.exit(1);
}

const scopes = ['chat:read', 'chat:edit', 'moderator:read:followers'].join(' ');

const state = randomBytes(8).toString('hex');
const authorizeUrl = new URL('https://id.twitch.tv/oauth2/authorize');
authorizeUrl.searchParams.set('client_id', clientId);
authorizeUrl.searchParams.set('response_type', 'code');
authorizeUrl.searchParams.set('redirect_uri', redirectUri);
authorizeUrl.searchParams.set('scope', scopes);
authorizeUrl.searchParams.set('state', state);

runAuthorizationCodeFlow({
  authorizeUrl,
  redirectUri,
  exchangeCode: async (code) => {
    const url = new URL('https://id.twitch.tv/oauth2/token');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('client_secret', clientSecret);
    url.searchParams.set('code', code);
    url.searchParams.set('grant_type', 'authorization_code');
    url.searchParams.set('redirect_uri', redirectUri);

    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) {
      throw new Error(`Twitch вернул HTTP ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
    return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresInSec: data.expires_in };
  },
  onSuccess: (tokens) => {
    const store = new TokenStore(tokenFilePath, () => {
      throw new Error('refresh не должен вызываться во время первичной авторизации');
    });
    store.saveInitial(tokens.accessToken, tokens.refreshToken, tokens.expiresInSec);
    console.log(`Готово! Токен сохранён в ${tokenFilePath}`);
  },
});
