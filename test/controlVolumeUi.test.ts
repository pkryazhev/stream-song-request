import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

test('volume UI serializes rapid edits, restores muted level, disables Spotify controls', async () => {
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, {
      value: '50', textContent: '', disabled: true, style: {}, listeners: {}, attributes: {},
      addEventListener(name: string, fn: () => void) { this.listeners[name] = fn; },
      setAttribute(name: string, value: string) { this.attributes[name] = value; },
    });
    return elements.get(id);
  };
  let supported = true;
  let target: string | undefined;
  let saved = { level: 50, muted: false };
  const writes: Array<{ level: number; muted: boolean }> = [];
  const pending: Array<() => void> = [];
  const context = createContext({
    document: { getElementById: element }, AbortSignal,
    setTimeout: () => 1, clearTimeout: () => {},
    fetch: async (url: string, options: any) => {
      if (url === '/control/state') return { ok: true, json: async () => ({
        playbackId: 1, canSkip: true, track: { playing: false }, volume: { ...saved, supported, target,
          error: supported ? null : 'Устройство Spotify не поддерживает громкость' },
      }) };
      assert.equal(url, '/control/volume');
      const value = { level: Number(options.headers['X-Volume']), muted: options.headers['X-Muted'] === 'true' };
      writes.push(value);
      await new Promise<void>((resolve) => pending.push(resolve));
      saved = value;
      return { ok: true, json: async () => ({ ...saved, supported, error: null }) };
    },
  });
  const script = readFileSync(new URL('../src/overlay/control.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)![1];
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  runInContext(script, context);
  await tick();
  const slider = element('volume');
  const mute = element('mute');
  assert.equal(slider.disabled, false);
  slider.value = '20'; slider.listeners.input(); slider.listeners.change();
  slider.value = '80'; slider.listeners.input(); slider.listeners.change();
  assert.deepEqual(writes, [{ level: 20, muted: false }]);
  pending.shift()!(); await tick();
  assert.deepEqual(writes[1], { level: 80, muted: false });
  pending.shift()!(); await tick();
  mute.listeners.click();
  assert.deepEqual(writes[2], { level: 80, muted: true });
  pending.shift()!(); await tick();
  mute.listeners.click();
  assert.deepEqual(writes[3], { level: 80, muted: false });
  pending.shift()!(); await tick();
  supported = false;
  await runInContext('refresh()', context);
  assert.equal(slider.disabled, true);
  assert.equal(mute.disabled, true);
  assert.match(element('volume-status').textContent, /Spotify/);
  supported = true;
  target = 'mpv';
  await runInContext('refresh()', context);
  slider.value = '20'; slider.listeners.input(); slider.listeners.change();
  slider.value = '30'; slider.listeners.input(); slider.listeners.change();
  target = 'spotify:desktop';
  saved = { level: 65, muted: false };
  await runInContext('refresh()', context);
  assert.equal(slider.disabled, false);
  assert.equal(Number(slider.value), 65);
  pending.shift()!(); await tick();
  assert.equal(writes.length, 5, 'отложенная правка mpv не отправляется в Spotify');
});
