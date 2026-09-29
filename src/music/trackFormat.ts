import type { SongProvider } from '../core/events.ts';

/**
 * Единый формат отображения трека в чате — используется и при постановке в
 * очередь (requestHandler.ts), и в ответе на команду "текущий трек"
 * (currentTrackHandler.ts), чтобы вид не расходился между двумя местами.
 */
export function formatTrackTitle(provider: SongProvider, title: string, author: string): string {
  // У YouTube "автор" — это канал, а не исполнитель, поэтому его не показываем.
  return provider === 'youtube' ? title : `${author} - ${title}`;
}
