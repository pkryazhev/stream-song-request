import type { SpotifyPlaybackController } from './spotifyProvider.ts';

interface LikeState { rating: 'like' | null; ready: boolean; busy: boolean; error: string | null; refreshAt: number }

export class SpotifyLikes {
  private api: Pick<SpotifyPlaybackController, 'isTrackSaved' | 'setTrackSaved'>;
  private cache = new Map<string, LikeState>();
  constructor(api: Pick<SpotifyPlaybackController, 'isTrackSaved' | 'setTrackSaved'>) { this.api = api; }

  getState(uri: string) {
    let state = this.cache.get(uri);
    if (!state) {
      state = { rating: null, ready: false, busy: false, error: null, refreshAt: 0 };
      this.cache.set(uri, state);
      // Активные запросы не удаляем: их результат должен остаться связан с треком.
      for (const [key, entry] of this.cache) {
        if (this.cache.size <= 30) break;
        if (key !== uri && !entry.busy) this.cache.delete(key);
      }
    }
    if (!state.busy && Date.now() >= state.refreshAt) void this.refresh(uri, state);
    return { rating: state.rating, ready: state.ready, busy: state.busy, error: state.error };
  }

  private async refresh(uri: string, state: LikeState): Promise<void> {
    state.busy = true;
    try {
      state.rating = await this.api.isTrackSaved(uri) ? 'like' : null;
      state.ready = true;
      state.error = null;
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Не удалось получить лайк Spotify';
      state.ready = false;
    } finally { state.refreshAt = Date.now() + 60_000; state.busy = false; }
  }

  async set(uri: string, rating: 'like' | null): Promise<{ warning: null }> {
    const state = this.cache.get(uri);
    if (!state?.ready || state.busy) throw new Error('Лайк ещё загружается или действие уже выполняется');
    state.busy = true;
    try {
      await this.api.setTrackSaved(uri, rating === 'like');
      state.rating = rating;
      state.error = null;
      return { warning: null };
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Не удалось сохранить лайк Spotify';
      throw error;
    } finally { state.busy = false; state.refreshAt = Date.now() + 60_000; }
  }
}
