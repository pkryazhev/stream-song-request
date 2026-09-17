import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, hasAnnounced, markAnnounced } from '../src/db/index.ts';

test('дедуп анонсов: повторная проверка того же stream_id не считается новым анонсом', () => {
  initDb(':memory:');
  assert.equal(hasAnnounced('stream-1'), false);

  markAnnounced('stream-1');
  assert.equal(hasAnnounced('stream-1'), true);

  // повторная запись того же id не должна падать (INSERT OR IGNORE)
  markAnnounced('stream-1');
  assert.equal(hasAnnounced('stream-1'), true);

  // другой id — независим
  assert.equal(hasAnnounced('stream-2'), false);
});
