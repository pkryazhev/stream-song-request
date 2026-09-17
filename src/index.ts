import { config } from './core/config.ts';
import { logger } from './core/logger.ts';
import { initDb } from './db/index.ts';
import { peekNextPending, markPlaying, markDone } from './db/musicQueue.ts';
import { TwitchChatClient } from './integrations/twitch/chatClient.ts';
import { createTwitchUserTokenStore } from './integrations/twitch/twitchUserAuth.ts';
import { createSpotifyUserTokenStore } from './music/spotifyAuth.ts';
import { SpotifyPlaybackController } from './music/spotifyProvider.ts';
import { registerMusicRequestHandler } from './music/requestHandler.ts';
import { registerSkipVoteHandler } from './music/skipVoteHandler.ts';
import { registerCurrentTrackHandler } from './music/currentTrackHandler.ts';
import { registerRequestsToggleHandler } from './music/requestsToggleHandler.ts';
import { setRequestsPaused } from './music/requestsGate.ts';
import { PlaybackOrchestrator, type SpotifyPlaybackLike } from './music/playbackOrchestrator.ts';
import { playYoutubeUrl } from './music/youtubePlayer.ts';

// Подстраховка: необработанный reject где-то в цепочке промисов не должен
// ронять всё приложение посреди стрима — логируем и продолжаем работать.
process.on('unhandledRejection', (err) => {
  logger.error('app', 'Необработанный promise rejection (см. детали ниже) — приложение продолжает работать', err);
});

logger.info('app', 'Запуск stream-companion...');

initDb(config.db.path);

// Запуск с флагом -s/--pause-requests — сразу приостановленные заказы (см.
// config.ts). Установлено до старта оркестратора и любых обработчиков чата,
// чтобы дефолтный плейлист не успел запуститься даже на долю секунды.
if (config.chat.startWithRequestsPaused) {
  setRequestsPaused(true);
  logger.info(
    'app',
    `Заказы музыки запущены в приостановленном состоянии (флаг -s/--pause-requests). Включить — команда "${config.chat.resumeRequestsCommand}" в чате (стример/модератор).`,
  );
}

// --- Заказ музыки ---
const twitchUserTokens = createTwitchUserTokenStore({
  clientId: config.twitch.clientId,
  clientSecret: config.twitch.clientSecret,
  tokenFilePath: config.chat.tokenFilePath,
});
if (!twitchUserTokens.load()) {
  logger.error(
    'app',
    `Нет сохранённого Twitch chat-токена (${config.chat.tokenFilePath}). Запусти "npm run auth:twitch" перед первым стартом.`,
  );
}

const chatClient = new TwitchChatClient({
  botUsername: config.chat.botUsername,
  channelLogin: config.twitch.broadcasterLogin,
  getAccessToken: () => twitchUserTokens.getValidAccessToken(),
});
chatClient.connect().catch((err: unknown) => {
  logger.error('app', 'Не удалось подключиться к чату Twitch (нужна авторизация — npm run auth:twitch)', err);
});

registerMusicRequestHandler({
  commandName: config.chat.commandName,
  minFollowerDays: config.chat.minFollowerDays,
  maxYoutubeDurationSec: config.youtube.maxDurationSec,
  youtubeApiKey: config.youtube.apiKey,
  // SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET/SPOTIFY_DEFAULT_PLAYLIST_URI
  // необязательны (см. config.ts) — если Spotify не настроен, заказы
  // принимаются только по YouTube-ссылкам.
  spotify: config.spotify ? { clientId: config.spotify.clientId, clientSecret: config.spotify.clientSecret } : undefined,
  twitchClientId: config.twitch.clientId,
  twitchBroadcasterId: config.chat.broadcasterId,
  getTwitchAccessToken: () => twitchUserTokens.getValidAccessToken(),
});

let spotifyController: SpotifyPlaybackLike | null = null;
if (config.spotify) {
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
  spotifyController = new SpotifyPlaybackController(spotifyUserTokens, fetch, config.spotify.deviceName);
}

const orchestrator = new PlaybackOrchestrator(
  spotifyController,
  {
    play: (url) =>
      playYoutubeUrl(url, config.mpvPath, {
        playerClient: config.youtube.playerClient,
        cookiesFromBrowser: config.youtube.cookiesFromBrowser,
        cookiesFile: config.youtube.cookiesFile,
        ytdlPath: config.youtube.ytdlPath,
        forceIpv4: config.youtube.forceIpv4,
        volume: config.youtube.volume,
        audioDevice: config.youtube.audioDevice,
      }),
  },
  { peekNextPending, markPlaying, markDone },
  {
    defaultPlaylistUri: config.spotify?.defaultPlaylistUri ?? null,
    endOfTrackThresholdMs: config.playback.endOfTrackThresholdMs,
    pollIntervalMs: config.playback.pollIntervalMs,
  },
);
orchestrator.start();

// unregister не используется — обработчик живёт всё время работы приложения.
registerSkipVoteHandler(orchestrator, {
  commandName: config.chat.skipCommand,
  thresholdPercent: config.chat.skipThresholdPercent,
  activeWindowMs: config.chat.skipActiveWindowMs,
});

registerCurrentTrackHandler(orchestrator, { commandName: config.chat.currentTrackCommand });

registerRequestsToggleHandler(orchestrator, {
  pauseCommand: config.chat.pauseRequestsCommand,
  resumeCommand: config.chat.resumeRequestsCommand,
});

logger.info('app', `Обработка заказов музыки включена (команда "${config.chat.commandName}")`);

function shutdown(): void {
  logger.info('app', 'Останавливаюсь...');
  orchestrator.stop();
  chatClient.disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
