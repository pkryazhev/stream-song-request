import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface ControlDeps {
  getState: () => { playbackId: number; canSkip: boolean };
  skip: (playbackId: number) => boolean;
}

export function createControlPanel(deps: ControlDeps, getTrack: () => unknown) {
  const token = randomBytes(32).toString('hex');
  const html = readFileSync(new URL('./control.html', import.meta.url), 'utf8').replace('__CONTROL_TOKEN__', token);
  return (req: IncomingMessage, res: ServerResponse, path: string): boolean => {
    if (!['/control', '/control/', '/control/state', '/control/skip'].includes(path)) return false;
    const reply = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    const address = req.socket.localAddress;
    const host = req.headers.host;
    // Разрешаем только локальный адрес сервера; чужие Host/Origin не получают токен.
    const port = req.socket.localPort;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '') ||
        ![`127.0.0.1:${port}`, `localhost:${port}`].includes(host ?? '') ||
        (req.headers.origin && req.headers.origin !== `http://${host}`) ||
        req.headers['sec-fetch-site'] === 'cross-site') {
      reply(403, { error: 'Доступ запрещён' });
      return true;
    }
    if (path === '/control/skip') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        reply(405, { error: 'Нужен POST' });
      } else if (req.headers['x-control-token'] !== token) {
        reply(403, { error: 'Обновите страницу панели' });
      } else {
        const raw = req.headers['x-playback-id'];
        const id = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isSafeInteger(id)) reply(400, { error: 'Некорректный трек' });
        else if (!deps.skip(id)) reply(409, { error: 'Трек сменился или пока недоступен для скипа' });
        else reply(200, { ok: true });
      }
    } else if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      reply(405, { error: 'Нужен GET' });
    } else if (path === '/control/state') {
      reply(200, { ...deps.getState(), track: getTrack() });
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
      res.end(html);
    }
    return true;
  };
}
