import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { exchange } from '../../src/migration/emby/exchange.js';
import { toBlob } from '../../src/migration/emby/format.js';
import { exchangeFixture, exchangeId, stoppedEmby } from './emby-exchange-fixture.js';

test('a new metadata directory keeps its access mode and mtime on first Emby import', async t => {
  const f = await exchangeFixture(t);
  f.emby.prepare("INSERT INTO MediaItems(Id,guid,type,Name) VALUES(1,?,5,'Movie')").run(toBlob(exchangeId(1)));
  const source = await stoppedEmby(f);
  const directory = path.join(source, 'metadata', 'custom-posters');
  const stamp = new Date('2022-03-04T00:00:00Z');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'poster.txt'), 'cover');
  await chmod(directory, 0o750);
  await utimes(directory, stamp, stamp);
  const result = await exchange({ direction: 'import', source, output: path.join(f.directory, 'manager') });
  const target = path.join(result.output, 'data', 'metadata', 'custom-posters');
  assert.equal(await readFile(path.join(target, 'poster.txt'), 'utf8'), 'cover');
  const before = await stat(directory), after = await stat(target);
  assert.deepEqual({ mode: (after.mode & 0o777).toString(8), mtime: after.mtime.toISOString() },
    { mode: (before.mode & 0o777).toString(8), mtime: stamp.toISOString() });
});
