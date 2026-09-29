import { eventBus } from '../core/eventBus.ts';
import { SkipVoteTracker } from './skipVoteTracker.ts';
import type { ChatMessageEvent, SongNowPlayingEvent } from '../core/events.ts';

export interface SkipVoteHandlerConfig {
  /** Например "!skip". Сравнение регистронезависимое. */
  commandName: string;
  thresholdPercent: number;
  activeWindowMs: number;
}

/** Минимальный контракт оркестратора, который нужен обработчику скипа. */
export interface SkipableOrchestrator {
  getMode(): 'default' | 'request';
  skip(): boolean;
  skipDefaultPlaylist(): boolean;
}

function reply(text: string): void {
  eventBus.emit('chat.reply', { text });
}

/**
 * Подписывает голосование за скип текущего трека на чат Twitch — как заказа,
 * так и трека дефолтного плейлиста (когда очередь заказов пуста).
 *
 * Условие (по требованию): трек скипается сразу, без порога, если команду
 * !skip введёт либо сам стример или модератор канала (по правам на скип
 * модератор равен стримеру; это скорее для YouTube-заказов, которые иначе не
 * переключить), либо (только для
 * заказов) тот же зритель, который этот трек и заказал (это его собственный
 * заказ — разумно, что он может передумать без голосования; у треков
 * дефолтного плейлиста заказчика нет, эта льгота на них не распространяется).
 * Для всех остальных — обычное голосование: наберётся достаточно голосов
 * зрителей — 30% (настраивается) от числа уникальных "активных" в чате (тех,
 * кто писал что-либо за последние activeWindowMs) — а не от общего числа
 * зрителей стрима, которое приложению взять неоткуда.
 *
 * Любое сообщение в чате (не только сама команда) отмечает автора активным —
 * иначе пришлось бы отдельно опрашивать список зрителей чата.
 *
 * Голоса за конкретный трек (и то, кто его заказал, если заказал) сбрасываются/
 * обновляются при старте следующего трека (событие song.now_playing, которое
 * оркестратор эмитит для каждого трека — и заказа, и дефолтного плейлиста).
 */
export interface SkipVoteHandlerHandle {
  tracker: SkipVoteTracker;
  /** Отписывает обработчик от eventBus — используется в тестах для изоляции между тестами. */
  unregister: () => void;
}

export function registerSkipVoteHandler(
  orchestrator: SkipableOrchestrator,
  cfg: SkipVoteHandlerConfig,
): SkipVoteHandlerHandle {
  const tracker = new SkipVoteTracker({ thresholdPercent: cfg.thresholdPercent, activeWindowMs: cfg.activeWindowMs });
  let currentRequesterId: string | null = null;

  const onNowPlaying = (payload: SongNowPlayingEvent): void => {
    tracker.resetVotes();
    currentRequesterId = payload.requestedById;
  };

  const doSkip = (): boolean =>
    orchestrator.getMode() === 'request' ? orchestrator.skip() : orchestrator.skipDefaultPlaylist();

  const onChatMessage = (msg: ChatMessageEvent): void => {
    tracker.recordActivity(msg.userId);

    const [cmd] = msg.text.trim().split(/\s+/);
    if (!cmd || cmd.toLowerCase() !== cfg.commandName.toLowerCase()) return;

    const isRequestMode = orchestrator.getMode() === 'request';

    if (msg.isBroadcaster || msg.isModerator) {
      if (doSkip()) {
        reply(msg.isBroadcaster ? 'Трек скипнут по команде стримера' : 'Трек скипнут по команде модератора');
      } else {
        reply(`@${msg.displayName} сейчас нечего скипать`);
      }
      return;
    }

    if (isRequestMode && currentRequesterId !== null && msg.userId === currentRequesterId) {
      if (orchestrator.skip()) {
        reply(`@${msg.displayName} трек скипнут — это был твой заказ`);
      }
      return;
    }

    const passed = tracker.vote(msg.userId);
    if (passed) {
      if (doSkip()) {
        reply(`Трек скипнут голосованием (${tracker.voteCount}/${tracker.requiredVotes()})`);
      } else {
        reply(`@${msg.displayName} сейчас нечего скипать`);
      }
    } else {
      reply(`@${msg.displayName} голос за скип принят (${tracker.voteCount}/${tracker.requiredVotes()})`);
    }
  };

  eventBus.on('song.now_playing', onNowPlaying);
  eventBus.on('chat.message', onChatMessage);

  return {
    tracker,
    unregister: () => {
      eventBus.off('song.now_playing', onNowPlaying);
      eventBus.off('chat.message', onChatMessage);
    },
  };
}
