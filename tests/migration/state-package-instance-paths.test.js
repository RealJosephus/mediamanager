import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tableDefinition } from '../../src/database/model.js';
import { NativeTextCell, nativeTextBytes } from '../../src/database/native-text.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { createVirtualPathExpander } from '../../src/library/options.js';
import { databaseDigest } from '../../src/migration/database-transfer.js';
import { createSqliteExportPathProjector } from '../../src/migration/sqlite-export-paths.js';
import { createStatePackage, restoreStatePackage, verifyStatePackage } from '../../src/migration/state-package.js';
import { fixtureIds, fixtureRow, seedAllTables } from '../database/fixtures.js';
import { orderedExchangeSnapshot } from '../helpers/ordered-exchange-snapshot.js';
import { createInstanceFixture } from './instance-fixture.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const ids = { library: fixtureIds.BaseItems,
  data: '30000000-0000-0000-0000-000000000002', metadata: '30000000-0000-0000-0000-000000000003',
  unknown: '30000000-0000-0000-0000-000000000004', invalid: '30000000-0000-0000-0000-000000000005' };

for (const externalMetadata of [false, true]) test(`state package restores native instance path roles and every original cell/order (${externalMetadata ? 'external' : 'default'} metadata)`, async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'state-package-instance-paths-' });
  const programData = path.join(fixture.root, 'data');
  const metadata = externalMetadata ? path.join(fixture.directory, 'external-metadata') : path.join(programData, 'metadata');
  if (externalMetadata) {
    await mkdir(metadata);
    const escaped = metadata.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    await writeFile(path.join(fixture.root, 'config/system.xml'), `<ServerConfiguration><MetadataPath>${escaped}</MetadataPath></ServerConfiguration>`);
  }
  seedAllTables(fixture.database);
  const ownerPath = path.join(programData, 'root', 'default', 'Movies');
  await mkdir(ownerPath, { recursive: true });
  await writeFile(path.join(ownerPath, 'movies.collection'), '');
  const data = '{ "PhysicalLocationsList" : [' + JSON.stringify(ownerPath)
    + ',"Z:\\\\Media\\\\Movies"], "Unknown" : { "Path" : ' + JSON.stringify(ownerPath) + ', "Int64":9223372036854775807 } }';
  fixture.database.update('BaseItems', { Id: ids.library }, { Type: 'MediaBrowser.Controller.Entities.CollectionFolder',
    Path: ownerPath, IsFolder: true, Data: data });
  const insert = (Id, Type, Path, Data) => fixture.database.insert('BaseItems', {
    ...fixtureRow(tableDefinition('BaseItems')), Id, Type, Path, Data, ParentId: null, OwnerId: null,
  });
  insert(ids.data, 'MediaBrowser.Controller.Playlists.PlaylistsFolder', path.join(programData, 'data', 'playlists'), null);
  insert(ids.metadata, 'MediaBrowser.Controller.Entities.UserView', path.join(metadata, 'views', 'movies'), null);
  insert(ids.unknown, 'Unknown.Provider.Folder', ownerPath, '{"UnknownPath":' + JSON.stringify(ownerPath) + ',"Int64":9223372036854775807}');
  const invalidData = Buffer.from([0xff, 0x80, 0, 0x7b, 0x22]);
  insert(ids.invalid, 'MediaBrowser.Controller.Entities.UserView', path.join(metadata, 'views', 'invalid'), null);
  // insert() returns a runtime row, which deliberately cannot decode invalid
  // UTF8. Seed the authoritative native TEXT bytes without requesting that view.
  assert.equal(fixture.database.update('BaseItems', { Id: ids.invalid }, { Data: new NativeTextCell(invalidData) }), 1n);
  const sourceTables = await databaseDigest(fixture.database);
  const packageRoot = path.join(fixture.directory, 'package');
  const manifest = await createStatePackage(await fixture.packageOptions({ destination: packageRoot }));
  const packageFilename = path.join(packageRoot, manifest.database.path);
  const packageSha256 = hash(await readFile(packageFilename));
  const manifestBytes = await readFile(path.join(packageRoot, 'manifest.json'));
  const sourceInstanceStatePaths = { programData, metadata };

  const packaged = new SqliteDatabase(packageFilename, { readOnly: true });
  try {
    const rows = Object.fromEntries((await packaged.rows('BaseItems', { consumer: 'exchange' })).map(row => [row.Id.string(), row]));
    assert.equal(rows[ids.library].Path.string(), ownerPath);
    assert.equal(rows[ids.library].Data.string(), data);
    assert.equal(rows[ids.data].Path.string(), '%AppDataPath%' + path.sep + 'playlists');
    assert.equal(rows[ids.metadata].Path.string(), '%MetadataPath%' + path.sep + 'views' + path.sep + 'movies');
    assert.deepEqual(nativeTextBytes(rows[ids.invalid].Data), invalidData);

    for (const name of ['restored-a', 'restored-b']) {
      const destination = path.join(fixture.directory, name);
      if (name === 'restored-a') {
        const controller = new AbortController();
        await assert.rejects(restoreStatePackage(packageRoot, destination, {
          signal: controller.signal, onProgress: ({ completed }) => { if (completed === 1) controller.abort(); },
        }), /abort/iu);
      }
      const restored = await restoreStatePackage(packageRoot, destination);
      const targetInstanceStatePaths = { programData: path.join(destination, 'data'),
        metadata: externalMetadata ? path.join(destination, 'metadata-external') : path.join(destination, 'data', 'metadata') };
      assert.equal(restored.alreadyRestored, false);
      assert.equal(restored.resumed, name === 'restored-a');
      assert.deepEqual(restored.databaseProjection.sourceInstanceStatePaths, sourceInstanceStatePaths);
      assert.deepEqual(restored.databaseProjection.targetInstanceStatePaths, targetInstanceStatePaths);
      assert.equal(restored.databaseProjection.sourceSha256, manifest.database.sha256);
      assert.notEqual(restored.databaseProjection.targetSha256, manifest.database.sha256);
      const options = { instanceStatePaths: sourceInstanceStatePaths, targetInstanceStatePaths: targetInstanceStatePaths };
      const tableProjector = createSqliteExportPathProjector(options), orderProjector = createSqliteExportPathProjector(options);
      const expected = await orderedExchangeSnapshot(packaged, {
        rowTransform: tableProjector.projectRow, insertionRowTransform: orderProjector.projectRow });
      const filename = path.join(destination, ...manifest.database.restorePath.split('/'));
      const database = new SqliteDatabase(filename, { readOnly: true });
      try {
        const snapshot = await orderedExchangeSnapshot(database);
        assert.equal(snapshot.tables.length, 31);
        assert.equal(Object.keys(snapshot.insertionOrder).length, 6);
        assert.deepEqual(snapshot, expected);
        assert.deepEqual(snapshot.tables, restored.databaseProjection.tables);
        const actual = Object.fromEntries((await database.rows('BaseItems', { consumer: 'exchange' })).map(row => [row.Id.string(), row]));
        const restoredOwner = path.join(destination, 'data', 'root', 'default', 'Movies');
        assert.equal(actual[ids.library].Path.string(), restoredOwner);
        assert.equal(actual[ids.library].Data.string(), data.replace(JSON.stringify(ownerPath), JSON.stringify(restoredOwner)));
        const expand = createVirtualPathExpander({ programDataPath: targetInstanceStatePaths.programData, metadataPath: targetInstanceStatePaths.metadata });
        assert.equal(expand(actual[ids.data].Path.string()), path.join(destination, 'data', 'data', 'playlists'));
        assert.equal(expand(actual[ids.metadata].Path.string()), path.join(targetInstanceStatePaths.metadata, 'views', 'movies'));
        assert.deepEqual(nativeTextBytes(actual[ids.unknown].Data), nativeTextBytes(rows[ids.unknown].Data));
        assert.equal(actual[ids.unknown].Path.string(), ownerPath);
        assert.deepEqual(nativeTextBytes(actual[ids.invalid].Data), invalidData);
      } finally { database.close(); }
      const marker = JSON.parse(await readFile(path.join(destination, 'mediamanager-state.json'), 'utf8'));
      assert.equal(marker.database.sha256, hash(await readFile(filename)));
      assert.equal(marker.database.sha256, restored.databaseProjection.targetSha256);
      const again = await restoreStatePackage(packageRoot, destination);
      assert.equal(again.alreadyRestored, true);
      assert.deepEqual(again.databaseProjection, restored.databaseProjection);
    }
  } finally { packaged.close(); }
  assert.deepEqual(await databaseDigest(fixture.database), sourceTables);
  assert.equal(hash(await readFile(packageFilename)), packageSha256);
  assert.deepEqual(await readFile(path.join(packageRoot, 'manifest.json')), manifestBytes);
  assert.deepEqual(await verifyStatePackage(packageRoot), manifest);
});
