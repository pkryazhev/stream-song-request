/**
 * App Access Token для Twitch Helix API (client_credentials flow).
 * Этого токена достаточно для чтения публичных данных (Get Streams) —
 * не нужен OAuth конкретного пользователя.
 * Токен кэшируется в памяти и обновляется перед истечением.
 */

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let cached: CachedToken | undefined;

export async function getAppAccessToken(
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (cached && cached.expiresAt - 60_000 > Date.now()) {
    return cached.accessToken;
  }

  const url = new URL('https://id.twitch.tv/oauth2/token');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('client_secret', clientSecret);
  url.searchParams.set('grant_type', 'client_credentials');

  const res = await fetchImpl(url, { method: 'POST' });
  if (!res.ok) {
    throw new Error(`Не удалось получить Twitch app access token: HTTP ${res.status}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cached = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cached.accessToken;
}

/** Только для тестов — сбросить кэш токена между прогонами. */
export function resetTokenCache(): void {
  cached = undefined;
}
