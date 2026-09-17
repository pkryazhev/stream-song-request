import { eventBus } from '../../core/eventBus.ts';
import { logger } from '../../core/logger.ts';
import { hasAnnounced, markAnnounced } from '../../db/index.ts';
import { getAppAccessToken } from './authClient.ts';
import type { StreamWentLiveEvent } from '../../core/events.ts';

export interface TwitchWatcherConfig {
  clientId: string;
  clientSecret: string;
  broadcasterLogin: string;
  pollIntervalMs: number;
}

interface HelixStream {
  id: string;
  user_login: string;
  title: string;
  game_name: string;
  thumbnail_url: string;
  started_at: string;
}

/**
 * Опрашивает Twitch Helix "Get Streams" для одного канала.
 * Возвращает null, если канал сейчас офлайн.
 *
 * Сознательно выбран поллинг, а не EventSub webhook: EventSub требует
 * публично доступный HTTPS-эндпоинт (или WebSocket-подписку с постоянным
 * соединением), что избыточно для локального личного инструмента.
 * Поллинг раз в 30–60 сек полностью достаточен для анонса о начале стрима.
 */
export async function fetchCurrentStream(
  cfg: Pick<TwitchWatcherConfig, 'clientId' | 'clientSecret' | 'broadcasterLogin'>,
  fetchImpl: typeof fetch = fetch,
): Promise<HelixStream | null> {
  const token = await getAppAccessToken(cfg.clientId, cfg.clientSecret, fetchImpl);

  const url = new URL('https://api.twitch.tv/helix/streams');
  url.searchParams.set('user_login', cfg.broadcasterLogin);

  const res = await fetchImpl(url, {
    headers: {
      'Client-Id': cfg.clientId,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Twitch Helix API вернул ошибку: HTTP ${res.status}`);
  }

  const data = (await res.json()) as { data: HelixStream[] };
  return data.data[0] ?? null;
}

/**
 * Запускает периодический опрос. При переходе канала в статус "онлайн"
 * (и только один раз на конкретный stream_id, см. announced_streams в БД)
 * публикует событие 'stream.went_live' в общую шину.
 *
 * Возвращает функцию остановки (для аккуратного shutdown).
 */
export function startStreamWatcher(cfg: TwitchWatcherConfig): () => void {
  let stopped = false;

  async function tick(): Promise<void> {
    try {
      const stream = await fetchCurrentStream(cfg);
      if (stream && !hasAnnounced(stream.id)) {
        markAnnounced(stream.id);
        const event: StreamWentLiveEvent = {
          streamId: stream.id,
          broadcasterLogin: stream.user_login,
          title: stream.title,
          gameName: stream.game_name,
          thumbnailUrl: stream.thumbnail_url,
          startedAt: stream.started_at,
        };
        logger.info('twitch', `Стрим начался: "${event.title}"`);
        eventBus.emit('stream.went_live', event);
      }
    } catch (err) {
      logger.error('twitch', 'Ошибка при опросе Twitch API', err);
    }
  }

  const timer = setInterval(() => {
    if (!stopped) void tick();
  }, cfg.pollIntervalMs);

  void tick(); // проверить сразу при старте, не дожидаясь первого интервала

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
