import { createHash } from 'node:crypto';
import { logger } from '../core/logger.ts';

/**
 * Яндекс Музыка через её неофициальный API (api.music.yandex.net) — тот же,
 * которым пользуются официальные приложения и библиотека yandex-music-api.
 * Официального публичного API у Яндекс Музыки нет.
 *
 * Метаданные трека отдаются без авторизации. Ссылка на аудиофайл без токена
 * тоже отдаётся, но только на 30-секундное превью — для полного трека нужен
 * OAuth-токен аккаунта с подпиской Плюс (YANDEX_MUSIC_TOKEN, см. .env.example).
 *
 * yt-dlp для Яндекс Музыки не используется: его экстрактор yandexmusic:track
 * ходит в старые web-эндпоинты и сейчас (2026) не работает.
 */

const API_BASE = 'https://api.music.yandex.net';

/**
 * Соль подписи ссылки на файл. Не секрет — зашита в клиенты Яндекс Музыки и
 * публично известна (см. yandex-music-api), но Яндекс может её сменить.
 */
const DOWNLOAD_SIGN_SALT = 'XGRlBW9FXlekgbPrRHuSiA';

/** Префикс playUri в очереди заказов — по нему плеер отличает Яндекс от YouTube-ссылок. */
export const YANDEX_PLAY_URI_PREFIX = 'yandex:track:';

export function yandexPlayUri(trackId: string): string {
  return `${YANDEX_PLAY_URI_PREFIX}${trackId}`;
}

/** trackId из playUri вида yandex:track:<id>, либо null, если это не Яндекс. */
export function parseYandexPlayUri(playUri: string): string | null {
  return playUri.startsWith(YANDEX_PLAY_URI_PREFIX) ? playUri.slice(YANDEX_PLAY_URI_PREFIX.length) : null;
}

export interface YandexTrackDetails {
  trackId: string;
  title: string;
  artist: string;
  durationSec: number;
  /** false — трек изъят/недоступен в регионе, играть его нельзя. */
  available: boolean;
  /** Измеренная Яндексом громкость (EBU R128); null — Яндекс её не отдал. */
  loudness: YandexTrackLoudness | null;
}

export interface YandexTrackLoudness {
  /** Интегральная громкость, LUFS. */
  integratedLufs: number;
  /** Пиковый уровень (true peak), дБ. */
  truePeakDb: number;
}

interface YandexTrackJson {
  id: string | number;
  title: string;
  version?: string;
  durationMs?: number;
  available?: boolean;
  artists?: Array<{ name: string }>;
  r128?: { i?: number; tp?: number };
}

/** Выше этого пика поправка громкости вверх не поднимает трек — иначе искажения при клиппинге. */
const MAX_TRUE_PEAK_DB = -1;

/**
 * Поправка громкости (дБ), приводящая трек к targetLufs — так же, как
 * нормализация громкости в Spotify (там "Обычная" = −14 LUFS). Тихие треки
 * поднимаются не выше, чем позволяет их пик (MAX_TRUE_PEAK_DB), — Spotify
 * делает так же.
 */
export function computeLoudnessGainDb(loudness: YandexTrackLoudness, targetLufs: number): number {
  let gain = targetLufs - loudness.integratedLufs;
  if (gain > 0) gain = Math.min(gain, Math.max(0, MAX_TRUE_PEAK_DB - loudness.truePeakDb));
  return Math.round(gain * 100) / 100;
}

interface DownloadInfoJson {
  codec: string;
  preview?: boolean;
  bitrateInKbps: number;
  downloadInfoUrl: string;
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `OAuth ${token}` } : {};
}

/** Название/исполнитель/длительность трека. null — трека с таким id нет. */
export async function fetchYandexTrackDetails(
  trackId: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<YandexTrackDetails | null> {
  const res = await fetchImpl(`${API_BASE}/tracks/${encodeURIComponent(trackId)}`, { headers: authHeaders(token) });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) {
    throw new Error(`Яндекс Музыка вернула ошибку HTTP ${res.status} на запрос трека ${trackId}`);
  }

  const data = (await res.json()) as { result?: YandexTrackJson[] };
  const track = data.result?.[0];
  if (!track) return null;

  return {
    trackId: String(track.id),
    title: track.version ? `${track.title} (${track.version})` : track.title,
    artist: (track.artists ?? []).map((a) => a.name).join(', '),
    durationSec: Math.round((track.durationMs ?? 0) / 1000),
    available: track.available !== false,
    loudness:
      typeof track.r128?.i === 'number' && typeof track.r128?.tp === 'number'
        ? { integratedLufs: track.r128.i, truePeakDb: track.r128.tp }
        : null,
  };
}

/**
 * Лучший (по битрейту) полноценный mp3-вариант трека, либо null, если
 * доступно только превью — то есть токена нет, он протух или у аккаунта нет
 * подписки Плюс.
 */
export async function fetchYandexFullDownloadInfo(
  trackId: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DownloadInfoJson | null> {
  const res = await fetchImpl(`${API_BASE}/tracks/${encodeURIComponent(trackId)}/download-info`, {
    headers: authHeaders(token),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Яндекс Музыка отклонила токен (HTTP ${res.status}) — обнови YANDEX_MUSIC_TOKEN`);
  }
  if (!res.ok) {
    throw new Error(`Яндекс Музыка вернула ошибку HTTP ${res.status} на download-info трека ${trackId}`);
  }

  const data = (await res.json()) as { result?: DownloadInfoJson[] };
  const full = (data.result ?? []).filter((d) => d.codec === 'mp3' && !d.preview);
  if (full.length === 0) return null;
  return full.reduce((best, d) => (d.bitrateInKbps > best.bitrateInKbps ? d : best));
}

/** Собирает прямую ссылку на файл из ответа downloadInfoUrl. Экспортировано ради юнит-тестов. */
export function buildYandexDirectUrl(info: { host: string; path: string; ts: string; s: string }): string {
  const sign = createHash('md5')
    .update(DOWNLOAD_SIGN_SALT + info.path.slice(1) + info.s)
    .digest('hex');
  return `https://${info.host}/get-mp3/${sign}/${info.ts}${info.path}`;
}

/**
 * Прямая ссылка на полный mp3 трека, которую можно отдать mpv. Ссылка
 * подписана и живёт недолго, поэтому её получают прямо перед
 * воспроизведением, а не при постановке заказа в очередь.
 */
export async function resolveYandexStreamUrl(
  trackId: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const download = await fetchYandexFullDownloadInfo(trackId, token, fetchImpl);
  if (!download) {
    throw new Error(
      `Яндекс Музыка отдаёт по треку ${trackId} только превью — у аккаунта YANDEX_MUSIC_TOKEN нет подписки Плюс?`,
    );
  }

  const url = new URL(download.downloadInfoUrl);
  url.searchParams.set('format', 'json');
  const res = await fetchImpl(url, { headers: authHeaders(token) });
  if (!res.ok) {
    throw new Error(`Яндекс Музыка вернула ошибку HTTP ${res.status} на ссылку скачивания трека ${trackId}`);
  }
  const info = (await res.json()) as { host: string; path: string; ts: string; s: string };
  return buildYandexDirectUrl(info);
}

export interface YandexPlayback {
  streamUrl: string;
  /** Поправка громкости для mpv, дБ; undefined — не применять. */
  gainDb?: number;
}

/**
 * Всё, что нужно mpv для трека: ссылка на файл и, если задан targetLufs и
 * Яндекс знает громкость трека, поправка до этого уровня.
 */
export async function resolveYandexPlayback(
  trackId: string,
  token: string,
  targetLufs: number | null,
  fetchImpl: typeof fetch = fetch,
): Promise<YandexPlayback> {
  const [streamUrl, details] = await Promise.all([
    resolveYandexStreamUrl(trackId, token, fetchImpl),
    targetLufs === null ? Promise.resolve(null) : fetchYandexTrackDetails(trackId, token, fetchImpl),
  ]);
  if (targetLufs === null) return { streamUrl };
  if (!details?.loudness) {
    logger.warn('playback', `Яндекс не отдал громкость трека ${trackId} — играю без выравнивания`);
    return { streamUrl };
  }
  const gainDb = computeLoudnessGainDb(details.loudness, targetLufs);
  logger.info(
    'playback',
    `Выравнивание громкости трека ${trackId}: ${details.loudness.integratedLufs} LUFS → поправка ${gainDb} дБ`,
  );
  return { streamUrl, gainDb };
}
