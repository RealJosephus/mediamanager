import { testFileSystem } from '../storage/plugin-files.js';
import { openMetadataRelations, trackMetadataContexts, attachMetadataItemCreation, closeMetadataFixture, removeMetadataTestRoot } from './relations-fixture.js';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { LibraryService } from '../../src/library/library-service.js';
import { MetadataRefreshHost, MetadataRegistry, createMetadataContextLoader } from '../../src/metadata/index.js';
import { createApplication } from '../../src/http/application.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import nativeHttp from './fixtures/refresh-queue-http/native.json' with { type: 'json' };

const ids = Array.from({ length: 4 }, (_, index) => `F1111111-1111-1111-1111-${String(index + 1).padStart(12, '0')}`);
const empty = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated)
  .map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : 0]));
const stamp = '2026-09-26 10:00:00';
const updatedStamp = '2026-10-03T12:00:00Z';
const executeNode = (args, options) => new Promise((resolve, reject) => {
  execFile(process.execPath, args, options, (error, stdout, stderr) => {
    if (error) reject(error);
    else resolve({ stdout, stderr });
  });
});

async function setup(t, postgres, provider, kind = 'remote') {
  const schema = `refresh_queue_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const db = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const store = new DomainStore(db);
  const storage = new StorageRegistry();
  storage.registerType('memory', () => new MemoryStorageAdapter());
  await storage.createInstance('fixture', 'memory', {});
  const vfs = new VirtualFileSystem(storage); vfs.mount({ path: '/fixture', instanceId: 'fixture', capabilities: {} });
  const identityMap = new IdentityAccessMap();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'metadata-refresh-queue-'));
  const spoolRoot = path.join(stateRoot, 'metadata-spool'), contextLoaders = [];
  const linkedChildren = await openMetadataRelations(db, spoolRoot);
  const library = new LibraryService({fileSystem: testFileSystem,  store, linkedChildren, spoolRoot, programDataPath: stateRoot, serverId: 'refresh-queue' });
  const loadContext = trackMetadataContexts(createMetadataContextLoader({fileSystem: testFileSystem,  store, library, linkedChildren, spoolRoot, vfs, identityMap }), contextLoaders);
  const itemCreation = attachMetadataItemCreation({ store, library, linkedChildren, loadContext });
  const registry = new MetadataRegistry();
  registry.register({ id: 'controlled-refresh', name: 'Controlled refresh', providers: [{ id: 'controlled-provider', name: 'Controlled provider',
    kind, itemTypes: ['Movie'], ...(kind === 'custom' ? { fetch: provider } : { getMetadata: provider }) }] });
  const errors = [], events = [];
  const metadata = new MetadataRefreshHost({ registry, store, linkedChildren, loadContext, vfs, now: () => updatedStamp, logger: { error: error => errors.push(error) } });
  metadata.updates.on('ItemUpdated', event => events.push(event));
  for (const [index, Id] of ids.entries()) await db.insert('BaseItems', { ...empty('BaseItems'), Id,
    Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Name: `item-${index}`, Path: `https://isolated.invalid/item-${index}.mkv`,
    Data: '{}', IsInMixedFolder: true, PresentationUniqueKey: Id.replaceAll('-', '').toLowerCase(), DateLastSaved: stamp, DateLastRefreshed: stamp });
  const app = await createApplication({ configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, library, metadata,
    authentication: { authenticate: async () => ({ IsAuthenticated: true, IsAdministrator: true }), authorize(_auth, { policy }) { assert.equal(policy, 'RequiresElevation'); } },
    onError: error => errors.push(error) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await closeMetadataFixture({ library, itemCreation, linkedChildren, contexts: contextLoaders,
      before: [() => metadata.close(), () => new Promise(resolve => app.server.close(resolve)), () => metadata.images.close()],
      after: [() => storage.close(), () => db.client.query(`DROP SCHEMA "${schema}" CASCADE`),
        () => db.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`), () => store.close(),
        () => removeMetadataTestRoot(stateRoot, 'metadata-refresh-queue-')] });
  });
  return { db, store, metadata, errors, events, schema,
    post: (index, query = 'metadataRefreshMode=FullRefresh&replaceAllMetadata=true') => fetch(`${origin}/Items/${ids[index]}/Refresh?${query}`, { method: 'POST' }),
    row: async index => (await store.run(db => db.rows('BaseItems', { where: { Id: ids[index] } })))[0] };
}

const result = name => ({ HasMetadata: true, Item: { Type: 'Movie', Name: `updated-${name}`, Overview: `Provider updated ${name}` } });
const until = async promise => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Controlled refresh did not progress.')), 5000);
  })]).finally(() => clearTimeout(timer));
};

for (const postgres of [true]) {
  const database = 'PostgreSQL';
  const options = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES };
  test(`${database} public item refresh acknowledges a blocked provider and globally orders independent items`, options, async t => {
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    const order = [];
    let active = 0, maximumConcurrency = 0;
    const fixture = await setup(t, postgres, async lookup => {
      active++; maximumConcurrency = Math.max(maximumConcurrency, active); order.push(lookup.Name);
      try {
        if (lookup.Name === 'item-0') { started.resolve(); await release.promise; }
        return result(lookup.Name);
      } finally { active--; }
    });
    assert.equal((await fixture.post(0)).status, 204);
    await until(started.promise);
    for (const index of [1, 2, 3]) assert.equal((await fixture.post(index)).status, 204);
    assert.deepEqual(order, ['item-0']);
    for (let index = 0; index < 4; index++) assert.equal((await fixture.row(index)).Name, `item-${index}`);
    release.resolve(); await fixture.metadata.drain();
    assert.deepEqual(order, ['item-0', 'item-1', 'item-3', 'item-2']);
    assert.equal(maximumConcurrency, 1);
    assert.deepEqual(fixture.errors, []);
    assert.equal(fixture.events.length, 4);
    for (let index = 0; index < 4; index++) {
      const row = await fixture.row(index);
      assert.equal(row.Name, `updated-item-${index}`);
      assert.equal(row.DateLastRefreshed, '2026-10-03 12:00:00');
      assert.equal(row.DateLastSaved, '2026-10-03 12:00:00');
      assert.equal(fixture.events.find(event => event.Item.Id === ids[index]).Item.Name, row.Name);
    }
  });

  test(`${database} provider cancellation leaves its existing row intact and the HTTP queue continues`, options, async t => {
    const started = Promise.withResolvers(), release = Promise.withResolvers(), order = [];
    t.after(() => release.resolve());
    const cancellation = new DOMException('Controlled provider cancellation.', 'AbortError');
    const fixture = await setup(t, postgres, async lookup => {
      order.push(lookup.Name);
      if (lookup.Name === 'item-0') { started.resolve(); await release.promise; throw cancellation; }
      return result(lookup.Name);
    });
    const before = await fixture.row(0);
    assert.equal((await fixture.post(0)).status, 204); await until(started.promise);
    assert.equal((await fixture.post(1)).status, 204);
    release.resolve(); await fixture.metadata.drain();
    await delay(0);
    assert.deepEqual(order, ['item-0', 'item-1']);
    assert.deepEqual(await fixture.row(0), before);
    assert.equal((await fixture.row(1)).Name, 'updated-item-1');
    assert.deepEqual(fixture.events.map(event => event.Item.Id), [ids[1]]);
    assert.deepEqual(fixture.errors, [cancellation]);
  });

  test(`${database} shutdown cancels the active provider and discards pending HTTP refreshes without database changes`, options, async t => {
    const started = Promise.withResolvers(), order = [];
    const fixture = await setup(t, postgres, async (lookup, { signal }) => {
      order.push(lookup.Name); started.resolve();
      await delay(60000, undefined, { signal });
      return result(lookup.Name);
    });
    const before = await Promise.all(ids.map((_id, index) => fixture.row(index)));
    assert.equal((await fixture.post(0)).status, 204); await until(started.promise);
    assert.equal((await fixture.post(1)).status, 204);
    await until(fixture.metadata.close());
    assert.deepEqual(order, ['item-0']);
    assert.deepEqual(await Promise.all(ids.map((_id, index) => fixture.row(index))), before);
    assert.deepEqual(fixture.events, []);
  });

  test(`${database} SQL failure rolls back the item and publishes no update while the next queued request commits`, options, async t => {
    const fixture = await setup(t, postgres, async lookup => result(lookup.Name));
    const before = await fixture.row(0);
    const failure = new Error('Controlled metadata SQL failure.');
    const update = fixture.db.update.bind(fixture.db);
    fixture.db.update = async (table, where, changes) => {
      const row = await update(table, where, changes);
      if (table === 'BaseItems' && where.Id === ids[0]) throw failure;
      return row;
    };
    assert.equal((await fixture.post(0)).status, 204);
    assert.equal((await fixture.post(1)).status, 204);
    await fixture.metadata.drain(); await delay(0);
    assert.deepEqual(await fixture.row(0), before);
    assert.equal((await fixture.row(1)).Name, 'updated-item-1');
    assert.deepEqual(fixture.events.map(event => event.Item.Id), [ids[1]]);
    assert.deepEqual(fixture.errors, [failure]);
  });

  test(`${database} an independent process edit during an HTTP refresh survives conflict rejection and subsequent reload`, options, async t => {
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    let calls = 0;
    const fixture = await setup(t, postgres, async lookup => {
      if (++calls === 1) { started.resolve(); await release.promise; }
      return result(lookup.Name);
    });
    assert.equal((await fixture.post(0)).status, 204); await until(started.promise);
    const worker = fileURLToPath(new URL('./fixtures/refresh-queue-http/refresh-race-writer.mjs', import.meta.url));
    const execution = await executeNode([worker, fixture.schema, ids[0]],
      { timeout: 10000 });
    const observation = JSON.parse(execution.stdout);
    assert.notEqual(observation.pid, process.pid);
    assert.equal(observation.name, 'External process edit');
    release.resolve(); await fixture.metadata.drain(); await delay(0);
    assert.equal((await fixture.row(0)).Name, 'External process edit');
    assert.equal((await fixture.row(0)).DateLastRefreshed, stamp);
    assert.deepEqual(fixture.events, []);
    assert.equal(fixture.errors.length, 1);
    assert.equal(fixture.errors[0].code, 'metadata-conflict');
    assert.deepEqual(await fixture.db.rows('BaseItemProviders', { where: { ItemId: ids[0] } }),
      [{ ItemId: ids[0], ProviderId: 'External', ProviderValue: 'Preserved' }]);
    assert.equal((await fixture.post(0)).status, 204); await fixture.metadata.drain();
    assert.equal((await fixture.row(0)).Name, 'updated-External process edit');
    assert.equal(fixture.events.length, 1);
    assert.deepEqual(await fixture.db.rows('BaseItemProviders', { where: { ItemId: ids[0] } }),
      [{ ItemId: ids[0], ProviderId: 'External', ProviderValue: 'Preserved' }]);
  });

  for (const sample of nativeHttp) test(`${database} actual native HTTP and persisted refresh lifecycle: ${sample.name}`, options, async t => {
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    const order = [], cancelled = [];
    const fixture = await setup(t, postgres, async (item, { signal }) => {
      order.push(item.Name);
      try {
        if (item.Name === 'refresh-control-0') {
          started.resolve();
          await Promise.race([release.promise, delay(60000, undefined, { signal })]);
          if (sample.name === 'provider-cancellation') throw new DOMException('Controlled provider cancellation.', 'AbortError');
        }
        item.Overview = `Provider updated ${item.Name}`;
        return 2;
      } catch (error) {
        if (error.name === 'AbortError' || signal.aborted) cancelled.push(item.Name);
        throw error;
      }
    }, 'custom');
    for (let index = 0; index < 4; index++) await fixture.db.update('BaseItems', { Id: ids[index] }, { Name: `refresh-control-${index}`, Path: '' });
    const before = await Promise.all(ids.map((_id, index) => fixture.row(index)));
    const statuses = [];
    for (let index = 0; index < 4; index++) {
      statuses.push((await fixture.post(index, 'metadataRefreshMode=FullRefresh')).status);
      if (!index) await until(started.promise);
    }
    const beforeRelease = [...order];
    assert.deepEqual((await Promise.all(ids.map((_id, index) => fixture.row(index)))).map(row => [row.Overview, row.DateLastSaved, row.DateLastRefreshed]),
      before.map(row => [row.Overview, row.DateLastSaved, row.DateLastRefreshed]));
    if (sample.name === 'shutdown') await until(fixture.metadata.close());
    else { release.resolve(); await fixture.metadata.drain(); }
    const after = await Promise.all(ids.map((_id, index) => fixture.row(index)));
    const { shutdownStatus, exitCode, signalCode, ...expected } = sample;
    assert.equal(shutdownStatus, 204); assert.equal(exitCode, 0); assert.equal(signalCode, null);
    assert.deepEqual({ name: sample.name, statuses, beforeRelease, order, cancelled,
      persisted: after.map(row => row.Overview?.startsWith('Provider updated') ?? false),
      savedChanged: after.map((row, index) => row.DateLastSaved !== before[index].DateLastSaved),
      refreshedChanged: after.map((row, index) => row.DateLastRefreshed !== before[index].DateLastRefreshed),
      overviews: after.map(row => row.Overview),
    }, expected);
  });
}
