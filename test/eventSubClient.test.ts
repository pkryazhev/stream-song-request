import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventBus } from '../src/core/eventBus.ts';
import { TwitchEventSubClient, type SocketLike } from '../src/integrations/twitch/eventSubClient.ts';
import { parseEventSubMessage, toRewardRedeemedEvent } from '../src/integrations/twitch/eventSubMessages.ts';
import type { RewardRedeemedEvent } from '../src/core/events.ts';

class FakeSocket implements SocketLike {
  closed = false;
  readonly url: string;
  private readonly listeners = new Map<string, Array<(event?: { data: unknown }) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (event?: { data: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const l of this.listeners.get('close') ?? []) l();
  }

  receive(message: unknown): void {
    for (const l of this.listeners.get('message') ?? []) l({ data: JSON.stringify(message) });
  }
}

const welcome = (sessionId: string) => ({
  metadata: { message_id: `w-${sessionId}`, message_type: 'session_welcome' },
  payload: { session: { id: sessionId, keepalive_timeout_seconds: 10 } },
});

const redemptionNotification = (messageId: string, rewardId = 'reward-1') => ({
  metadata: {
    message_id: messageId,
    message_type: 'notification',
    subscription_type: 'channel.channel_points_custom_reward_redemption.add',
  },
  payload: {
    subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
    event: {
      id: `red-${messageId}`,
      user_id: 'viewer-1',
      user_login: 'viewer1',
      user_name: 'Viewer1',
      user_input: 'https://youtu.be/dQw4w9WgXcQ',
      status: 'unfulfilled',
      reward: { id: rewardId, title: 'Заказ музыки', cost: 500 },
    },
  },
});

function setup(): {
  client: TwitchEventSubClient;
  sockets: FakeSocket[];
  subscribeBodies: Array<Record<string, unknown>>;
  redeemed: RewardRedeemedEvent[];
  cleanup: () => void;
} {
  const sockets: FakeSocket[] = [];
  const subscribeBodies: Array<Record<string, unknown>> = [];
  const redeemed: RewardRedeemedEvent[] = [];
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    subscribeBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response('{}', { status: 202 });
  }) as typeof fetch;
  const client = new TwitchEventSubClient(
    { clientId: 'tw-cid', broadcasterId: 'broadcaster-1', rewardId: 'reward-1', getAccessToken: async () => 'tok' },
    fetchImpl,
    (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
  );
  const onRedeemed = (e: RewardRedeemedEvent): void => {
    redeemed.push(e);
  };
  eventBus.on('channel_points.redeemed', onRedeemed);
  return {
    client,
    sockets,
    subscribeBodies,
    redeemed,
    cleanup: () => {
      client.disconnect();
      eventBus.off('channel_points.redeemed', onRedeemed);
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('после session_welcome создаётся подписка на активации нужной награды с id сессии', async () => {
  const { client, sockets, subscribeBodies, cleanup } = setup();
  try {
    client.connect();
    sockets[0].receive(welcome('session-1'));
    await tick();
    assert.equal(subscribeBodies.length, 1);
    assert.deepEqual(subscribeBodies[0], {
      type: 'channel.channel_points_custom_reward_redemption.add',
      version: '1',
      condition: { broadcaster_user_id: 'broadcaster-1', reward_id: 'reward-1' },
      transport: { method: 'websocket', session_id: 'session-1' },
    });
  } finally {
    cleanup();
  }
});

test('уведомление об активации публикуется в шину; повтор с тем же message_id — игнорируется', async () => {
  const { client, sockets, redeemed, cleanup } = setup();
  try {
    client.connect();
    sockets[0].receive(welcome('session-1'));
    sockets[0].receive(redemptionNotification('m-1'));
    sockets[0].receive(redemptionNotification('m-1'));
    assert.equal(redeemed.length, 1);
    assert.deepEqual(redeemed[0], {
      redemptionId: 'red-m-1',
      rewardId: 'reward-1',
      rewardTitle: 'Заказ музыки',
      userId: 'viewer-1',
      userLogin: 'viewer1',
      userName: 'Viewer1',
      userInput: 'https://youtu.be/dQw4w9WgXcQ',
    });
  } finally {
    cleanup();
  }
});

test('активация другой награды канала игнорируется', async () => {
  const { client, sockets, redeemed, cleanup } = setup();
  try {
    client.connect();
    sockets[0].receive(welcome('session-1'));
    sockets[0].receive(redemptionNotification('m-1', 'other-reward'));
    assert.equal(redeemed.length, 0);
  } finally {
    cleanup();
  }
});

test('session_reconnect: новое соединение без повторной подписки, старое закрывается после welcome нового', async () => {
  const { client, sockets, subscribeBodies, cleanup } = setup();
  try {
    client.connect();
    sockets[0].receive(welcome('session-1'));
    await tick();
    sockets[0].receive({
      metadata: { message_id: 'r', message_type: 'session_reconnect' },
      payload: { session: { id: 'session-1', reconnect_url: 'wss://reconnect.example/ws' } },
    });
    assert.equal(sockets.length, 2);
    assert.equal(sockets[1].url, 'wss://reconnect.example/ws');
    assert.equal(sockets[0].closed, false);

    sockets[1].receive(welcome('session-1'));
    await tick();
    assert.equal(sockets[0].closed, true);
    assert.equal(subscribeBodies.length, 1);
    // Закрытие старого соединения — штатное, лишнего переподключения нет.
    assert.equal(sockets.length, 2);
  } finally {
    cleanup();
  }
});

test('parseEventSubMessage: мусор и незнакомые типы — "other"', () => {
  assert.deepEqual(parseEventSubMessage('не json'), { type: 'other' });
  assert.deepEqual(parseEventSubMessage('{"metadata":{"message_type":"что-то"}}'), { type: 'other' });
  assert.deepEqual(parseEventSubMessage('{"metadata":{"message_type":"session_keepalive"}}'), { type: 'keepalive' });
});

test('toRewardRedeemedEvent: без обязательных полей — null', () => {
  assert.equal(toRewardRedeemedEvent({ id: 'x' }), null);
  assert.equal(toRewardRedeemedEvent(null), null);
});
