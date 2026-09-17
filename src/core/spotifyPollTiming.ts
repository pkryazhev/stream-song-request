/**
 * Оркестратор переключается на заказ, только когда опрос Spotify видит, что
 * до конца текущего дефолтного трека осталось не больше endOfTrackThresholdMs
 * (см. playbackOrchestrator.ts). Опрос происходит раз в pollIntervalMs.
 *
 * Если endOfTrackThresholdMs меньше pollIntervalMs, окно "трек почти
 * закончился" уже одного цикла опроса — есть реальный шанс, что ни один
 * опрос в него не попадёт (трек ещё не "почти закончился" на одном опросе,
 * а на следующем, pollIntervalMs позже, уже полностью закончился и Spotify
 * сам естественно продолжил дефолтный плейлист). В этом случае заказ из
 * очереди просто не подхватывается вовремя — выглядит как "переключение не
 * работает", хотя на самом деле это гонка между двумя настройками.
 *
 * Математически: если threshold >= pollInterval, хотя бы один опрос
 * гарантированно попадает в окно [0, threshold] до конца трека — потому что
 * между двумя соседними опросами remaining уменьшается ровно на
 * pollInterval, и если он был больше threshold на одном опросе, а
 * threshold >= pollInterval, то на следующем опросе remaining гарантированно
 * окажется в диапазоне (0, threshold]. Поэтому здесь threshold всегда
 * приводится к >= pollInterval.
 */
export interface EndOfTrackThresholdResolution {
  /** Итоговое значение, которое нужно использовать. */
  value: number;
  /** true, если запрошенное значение было меньше pollIntervalMs и его пришлось поднять. */
  wasClamped: boolean;
}

export function resolveEndOfTrackThresholdMs(
  pollIntervalMs: number,
  requestedThresholdMs: number,
): EndOfTrackThresholdResolution {
  const value = Math.max(requestedThresholdMs, pollIntervalMs);
  return { value, wasClamped: value !== requestedThresholdMs };
}
