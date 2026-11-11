import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tableDefinition } from '../../src/database/model.js';
import { NativeTextCell, nativeTextCell, nativeTextBytes } from '../../src/database/native-text.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { inspectInstanceConfiguration } from '../../src/configuration.js';
import { createVirtualPathExpander } from '../../src/library/options.js';
import { discoverInstanceState } from '../../src/migration/instance-state.js';
import { createStatePackage, restoreStatePackage, verifyStatePackage } from '../../src/migration/state-package.js';
import { fixtureRow, seedAllTables } from '../database/fixtures.js';
import { orderedExchangeSnapshot } from '../helpers/ordered-exchange-snapshot.js';
import { createInstanceFixture } from './instance-fixture.js';

const ids = { owner: '30000000-0000-0000-0000-000000000001',
  data: '30000000-0000-0000-0000-000000000002', metadata: '30000000-0000-0000-0000-000000000003' };
const opaque = Buffer.from([0xff, 0x80, 0, 0x7b]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { $integer: item.toString() } : item, 2) + '\n';
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const ownerData = (owner, original) => '{ "PhysicalLocationsList" : [' + JSON.stringify(owner)
  + '], "Unknown" : {"Path":' + JSON.stringify(original) + ',"Int64":9223372036854775807} }';

// Only the three fixture-owned path cells are compared by role. The consumer
// independently checks their exact target values before hashing every table
// and insertion sequence. Unknown JSON and invalid TEXT bytes stay untouched.
function fixturePathRoles(table, row) {
  if (table !== 'BaseItems') return row;
  const id = row.Id.string();
  const role = Object.keys(ids).find(key => ids[key] === id);
  if (!role) return row;
  const result = { ...row, Path: nativeTextCell(`<${role}>`) };
  if (role === 'owner') {
    const prefix = '{ "PhysicalLocationsList" : [' + JSON.stringify(row.Path.string()) + ']';
    assert.ok(row.Data.string().startsWith(prefix));
    result.Data = nativeTextCell('{ "PhysicalLocationsList" : ["<owner>"]' + row.Data.string().slice(prefix.length));
  }
  return result;
}

export async function capturePlatformPackage(t, output) {
  await mkdir(output, { recursive: true });
  const fixture = await createInstanceFixture(t, { prefix: 'state-package-platform-' });
  seedAllTables(fixture.database);
  const programData = path.join(fixture.root, 'data');
  const metadata = path.join(fixture.directory, 'source metadata $1 & state');
  const cache = path.join(fixture.directory, 'source cache $& & state');
  const owner = path.join(programData, 'root', 'default', 'Movies');
  for (const directory of [owner, path.join(programData, 'data', 'playlists'), path.join(metadata, 'views', 'one'), cache]) {
    await mkdir(directory, { recursive: true });
  }
  await writeFile(path.join(programData, 'data', 'playlists', 'one.xml'), 'playlist asset');
  await writeFile(path.join(metadata, 'views', 'one', 'asset.txt'), 'metadata asset');
  await writeFile(path.join(cache, 'asset.txt'), 'cache asset');
  await writeFile(path.join(fixture.root, 'config', 'system.xml'),
    `<ServerConfiguration><MetadataPath>${xml(metadata + path.sep)}</MetadataPath><CachePath>${xml(cache + path.sep)}</CachePath></ServerConfiguration>`);
  const insert = (Id, Type, Path, Data) => fixture.database.insert('BaseItems', {
    ...fixtureRow(tableDefinition('BaseItems')), Id, Type, Path, Data, ParentId: null, OwnerId: null,
  });
  insert(ids.owner, 'MediaBrowser.Controller.Entities.CollectionFolder', owner, ownerData(owner, owner));
  insert(ids.data, 'MediaBrowser.Controller.Playlists.PlaylistsFolder', path.join(programData, 'data', 'playlists'), null);
  insert(ids.metadata, 'MediaBrowser.Controller.Entities.UserView', path.join(metadata, 'views', 'one'), null);
  fixture.database.update('BaseItems', { Id: ids.metadata }, { Data: new NativeTextCell(opaque) });
  const directory = path.join(output, 'package');
  const manifest = await createStatePackage(await fixture.packageOptions({ destination: directory }));
  const database = new SqliteDatabase(path.join(directory, manifest.database.path), { readOnly: true });
  let snapshot;
  try { snapshot = await orderedExchangeSnapshot(database, { rowTransform: fixturePathRoles }); }
  finally { database.close(); }
  assert.equal(snapshot.tables.length, 31);
  assert.equal(Object.keys(snapshot.insertionOrder).length, 6);
  const control = { platform: process.platform, node: process.version, head: process.env.GITHUB_SHA ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    sourceOwner: owner, snapshot, manifestSha256: hash(await readFile(path.join(directory, 'manifest.json'))) };
  await writeFile(path.join(output, 'control.json'), json(control), { flag: 'wx' });
  return control;
}

export async function restorePlatformPackages(input, output, expectedPlatforms = ['darwin', 'linux', 'win32']) {
  await mkdir(output, { recursive: true });
  const entries = await readdir(input, { withFileTypes: true });
  assert.equal(entries.length, expectedPlatforms.length);
  const seen = new Set(), results = [];
  for (const entry of entries) {
    assert.ok(entry.isDirectory());
    const root = path.join(input, entry.name), directory = path.join(root, 'package');
    const control = JSON.parse(await readFile(path.join(root, 'control.json'), 'utf8'));
    assert.ok(expectedPlatforms.includes(control.platform) && !seen.has(control.platform));
    seen.add(control.platform);
    assert.equal(control.head, process.env.GITHUB_SHA ?? null);
    assert.equal(control.runId, process.env.GITHUB_RUN_ID ?? null);
    const original = await readFile(path.join(directory, 'manifest.json'));
    assert.equal(hash(original), control.manifestSha256);
    const manifest = await verifyStatePackage(directory);
    const destination = path.join(output, control.platform + ' $1 $& $$ & restored');
    const restored = await restoreStatePackage(directory, destination);
    assert.equal(restored.alreadyRestored, false);
    const discovered = await discoverInstanceState({ instanceRoot: destination });
    assert.equal(discovered.identity.serverId, manifest.instanceState.identity.serverId);
    const settings = await inspectInstanceConfiguration(destination);
    assert.equal(settings.configuration.MetadataPath, path.join(destination, 'metadata-external'));
    assert.equal(settings.configuration.CachePath, path.join(destination, 'cache-external'));
    const database = new SqliteDatabase(path.join(destination, ...manifest.database.restorePath.split('/')), { readOnly: true });
    let snapshot;
    try {
      const rows = Object.fromEntries(database.rows('BaseItems', { consumer: 'exchange' }).map(row => [row.Id.string(), row]));
      const owner = path.join(destination, 'data', 'root', 'default', 'Movies');
      assert.equal(rows[ids.owner].Path.string(), owner);
      assert.equal(rows[ids.owner].Data.string(), ownerData(owner, control.sourceOwner));
      assert.equal(rows[ids.data].Path.string(), '%AppDataPath%' + path.sep + 'playlists');
      assert.equal(rows[ids.metadata].Path.string(), '%MetadataPath%' + path.sep + 'views' + path.sep + 'one');
      assert.deepEqual(nativeTextBytes(rows[ids.metadata].Data), opaque);
      const expand = createVirtualPathExpander({ programDataPath: path.join(destination, 'data'), metadataPath: settings.configuration.MetadataPath });
      assert.equal(await readFile(path.join(expand(rows[ids.data].Path.string()), 'one.xml'), 'utf8'), 'playlist asset');
      assert.equal(await readFile(path.join(expand(rows[ids.metadata].Path.string()), 'asset.txt'), 'utf8'), 'metadata asset');
      assert.ok((await stat(owner)).isDirectory());
      snapshot = await orderedExchangeSnapshot(database, { rowTransform: fixturePathRoles });
    } finally { database.close(); }
    assert.deepEqual(JSON.parse(json(snapshot)), control.snapshot);
    assert.equal(await readFile(path.join(settings.configuration.CachePath, 'asset.txt'), 'utf8'), 'cache asset');
    assert.equal((await restoreStatePackage(directory, destination)).alreadyRestored, true);
    assert.deepEqual(await verifyStatePackage(directory), manifest);
    assert.deepEqual(await readFile(path.join(directory, 'manifest.json')), original);
    results.push({ source: control.platform, target: process.platform, producer: control,
      destination, restoredIdentity: discovered.identity, databaseProjection: restored.databaseProjection });
  }
  await writeFile(path.join(output, 'receipt.json'), json({ head: process.env.GITHUB_SHA ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null, platform: process.platform,
    scope: 'Actual state packages exchanged across runners; 31 tables, six relation orders, instance paths, assets and repeat restore. Synthetic database fixture; no Native continuation, full-suite or release claim.', results }), { flag: 'wx' });
}
