import { getSpotifyAppToken } from './spotifyAuth.ts';
import type { SpotifyTrackDetails } from './spotifyProvider.ts';

interface SpotifySearchTrackItem {
  id: string;
  uri: string;
  name: string;
  artists: Array<{ name: string }>;
  duration_ms: number;
}

/**
 * Ищет трек в Spotify по свободному тексту (например "Artist - Title" или
 * просто "Title") и возвращает первый результат поиска — то есть то же
 * самое, что показал бы сам поиск в приложении Spotify первым пунктом.
 *
 * Раньше здесь была попытка требовать "однозначное" совпадение (ровно один
 * результат из нескольких первых должен был точно совпасть с запросом
 * после нормализации) — на практике это почти никогда не срабатывало:
 * у Spotify в базе почти для любого сколь-нибудь популярного трека
 * найдётся несколько версий (ремастеры, live, разные альбомы и т.п.),
 * поэтому "точных" совпадений либо не находилось вовсе, либо находилось
 * больше одного, и заказ почти всегда отклонялся. Первый результат поиска
 * Spotify и так, как правило, самый релевантный — этого достаточно.
 */
export async function searchSpotifyTrackByText(
  query: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SpotifyTrackDetails | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const token = await getSpotifyAppToken(clientId, clientSecret, fetchImpl);

  const url = new URL('https://api.spotify.com/v1/search');
  url.searchParams.set('q', trimmed);
  url.searchParams.set('type', 'track');
  url.searchParams.set('limit', '1');

  const res = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Spotify API (поиск трека) вернул ошибку HTTP ${res.status}`);
  }

  const data = (await res.json()) as { tracks?: { items: SpotifySearchTrackItem[] } };
  const match = data.tracks?.items?.[0];
  if (!match) return null;

  return {
    trackId: match.id,
    uri: match.uri,
    title: match.name,
    artist: match.artists.map((a) => a.name).join(', '),
    durationMs: match.duration_ms,
  };
}
