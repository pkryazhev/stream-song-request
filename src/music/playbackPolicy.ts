import type { PlaybackSession } from './youtubePlayer.ts';

/** Bounds headers and body consumption, including callers that supply no signal. */
export const timedFetch: typeof fetch = (input, init) => {
  const signal = AbortSignal.timeout(10_000);
  return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
};

/** One budget covers resolving, retries, buffering and the playback check. */
export function boundStartup(session: PlaybackSession, timeoutMs: number): PlaybackSession {
  let timer: ReturnType<typeof setTimeout>;
  let active = true;
  let confirmed = false;
  let cancel!: () => void;
  const cancelled = new Promise<void>((resolve) => { cancel = resolve; });
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      active = false;
      session.stop();
      reject(new Error(`Воспроизведение не подтверждено за ${timeoutMs / 1000} с`));
    }, timeoutMs);
  });
  const clear = () => { clearTimeout(timer); };
  const playbackConfirmed = session.playbackConfirmed?.then(() => {
    if (!active) return new Promise<void>(() => {});
    confirmed = true;
    clear();
  });
  const completed = session.finished.then(() => {
    if (active && !confirmed) throw new Error('Плеер завершился до подтверждения воспроизведения');
  });
  const finished = Promise.race([completed, deadline, cancelled]).finally(() => {
    active = false;
    clear();
  });
  return { ...session, playbackConfirmed, finished, stop: () => { active = false; clear(); session.stop(); cancel(); } };
}
