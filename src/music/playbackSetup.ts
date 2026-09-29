import { config } from '../core/config.ts';
import { logger } from '../core/logger.ts';
import { createSpotifyUserTokenStore } from './spotifyAuth.ts';
import { SpotifyPlaybackController } from './spotifyProvider.ts';
import { playYoutubeUrl } from './youtubePlayer.ts';
import { playYandexTrack } from './yandexPlayer.ts';
import { parseYandexPlayUri, resolveYandexPlayback } from './yandexMusicProvider.ts';
import { fetchYandexPlaylistTracks } from './yandexPlaylist.ts';
import type { DefaultPlaylistLoader, YoutubePlayerLike } from './playbackOrchestrator.ts';

/**
 * Сборка плееров из config — общая для приложения (index.ts) и проверки
 * перед стримом (scripts/music-check.ts), чтобы проверка играла музыку ровно
 * тем же кодом, что и стрим.
 */

/** null — Spotify не настроен. */
export function createSpotifyController(): SpotifyPlaybackController | null {
  if (!config.spotify) return null;
  const spotifyUserTokens = createSpotifyUserTokenStore({
    clientId: config.spotify.clientId,
    clientSecret: config.spotify.clientSecret,
    tokenFilePath: config.spotify.tokenFilePath,
  });
  if (!spotifyUserTokens.load()) {
    logger.error(
      'app',
      `Нет сохранённого Spotify-токена (${config.spotify.tokenFilePath}). Запусти "npm run auth:spotify" перед первым стартом.`,
    );
  }
  return new SpotifyPlaybackController(spotifyUserTokens, fetch, config.spotify.deviceName);
}

/**
 * Всё, что не Spotify, играет mpv: заказы Яндекс Музыки хранятся в очереди
 * как yandex:track:<id>, остальное — ссылки на YouTube.
 */
export function createMpvPlayer(): YoutubePlayerLike {
  return {
    play: (url) => {
      const yandexTrackId = parseYandexPlayUri(url);
      if (yandexTrackId !== null) {
        const token = config.yandexMusic?.token;
        if (!token) {
          // Заказ попал в очередь, пока токен был, а потом его убрали из .env.
          return {
            finished: Promise.reject(new Error('Заказ из Яндекс Музыки, но YANDEX_MUSIC_TOKEN не задан')),
            stop: () => {},
          };
        }
        const targetLufs = config.yandexMusic?.loudnessTargetLufs ?? null;
        return playYandexTrack(() => resolveYandexPlayback(yandexTrackId, token, targetLufs), config.mpvPath, {
          volume: config.youtube.volume,
          audioDevice: config.youtube.audioDevice,
        });
      }
      return playYoutubeUrl(url, config.mpvPath, {
        playerClient: config.youtube.playerClient,
        cookiesFromBrowser: config.youtube.cookiesFromBrowser,
        cookiesFile: config.youtube.cookiesFile,
        ytdlPath: config.youtube.ytdlPath,
        forceIpv4: config.youtube.forceIpv4,
        volume: config.youtube.volume,
        audioDevice: config.youtube.audioDevice,
      });
    },
  };
}

/**
 * Откуда брать треки для таблицы дефолтного плейлиста. config.ts гарантирует,
 * что задан не больше чем один плейлист: Spotify (SPOTIFY_DEFAULT_PLAYLIST_URI)
 * или Яндекс Музыка (YANDEX_DEFAULT_PLAYLIST_URL).
 */
export function createDefaultPlaylistLoader(
  spotifyController: SpotifyPlaybackController | null,
): DefaultPlaylistLoader | null {
  const yandex = config.yandexMusic;
  if (yandex?.defaultPlaylist) {
    const ref = yandex.defaultPlaylist.ref;
    return () => fetchYandexPlaylistTracks(ref, yandex.token);
  }
  const playlistUri = config.spotify?.defaultPlaylistUri;
  if (spotifyController && playlistUri) {
    const controller = spotifyController;
    return async () =>
      (await controller.fetchPlaylistTracks(playlistUri)).map((t) => ({
        provider: 'spotify' as const,
        playUri: t.uri,
        title: t.title,
        author: t.artist,
        durationSec: Math.round(t.durationMs / 1000),
      }));
  }
  logger.warn('app', 'Дефолтный плейлист не задан — между заказами будет тишина.');
  return null;
}
