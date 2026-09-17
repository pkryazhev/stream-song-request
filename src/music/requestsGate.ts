/**
 * Общий флаг "заказы музыки временно приостановлены" (команды !pr/!rr, см.
 * requestsToggleHandler.ts). Простое модульное состояние вместо события через
 * eventBus — как и, например, spotifyAuth.ts::resetSpotifyAppTokenCache,
 * оно одно на процесс и должно читаться синхронно сразу в нескольких местах
 * (requestHandler.ts — отклонять новые заказы, playbackOrchestrator.ts — не
 * перезапускать дефолтный плейлист), без накладных расходов на события.
 */
let paused = false;

export function isRequestsPaused(): boolean {
  return paused;
}

export function setRequestsPaused(value: boolean): void {
  paused = value;
}
