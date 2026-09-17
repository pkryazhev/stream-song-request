import { eventBus } from '../core/eventBus.ts';
import { logger } from '../core/logger.ts';
import { isRequestsPaused } from './requestsGate.ts';
import type { QueuedSongRequest } from '../db/musicQueue.ts';
import type { SongProvider } from '../core/events.ts';

export interface SpotifyPlaybackLike {
  getCurrentPlayback(): Promise<{
    isPlaying: boolean;
    progressMs: number;
    durationMs: number;
    trackUri: string | null;
    /** Опционально: не все тесты/заглушки его задают, но реальный контроллер — всегда. */
    trackTitle?: string | null;
    trackArtist?: string | null;
  } | null>;
  playTrackUri(uri: string): Promise<void>;
  playContext(contextUri: string): Promise<void>;
  pause(): Promise<void>;
}

/** Трек, который сейчас играет — для команды "текущий трек" в чате (см. currentTrackHandler.ts). */
export interface CurrentTrackInfo {
  provider: SongProvider;
  title: string;
  author: string;
}

export interface YoutubePlayerLike {
  play(url: string): { finished: Promise<void>; stop: () => void };
}

export interface QueueLike {
  peekNextPending(): QueuedSongRequest | undefined;
  markPlaying(id: number): void;
  markDone(id: number): void;
}

export interface OrchestratorConfig {
  /**
   * context uri дефолтного плейлиста Spotify, например spotify:playlist:xxxx.
   * null — Spotify не настроен вовсе (см. SpotifyPlaybackLike | null ниже) —
   * тогда это значение никогда не используется.
   */
  defaultPlaylistUri: string | null;
  /** За сколько мс до конца трека считать, что "трек почти закончился" */
  endOfTrackThresholdMs: number;
  /** Как часто опрашивать Spotify Player API, мс */
  pollIntervalMs: number;
}

type Mode = 'default' | 'request';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Переключение между дефолтным плейлистом Spotify и очередью заказов.
 *
 * Правила (по требованиям):
 *  - пока играет дефолтный плейлист, заказы не прерывают текущий трек —
 *    переключение происходит только когда текущий трек почти закончился;
 *  - между заказами нет приоритета — обрабатываются строго по очереди (FIFO);
 *  - когда очередь заказов опустела — снова запускается дефолтный плейлист;
 *  - зрители (или сам стример) могут проголосовать за скип текущего заказа
 *    через чат — см. skip() и skipVoteHandler.ts.
 *
 * YouTube-треки играют через локальный процесс-плеер (mpv) — там реальный
 * сигнал о завершении есть (`session.finished` резолвится, когда процесс
 * mpv сам завершается), никакого поллинга не нужно.
 *
 * Со Spotify так не получится: Web API — это обычный REST, без push-
 * уведомлений о смене трека, поэтому состояние приходится опрашивать
 * (`getCurrentPlayback`). Но раз каждый опрос всё равно возвращает
 * duration/progress трека, можно не ждать вслепую фиксированный интервал —
 * а точно посчитать, сколько миллисекунд осталось до момента, когда трек
 * войдёт в окно "почти закончился", и запланировать следующую проверку
 * прямо на этот момент (см. scheduleNearEndCheck ниже и аналогичную логику
 * в waitForSpotifyTrackToFinish). Это не настоящий push от Spotify, но по
 * итогу ведёт себя так же точно, и не зависит от того, насколько часто
 * настроен "обычный" опрос (pollIntervalMs).
 *
 * Spotify целиком опционален (spotify: SpotifyPlaybackLike | null) — если он
 * не настроен (см. config.ts), нет ни дефолтного плейлиста, ни самой
 * возможности им управлять. В этом режиме нет смысла "ждать, пока текущий
 * трек почти закончится" — ждать нечего, дефолтного трека нет — поэтому
 * любой заказ из очереди играется сразу же, как только освобождается плеер.
 */
export class PlaybackOrchestrator {
  private mode: Mode = 'default';
  private timer: ReturnType<typeof setInterval> | undefined;
  private nearEndTimer: ReturnType<typeof setTimeout> | undefined;
  private stopCurrentYoutube: (() => void) | undefined;
  private busy = false;
  private skipRequested = false;
  private skipWaiters: Array<() => void> = [];
  private currentRequestTrack: CurrentTrackInfo | null = null;
  private readonly spotify: SpotifyPlaybackLike | null;
  private readonly youtubePlayer: YoutubePlayerLike;
  private readonly queue: QueueLike;
  private readonly cfg: OrchestratorConfig;

  constructor(
    spotify: SpotifyPlaybackLike | null,
    youtubePlayer: YoutubePlayerLike,
    queue: QueueLike,
    cfg: OrchestratorConfig,
  ) {
    this.spotify = spotify;
    this.youtubePlayer = youtubePlayer;
    this.queue = queue;
    this.cfg = cfg;
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.cfg.pollIntervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.clearNearEndTimer();
    this.stopCurrentYoutube?.();
  }

  getMode(): Mode {
    return this.mode;
  }

  /**
   * Трек, который сейчас реально играет — для команды "текущий трек" в чате
   * (см. currentTrackHandler.ts). Во время заказа (mode === 'request') это
   * заранее известные данные из очереди (см. playRequestsUntilEmpty), без
   * лишнего запроса к Spotify. Во время дефолтного плейлиста единственный
   * источник этой информации — сам Spotify (mpv/YouTube для дефолта не
   * используется), поэтому опрашиваем его прямо по запросу команды, а не
   * храним из обычного tick() — иначе пришлось бы плодить лишнее состояние,
   * которое почти всегда никому не нужно.
   */
  async getCurrentTrack(): Promise<CurrentTrackInfo | null> {
    if (this.mode === 'request') return this.currentRequestTrack;

    const spotify = this.spotify;
    if (!spotify) return null;
    try {
      const playback = await spotify.getCurrentPlayback();
      if (!playback || !playback.isPlaying || !playback.trackTitle) return null;
      return { provider: 'spotify', title: playback.trackTitle, author: playback.trackArtist ?? '' };
    } catch (err) {
      logger.error('playback', 'Не удалось получить текущий трек Spotify для команды "текущий трек"', err);
      return null;
    }
  }

  /**
   * Скипает текущий заказ (по голосованию зрителей или команде стримера —
   * см. skipVoteHandler.ts). Работает только пока реально играет заказ
   * (mode === 'request') — во время дефолтного плейлиста скипать нечего,
   * заказ ещё не начал играть. Возвращает true, если скип был применён.
   *
   * Для YouTube — просто останавливает текущий mpv-процесс (тот же
   * механизм, что и обычная остановка при shutdown). Для Spotify — мы не
   * управляем самим треком напрямую (см. playRequestsUntilEmpty — переход
   * между заказами и так каждый раз явно указывает Spotify, что играть
   * дальше), а лишь досрочно будим цикл ожидания waitForSpotifyTrackToFinish
   * через interruptibleSleep, чтобы не ждать вслепую до следующего
   * запланированного опроса.
   */
  skip(): boolean {
    if (this.mode !== 'request') return false;
    this.skipRequested = true;
    this.stopCurrentYoutube?.();
    this.resolveSkipWaiters();
    return true;
  }

  private resolveSkipWaiters(): void {
    const waiters = this.skipWaiters;
    this.skipWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Как sleep(), но резолвится досрочно, если за это время вызвали skip(). */
  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const onSkip = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.skipWaiters = this.skipWaiters.filter((waiter) => waiter !== onSkip);
        resolve();
      }, ms);
      this.skipWaiters.push(onSkip);
    });
  }

  /** Один шаг цикла. Публичный — чтобы тесты могли дёргать его вручную, без реальных таймеров. */
  async tick(): Promise<void> {
    if (this.busy || this.mode !== 'default') return;
    this.busy = true;
    this.clearNearEndTimer();
    try {
      const spotify = this.spotify;

      if (!spotify) {
        // Youtube-only режим: нет дефолтного трека, дожидаться "почти
        // конца" нечего — любой заказ из очереди играется немедленно.
        const next = this.queue.peekNextPending();
        if (next) {
          await this.playRequestsUntilEmpty(next);
        }
        return;
      }

      const playback = await spotify.getCurrentPlayback();

      if (!playback || !playback.isPlaying) {
        await this.ensureDefaultPlaying();
        return;
      }

      const next = this.queue.peekNextPending();
      const remaining = playback.durationMs - playback.progressMs;

      if (remaining <= this.cfg.endOfTrackThresholdMs) {
        if (next) {
          await this.playRequestsUntilEmpty(next);
        }
        return;
      }

      // Трек ещё не подходит к концу. Если в очереди есть заказ — не ждём
      // вслепую следующего "обычного" опроса (он может проскочить нужный
      // момент, см. spotifyPollTiming.ts) — а точно планируем проверку
      // прямо на момент, когда трек должен войти в окно "почти закончился".
      if (next) {
        this.scheduleNearEndCheck(remaining - this.cfg.endOfTrackThresholdMs);
      }
    } catch (err) {
      logger.error('playback', 'Ошибка в цикле оркестратора воспроизведения', err);
    } finally {
      this.busy = false;
    }
  }

  private clearNearEndTimer(): void {
    if (this.nearEndTimer) {
      clearTimeout(this.nearEndTimer);
      this.nearEndTimer = undefined;
    }
  }

  /**
   * Планирует дополнительную (вне обычного pollIntervalMs) проверку прямо
   * на момент, когда трек должен войти в окно "почти закончился" — вместо
   * того чтобы полагаться на то, что обычный опрос случайно попадёт в это
   * окно. MIN_DELAY_MS — просто подстраховка, чтобы не долбить Spotify API
   * чаще пары раз в секунду, если расчёт вдруг даст что-то совсем крошечное.
   */
  private scheduleNearEndCheck(delayMs: number): void {
    const MIN_DELAY_MS = 250;
    this.nearEndTimer = setTimeout(() => void this.tick(), Math.max(delayMs, MIN_DELAY_MS));
  }

  private async ensureDefaultPlaying(): Promise<void> {
    const spotify = this.spotify;
    if (!spotify || !this.cfg.defaultPlaylistUri) return;
    // Заказы приостановлены командой !pr (см. requestsToggleHandler.ts) —
    // дефолтный плейлист тоже не должен играть, иначе он бы сам возобновлялся
    // на каждом тике сразу после halt'а из этой же команды.
    if (isRequestsPaused()) return;
    try {
      await spotify.playContext(this.cfg.defaultPlaylistUri);
    } catch (err) {
      logger.error('playback', 'Не удалось запустить дефолтный плейлист', err);
    }
  }

  /**
   * Немедленно останавливает дефолтный плейлист — используется командой !pr.
   * Без этого метода пришлось бы просто вызвать spotify.pause() и ждать —
   * но обычный tick() каждый pollIntervalMs видит "ничего не играет" и сам
   * вызывает ensureDefaultPlaying(), т.е. без учёта requestsGate воспроизведение
   * само возобновилось бы в течение нескольких секунд (это и есть тот эффект,
   * когда "поставили на паузу, а через некоторое время само заиграло").
   * ensureDefaultPlaying() теперь проверяет isRequestsPaused() и не даёт tick()
   * перезапустить плейлист, пока заказы приостановлены.
   * Не трогает ничего, если сейчас играет заказ (mode === 'request') — это
   * не дефолтный плейлист, останавливать его через эту команду не нужно.
   */
  async haltDefaultPlaylist(): Promise<void> {
    if (this.mode !== 'default') return;
    const spotify = this.spotify;
    if (!spotify) return;
    try {
      await spotify.pause();
    } catch (err) {
      logger.error('playback', 'Не удалось остановить дефолтный плейлист (команда !pr)', err);
    }
  }

  private async playRequestsUntilEmpty(first: QueuedSongRequest): Promise<void> {
    this.mode = 'request';
    let current: QueuedSongRequest | undefined = first;

    while (current) {
      // Сбрасываем на каждый новый заказ — иначе skip(), вызванный во время
      // YouTube-заказа (где skipRequested сам по себе не используется —
      // там достаточно stopCurrentYoutube), мог бы "утечь" и на следующий
      // заказ, если тот окажется через Spotify, и оборвать его раньше времени.
      this.skipRequested = false;
      this.queue.markPlaying(current.id);
      this.currentRequestTrack = { provider: current.provider, title: current.title, author: current.author };
      eventBus.emit('song.now_playing', {
        title: current.title,
        provider: current.provider,
        requestedById: current.requestedById,
      });
      logger.info('playback', `Играет заказ: "${current.title}" (${current.provider})`);

      try {
        if (current.provider === 'spotify') {
          const spotify = this.spotify;
          if (!spotify) {
            // Не должно происходить в норме — заказы через Spotify не
            // должны попадать в очередь, пока Spotify не настроен (см.
            // requestHandler.ts). Подстраховка на случай рассинхронизации
            // (например, Spotify отключили в .env, пока в очереди уже был
            // старый заказ) — пропускаем его, а не падаем.
            logger.error(
              'playback',
              `Заказ "${current.title}" — трек Spotify, но Spotify сейчас не настроен, пропускаю заказ`,
            );
          } else {
            await spotify.playTrackUri(current.playUri);
            await this.waitForSpotifyTrackToFinish(spotify);
          }
        } else {
          // Spotify играет через отдельное устройство (Spotify Connect) и
          // ничего не знает про mpv — если его не поставить на паузу явно,
          // он продолжает проигрывать дефолтный плейлист поверх YouTube-
          // заказа. Сбой самой паузы (сеть и т.п.) не должен отменять
          // проигрывание YouTube-заказа — поэтому отдельный try/catch.
          if (this.spotify) {
            try {
              await this.spotify.pause();
            } catch (err) {
              logger.error(
                'playback',
                'Не удалось поставить Spotify на паузу перед YouTube-заказом — запускаю YouTube всё равно',
                err,
              );
            }
          }
          const session = this.youtubePlayer.play(current.playUri);
          this.stopCurrentYoutube = session.stop;
          await session.finished;
          this.stopCurrentYoutube = undefined;
        }
      } catch (err) {
        logger.error('playback', `Ошибка воспроизведения заказа "${current.title}"`, err);
      }

      this.queue.markDone(current.id);
      current = this.queue.peekNextPending();
    }

    this.currentRequestTrack = null;
    this.mode = 'default';
    await this.ensureDefaultPlaying();
  }

  /**
   * Опрашивает Spotify, пока не станет ясно, что трек закончился (или
   * не играет). Сетевые запросы время от времени падают с транзиентными
   * ошибками (обрыв соединения, TLS-хендшейк и т.п.) — раньше такая ошибка
   * вылетала прямо наружу из playRequestsUntilEmpty, заказ считался
   * "не удался" и обрывался на середине, хотя реально всё ещё играл.
   * Теперь единичные сбои просто логируются и опрос продолжается — трек
   * считается прерванным по сети только после нескольких сбоев подряд.
   *
   * Первая пауза — фиксированный pollIntervalMs (даём Spotify время принять
   * playTrackUri и начать отдавать актуальный progress). Дальше, раз мы уже
   * знаем duration/progress трека, каждая следующая пауза вычисляется точно
   * под момент, когда трек должен войти в окно "почти закончился" — вместо
   * того чтобы вслепую ждать pollIntervalMs и рисковать проскочить его.
   *
   * Каждая пауза — interruptibleSleep(), а не обычный sleep(): если за это
   * время вызвали skip(), ждать дальше нет смысла — сразу возвращаемся, и
   * playRequestsUntilEmpty переходит к следующему заказу (или дефолтному
   * плейлисту), что само по себе переключает Spotify на что-то другое.
   */
  private async waitForSpotifyTrackToFinish(spotify: SpotifyPlaybackLike): Promise<void> {
    const MAX_CONSECUTIVE_ERRORS = 5;
    const MIN_WAIT_MS = 250;
    let consecutiveErrors = 0;
    let waitMs = this.cfg.pollIntervalMs;

    for (;;) {
      await this.interruptibleSleep(waitMs);
      if (this.skipRequested) {
        this.skipRequested = false;
        return;
      }

      let playback: Awaited<ReturnType<SpotifyPlaybackLike['getCurrentPlayback']>>;
      try {
        playback = await spotify.getCurrentPlayback();
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors += 1;
        logger.error(
          'playback',
          `Не удалось опросить статус воспроизведения Spotify (попытка ${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}), считаю это временным сбоем сети и пробую ещё раз`,
          err,
        );
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          logger.error('playback', 'Слишком много сбоев подряд при опросе Spotify, прекращаю ждать этот трек');
          return;
        }
        // Не знаем актуальный remaining (запрос не удался) — возвращаемся
        // к обычному интервалу для следующей попытки.
        waitMs = this.cfg.pollIntervalMs;
        continue;
      }

      if (!playback) return;
      const remaining = playback.durationMs - playback.progressMs;
      if (!playback.isPlaying || remaining <= this.cfg.endOfTrackThresholdMs) {
        return;
      }
      waitMs = Math.max(remaining - this.cfg.endOfTrackThresholdMs, MIN_WAIT_MS);
    }
  }
}
