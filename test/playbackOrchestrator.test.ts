import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  PlaybackOrchestrator,
  type SpotifyPlaybackLike,
  type YoutubePlayerLike,
  type QueueLike,
} from '../src/music/playbackOrchestrator.ts';
import { setRequestsPaused } from '../src/music/requestsGate.ts';
import type { QueuedSongRequest } from '../src/db/musicQueue.ts';

beforeEach(() => {
  setRequestsPaused(false);
});

type PlaybackState = {
  isPlaying: boolean;
  progressMs: number;
  durationMs: number;
  trackUri: string | null;
  trackTitle?: string | null;
  trackArtist?: string | null;
} | null;

/** 'error' в скрипте — эмулирует транзиентный сбой сети (fetch failed / ECONNRESET и т.п.). */
type ScriptEntry = PlaybackState | 'error';

class FakeSpotify implements SpotifyPlaybackLike {
  playTrackUriCalls: string[] = [];
  playContextCalls: string[] = [];
  pauseCalls = 0;
  callCount = 0;
  pauseThrows = false;
  private scriptIndex = 0;
  private readonly script: ScriptEntry[];

  constructor(script: ScriptEntry[]) {
    this.script = script;
  }

  async getCurrentPlayback(): Promise<PlaybackState> {
    const value = this.script[Math.min(this.scriptIndex, this.script.length - 1)];
    this.scriptIndex += 1;
    this.callCount += 1;
    if (value === 'error') {
      throw new Error('fetch failed (эмуляция обрыва сети)');
    }
    return value;
  }

  async playTrackUri(uri: string): Promise<void> {
    this.playTrackUriCalls.push(uri);
  }

  async playContext(contextUri: string): Promise<void> {
    this.playContextCalls.push(contextUri);
  }

  async pause(): Promise<void> {
    this.pauseCalls += 1;
    if (this.pauseThrows) {
      throw new Error('сбой сети при попытке поставить Spotify на паузу');
    }
  }
}

class FakeYoutubePlayer implements YoutubePlayerLike {
  playCalls: string[] = [];

  play(url: string): { finished: Promise<void>; stop: () => void } {
    this.playCalls.push(url);
    return { finished: Promise.resolve(), stop: () => {} };
  }
}

class FakeQueue implements QueueLike {
  items: QueuedSongRequest[];

  constructor(items: QueuedSongRequest[]) {
    this.items = items;
  }

  peekNextPending(): QueuedSongRequest | undefined {
    return this.items.find((item) => item.status === 'pending');
  }

  markPlaying(id: number): void {
    const item = this.items.find((i) => i.id === id);
    if (item) item.status = 'playing';
  }

  markDone(id: number): void {
    const item = this.items.find((i) => i.id === id);
    if (item) item.status = 'done';
  }
}

function makeRequest(overrides: Partial<QueuedSongRequest> & Pick<QueuedSongRequest, 'id'>): QueuedSongRequest {
  return {
    provider: 'spotify',
    externalId: 'ext',
    playUri: 'spotify:track:default',
    title: 'Untitled',
    author: 'Author',
    durationSec: 200,
    requestedById: 'u1',
    requestedByLogin: 'viewer',
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const cfg = { defaultPlaylistUri: 'ctx', endOfTrackThresholdMs: 3000, pollIntervalMs: 5 };

test('не переключается на заказ, пока дефолтный трек не подходит к концу', async () => {
  const spotify = new FakeSpotify([{ isPlaying: true, progressMs: 10_000, durationMs: 300_000, trackUri: 'default' }]);
  const orchestrator = new PlaybackOrchestrator(spotify, new FakeYoutubePlayer(), new FakeQueue([]), cfg);

  await orchestrator.tick();

  assert.equal(spotify.playTrackUriCalls.length, 0);
  assert.equal(spotify.playContextCalls.length, 0);
  assert.equal(orchestrator.getMode(), 'default');
});

test('запускает дефолтный плейлист, если ничего не играет', async () => {
  const spotify = new FakeSpotify([null]);
  const orchestrator = new PlaybackOrchestrator(spotify, new FakeYoutubePlayer(), new FakeQueue([]), cfg);

  await orchestrator.tick();

  assert.deepEqual(spotify.playContextCalls, ['ctx']);
});

test('заказ включается вместо следующего трека плейлиста только когда текущий трек почти закончился', async () => {
  const spotify = new FakeSpotify([
    { isPlaying: true, progressMs: 298_000, durationMs: 300_000, trackUri: 'default' }, // remaining=2000 <= 3000
    { isPlaying: false, progressMs: 100_000, durationMs: 100_000, trackUri: 'spotify:track:1' },
  ]);
  const queue = new FakeQueue([makeRequest({ id: 1, playUri: 'spotify:track:1', title: 'Requested' })]);
  const orchestrator = new PlaybackOrchestrator(spotify, new FakeYoutubePlayer(), queue, cfg);

  await orchestrator.tick();

  assert.deepEqual(spotify.playTrackUriCalls, ['spotify:track:1']);
  assert.equal(queue.items[0].status, 'done');
  assert.equal(orchestrator.getMode(), 'default');
  assert.deepEqual(spotify.playContextCalls, ['ctx']);
});

test('несколько заказов обрабатываются строго по очереди (FIFO), разные провайдеры без приоритета', async () => {
  const spotify = new FakeSpotify([
    { isPlaying: true, progressMs: 299_000, durationMs: 300_000, trackUri: 'default' },
    { isPlaying: false, progressMs: 50_000, durationMs: 50_000, trackUri: 'spotify:track:1' },
  ]);
  const youtube = new FakeYoutubePlayer();
  const queue = new FakeQueue([
    makeRequest({ id: 1, provider: 'spotify', playUri: 'spotify:track:1', title: 'First' }),
    makeRequest({ id: 2, provider: 'youtube', playUri: 'https://youtu.be/second', title: 'Second' }),
  ]);
  const orchestrator = new PlaybackOrchestrator(spotify, youtube, queue, cfg);

  await orchestrator.tick();

  assert.deepEqual(spotify.playTrackUriCalls, ['spotify:track:1']);
  assert.deepEqual(youtube.playCalls, ['https://youtu.be/second']);
  assert.equal(queue.items[0].status, 'done');
  assert.equal(queue.items[1].status, 'done');
  assert.equal(orchestrator.getMode(), 'default');
  assert.deepEqual(spotify.playContextCalls, ['ctx']);
  // Перед вторым (YouTube) заказом Spotify должен быть поставлен на паузу —
  // иначе дефолтный плейлист продолжает играть поверх YouTube-заказа.
  assert.equal(spotify.pauseCalls, 1);
});

test('перед YouTube-заказом Spotify ставится на паузу (иначе играет поверх)', async () => {
  const spotify = new FakeSpotify([{ isPlaying: true, progressMs: 299_000, durationMs: 300_000, trackUri: 'default' }]);
  const youtube = new FakeYoutubePlayer();
  const queue = new FakeQueue([makeRequest({ id: 1, provider: 'youtube', playUri: 'https://youtu.be/only', title: 'Only' })]);
  const orchestrator = new PlaybackOrchestrator(spotify, youtube, queue, cfg);

  await orchestrator.tick();

  assert.equal(spotify.pauseCalls, 1);
  assert.deepEqual(youtube.playCalls, ['https://youtu.be/only']);
  assert.equal(queue.items[0].status, 'done');
  // После YouTube-заказа снова запускается дефолтный плейлист (уже не на паузе).
  assert.deepEqual(spotify.playContextCalls, ['ctx']);
});

test('если Spotify.pause() падает с ошибкой — YouTube-заказ всё равно проигрывается', async () => {
  const spotify = new FakeSpotify([{ isPlaying: true, progressMs: 299_000, durationMs: 300_000, trackUri: 'default' }]);
  spotify.pauseThrows = true;
  const youtube = new FakeYoutubePlayer();
  const queue = new FakeQueue([makeRequest({ id: 1, provider: 'youtube', playUri: 'https://youtu.be/only', title: 'Only' })]);
  const orchestrator = new PlaybackOrchestrator(spotify, youtube, queue, cfg);

  await orchestrator.tick();

  assert.equal(spotify.pauseCalls, 1);
  // Сбой паузы не должен отменять сам YouTube-заказ.
  assert.deepEqual(youtube.playCalls, ['https://youtu.be/only']);
  assert.equal(queue.items[0].status, 'done');
});

test('если трек ещё не подходит к концу, а в очереди есть заказ — планируется точная проверка на момент конца трека, а не следующий обычный опрос', async () => {
  // Заказ через YouTube — чтобы после переключения не упереться в
  // отдельный (медленный, с фиксированной первой паузой в pollIntervalMs)
  // цикл ожидания waitForSpotifyTrackToFinish; тут проверяется именно
  // сама точная проверка на уровне tick(), а не то, что происходит после неё.
  const spotify = new FakeSpotify([
    { isPlaying: true, progressMs: 0, durationMs: 400, trackUri: 'default' }, // remaining=400 > threshold(50) → задержка ~350мс
    { isPlaying: true, progressMs: 380, durationMs: 400, trackUri: 'default' }, // remaining=20 <= threshold(50) — пора переключаться
  ]);
  const youtube = new FakeYoutubePlayer();
  const queue = new FakeQueue([
    makeRequest({ id: 1, provider: 'youtube', playUri: 'https://youtu.be/only', title: 'Requested' }),
  ]);
  // Специально большой pollIntervalMs — обычный интервал точно не успеет
  // сработать за время теста, чтобы показать, что срабатывает именно
  // запланированная точная проверка (через ~350мс = remaining - threshold), а не он.
  const orchestrator = new PlaybackOrchestrator(spotify, youtube, queue, {
    defaultPlaylistUri: 'ctx',
    endOfTrackThresholdMs: 50,
    pollIntervalMs: 10_000,
  });

  try {
    await orchestrator.tick();
    // Сразу после первого опроса переключения ещё не было.
    assert.equal(youtube.playCalls.length, 0);
    assert.equal(queue.items[0].status, 'pending');

    // Ждём чуть больше расчётной задержки — orchestrator сам, без внешнего
    // вызова tick(), должен опросить Spotify ещё раз и переключиться.
    await new Promise((resolve) => setTimeout(resolve, 600));

    assert.deepEqual(youtube.playCalls, ['https://youtu.be/only']);
    assert.equal(queue.items[0].status, 'done');
  } finally {
    orchestrator.stop();
  }
});

test('если заказов нет — точная проверка не планируется, лишних опросов Spotify не происходит', async () => {
  const spotify = new FakeSpotify([{ isPlaying: true, progressMs: 0, durationMs: 100, trackUri: 'default' }]);
  const orchestrator = new PlaybackOrchestrator(spotify, new FakeYoutubePlayer(), new FakeQueue([]), {
    defaultPlaylistUri: 'ctx',
    endOfTrackThresholdMs: 50,
    pollIntervalMs: 10_000,
  });

  try {
    await orchestrator.tick();
    assert.equal(spotify.callCount, 1);

    await new Promise((resolve) => setTimeout(resolve, 200));
    // Нечего подхватывать — не должно быть никаких дополнительных опросов.
    assert.equal(spotify.callCount, 1);
  } finally {
    orchestrator.stop();
  }
});

test('stop() отменяет запланированную точную проверку конца трека', async () => {
  // durationMs=400/threshold=50 → без отмены проверка запланировалась бы
  // через ~350мс; ждём дольше этого (600мс), чтобы тест реально проверял
  // отмену, а не просто не успевал дождаться срабатывания.
  const spotify = new FakeSpotify([{ isPlaying: true, progressMs: 0, durationMs: 400, trackUri: 'default' }]);
  const queue = new FakeQueue([makeRequest({ id: 1, playUri: 'spotify:track:1', title: 'Requested' })]);
  const orchestrator = new PlaybackOrchestrator(spotify, new FakeYoutubePlayer(), queue, {
    defaultPlaylistUri: 'ctx',
    endOfTrackThresholdMs: 50,
    pollIntervalMs: 10_000,
  });

  await orchestrator.tick();
  orchestrator.stop();

  await new Promise((resolve) => setTimeout(resolve, 600));
  // stop() должен был отменить запланированный таймер — второго опроса не будет.
  assert.equal(spotify.callCount, 1);
});

test('транзиентная сетевая ошибка при опросе Spotify не обрывает заказ раньше времени', async () => {
  const spotify = new FakeSpotify([
    { isPlaying: true, progressMs: 299_000, durationMs: 300_000, trackUri: 'default' }, // tick: переключение на заказ
    'error', // первый опрос внутри ожидания конца трека — временный сбой сети
    { isPlaying: false, progressMs: 50_000, durationMs: 50_000, trackUri: 'spotify:track:1' }, // трек реально закончился
  ]);
  const queue = new FakeQueue([makeRequest({ id: 1, playUri: 'spotify:track:1', title: 'Requested' })]);
  const orchestrator = new PlaybackOrchestrator(spotify, new FakeYoutubePlayer(), queue, cfg);

  await orchestrator.tick();

  // Опрос дошёл до реального завершения трека, а не оборвался сразу на первой ошибке.
  assert.equal(spotify.callCount, 3);
  assert.equal(queue.items[0].status, 'done');
  assert.equal(orchestrator.getMode(), 'default');
  assert.deepEqual(spotify.playContextCalls, ['ctx']);
});

test('слишком много сбоев сети подряд при опросе Spotify — заказ помечается обработанным, а не зависает навсегда', async () => {
  const spotify = new FakeSpotify([
    { isPlaying: true, progressMs: 299_000, durationMs: 300_000, trackUri: 'default' },
    'error', // все дальнейшие обращения тоже вернут 'error' (последний элемент скрипта)
  ]);
  const queue = new FakeQueue([makeRequest({ id: 1, playUri: 'spotify:track:1', title: 'Requested' })]);
  const orchestrator = new PlaybackOrchestrator(spotify, new FakeYoutubePlayer(), queue, cfg);

  await orchestrator.tick();

  assert.equal(queue.items[0].status, 'done');
  assert.equal(orchestrator.getMode(), 'default');
  // 1 вызов из tick() + 5 неудачных попыток внутри ожидания (предел MAX_CONSECUTIVE_ERRORS)
  assert.equal(spotify.callCount, 6);
});

test('spotify не настроен (null) — заказ из очереди играет сразу, без ожидания "почти конца" (которого не существует)', async () => {
  const youtube = new FakeYoutubePlayer();
  const queue = new FakeQueue([makeRequest({ id: 1, provider: 'youtube', playUri: 'https://youtu.be/only', title: 'Only' })]);
  const orchestrator = new PlaybackOrchestrator(null, youtube, queue, cfg);

  await orchestrator.tick();

  assert.deepEqual(youtube.playCalls, ['https://youtu.be/only']);
  assert.equal(queue.items[0].status, 'done');
  assert.equal(orchestrator.getMode(), 'default');
});

test('spotify не настроен (null) — пустая очередь — tick() ничего не делает и не падает', async () => {
  const orchestrator = new PlaybackOrchestrator(null, new FakeYoutubePlayer(), new FakeQueue([]), cfg);
  await orchestrator.tick();
  assert.equal(orchestrator.getMode(), 'default');
});

test('spotify не настроен (null) — заказ через Spotify в очереди (не должно случаться в норме) пропускается, а не роняет оркестратор', async () => {
  const youtube = new FakeYoutubePlayer();
  const queue = new FakeQueue([
    makeRequest({ id: 1, provider: 'spotify', playUri: 'spotify:track:orphan', title: 'Orphan' }),
    makeRequest({ id: 2, provider: 'youtube', playUri: 'https://youtu.be/next', title: 'Next' }),
  ]);
  const orchestrator = new PlaybackOrchestrator(null, youtube, queue, cfg);

  await orchestrator.tick();

  assert.equal(queue.items[0].status, 'done'); // пропущен, а не завис навсегда
  assert.deepEqual(youtube.playCalls, ['https://youtu.be/next']);
  assert.equal(queue.items[1].status, 'done');
});

test('skip() вне режима "request" ничего не делает и возвращает false', () => {
  const spotify = new FakeSpotify([null]);
  const orchestrator = new PlaybackOrchestrator(spotify, new FakeYoutubePlayer(), new FakeQueue([]), cfg);
  assert.equal(orchestrator.skip(), false);
});

class ControllableYoutubePlayer implements YoutubePlayerLike {
  playCalls: string[] = [];
  stopCalls = 0;
  private resolveFinished: (() => void) | undefined;

  play(url: string): { finished: Promise<void>; stop: () => void } {
    this.playCalls.push(url);
    const finished = new Promise<void>((resolve) => {
      this.resolveFinished = resolve;
    });
    return {
      finished,
      stop: () => {
        this.stopCalls += 1;
        this.resolveFinished?.();
      },
    };
  }
}

test('skip() останавливает текущий YouTube-заказ — оркестратор сразу переходит дальше', async () => {
  const spotify = new FakeSpotify([{ isPlaying: true, progressMs: 299_000, durationMs: 300_000, trackUri: 'default' }]);
  const youtube = new ControllableYoutubePlayer();
  const queue = new FakeQueue([makeRequest({ id: 1, provider: 'youtube', playUri: 'https://youtu.be/only', title: 'Only' })]);
  const orchestrator = new PlaybackOrchestrator(spotify, youtube, queue, cfg);

  const tickPromise = orchestrator.tick();
  // Даём микрозадачам прокрутиться, чтобы плеер успел реально "запуститься"
  // (session.finished ещё не резолвится сам — ждёт нашего skip()).
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(orchestrator.getMode(), 'request');
  assert.deepEqual(youtube.playCalls, ['https://youtu.be/only']);

  assert.equal(orchestrator.skip(), true);
  await tickPromise;

  assert.equal(youtube.stopCalls, 1);
  assert.equal(queue.items[0].status, 'done');
  assert.equal(orchestrator.getMode(), 'default');
});

test('skip() прерывает ожидание конца Spotify-трека — не нужно ждать обычного интервала опроса', async () => {
  const spotify = new FakeSpotify([
    { isPlaying: true, progressMs: 299_000, durationMs: 300_000, trackUri: 'default' }, // tick: переключение на заказ
    { isPlaying: true, progressMs: 0, durationMs: 200_000, trackUri: 'spotify:track:1' }, // трек только начался
  ]);
  const queue = new FakeQueue([makeRequest({ id: 1, playUri: 'spotify:track:1', title: 'Requested' })]);
  // Специально большой pollIntervalMs — без skip() тест ждал бы 10с.
  const orchestrator = new PlaybackOrchestrator(spotify, new FakeYoutubePlayer(), queue, {
    defaultPlaylistUri: 'ctx',
    endOfTrackThresholdMs: 3000,
    pollIntervalMs: 10_000,
  });

  const tickPromise = orchestrator.tick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(orchestrator.getMode(), 'request');

  assert.equal(orchestrator.skip(), true);
  await tickPromise;

  assert.equal(queue.items[0].status, 'done');
  assert.equal(orchestrator.getMode(), 'default');
  assert.deepEqual(spotify.playContextCalls, ['ctx']);
});

test('getCurrentTrack() во время заказа возвращает данные из очереди, без обращения к Spotify', async () => {
  // YouTube-заказ — session.finished не резолвится сама, ждёт нашего skip(),
  // поэтому режим 'request' гарантированно ещё активен, когда мы проверяем getCurrentTrack().
  const spotify = new FakeSpotify([{ isPlaying: true, progressMs: 299_000, durationMs: 300_000, trackUri: 'default' }]);
  const youtube = new ControllableYoutubePlayer();
  const queue = new FakeQueue([
    makeRequest({ id: 1, provider: 'youtube', playUri: 'https://youtu.be/only', title: 'Requested', author: 'Requester Author' }),
  ]);
  const orchestrator = new PlaybackOrchestrator(spotify, youtube, queue, cfg);

  const tickPromise = orchestrator.tick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(orchestrator.getMode(), 'request');

  const callCountBefore = spotify.callCount;
  const current = await orchestrator.getCurrentTrack();
  assert.deepEqual(current, { provider: 'youtube', title: 'Requested', author: 'Requester Author' });
  // Во время заказа данные уже известны из очереди — лишний опрос Spotify не нужен.
  assert.equal(spotify.callCount, callCountBefore);

  orchestrator.skip();
  await tickPromise;
});

test('getCurrentTrack() во время дефолтного плейлиста опрашивает Spotify за названием/исполнителем', async () => {
  const spotify = new FakeSpotify([
    { isPlaying: true, progressMs: 10_000, durationMs: 300_000, trackUri: 'default', trackTitle: 'Default Track', trackArtist: 'Default Artist' },
  ]);
  const orchestrator = new PlaybackOrchestrator(spotify, new FakeYoutubePlayer(), new FakeQueue([]), cfg);

  const current = await orchestrator.getCurrentTrack();
  assert.deepEqual(current, { provider: 'spotify', title: 'Default Track', author: 'Default Artist' });
});

test('getCurrentTrack() без Spotify и без активного заказа — null (нечего показывать)', async () => {
  const orchestrator = new PlaybackOrchestrator(null, new FakeYoutubePlayer(), new FakeQueue([]), cfg);
  assert.equal(await orchestrator.getCurrentTrack(), null);
});

test('getCurrentTrack() — сбой опроса Spotify не падает наружу, возвращает null', async () => {
  const spotify = new FakeSpotify(['error']);
  const orchestrator = new PlaybackOrchestrator(spotify, new FakeYoutubePlayer(), new FakeQueue([]), cfg);
  assert.equal(await orchestrator.getCurrentTrack(), null);
});

test('заказы приостановлены (!pr) — tick() не перезапускает дефолтный плейлист', async () => {
  setRequestsPaused(true);
  const spotify = new FakeSpotify([null]);
  const orchestrator = new PlaybackOrchestrator(spotify, new FakeYoutubePlayer(), new FakeQueue([]), cfg);

  await orchestrator.tick();

  assert.equal(spotify.playContextCalls.length, 0);
});

test('haltDefaultPlaylist() останавливает дефолтный плейлист, пока играет он (mode === default)', async () => {
  const spotify = new FakeSpotify([{ isPlaying: true, progressMs: 10_000, durationMs: 300_000, trackUri: 'default' }]);
  const orchestrator = new PlaybackOrchestrator(spotify, new FakeYoutubePlayer(), new FakeQueue([]), cfg);

  await orchestrator.haltDefaultPlaylist();

  assert.equal(spotify.pauseCalls, 1);
});

test('haltDefaultPlaylist() ничего не делает во время заказа — не должен ставить сам заказ на паузу', async () => {
  const spotify = new FakeSpotify([{ isPlaying: true, progressMs: 299_000, durationMs: 300_000, trackUri: 'default' }]);
  const youtube = new ControllableYoutubePlayer();
  const queue = new FakeQueue([makeRequest({ id: 1, provider: 'youtube', playUri: 'https://youtu.be/only', title: 'Only' })]);
  const orchestrator = new PlaybackOrchestrator(spotify, youtube, queue, cfg);

  const tickPromise = orchestrator.tick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(orchestrator.getMode(), 'request');

  // К этому моменту Spotify уже мог быть поставлен на паузу перед самим
  // YouTube-заказом (см. playRequestsUntilEmpty) — проверяем, что
  // haltDefaultPlaylist() не добавляет ещё один вызов паузы поверх этого.
  const pauseCallsBefore = spotify.pauseCalls;
  await orchestrator.haltDefaultPlaylist();
  assert.equal(spotify.pauseCalls, pauseCallsBefore);

  orchestrator.skip();
  await tickPromise;
});

test('не трогает плеер, когда уже в режиме заказа и tick() дёргается повторно', async () => {
  const spotify = new FakeSpotify([{ isPlaying: true, progressMs: 0, durationMs: 300_000, trackUri: 'default' }]);
  const orchestrator = new PlaybackOrchestrator(spotify, new FakeYoutubePlayer(), new FakeQueue([]), cfg);

  // @ts-expect-error — доступ к приватному полю ради теста защиты от гонки
  orchestrator.mode = 'request';
  await orchestrator.tick();

  assert.equal(spotify.playTrackUriCalls.length, 0);
  assert.equal(spotify.playContextCalls.length, 0);
});
