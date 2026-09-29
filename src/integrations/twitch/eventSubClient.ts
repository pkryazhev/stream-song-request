import { eventBus } from '../../core/eventBus.ts';
import { logger } from '../../core/logger.ts';
import { parseEventSubMessage, toRewardRedeemedEvent, REDEMPTION_ADD_TYPE } from './eventSubMessages.ts';

export interface EventSubClientConfig {
  clientId: string;
  broadcasterId: string;
  /** Подписка только на активации этой награды, чужие награды канала не приходят вовсе. */
  rewardId: string;
  /** Токен стримера со скоупом channel:manage:redemptions (или channel:read:redemptions). */
  getAccessToken: () => Promise<string>;
}

/** Минимум WebSocket, который нужен клиенту — чтобы в тестах подставлять фейковый сокет. */
export interface SocketLike {
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  close(): void;
}

export type SocketFactory = (url: string) => SocketLike;

const DEFAULT_URL = 'wss://eventsub.wss.twitch.tv/ws';
const RECONNECT_DELAY_MS = 5000;
// Если подписаться не вышло (например, у токена нет нужного скоупа) — это
// почти наверняка не временная ошибка сети, долбить Twitch каждые 5 секунд
// нет смысла, но и сдаваться насовсем не стоит (вдруг всё-таки сеть).
const SUBSCRIBE_FAILURE_RETRY_MS = 60_000;
// Twitch шлёт keepalive раз в keepalive_timeout_seconds, если других
// сообщений нет — даём небольшой запас на сетевые задержки.
const KEEPALIVE_GRACE_MS = 5000;
// Twitch может доставить одно и то же событие повторно — помним последние id.
const SEEN_MESSAGE_IDS_LIMIT = 500;

/**
 * Клиент Twitch EventSub поверх WebSocket — получает активации награды за
 * баллы канала в реальном времени и публикует их как 'channel_points.redeemed'.
 * Что делать с активацией, решает подписчик события (см. pointsRequestHandler.ts).
 *
 * Протокол: после подключения Twitch присылает session_welcome с id сессии —
 * в течение 10 секунд нужно создать подписку через Helix с этим id, иначе
 * Twitch закроет соединение. При session_reconnect подписки переносятся на
 * новое соединение сами, повторно подписываться не нужно.
 */
export class TwitchEventSubClient {
  private socket: SocketLike | undefined;
  /** Старое соединение при session_reconnect — закрывается, когда новое пришлёт welcome. */
  private retiringSocket: SocketLike | undefined;
  private stopped = false;
  private keepaliveTimer: ReturnType<typeof setTimeout> | undefined;
  /** Уточняется из session_welcome (keepalive_timeout_seconds). */
  private keepaliveTimeoutMs = 10_000 + KEEPALIVE_GRACE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private nextReconnectDelayMs = RECONNECT_DELAY_MS;
  private readonly seenMessageIds = new Set<string>();
  private readonly cfg: EventSubClientConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly createSocket: SocketFactory;

  constructor(
    cfg: EventSubClientConfig,
    fetchImpl: typeof fetch = fetch,
    createSocket: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike,
  ) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
    this.createSocket = createSocket;
  }

  connect(): void {
    this.stopped = false;
    this.openFresh();
  }

  disconnect(): void {
    this.stopped = true;
    clearTimeout(this.keepaliveTimer);
    clearTimeout(this.reconnectTimer);
    this.retiringSocket?.close();
    this.retiringSocket = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  /** Новое соединение с нуля — после него нужно заново создать подписку. */
  private openFresh(): void {
    this.retiringSocket?.close();
    this.retiringSocket = undefined;
    const previous = this.socket;
    this.socket = undefined;
    previous?.close();
    this.open(DEFAULT_URL, true);
  }

  private open(url: string, needsSubscription: boolean): void {
    const socket = this.createSocket(url);
    this.socket = socket;

    socket.addEventListener('message', (event) => {
      if (socket === this.socket) this.armKeepaliveWatchdog();
      this.handleMessage(socket, String(event.data), needsSubscription);
    });

    socket.addEventListener('close', () => {
      // Закрытие старого соединения после session_reconnect или при
      // disconnect() — штатная ситуация, переподключаться не нужно.
      if (this.stopped || socket !== this.socket) return;
      this.socket = undefined;
      clearTimeout(this.keepaliveTimer);
      const delay = this.nextReconnectDelayMs;
      this.nextReconnectDelayMs = RECONNECT_DELAY_MS;
      logger.warn('twitch-eventsub', `Соединение EventSub разорвано, переподключение через ${delay / 1000} сек.`);
      this.reconnectTimer = setTimeout(() => {
        if (!this.stopped) this.openFresh();
      }, delay);
    });

    socket.addEventListener('error', () => {
      logger.error('twitch-eventsub', 'Ошибка WebSocket-соединения EventSub');
    });
  }

  private handleMessage(socket: SocketLike, raw: string, needsSubscription: boolean): void {
    const msg = parseEventSubMessage(raw);

    switch (msg.type) {
      case 'welcome':
        this.keepaliveTimeoutMs = msg.keepaliveTimeoutSec * 1000 + KEEPALIVE_GRACE_MS;
        this.armKeepaliveWatchdog();
        if (needsSubscription) {
          void this.subscribe(socket, msg.sessionId);
        } else {
          this.retiringSocket?.close();
          this.retiringSocket = undefined;
          logger.info('twitch-eventsub', 'Переподключение EventSub по запросу Twitch выполнено');
        }
        return;

      case 'reconnect':
        logger.info('twitch-eventsub', 'Twitch попросил переподключиться к EventSub, переподключаюсь...');
        this.retiringSocket?.close();
        this.retiringSocket = socket;
        this.open(msg.reconnectUrl, false);
        return;

      case 'notification':
        if (msg.messageId) {
          if (this.seenMessageIds.has(msg.messageId)) return;
          this.rememberMessageId(msg.messageId);
        }
        if (msg.subscriptionType === REDEMPTION_ADD_TYPE) {
          const event = toRewardRedeemedEvent(msg.event);
          if (event && event.rewardId === this.cfg.rewardId) {
            eventBus.emit('channel_points.redeemed', event);
          }
        }
        return;

      case 'revocation':
        logger.error(
          'twitch-eventsub',
          `Twitch отозвал подписку ${msg.subscriptionType} (причина: ${msg.status}) — заказы за баллы канала ` +
            'перестанут приходить. Чаще всего это значит, что доступ приложения к аккаунту стримера отозван — ' +
            'пройди авторизацию заново (npm run auth:twitch-points) и перезапусти приложение.',
        );
        return;

      default:
        return;
    }
  }

  private armKeepaliveWatchdog(): void {
    clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = setTimeout(() => {
      if (this.stopped) return;
      logger.warn('twitch-eventsub', 'От EventSub давно нет сообщений (даже keepalive) — переподключаюсь');
      this.openFresh();
    }, this.keepaliveTimeoutMs);
  }

  private rememberMessageId(id: string): void {
    this.seenMessageIds.add(id);
    if (this.seenMessageIds.size > SEEN_MESSAGE_IDS_LIMIT) {
      // Set хранит порядок вставки — первый элемент самый старый.
      const oldest = this.seenMessageIds.values().next().value;
      if (oldest !== undefined) this.seenMessageIds.delete(oldest);
    }
  }

  private async subscribe(socket: SocketLike, sessionId: string): Promise<void> {
    try {
      const token = await this.cfg.getAccessToken();
      const res = await this.fetchImpl('https://api.twitch.tv/helix/eventsub/subscriptions', {
        method: 'POST',
        headers: {
          'Client-Id': this.cfg.clientId,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: REDEMPTION_ADD_TYPE,
          version: '1',
          condition: { broadcaster_user_id: this.cfg.broadcasterId, reward_id: this.cfg.rewardId },
          transport: { method: 'websocket', session_id: sessionId },
        }),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      }
      logger.info('twitch-eventsub', 'Подписка на активации награды за баллы канала оформлена');
    } catch (err) {
      logger.error(
        'twitch-eventsub',
        `Не удалось подписаться на активации награды за баллы канала, повтор через ${SUBSCRIBE_FAILURE_RETRY_MS / 1000} сек.`,
        err,
      );
      if (socket === this.socket) {
        this.nextReconnectDelayMs = SUBSCRIBE_FAILURE_RETRY_MS;
        socket.close();
      }
    }
  }
}
