import { eventBus } from '../core/eventBus.ts';
import { logger } from '../core/logger.ts';
import { parseRequestLink } from './linkParser.ts';
import { fetchYoutubeVideoDetails } from './youtubeProvider.ts';
import { fetchSpotifyTrackDetails, type SpotifyTrackDetails } from './spotifyProvider.ts';
import { searchSpotifyTrackByText } from './spotifySearch.ts';
import { checkFollowerEligibility } from '../integrations/twitch/followerCheck.ts';
import { enqueueSongRequest } from '../db/musicQueue.ts';
import { formatTrackTitle } from './trackFormat.ts';
import { isRequestsPaused } from './requestsGate.ts';
import type { ChatMessageEvent } from '../core/events.ts';

export interface SpotifyRequestConfig {
  clientId: string;
  clientSecret: string;
}

export interface RequestHandlerConfig {
  /** Например "!sr". Сравнение регистронезависимое. */
  commandName: string;
  minFollowerDays: number;
  maxYoutubeDurationSec: number;
  youtubeApiKey: string;
  /** undefined — Spotify не настроен, заказы принимаются только по YouTube-ссылкам. */
  spotify?: SpotifyRequestConfig;
  twitchClientId: string;
  twitchBroadcasterId: string;
  getTwitchAccessToken: () => Promise<string>;
}

function reply(text: string): void {
  eventBus.emit('chat.reply', { text });
}

/** Подписывает обработчик заказов на входящие сообщения чата. */
export function registerMusicRequestHandler(cfg: RequestHandlerConfig, fetchImpl: typeof fetch = fetch): void {
  eventBus.on('chat.message', (msg) => {
    void handleChatMessage(msg, cfg, fetchImpl).catch((err) => {
      logger.error('music', 'Ошибка обработки заказа музыки', err);
      reply(`@${msg.displayName} не получилось обработать заказ, попробуй ещё раз чуть позже`);
    });
  });
}

/**
 * Основная логика одного сообщения чата. Вынесена отдельной экспортируемой
 * функцией (не только через eventBus) — так её проще тестировать напрямую,
 * без поднятия реального чат-клиента.
 */
export async function handleChatMessage(
  msg: ChatMessageEvent,
  cfg: RequestHandlerConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const text = msg.text.trim();
  const [cmd, ...rest] = text.split(/\s+/);
  if (!cmd || cmd.toLowerCase() !== cfg.commandName.toLowerCase()) return;

  const mention = `@${msg.displayName}`;

  if (isRequestsPaused()) {
    reply(`${mention} заказы музыки сейчас недоступны`);
    return;
  }

  const arg = rest.join(' ').trim();

  if (!arg) {
    reply(`${mention} укажи ссылку: ${cfg.commandName} <ссылка на YouTube или Spotify>`);
    return;
  }

  // Сам стример не может зафолловить собственный канал, поэтому проверка
  // фолловера для него всегда провалится — пропускаем её для broadcaster'а.
  if (!msg.isBroadcaster) {
    const eligibility = await checkFollowerEligibility(
      {
        broadcasterId: cfg.twitchBroadcasterId,
        userId: msg.userId,
        clientId: cfg.twitchClientId,
        getAccessToken: cfg.getTwitchAccessToken,
      },
      cfg.minFollowerDays,
      fetchImpl,
    );
    if (!eligibility.isEligible) {
      reply(`${mention} заказывать музыку могут фолловеры канала от ${cfg.minFollowerDays} дн.`);
      return;
    }
  }

  const parsed = parseRequestLink(arg);

  if (parsed.type === 'youtube') {
    await handleYoutubeRequest(parsed.videoId, msg, mention, cfg, fetchImpl);
    return;
  }

  if (parsed.type === 'spotify') {
    if (!cfg.spotify) {
      reply(`${mention} заказ по ссылке на Spotify сейчас недоступен — включён только YouTube`);
      return;
    }
    await handleSpotifyRequest(parsed.trackId, msg, mention, cfg.spotify, fetchImpl);
    return;
  }

  // parsed.type === 'invalid' — это необязательно ошибка: если Spotify
  // настроен, это может быть текстовый запрос ("название трека" или
  // "исполнитель - название") вместо ссылки — заказываем первый результат
  // поиска в Spotify (см. spotifySearch.ts), прежде чем окончательно отказать.
  if (cfg.spotify) {
    const matched = await searchSpotifyTrackByText(arg, cfg.spotify.clientId, cfg.spotify.clientSecret, fetchImpl);
    if (matched) {
      enqueueSpotifyTrack(matched, msg, mention);
      return;
    }
  }

  reply(
    `${mention} ссылка невалидная — принимаются ссылки на YouTube и Spotify` +
      (cfg.spotify ? ', либо название трека для поиска в Spotify' : ''),
  );
}

async function handleYoutubeRequest(
  videoId: string,
  msg: ChatMessageEvent,
  mention: string,
  cfg: RequestHandlerConfig,
  fetchImpl: typeof fetch,
): Promise<void> {
  const details = await fetchYoutubeVideoDetails(videoId, cfg.youtubeApiKey, fetchImpl);
  if (!details) {
    reply(`${mention} ссылка невалидная — видео не найдено`);
    return;
  }
  if (details.durationSec > cfg.maxYoutubeDurationSec) {
    reply(`${mention} ссылка невалидная — видео длиннее ${Math.round(cfg.maxYoutubeDurationSec / 60)} мин.`);
    return;
  }

  const { position } = enqueueSongRequest({
    provider: 'youtube',
    externalId: videoId,
    playUri: `https://www.youtube.com/watch?v=${videoId}`,
    title: details.title,
    author: details.channelTitle,
    durationSec: details.durationSec,
    requestedById: msg.userId,
    requestedByLogin: msg.login,
  });

  eventBus.emit('song.queued', { title: details.title, provider: 'youtube', position });
  reply(`${mention} трек добавлен в очередь: "${formatTrackTitle('youtube', details.title, details.channelTitle)}" (позиция ${position})`);
}

async function handleSpotifyRequest(
  trackId: string,
  msg: ChatMessageEvent,
  mention: string,
  spotifyCfg: SpotifyRequestConfig,
  fetchImpl: typeof fetch,
): Promise<void> {
  const details = await fetchSpotifyTrackDetails(trackId, spotifyCfg.clientId, spotifyCfg.clientSecret, fetchImpl);
  if (!details) {
    reply(`${mention} ссылка невалидная — трек не найден`);
    return;
  }
  enqueueSpotifyTrack(details, msg, mention);
}

/** Общий "хвост" постановки в очередь для заказа по ссылке и по текстовому поиску (#6). */
function enqueueSpotifyTrack(details: SpotifyTrackDetails, msg: ChatMessageEvent, mention: string): void {
  const { position } = enqueueSongRequest({
    provider: 'spotify',
    externalId: details.trackId,
    playUri: details.uri,
    title: details.title,
    author: details.artist,
    durationSec: Math.round(details.durationMs / 1000),
    requestedById: msg.userId,
    requestedByLogin: msg.login,
  });

  eventBus.emit('song.queued', { title: details.title, provider: 'spotify', position });
  // В отличие от YouTube, у Spotify-трека почти всегда есть чёткое поле
  // "исполнитель" — показываем его в чате вместе с названием, иначе не
  // всегда понятно, о каком именно треке речь (мало ли каверов/ремиксов).
  reply(`${mention} трек добавлен в очередь: "${formatTrackTitle('spotify', details.title, details.artist)}" (позиция ${position})`);
}
