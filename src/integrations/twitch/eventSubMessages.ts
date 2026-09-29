/**
 * Разбор сообщений Twitch EventSub WebSocket (без сетевого кода — легко
 * тестировать, как и ircParser.ts). Формат:
 * https://dev.twitch.tv/docs/eventsub/websocket-reference/
 */
import type { RewardRedeemedEvent } from '../../core/events.ts';

export const REDEMPTION_ADD_TYPE = 'channel.channel_points_custom_reward_redemption.add';

export type EventSubMessage =
  | { type: 'welcome'; sessionId: string; keepaliveTimeoutSec: number }
  | { type: 'keepalive' }
  | { type: 'notification'; messageId: string; subscriptionType: string; event: unknown }
  | { type: 'reconnect'; reconnectUrl: string }
  | { type: 'revocation'; subscriptionType: string; status: string }
  | { type: 'other' };

interface RawMessage {
  metadata?: { message_id?: string; message_type?: string; subscription_type?: string };
  payload?: {
    session?: { id?: string; keepalive_timeout_seconds?: number | null; reconnect_url?: string | null };
    subscription?: { type?: string; status?: string };
    event?: unknown;
  };
}

export function parseEventSubMessage(raw: string): EventSubMessage {
  let msg: RawMessage;
  try {
    msg = JSON.parse(raw) as RawMessage;
  } catch {
    return { type: 'other' };
  }
  const meta = msg.metadata ?? {};
  const payload = msg.payload ?? {};

  switch (meta.message_type) {
    case 'session_welcome':
      if (!payload.session?.id) return { type: 'other' };
      return {
        type: 'welcome',
        sessionId: payload.session.id,
        keepaliveTimeoutSec: payload.session.keepalive_timeout_seconds ?? 10,
      };
    case 'session_keepalive':
      return { type: 'keepalive' };
    case 'notification':
      return {
        type: 'notification',
        messageId: meta.message_id ?? '',
        subscriptionType: meta.subscription_type ?? payload.subscription?.type ?? '',
        event: payload.event,
      };
    case 'session_reconnect':
      if (!payload.session?.reconnect_url) return { type: 'other' };
      return { type: 'reconnect', reconnectUrl: payload.session.reconnect_url };
    case 'revocation':
      return {
        type: 'revocation',
        subscriptionType: payload.subscription?.type ?? '',
        status: payload.subscription?.status ?? '',
      };
    default:
      return { type: 'other' };
  }
}

/** Payload события channel.channel_points_custom_reward_redemption.add → событие приложения. */
export function toRewardRedeemedEvent(event: unknown): RewardRedeemedEvent | null {
  if (!event || typeof event !== 'object') return null;
  const e = event as {
    id?: string;
    user_id?: string;
    user_login?: string;
    user_name?: string;
    user_input?: string;
    reward?: { id?: string; title?: string };
  };
  if (!e.id || !e.user_id || !e.reward?.id) return null;
  return {
    redemptionId: e.id,
    rewardId: e.reward.id,
    rewardTitle: e.reward.title ?? '',
    userId: e.user_id,
    userLogin: e.user_login ?? '',
    userName: e.user_name || e.user_login || '',
    userInput: e.user_input ?? '',
  };
}
