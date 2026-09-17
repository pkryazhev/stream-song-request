import { eventBus } from '../../core/eventBus.ts';
import { logger } from '../../core/logger.ts';
import type { StreamWentLiveEvent } from '../../core/events.ts';

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

/** Формирует текст анонса. Вынесено отдельной функцией — легко тестировать и менять шаблон. */
export function formatAnnouncement(event: StreamWentLiveEvent): string {
  const lines = [
    '🔴 Стрим начался!',
    event.title,
    event.gameName ? `Категория: ${event.gameName}` : undefined,
    `https://twitch.tv/${event.broadcasterLogin}`,
  ].filter((line): line is string => Boolean(line));
  return lines.join('\n');
}

/** Отправляет сообщение через Telegram Bot API. fetchImpl подменяется в тестах. */
export async function sendTelegramMessage(
  cfg: TelegramConfig,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: cfg.chatId,
      text,
      disable_web_page_preview: false,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram API вернул ошибку HTTP ${res.status}: ${body}`);
  }
}

/** Подписывает адаптер на событие 'stream.went_live' в общей шине событий. */
export function registerTelegramAdapter(cfg: TelegramConfig): void {
  eventBus.on('stream.went_live', (event) => {
    const text = formatAnnouncement(event);
    sendTelegramMessage(cfg, text)
      .then(() => logger.info('telegram', 'Анонс отправлен в Telegram'))
      .catch((err: unknown) => logger.error('telegram', 'Не удалось отправить анонс', err));
  });
}
