import { getDb } from './index.ts';
import type { SongProvider } from '../core/events.ts';

/**
 * Треки дефолтного плейлиста — вторая "очередь" рядом с заказами
 * (db/musicQueue.ts). Заполняется целиком при старте приложения (и заново,
 * когда опустеет), играется по порядку id, проигранный трек удаляется.
 */

export interface NewDefaultTrack {
  provider: SongProvider;
  /** То же, что playUri заказа: spotify:track:..., yandex:track:... */
  playUri: string;
  title: string;
  author: string;
  durationSec: number;
}

export interface DefaultTrack extends NewDefaultTrack {
  id: number;
}

interface DefaultTrackRow {
  id: number;
  provider: string;
  play_uri: string;
  title: string;
  author: string;
  duration_sec: number;
}

/** Заменяет содержимое таблицы новым списком (в переданном порядке). */
export function replaceDefaultTracks(tracks: NewDefaultTrack[]): void {
  const db = getDb();
  const insert = db.prepare(
    'INSERT INTO default_tracks (provider, play_uri, title, author, duration_sec) VALUES (?, ?, ?, ?, ?)',
  );
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM default_tracks');
    for (const t of tracks) {
      insert.run(t.provider, t.playUri, t.title, t.author, t.durationSec);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Следующий трек дефолтного плейлиста (не удаляет его). */
export function peekNextDefaultTrack(): DefaultTrack | undefined {
  const row = getDb().prepare('SELECT * FROM default_tracks ORDER BY id LIMIT 1').get() as
    | DefaultTrackRow
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    provider: row.provider as SongProvider,
    playUri: row.play_uri,
    title: row.title,
    author: row.author,
    durationSec: row.duration_sec,
  };
}

export function removeDefaultTrack(id: number): void {
  getDb().prepare('DELETE FROM default_tracks WHERE id = ?').run(id);
}

export function countDefaultTracks(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM default_tracks').get() as { n: number }).n;
}
