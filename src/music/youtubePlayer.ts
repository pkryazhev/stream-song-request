import { spawn, execFile } from 'node:child_process';

export interface PlaybackSession {
  /** Резолвится, когда воспроизведение естественным образом завершилось. */
  finished: Promise<void>;
  /** Принудительно остановить (скип). */
  stop: () => void;
}

/**
 * Запускает произвольный процесс-плеер и оборачивает его в PlaybackSession.
 * Вынесено отдельно от playYoutubeUrl(), чтобы быть тестируемым без mpv —
 * в тестах сюда подставляется сам node с простым скриптом.
 */
const MAX_CAPTURED_OUTPUT = 4000;

export function spawnPlaybackProcess(command: string, args: string[]): PlaybackSession {
  // Раньше stdio был 'ignore' с флагом --really-quiet у mpv — в случае
  // ошибки (например, yt-dlp не смог разобрать ссылку) наружу летел только
  // голый код выхода, без единой подсказки, что именно пошло не так.
  // Теперь вывод процесса перехватывается (а не выводится в наш собственный
  // терминал) и при ненулевом коде выхода прикладывается к ошибке.
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stopped = false;
  let capturedOutput = '';

  const captureChunk = (chunk: Buffer): void => {
    capturedOutput += chunk.toString('utf8');
    if (capturedOutput.length > MAX_CAPTURED_OUTPUT) {
      capturedOutput = capturedOutput.slice(capturedOutput.length - MAX_CAPTURED_OUTPUT);
    }
  };
  child.stdout?.on('data', captureChunk);
  child.stderr?.on('data', captureChunk);

  const finished = new Promise<void>((resolve, reject) => {
    child.on('exit', (code) => {
      if (stopped || code === 0 || code === null) {
        resolve();
      } else {
        const details = capturedOutput.trim();
        const suffix = details ? `\n--- вывод "${command}" ---\n${details}` : ' (без вывода в stdout/stderr)';
        reject(new Error(`Процесс плеера "${command}" завершился с кодом ${code}${suffix}`));
      }
    });
    child.on('error', (err) => reject(err));
  });

  return {
    finished,
    stop: () => {
      stopped = true;
      killProcess(child);
    },
  };
}

/**
 * Останавливает процесс плеера (используется для скипа). На всех ОС, кроме
 * Windows, обычный child.kill('SIGTERM') работает нормально.
 *
 * На Windows — нет: Node.js там лишь эмулирует POSIX-сигналы, а
 * child.kill() под капотом сводится к TerminateProcess только для САМОГО
 * процесса mpv, но не для его дочерних процессов (mpv через ytdl_hook сам
 * запускает yt-dlp как подпроцесс, чтобы разобрать ссылку и получить прямой
 * URL потока). На практике это плохо ловится тестами (нужна реальная
 * Windows-машина), но именно это — известная и частая причина, почему
 * "скип" визуально срабатывает (следующий трек в очереди стартует), а
 * прошлый процесс mpv из-за этого не завершается и продолжает играть
 * параллельно с новым (два трека одновременно). taskkill с /T (дерево
 * процессов, то есть и сам процесс, и все его потомки) и /F (принудительно)
 * останавливает его гарантированно.
 */
function killProcess(child: ReturnType<typeof spawn>): void {
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {
      // Ошибку игнорируем: например, если процесс уже успел завершиться
      // сам между вызовом stop() и запуском taskkill (гонка) — taskkill
      // вернёт "process not found", это не проблема, а не сбой скипа.
    });
    return;
  }
  child.kill('SIGTERM');
}

export interface YoutubePlaybackOptions {
  /**
   * Какого "клиента" YouTube изображает yt-dlp при запросе видео — например
   * "tv" или "android_vr". YouTube в 2025 постепенно требует т.н. PO Token
   * почти для всех клиентов, кроме нескольких — запрос от их имени сейчас
   * работает и без токена/кук ("Sign in to confirm you're not a bot").
   * Пусто/undefined — extractor-args не передаётся вообще.
   */
  playerClient?: string;
  /** Имя браузера для --cookies-from-browser (firefox/chrome/edge/...). */
  cookiesFromBrowser?: string;
  /** Путь к cookies.txt в формате Netscape — альтернатива cookiesFromBrowser. */
  cookiesFile?: string;
  /**
   * Явный путь к исполняемому файлу yt-dlp, который должен использовать
   * mpv (--script-opts=ytdl_hook-ytdl_path=...), вместо того, что первым
   * найдётся в PATH. Полезно, если на машине несколько установок yt-dlp
   * (например, winget поставил один, а рядом вручную положен более свежий
   * .exe) — mpv может резолвить не тот, который реально обновлялся.
   */
  ytdlPath?: string;
  /**
   * Заставляет yt-dlp резолвить видео только по IPv4 (yt-dlp --force-ipv4).
   * Помогает с "HTTP error 403 Forbidden" при собственно проигрывании (уже
   * после успешного разбора ссылки) на dual-stack (IPv4+IPv6) сетях: ссылка
   * на googlevideo.com привязывается к IP, с которого её запросил yt-dlp —
   * если сам mpv потом обращается к ней с другого IP (например, IPv6, пока
   * yt-dlp использовал IPv4, или наоборот), YouTube отвечает 403. Помогает
   * не всегда (у mpv нет отдельного способа принудительно указать IP-семью
   * для собственного запроса) — если не помогло, следующий шаг уже на
   * уровне ОС (см. .env.example).
   */
  forceIpv4?: boolean;
  /**
   * Громкость плеера при старте (0-100 согласно масштабу громкости mpv по
   * умолчанию — --volume-max=100 из коробки). Раньше mpv стартовал со своей
   * собственной громкостью по умолчанию (обычно 100), из-за чего YouTube-
   * заказы часто включались заметно громче, чем играл до этого Spotify.
   * undefined — флаг --volume вообще не передаётся (используется дефолт mpv).
   */
  volume?: number;
  /**
   * Имя аудио-устройства, на которое mpv должен выводить звук — например
   * "wasapi/{GUID-устройства}" или просто часть названия вроде "CABLE Input"
   * (см. MPV_AUDIO_DEVICE в .env.example для инструкции, как узнать точное
   * значение). Нужно, чтобы в OBS можно было захватить звук именно
   * YouTube-заказов отдельно от остального звука системы — например, через
   * виртуальный аудио-кабель (VB-CABLE и т.п.). undefined — флаг
   * --audio-device вообще не передаётся, используется устройство по
   * умолчанию (то же, что и у остальной системы).
   */
  audioDevice?: string;
}

/**
 * mpv-совместимое экранирование значения для list-опций (--ytdl-raw-options
 * и т.п.): значение оборачивается в %<длина в байтах>%<значение>. Без этого
 * любой ":" или "," внутри значения (например, "youtube:player_client=tv"
 * или путь на Windows "C:\Users\...\cookies.txt") ломает разбор опции у mpv
 * (см. https://github.com/mpv-player/mpv/issues/8021) — экранируем всегда,
 * чтобы не зависеть от того, какие символы окажутся в конкретном значении.
 */
export function mpvEscapeListValue(value: string): string {
  const byteLength = Buffer.byteLength(value, 'utf8');
  return `%${byteLength}%${value}`;
}

/** Экспортировано отдельно ради юнит-тестов — сборку строки проще проверить напрямую, без реального mpv. */
export function buildYtdlRawOptionsArg(options: YoutubePlaybackOptions): string[] {
  const pairs: string[] = [];
  if (options.playerClient) {
    pairs.push(`extractor-args=${mpvEscapeListValue(`youtube:player_client=${options.playerClient}`)}`);
  }
  if (options.cookiesFromBrowser) {
    pairs.push(`cookies-from-browser=${mpvEscapeListValue(options.cookiesFromBrowser)}`);
  } else if (options.cookiesFile) {
    pairs.push(`cookies=${mpvEscapeListValue(options.cookiesFile)}`);
  }
  if (options.forceIpv4) {
    // Флаг без значения — yt-dlp принимает --force-ipv4 как булев флаг, в
    // mpv-шном list-синтаксисе это "ключ=" с пустым значением.
    pairs.push('force-ipv4=');
  }
  return pairs.length ? [`--ytdl-raw-options=${pairs.join(',')}`] : [];
}

/** Экспортировано отдельно ради юнит-тестов, как и buildYtdlRawOptionsArg. */
export function buildScriptOptsArg(options: YoutubePlaybackOptions): string[] {
  if (!options.ytdlPath) return [];
  return [`--script-opts=ytdl_hook-ytdl_path=${mpvEscapeListValue(options.ytdlPath)}`];
}

/** Экспортировано отдельно ради юнит-тестов, как и buildYtdlRawOptionsArg. */
export function buildVolumeArg(options: YoutubePlaybackOptions): string[] {
  return options.volume === undefined ? [] : [`--volume=${options.volume}`];
}

/**
 * Экспортировано отдельно ради юнит-тестов, как и buildYtdlRawOptionsArg.
 * В отличие от --ytdl-raw-options, --audio-device — обычный (не list-)
 * флаг mpv, поэтому mpvEscapeListValue тут не нужен.
 */
export function buildAudioDeviceArg(options: YoutubePlaybackOptions): string[] {
  return options.audioDevice ? [`--audio-device=${options.audioDevice}`] : [];
}

/**
 * Воспроизводит YouTube-видео локально через mpv (у mpv есть встроенная
 * поддержка YouTube-ссылок через yt-dlp/youtube-dl — отдельно скачивать
 * файл не нужно, но yt-dlp должен быть установлен и виден mpv).
 * Используется только для заказов с YouTube — Spotify-треки играют через
 * Spotify Connect, см. spotifyProvider.ts.
 *
 * Флаг --really-quiet намеренно не используется: он подавляет и вывод
 * ошибок mpv, из-за чего при сбое (например, устаревший yt-dlp не смог
 * разобрать страницу YouTube) не было видно причины — только "код 2" без
 * подробностей. Сам вывод mpv никуда не печатается (см. spawnPlaybackProcess) —
 * он просто перехватывается и попадает в лог только при ошибке.
 *
 * options управляет обходом YouTube-проверки "Sign in to confirm you're
 * not a bot" (и связанных ошибок вроде "The page needs to be reloaded") —
 * см. YOUTUBE_PLAYER_CLIENT / YOUTUBE_COOKIES_FROM_BROWSER /
 * YOUTUBE_COOKIES_FILE / YTDLP_PATH в .env.example.
 */
export function playYoutubeUrl(videoUrl: string, mpvPath = 'mpv', options: YoutubePlaybackOptions = {}): PlaybackSession {
  const args = [
    ...buildScriptOptsArg(options),
    ...buildYtdlRawOptionsArg(options),
    ...buildVolumeArg(options),
    ...buildAudioDeviceArg(options),
    '--no-video',
    videoUrl,
  ];
  return spawnPlaybackProcess(mpvPath, args);
}
