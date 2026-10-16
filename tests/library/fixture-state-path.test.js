import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fixturePathStyle, projectStatePath, expandStatePath } from './fixture-state-path.js';

test('recorded state paths relocate separators without rewriting unrelated identities or text', () => {
  const root = path.resolve('isolated-state');
  assert.equal(fixturePathStyle, process.platform === 'win32' ? 'windows' : 'posix');
  assert.equal(expandStatePath('$STATE\\media\\Film.mkv', '$STATE', root), root + path.sep + 'media' + path.sep + 'Film.mkv');
  assert.equal(projectStatePath(root + path.sep + 'media' + path.sep + 'Film.mkv', root), '$STATE\\media\\Film.mkv');
  assert.equal(projectStatePath(root, root), '$STATE');
  assert.equal(expandStatePath('$STATE', '$STATE', root), root);
  for (const value of [null, '', 'https://example.invalid/a/b', 'Z:\\External\\Film.mkv', 'A title / with \\ separators', root + '-other/file']) {
    assert.equal(projectStatePath(value, root), value);
    assert.equal(expandStatePath(value, '$STATE', root), value);
  }
  assert.equal(expandStatePath('$STATE-other\\file', '$STATE', root), '$STATE-other\\file');
  assert.equal(expandStatePath('$STATE\\media\\..\\Film.mkv', '$STATE', root), root + path.sep + 'media' + path.sep + '..' + path.sep + 'Film.mkv');
});
