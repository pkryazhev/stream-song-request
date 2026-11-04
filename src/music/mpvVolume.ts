import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';

export interface VolumeState { level: number; muted: boolean; error: string | null }

/** Хранит желаемый уровень; каждый новый процесс получает собственный IPC-канал. */
export class MpvVolume {
  private level: number;
  private muted: boolean;
  private error: string | null = null;
  private sessions = new Set<() => void>();
  private save: (state: VolumeState) => void;

  constructor(initial: { level: number; muted: boolean }, save: (state: VolumeState) => void = () => {}) {
    this.save = save;
    this.level = Number.isFinite(initial.level) ? Math.min(100, Math.max(0, Math.round(initial.level))) : 50;
    this.muted = initial.muted;
  }

  getState(): VolumeState { return { level: this.level, muted: this.muted, error: this.error }; }

  set(level: number, muted: boolean): void {
    if (!Number.isInteger(level) || level < 0 || level > 100 || typeof muted !== 'boolean') throw new Error('Некорректная громкость');
    const next = { level, muted, error: null };
    this.save(next);
    this.level = level;
    this.muted = muted;
    for (const update of this.sessions) update();
  }

  prepare(args: string[]): { args: string[]; bind: (child: ChildProcess) => void } {
    const name = `stream-companion-${randomUUID()}`;
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
    return {
      args: [...args.filter((arg) => !arg.startsWith('--volume=')), `--volume=${this.muted ? 0 : this.level}`, `--input-ipc-server=${endpoint}`],
      bind: (child) => this.bind(child, endpoint),
    };
  }

  private bind(child: ChildProcess, endpoint: string): void {
    let socket: Socket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let ready = false;
    let pending = false;
    let sent = -1;
    let buffer = '';
    const started = Date.now();
    const desired = () => this.muted ? 0 : this.level;
    const update = () => {
      if (!ready || pending || sent === desired()) return;
      pending = true;
      sent = desired();
      socket!.write(JSON.stringify({ command: ['set_property', 'volume', sent], request_id: 1 }) + '\n');
      deadline = setTimeout(() => { this.error = 'mpv не подтвердил громкость'; socket?.destroy(); }, 2000);
    };
    const open = () => {
      if (closed) return;
      socket = connect(endpoint);
      socket.on('connect', () => { ready = true; sent = -1; update(); });
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        if (buffer.length > 65536) { socket?.destroy(); return; }
        const lines = buffer.split('\n');
        buffer = lines.pop()!;
        for (const line of lines) {
          try {
            const reply = JSON.parse(line);
            if (reply.request_id !== 1 || !pending) continue;
            clearTimeout(deadline);
            pending = false;
            if (reply.error !== 'success') { this.error = 'mpv отклонил изменение громкости'; continue; }
            this.error = null;
            update();
          } catch { /* События mpv не являются ответами на команду. */ }
        }
      });
      socket.on('error', () => { if (Date.now() - started > 3000) this.error = 'Нет связи с регулятором mpv'; });
      socket.on('close', () => {
        ready = false; pending = false; buffer = ''; clearTimeout(deadline);
        if (!closed) timer = setTimeout(open, 200);
      });
    };
    const cleanup = () => {
      closed = true;
      clearTimeout(timer); clearTimeout(deadline);
      socket?.destroy();
      this.sessions.delete(update);
      if (!this.sessions.size) this.error = null;
    };
    child.once('exit', cleanup);
    child.once('error', cleanup);
    this.sessions.add(update);
    open();
  }
}
