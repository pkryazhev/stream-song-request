import { eventBus } from '../core/eventBus.ts';
import { logger } from '../core/logger.ts';
import { isRequestsPaused, setRequestsPaused } from './requestsGate.ts';
import type { ChatMessageEvent } from '../core/events.ts';

export interface RequestsToggleHandlerConfig {
  /** Например "!pr". Сравнение регистронезависимое. */
  pauseCommand: string;
  /** Например "!rr". Сравнение регистронезависимое. */
  resumeCommand: string;
}

/** Минимальный контракт оркестратора, нужный командам !pr/!rr. */
export interface DefaultPlaylistControllable {
  haltDefaultPlaylist(): Promise<void>;
  tick(): Promise<void>;
}

function reply(text: string): void {
  eventBus.emit('chat.reply', { text });
}

/**
 * Команды приостановки/возобновления заказов музыки (по умолчанию !pr/!rr) —
 * доступны только стримеру и модераторам. Пока заказы приостановлены:
 *  - requestHandler.ts отклоняет новые заказы понятным сообщением (см. requestsGate.ts);
 *  - дефолтный плейлист тоже не играет: текущий дефолтный трек
 *    останавливается и после снятия паузы начнётся заново (см.
 *    haltDefaultPlaylist в playbackOrchestrator.ts).
 * Уже принятые в очередь заказы не отменяются и доигрываются как обычно —
 * команда останавливает приём новых, а не то, что уже играет/ждёт своей очереди.
 */
export function registerRequestsToggleHandler(
  orchestrator: DefaultPlaylistControllable,
  cfg: RequestsToggleHandlerConfig,
): () => void {
  const onChatMessage = (msg: ChatMessageEvent): void => {
    const [cmd] = msg.text.trim().split(/\s+/);
    if (!cmd) return;
    const lower = cmd.toLowerCase();
    const isPauseCommand = lower === cfg.pauseCommand.toLowerCase();
    const isResumeCommand = lower === cfg.resumeCommand.toLowerCase();
    if (!isPauseCommand && !isResumeCommand) return;

    if (!msg.isBroadcaster && !msg.isModerator) return;

    if (isPauseCommand) {
      if (isRequestsPaused()) {
        reply('Заказы музыки уже приостановлены');
        return;
      }
      setRequestsPaused(true);
      reply('Заказы музыки приостановлены');
      orchestrator.haltDefaultPlaylist().catch((err: unknown) => {
        logger.error('music', 'Ошибка остановки дефолтного плейлиста при приостановке заказов', err);
      });
      return;
    }

    if (!isRequestsPaused()) {
      reply('Заказы музыки и так доступны');
      return;
    }
    setRequestsPaused(false);
    reply('Заказы музыки снова доступны');
    // Не ждём обычного pollIntervalMs — сразу пробуем перезапустить дефолтный плейлист.
    orchestrator.tick().catch((err: unknown) => {
      logger.error('music', 'Ошибка возобновления дефолтного плейлиста после снятия паузы заказов', err);
    });
  };

  eventBus.on('chat.message', onChatMessage);
  return () => eventBus.off('chat.message', onChatMessage);
}
