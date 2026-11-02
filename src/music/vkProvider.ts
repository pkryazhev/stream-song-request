import { execFile } from 'node:child_process';
import { buildYtdlpInfoArgs, type YoutubePlaybackOptions } from './youtubePlayer.ts';
import { logger } from '../core/logger.ts';
import { fileURLToPath } from 'node:url';

// Только нативное видео ВК: переходы к YouTube и другим обработчикам запрещены.
export const VK_EXTRACTOR = 'vk';
export const VK_MATCH_FILTER = 'extractor_key = VK & !is_live';
export const VK_PLUGIN_DIR = fileURLToPath(new URL('../../scripts/ytdlp-plugins/', import.meta.url));
const thumbnails = new Map<string, { url: string | null; expires: number }>();

export function vkThumbnailFromInfo(info: Record<string, unknown>): string | null {
  const candidates = [info.thumbnail, ...(Array.isArray(info.thumbnails) ? [...info.thumbnails].reverse().map((t) => t?.url) : [])];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    try {
      const url = new URL(candidate);
      // ВК также использует CDN Одноклассников (iv.okcdn.ru).
      if (url.protocol === 'https:' && /(^|\.)(?:userapi\.com|vk\.com|vk\.ru|vkvideo\.ru|vkuserphoto\.ru|vkvideo\.net|okcdn\.ru)$/.test(url.hostname) && !url.username && !url.password && !url.port) return url.href;
    } catch { /* malformed thumbnail */ }
  }
  return null;
}

export async function fetchVkThumbnail(url: string, ytdlPath?: string): Promise<string | null> {
  const cached = thumbnails.get(url);
  if (cached && cached.expires > Date.now()) return cached.url;
  await fetchVkVideoDetails(url, { ytdlPath });
  return thumbnails.get(url)?.url ?? null;
}

export function describeVkExtractionError(error: { code?: string | number; killed?: boolean }, stderr: string): string {
  if (error.code === 'ENOENT') return 'не найден yt-dlp — проверь установку и YTDLP_PATH';
  if (stderr.includes("'NoneType' object has no attribute 'split'")) return 'ошибка yt-dlp при разборе субтитров ВК — проверь подключение локального исправления';
  if (error.killed) return 'ВК не ответил вовремя — попробуй заказать видео позже';
  return 'не удалось проверить видео ВК — подробности записаны в лог';
}

export interface VkVideoDetails {
  title: string;
  author: string;
  durationSec: number;
}

export function validateVkVideoInfo(info: Record<string, unknown>): VkVideoDetails {
  if (info.extractor_key !== 'VK' || info._type === 'url' || info._type === 'url_transparent' || info._type === 'playlist') {
    throw new Error('принимаются только видео, загруженные непосредственно в ВК');
  }
  if (info.is_live || (info.live_status && !['not_live', 'was_live'].includes(String(info.live_status)))) {
    throw new Error('прямые эфиры ВК не принимаются');
  }
  if (typeof info.duration !== 'number' || !Number.isFinite(info.duration) || info.duration <= 0) {
    throw new Error('не удалось определить длительность видео ВК');
  }
  if (typeof info.title !== 'string' || !info.title.trim()) throw new Error('не удалось получить название видео ВК');
  if (!Array.isArray(info.formats) || !info.formats.some((f) => f && typeof f.url === 'string' && /^https?:\/\//.test(f.url) && f.acodec !== 'none' && !f.has_drm)) {
    throw new Error('у видео ВК нет доступного потока со звуком');
  }
  return { title: info.title, author: typeof info.uploader === 'string' ? info.uploader : '', durationSec: Math.ceil(info.duration) };
}

export function fetchVkVideoDetails(url: string, options: YoutubePlaybackOptions = {}): Promise<VkVideoDetails> {
  return new Promise((resolve, reject) => {
    execFile(options.ytdlPath ?? 'yt-dlp', buildYtdlpInfoArgs(url, { allowedExtractors: VK_EXTRACTOR, matchFilter: VK_MATCH_FILTER, pluginDirs: VK_PLUGIN_DIR }), {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        logger.warn('music', `Не удалось проверить видео ВК (${url}, код ${error.code}, остановлен: ${error.killed ?? false}):\n${stderr.trim().slice(-4000) || error.message}`);
        return reject(new Error(describeVkExtractionError(error, stderr)));
      }
      try {
        if (!stdout.trim()) throw new Error('видео отклонено: принимаются только нативные видео ВК без прямых эфиров');
        const info = JSON.parse(stdout);
        const details = validateVkVideoInfo(info);
        thumbnails.delete(url);
        thumbnails.set(url, { url: vkThumbnailFromInfo(info), expires: Date.now() + 30 * 60_000 });
        while (thumbnails.size > 100) thumbnails.delete(thumbnails.keys().next().value!);
        resolve(details);
      }
      catch (err) { reject(err); }
    });
  });
}
