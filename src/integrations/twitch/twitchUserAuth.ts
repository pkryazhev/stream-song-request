import { TokenStore } from '../../core/tokenStore.ts';

export interface TwitchUserAuthConfig {
  clientId: string;
  clientSecret: string;
  tokenFilePath: string;
}

/**
 * User Access Token с refresh_token — нужен для чтения/отправки сообщений
 * в чат (chat:read, chat:edit) и для проверки даты фолловера
 * (moderator:read:followers). Получается один раз через scripts/twitch-auth.ts.
 */
export function createTwitchUserTokenStore(cfg: TwitchUserAuthConfig, fetchImpl: typeof fetch = fetch): TokenStore {
  return new TokenStore(cfg.tokenFilePath, async (refreshToken) => {
    const url = new URL('https://id.twitch.tv/oauth2/token');
    url.searchParams.set('grant_type', 'refresh_token');
    url.searchParams.set('refresh_token', refreshToken);
    url.searchParams.set('client_id', cfg.clientId);
    url.searchParams.set('client_secret', cfg.clientSecret);

    const res = await fetchImpl(url, { method: 'POST' });
    if (!res.ok) {
      throw new Error(`Не удалось обновить Twitch access token: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number; refresh_token: string };
    return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresInSec: data.expires_in };
  });
}
