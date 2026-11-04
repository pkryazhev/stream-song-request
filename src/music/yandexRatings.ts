import { timedFetch } from './playbackPolicy.ts';

export type YandexRating = 'like' | 'dislike' | null;
export type RatingEvent = 'like' | 'dislike' | 'unlike' | 'undislike';
interface YandexResult {
  account?: { uid?: string | number };
  library?: { tracks?: Array<{ id: string | number }> };
  revision?: number | string;
}

/** Отметки аккаунта; события волны отправляются отдельно от коллекции. */
export class YandexRatings {
  private token: string;
  private fetchImpl: typeof fetch;
  private uid: string | null = null;
  private likes = new Set<string>();
  private dislikes = new Set<string>();
  private loaded = false;
  private loading: Promise<void> | null = null;
  private pending = false;
  private revision = 0;
  private refreshAt = 0;
  private error: string | null = null;

  constructor(token: string, fetchImpl: typeof fetch = timedFetch) {
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  getState(trackId: string) {
    if (!this.loading && !this.pending && Date.now() >= this.refreshAt) {
      this.loading = this.refresh().finally(() => { this.loading = null; });
    }
    return { rating: this.rating(trackId), ready: this.loaded && !this.error,
      busy: this.pending || !this.loaded, error: this.error };
  }

  private rating(id: string): YandexRating {
    return this.dislikes.has(id) ? 'dislike' : this.likes.has(id) ? 'like' : null;
  }

  private async request(path: string, trackId?: string): Promise<YandexResult> {
    const response = await this.fetchImpl(`https://api.music.yandex.net${path}`, {
      method: trackId === undefined ? 'GET' : 'POST',
      headers: { Authorization: `OAuth ${this.token}`,
        ...(trackId === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) },
      ...(trackId === undefined ? {} : { body: new URLSearchParams({ 'track-ids': trackId }).toString() }),
    });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403
      ? 'Яндекс Музыка отклонила токен. Обнови YANDEX_MUSIC_TOKEN.'
      : `Не удалось обновить отметки Яндекс Музыки: HTTP ${response.status}`);
    const data = await response.json() as { result?: unknown; error?: unknown };
    if (data.error || data.result == null || typeof data.result !== 'object') throw new Error('Яндекс Музыка не подтвердила действие');
    return data.result as YandexResult;
  }

  private async refresh(): Promise<void> {
    const revision = this.revision;
    this.refreshAt = Date.now() + 60_000;
    try {
      if (!this.uid) {
        const account = await this.request('/account/status');
        if (!account.account?.uid) throw new Error('Яндекс Музыка не вернула ID аккаунта');
        this.uid = String(account.account.uid);
      }
      const results = await Promise.allSettled([
        this.request(`/users/${encodeURIComponent(this.uid)}/likes/tracks`),
        this.request(`/users/${encodeURIComponent(this.uid)}/dislikes/tracks`),
      ]);
      const sets = results.map((result) => {
        if (result.status === 'rejected') throw result.reason;
        const tracks = result.value.library?.tracks;
        if (!Array.isArray(tracks)) throw new Error('Не удалось прочитать отметки Яндекс Музыки');
        return new Set<string>(tracks.map((track: { id: string | number }) => String(track.id)));
      });
      if (this.revision !== revision) return;
      [this.likes, this.dislikes] = sets;
      this.loaded = true;
      this.error = null;
    } catch (error) {
      if (this.revision !== revision) return;
      this.error = error instanceof Error ? error.message : 'Нет связи с Яндекс Музыкой';
      this.refreshAt = Date.now() + 15_000;
    }
  }

  async set(trackId: string, rating: YandexRating, feedback?: (event: RatingEvent) => Promise<void>): Promise<{ warning: string | null }> {
    if (!this.loaded || this.pending || !this.uid) throw new Error('Отметки ещё загружаются или действие уже выполняется');
    if (!/^\d+$/.test(trackId) || ![null, 'like', 'dislike'].includes(rating)) throw new Error('Некорректная отметка');
    this.pending = true;
    this.revision++;
    const previous = this.rating(trackId);
    try {
      if (previous === rating) return { warning: null };
      const type = rating ?? previous;
      const action = rating === null ? 'remove' : 'add-multiple';
      const result = await this.request(`/users/${encodeURIComponent(this.uid)}/${type === 'like' ? 'likes' : 'dislikes'}/tracks/${action}`, trackId);
      if (!['number', 'string'].includes(typeof result.revision)) throw new Error('Яндекс Музыка не подтвердила сохранение отметки');
      this.likes.delete(trackId);
      this.dislikes.delete(trackId);
      if (rating === 'like') this.likes.add(trackId);
      if (rating === 'dislike') this.dislikes.add(trackId);
      this.error = null;
      if (feedback) {
        try {
          if (previous) await feedback(previous === 'like' ? 'unlike' : 'undislike');
          if (rating) await feedback(rating);
        } catch {
          return { warning: 'Отметка сохранена в аккаунте, но Моя волна не подтвердила событие.' };
        }
      }
      return { warning: null };
    } finally {
      this.pending = false;
      this.refreshAt = Date.now() + 60_000;
    }
  }
}
