import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { boundStartup } from '../src/music/playbackPolicy.ts';
import { watchPlaybackProgress, withRetryBeforeAudio } from '../src/music/youtubePlayer.ts';

test('progress confirmation requires three advancing seconds; buffering and seeks do not count', async () => {
  const stream = new PassThrough();
  let confirmed = false;
  const confirmation = watchPlaybackProgress([stream]).then(() => { confirmed = true; });
  stream.write('SC_PRO');
  stream.write('GRESS:0\rSC_PROGRESS:1\rSC_PROGRESS:1\rSC_PROGRESS:50\rSC_PROGRESS:51\r');
  await Promise.resolve();
  assert.equal(confirmed, false);
  stream.write('SC_PROGRESS:52\r');
  await confirmation;
});

test('startup budget stops a hung player and rejects, ignoring late confirmation', async () => {
  let stopped = false;
  let confirm!: () => void;
  const session = boundStartup({
    finished: new Promise(() => {}),
    playbackConfirmed: new Promise((resolve) => { confirm = resolve; }),
    stop: () => { stopped = true; },
  }, 20);
  await assert.rejects(session.finished, /20|0.02/);
  assert.equal(stopped, true);
  let confirmed = false;
  void session.playbackConfirmed?.then(() => { confirmed = true; });
  confirm();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(confirmed, false);
});

test('confirmation clears startup deadline; cancellation finishes even if resolver is hung', async () => {
  let finish!: () => void;
  const session = boundStartup({
    finished: new Promise((resolve) => { finish = resolve; }),
    playbackConfirmed: Promise.resolve(),
    stop: () => {},
  }, 20);
  await session.playbackConfirmed;
  await new Promise((resolve) => setTimeout(resolve, 30));
  finish();
  await session.finished;
  const hung = boundStartup({ finished: new Promise(() => {}), stop: () => {} }, 1000);
  hung.stop();
  await hung.finished;
});

test('clean EOF without confirmed playback is a failure', async () => {
  await assert.rejects(boundStartup({ finished: Promise.resolve(), stop: () => {} }, 100).finished, /подтверждения/);
});

test('permanent launch errors are not retried', async () => {
  let calls = 0;
  const session = withRetryBeforeAudio(() => {
    calls++;
    return { finished: Promise.reject(new Error('ENOENT')), audioStarted: new Promise(() => {}), stop: () => {} };
  }, 3);
  await assert.rejects(session.finished, /ENOENT/);
  assert.equal(calls, 1);
});
