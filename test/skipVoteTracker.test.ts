import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkipVoteTracker } from '../src/music/skipVoteTracker.ts';

const cfg = { thresholdPercent: 30, activeWindowMs: 10 * 60 * 1000 };

test('countActive считает только пользователей, активных в пределах activeWindowMs', () => {
  const tracker = new SkipVoteTracker(cfg);
  const now = 1_000_000;
  tracker.recordActivity('u1', now - 1000);
  tracker.recordActivity('u2', now - cfg.activeWindowMs - 1); // чуть-чуть просрочен
  assert.equal(tracker.countActive(now), 1);
});

test('requiredVotes — округление вверх (30% от 3 активных = 0.9 → нужен хотя бы 1)', () => {
  const tracker = new SkipVoteTracker(cfg);
  const now = 1000;
  tracker.recordActivity('u1', now);
  tracker.recordActivity('u2', now);
  tracker.recordActivity('u3', now);
  assert.equal(tracker.requiredVotes(now), 1);
});

test('requiredVotes растёт вместе с числом активных (30% от 10 = 3)', () => {
  const tracker = new SkipVoteTracker(cfg);
  const now = 1000;
  for (let i = 0; i < 10; i += 1) tracker.recordActivity(`u${i}`, now);
  assert.equal(tracker.requiredVotes(now), 3);
});

test('requiredVotes никогда не меньше 1, даже если активных 0', () => {
  const tracker = new SkipVoteTracker(cfg);
  assert.equal(tracker.requiredVotes(1000), 1);
});

test('vote() возвращает true только когда порог достигнут', () => {
  const tracker = new SkipVoteTracker(cfg);
  const now = 1000;
  for (let i = 0; i < 10; i += 1) tracker.recordActivity(`u${i}`, now); // нужно 3 голоса

  assert.equal(tracker.vote('u0', now), false);
  assert.equal(tracker.vote('u1', now), false);
  assert.equal(tracker.vote('u2', now), true);
});

test('повторный голос того же пользователя не засчитывается дважды', () => {
  const tracker = new SkipVoteTracker(cfg);
  const now = 1000;
  for (let i = 0; i < 10; i += 1) tracker.recordActivity(`u${i}`, now); // нужно 3 голоса

  tracker.vote('u0', now);
  tracker.vote('u0', now);
  tracker.vote('u0', now);
  assert.equal(tracker.voteCount, 1);
});

test('resetVotes() очищает голоса, но не активность зрителей', () => {
  const tracker = new SkipVoteTracker(cfg);
  const now = 1000;
  tracker.recordActivity('u1', now);
  tracker.vote('u1', now);
  assert.equal(tracker.voteCount, 1);

  tracker.resetVotes();
  assert.equal(tracker.voteCount, 0);
  assert.equal(tracker.countActive(now), 1); // активность сохранилась
});
