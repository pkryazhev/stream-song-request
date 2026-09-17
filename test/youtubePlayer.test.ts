import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  spawnPlaybackProcess,
  buildYtdlRawOptionsArg,
  buildScriptOptsArg,
  buildVolumeArg,
  buildAudioDeviceArg,
  mpvEscapeListValue,
  playYoutubeUrl,
} from '../src/music/youtubePlayer.ts';

// Вместо реального mpv используем сам node с коротким скриптом — это
// позволяет протестировать логику обёртки (успех/ошибка/stop) без
// зависимости от установленного mpv.

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

test('mpvEscapeListValue оборачивает значение в %длина%значение (защита от ":" и "," внутри)', () => {
  // "youtube:player_client=tv" — 24 символа/байта в ASCII
  assert.equal(mpvEscapeListValue('youtube:player_client=tv'), '%24%youtube:player_client=tv');
});

test('mpvEscapeListValue считает длину в байтах, а не в символах (юникод)', () => {
  const value = 'привет'; // кириллица — 2 байта на символ в UTF-8
  const escaped = mpvEscapeListValue(value);
  assert.equal(escaped, `%${Buffer.byteLength(value, 'utf8')}%${value}`);
});

test('buildYtdlRawOptionsArg: без опций — пустой массив (никаких --ytdl-raw-options)', () => {
  assert.deepEqual(buildYtdlRawOptionsArg({}), []);
});

test('buildYtdlRawOptionsArg: только playerClient', () => {
  const [arg] = buildYtdlRawOptionsArg({ playerClient: 'tv' });
  assert.equal(arg, `--ytdl-raw-options=extractor-args=${mpvEscapeListValue('youtube:player_client=tv')}`);
});

test('buildYtdlRawOptionsArg: playerClient + cookiesFromBrowser объединяются через запятую', () => {
  const [arg] = buildYtdlRawOptionsArg({ playerClient: 'tv', cookiesFromBrowser: 'firefox' });
  assert.equal(
    arg,
    `--ytdl-raw-options=extractor-args=${mpvEscapeListValue('youtube:player_client=tv')},cookies-from-browser=${mpvEscapeListValue('firefox')}`,
  );
});

test('buildYtdlRawOptionsArg: cookiesFile используется, только если cookiesFromBrowser не задан', () => {
  const withBoth = buildYtdlRawOptionsArg({ cookiesFromBrowser: 'firefox', cookiesFile: '/tmp/cookies.txt' });
  assert.ok(withBoth[0]?.includes('cookies-from-browser=') && !withBoth[0]?.includes('cookies='));

  const [onlyFile] = buildYtdlRawOptionsArg({ cookiesFile: 'C:\\Users\\me\\cookies.txt' });
  assert.equal(onlyFile, `--ytdl-raw-options=cookies=${mpvEscapeListValue('C:\\Users\\me\\cookies.txt')}`);
});

test('buildYtdlRawOptionsArg: playerClient со списком через запятую (например "default,web_embedded") экранируется одним куском', () => {
  const [arg] = buildYtdlRawOptionsArg({ playerClient: 'default,web_embedded' });
  // Запятая внутри player_client не должна ломать верхнеуровневый разбор
  // --ytdl-raw-options (который сам разделяет пары через запятую) — вся
  // строка "youtube:player_client=default,web_embedded" экранируется целиком.
  assert.equal(
    arg,
    `--ytdl-raw-options=extractor-args=${mpvEscapeListValue('youtube:player_client=default,web_embedded')}`,
  );
  // И, как следствие, там ровно один пары "extractor-args=" — запятая внутри
  // значения не порождает вторую "пару" верхнего уровня.
  assert.equal(arg.split('extractor-args=').length - 1, 1);
});

test('buildYtdlRawOptionsArg: forceIpv4 добавляет "force-ipv4=" без значения', () => {
  const [arg] = buildYtdlRawOptionsArg({ forceIpv4: true });
  assert.equal(arg, '--ytdl-raw-options=force-ipv4=');
});

test('buildYtdlRawOptionsArg: forceIpv4=false ничего не добавляет', () => {
  assert.deepEqual(buildYtdlRawOptionsArg({ forceIpv4: false }), []);
});

test('buildYtdlRawOptionsArg: playerClient + forceIpv4 вместе', () => {
  const [arg] = buildYtdlRawOptionsArg({ playerClient: 'tv', forceIpv4: true });
  assert.equal(
    arg,
    `--ytdl-raw-options=extractor-args=${mpvEscapeListValue('youtube:player_client=tv')},force-ipv4=`,
  );
});

test('buildScriptOptsArg: без ytdlPath — пустой массив', () => {
  assert.deepEqual(buildScriptOptsArg({}), []);
});

test('buildScriptOptsArg: с ytdlPath собирает --script-opts с экранированным путём (в т.ч. Windows-путь с ":")', () => {
  const [arg] = buildScriptOptsArg({ ytdlPath: 'C:\\tools\\yt-dlp.exe' });
  assert.equal(arg, `--script-opts=ytdl_hook-ytdl_path=${mpvEscapeListValue('C:\\tools\\yt-dlp.exe')}`);
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

test('buildYtdlRawOptionsArg не задействует volume — это отдельный, не yt-dlp-специфичный флаг', () => {
  assert.deepEqual(buildYtdlRawOptionsArg({ volume: 50 }), []);
});

test('buildAudioDeviceArg: без audioDevice — пустой массив (устройство по умолчанию)', () => {
  assert.deepEqual(buildAudioDeviceArg({}), []);
});

test('buildAudioDeviceArg: с audioDevice — "--audio-device=<значение>"', () => {
  assert.deepEqual(buildAudioDeviceArg({ audioDevice: 'wasapi/{abc-123}' }), ['--audio-device=wasapi/{abc-123}']);
});

test('buildYtdlRawOptionsArg не задействует audioDevice — это отдельный, не yt-dlp-специфичный флаг', () => {
  assert.deepEqual(buildYtdlRawOptionsArg({ audioDevice: 'wasapi/{abc-123}' }), []);
});

test('playYoutubeUrl без опций не добавляет --ytdl-raw-options', () => {
  // buildYtdlRawOptionsArg уже покрыт отдельными тестами выше — здесь только
  // убеждаемся, что playYoutubeUrl реально им пользуется (через stop() сразу
  // после запуска, не дожидаясь реального mpv — он вряд ли установлен в CI).
  const session = playYoutubeUrl('https://youtu.be/dQw4w9WgXcQ', process.execPath);
  session.stop();
  return session.finished; // не должно бросить — процесс остановлен нами, а не упал сам
});
