/**
 * Проверка "это фолловер канала от N дней?" через Twitch Helix
 * "Get Channel Followers". Требует User Access Token со скоупом
 * moderator:read:followers, и этот пользователь должен быть broadcaster'ом
 * или модератором канала (иначе Twitch вернёт 401/403).
 */

export interface FollowerCheckConfig {
  broadcasterId: string;
  userId: string;
  clientId: string;
  getAccessToken: () => Promise<string>;
}

export interface FollowerEligibility {
  isFollower: boolean;
  followedAt: string | null;
  daysSinceFollow: number | null;
  isEligible: boolean;
}

export async function checkFollowerEligibility(
  cfg: FollowerCheckConfig,
  minDays: number,
  fetchImpl: typeof fetch = fetch,
): Promise<FollowerEligibility> {
  const token = await cfg.getAccessToken();

  const url = new URL('https://api.twitch.tv/helix/channels/followers');
  url.searchParams.set('broadcaster_id', cfg.broadcasterId);
  url.searchParams.set('user_id', cfg.userId);

  const res = await fetchImpl(url, {
    headers: {
      'Client-Id': cfg.clientId,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Twitch Get Channel Followers вернул ошибку HTTP ${res.status}`);
  }

  const data = (await res.json()) as { data: Array<{ followed_at: string }> };
  const entry = data.data[0];
  if (!entry) {
    return { isFollower: false, followedAt: null, daysSinceFollow: null, isEligible: false };
  }

  const followedAt = entry.followed_at;
  const daysSinceFollow = (Date.now() - new Date(followedAt).getTime()) / (1000 * 60 * 60 * 24);
  return {
    isFollower: true,
    followedAt,
    daysSinceFollow,
    isEligible: daysSinceFollow >= minDays,
  };
}
