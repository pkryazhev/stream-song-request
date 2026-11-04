import type { SpotifyDevice, SpotifyPlaybackController } from './spotifyProvider.ts';

/** Читает реальную громкость Spotify, сохраняя уровень для возврата из mute. */
export class SpotifyVolume {
  private device: SpotifyDevice | null = null;
  private level: number;
  private muted = false;
  private error: string | null = 'Получаем устройство Spotify…';
  private nextRefresh = 0;
  private refreshing: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private revision = 0;
  private retryAfterMs = 60_000;
  private api: Pick<SpotifyPlaybackController, 'getVolumeDevice' | 'setVolume'>;
  private save: (level: number) => void;

  constructor(api: Pick<SpotifyPlaybackController, 'getVolumeDevice' | 'setVolume'>, initialLevel = 50, save: (level: number) => void = () => {}) {
    this.api = api;
    this.level = Number.isInteger(initialLevel) && initialLevel > 0 && initialLevel <= 100 ? initialLevel : 50;
    this.save = save;
  }

  getState() {
    if (!this.refreshing && !this.pending && Date.now() >= this.nextRefresh) {
      this.refreshing = this.refresh().finally(() => { this.refreshing = null; });
    }
    return { level: this.level, muted: this.muted, supported: this.supported(), error: this.error,
      target: `spotify:${this.device?.id ?? ''}` };
  }

  private supported(): boolean {
    return !!this.device?.id && this.device.supportsVolume === true && !this.device.isRestricted && !this.error;
  }

  private async refresh(): Promise<void> {
    const revision = this.revision;
    this.nextRefresh = Date.now() + 3000;
    try {
      const device = await this.api.getVolumeDevice();
      if (revision !== this.revision || this.pending) return;
      this.device = device;
      this.error = !device ? 'Устройство Spotify не найдено. Открой Spotify на устройстве воспроизведения.'
        : device.isRestricted ? 'Устройство Spotify запрещает управление через API.'
        : !device.supportsVolume ? 'Устройство Spotify не поддерживает регулировку громкости через API.'
        : null;
      if (device?.volumePercent != null) {
        const actual = device.volumePercent;
        this.muted = actual === 0;
        if (actual > 0) this.level = actual;
      }
    } catch (error) {
      if (revision !== this.revision) return;
      this.error = error instanceof Error ? error.message : 'Не удалось получить громкость Spotify';
      this.nextRefresh = Date.now() + this.retryDelay(error);
    }
  }

  private retryDelay(error: unknown): number {
    const delay = (error as { retryAfterMs?: number } | null)?.retryAfterMs;
    return typeof delay === 'number' && Number.isFinite(delay) ? Math.max(60_000, delay) : 60_000;
  }

  set(level: number, muted: boolean, target: string): Promise<void> {
    if (!Number.isInteger(level) || level < 0 || level > 100 || typeof muted !== 'boolean') return Promise.reject(new Error('Некорректная громкость'));
    const device = this.device;
    if (!this.supported() || target !== `spotify:${device?.id}`) return Promise.reject(new Error('Устройство Spotify сменилось или недоступно'));
    this.pending++;
    this.revision++;
    const operation = this.queue.then(async () => {
      try {
        await this.api.setVolume(muted ? 0 : level, device!.id);
        this.level = level;
        this.muted = muted || level === 0;
        this.error = null;
        if (level > 0) this.save(level);
      } catch (error) {
        this.error = error instanceof Error ? error.message : 'Не удалось изменить громкость Spotify';
        this.retryAfterMs = this.retryDelay(error);
        throw error;
      } finally {
        this.pending--;
        this.nextRefresh = Date.now() + (this.error ? this.retryAfterMs : 3000);
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
