import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { MpvVolume } from '../src/music/mpvVolume.ts';

async function until(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error('IPC timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('mpv volume: delayed IPC, serialized latest value, mute, persistence and next process', async () => {
  const saved: unknown[] = [];
  const volume = new MpvVolume({ level: 50, muted: false }, (state) => saved.push(state));
  const session = volume.prepare(['--no-video', '--volume=99']);
  assert.ok(session.args.includes('--volume=50'));
  assert.ok(!session.args.includes('--volume=99'));
  const endpoint = session.args.find((arg) => arg.startsWith('--input-ipc-server='))!.split('=').slice(1).join('=');
  const child = new EventEmitter() as ChildProcess;
  const commands: number[] = [];
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n'); buffer = lines.pop()!;
      for (const line of lines) {
        const message = JSON.parse(line);
        commands.push(message.command[2]);
        setTimeout(() => {
          if (!socket.destroyed) socket.write(JSON.stringify({ request_id: message.request_id, error: 'success' }) + '\n');
        }, 30);
      }
    });
  });
  session.bind(child);
  // Изменение до появления IPC должно примениться после соединения.
  volume.set(30, false);
  server.listen(endpoint);
  await once(server, 'listening');
  try {
    await until(() => commands.length === 1);
    assert.equal(commands[0], 30);
    volume.set(40, false);
    volume.set(60, false);
    volume.set(75, false);
    await until(() => commands.includes(75));
    assert.deepEqual(commands, [30, 75]);
    volume.set(75, true);
    await until(() => commands.includes(0));
    assert.equal(volume.getState().level, 75);
    assert.ok(volume.prepare([]).args.includes('--volume=0'));
    volume.set(75, false);
    await until(() => commands.filter((level) => level === 75).length === 2);
    assert.ok(volume.prepare([]).args.includes('--volume=75'));
    assert.deepEqual(saved.at(-1), { level: 75, muted: false, error: null });
    assert.throws(() => volume.set(101, false));
    assert.throws(() => volume.set(NaN, false));
  } finally {
    child.emit('exit', 0);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
