import { eventBus } from '../../core/eventBus.ts';
import { logger } from '../../core/logger.ts';
import { parseIrcLine } from './ircParser.ts';
import type { ChatMessageEvent } from '../../core/events.ts';

export interface ChatClientConfig {
  botUsername: string;
  channelLogin: string;
  getAccessToken: () => Promise<string>;
}

const RECONNECT_DELAY_MS = 5000;
// Twitch лимитирует обычных пользователей ~20 сообщений/30 сек — держим
// заметный запас, чтобы не словить временный бан бота за флуд.
const OUTGOING_MIN_INTERVAL_MS = 1600;

/**
 * Клиент чата Twitch поверх IRC-over-WebSocket (wss://irc-ws.chat.twitch.tv).
 * Публикует входящие сообщения как 'chat.message' и слушает 'chat.reply' —
 * любой другой модуль (requestHandler и т.д.) не знает о деталях протокола.
 *
 * Сетевая часть здесь не покрыта тестами (нужен реальный WebSocket до Twitch) —
 * разбор строк протокола вынесен в ircParser.ts и протестирован отдельно.
 */
export class TwitchChatClient {
  private socket: WebSocket | undefined;
  private stopped = false;
  private outgoingQueue: string[] = [];
  private sendTimer: ReturnType<typeof setInterval> | undefined;
  private unsubscribeReply: (() => void) | undefined;
  private readonly cfg: ChatClientConfig;

  constructor(cfg: ChatClientConfig) {
    this.cfg = cfg;
  }

  async connect(): Promise<void> {
    this.stopped = false;
    await this.openSocket();

    const onReply = ({ text }: { text: string }): void => this.enqueueMessage(text);
    eventBus.on('chat.reply', onReply);
    this.unsubscribeReply = () => eventBus.off('chat.reply', onReply);

    this.sendTimer = setInterval(() => this.flushOutgoing(), OUTGOING_MIN_INTERVAL_MS);
  }

  disconnect(): void {
    this.stopped = true;
    if (this.sendTimer) clearInterval(this.sendTimer);
    this.unsubscribeReply?.();
    this.socket?.close();
  }

  private async openSocket(): Promise<void> {
    const token = await this.cfg.getAccessToken();
    const socket = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    this.socket = socket;

    socket.addEventListener('open', () => {
      socket.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      socket.send(`PASS oauth:${token}`);
      socket.send(`NICK ${this.cfg.botUsername}`);
      socket.send(`JOIN #${this.cfg.channelLogin}`);
      logger.info('twitch-chat', `Подключен к чату канала #${this.cfg.channelLogin}`);
    });

    socket.addEventListener('message', (event: MessageEvent) => {
      const raw = String(event.data);
      for (const line of raw.split('\r\n')) {
        if (line) this.handleLine(line);
      }
    });

    socket.addEventListener('close', () => {
      if (!this.stopped) {
        logger.warn(
          'twitch-chat',
          `Соединение с чатом разорвано, переподключение через ${RECONNECT_DELAY_MS / 1000} сек.`,
        );
        setTimeout(() => void this.openSocket(), RECONNECT_DELAY_MS);
      }
    });

    socket.addEventListener('error', () => {
      logger.error('twitch-chat', 'Ошибка WebSocket-соединения с чатом');
    });
  }

  private handleLine(line: string): void {
    const parsed = parseIrcLine(line);

    if (parsed.command === 'PING') {
      this.socket?.send(`PONG ${parsed.payload}`);
      return;
    }

    if (parsed.command === 'PRIVMSG') {
      const event: ChatMessageEvent = {
        userId: parsed.tags['user-id'] ?? '',
        login: parsed.userLogin,
        displayName: parsed.tags['display-name'] || parsed.userLogin,
        text: parsed.text,
        isModerator: parsed.tags.mod === '1',
        isBroadcaster: (parsed.tags.badges ?? '').includes('broadcaster/'),
      };
      eventBus.emit('chat.message', event);
    }
  }

  private enqueueMessage(text: string): void {
    this.outgoingQueue.push(text);
  }

  private flushOutgoing(): void {
    const next = this.outgoingQueue.shift();
    if (next && this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(`PRIVMSG #${this.cfg.channelLogin} :${next}`);
    }
  }
}
