import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

test('Яндекс UI: кнопки только для Яндекса, подтверждение и снятие отметки, защита при смене трека', async () => {
  const nodes = new Map<string, any>();
  const get = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { style: {}, listeners: {}, attributes: {},
      addEventListener(key: string, fn: unknown) { this.listeners[key] = fn; },
      setAttribute(key: string, value: string) { this.attributes[key] = value; },
    });
    return nodes.get(id);
  };
  let provider = 'youtube';
  let playbackId = 1;
  let rating: string | null = null;
  const requests: string[] = [];
  let release!: () => void;
  const context = createContext({ document: { getElementById: get }, AbortSignal,
    setTimeout: () => 1, clearTimeout: () => {},
    fetch: async (url: string, options: any) => {
      if (url === '/control/state') return { ok: true, json: async () => ({ playbackId,
        track: { playing: true, provider }, volume: null,
        yandexRating: provider === 'yandex' ? { rating, ready: true, busy: false, error: null } : null,
        spotifyRating: provider === 'spotify' ? { rating, ready: true, busy: false, error: null } : null,
      }) };
      assert.equal(url, provider === 'spotify' ? '/control/spotify-rating' : '/control/yandex-rating');
      requests.push(options.headers['X-Rating']);
      await new Promise<void>((resolve) => { release = resolve; });
      rating = requests.at(-1) === 'none' ? null : requests.at(-1)!;
      return { ok: true, json: async () => ({ warning: null }) };
    },
  });
  runInContext(readFileSync(new URL('../src/overlay/control.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)![1], context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(get('ratings').hidden, true);
  provider = 'yandex'; await runInContext('refresh()', context);
  assert.equal(get('ratings').hidden, false);
  const first = get('like').listeners.click();
  get('dislike').listeners.click();
  assert.deepEqual(requests, ['like']);
  assert.equal(get('like').attributes['aria-pressed'], 'false');
  release(); await first;
  assert.equal(get('like').attributes['aria-pressed'], 'true');
  const second = get('like').listeners.click();
  assert.equal(requests.at(-1), 'none');
  release(); await second;
  assert.equal(get('like').attributes['aria-pressed'], 'false');
  const third = get('dislike').listeners.click();
  playbackId++; provider = 'youtube';
  await runInContext('refresh()', context);
  release(); await third;
  assert.equal(get('ratings').hidden, true);
  assert.equal(get('rating-status').textContent, '');
  provider = 'spotify'; playbackId++; rating = null;
  await runInContext('refresh()', context);
  assert.equal(get('ratings').hidden, false);
  assert.equal(get('dislike').hidden, true);
  const spotifyLike = get('like').listeners.click();
  release(); await spotifyLike;
  assert.equal(get('like').attributes['aria-pressed'], 'true');
  const spotifyUnlike = get('like').listeners.click();
  assert.equal(requests.at(-1), 'none');
  release(); await spotifyUnlike;
  assert.equal(get('like').attributes['aria-pressed'], 'false');
});
