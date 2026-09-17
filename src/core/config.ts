import { normalizeSpotifyPlaylistUri } from '../music/spotifyPlaylistUri.ts';
import { resolveEndOfTrackThresholdMs } from './spotifyPollTiming.ts';
import { logger } from './logger.ts';

/**
 * Загружает .env (если он есть) и собирает типизированный конфиг из
 * переменных окружения. Падает с понятной ошибкой, если чего-то не хватает —
 * лучше узнать об этом сразу при старте, а не посреди работы.
 */

function loadDotEnvIfPresent(): void {
  try {
    // process.loadEnvFile — встроенная в Node (>=20.6) загрузка .env,
    // без сторонних зависимостей вроде dotenv.
    process.loadEnvFile();
  } catch {
    // .env необязателен — переменные могут быть заданы окружением напрямую
  }
}

loadDotEnvIfPresent();

// Флаг командной строки, чтобы запустить приложение сразу с приостановленными
// заказами (например, техническая пауза перед стримом) — без него пришлось бы
// сразу после старта писать !pr в чат самому. Включить обратно — команда !rr
// (см. requestsToggleHandler.ts) с тем же эффектом, как если бы её ввёл модератор.
const cliArgs = process.argv.slice(2);
const startWithRequestsPaused = cliArgs.includes('-s') || cliArgs.includes('--pause-requests');

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Отсутствует обязательная переменная окружения: ${name}. Скопируй .env.example в .env и заполни значения.`,
    );
  }
  return value;
}

/**
 * Некоторые фичи (Telegram-анонсы, Spotify) целиком опциональны — если их не
 * настраивать, приложение просто работает без них (например, только с
 * YouTube-заказами). Но набор переменных, который их описывает, должен быть
 * заполнен либо целиком, либо не заполнен вовсе: если часть переменных
 * задана, а часть — нет, это почти наверняка недосмотр (например, забыли
 * дописать один токен), и лучше сразу упасть с понятной ошибкой, чем молча
 * работать в каком-то промежуточном, скорее всего сломанном состоянии.
 */
function resolveOptionalGroup(groupName: string, varNames: string[]): 'unset' | 'set' {
  const setCount = varNames.filter((name) => !!process.env[name]).length;
  if (setCount === 0) return 'unset';
  if (setCount === varNames.length) return 'set';
  const missing = varNames.filter((name) => !process.env[name]);
  throw new Error(
    `Группа переменных окружения "${groupName}" заполнена только частично — заданы не все из [${varNames.join(', ')}] ` +
      `(не хватает: ${missing.join(', ')}). Либо заполни все переменные группы, либо не задавай ни одной — ` +
      `тогда соответствующая фича будет просто отключена.`,
  );
}

const spotifyPollIntervalMs = Number(process.env.SPOTIFY_POLL_INTERVAL_MS ?? 4000);
const requestedEndOfTrackThresholdMs = Number(process.env.SPOTIFY_END_THRESHOLD_MS ?? 5000);
// См. подробное объяснение в spotifyPollTiming.ts — если порог меньше
// интервала опроса, можно проскочить момент конца трека и пропустить
// переключение на заказ (очередь как будто "не двигается"). Считается
// независимо от того, настроен ли Spotify вообще (см. ниже) — это просто
// параметры цикла оркестратора, а не сама интеграция с Spotify.
const { value: spotifyEndOfTrackThresholdMs, wasClamped } = resolveEndOfTrackThresholdMs(
  spotifyPollIntervalMs,
  requestedEndOfTrackThresholdMs,
);
if (wasClamped) {
  logger.warn(
    'config',
    `SPOTIFY_END_THRESHOLD_MS (${requestedEndOfTrackThresholdMs}) меньше SPOTIFY_POLL_INTERVAL_MS (${spotifyPollIntervalMs}) — при такой связке можно проскочить момент конца трека и пропустить переключение на заказ. Использую ${spotifyEndOfTrackThresholdMs} мс вместо заданного значения.`,
  );
}

const telegramGroupState = resolveOptionalGroup('Telegram', ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
if (telegramGroupState === 'unset') {
  logger.warn(
    'config',
    'TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы — анонсы в Telegram отключены, эта часть работать не будет.',
  );
}
const telegram =
  telegramGroupState === 'set'
    ? {
        botToken: required('TELEGRAM_BOT_TOKEN'),
        chatId: required('TELEGRAM_CHAT_ID'),
      }
    : null;

const spotifyGroupState = resolveOptionalGroup('Spotify', [
  'SPOTIFY_CLIENT_ID',
  'SPOTIFY_CLIENT_SECRET',
  'SPOTIFY_DEFAULT_PLAYLIST_URI',
]);
if (spotifyGroupState === 'unset') {
  logger.warn(
    'config',
    'SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET/SPOTIFY_DEFAULT_PLAYLIST_URI не заданы — интеграция со Spotify ' +
      'отключена, заказ музыки работает только через YouTube-ссылки.',
  );
}
const spotify =
  spotifyGroupState === 'set'
    ? {
        clientId: required('SPOTIFY_CLIENT_ID'),
        clientSecret: required('SPOTIFY_CLIENT_SECRET'),
        tokenFilePath: process.env.SPOTIFY_TOKEN_FILE ?? './data/spotify-token.json',
        // Принимает и https://open.spotify.com/playlist/<id>?si=..., и голый
        // <id>, и spotify:playlist:<id> — см. music/spotifyPlaylistUri.ts
        defaultPlaylistUri: normalizeSpotifyPlaylistUri(required('SPOTIFY_DEFAULT_PLAYLIST_URI')),
        // Необязательно. Точное имя устройства из Spotify Connect (см. "node
        // scripts/spotify-devices.ts"). Если не задано — приложение полагается
        // на то, что у аккаунта уже есть "активное устройство" (см. ошибку
        // HTTP 404 в spotifyProvider.ts, если что-то пошло не так).
        deviceName: process.env.SPOTIFY_DEVICE_NAME || undefined,
      }
    : null;

export const config = {
  twitch: {
    clientId: required('TWITCH_CLIENT_ID'),
    clientSecret: required('TWITCH_CLIENT_SECRET'),
    broadcasterLogin: required('TWITCH_BROADCASTER_LOGIN'),
    pollIntervalMs: Number(process.env.TWITCH_POLL_INTERVAL_MS ?? 60_000),
  },
  telegram,
  db: {
    path: process.env.DB_PATH ?? './data/stream-companion.sqlite',
  },
  chat: {
    // Аккаунт, от имени которого бот пишет в чат. Если это сам broadcaster —
    // укажи тот же логин, что и TWITCH_BROADCASTER_LOGIN. Если отдельный бот —
    // он должен быть модератором канала (нужно для проверки фолловеров).
    botUsername: required('TWITCH_CHAT_BOT_USERNAME'),
    tokenFilePath: process.env.TWITCH_CHAT_TOKEN_FILE ?? './data/twitch-chat-token.json',
    broadcasterId: required('TWITCH_BROADCASTER_ID'),
    commandName: process.env.MUSIC_COMMAND ?? '!sr',
    minFollowerDays: Number(process.env.MUSIC_MIN_FOLLOWER_DAYS ?? 3),
    // Команда "текущий трек" — показывает в чате трек, который сейчас играет
    // (дефолтный плейлист или заказ), в том же виде, что и при добавлении в
    // очередь. Доступна всем без ограничений по фолловингу.
    currentTrackCommand: process.env.MUSIC_CURRENT_COMMAND ?? '!s',
    // Команда голосования за скип текущего трека и порог голосования — см.
    // skipVoteHandler.ts. Скипает броадкастер — сразу, без порога; остальные
    // зрители — голосованием, от числа уникальных "активных" в чате (тех,
    // кто писал что-либо за последние skipActiveWindowMs).
    skipCommand: process.env.MUSIC_SKIP_COMMAND ?? '!skip',
    skipThresholdPercent: Number(process.env.MUSIC_SKIP_THRESHOLD_PERCENT ?? 30),
    skipActiveWindowMs: Number(process.env.MUSIC_SKIP_ACTIVE_WINDOW_MS ?? 600_000),
    // Команды приостановки/возобновления приёма заказов (только для стримера
    // и модераторов) — см. requestsToggleHandler.ts. Пока приостановлено, не
    // играет и дефолтный плейлист (не только новые заказы недоступны).
    pauseRequestsCommand: process.env.MUSIC_PAUSE_COMMAND ?? '!pr',
    resumeRequestsCommand: process.env.MUSIC_RESUME_COMMAND ?? '!rr',
    // См. cliArgs/startWithRequestsPaused выше — запуск с флагом -s/--pause-requests.
    startWithRequestsPaused,
  },
  youtube: {
    apiKey: required('YOUTUBE_API_KEY'),
    maxDurationSec: Number(process.env.YOUTUBE_MAX_DURATION_SEC ?? 600),
    // Обходит проверку YouTube "Sign in to confirm you're not a bot" и
    // связанные с ней ошибки при локальном воспроизведении через mpv/yt-dlp —
    // см. комментарии в .env.example и youtubePlayer.ts. YouTube регулярно
    // меняет правила, так что при необходимости значение может понадобиться
    // сменить — это не жёстко зашитое "правильное" значение навсегда.
    // "android"-семейство клиентов (в т.ч. android_vr) сейчас особенно часто
    // ловит HTTP 403 на самом проигрывании (уже после успешного разбора
    // ссылки) — поэтому по умолчанию не используется, см. .env.example.
    playerClient: process.env.YOUTUBE_PLAYER_CLIENT ?? 'tv,web_safari,web_embedded',
    cookiesFromBrowser: process.env.YOUTUBE_COOKIES_FROM_BROWSER || undefined,
    cookiesFile: process.env.YOUTUBE_COOKIES_FILE || undefined,
    // Явный путь к yt-dlp, если на машине их несколько и mpv резолвит не
    // тот, который реально обновлялся (см. YTDLP_PATH в .env.example).
    ytdlPath: process.env.YTDLP_PATH || undefined,
    // См. YOUTUBE_FORCE_IPV4 в .env.example — обход HTTP 403 на dual-stack сетях.
    forceIpv4: process.env.YOUTUBE_FORCE_IPV4 === 'true',
    // Громкость mpv при старте YouTube-заказа (0-100). По умолчанию 50 —
    // раньше mpv стартовал со своей дефолтной громкостью (обычно заметно
    // громче, чем играл до этого Spotify), см. MPV_VOLUME в .env.example.
    volume: Number(process.env.MPV_VOLUME ?? 50),
    // Аудио-устройство для вывода звука mpv (например виртуальный кабель
    // для отдельного захвата в OBS) — см. MPV_AUDIO_DEVICE в .env.example.
    // Не задано — mpv играет на устройство по умолчанию, как обычная система.
    audioDevice: process.env.MPV_AUDIO_DEVICE || undefined,
  },
  spotify,
  // Параметры цикла оркестратора воспроизведения (см. playbackOrchestrator.ts).
  // Формально это "настройки под Spotify" (там же и определяются переменные
  // окружения SPOTIFY_POLL_INTERVAL_MS/SPOTIFY_END_THRESHOLD_MS), но нужны
  // оркестратору независимо от того, настроен ли Spotify — например, чтобы
  // знать, как часто проверять очередь заказов в youtube-only режиме.
  playback: {
    pollIntervalMs: spotifyPollIntervalMs,
    endOfTrackThresholdMs: spotifyEndOfTrackThresholdMs,
  },
  mpvPath: process.env.MPV_PATH ?? 'mpv',
} as const;
