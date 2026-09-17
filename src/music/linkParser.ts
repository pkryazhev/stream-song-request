/**
 * Разбор ссылки из команды `!sr <ссылка>`. Принимаются только YouTube и
 * Spotify — всё остальное (включая просто текстовый поисковый запрос)
 * считается невалидной ссылкой.
 */

export type ParsedRequestLink =
  | { type: 'youtube'; videoId: string }
  | { type: 'spotify'; trackId: string }
  | { type: 'invalid' };

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);

// YouTube video id — ровно 11 символов из этого набора. Ссылки, especially
// присланные через чат, иногда приходят с "хвостом" из невидимых юникод-
// символов (комбинирующие диакритики, zero-width-символы и т.п. — например
// от того, откуда ссылку скопировали). Такие символы не всегда считаются
// "пробелом" для regex \s, поэтому trim()/split(/\s/) их не отсекают, и они
// раньше попадали прямо в videoId, из-за чего YouTube API не находил видео.
// Поэтому id не берём "как есть", а явно вычленяем ожидаемый формат.
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}/;

function extractYoutubeId(candidate: string | null): string | null {
  if (!candidate) return null;
  const match = candidate.match(YOUTUBE_ID_RE);
  return match ? match[0] : null;
}

export function parseRequestLink(raw: string): ParsedRequestLink {
  const trimmed = raw.trim();

  // spotify:track:<id> — это не URL в обычном смысле, разбираем отдельно
  if (trimmed.startsWith('spotify:track:')) {
    const trackId = trimmed.slice('spotify:track:'.length).split(/[?&\s]/)[0];
    return trackId ? { type: 'spotify', trackId } : { type: 'invalid' };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { type: 'invalid' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { type: 'invalid' };
  }

  const host = url.hostname.toLowerCase();

  if (host === 'youtu.be') {
    const videoId = extractYoutubeId(url.pathname.slice(1).split('/')[0]);
    return videoId ? { type: 'youtube', videoId } : { type: 'invalid' };
  }

  if (YOUTUBE_HOSTS.has(host)) {
    if (url.pathname === '/watch') {
      const videoId = extractYoutubeId(url.searchParams.get('v'));
      return videoId ? { type: 'youtube', videoId } : { type: 'invalid' };
    }
    const shortsMatch = url.pathname.match(/^\/shorts\/([^/]+)/);
    if (shortsMatch) {
      const videoId = extractYoutubeId(shortsMatch[1]);
      return videoId ? { type: 'youtube', videoId } : { type: 'invalid' };
    }
    return { type: 'invalid' };
  }

  if (host === 'open.spotify.com') {
    // поддерживаем и обычные, и локализованные пути вида /intl-ru/track/<id>
    const match = url.pathname.match(/\/track\/([a-zA-Z0-9]{10,30})/);
    return match ? { type: 'spotify', trackId: match[1] } : { type: 'invalid' };
  }

  return { type: 'invalid' };
}
