import { getDb } from './index.ts';

/**
 * Простое key-value хранилище того, что приложение должно помнить между
 * запусками, но что не задаётся руками в .env (например, id награды за
 * баллы канала, которую приложение создало само — см. pointsMode.ts).
 */

export function getSetting(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}
