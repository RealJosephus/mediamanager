import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { quoteIdentifier as q, tableDefinition } from '../../src/database/model.js';
import { databaseDigest, transferDatabase } from '../../src/migration/database-transfer.js';
import { createStatePackage, verifyStatePackage } from '../../src/migration/state-package.js';
import { fixtureIds, fixtureRow } from '../database/fixtures.js';
import { createInstanceFixture } from './instance-fixture.js';

const sourceContract = {
  mounts: [{ mountId: 'media-main', identityRoot: 'Z:\\Media', accessRoot: '/media', pathStyle: 'windows',
    caseSensitive: false, returnPolicy: 'required' }]
};
const targetContract = {
  mounts: [{ mountId: 'media-main', identityRoot: '/srv/jellyfin/media', accessRoot: '/media', pathStyle: 'posix',
    caseSensitive: true, returnPolicy: 'required' }]
};

test('state package target retargeting requires a persisted PostgreSQL source contract', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'state-package-retarget-sqlite-' });
  const destination = path.join(fixture.directory, 'invalid-retarget-package');
  await assert.rejects(createStatePackage(await fixture.packageOptions({
    destination,
    targetPortableMountContract: targetContract,
  })), /requires a PostgreSQL package database/u);
});

test('PostgreSQL state package retargets its SQLite paths, contract and media-access declaration together', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
  timeout: 30000,
}, async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'state-package-retarget-' });
  const sourcePath = 'Z:\\Media\\Films\\One.mkv';
  const internalId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const internalPath = path.join(fixture.root, 'data', 'root');
  fixture.database.insert('BaseItems', {
    ...fixtureRow(tableDefinition('BaseItems')),
    Id: fixtureIds.BaseItems,
    Path: sourcePath,
    Type: 'MediaBrowser.Controller.Entities.Movies.Movie',
    MediaType: 'Video',
    IsFolder: false,
    IsVirtualItem: false,
    IsInMixedFolder: false,
    Data: '{"VideoType":"VideoFile","IsShortcut":false}',
  });
  fixture.database.insert('BaseItems', {
    ...fixtureRow(tableDefinition('BaseItems')),
    Id: internalId,
    ParentId: null,
    TopParentId: null,
    Path: internalPath,
    Type: 'MediaBrowser.Controller.Entities.AggregateFolder',
    Name: 'Internal Root',
    MediaType: null,
    IsFolder: true,
    IsVirtualItem: false,
    IsInMixedFolder: false,
    Data: '{"IsRoot":true}',
  });
  const hash = 'a'.repeat(64);
  const mediaAccess = {
    scope: 'explicit-items',
    items: [{
      itemId: fixtureIds.BaseItems,
      identityPath: sourcePath,
      identityRoot: 'Z:\\Media',
      enumeration: { kind: 'native-filesystem', root: 'Z:\\Media' },
      read: { kind: 'native-local-media-proxy' },
      expected: { bytes: '1', sha256: hash, range: { start: '0', end: '0', sha256: hash } },
      sidecars: [],
    }],
  };
  const destination = path.join(fixture.directory, 'retargeted-package');
  const options = await fixture.packageOptions({ destination, mediaAccess });
  const schema = `pkg_retarget_${Date.now().toString(36)}_${Math.floor(Math.random() * 100000).toString(36)}`;
  let postgres = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
    schema,
    create: true,
  });
  t.after(async () => {
    await postgres?.close();
    const cleanup = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema });
    try { await cleanup.client.query(`DROP SCHEMA ${q(schema)}, ${q(`${schema}__mm`)} CASCADE`); }
    finally { await cleanup.close(); }
    await rm(destination, { recursive: true, force: true });
  });
  await transferDatabase(fixture.database, postgres, {
    instanceBinding: {
      serverId: options.instanceState.identity.serverId,
      originIdentityDigest: options.instanceState.identity.digest,
    },
    portableMountContract: sourceContract,
  });
  const activity = fixtureRow(tableDefinition('ActivityLogs'));
  delete activity.Id;
  const currentActivity = await postgres.insert('ActivityLogs', {
    ...activity,
    Name: 'Current PostgreSQL state before packaging',
  });
  assert.equal(currentActivity.Id, 1);

  const receiptText = await postgres.getState('transferReceipt');
  await postgres.client.query(`DELETE FROM ${q(postgres.controlSchema)}.state WHERE key = 'transferReceipt'`);
  await assert.rejects(createStatePackage({ ...options, database: postgres,
    destination: path.join(fixture.directory, 'missing-receipt-package'),
    targetPortableMountContract: targetContract }), /no completed database transfer receipt/iu);
  await postgres.client.query(`INSERT INTO ${q(postgres.controlSchema)}.state (key, value) VALUES ('transferReceipt', $1)`,
    [receiptText]);

  const tamperedReceipt = { ...JSON.parse(receiptText), targetIdentitySha256: 'f'.repeat(64) };
  await postgres.client.query(`UPDATE ${q(postgres.controlSchema)}.state SET value = $1 WHERE key = 'transferReceipt'`,
    [JSON.stringify(tamperedReceipt)]);
  await assert.rejects(createStatePackage({ ...options, database: postgres,
    destination: path.join(fixture.directory, 'tampered-receipt-package'),
    targetPortableMountContract: targetContract }), /does not match this database target/iu);
  await postgres.client.query(`UPDATE ${q(postgres.controlSchema)}.state SET value = $1 WHERE key = 'transferReceipt'`,
    [receiptText]);

  const manifest = await createStatePackage({ ...options, database: postgres,
    targetPortableMountContract: targetContract });
  assert.deepEqual(manifest.database.portableMountContract, targetContract);
  assert.deepEqual(manifest.database.portableMountContract.mounts.map(({ mountId }) => mountId), ['media-main']);
  assert.ok(manifest.database.pathProjection.rewrittenPaths >= 1);
  assert.equal(manifest.mediaAccess.items[0].identityRoot, '/srv/jellyfin/media');
  assert.equal(manifest.mediaAccess.items[0].identityPath, '/srv/jellyfin/media/Films/One.mkv');
  assert.equal(manifest.mediaAccess.items[0].enumeration.root, '/srv/jellyfin/media');

  const exported = new SqliteDatabase(path.join(destination, 'jellyfin.db'), { readOnly: true });
  try {
    assert.equal((await exported.rows('BaseItems', { where: { Id: fixtureIds.BaseItems } }))[0].Path,
      '/srv/jellyfin/media/Films/One.mkv');
    assert.equal((await exported.rows('BaseItems', { where: { Id: internalId } }))[0].Path,
      `%AppDataPath%${path.sep}root`);
  } finally { exported.close(); }

  const altered = structuredClone(manifest);
  altered.database.portableMountContract.mounts[0].accessRoot = '/other';
  const manifestText = `${JSON.stringify(altered, null, 2)}\n`;
  await writeFile(path.join(destination, 'manifest.json'), manifestText);
  const commitFilename = path.join(destination, 'COMMITTED');
  const commit = JSON.parse(await readFile(commitFilename, 'utf8'));
  commit.manifestSha256 = createHash('sha256').update(manifestText).digest('hex');
  await writeFile(commitFilename, `${JSON.stringify(commit, null, 2)}\n`);
  await assert.rejects(verifyStatePackage(destination), /target portable VFS mount contract is incompatible/u);

  const tamperedDatabase = new SqliteDatabase(path.join(destination, 'jellyfin.db'));
  let tamperedTables;
  try {
    tamperedDatabase.update('BaseItems', { Id: fixtureIds.BaseItems }, { Name: 'silently changed after projection' });
    tamperedTables = await databaseDigest(tamperedDatabase);
  } finally { tamperedDatabase.close(); }
  const contentTampered = structuredClone(manifest);
  contentTampered.database.tables = tamperedTables;
  contentTampered.database.sha256 = createHash('sha256')
    .update(await readFile(path.join(destination, 'jellyfin.db'))).digest('hex');
  const contentManifestText = `${JSON.stringify(contentTampered, null, 2)}\n`;
  await writeFile(path.join(destination, 'manifest.json'), contentManifestText);
  commit.manifestSha256 = createHash('sha256').update(contentManifestText).digest('hex');
  await writeFile(commitFilename, `${JSON.stringify(commit, null, 2)}\n`);
  await assert.rejects(verifyStatePackage(destination),
    /source database generation differs from its exported database/u);
  await postgres.close();
  postgres = null;
});
