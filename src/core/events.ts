/**
 * Центральный реестр событий приложения.
 * Любой модуль публикует и подписывается на события через eventBus,
 * не зная о существовании других модулей напрямую.
 */

export interface StreamWentLiveEvent {
  streamId: string;
  broadcasterLogin: string;
  title: string;
  gameName: string;
  thumbnailUrl: string;
  startedAt: string;
}

/** Сырое сообщение из чата Twitch. */
export interface ChatMessageEvent {
  userId: string;
  login: string;
  displayName: string;
  text: string;
  isModerator: boolean;
  isBroadcaster: boolean;
}

/** Любой модуль может попросить написать сообщение в чат, не зная деталей подключения к Twitch. */
export interface ChatReplyEvent {
  text: string;
}

export type SongProvider = 'spotify' | 'youtube';

/** Трек успешно поставлен в очередь заказов. */
export interface SongQueuedEvent {
  title: string;
  provider: SongProvider;
  position: number;
}

/** Оркестратор воспроизведения начал играть конкретный заказ. */
export interface SongNowPlayingEvent {
  title: string;
  provider: SongProvider;
  /** userId зрителя, который заказал этот трек — нужен, например, чтобы разрешить ему самому скипнуть свой заказ (см. skipVoteHandler.ts). */
  requestedById: string;
}

/**
 * Карта "имя события -> тип payload".
 * При добавлении новой фичи (файловая система) сюда добавляются новые
 * события — остальной код не меняется.
 */
export interface AppEvents {
  'stream.went_live': StreamWentLiveEvent;
  'chat.message': ChatMessageEvent;
  'chat.reply': ChatReplyEvent;
  'song.queued': SongQueuedEvent;
  'song.now_playing': SongNowPlayingEvent;
}
