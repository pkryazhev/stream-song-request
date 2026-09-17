/** Разбор длительности вида ISO 8601 ("PT10M13S", "PT1H2M", "PT45S") в секунды. */
export function parseIso8601DurationToSeconds(iso: string): number {
  const match = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return 0;
  const [, h, m, s] = match;
  return Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
}

export interface YoutubeVideoDetails {
  videoId: string;
  title: string;
  channelTitle: string;
  durationSec: number;
}

/** Получает название/канал/длительность видео через YouTube Data API v3. */
export async function fetchYoutubeVideoDetails(
  videoId: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<YoutubeVideoDetails | null> {
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'snippet,contentDetails');
  url.searchParams.set('id', videoId);
  url.searchParams.set('key', apiKey);

  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`YouTube Data API вернул ошибку HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    items: Array<{
      snippet: { title: string; channelTitle: string };
      contentDetails: { duration: string };
    }>;
  };

  const item = data.items[0];
  if (!item) return null;

  return {
    videoId,
    title: item.snippet.title,
    channelTitle: item.snippet.channelTitle,
    durationSec: parseIso8601DurationToSeconds(item.contentDetails.duration),
  };
}
