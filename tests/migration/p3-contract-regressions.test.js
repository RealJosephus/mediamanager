import { createPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import {
  discoverInstanceState,
  validateInstanceStateSnapshot,
  validateWriteBarrier,
  validateWriteBarrierSnapshot,
} from '../../src/migration/instance-state.js';
import { createStatePackage, restoreStatePackage, verifyStatePackage } from '../../src/migration/state-package.js';
import { createInstanceFixture } from './instance-fixture.js';

const serverId = '0123456789abcdef0123456789abcdef';
const recordedAt = '2026-10-04T03:04:05.000Z';
const packageStagingPath = destination => path.join(path.dirname(destination), `.${path.basename(destination)}.mediamanager-package-staging`);
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const stoppedBarrier = state => ({
  kind: 'stopped-service',
  identityDigest: state.identity.digest,
  recordedAt,
  ownedProcess: {
    pid: 4321,
    shutdown: { kind: 'http', statusCode: 204 },
    forced: false,
    exitCode: 0,
    signalCode: null,
    stopped: true,
  },
});

const isolatedBarrier = state => ({
  kind: 'isolated-offline-copy',
  identityDigest: state.identity.digest,
  recordedAt,
  isolatedCopy: {
    owner: { kind: 'test-fixture', id: 'persisted snapshot regression' },
    source: { identityDigest: state.identity.digest, serverId: state.identity.serverId },
  },
});

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse()
    .map(([key, child]) => [key, reverseObjectKeys(child)]));
}

function validRestoreMarker(destination) {
  return {
    generation: '11111111-1111-4111-8111-111111111111',
    manifestSha256: 'a'.repeat(64),
    layoutSha256: 'b'.repeat(64),
    systemConfigurationSha256: 'c'.repeat(64),
    destination,
    stage: 'complete',
    database: { restorePath: 'data/data/jellyfin.db', sha256: 'd'.repeat(64) },
    extensionStateSha256: 'e'.repeat(64),
    mediaAccessSha256: 'f'.repeat(64),
  };
}

test('uppercase native device identity retains its original text through configuration and discovery', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-p3-uppercase-' });
  await writeFile(path.join(fixture.root, 'data/data/device.txt'), serverId.toUpperCase());

  assert.equal((await readInstanceConfiguration(fixture.root)).serverId, serverId.toUpperCase());
  assert.equal((await discoverInstanceState({ instanceRoot: fixture.root })).identity.serverId, serverId.toUpperCase());
});

test('persisted discovery snapshots are key-order independent while barriers remain identity-bound', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-p3-persisted-' });
  const state = await discoverInstanceState({ instanceRoot: fixture.root });
  const persisted = JSON.parse(JSON.stringify(reverseObjectKeys(state)));
  const validated = validateInstanceStateSnapshot(persisted);

  assert.deepEqual(validated, state);
  assert.deepEqual(await validateWriteBarrier(stoppedBarrier(state), validated), stoppedBarrier(state));

  const mismatched = isolatedBarrier(state);
  mismatched.isolatedCopy.source.identityDigest = state.identity.digest === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
  assert.throws(() => validateWriteBarrierSnapshot(mismatched, validated), /source identity/u);
});

test('deleting or changing a valid restore marker invalidates the original write barrier', async t => {
  for (const [name, mutate] of [
    ['deleted marker', filename => unlink(filename)],
    ['changed marker content', async (filename, marker) => {
      marker.extensionStateSha256 = '0'.repeat(64);
      await writeFile(filename, `${JSON.stringify(marker, null, 2)}\n`);
    }],
  ]) await t.test(name, async t => {
    const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-p3-marker-generation-' });
    const filename = path.join(fixture.root, 'mediamanager-state.json');
    const marker = validRestoreMarker(fixture.root);
    await writeFile(filename, `${JSON.stringify(marker, null, 2)}\n`);
    const state = await discoverInstanceState({ instanceRoot: fixture.root });
    const barrier = stoppedBarrier(state);

    await mutate(filename, marker);
    await assert.rejects(validateWriteBarrier(barrier, state), /control generation is no longer current/u);
  });
});

test('database transfer rejects unknown options before touching either database', async () => {
  const source = new SqliteDatabase(':memory:', { create: true });
  const target = new SqliteDatabase(':memory:', { create: true });
  try {
    await assert.rejects(transferDatabase(source, target, { mysteryOption: true }), /Invalid database transfer options/u);
  } finally {
    source.close();
    target.close();
  }
});

test('PostgreSQL transaction rolls back when BEGIN reached the server but its acknowledgement was lost', async () => {
  let serverTransactionOpen = false;
  let rollbackAttempts = 0;
  let released = false;
  const client = {
    async query(sql) {
      if (sql.startsWith('SET search_path')) return { rows: [] };
      if (sql.startsWith('BEGIN ')) {
        serverTransactionOpen = true;
        throw new Error('simulated lost BEGIN acknowledgement');
      }
      if (sql === 'ROLLBACK') {
        rollbackAttempts += 1;
        serverTransactionOpen = false;
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() { released = true; },
  };
  const pool = {
    options: { host: 'mock-host', port: 5432 },
    async connect() { return client; },
  };
  const database = new PostgresDatabase(pool, 'lost_begin');

  await assert.rejects(database.transaction(async () => {
    throw new Error('callback must not run');
  }), /lost BEGIN acknowledgement/u);
  assert.equal(rollbackAttempts, 1);
  assert.equal(serverTransactionOpen, false);
  assert.equal(database.inTransaction, false);
  assert.equal(released, true);
});

test('a complete package remains verifiable after copy and rename, and restored markers reject semantic tampering', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-p3-relocated-package-' });
  const original = path.join(fixture.directory, 'package-original');
  await createStatePackage(await fixture.packageOptions({
    destination: original,
    extensionState: { plugin: { enabled: true } },
  }));

  const copied = path.join(fixture.directory, 'package-copy');
  const moved = path.join(fixture.directory, 'package-moved');
  await cp(original, copied, { recursive: true });
  await verifyStatePackage(copied);
  await rename(copied, moved);
  await verifyStatePackage(moved);

  for (const [name, mutate] of [
    ['extension state', marker => { marker.extensionStateSha256 = '0'.repeat(64); }],
    ['media access', marker => { marker.mediaAccessSha256 = '0'.repeat(64); }],
  ]) await t.test(name, async () => {
    const destination = path.join(fixture.directory, `restored-${name.replaceAll(' ', '-')}`);
    await restoreStatePackage(moved, destination);
    const markerPath = path.join(destination, 'mediamanager-state.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    mutate(marker);
    await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
    await assert.rejects(restoreStatePackage(moved, destination), /Restore state does not match/u);
  });
});

test('package capture recovers from each pre-journal staging shape', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-p3-prejournal-' });
  for (const [name, prepare] of [
    ['empty staging', async () => {}],
    ['files directory only', staging => mkdir(path.join(staging, 'files'))],
    ['temporary progress only', staging => writeFile(path.join(staging, 'progress.json.tmp'), 'interrupted journal bytes')],
  ]) await t.test(name, async () => {
    const destination = path.join(fixture.directory, `package-${name.replaceAll(' ', '-')}`);
    const staging = packageStagingPath(destination);
    await mkdir(staging);
    await prepare(staging);

    const manifest = await createStatePackage(await fixture.packageOptions({ destination }));
    assert.deepEqual(await verifyStatePackage(destination), manifest);
  });
});

test('package path binding accepts configured absolute paths with host separator semantics', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-p3-native-path-' });
  const metadata = path.join(fixture.root, 'data/metadata/custom');
  const cache = path.join(fixture.root, 'cache/custom');
  await mkdir(metadata, { recursive: true });
  await mkdir(cache, { recursive: true });
  // Windows accepts forward slashes in these absolute paths; POSIX already
  // uses them. Exercise actual host paths without simulating another OS.
  await writeFile(path.join(fixture.root, 'config/system.xml'), [
    '<ServerConfiguration>',
    `<MetadataPath>${xml(metadata.replaceAll('\\', '/'))}</MetadataPath>`,
    `<CachePath>${xml(cache.replaceAll('\\', '/'))}</CachePath>`,
    '</ServerConfiguration>',
  ].join(''));
  const destination = path.join(fixture.directory, 'package');

  const manifest = await createStatePackage(await fixture.packageOptions({ destination }));
  assert.deepEqual(await verifyStatePackage(destination), manifest);
});

const apiKey = Name => ({ Name, AccessToken: Name, DateCreated: '2026-10-09 12:00:00', DateLastActivity: '2026-10-09 12:00:00' });

test('migration discards a target whose rollback failed', { skip: !postgresTestConnectionString }, async t => {
  const source = new SqliteDatabase(':memory:', { create: true });
  t.after(() => source.close());
  source.insert('ApiKeys', apiKey('must-not-leak'));
  const target = await createPostgresTestDatabase(t, 'target_rollback', { max: 1 });
  await target.withConnection(async session => {
    const query = session.client.query.bind(session.client);
    const insertBatch = session.insertBatch.bind(session);
    session.insertBatch = async (...args) => { await insertBatch(...args); throw new Error('injected copy failure'); };
    session.client.query = (statement, ...args) => {
      if (statement === 'ROLLBACK') throw new Error('injected rollback failure');
      return query(statement, ...args);
    };
    try {
      await assert.rejects(transferDatabase(source, session), error => error instanceof AggregateError
        && error.errors.some(cause => cause.message === 'injected rollback failure'));
    } finally { session.client.query = query; }
  });
  await target.transaction(session => session.insert('ApiKeys', { ...apiKey('subsequent-write'), Id: 2 }));
  assert.deepEqual((await target.rows('ApiKeys')).map(row => row.Name), ['subsequent-write']);
});

test('migration discards a source whose rollback failed', { skip: !postgresTestConnectionString }, async t => {
  const source = await createPostgresTestDatabase(t, 'source_rollback', { max: 1 });
  const target = new SqliteDatabase(':memory:', { create: true });
  t.after(() => target.close());
  await source.withConnection(async session => {
    const query = session.client.query.bind(session.client);
    session.client.query = (statement, ...args) => {
      if (statement === 'ROLLBACK') throw new Error('injected rollback failure');
      return query(statement, ...args);
    };
    try {
      await assert.rejects(transferDatabase(session, target), error => error instanceof AggregateError
        && error.errors.some(cause => cause.message === 'injected rollback failure'));
    } finally { session.client.query = query; }
  });
  await source.transaction(session => session.insert('ApiKeys', apiKey('subsequent-write')));
  assert.deepEqual((await source.rows('ApiKeys')).map(row => row.Name), ['subsequent-write']);
});
