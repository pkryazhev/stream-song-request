/**
 * Spotify то добавляет, то убирает пункт меню "Copy Spotify URI" в разных
 * версиях приложения — полагаться на него неудобно. Проще принимать то, что
 * реально доступно для копирования (ссылка вида
 * https://open.spotify.com/playlist/<id>?si=...), а также сам URI и голый id
 * плейлиста — и приводить всё это к единому виду spotify:playlist:<id>,
 * который требует Spotify Web API в параметре context_uri.
 */
export function normalizeSpotifyPlaylistUri(raw: string): string {
  const trimmed = raw.trim();

  if (trimmed.startsWith('spotify:playlist:')) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed);
    const match = url.pathname.match(/\/playlist\/([a-zA-Z0-9]+)/);
    if (match) {
      return `spotify:playlist:${match[1]}`;
    }
  } catch {
    // не похоже на URL — возможно, это просто голый id плейлиста, см. ниже
  }

  if (/^[a-zA-Z0-9]{15,30}$/.test(trimmed)) {
    return `spotify:playlist:${trimmed}`;
  }

  throw new Error(
    `SPOTIFY_DEFAULT_PLAYLIST_URI: не удалось распознать плейлист в значении "${raw}". ` +
      'Подойдёт ссылка вида https://open.spotify.com/playlist/<id>, просто <id> или spotify:playlist:<id>.',
  );
}
