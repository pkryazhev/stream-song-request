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
 * процесса (но не для его дочерних процессов, если они у него есть). На
 * практике это плохо ловится тестами (нужна реальная Windows-машина), но
 * именно это — известная и частая причина, почему "скип" визуально
 * срабатывает (следующий трек в очереди стартует), а прошлый процесс
 * из-за этого не завершается и продолжает играть параллельно с новым (два
 * трека одновременно). taskkill с /T (дерево процессов, то есть и сам
 * процесс, и все его потомки) и /F (принудительно) останавливает его
 * гарантированно.
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
   * Пусто/undefined — --extractor-args не передаётся вообще.
   */
  playerClient?: string;
  /** Имя браузера для --cookies-from-browser (firefox/chrome/edge/...). */
  cookiesFromBrowser?: string;
  /** Путь к cookies.txt в формате Netscape — альтернатива cookiesFromBrowser. */
  cookiesFile?: string;
  /**
   * Явный путь к исполняемому файлу yt-dlp, который мы сами запускаем для
   * скачивания аудио (см. playYoutubeUrl). Полезно, если на машине несколько
   * установок yt-dlp (например, winget поставил один, а рядом вручную
   * положен более свежий .exe) — без этой опции используется первый yt-dlp,
   * который найдётся в PATH, а это не всегда тот, который реально обновлялся.
   */
  ytdlPath?: string;
  /**
   * Заставляет yt-dlp резолвить и скачивать видео только по IPv4
   * (yt-dlp --force-ipv4). Раньше (когда прямую ссылку на googlevideo.com
   * получал yt-dlp, а скачивал её сам mpv отдельным HTTP-запросом) это было
   * попыткой обойти "HTTP error 403 Forbidden" из-за IP-привязки ссылки —
   * ссылка привязывается к IP, с которого её запросил yt-dlp, и если сам
   * mpv стучится с другого IP (типично на dual-stack сетях), YouTube отвечал
   * 403. Теперь skачивание тоже делает yt-dlp (см. playYoutubeUrl) — тот же
   * процесс, тот же IP что для резолва, что для скачивания, так что эта
   * проблема больше не актуальна сама по себе, но флаг всё равно оставлен —
   * иногда IPv4 просто стабильнее IPv6 на конкретной сети.
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
 * Собирает аргументы командной строки yt-dlp для скачивания только аудио
 * заданного видео и вывода его сырых байт в stdout (playYoutubeUrl пускает
 * этот stdout прямо во stdin mpv, см. там подробное объяснение зачем).
 * Экспортировано отдельно ради юнит-тестов.
 */
export function buildYtdlpAudioArgs(videoUrl: string, options: YoutubePlaybackOptions): string[] {
  const args: string[] = ['-f', 'bestaudio', '--no-playlist', '-o', '-'];
  if (options.playerClient) {
    args.push('--extractor-args', `youtube:player_client=${options.playerClient}`);
  }
  if (options.cookiesFromBrowser) {
    args.push('--cookies-from-browser', options.cookiesFromBrowser);
  } else if (options.cookiesFile) {
    args.push('--cookies', options.cookiesFile);
  }
  if (options.forceIpv4) {
    args.push('--force-ipv4');
  }
  args.push(videoUrl);
  return args;
}

/** Экспортировано отдельно ради юнит-тестов, как и buildYtdlpAudioArgs. */
export function buildVolumeArg(options: YoutubePlaybackOptions): string[] {
  return options.volume === undefined ? [] : [`--volume=${options.volume}`];
}

/** Экспортировано отдельно ради юнит-тестов, как и buildYtdlpAudioArgs. */
export function buildAudioDeviceArg(options: YoutubePlaybackOptions): string[] {
  return options.audioDevice ? [`--audio-device=${options.audioDevice}`] : [];
}

/**
 * Собирает аргументы командной строки mpv для проигрывания аудио, которое
 * приходит через stdin (см. playYoutubeUrl) — "-" в качестве имени файла
 * означает для mpv именно stdin. Экспортировано отдельно ради юнит-тестов.
 */
export function buildMpvStdinArgs(options: YoutubePlaybackOptions): string[] {
  return [...buildVolumeArg(options), ...buildAudioDeviceArg(options), '--no-video', '-'];
}

/**
 * Воспроизводит YouTube-видео локально: yt-dlp сам скачивает аудио и
 * стримит его сырые байты напрямую в stdin mpv, который просто их
 * проигрывает — mpv никогда не делает собственный сетевой запрос к
 * googlevideo.com.
 *
 * Так было не всегда — раньше mpv (через встроенный ytdl_hook) сам
 * резолвил и мгновенно "не мытьём, так катаньем" уже сам, а не yt-dlp
 * докачивал итоговую ссылку на googlevideo.com. Оказалось, что YouTube
 * сейчас (2026) в некоторых случаях блокирует именно сетевой запрос
 * ffmpeg/mpv к этой ссылке (HTTP 403), даже когда та же самая ссылка
 * секунду назад успешно скачивалась через сам yt-dlp (или даже banal curl) —
 * то есть ссылка валидна, но именно клиент mpv/ffmpeg под подозрением у
 * анти-бот защиты YouTube. Никакие --extractor-args/куки/IPv4 этого не
 * лечат, потому что все они влияют только на то, как РЕЗОЛВИТСЯ ссылка, а
 * не на то, кто её СКАЧИВАЕТ. Раз yt-dlp скачивать умеет надёжно (в
 * отличие от mpv) — пусть он и скачивает, а mpv остаётся только плеером.
 *
 * options управляет обходом YouTube-проверки "Sign in to confirm you're
 * not a bot" (и связанных ошибок вроде "The page needs to be reloaded") —
 * см. YOUTUBE_PLAYER_CLIENT / YOUTUBE_COOKIES_FROM_BROWSER /
 * YOUTUBE_COOKIES_FILE / YTDLP_PATH в .env.example.
 */
export function playYoutubeUrl(videoUrl: string, mpvPath = 'mpv', options: YoutubePlaybackOptions = {}): PlaybackSession {
  const ytdlpPath = options.ytdlPath || 'yt-dlp';
  return spawnYtdlpMpvPipeline(ytdlpPath, buildYtdlpAudioArgs(videoUrl, options), mpvPath, buildMpvStdinArgs(options));
}

/**
 * Соединяет процесс yt-dlp (скачивает аудио, пишет сырые байты в stdout) с
 * процессом mpv (читает их из stdin и проигрывает) — см. playYoutubeUrl,
 * где объясняется, почему именно так. Вынесено отдельно от playYoutubeUrl
 * ради юнит-тестов: сюда можно подставить node с простыми скриптами вместо
 * реальных yt-dlp/mpv, не трогая сборку аргументов командной строки.
 */
export function spawnYtdlpMpvPipeline(
  ytdlpPath: string,
  ytdlpArgs: string[],
  mpvPath: string,
  mpvArgs: string[],
): PlaybackSession {
  const ytdlp = spawn(ytdlpPath, ytdlpArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  const mpv = spawn(mpvPath, mpvArgs, { stdio: [ytdlp.stdout, 'pipe', 'pipe'] });

  let stopped = false;
  let ytdlpStderr = '';
  let mpvOutput = '';

  const capture = (target: 'ytdlp' | 'mpv') =>
    (chunk: Buffer): void => {
      if (target === 'ytdlp') {
        ytdlpStderr += chunk.toString('utf8');
        if (ytdlpStderr.length > MAX_CAPTURED_OUTPUT) {
          ytdlpStderr = ytdlpStderr.slice(ytdlpStderr.length - MAX_CAPTURED_OUTPUT);
        }
      } else {
        mpvOutput += chunk.toString('utf8');
        if (mpvOutput.length > MAX_CAPTURED_OUTPUT) {
          mpvOutput = mpvOutput.slice(mpvOutput.length - MAX_CAPTURED_OUTPUT);
        }
      }
    };
  ytdlp.stderr?.on('data', capture('ytdlp'));
  mpv.stdout?.on('data', capture('mpv'));
  mpv.stderr?.on('data', capture('mpv'));

  // yt-dlp может либо не найти видео/упереться в бан (см. буллеты про
  // "Sign in to confirm..." в README), либо честно докачать всё до конца —
  // в обоих случаях он завершается сам, до того как закончит играть mpv
  // (mpv просто получит EOF на stdin, когда yt-dlp закроет stdout). Только
  // ошибка самого yt-dlp (ненулевой код) означает реальный сбой — если он
  // вышел с 0, это значит "аудио полностью докачано", а не "воспроизведение
  // не удалось".
  let ytdlpFailed = false;
  const ytdlpDone = new Promise<void>((resolve) => {
    ytdlp.on('exit', (code) => {
      if (!stopped && code !== 0 && code !== null) {
        ytdlpFailed = true;
      }
      resolve();
    });
    ytdlp.on('error', () => {
      ytdlpFailed = true;
      resolve();
    });
  });

  const finished = new Promise<void>((resolve, reject) => {
    mpv.on('exit', (code) => {
      void ytdlpDone.then(() => {
        if (stopped) {
          resolve();
          return;
        }
        if (ytdlpFailed) {
          const details = ytdlpStderr.trim();
          const suffix = details ? `\n--- вывод "${ytdlpPath}" ---\n${details}` : ' (без вывода в stdout/stderr)';
          reject(new Error(`Процесс "${ytdlpPath}" не смог скачать аудио${suffix}`));
          return;
        }
        if (code === 0 || code === null) {
          resolve();
          return;
        }
        const details = mpvOutput.trim();
        const suffix = details ? `\n--- вывод "${mpvPath}" ---\n${details}` : ' (без вывода в stdout/stderr)';
        reject(new Error(`Процесс плеера "${mpvPath}" завершился с кодом ${code}${suffix}`));
      });
    });
    mpv.on('error', (err) => reject(err));
  });

  return {
    finished,
    stop: () => {
      stopped = true;
      killProcess(mpv);
      killProcess(ytdlp);
    },
  };
}
