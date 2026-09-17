import { getDb } from './index.ts';
import type { SongProvider } from '../core/events.ts';

export interface NewSongRequest {
  provider: SongProvider;
  externalId: string;
  /** Что именно передавать в плеер: spotify:track:... для Spotify либо URL для mpv/YouTube. */
  playUri: string;
  title: string;
  author: string;
  durationSec: number;
  requestedById: string;
  requestedByLogin: string;
}

export interface QueuedSongRequest extends NewSongRequest {
  id: number;
  status: 'pending' | 'playing' | 'done';
  createdAt: string;
}

interface SongRequestRow {
  id: number;
  provider: string;
  external_id: string;
  play_uri: string;
  title: string;
  author: string;
  duration_sec: number;
  requested_by_id: string;
  requested_by_login: string;
  status: string;
  created_at: string;
}

function rowToRequest(row: SongRequestRow): QueuedSongRequest {
  return {
    id: row.id,
    provider: row.provider as SongProvider,
    externalId: row.external_id,
    playUri: row.play_uri,
    title: row.title,
    author: row.author,
    durationSec: row.duration_sec,
    requestedById: row.requested_by_id,
    requestedByLogin: row.requested_by_login,
    status: row.status as QueuedSongRequest['status'],
    createdAt: row.created_at,
  };
}

/** Сколько заказов сейчас ждут своей очереди (не считая того, что уже играет). */
export function countPending(): number {
  const row = getDb().prepare(`SELECT COUNT(*) as c FROM song_requests WHERE status = 'pending'`).get() as {
    c: number;
  };
  return row.c;
}

/** Добавляет заказ в конец очереди. Возвращает id и позицию в очереди (1 = следующий). */
export function enqueueSongRequest(track: NewSongRequest): { id: number; position: number } {
  const db = getDb();
  const positionBefore = countPending();
  const info = db
    .prepare(
      `INSERT INTO song_requests
         (provider, external_id, play_uri, title, author, duration_sec, requested_by_id, requested_by_login, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(
      track.provider,
      track.externalId,
      track.playUri,
      track.title,
      track.author,
      track.durationSec,
      track.requestedById,
      track.requestedByLogin,
      new Date().toISOString(),
    );
  return { id: Number(info.lastInsertRowid), position: positionBefore + 1 };
}

/** Заказ, который должен играть следующим (самый старый pending, без приоритетов). */
export function peekNextPending(): QueuedSongRequest | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM song_requests WHERE status = 'pending' ORDER BY id ASC LIMIT 1`)
    .get() as SongRequestRow | undefined;
  return row ? rowToRequest(row) : undefined;
}

export function markPlaying(id: number): void {
  getDb().prepare(`UPDATE song_requests SET status = 'playing' WHERE id = ?`).run(id);
}

export function markDone(id: number): void {
  getDb().prepare(`UPDATE song_requests SET status = 'done' WHERE id = ?`).run(id);
}
