#!/usr/bin/env node
/**
 * Вспомогательный скрипт: узнать числовой Twitch user id по логину.
 * Нужен для TWITCH_BROADCASTER_ID в .env.
 * Запуск: node scripts/twitch-user-id.ts <login>
 */
import { getAppAccessToken } from '../src/integrations/twitch/authClient.ts';

try {
  process.loadEnvFile();
} catch {
  // .env необязателен, если переменные заданы окружением
}

const login = process.argv[2];
if (!login) {
  console.error('Использование: node scripts/twitch-user-id.ts <login>');
  process.exit(1);
}

const clientId = process.env.TWITCH_CLIENT_ID;
const clientSecret = process.env.TWITCH_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Заполни TWITCH_CLIENT_ID и TWITCH_CLIENT_SECRET в .env перед запуском.');
  process.exit(1);
}

const token = await getAppAccessToken(clientId, clientSecret);
const res = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, {
  headers: { 'Client-Id': clientId, Authorization: `Bearer ${token}` },
});
if (!res.ok) {
  console.error(`Twitch API вернул ошибку HTTP ${res.status}`);
  process.exit(1);
}
const data = (await res.json()) as { data: Array<{ id: string; login: string; display_name: string }> };
const user = data.data[0];
console.log(user ? `id=${user.id}  login=${user.login}  display_name=${user.display_name}` : 'Пользователь не найден');
