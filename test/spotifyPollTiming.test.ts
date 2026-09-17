import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEndOfTrackThresholdMs } from '../src/core/spotifyPollTiming.ts';

test('threshold >= pollInterval — используется как есть, без клампа', () => {
  const result = resolveEndOfTrackThresholdMs(4000, 5000);
  assert.deepEqual(result, { value: 5000, wasClamped: false });
});

test('threshold === pollInterval — используется как есть, без клампа (граница)', () => {
  const result = resolveEndOfTrackThresholdMs(4000, 4000);
  assert.deepEqual(result, { value: 4000, wasClamped: false });
});

test('threshold < pollInterval — поднимается до pollInterval, wasClamped=true (сам баг из тикета)', () => {
  // Ровно старые дефолты: pollIntervalMs=4000, endOfTrackThresholdMs=3000 —
  // такая связка давала ~25% шанс проскочить момент конца трека и не
  // подхватить заказ вовремя (очередь "не двигалась").
  const result = resolveEndOfTrackThresholdMs(4000, 3000);
  assert.deepEqual(result, { value: 4000, wasClamped: true });
});

test('очень маленький threshold относительно pollInterval — тоже поднимается', () => {
  const result = resolveEndOfTrackThresholdMs(4000, 100);
  assert.deepEqual(result, { value: 4000, wasClamped: true });
});
