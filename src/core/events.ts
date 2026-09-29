/**
 * Центральный реестр событий приложения.
 * Любой модуль публикует и подписывается на события через eventBus,
 * не зная о существовании других модулей напрямую.
 */

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

export type SongProvider = 'spotify' | 'youtube' | 'yandex';

/** Трек успешно поставлен в очередь заказов. */
export interface SongQueuedEvent {
  title: string;
  provider: SongProvider;
  position: number;
}

/** Оркестратор воспроизведения начал играть конкретный трек — заказ или трек дефолтного плейлиста. */
export interface SongNowPlayingEvent {
  title: string;
  provider: SongProvider;
  /**
   * userId зрителя, который заказал этот трек — нужен, например, чтобы
   * разрешить ему самому скипнуть свой заказ (см. skipVoteHandler.ts).
   * null для треков дефолтного плейлиста — у них нет заказчика.
   */
  requestedById: string | null;
}

/**
 * Зритель активировал награду за баллы канала (EventSub
 * channel.channel_points_custom_reward_redemption.add, см. eventSubClient.ts).
 * Статус активации пока "unfulfilled" — выполнить или отклонить (с возвратом
 * баллов) её должен тот, кто обработает событие.
 */
export interface RewardRedeemedEvent {
  redemptionId: string;
  rewardId: string;
  /** Текущее название награды на Twitch (её могли переименовать в панели). */
  rewardTitle: string;
  userId: string;
  userLogin: string;
  userName: string;
  /** Текст, который зритель ввёл при активации награды. */
  userInput: string;
}

/**
 * Карта "имя события -> тип payload".
 * При добавлении новой фичи (файловая система) сюда добавляются новые
 * события — остальной код не меняется.
 */
export interface AppEvents {
  'chat.message': ChatMessageEvent;
  'chat.reply': ChatReplyEvent;
  'song.queued': SongQueuedEvent;
  'song.now_playing': SongNowPlayingEvent;
  'channel_points.redeemed': RewardRedeemedEvent;
}
