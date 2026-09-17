import { TokenStore } from '../core/tokenStore.ts';

interface CachedAppToken {
  accessToken: string;
  expiresAt: number;
}

let cachedAppToken: CachedAppToken | undefined;

/**
 * App Access Token (Client Credentials flow) — достаточно для чтения
 * публичных метаданных трека (название, длительность), без привязки
 * к конкретному пользователю.
 */
export async function getSpotifyAppToken(
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (cachedAppToken && cachedAppToken.expiresAt - 60_000 > Date.now()) {
    return cachedAppToken.accessToken;
  }

  const res = await fetchImpl('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    throw new Error(`Не удалось получить Spotify app token: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedAppToken = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedAppToken.accessToken;
}

/** Только для тестов — сбросить кэш app-токена между прогонами. */
export function resetSpotifyAppTokenCache(): void {
  cachedAppToken = undefined;
}

export interface SpotifyUserAuthConfig {
  clientId: string;
  clientSecret: string;
  tokenFilePath: string;
}

/**
 * User Access Token с refresh_token — нужен, чтобы управлять
 * воспроизведением на устройстве пользователя (play/pause/queue).
 * Получается один раз через scripts/spotify-auth.ts.
 */
export function createSpotifyUserTokenStore(cfg: SpotifyUserAuthConfig, fetchImpl: typeof fetch = fetch): TokenStore {
  return new TokenStore(cfg.tokenFilePath, async (refreshToken) => {
    const res = await fetchImpl('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
    });
    if (!res.ok) {
      throw new Error(`Не удалось обновить Spotify access token: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };
    return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresInSec: data.expires_in };
  });
}
