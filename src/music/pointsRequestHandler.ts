import { eventBus } from '../core/eventBus.ts';
import { logger } from '../core/logger.ts';
import { processSongRequest, describeLinkSources, type RequestHandlerConfig, type SongRequestOutcome } from './requestHandler.ts';
import type { RewardRedeemedEvent } from '../core/events.ts';
import type { RedemptionStatus } from '../integrations/twitch/channelPointsApi.ts';

export interface PointsRequestHandlerConfig {
  request: RequestHandlerConfig;
  /** Выполнить (FULFILLED) или отклонить с возвратом баллов (CANCELED) активацию в Twitch. */
  setRedemptionStatus: (redemption: RewardRedeemedEvent, status: RedemptionStatus) => Promise<void>;
}

function reply(text: string): void {
  eventBus.emit('chat.reply', { text });
}

/** Подписывает обработчик заказов за баллы канала на активации награды. */
export function registerPointsRequestHandler(cfg: PointsRequestHandlerConfig, fetchImpl: typeof fetch = fetch): () => void {
  const onRedeemed = (redemption: RewardRedeemedEvent): void => {
    void handleRedemption(redemption, cfg, fetchImpl);
  };
  eventBus.on('channel_points.redeemed', onRedeemed);
  return () => eventBus.off('channel_points.redeemed', onRedeemed);
}

/**
 * Одна активация награды "заказ музыки": те же правила, что и у команды
 * заказа (см. processSongRequest), кроме проверки фолловинга — за баллы
 * может заказывать любой зритель. Трек встал в очередь — активация
 * выполнена; не встал по любой причине (включая непредвиденную ошибку) —
 * активация отклоняется, и Twitch сам возвращает зрителю баллы.
 */
export async function handleRedemption(
  redemption: RewardRedeemedEvent,
  cfg: PointsRequestHandlerConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const requester = {
    userId: redemption.userId,
    login: redemption.userLogin,
    displayName: redemption.userName,
    isBroadcaster: redemption.userId === cfg.request.twitchBroadcasterId,
  };

  let outcome: SongRequestOutcome;
  try {
    outcome = await processSongRequest(
      requester,
      redemption.userInput,
      cfg.request,
      {
        emptyArgHint: `укажи ссылку на ${describeLinkSources(cfg.request, 'или')} в тексте награды "${redemption.rewardTitle}"`,
        requireFollower: false,
      },
      fetchImpl,
    );
  } catch (err) {
    logger.error('music', 'Ошибка обработки заказа музыки за баллы канала', err);
    outcome = {
      queued: false,
      replyText: `@${redemption.userName} не получилось обработать заказ, попробуй ещё раз чуть позже`,
    };
  }

  const status: RedemptionStatus = outcome.queued ? 'FULFILLED' : 'CANCELED';
  let statusUpdated = true;
  try {
    await cfg.setRedemptionStatus(redemption, status);
  } catch (err) {
    statusUpdated = false;
    logger.error(
      'music',
      `Не удалось отметить активацию награды ${redemption.redemptionId} (${redemption.userName}) как ${status} — ` +
        'её можно обработать вручную в очереди запросов наград на Twitch',
      err,
    );
  }

  if (outcome.queued || statusUpdated) {
    reply(outcome.replyText);
  } else {
    reply(`${outcome.replyText} (баллы не удалось вернуть автоматически — стример вернёт их вручную)`);
  }
}
