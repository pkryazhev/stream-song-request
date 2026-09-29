import { logger } from '../core/logger.ts';
import type { PlaybackSession } from './youtubePlayer.ts';

/** Минимум от Spotify-контроллера, нужный плееру (см. SpotifyPlaybackController). */
export interface SpotifyPlayerApi {
  getCurrentPlayback(): Promise<{
    isPlaying: boolean;
    progressMs: number;
    durationMs: number;
    trackUri: string | null;
  } | null>;
  playTrackUri(uri: string): Promise<void>;
  skipToNext(): Promise<void>;
}

export interface SpotifyTrackPlayerOptions {
  /** Как часто опрашивать Spotify, пока трек играет, мс (SPOTIFY_POLL_INTERVAL_MS). */
  pollIntervalMs: number;
  /** Как часто опрашивать, пока ждём, что трек начал играть, мс (по умолчанию 1 с, но не реже pollIntervalMs). */
  startPollIntervalMs?: number;
}

/** Сколько опросов подряд ждать, пока трек начнёт играть, прежде чем сдаться. */
const MAX_START_POLLS = 12;
/** Через сколько опросов "ничего не играет" повторить команду запуска. */
const RESEND_AFTER_POLLS = 4;
/** Сколько раз можно нажать "следующий", если заиграл чужой трек из очереди Spotify. */
const MAX_EXTRA_SKIPS = 3;
/** Сколько сетевых сбоев подряд терпеть. */
const MAX_CONSECUTIVE_ERRORS = 5;
/**
 * Когда до конца трека остаётся меньше этого — перестаём опрашивать и просто
 * дожидаемся конца по часам. Опрос ближе к концу бессмыслен: Spotify может
 * уже переключиться на что-то своё (автовоспроизведение).
 */
const END_LEAD_MS = 2000;
/**
 * На сколько раньше конца трека отдавать управление дальше. Совсем чуть-чуть:
 * если дождаться ровно конца, Spotify успевает включить своё
 * автовоспроизведение, и оно на долю секунды прорывается между треками.
 */
const HANDOFF_EARLY_MS = 300;
/** Трек на паузе ближе этого к концу (или на нуле) — считаем, что он закончился. */
const ENDED_NEAR_END_MS = 2500;

/**
 * Играет один трек через Spotify и сообщает (session.finished), когда он
 * закончился. У Spotify Web API нет событий "трек закончился", поэтому
 * состояние опрашивается. Правила:
 *
 *  1. Запуск. playTrackUri() и ждём, пока Spotify отчитается, что играет
 *     именно наш трек. Если играет чужой (застрял в очереди Spotify) —
 *     жмём "следующий", пока не дойдём до нашего. Если ничего не играет —
 *     через несколько опросов повторяем запуск. Не заиграл совсем — ошибка.
 *  2. Трек играет. Конец — это когда Spotify переключился на другой трек или
 *     остановился в самом конце. Ручная пауза посреди трека концом не
 *     считается — ждём дальше. Единичный сетевой сбой — тоже.
 *  3. Последние секунды не обрезаются: когда до конца остаётся END_LEAD_MS,
 *     ждём по часам почти до самого конца (без HANDOFF_EARLY_MS).
 *
 * stop() (скип) просто прекращает ожидание — что играть дальше (или
 * поставить Spotify на паузу), решает оркестратор.
 */
export function playSpotifyTrack(
  spotify: SpotifyPlayerApi,
  uri: string,
  options: SpotifyTrackPlayerOptions,
): PlaybackSession {
  let stopped = false;
  let wake: (() => void) | undefined;

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (stopped) return resolve();
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      }
      wake = done;
    });

  const poll = async (): Promise<Awaited<ReturnType<SpotifyPlayerApi['getCurrentPlayback']>> | 'error'> => {
    try {
      return await spotify.getCurrentPlayback();
    } catch (err) {
      logger.error('playback', 'Не удалось опросить Spotify (временный сбой?)', err);
      return 'error';
    }
  };

  const finished = (async () => {
    await spotify.playTrackUri(uri);

    // --- 1. Ждём, пока заиграет именно наш трек ---
    const startPollMs = options.startPollIntervalMs ?? Math.min(1000, options.pollIntervalMs);
    let errors = 0;
    let idlePolls = 0;
    let foreignPolls = 0;
    let extraSkips = 0;
    let started = false;
    for (let attempt = 0; attempt < MAX_START_POLLS && !stopped; attempt++) {
      await sleep(startPollMs);
      if (stopped) return;
      const pb = await poll();
      if (pb === 'error') {
        if (++errors >= MAX_CONSECUTIVE_ERRORS) throw new Error('Spotify не отвечает — не удалось запустить трек');
        continue;
      }
      errors = 0;
      if (pb && pb.trackUri === uri && pb.isPlaying) {
        started = true;
        break;
      }
      if (pb && pb.trackUri && pb.trackUri !== uri && pb.isPlaying) {
        // Играет чужой трек. Даём Spotify один опрос "на переключение", потом
        // жмём "следующий": наш трек стоит в очереди Spotify где-то дальше.
        if (++foreignPolls >= 2 && extraSkips < MAX_EXTRA_SKIPS) {
          extraSkips++;
          foreignPolls = 0;
          logger.warn('playback', `Spotify играет не тот трек (${pb.trackUri}) — переключаю на следующий в очереди`);
          await spotify.skipToNext();
        }
        continue;
      }
      // Ничего не играет (или наш трек, но на паузе) — через несколько опросов повторяем запуск.
      if (++idlePolls === RESEND_AFTER_POLLS) {
        logger.warn('playback', `Spotify не начал играть ${uri} — повторяю запуск`);
        await spotify.playTrackUri(uri);
      }
    }
    if (stopped) return;
    if (!started) throw new Error(`Spotify так и не начал играть трек ${uri}`);

    // --- 2. Трек играет — ждём конца ---
    errors = 0;
    let waitMs = options.pollIntervalMs;
    for (;;) {
      await sleep(waitMs);
      if (stopped) return;
      const pb = await poll();
      if (pb === 'error') {
        if (++errors >= MAX_CONSECUTIVE_ERRORS) {
          throw new Error('Spotify перестал отвечать посреди трека — перехожу к следующему');
        }
        waitMs = options.pollIntervalMs;
        continue;
      }
      errors = 0;

      // Spotify ушёл на другой трек или устройство пропало — наш закончился (или его переключили вручную).
      if (!pb || pb.trackUri !== uri) return;

      const remaining = pb.durationMs - pb.progressMs;
      if (!pb.isPlaying) {
        if (pb.progressMs === 0 || remaining <= ENDED_NEAR_END_MS) return;
        // Пауза посреди трека (например, стример нажал паузу в Spotify) — ждём.
        waitMs = options.pollIntervalMs;
        continue;
      }

      if (remaining <= END_LEAD_MS) {
        // --- 3. Доигрываем хвост по часам ---
        await sleep(Math.max(remaining - HANDOFF_EARLY_MS, 0));
        return;
      }
      waitMs = Math.min(options.pollIntervalMs, remaining - END_LEAD_MS);
    }
  })();

  return {
    finished,
    stop: () => {
      stopped = true;
      wake?.();
    },
  };
}
