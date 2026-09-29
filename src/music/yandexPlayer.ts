import {
  spawnPlaybackProcess,
  buildVolumeArg,
  buildAudioDeviceArg,
  type PlaybackSession,
  type YoutubePlaybackOptions,
} from './youtubePlayer.ts';
import type { YandexPlayback } from './yandexMusicProvider.ts';

/** Громкость и аудио-устройство mpv — те же, что у YouTube-заказов (MPV_VOLUME, MPV_AUDIO_DEVICE). */
export type YandexPlaybackOptions = Pick<YoutubePlaybackOptions, 'volume' | 'audioDevice'>;

/**
 * Экспортировано отдельно ради юнит-тестов. Поправка громкости (выравнивание
 * под Spotify, см. resolveYandexPlayback) применяется фильтром ffmpeg поверх
 * MPV_VOLUME, а не вместо неё.
 */
export function buildMpvUrlArgs(playback: YandexPlayback, options: YandexPlaybackOptions): string[] {
  const gainArg = playback.gainDb ? [`--af=lavfi=[volume=${playback.gainDb}dB]`] : [];
  return [...buildVolumeArg(options), ...buildAudioDeviceArg(options), ...gainArg, '--no-video', playback.streamUrl];
}

/**
 * Воспроизводит трек Яндекс Музыки через mpv. В отличие от YouTube, yt-dlp
 * здесь не нужен: mpv сам скачивает прямую mp3-ссылку. Ссылку получаем
 * асинхронно (resolvePlayback), поэтому сессия возвращается сразу, а mpv
 * запускается, когда ссылка готова. Если скип пришёл раньше, mpv не
 * запускается вовсе.
 *
 * spawn передаётся параметром ради тестов, как в spawnYtdlpMpvPipeline.
 */
export function playYandexTrack(
  resolvePlayback: () => Promise<YandexPlayback>,
  mpvPath = 'mpv',
  options: YandexPlaybackOptions = {},
  spawn: (command: string, args: string[]) => PlaybackSession = spawnPlaybackProcess,
): PlaybackSession {
  let stopped = false;
  let inner: PlaybackSession | undefined;
  let onAudioStarted: () => void = () => {};
  const audioStarted = new Promise<void>((resolve) => (onAudioStarted = resolve));

  const finished = (async () => {
    const playback = await resolvePlayback();
    if (stopped) return;
    inner = spawn(mpvPath, buildMpvUrlArgs(playback, options));
    void inner.audioStarted?.then(onAudioStarted);
    await inner.finished;
  })();

  return {
    finished,
    stop: () => {
      stopped = true;
      inner?.stop();
    },
    audioStarted,
  };
}
