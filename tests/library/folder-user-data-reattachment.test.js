import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tableDefinition } from '../../src/database/model.js';
import { DirectoryItemResolverPipeline } from '../../src/library/directory-item-resolver.js';
import { FolderValidationService } from '../../src/library/folder-validation-service.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { ItemDeletionService } from '../../src/library/item-deletion-service.js';
import { ResolvedItemLifecycleHost } from '../../src/library/resolved-item-lifecycle.js';
import { createVideoFileResolver } from '../../src/library/video-file-resolver.js';
import { guid, idKey, dateText } from '../../src/library/records.js';
import { reattachUserData } from '../../src/metadata/persistence.js';
import { ProviderRefreshService } from '../../src/metadata/provider-refresh-service.js';
import { guidD } from '../../src/sessions/user-data.js';
import { nativeGuid } from '../../src/users/native.js';
import { discoveryFixture, typeName } from './video-discovery-fixture.js';

const placeholderId = '00000000-0000-0000-0000-000000000001';
const userId = 'FA130000-0000-0000-0000-000000000001';
const sharedKey = 'tt7654321';
const oldName = `Old Recording ${sharedKey}.mkv`;
const sample = Object.freeze({
  name: 'folder-user-data-reattachment',
  operation: 'resolvepaths',
  expectedType: 'Movie',
  resolverType: 'Movie',
  parseName: true,
  mixed: true,
  existingType: true,
  collectionType: 'movies',
  entries: [oldName],
  files: [oldName],
  directories: [],
  ignoreFiles: []
});

const blank = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => [column.name,
  column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));

async function subject(t, dialect, { newNames = [`New Recording ${sharedKey}.mkv`], beforeReattach,
  protectOld = false } = {}) {
  const value = await discoveryFixture(t, dialect, sample, { captureDatabaseDeletes: false, captureMetadataEvents: false });
  const { fixture, loaded, oldId, childrenCleared } = value;
  await fixture.database.delete('BaseItems', { Id: loaded.item.Id });
  await fixture.adapter.delete('/discovery/primary.mkv');
  if (!(await fixture.database.rows('BaseItems', { where: { Id: placeholderId } })).length) {
    await fixture.database.insert('BaseItems', {
      ...blank('BaseItems'),
      Id: placeholderId,
      Type: 'PLACEHOLDER',
      Name: 'This is a placeholder item for UserData that has been detached from its original item',
      Data: '{}'
    });
  }
  await fixture.database.insert('BaseItemProviders', { ItemId: oldId, ProviderId: 'Imdb', ProviderValue: sharedKey });
  await fixture.database.insert('Users', {
    ...blank('Users'), Id: userId, InternalId: 1301, Username: 'UserData Fixture', NormalizedUsername: 'USERDATA FIXTURE'
  });
  const oldIdKey = guidD(oldId);
  await fixture.database.insert('UserData', {
    ...blank('UserData'), ItemId: oldId, UserId: userId, CustomDataKey: sharedKey,
    IsFavorite: true, Played: true, PlayCount: 7, PlaybackPositionTicks: 9007199254740993n,
    LastPlayedDate: '2026-10-03 01:02:03.0000000', Rating: 8.5
  });
  await fixture.database.insert('UserData', {
    ...blank('UserData'), ItemId: oldId, UserId: userId, CustomDataKey: oldIdKey,
    PlayCount: 3, PlaybackPositionTicks: 33n
  });

  await fixture.adapter.delete('/discovery/' + oldName);
  for (const name of newNames) await fixture.adapter.write('/discovery/' + name, Buffer.from('replacement media'), {
    modified: '2025-01-03T04:05:06.0000000Z'
  });

  if (protectOld) {
    const load = fixture.library.load.bind(fixture.library);
    fixture.library.load = async (...args) => {
      const state = await load(...args);
      const old = state.byId.get(idKey(oldId));
      if (old) old.CanDelete = false;
      return state;
    };
  }

  const phases = [], errors = [];
  fixture.library.on('ItemRemoved', event => phases.push({ action: 'removed', id: guid(event.Item.Id) }));
  fixture.library.on('ItemAdded', event => phases.push({ action: 'added', id: guid(event.Item.Id) }));
  const creator = new ItemCreationService({ ...fixture });
  const linkedChildReferences = { reroute: async () => [] };
  fixture.library.itemCreation = creator;
  creator.registerItem(loaded.parent);
  fixture.host.updates.library = fixture.library;
  fixture.library.itemDeletion = new ItemDeletionService({ ...fixture, itemCreation: creator,
    updates: fixture.host.updates, externalData: loaded.videoVersionDiscovery.externalData,
    linkedChildReferences, now: () => fixture.now });
  t.after(() => creator.close());
  const lifecycle = new ResolvedItemLifecycleHost({ store: fixture.store, loadContext: fixture.loadContext,
    updates: fixture.host.updates, images: fixture.host.images });
  const resolverPipeline = new DirectoryItemResolverPipeline({ resolvers: [createVideoFileResolver()],
    programDataPath: fixture.stateRoot, configuration: fixture.configuration, onError: error => errors.push(error) });
  const reattach = async (store, item, options) => {
    phases.push({ action: 'reattach', id: guid(item.Id) });
    await beforeReattach?.({ store, item, options, phases });
    return reattachUserData(store, item, options);
  };
  const validation = new FolderValidationService({
    store: fixture.store,
    library: fixture.library,
    itemCreation: creator,
    resolvedItemLifecycle: lifecycle,
    vfs: fixture.vfs,
    identityMap: fixture.identityMap,
    ignoreRule: fixture.ignoreRule,
    resolverPipeline,
    loadContext: fixture.loadContext,
    programDataPath: fixture.stateRoot,
    configurationDirectoryPath: path.join(fixture.stateRoot, 'config'),
    refreshes: new ProviderRefreshService(),
    linkedChildReferences,
    metadataScanner: {
      async refreshAccessibleChildren() {},
      async refreshContainer() {}
    },
    clock: () => fixture.now,
    onError: error => errors.push(error),
    reattach
  });
  const newItems = newNames.map(name => ({
    name,
    id: nativeGuid(loaded.getNewItemId(path.join(loaded.parent.Path, name), typeName('Movie')))
  }));
  return { ...value, fixture, validation, creator, phases, errors, oldId, oldIdKey, newItems, childrenCleared };
}

function userDataRows(database) {
  return database.rows('UserData', {
    orderBy: [{ column: 'ItemId', direction: 'ASC' }, { column: 'CustomDataKey', direction: 'ASC' }]
  });
}

for (const dialect of ['postgres']) test(`${dialect}: folder validation reattaches removed user data by populated keys`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  await t.test('moves only shared keys after removal and creation and rehydrates the valid child cache', async t => {
    const context = await subject(t, dialect);
    await context.validation.validateChildren(context.loaded.parent, { collectionType: 'movies' });

    const [{ id: newId }] = context.newItems;
    assert.deepEqual(context.phases, [
      { action: 'removed', id: guid(context.oldId) },
      { action: 'added', id: guid(newId) },
      { action: 'reattach', id: guid(newId) }
    ]);
    assert.deepEqual(context.errors, []);
    const rows = await userDataRows(context.fixture.database);
    const shared = rows.find(row => row.CustomDataKey === sharedKey);
    const identity = rows.find(row => row.CustomDataKey === context.oldIdKey);
    assert.equal(idKey(shared.ItemId), idKey(newId));
    assert.equal(shared.RetentionDate, null);
    assert.equal(shared.Played, true);
    assert.equal(shared.IsFavorite, true);
    assert.equal(shared.PlayCount, 7);
    assert.equal(shared.PlaybackPositionTicks, 9007199254740993n);
    assert.equal(idKey(identity.ItemId), idKey(placeholderId));
    assert.equal(dateText(identity.RetentionDate), dateText(context.fixture.now));
    const cached = await context.creator.getItemById(newId);
    assert.deepEqual(cached.UserData.map(row => row.CustomDataKey), [sharedKey]);
    assert.equal(context.childrenCleared(), true);
  });

  await t.test('reattaches matching valid children in resolver order', async t => {
    const names = [`Alpha Recording ${sharedKey}.mkv`, `Beta Recording ${sharedKey}.mkv`];
    const context = await subject(t, dialect, { newNames: names });
    await context.validation.validateChildren(context.loaded.parent, { collectionType: 'movies' });

    const orderedIds = context.newItems.map(item => guid(item.id));
    assert.deepEqual(context.phases.filter(phase => phase.action === 'reattach').map(phase => phase.id), orderedIds);
    const first = await context.creator.getItemById(context.newItems[0].id);
    const second = await context.creator.getItemById(context.newItems[1].id);
    assert.deepEqual(first.UserData.map(row => row.CustomDataKey), [sharedKey]);
    assert.deepEqual(second.UserData, []);
    assert.equal(context.childrenCleared(), true);
  });

  await t.test('does not invoke reattachment when no valid child has a removed key', async t => {
    const context = await subject(t, dialect, { newNames: ['Unrelated Replacement.mkv'] });
    await context.validation.validateChildren(context.loaded.parent, { collectionType: 'movies' });

    const [{ id: newId }] = context.newItems;
    assert.deepEqual(context.phases, [
      { action: 'removed', id: guid(context.oldId) },
      { action: 'added', id: guid(newId) }
    ]);
    const rows = await userDataRows(context.fixture.database);
    assert.ok(rows.every(row => idKey(row.ItemId) === idKey(placeholderId)));
    assert.ok(rows.every(row => dateText(row.RetentionDate) === dateText(context.fixture.now)));
    assert.deepEqual((await context.creator.getItemById(newId)).UserData, []);
    assert.equal(context.childrenCleared(), true);
  });

  await t.test('retains an earlier child reattachment when a later matching child fails', async t => {
    const failure = new Error('controlled second-child reattachment failure');
    let attempts = 0;
    const names = [`Alpha Recording ${sharedKey}.mkv`, `Beta Recording ${sharedKey}.mkv`];
    const context = await subject(t, dialect, {
      newNames: names,
      beforeReattach: () => { if (++attempts === 2) throw failure; }
    });

    await assert.rejects(context.validation.validateChildren(context.loaded.parent, {
      collectionType: 'movies'
    }), error => error === failure);

    const orderedIds = context.newItems.map(item => guid(item.id));
    assert.deepEqual(context.phases, [
      { action: 'removed', id: guid(context.oldId) },
      ...orderedIds.map(id => ({ action: 'added', id })),
      ...orderedIds.map(id => ({ action: 'reattach', id }))
    ]);
    assert.equal((await context.fixture.database.rows('BaseItems', { where: { Id: context.oldId } })).length, 0);
    for (const { id } of context.newItems) {
      assert.equal((await context.fixture.database.rows('BaseItems', { where: { Id: id } })).length, 1);
    }
    const rows = await userDataRows(context.fixture.database);
    const shared = rows.find(row => row.CustomDataKey === sharedKey);
    const identity = rows.find(row => row.CustomDataKey === context.oldIdKey);
    assert.equal(idKey(shared.ItemId), idKey(context.newItems[0].id));
    assert.equal(shared.RetentionDate, null);
    assert.equal(idKey(identity.ItemId), idKey(placeholderId));
    assert.equal(dateText(identity.RetentionDate), dateText(context.fixture.now));
    assert.deepEqual((await context.creator.getItemById(context.newItems[0].id)).UserData
      .map(row => row.CustomDataKey), [sharedKey]);
    assert.deepEqual((await context.creator.getItemById(context.newItems[1].id)).UserData, []);
    assert.equal(context.childrenCleared(), true);
  });

  await t.test('uses only items actually removed, excluding a protected stale child', async t => {
    const context = await subject(t, dialect, { protectOld: true });
    await context.validation.validateChildren(context.loaded.parent, { collectionType: 'movies' });

    const [{ id: newId }] = context.newItems;
    assert.deepEqual(context.phases, [{ action: 'added', id: guid(newId) }]);
    assert.equal((await context.fixture.database.rows('BaseItems', { where: { Id: context.oldId } })).length, 1);
    assert.equal((await context.fixture.database.rows('BaseItems', { where: { Id: newId } })).length, 1);
    const rows = await userDataRows(context.fixture.database);
    assert.ok(rows.every(row => idKey(row.ItemId) === idKey(context.oldId)));
    assert.deepEqual((await context.creator.getItemById(newId)).UserData, []);
    assert.equal(context.childrenCleared(), true);
  });

  await t.test('cancellation at reattachment retains prior deletion and creation without advancing child cache', async t => {
    const controller = new AbortController();
    const reason = new Error('controlled reattachment cancellation');
    const context = await subject(t, dialect, { beforeReattach: () => controller.abort(reason) });

    await assert.rejects(context.validation.validateChildren(context.loaded.parent, {
      collectionType: 'movies', signal: controller.signal
    }), error => error === reason);

    const [{ id: newId }] = context.newItems;
    assert.deepEqual(context.phases, [
      { action: 'removed', id: guid(context.oldId) },
      { action: 'added', id: guid(newId) },
      { action: 'reattach', id: guid(newId) }
    ]);
    assert.equal((await context.fixture.database.rows('BaseItems', { where: { Id: context.oldId } })).length, 0);
    assert.equal((await context.fixture.database.rows('BaseItems', { where: { Id: newId } })).length, 1);
    const rows = await userDataRows(context.fixture.database);
    assert.ok(rows.every(row => idKey(row.ItemId) === idKey(placeholderId)));
    assert.ok(rows.every(row => dateText(row.RetentionDate) === dateText(context.fixture.now)));
    const cached = await context.creator.getItemById(newId);
    assert.deepEqual(cached.UserData, []);
    assert.equal(context.childrenCleared(), true);
  });
});
