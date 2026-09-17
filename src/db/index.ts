import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Локальное хранилище на node:sqlite (встроен в Node, без зависимостей).
 * Используется для очереди музыкальных заказов (см. db/musicQueue.ts).
 */

let db: DatabaseSync | undefined;

export function initDb(path: string): void {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  db = new DatabaseSync(path);

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
