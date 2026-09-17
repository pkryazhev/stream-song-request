import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Локальное хранилище на node:sqlite (встроен в Node, без зависимостей).
 * Используется для дедупа анонсов ("этот стрим уже анонсирован, второй раз
 * не шлём") и для очереди музыкальных заказов (см. db/musicQueue.ts).
 */

let db: DatabaseSync | undefined;

export function initDb(path: string): void {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  db = new DatabaseSync(path);

  db.exec(`
    CREATE TABLE IF NOT EXISTS announced_streams (
      stream_id TEXT PRIMARY KEY,
      announced_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS song_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      play_uri TEXT NOT NULL,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      duration_sec INTEGER NOT NULL,
      requested_by_id TEXT NOT NULL,
      requested_by_login TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    )
  `);
}

/** Доступ к общему инстансу БД для остальных модулей (db/musicQueue.ts и т.п.). */
export function getDb(): DatabaseSync {
  if (!db) {
    throw new Error('База данных не инициализирована — вызови initDb() при старте приложения.');
  }
  return db;
}

export function hasAnnounced(streamId: string): boolean {
  const row = getDb().prepare('SELECT 1 FROM announced_streams WHERE stream_id = ?').get(streamId);
  return row !== undefined;
}

export function markAnnounced(streamId: string): void {
  getDb()
    .prepare('INSERT OR IGNORE INTO announced_streams (stream_id, announced_at) VALUES (?, ?)')
    .run(streamId, new Date().toISOString());
}
