import type { SpotifyDevice, SpotifyPlaybackController } from './spotifyProvider.ts';

/** Один раз читает громкость Spotify, затем хранит изменения панели локально. */
export class SpotifyVolume {
  private device: SpotifyDevice | null = null;
  private level: number;
  private muted = false;
  private error: string | null = 'Получаем устройство Spotify…';
  private initialized = false;
  private queue: Promise<void> = Promise.resolve();
  private api: Pick<SpotifyPlaybackController, 'getVolumeDevice' | 'setVolume'>;
  private save: (level: number) => void;

  constructor(api: Pick<SpotifyPlaybackController, 'getVolumeDevice' | 'setVolume'>, initialLevel = 50, save: (level: number) => void = () => {}) {
    this.api = api;
    this.level = Number.isInteger(initialLevel) && initialLevel > 0 && initialLevel <= 100 ? initialLevel : 50;
    this.save = save;
  }

  getState() {
    if (!this.initialized) {
      this.initialized = true;
      void this.refresh();
    }
    return { level: this.level, muted: this.muted, supported: this.supported(), error: this.error,
      target: `spotify:${this.device?.id ?? ''}` };
  }

  private supported(): boolean {
    return !!this.device?.id && this.device.supportsVolume === true && !this.device.isRestricted && !this.error;
  }

  private async refresh(): Promise<void> {
    try {
      const device = await this.api.getVolumeDevice();
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
      this.error = error instanceof Error ? error.message : 'Не удалось получить громкость Spotify';
    }
  }

  set(level: number, muted: boolean, target: string): Promise<void> {
    if (!Number.isInteger(level) || level < 0 || level > 100 || typeof muted !== 'boolean') return Promise.reject(new Error('Некорректная громкость'));
    const device = this.device;
    if (!this.supported() || target !== `spotify:${device?.id}`) return Promise.reject(new Error('Устройство Spotify сменилось или недоступно'));
    const operation = this.queue.then(async () => {
      try {
        await this.api.setVolume(muted ? 0 : level, device!.id);
        this.level = level;
        this.muted = muted || level === 0;
        this.error = null;
        if (level > 0) this.save(level);
      } catch (error) {
        this.error = error instanceof Error ? error.message : 'Не удалось изменить громкость Spotify';
        throw error;
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
