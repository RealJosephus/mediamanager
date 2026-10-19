import { testFileSystem } from '../storage/plugin-files.js';
import { openMetadataRelations, trackMetadataContexts, attachMetadataItemCreation, closeMetadataFixture, removeMetadataTestRoot } from './relations-fixture.js';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { quoteIdentifier, tableDefinition } from '../../src/database/model.js';
import { reattachUserData } from '../../src/metadata/persistence.js';
import { hydrateItem, userDataKeys } from '../../src/sessions/user-data.js';
import { LibraryService } from '../../src/library/library-service.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { MetadataRefreshHost } from '../../src/metadata/refresh-host.js';
import { MetadataRegistry } from '../../src/metadata/registry.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';

const placeholderId = '00000000-0000-0000-0000-000000000001';
const ids = {
  series: 'E7111111-1111-1111-1111-000000000001',
  season: 'E7111111-1111-1111-1111-000000000002',
  episode: 'E7111111-1111-1111-1111-000000000003',
  user: 'E7111111-1111-1111-1111-000000000004',
};
const empty = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated)
  .map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : 0]));
const itemRow = (Id, Type, values = {}) => ({ ...empty('BaseItems'), Id,
  Type: Type === 'PLACEHOLDER' ? Type : `MediaBrowser.Controller.Entities.TV.${Type}`,
  Name: Type, SortName: Type.toLowerCase(), CleanName: Type.toLowerCase(), Data: '{}', ...values });

async function fixture(t) {
  const schema = `userdata_reattach_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const db = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const store = new DomainStore(db);
  t.after(async () => {
    await db.client.query(`DROP SCHEMA ${quoteIdentifier(db.schemaName)} CASCADE`);
    await db.client.query(`DROP SCHEMA ${quoteIdentifier(db.controlSchema)} CASCADE`);
    await store.close();
  });
  await db.insert('BaseItems', itemRow(placeholderId, 'PLACEHOLDER'));
  await db.insert('BaseItems', itemRow(ids.series, 'Series', { IsFolder: true }));
  await db.insert('BaseItems', itemRow(ids.season, 'Season', { IsFolder: true, ParentId: ids.series, SeriesId: ids.series, IndexNumber: 1 }));
  await db.insert('BaseItems', itemRow(ids.episode, 'Episode', {
    ParentId: ids.season, SeriesId: ids.series, SeasonId: ids.season, ParentIndexNumber: 1, IndexNumber: 2,
  }));
  for (const [ProviderId, ProviderValue] of [['Imdb', 'tt-series'], ['Tvdb', 'tvdb-series'], ['Custom', 'custom-series']]) {
    await db.insert('BaseItemProviders', { ItemId: ids.series, ProviderId, ProviderValue });
  }
  await db.insert('Users', { ...empty('Users'), Id: ids.user, InternalId: 71, Username: 'Fixture', NormalizedUsername: 'FIXTURE' });
  const item = await hydrateItem(db, (await db.rows('BaseItems', { where: { Id: ids.episode } }))[0]);
  const keys = await userDataKeys(db, item);
  assert.deepEqual(keys, [
    'custom-series001002', 'tvdb-series001002', 'tt-series001002', ids.episode.toLowerCase(),
  ]);
  return { db, store, item, keys };
}

async function seedDetached(db, keys) {
  for (const [index, CustomDataKey] of keys.entries()) await db.insert('UserData', {
    ...empty('UserData'), ItemId: placeholderId, UserId: ids.user, CustomDataKey,
    PlayCount: index + 1, PlaybackPositionTicks: BigInt(index + 1) * 9007199254740993n,
    RetentionDate: `2026-09-0${index + 1} 12:00:00`,
  });
  await db.insert('UserData', {
    ...empty('UserData'), ItemId: placeholderId, UserId: ids.user, CustomDataKey: 'unrelated',
    PlayCount: 99, PlaybackPositionTicks: 99n, RetentionDate: '2026-08-01 12:00:00',
  });
}

for (const dialect of ['postgres']) test(`${dialect}: first-refresh user data reattachment is complete and atomic`, async t => {
  await t.test('the initial save leaves rows detached; final save then reattaches in native order', async t => {
    const { db, store, keys } = await fixture(t, dialect);
    await seedDetached(db, keys);
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'metadata-reattach-'));
    const spoolRoot = path.join(stateRoot, 'metadata-spool'), contextLoaders = [];
    const linkedChildren = await openMetadataRelations(db, spoolRoot);
    const library = new LibraryService({fileSystem: testFileSystem,  store, linkedChildren, spoolRoot, programDataPath: stateRoot, serverId: 'reattach-lifecycle-test' });
    const loadContext = trackMetadataContexts(createMetadataContextLoader({fileSystem: testFileSystem,  store, library, linkedChildren, spoolRoot, vfs: {}, identityMap: {} }), contextLoaders);
    const itemCreation = attachMetadataItemCreation({ store, library, linkedChildren, loadContext });
    const registry = new MetadataRegistry(), events = [];
    registry.register({ id: 'lifecycle', name: 'Lifecycle', providers: [{
      id: 'lifecycle', name: 'Lifecycle', kind: 'custom', itemTypes: ['Episode'],
      async fetch() {
        events.push('provider');
        assert.equal((await db.rows('UserData', { where: { ItemId: ids.episode } })).length, 0);
        assert.equal((await db.rows('UserData', { where: { ItemId: placeholderId } })).length, keys.length + 1);
        return ItemUpdateType.None;
      },
    }] });
    const host = new MetadataRefreshHost({ registry, store, linkedChildren, loadContext, vfs: {}, now: () => '2026-10-04T01:02:03Z' });
    host.updates.on('ItemUpdated', () => events.push('save'));
    host.updates.on('UserDataReattached', () => events.push('reattach'));
    try {
      await host.refresh(ids.episode, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' });
      assert.deepEqual(events, ['save', 'provider', 'save', 'reattach']);
      assert.deepEqual((await db.rows('UserData', { where: { ItemId: ids.episode } })).map(row => row.CustomDataKey), [...keys].sort());
    } finally { await closeMetadataFixture({ library, itemCreation, linkedChildren, contexts: contextLoaders,
      before: [() => host.close()], after: [() => removeMetadataTestRoot(stateRoot, 'metadata-reattach-')] }); }
  });

  await t.test('provider cancellation after the initial save does not reattach early', async t => {
    const { db, store, keys } = await fixture(t, dialect);
    await seedDetached(db, keys);
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'metadata-reattach-'));
    const spoolRoot = path.join(stateRoot, 'metadata-spool'), contextLoaders = [];
    const linkedChildren = await openMetadataRelations(db, spoolRoot);
    const library = new LibraryService({fileSystem: testFileSystem,  store, linkedChildren, spoolRoot, programDataPath: stateRoot, serverId: 'reattach-cancellation-test' });
    const loadContext = trackMetadataContexts(createMetadataContextLoader({fileSystem: testFileSystem,  store, library, linkedChildren, spoolRoot, vfs: {}, identityMap: {} }), contextLoaders);
    const itemCreation = attachMetadataItemCreation({ store, library, linkedChildren, loadContext });
    const registry = new MetadataRegistry(), events = [], controller = new AbortController();
    const expected = new Error('Injected provider cancellation');
    registry.register({ id: 'cancel', name: 'Cancel', providers: [{
      id: 'cancel', name: 'Cancel', kind: 'custom', itemTypes: ['Episode'],
      async fetch() { events.push('provider'); controller.abort(expected); throw expected; },
    }] });
    const host = new MetadataRefreshHost({ registry, store, linkedChildren, loadContext, vfs: {} });
    host.updates.on('ItemUpdated', () => events.push('save'));
    host.updates.on('UserDataReattached', () => events.push('reattach'));
    try {
      await assert.rejects(host.refresh(ids.episode, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None', signal: controller.signal }),
        error => error === expected);
      assert.deepEqual(events, ['save', 'provider']);
      assert.equal((await db.rows('UserData', { where: { ItemId: ids.episode } })).length, 0);
      assert.equal((await db.rows('UserData', { where: { ItemId: placeholderId } })).length, keys.length + 1);
    } finally { await closeMetadataFixture({ library, itemCreation, linkedChildren, contexts: contextLoaders,
      before: [() => host.close()], after: [() => removeMetadataTestRoot(stateRoot, 'metadata-reattach-')] }); }
  });

  await t.test('moves every native key, clears retention and rehydrates the item cache', async t => {
    const { db, store, item, keys } = await fixture(t, dialect);
    await seedDetached(db, keys);
    const attached = await reattachUserData(store, item);
    assert.deepEqual(attached.map(row => row.CustomDataKey), [...keys].sort());
    for (const [index, key] of keys.entries()) {
      const [row] = await db.rows('UserData', { where: { ItemId: ids.episode, UserId: ids.user, CustomDataKey: key } });
      assert.equal(row.RetentionDate, null); assert.equal(row.PlayCount, index + 1);
      assert.equal(row.PlaybackPositionTicks, BigInt(index + 1) * 9007199254740993n);
    }
    assert.deepEqual(item.UserData, attached);
    const [unrelated] = await db.rows('UserData', { where: { ItemId: placeholderId, UserId: ids.user, CustomDataKey: 'unrelated' } });
    assert.equal(unrelated.RetentionDate, '2026-08-01 12:00:00');
  });

  await t.test('a target primary-key conflict preserves both target and detached rows', async t => {
    const { db, store, item, keys } = await fixture(t, dialect);
    await seedDetached(db, keys);
    const conflictKey = [...keys].sort().at(-1);
    await db.insert('UserData', {
      ...empty('UserData'), ItemId: ids.episode, UserId: ids.user, CustomDataKey: conflictKey,
      PlayCount: 777, PlaybackPositionTicks: 777n,
    });
    const before = await db.rows('UserData');
    item.UserData = [{ sentinel: true }];
    await assert.rejects(reattachUserData(store, item));
    assert.deepEqual(await db.rows('UserData'), before);
    assert.deepEqual(item.UserData, [{ sentinel: true }]);
  });

  for (const mode of ['cancellation', 'failure']) await t.test(`${mode} after the first migrated row rolls back every row`, async t => {
    const { db, store, item, keys } = await fixture(t, dialect);
    await seedDetached(db, keys);
    const before = await db.rows('UserData');
    const beforeUserData = item.UserData;
    const controller = new AbortController(), expected = new Error(`Injected reattachment ${mode}`);
    let migrated = 0;
    db.queryHook = async (...args) => {
      const result = await db.client.query(...args);
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
      if (/UPDATE\s+"[^"]+"\."UserData"/u.test(text) && result.rowCount > 0 && ++migrated === 1) {
        if (mode === 'cancellation') controller.abort(expected);
        else throw expected;
      }
      return result;
    };
    try {
      await assert.rejects(reattachUserData(store, item, { signal: controller.signal }), error => error === expected);
    } finally {
      db.queryHook = null;
    }
    assert.deepEqual(await db.rows('UserData'), before);
    assert.equal(item.UserData, beforeUserData);
    assert.deepEqual(item.UserData, []);
  });
});
