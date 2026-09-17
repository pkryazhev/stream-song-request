import { eventBus } from '../core/eventBus.ts';
import { logger } from '../core/logger.ts';
import { formatTrackTitle } from './trackFormat.ts';
import type { CurrentTrackInfo } from './playbackOrchestrator.ts';
import type { ChatMessageEvent } from '../core/events.ts';

export interface CurrentTrackHandlerConfig {
  /** Например "!s". Сравнение регистронезависимое. */
  commandName: string;
}

/** Минимальный контракт оркестратора, который нужен обработчику команды "текущий трек". */
export interface CurrentTrackProvider {
  getCurrentTrack(): Promise<CurrentTrackInfo | null>;
}

function reply(text: string): void {
  eventBus.emit('chat.reply', { text });
}

/**
 * Подписывает команду "текущий трек" (по умолчанию !s) на чат Twitch.
 * Показывает трек в том же виде, в котором он отображается при добавлении
 * в очередь (см. formatTrackTitle) — просто название для YouTube,
 * "исполнитель - название" для Spotify.
 */
export function registerCurrentTrackHandler(
  orchestrator: CurrentTrackProvider,
  cfg: CurrentTrackHandlerConfig,
): () => void {
  const onChatMessage = (msg: ChatMessageEvent): void => {
    const [cmd] = msg.text.trim().split(/\s+/);
    if (!cmd || cmd.toLowerCase() !== cfg.commandName.toLowerCase()) return;

    orchestrator
      .getCurrentTrack()
      .then((track) => {
        if (!track) {
          reply('Сейчас ничего не играет');
          return;
        }
        reply(`Сейчас играет: "${formatTrackTitle(track.provider, track.title, track.author)}"`);
      })
      .catch((err: unknown) => {
        logger.error('music', 'Ошибка обработки команды "текущий трек"', err);
        reply(`@${msg.displayName} не получилось узнать текущий трек, попробуй ещё раз чуть позже`);
      });
  };

  eventBus.on('chat.message', onChatMessage);
  return () => eventBus.off('chat.message', onChatMessage);
}
