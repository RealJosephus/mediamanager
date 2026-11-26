import assert from 'node:assert/strict';
import path from 'node:path';
import { stat, appendFile, readFile, writeFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { exchange } from '../../src/migration/emby/exchange.js';
import { stateDirectory, verifyState } from '../../src/migration/emby/files.js';
import { toBlob } from '../../src/migration/emby/format.js';
import { exchangeFixture, exchangeId, stoppedEmby, withCatalog } from './emby-exchange-fixture.js';

test('a version-one monolithic Emby import can be returned and exchanged again', async t => {
  const fixture = await exchangeFixture(t);
  fixture.emby.prepare('INSERT INTO MediaItems(Id,guid,type,Name,Overview) VALUES(1,?,5,?,?)')
    .run(toBlob(exchangeId(1)), 'Stored movie', 'Original');
  const source = await stoppedEmby(fixture), manager = path.join(fixture.directory, 'manager-v1');
  await exchange({ direction: 'import', source, output: manager });
  const state = path.join(manager, stateDirectory), manifestPath = path.join(state, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const { base } = await verifyState(manager, 'jellyfin');
  const bytes = Buffer.from(JSON.stringify(base) + '\n');
  await writeFile(path.join(state, 'base.json'), bytes);
  manifest.version = 1;
  manifest.baseHash = createHash('sha256').update(bytes).digest('hex');
  await writeFile(manifestPath, JSON.stringify(manifest) + '\n');
  await unlink(path.join(state, 'source-0.json'));
  await unlink(path.join(state, 'target-0.json'));

  withCatalog(manager, 'jellyfin', db => db.prepare('UPDATE BaseItems SET Overview=? WHERE Id=?').run('Edited', exchangeId(1)));
  const returned = await exchange({ direction: 'export', source: manager, output: path.join(fixture.directory, 'returned') });
  withCatalog(returned.output, 'emby', db => assert.equal(db.prepare('SELECT Overview FROM MediaItems WHERE Id=1').get().Overview, 'Edited'));
  assert.equal(JSON.parse(await readFile(path.join(returned.output, stateDirectory, 'manifest.json'), 'utf8')).version, 2);
  const reimport = await exchange({ direction: 'import', source: returned.output, output: path.join(fixture.directory, 'again') });
  withCatalog(reimport.output, 'jellyfin', db => assert.equal(db.prepare('SELECT Overview FROM BaseItems WHERE Id=?').get(exchangeId(1)).Overview, 'Edited'));
});

test('Emby exchanges 100000 long overviews, resumes publication and reads the sealed baseline on return', { timeout: 1_200_000 }, async t => {
  const fixture = await exchangeFixture(t);
  const count = 100000, overview = 'x'.repeat(3000);
  const insert = fixture.emby.prepare('INSERT INTO MediaItems(Id,guid,type,Name,Overview) VALUES(?,?,5,?,?)');
  fixture.emby.exec('BEGIN');
  for (let i = 1; i <= count; i++) insert.run(i, toBlob(exchangeId(i)), 'Movie ' + i, overview + i);
  fixture.emby.exec('COMMIT');
  const source = await stoppedEmby(fixture);
  const output = path.join(fixture.directory, 'manager'), args = { direction: 'import', source, output };
  await assert.rejects(exchange({ ...args, afterDatabaseCommit() { throw new Error('Interrupted before publication'); } }), /Interrupted before publication/);
  await assert.rejects(stat(output), { code: 'ENOENT' });
  const imported = await exchange(args);
  assert.equal(imported.sourceRecords, count);
  assert.equal(imported.targetRecords, count);
  withCatalog(output, 'jellyfin', db => {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM BaseItems WHERE length(Overview)>=3001').get().n, count);
    assert.equal(db.prepare('UPDATE BaseItems SET Overview=? WHERE Id=?').run('Return edit', exchangeId(count)).changes, 1);
  });
  const returned = await exchange({ direction: 'export', source: output, output: path.join(fixture.directory, 'returned') });
  assert.equal(returned.changes, 1);
  withCatalog(returned.output, 'emby', db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM MediaItems').get().n, count);
    assert.equal(db.prepare('SELECT Overview FROM MediaItems WHERE Id=?').get(count).Overview, 'Return edit');
    assert.equal(db.prepare('SELECT Overview FROM MediaItems WHERE Id=1').get().Overview, overview + 1);
  });
  await appendFile(path.join(output, stateDirectory, 'source-0.json'), ' ');
  await assert.rejects(verifyState(output, 'jellyfin'), /Migration field baseline has changed/);
});
