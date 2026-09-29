import { getSpotifyAppToken } from './spotifyAuth.ts';
import type { TokenStore } from '../core/tokenStore.ts';

export interface SpotifyTrackDetails {
  trackId: string;
  uri: string;
  title: string;
  artist: string;
  durationMs: number;
}

/** Метаданные трека по id — только для чтения, через app-токен (client credentials). */
export async function fetchSpotifyTrackDetails(
  trackId: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SpotifyTrackDetails | null> {
  const token = await getSpotifyAppToken(clientId, clientSecret, fetchImpl);

  const res = await fetchImpl(`https://api.spotify.com/v1/tracks/${encodeURIComponent(trackId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Spotify API вернул ошибку HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    uri: string;
    name: string;
    artists: Array<{ name: string }>;
    duration_ms: number;
  };

  return {
    trackId,
    uri: data.uri,
    title: data.name,
    artist: data.artists.map((a) => a.name).join(', '),
    durationMs: data.duration_ms,
  };
}

export interface SpotifyPlaybackState {
  isPlaying: boolean;
  progressMs: number;
  durationMs: number;
  trackUri: string | null;
  /** Название и исполнитель — нужны для команды "текущий трек" в чате (см. currentTrackHandler.ts). */
  trackTitle: string | null;
  trackArtist: string | null;
}

export interface SpotifyPlaylistTrack {
  uri: string;
  title: string;
  artist: string;
  durationMs: number;
}

export interface SpotifyDevice {
  id: string;
  name: string;
  isActive: boolean;
}

const NO_ACTIVE_DEVICE_HINT =
  'Похоже, у Spotify нет "активного устройства" — открой приложение Spotify ' +
  '(desktop/mobile/web) на том устройстве, где должна играть музыка. Если это ' +
  'не помогает — укажи SPOTIFY_DEVICE_NAME в .env (точное имя устройства можно ' +
  'узнать через "node scripts/spotify-devices.ts"), чтобы приложение явно ' +
  'выбирало нужное устройство вместо "текущего активного".';

/**
 * Управление воспроизведением на устройстве пользователя через Spotify
 * Connect (Web API `/me/player/*`). Требует Premium-аккаунт — обычные
 * endpoints управления плеером недоступны бесплатным аккаунтам.
 *
 * Важный нюанс Spotify Web API: если у аккаунта нет "активного устройства"
 * (Spotify нигде не запущен / давно не использовался), запросы на
 * воспроизведение падают с HTTP 404 "NO_ACTIVE_DEVICE" — это официально
 * задокументированное поведение, не баг в этом коде. Если задан
 * deviceName, контроллер явно ищет устройство с таким именем среди
 * доступных (GET /me/player/devices) и передаёт его id в каждый запрос —
 * это работает даже для устройства, которое сейчас не воспроизводит
 * ничего, достаточно чтобы на нём было открыто приложение Spotify.
 */
export class SpotifyPlaybackController {
  private readonly userAuth: Pick<TokenStore, 'getValidAccessToken'>;
  private readonly fetchImpl: typeof fetch;
  private readonly deviceName: string | undefined;

  constructor(
    userAuth: Pick<TokenStore, 'getValidAccessToken'>,
    fetchImpl: typeof fetch = fetch,
    deviceName?: string,
  ) {
    this.userAuth = userAuth;
    this.fetchImpl = fetchImpl;
    this.deviceName = deviceName;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.userAuth.getValidAccessToken();
    return { Authorization: `Bearer ${token}` };
  }

  /** Список устройств Spotify Connect, видимых для этого аккаунта прямо сейчас. */
  async listDevices(): Promise<SpotifyDevice[]> {
    const res = await this.fetchImpl('https://api.spotify.com/v1/me/player/devices', {
      headers: await this.authHeaders(),
    });
    if (!res.ok) {
      throw new Error(`Не удалось получить список устройств Spotify: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { devices: Array<{ id: string; name: string; is_active: boolean }> };
    return data.devices.map((d) => ({ id: d.id, name: d.name, isActive: d.is_active }));
  }

  /**
   * Кэш резолва device_id по имени — на короткий срок. Без него каждый
   * вызов resolveDeviceId() делает отдельный GET /me/player/devices, а
   * playTrackUri() внутри себя делает ДВА действия подряд (queue + next,
   * см. ниже) — то есть два лишних похода за списком устройств на каждый
   * заказ. На практике это добавляло заметную задержку (сотни мс — секунды)
   * между решением "пора переключаться" и реальным запуском трека, из-за
   * чего можно было не успеть до того, как предыдущий трек естественным
   * образом закончится сам (см. подробности в README, раздел про
   * playTrackUri). TTL короткий — если пользователь переключит активное
   * устройство, это подхватится максимум через несколько секунд.
   */
  private static readonly DEVICE_ID_CACHE_MS = 15_000;
  private cachedDeviceId: { id: string; expiresAt: number } | undefined;

  /**
   * Если задан deviceName — находит его id среди доступных устройств.
   * Если deviceName не задан — возвращает undefined (Spotify сам выберет
   * "текущее активное" устройство, как раньше).
   */
  private async resolveDeviceId(): Promise<string | undefined> {
    if (!this.deviceName) return undefined;

    const now = Date.now();
    if (this.cachedDeviceId && this.cachedDeviceId.expiresAt > now) {
      return this.cachedDeviceId.id;
    }

    const devices = await this.listDevices();
    const match = devices.find((d) => d.name.toLowerCase() === this.deviceName!.toLowerCase());
    if (!match) {
      const available = devices.map((d) => `"${d.name}"`).join(', ') || '(ни одного — Spotify нигде не открыт)';
      throw new Error(
        `Устройство SPOTIFY_DEVICE_NAME="${this.deviceName}" не найдено. Доступные сейчас устройства: ${available}.`,
      );
    }
    this.cachedDeviceId = { id: match.id, expiresAt: now + SpotifyPlaybackController.DEVICE_ID_CACHE_MS };
    return match.id;
  }

  private buildPlayerUrl(path: string, deviceId: string | undefined): string {
    const url = new URL(`https://api.spotify.com/v1/me/player${path}`);
    if (deviceId) url.searchParams.set('device_id', deviceId);
    return url.toString();
  }

  /** Текущее состояние плеера. null — ничего не играет / нет активного устройства. */
  async getCurrentPlayback(): Promise<SpotifyPlaybackState | null> {
    const res = await this.fetchImpl('https://api.spotify.com/v1/me/player', {
      headers: await this.authHeaders(),
    });
    if (res.status === 204) return null;
    if (!res.ok) {
      throw new Error(`Spotify Player API вернул ошибку HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      is_playing: boolean;
      progress_ms: number;
      item: { duration_ms: number; uri: string; name: string; artists: Array<{ name: string }> } | null;
    };
    if (!data.item) return null;
    return {
      isPlaying: data.is_playing,
      progressMs: data.progress_ms,
      durationMs: data.item.duration_ms,
      trackUri: data.item.uri,
      trackTitle: data.item.name,
      trackArtist: data.item.artists.map((a) => a.name).join(', '),
    };
  }

  /**
   * Немедленно запускает конкретный трек (и заказы, и треки дефолтного плейлиста).
   *
   * Реализовано через "добавить в очередь + переключиться на следующий", а
   * не через прямой `PUT /me/player/play` с `{"uris": [...]}` — на практике
   * прямой запрос "играть именно этот трек" принимался Spotify с HTTP 204
   * (успех), но реально ничего не запускал. `POST /me/player/queue` +
   * `POST /me/player/next` отрабатывает надёжно там, где прямой "play by uri" — нет.
   *
   * Подвох: если в очереди Spotify уже что-то лежит (например, трек от
   * прошлой неудачной попытки — удалить из очереди через API нельзя), "next"
   * включит его, а не наш. Это ловит и исправляет плеер (spotifyTrackPlayer.ts).
   */
  async playTrackUri(uri: string): Promise<void> {
    await this.queueTrack(uri);
    await this.skipToNext();
  }

  private async queueTrack(uri: string): Promise<void> {
    const deviceId = await this.resolveDeviceId();
    const url = new URL('https://api.spotify.com/v1/me/player/queue');
    url.searchParams.set('uri', uri);
    if (deviceId) url.searchParams.set('device_id', deviceId);
    const res = await this.fetchImpl(url.toString(), {
      method: 'POST',
      headers: await this.authHeaders(),
    });
    if (!res.ok && res.status !== 204) {
      throw new Error(this.playbackErrorMessage('добавить трек в очередь', res.status));
    }
  }

  /**
   * Треки плейлиста по его uri (spotify:playlist:<id>) — для заполнения
   * таблицы дефолтных треков. Используется /items: старый /tracks Spotify
   * закрыл (HTTP 403 для любых плейлистов). Локальные файлы, подкасты и
   * недоступные в регионе треки пропускаются.
   *
   * Приложения Spotify в режиме разработки видят только плейлисты из
   * медиатеки пользователя — на чужой плейлист, не добавленный в медиатеку,
   * Spotify отвечает 403.
   */
  async fetchPlaylistTracks(playlistUri: string): Promise<SpotifyPlaylistTrack[]> {
    const playlistId = playlistUri.split(':').pop()!;
    const tracks: SpotifyPlaylistTrack[] = [];
    let url: string | null =
      `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/items?limit=50&additional_types=track`;

    while (url) {
      const res = await this.fetchImpl(url, { headers: await this.authHeaders() });
      if (res.status === 403) {
        throw new Error(
          'Spotify не дал прочитать дефолтный плейлист (HTTP 403). Приложению доступны только плейлисты из ' +
            'твоей медиатеки — открой плейлист в Spotify и нажми "Добавить в медиатеку" (или скопируй его ' +
            'треки в свой плейлист), затем перезапусти приложение.',
        );
      }
      if (res.status === 404) {
        throw new Error('Дефолтный плейлист Spotify не найден (HTTP 404) — проверь SPOTIFY_DEFAULT_PLAYLIST_URI.');
      }
      if (!res.ok) {
        throw new Error(`Spotify вернул HTTP ${res.status} при чтении дефолтного плейлиста`);
      }
      const data = (await res.json()) as {
        next: string | null;
        items: Array<{
          is_local?: boolean;
          item: {
            type: string;
            uri: string;
            name: string;
            duration_ms: number;
            is_playable?: boolean;
            is_local?: boolean;
            artists?: Array<{ name: string }>;
          } | null;
        }>;
      };
      for (const entry of data.items) {
        const t = entry.item;
        if (!t || t.type !== 'track' || entry.is_local || t.is_local || t.is_playable === false) continue;
        tracks.push({
          uri: t.uri,
          title: t.name,
          artist: (t.artists ?? []).map((a) => a.name).join(', '),
          durationMs: t.duration_ms,
        });
      }
      url = data.next;
    }
    return tracks;
  }

  async pause(): Promise<void> {
    const deviceId = await this.resolveDeviceId();
    const res = await this.fetchImpl(this.buildPlayerUrl('/pause', deviceId), {
      method: 'PUT',
      headers: await this.authHeaders(),
    });
    if (!res.ok && res.status !== 204 && res.status !== 404) {
      throw new Error(this.playbackErrorMessage('поставить Spotify на паузу', res.status));
    }
  }

  /**
   * "Следующий трек" в Spotify. Используется playTrackUri и плеером, когда
   * после playTrackUri заиграл не тот трек (см. spotifyTrackPlayer.ts).
   */
  async skipToNext(): Promise<void> {
    const deviceId = await this.resolveDeviceId();
    const res = await this.fetchImpl(this.buildPlayerUrl('/next', deviceId), {
      method: 'POST',
      headers: await this.authHeaders(),
    });
    if (!res.ok && res.status !== 204) {
      throw new Error(this.playbackErrorMessage('скипнуть трек', res.status));
    }
  }

  private playbackErrorMessage(action: string, status: number): string {
    const base = `Не удалось ${action} в Spotify: HTTP ${status}`;
    return status === 404 ? `${base}. ${NO_ACTIVE_DEVICE_HINT}` : base;
  }
}
