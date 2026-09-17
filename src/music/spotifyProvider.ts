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
   * Если задан deviceName — находит его id среди доступных устройств.
   * Если deviceName не задан — возвращает undefined (Spotify сам выберет
   * "текущее активное" устройство, как раньше).
   */
  private async resolveDeviceId(): Promise<string | undefined> {
    if (!this.deviceName) return undefined;

    const devices = await this.listDevices();
    const match = devices.find((d) => d.name.toLowerCase() === this.deviceName!.toLowerCase());
    if (!match) {
      const available = devices.map((d) => `"${d.name}"`).join(', ') || '(ни одного — Spotify нигде не открыт)';
      throw new Error(
        `Устройство SPOTIFY_DEVICE_NAME="${this.deviceName}" не найдено. Доступные сейчас устройства: ${available}.`,
      );
    }
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

  /** Немедленно запускает конкретный трек (используется для заказов). */
  async playTrackUri(uri: string): Promise<void> {
    const deviceId = await this.resolveDeviceId();
    const res = await this.fetchImpl(this.buildPlayerUrl('/play', deviceId), {
      method: 'PUT',
      headers: { ...(await this.authHeaders()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: [uri] }),
    });
    if (!res.ok && res.status !== 204) {
      throw new Error(this.playbackErrorMessage('запустить трек', res.status));
    }
  }

  /** Запускает плейлист/альбом по его context uri (используется для дефолтного плейлиста). */
  async playContext(contextUri: string): Promise<void> {
    const deviceId = await this.resolveDeviceId();
    const res = await this.fetchImpl(this.buildPlayerUrl('/play', deviceId), {
      method: 'PUT',
      headers: { ...(await this.authHeaders()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ context_uri: contextUri }),
    });
    if (!res.ok && res.status !== 204) {
      throw new Error(this.playbackErrorMessage('запустить плейлист', res.status));
    }
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

  private playbackErrorMessage(action: string, status: number): string {
    const base = `Не удалось ${action} в Spotify: HTTP ${status}`;
    return status === 404 ? `${base}. ${NO_ACTIVE_DEVICE_HINT}` : base;
  }
}
