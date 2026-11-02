import { timedFetch } from './playbackPolicy.ts';

// Public anonymous web client settings from vkvideo.ru, not user credentials.
const WEB_CLIENT_ID = '52461373';
const WEB_CLIENT_KEY = 'o557NLIkAErNhakXrQ7A';
const headers = { Origin: 'https://vkvideo.ru', Referer: 'https://vkvideo.ru/' };
const sessions = new WeakMap<typeof fetch, Promise<{ token: string; expires: number }>>();

export class VkSearchError extends Error {
  readonly unavailable: boolean;
  constructor(unavailable: boolean, message: string) {
    super(message);
    this.unavailable = unavailable;
    this.name = 'VkSearchError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  if (!res.ok) throw new VkSearchError([401, 403, 429].includes(res.status), `VK Video search HTTP ${res.status}`);
  let data: unknown;
  try { data = await res.json(); }
  catch { throw new VkSearchError(false, 'VK Video search returned invalid JSON'); }
  if (!record(data)) throw new VkSearchError(false, 'VK Video search returned an invalid response');
  if (data.error) {
    // API error payloads may include tokens in request_params; never log the payload.
    const code = record(data.error) && typeof data.error.error_code === 'number' ? data.error.error_code : undefined;
    throw new VkSearchError(true, `VK Video search API error ${code ?? 'unknown'}`);
  }
  return data;
}

async function anonymousSession(fetchImpl: typeof fetch): Promise<string> {
  let pending = sessions.get(fetchImpl);
  if (pending) {
    const session = await pending;
    if (session.expires > Date.now()) return session.token;
  }
  pending = (async () => {
    const data = await readJson(await fetchImpl('https://login.vk.ru/?act=get_anonym_token', {
      method: 'POST', headers,
      body: new URLSearchParams({ client_id: WEB_CLIENT_ID, client_secret: WEB_CLIENT_KEY,
        scopes: 'video_anonymous', version: '1', app_id: WEB_CLIENT_ID }),
    }));
    const session = data.data;
    if (data.type !== 'okay' || !record(session) || typeof session.access_token !== 'string' || !session.access_token) {
      throw new VkSearchError(true, 'VK Video did not issue an anonymous search session');
    }
    const expiry = session.expired_at ?? session.expires;
    const expires = typeof expiry === 'number' ? Math.min(Date.now() + 5 * 60_000, expiry * 1000 - 60_000) : Date.now();
    return { token: session.access_token, expires };
  })();
  sessions.set(fetchImpl, pending);
  try { return (await pending).token; }
  catch (error) { if (sessions.get(fetchImpl) === pending) sessions.delete(fetchImpl); throw error; }
}

/** Follow the default section's displayed order, not metadata arrays or clips. */
export function firstVkSearchVideo(data: unknown): string | null {
  if (!record(data) || !record(data.catalog) || !Array.isArray(data.catalog.sections)) {
    throw new VkSearchError(false, 'VK Video search catalog is missing');
  }
  const catalog = data.catalog;
  const section = catalog.sections.find((s: unknown) => record(s) && s.id === catalog.default_section);
  if (!record(section) || !Array.isArray(section.blocks)) throw new VkSearchError(false, 'VK Video search section is missing');
  for (const block of section.blocks) {
    if (!record(block) || block.data_type !== 'catalog_videos' || !record(block.layout) || block.layout.name !== 'large_list') continue;
    if (!Array.isArray(block.videos_ids)) throw new VkSearchError(false, 'VK Video search video IDs are missing');
    if (block.videos_ids.length === 0) continue;
    const id: unknown = block.videos_ids[0];
    if (typeof id !== 'string' || !/^-?[1-9]\d*_[1-9]\d*$/.test(id)) throw new VkSearchError(false, 'VK Video search returned an invalid video ID');
    return `https://vkvideo.ru/video${id}`;
  }
  return null;
}

/** Same anonymous catalog as the VK Video website; no personal token or cookies. */
export async function searchVkVideoByText(query: string, fetchImpl: typeof fetch = timedFetch): Promise<string | null> {
  if (!query.trim()) return null;
  const token = await anonymousSession(fetchImpl);
  try {
    const data = await readJson(await fetchImpl('https://api.vkvideo.ru/method/catalog.getVideoSearchWeb2', {
      method: 'POST', headers,
      body: new URLSearchParams({ access_token: token, v: '5.289', q: query.trim(), count: '10',
        screen_ref: 'search_video_service', sort: '2',
        enabled_features: JSON.stringify([{ name: 'safe_mode', enabled: true }]),
      }),
    }));
    return firstVkSearchVideo(data.response);
  } catch (error) {
    // Reacquire rejected sessions on the next order, without retrying API errors.
    if (error instanceof VkSearchError && error.unavailable) sessions.delete(fetchImpl);
    throw error;
  }
}
