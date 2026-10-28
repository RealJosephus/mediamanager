import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, link, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createStatePackage, restoreStatePackage } from '../../src/migration/state-package.js';
import { fixtureIds, seedAllTables } from '../database/fixtures.js';
import { createInstanceFixture } from './instance-fixture.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const value = await createInstanceFixture(t, { prefix: 'state-package-preparation-' });
  seedAllTables(value.database);
  value.database.update('BaseItems', { Id: fixtureIds.BaseItems }, { Type: 'MediaBrowser.Controller.Entities.AggregateFolder',
    Path: path.join(value.root, 'data', 'root') });
  const packageDirectory = path.join(value.directory, 'package'), destination = path.join(value.directory, 'restored');
  const manifest = await createStatePackage(await value.packageOptions({ destination: packageDirectory }));
  return { ...value, packageDirectory, destination, manifest };
}
const privateFiles = async directory => Object.fromEntries(await Promise.all((await readdir(directory))
  .map(async filename => [filename, (await readFile(path.join(directory, filename))).toString('base64')])));

test('restore preparation closes its actual SQLite owner and removes its bound copy before every public file callback', async t => {
  const value = await fixture(t), plannedFailure = new Error('Stop at the open private database boundary');
  let preparation;
  await assert.rejects(restoreStatePackage(value.packageDirectory, value.destination, {
    onPreparation: async event => {
      preparation = event;
      if (event.stage !== 'database-opened') return;
      const directory = path.join(event.staging, event.relativeDirectory);
      assert.equal(hash(await readFile(path.join(directory, 'jellyfin.db'))), value.manifest.database.sha256);
      const binding = JSON.parse(await readFile(path.join(directory, 'binding.json'), 'utf8'));
      assert.equal(binding.manifestSha256, hash(await readFile(path.join(value.packageDirectory, 'manifest.json'))));
      assert.equal(binding.destination, value.destination); assert.equal(binding.sourceSha256, value.manifest.database.sha256);
      throw plannedFailure;
    },
  }), error => error === plannedFailure);
  await assert.rejects(access(preparation.staging), { code: 'ENOENT' });
  let callbacks = 0;
  const restored = await restoreStatePackage(value.packageDirectory, value.destination, {
    onPreparation: event => { preparation = event; },
    onProgress: async event => {
      callbacks++;
      if (callbacks === 1) assert.equal(event.path, value.manifest.database.restorePath);
      await assert.rejects(access(path.join(preparation.staging, preparation.relativeDirectory)), { code: 'ENOENT' });
    },
  });
  assert.equal(callbacks, value.manifest.instanceFiles.length + 1);
  assert.equal(restored.resumed, false);
  assert.equal(hash(await readFile(path.join(value.packageDirectory, 'jellyfin.db'))), value.manifest.database.sha256);
});

for (const kind of ['foreign file', 'wrong binding', 'unbound database', 'hard-linked database']) {
  test(`restore preparation preserves and rejects ${kind} before deleting any member`, async t => {
    const value = await fixture(t);
    let directory, before;
    await assert.rejects(restoreStatePackage(value.packageDirectory, value.destination, {
      onPreparation: async event => {
        if (event.stage !== 'database-opened') return;
        directory = path.join(event.staging, event.relativeDirectory);
        if (kind === 'foreign file') await writeFile(path.join(directory, 'foreign.bin'), Buffer.from([0xff, 0, 0x7b]));
        if (kind === 'wrong binding') {
          const filename = path.join(directory, 'binding.json'), binding = JSON.parse(await readFile(filename, 'utf8'));
          binding.destination = path.join(value.directory, 'other-owner');
          await writeFile(filename, JSON.stringify(binding));
        }
        if (kind === 'unbound database') await unlink(path.join(directory, 'binding.json'));
        if (kind === 'hard-linked database') await link(path.join(directory, 'jellyfin.db'), path.join(value.directory, 'outside-preparation.db'));
        before = await privateFiles(directory);
      },
    }), /preparation and cleanup failed/u);
    assert.deepEqual(await privateFiles(directory), before);
    await assert.rejects(restoreStatePackage(value.packageDirectory, value.destination),
      /Unbound|unexpected file|binding differs|not a private regular file/u);
    assert.deepEqual(await privateFiles(directory), before);
    await assert.rejects(access(value.destination), { code: 'ENOENT' });
    assert.equal(hash(await readFile(path.join(value.packageDirectory, 'jellyfin.db'))), value.manifest.database.sha256);
  });
}
