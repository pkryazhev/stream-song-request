import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  spawnPlaybackProcess,
  spawnYtdlpMpvPipeline,
  buildYtdlpAudioArgs,
  buildVolumeArg,
  buildAudioDeviceArg,
  buildMpvStdinArgs,
  playYoutubeUrl,
} from '../src/music/youtubePlayer.ts';

// Вместо реального mpv/yt-dlp используем сам node с коротким скриптом — это
// позволяет протестировать логику обёртки (успех/ошибка/stop) без
// зависимости от установленных mpv/yt-dlp.

test('finished резолвится, когда процесс завершился с кодом 0', async () => {
  const session = spawnPlaybackProcess(process.execPath, ['-e', 'process.exit(0)']);
  await session.finished; // не должно бросить
});

test('finished отклоняется, если процесс завершился с ненулевым кодом', async () => {
  const session = spawnPlaybackProcess(process.execPath, ['-e', 'process.exit(1)']);
  await assert.rejects(() => session.finished, /завершился с кодом 1/);
});

test('stop() останавливает процесс и finished резолвится без ошибки', async () => {
  const session = spawnPlaybackProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  session.stop();
  await session.finished; // не должно бросить, несмотря на SIGTERM
});

test('finished при ошибке прикладывает вывод процесса (stdout/stderr) к сообщению об ошибке', async () => {
  const session = spawnPlaybackProcess(process.execPath, [
    '-e',
    'process.stderr.write("ERROR: не удалось разобрать ссылку"); process.exit(2)',
  ]);
  await assert.rejects(() => session.finished, /завершился с кодом 2[\s\S]*не удалось разобрать ссылку/);
});

test('buildYtdlpAudioArgs: без опций — только формат/вывод в stdout и сама ссылка', () => {
  assert.deepEqual(buildYtdlpAudioArgs('https://youtu.be/xyz', {}), [
    '-f',
    'bestaudio',
    '--no-playlist',
    '-o',
    '-',
    'https://youtu.be/xyz',
  ]);
});

test('buildYtdlpAudioArgs: playerClient добавляет --extractor-args', () => {
  const args = buildYtdlpAudioArgs('https://youtu.be/xyz', { playerClient: 'tv,web_safari,web_embedded' });
  assert.ok(args.includes('--extractor-args'));
  assert.equal(args[args.indexOf('--extractor-args') + 1], 'youtube:player_client=tv,web_safari,web_embedded');
});

test('buildYtdlpAudioArgs: cookiesFromBrowser добавляет --cookies-from-browser', () => {
  const args = buildYtdlpAudioArgs('https://youtu.be/xyz', { cookiesFromBrowser: 'firefox' });
  assert.ok(args.includes('--cookies-from-browser'));
  assert.equal(args[args.indexOf('--cookies-from-browser') + 1], 'firefox');
  assert.ok(!args.includes('--cookies'));
});

test('buildYtdlpAudioArgs: cookiesFile используется, только если cookiesFromBrowser не задан', () => {
  const withBoth = buildYtdlpAudioArgs('https://youtu.be/xyz', {
    cookiesFromBrowser: 'firefox',
    cookiesFile: 'C:\\cookies.txt',
  });
  assert.ok(withBoth.includes('--cookies-from-browser') && !withBoth.includes('--cookies'));

  const onlyFile = buildYtdlpAudioArgs('https://youtu.be/xyz', { cookiesFile: 'C:\\Users\\me\\cookies.txt' });
  assert.ok(onlyFile.includes('--cookies'));
  assert.equal(onlyFile[onlyFile.indexOf('--cookies') + 1], 'C:\\Users\\me\\cookies.txt');
});

test('buildYtdlpAudioArgs: forceIpv4 добавляет "--force-ipv4"', () => {
  const args = buildYtdlpAudioArgs('https://youtu.be/xyz', { forceIpv4: true });
  assert.ok(args.includes('--force-ipv4'));
});

test('buildYtdlpAudioArgs: forceIpv4=false ничего не добавляет', () => {
  const args = buildYtdlpAudioArgs('https://youtu.be/xyz', { forceIpv4: false });
  assert.ok(!args.includes('--force-ipv4'));
});

test('buildYtdlpAudioArgs: ссылка на видео — всегда последний аргумент', () => {
  const args = buildYtdlpAudioArgs('https://youtu.be/xyz', {
    playerClient: 'tv',
    cookiesFromBrowser: 'firefox',
    forceIpv4: true,
  });
  assert.equal(args.at(-1), 'https://youtu.be/xyz');
});

test('buildVolumeArg: без volume — пустой массив (используется дефолтная громкость mpv)', () => {
  assert.deepEqual(buildVolumeArg({}), []);
});

test('buildVolumeArg: с volume=50 — "--volume=50"', () => {
  assert.deepEqual(buildVolumeArg({ volume: 50 }), ['--volume=50']);
});

test('buildVolumeArg: volume=0 (не путать с "не задано") тоже передаётся', () => {
  assert.deepEqual(buildVolumeArg({ volume: 0 }), ['--volume=0']);
});

test('buildAudioDeviceArg: без audioDevice — пустой массив (устройство по умолчанию)', () => {
  assert.deepEqual(buildAudioDeviceArg({}), []);
});

test('buildAudioDeviceArg: с audioDevice — "--audio-device=<значение>"', () => {
  assert.deepEqual(buildAudioDeviceArg({ audioDevice: 'wasapi/{abc-123}' }), ['--audio-device=wasapi/{abc-123}']);
});

test('buildMpvStdinArgs: без опций — только --no-video и "-" (чтение из stdin)', () => {
  assert.deepEqual(buildMpvStdinArgs({}), ['--no-video', '-']);
});

test('buildMpvStdinArgs: volume/audioDevice добавляются перед --no-video/"-"', () => {
  assert.deepEqual(buildMpvStdinArgs({ volume: 25, audioDevice: 'wasapi/{abc}' }), [
    '--volume=25',
    '--audio-device=wasapi/{abc}',
    '--no-video',
    '-',
  ]);
});

test('playYoutubeUrl: stop() останавливает и yt-dlp, и mpv, finished резолвится без ошибки', async () => {
  const session = playYoutubeUrl('https://youtu.be/xyz', process.execPath, {
    ytdlPath: process.execPath,
  });
  session.stop();
  await session.finished; // не должно бросить, несмотря на то что оба процесса убиты
});

test('spawnYtdlpMpvPipeline: finished резолвится, когда yt-dlp и mpv оба завершились успешно', async () => {
  // "yt-dlp" — пишет немного байт в stdout и завершается с кодом 0.
  const ytdlpArgs = ['-e', 'process.stdout.write("fake audio bytes"); process.exit(0)'];
  // "mpv" — читает stdin до EOF и только тогда завершается с кодом 0
  // (так проверяем, что stdout yt-dlp реально прокинут в stdin mpv).
  const mpvArgs = ['-e', 'process.stdin.on("data", () => {}); process.stdin.on("end", () => process.exit(0));'];

  const session = spawnYtdlpMpvPipeline(process.execPath, ytdlpArgs, process.execPath, mpvArgs);
  await session.finished; // не должно бросить
});

test('spawnYtdlpMpvPipeline: если yt-dlp не смог скачать аудио — finished отклоняется с его выводом', async () => {
  const ytdlpArgs = ['-e', 'process.stderr.write("ERROR: Sign in to confirm you are not a bot"); process.exit(1)'];
  const mpvArgs = ['-e', 'process.stdin.on("data", () => {}); process.stdin.on("end", () => process.exit(0));'];

  const session = spawnYtdlpMpvPipeline(process.execPath, ytdlpArgs, process.execPath, mpvArgs);
  await assert.rejects(() => session.finished, /не смог скачать аудио[\s\S]*Sign in to confirm/);
});

test('spawnYtdlpMpvPipeline: если mpv упал с ошибкой (yt-dlp успешен) — finished отклоняется с выводом mpv', async () => {
  const ytdlpArgs = ['-e', 'process.stdout.write("fake audio bytes"); process.exit(0)'];
  const mpvArgs = ['-e', 'process.stderr.write("mpv: не смог проиграть"); process.exit(2)'];

  const session = spawnYtdlpMpvPipeline(process.execPath, ytdlpArgs, process.execPath, mpvArgs);
  await assert.rejects(() => session.finished, /завершился с кодом 2[\s\S]*не смог проиграть/);
});

test('spawnYtdlpMpvPipeline: stop() останавливает оба процесса, finished резолвится без ошибки', async () => {
  const ytdlpArgs = ['-e', 'setTimeout(() => {}, 60000)'];
  const mpvArgs = ['-e', 'setTimeout(() => {}, 60000)'];

  const session = spawnYtdlpMpvPipeline(process.execPath, ytdlpArgs, process.execPath, mpvArgs);
  session.stop();
  await session.finished;
});

test('audioStarted резолвится, когда mpv напечатал "AO: ..." (открыл аудиовыход)', async () => {
  const session = spawnPlaybackProcess(process.execPath, [
    '-e',
    'console.log("● Audio  --aid=1"); console.log("AO: [wasapi] 48000Hz stereo 2ch float"); setTimeout(() => {}, 60000)',
  ]);
  await session.audioStarted;
  session.stop();
  await session.finished;
});

test('audioStarted не резолвится, если процесс упал, так и не открыв аудиовыход', async () => {
  const session = spawnPlaybackProcess(process.execPath, ['-e', 'process.stderr.write("Failed to open x.mp3"); process.exit(2)']);
  const winner = await Promise.race([
    session.audioStarted!.then(() => 'audioStarted'),
    session.finished.then(
      () => 'finished',
      () => 'failed',
    ),
  ]);
  assert.equal(winner, 'failed');
});

test('spawnYtdlpMpvPipeline: audioStarted — по выводу mpv', async () => {
  const ytdlpArgs = ['-e', 'process.stdout.write("fake audio bytes"); process.exit(0)'];
  const mpvArgs = ['-e', 'console.log("AO: [null] 44100Hz mono 1ch floatp"); setTimeout(() => {}, 60000)'];

  const session = spawnYtdlpMpvPipeline(process.execPath, ytdlpArgs, process.execPath, mpvArgs);
  await session.audioStarted;
  session.stop();
  await session.finished;
});
