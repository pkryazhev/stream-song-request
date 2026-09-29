import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequestLink } from '../src/music/linkParser.ts';

test('распознаёт обычную ссылку youtube.com/watch?v=', () => {
  const result = parseRequestLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.deepEqual(result, { type: 'youtube', videoId: 'dQw4w9WgXcQ' });
});

test('распознаёт короткую ссылку youtu.be', () => {
  const result = parseRequestLink('https://youtu.be/dQw4w9WgXcQ?t=10');
  assert.deepEqual(result, { type: 'youtube', videoId: 'dQw4w9WgXcQ' });
});

test('распознаёт youtube shorts', () => {
  const result = parseRequestLink('https://www.youtube.com/shorts/abc123XYZ_-');
  assert.deepEqual(result, { type: 'youtube', videoId: 'abc123XYZ_-' });
});

test('распознаёт ссылку open.spotify.com/track', () => {
  const result = parseRequestLink('https://open.spotify.com/track/6habFhsOp2NvshLv26DqMb?si=abc123');
  assert.deepEqual(result, { type: 'spotify', trackId: '6habFhsOp2NvshLv26DqMb' });
});

test('распознаёт локализованную ссылку open.spotify.com/intl-.../track', () => {
  const result = parseRequestLink('https://open.spotify.com/intl-ru/track/6habFhsOp2NvshLv26DqMb');
  assert.deepEqual(result, { type: 'spotify', trackId: '6habFhsOp2NvshLv26DqMb' });
});

test('распознаёт spotify:track: URI', () => {
  const result = parseRequestLink('spotify:track:6habFhsOp2NvshLv26DqMb');
  assert.deepEqual(result, { type: 'spotify', trackId: '6habFhsOp2NvshLv26DqMb' });
});

test('невалидно: произвольный текст вместо ссылки', () => {
  assert.deepEqual(parseRequestLink('включи битлз'), { type: 'invalid' });
});

test('невалидно: ссылка на другой сайт', () => {
  assert.deepEqual(parseRequestLink('https://soundcloud.com/some-track'), { type: 'invalid' });
});

test('невалидно: youtube-ссылка без видео (например, главная страница)', () => {
  assert.deepEqual(parseRequestLink('https://www.youtube.com/'), { type: 'invalid' });
});

test('невалидно: spotify-ссылка на плейлист, а не трек', () => {
  assert.deepEqual(parseRequestLink('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'), {
    type: 'invalid',
  });
});

test('невалидно: пустая строка', () => {
  assert.deepEqual(parseRequestLink(''), { type: 'invalid' });
});

test('отсекает невидимый юникод-"хвост" после id (watch?v=) — такие символы прилетают при копировании ссылки из некоторых источников', () => {
  // U+034F COMBINING GRAPHEME JOINER — невидим, но не является "пробелом" с
  // точки зрения regex \s, поэтому trim()/split(/\s/) его не убирают.
  const result = parseRequestLink('https://www.youtube.com/watch?v=D8VEhcPeSlc͏');
  assert.deepEqual(result, { type: 'youtube', videoId: 'D8VEhcPeSlc' });
});

test('отсекает невидимый юникод-"хвост" вместе с настоящим пробелом (как реально прислали в чате)', () => {
  const result = parseRequestLink('https://www.youtube.com/watch?v=D8VEhcPeSlc ͏');
  assert.deepEqual(result, { type: 'youtube', videoId: 'D8VEhcPeSlc' });
});

test('отсекает невидимый юникод-"хвост" после id в youtu.be', () => {
  const result = parseRequestLink('https://youtu.be/dQw4w9WgXcQ​');
  assert.deepEqual(result, { type: 'youtube', videoId: 'dQw4w9WgXcQ' });
});

test('распознаёт ссылку music.yandex.ru/album/<id>/track/<id>', () => {
  const result = parseRequestLink('https://music.yandex.ru/album/5307396/track/38633712?utm_source=desktop');
  assert.deepEqual(result, { type: 'yandex', trackId: '38633712' });
});

test('распознаёт короткую ссылку Яндекс Музыки /track/<id> на региональном домене', () => {
  const result = parseRequestLink('https://music.yandex.com/track/38633712');
  assert.deepEqual(result, { type: 'yandex', trackId: '38633712' });
});

test('ссылка на альбом Яндекс Музыки без трека — невалидная', () => {
  assert.deepEqual(parseRequestLink('https://music.yandex.ru/album/5307396'), { type: 'invalid' });
});

test('отсекает невидимый юникод-"хвост" после id в shorts', () => {
  const result = parseRequestLink('https://www.youtube.com/shorts/abc123XYZ_-͏');
  assert.deepEqual(result, { type: 'youtube', videoId: 'abc123XYZ_-' });
});
