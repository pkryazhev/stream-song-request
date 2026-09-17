#!/usr/bin/env node
/**
 * Вспомогательный скрипт: показать список устройств Spotify Connect,
 * видимых прямо сейчас (нужно, чтобы узнать точное имя для SPOTIFY_DEVICE_NAME).
 * Запуск: node scripts/spotify-devices.ts
 * Перед запуском открой Spotify (desktop/mobile/web) на устройстве(ах),
 * которые должны появиться в списке — иначе список будет пустым.
 */
import { createSpotifyUserTokenStore } from '../src/music/spotifyAuth.ts';
import { SpotifyPlaybackController } from '../src/music/spotifyProvider.ts';

try {
  process.loadEnvFile();
} catch {
  // .env необязателен, если переменные заданы окружением
}

const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
const tokenFilePath = process.env.SPOTIFY_TOKEN_FILE ?? './data/spotify-token.json';

if (!clientId || !clientSecret) {
  console.error('Заполни SPOTIFY_CLIENT_ID и SPOTIFY_CLIENT_SECRET в .env перед запуском.');
  process.exit(1);
}

const tokenStore = createSpotifyUserTokenStore({ clientId, clientSecret, tokenFilePath });
if (!tokenStore.load()) {
  console.error(`Нет сохранённого Spotify-токена (${tokenFilePath}). Сначала запусти "npm run auth:spotify".`);
  process.exit(1);
}

const controller = new SpotifyPlaybackController(tokenStore);
const devices = await controller.listDevices();

if (devices.length === 0) {
  console.log(
    'Устройств не найдено. Открой приложение Spotify (desktop/mobile/web) на устройстве, ' +
      'где должна играть музыка, и запусти скрипт ещё раз.',
  );
} else {
  console.log('Доступные устройства Spotify Connect:\n');
  for (const d of devices) {
    console.log(`  ${d.isActive ? '● активно' : '○'}  "${d.name}"  (id: ${d.id})`);
  }
  console.log('\nСкопируй нужное имя (то, что в кавычках) в SPOTIFY_DEVICE_NAME в .env.');
}
