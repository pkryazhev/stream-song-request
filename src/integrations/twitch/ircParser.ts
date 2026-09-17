/**
 * Разбор строк протокола Twitch IRC (без сетевого кода — легко тестировать).
 * Формат сообщения с тегами:
 *   @badge-info=;badges=broadcaster/1;display-name=Pavel;mod=0;user-id=123
 *   :pavel!pavel@pavel.tmi.twitch.tv PRIVMSG #pavel :!sr https://...
 */

export type ParsedIrcMessage =
  | { command: 'PING'; payload: string }
  | { command: 'PRIVMSG'; channel: string; text: string; tags: Record<string, string>; userLogin: string }
  | { command: 'OTHER' };

export function parseIrcLine(line: string): ParsedIrcMessage {
  if (line.startsWith('PING')) {
    return { command: 'PING', payload: line.slice('PING'.length).trim() };
  }

  let rest = line;
  let tags: Record<string, string> = {};

  if (rest.startsWith('@')) {
    const spaceIdx = rest.indexOf(' ');
    if (spaceIdx === -1) return { command: 'OTHER' };
    const tagString = rest.slice(1, spaceIdx);
    rest = rest.slice(spaceIdx + 1);
    tags = parseTags(tagString);
  }

  const prefixMatch = rest.match(/^:([^!]+)!/);
  const userLogin = prefixMatch ? prefixMatch[1] : '';

  const privmsgMatch = rest.match(/PRIVMSG #(\S+) :(.*)$/s);
  if (privmsgMatch) {
    return { command: 'PRIVMSG', channel: privmsgMatch[1], text: privmsgMatch[2], tags, userLogin };
  }

  return { command: 'OTHER' };
}

function parseTags(tagString: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const pair of tagString.split(';')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const key = pair.slice(0, eqIdx);
    const value = pair.slice(eqIdx + 1);
    tags[key] = decodeIrcTagValue(value);
  }
  return tags;
}

function decodeIrcTagValue(value: string): string {
  return value
    .replace(/\\s/g, ' ')
    .replace(/\\:/g, ';')
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\\\/g, '\\');
}
