import { timedFetch } from './playbackPolicy.ts';
import { parseIso8601DurationToSeconds } from './youtubeProvider.ts';
import type { NewDefaultTrack } from '../db/defaultTracks.ts';

interface PlaylistPage {
  items?: Array<{ contentDetails?: { videoId?: string } }>;
  nextPageToken?: string;
}
interface VideoPage {
  items?: Array<{
    id: string;
    snippet?: { title: string; channelTitle: string; liveBroadcastContent?: string };
    contentDetails?: { duration?: string };
    status?: { privacyStatus?: string; uploadStatus?: string };
  }>;
}

/** Принимает ссылку на подборку или видео внутри неё. */
export function parseYoutubePlaylistUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(url.hostname)) return null;
    const id = url.searchParams.get('list');
    // Персональные миксы и служебные списки не являются обычными плейлистами.
    return id && /^(PL|UU|OLAK5uy_)[A-Za-z0-9_-]+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Полный импорт: сначала все страницы состава, затем метаданные пачками по 50. */
export async function fetchYoutubePlaylistTracks(
  playlistId: string,
  apiKey: string,
  fetchImpl: typeof fetch = timedFetch,
): Promise<NewDefaultTrack[]> {
  async function request<T>(endpoint: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
    for (const [key, value] of Object.entries({ ...params, key: apiKey })) url.searchParams.set(key, value);
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(`YouTube ${endpoint}: HTTP ${response.status}. Проверь API-ключ и доступ к плейлисту (публичный или по ссылке).`);
    }
    return response.json();
  }

  const ids: string[] = [];
  const seenPages = new Set<string>();
  let pageToken = '';
  do {
    if (seenPages.has(pageToken)) throw new Error('YouTube вернул повторяющуюся страницу плейлиста');
    seenPages.add(pageToken);
    const page = await request<PlaylistPage>('playlistItems', { part: 'contentDetails', playlistId, maxResults: '50', pageToken });
    for (const item of page.items ?? []) {
      const id = item.contentDetails?.videoId;
      if (typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id)) ids.push(id);
    }
    pageToken = page.nextPageToken ?? '';
  } while (pageToken);

  const details = new Map<string, NewDefaultTrack>();
  const uniqueIds = [...new Set(ids)];
  for (let offset = 0; offset < uniqueIds.length; offset += 50) {
    const page = await request<VideoPage>('videos', {
      part: 'snippet,contentDetails,status', id: uniqueIds.slice(offset, offset + 50).join(','),
    });
    for (const video of page.items ?? []) {
      const durationSec = parseIso8601DurationToSeconds(video.contentDetails?.duration ?? '');
      if (!video.snippet || durationSec <= 0 || video.status?.privacyStatus === 'private' ||
          (video.status?.uploadStatus && video.status.uploadStatus !== 'processed') ||
          (video.snippet.liveBroadcastContent && video.snippet.liveBroadcastContent !== 'none')) continue;
      details.set(video.id, {
        provider: 'youtube', playUri: `https://www.youtube.com/watch?v=${video.id}`,
        title: video.snippet.title, author: video.snippet.channelTitle, durationSec,
      });
    }
  }
  // Ответ videos может быть в другом порядке; порядок исходного плейлиста сохраняем.
  return uniqueIds.flatMap((id) => details.has(id) ? [details.get(id)!] : []);
}
