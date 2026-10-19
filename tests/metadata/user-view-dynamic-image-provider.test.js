import { testFileSystem } from '../storage/plugin-files.js';
import { openMetadataRelations, trackMetadataContexts, attachMetadataItemCreation } from './relations-fixture.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { quoteIdentifier, tableDefinition } from '../../src/database/model.js';
import { LibraryService } from '../../src/library/library-service.js';
import { createUserViewDynamicImagePlugin } from '../../src/metadata/user-view-dynamic-image-provider.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { dateTicks, idKey, MIN_DATE } from '../../src/library/records.js';
import { internalImagePath } from '../../src/metadata/image-paths.js';

const nativeBytes = await readFile(new URL('./fixtures/user-view-dynamic/native.json', import.meta.url));
assert.equal(createHash('sha256').update(nativeBytes).digest('hex'), 'e0404526906b6ecc66f38353f64a7747b172d3a6a9d970aa03cae1e6bf6e30c5');
const native = JSON.parse(nativeBytes);
const lifecycleBytes = await readFile(new URL('./fixtures/user-view-refresh-lifecycle/native.json', import.meta.url));
assert.equal(createHash('sha256').update(lifecycleBytes).digest('hex'), '64b2741c37d5ccf69579e3ab34d938986988444e32b2f07d34a4c00ec840681a');
const lifecycle = JSON.parse(lifecycleBytes);
assert.equal(lifecycle.actualFrozenUserViewMetadataService, true);
assert.equal(native.schemaVersion, 1);
assert.deepEqual(native.verified, { nativeProcessExit: 0, actualFrozenDynamicProvider: true, actualManagedFileSystem: true,
  controlledSourceQuery: true, controlledCollageProcessor: true });
assert.deepEqual(native.output.map(value => value.name), ['missing-managed-primary', 'missing-min-managed-primary',
  'cancelled-empty-query', 'cancelled-failing-query', 'cancelled-local-source']);
assert.equal(native.sourceBindings.length, 8);
assert.ok(native.sourceBindings.every(value => /^[a-f0-9]{64}$/u.test(value.sha256) && value.bytes > 0));

const id = value => `98200000-0000-0000-0000-${String(value).padStart(12, '0')}`;
const empty = Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => !column.generated).map(column =>
  [column.name, column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : 0]));
const item = (number, Type, values = {}) => ({ ...empty, Id: id(number), Type: 'MediaBrowser.Controller.Entities.' + Type,
  Name: Type, SortName: Type.toLowerCase(), CleanName: Type.toLowerCase(), Data: '{}', Tags: '', Studios: '', Genres: '',
  ProductionLocations: '', MediaType: 'Unknown', UnratedType: 'Other', IsFolder: Type !== 'Movie', ...values });
async function fixture(t) {
  const schema = 'dynamic_view_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const store = new DomainStore(database);
  const directory = await mkdtemp(path.join(tmpdir(), 'mm-dynamic-view-'));
  const errors = [], contexts = [], spoolRoot = path.join(directory, 'metadata-spool');
  const linkedChildren = await openMetadataRelations(database, spoolRoot);
  const library = new LibraryService({fileSystem: testFileSystem,  store, linkedChildren, serverId: 'dynamic-test', programDataPath: directory, configuration: {}, onError: error => errors.push(error) });
  const loadContext = trackMetadataContexts(library.userViews.metadata.loadContext, contexts);
  library.userViews.metadata.loadContext = loadContext;
  const itemCreation = attachMetadataItemCreation({ store, library, linkedChildren, loadContext });
  t.after(async () => { try {
    const failures = [];
    for (const close of [() => library.close(), ...contexts.map(loader => () => loader.close()),
      () => itemCreation.close(), () => linkedChildren.flushReleases(), () => linkedChildren.close(), () => store.close()]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'User view dynamic fixture ownership cleanup failed.');
  } finally {
    let databaseClosed = false;
    try { await database.rows('BaseItems', { limit: 1 }); }
    catch (error) { databaseClosed = ['database is not open', 'Client was closed and is not queryable'].includes(error.message); }
    assert.equal(databaseClosed, true);
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(directory).startsWith('mm-dynamic-view-'));
    await rm(directory, { recursive: true, force: false });
    await assert.rejects(stat(directory), error => error.code === 'ENOENT');
    const client = new pg.Client({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES });
    try { await client.connect(); for (const name of [schema, schema + '__mm']) await client.query(`DROP SCHEMA ${quoteIdentifier(name)} CASCADE`);
      assert.equal((await client.query('SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY($1::text[])', [[schema, schema + '__mm']])).rows.length, 0);
    } finally { await client.end(); }
  } });
  await database.insert('BaseItems', item(1, 'AggregateFolder'));
  await database.insert('BaseItems', item(2, 'UserRootFolder'));
  await database.insert('BaseItems', item(3, 'CollectionFolder', { ParentId: id(2), Data: JSON.stringify({ CollectionType: 'movies', PhysicalFolderIds: [id(4)] }) }));
  await database.insert('BaseItems', item(4, 'Folder', { ParentId: id(1), TopParentId: id(4) }));
  const view = item(5, 'UserView', { Data: JSON.stringify({ ViewType: 'movies', DisplayParentId: idKey(id(3)) }) });
  await database.insert('BaseItems', view);
  const user = { Id: id(100), Configuration: {}, Policy: { EnableAllFolders: true, EnabledFolders: [], BlockedMediaFolders: [], BlockedTags: [], AllowedTags: [], BlockUnratedItems: [] } };
  const users = { getUser: async userId => { assert.equal(idKey(userId), idKey(user.Id)); return user; } };
  const provider = createUserViewDynamicImagePlugin({ library, users }).providers[0];
  return { database, library, provider, user, directory, errors, view: { Id: view.Id, Type: 'UserView', ViewType: 'movies', DisplayParentId: id(3) } };
}
test('dynamic images use actual recursive movie/TV queries, including the frozen null-user failure', async t => {
  const { provider, view, database } = await fixture(t);
  for (const ViewType of ['movies', 'tvshows']) {
    await database.update('BaseItems', { Id: view.Id }, { Data: JSON.stringify({ ViewType, DisplayParentId: idKey(id(3)) }) });
    await assert.rejects(provider.fetch({ ...view, ViewType }), error => error.status === 500 && error.message === 'Error processing request.');
    await assert.rejects(provider.hasChanged({ ...view, ViewType }), error => error.status === 500 && error.message === 'Error processing request.');
  }
});
test('real user and playlist empty image sources return None without reporting a refresh failure', async t => {
  const { provider, view, user, database } = await fixture(t);
  assert.equal(await provider.fetch({ ...view, UserId: user.Id }), ItemUpdateType.None);
  assert.equal(await provider.hasChanged({ ...view, UserId: user.Id }), false);
  await database.update('BaseItems', { Id: view.Id }, { Data: JSON.stringify({ ViewType: 'playlists', DisplayParentId: idKey(id(3)) }) });
  assert.equal(await provider.fetch({ ...view, ViewType: 'playlists' }), ItemUpdateType.None);
  assert.equal(await provider.fetch({ ...view, ViewType: 'books' }), ItemUpdateType.None);
});
test('an existing remote or media-side primary image prevents the null-user query and replacement', async t => {
  const { provider, view } = await fixture(t);
  for (const Path of ['https://fixture.invalid/poster.jpg', 'Z:\\MediaLibrary\\poster.jpg']) {
    const images = [{ Type: 'Primary', Path }];
    assert.equal(await provider.fetch(view, { images }), ItemUpdateType.None);
    assert.equal(await provider.hasChanged(view, { images }), false);
  }
});
test('a genuine local source image reaches the explicit unsupported collage path', async t => {
  const { provider, database, view, user } = await fixture(t);
  await database.insert('BaseItems', item(6, 'Movies.Movie', { ParentId: id(4), TopParentId: id(4), IsFolder: false }));
  await database.insert('AncestorIds', { ItemId: id(6), ParentItemId: id(4) });
  await database.insert('BaseItemImageInfos', { Id: id(7), ItemId: id(6), ImageType: 0, Path: 'Z:\\MediaLibrary\\poster.jpg',
    DateModified: '2026-10-01T00:00:00.0000000Z', Width: 960, Height: 540, Blurhash: null });
  assert.equal(await provider.hasChanged({ ...view, UserId: user.Id }), true);
  await assert.rejects(provider.fetch({ ...view, UserId: user.Id }), error => error.status === 501 && error.message === 'UserView image collage creation is not implemented.');
  await database.update('BaseItems', { Id: view.Id }, { Data: JSON.stringify({ ViewType: 'playlists', DisplayParentId: idKey(id(3)) }) });
  await assert.rejects(provider.fetch({ ...view, ViewType: 'playlists' }), error => error.status === 501 && error.message === 'UserView image collage creation is not implemented.');
});
test('a remote image source changes the candidate set but produces no local collage input', async t => {
  const { provider, database, view, user } = await fixture(t);
  await database.insert('BaseItems', item(6, 'Movies.Movie', { ParentId: id(4), TopParentId: id(4), IsFolder: false }));
  await database.insert('AncestorIds', { ItemId: id(6), ParentItemId: id(4) });
  await database.insert('BaseItemImageInfos', { Id: id(7), ItemId: id(6), ImageType: 0, Path: 'https://fixture.invalid/poster.jpg',
    DateModified: '2026-10-01T00:00:00.0000000Z', Width: 960, Height: 540, Blurhash: null });
  assert.equal(await provider.hasChanged({ ...view, UserId: user.Id }), true);
  assert.equal(await provider.fetch({ ...view, UserId: user.Id }), ItemUpdateType.None);
});

for (const dialect of ['postgres']) {
  const options = {};
  test(`${dialect}: missing managed primary images compare against the native minimum file date`, options, async t => {
    const { provider, view, directory } = await fixture(t, dialect);
    const Path = path.join(internalImagePath(view, path.join(directory, 'metadata')), 'missing.jpg');
    const images = [{ Type: 'Primary', Path, DateModified: '2026-10-01T00:00:00.0000000Z' }];
    const signal = AbortSignal.abort(new Error('Native HasChanged has no cancellation token'));
    assert.equal(await provider.hasChanged(view, { images }), native.output[0].changed);
    assert.equal(await provider.hasChanged(view, { images, signal }), native.output[0].changed);
    images[0].DateModified = '0001-01-01T00:00:00.0000000Z';
    assert.equal(await provider.hasChanged(view, { images }), native.output[1].changed);
    assert.equal(await provider.hasChanged(view, { images, signal }), native.output[1].changed);
    assert.equal(dateTicks(native.output[0].date), dateTicks(MIN_DATE));
    assert.equal(dateTicks(native.output[1].date), dateTicks(MIN_DATE));
  });
  test(`${dialect}: dynamic provider cancellation leaves synchronous query outcomes observable`, options, async t => {
    const { provider, view, user, database } = await fixture(t, dialect);
    // BaseItemMapper returns null for an exact discriminator that is no longer
    // loadable; the provider's all-items image lookup skips that record.
    await database.insert('BaseItems', item(999, 'RemovedPlugin.UnknownItem'));
    const signal = AbortSignal.abort(new Error('Controlled cancellation'));
    assert.equal(await provider.fetch({ ...view, UserId: user.Id }, { signal }), ItemUpdateType.None);
    await assert.rejects(provider.fetch(view, { signal }), error => error.status === 500 && error.message === 'Error processing request.');
  });
  test(`${dialect}: actual metadata host serializes real null-user query failures and cancels before persistence`, options, async t => {
    const { database, library, view, user, directory, errors } = await fixture(t, dialect);
    const Path = path.join(directory, 'metadata', 'views', idKey(view.Id));
    await mkdir(Path, { recursive: true });
    await database.update('BaseItems', { Id: view.Id }, { Path });
    library.userViews.metadata.registry.register(createUserViewDynamicImagePlugin({ library, users: { getUser: async () => user } }));
    const before = await database.rows('BaseItems'), beforeRelations = await database.rows('AncestorIds');
    const refreshOptions = { MetadataRefreshMode: 'Default', ImageRefreshMode: 'Default', ForceSave: true };
    const signal = AbortSignal.abort(new Error('Cancel metadata host before query'));
    await assert.rejects(library.userViews.metadata.refresh(view.Id, { ...refreshOptions, signal }), error => error === signal.reason);
    assert.deepEqual(await database.rows('BaseItems'), before);
    assert.deepEqual(await database.rows('AncestorIds'), beforeRelations);
    const query = library.queryItems.bind(library);
    let active = 0, maximumActive = 0, calls = 0;
    library.queryItems = async (...args) => {
      active++; calls++; maximumActive = Math.max(maximumActive, active);
      try { await new Promise(resolve => setImmediate(resolve)); return await query(...args); }
      finally { active--; }
    };
    const [first, second] = await Promise.all([library.userViews.metadata.refresh(view.Id, refreshOptions), library.userViews.metadata.refresh(view.Id, refreshOptions)]);
    assert.equal(calls, 2); assert.equal(maximumActive, 1);
    for (const result of [first, second]) {
      assert.equal(result.Failures, 1); assert.equal(result.ErrorMessage, 'Error processing request.');
      assert.equal(result.Item.DateLastRefreshed, '0001-01-01T00:00:00.0000000Z');
    }
    const failed = (await database.rows('BaseItems', { where: { Id: view.Id } }))[0];
    assert.equal(failed.DateLastRefreshed, null); assert.ok(failed.DateLastSaved);
    assert.equal(failed.PresentationUniqueKey, idKey(view.Id));
    assert.deepEqual(errors.map(error => [error.status, error.message]), [[500, 'Error processing request.'], [500, 'Error processing request.']]);
    assert.deepEqual(await database.rows('AncestorIds'), beforeRelations);
    await database.update('BaseItems', { Id: view.Id }, { Data: JSON.stringify({ ...JSON.parse(failed.Data), UserId: idKey(user.Id) }) });
    // This explicit fixture repository edit is followed by a cold lookup,
    // rather than replacing the still-live null-user entity by ID.
    library.itemCreation.unregisterItem(view.Id);
    await library.options.linkedChildren.flushReleases();
    const recovered = await library.userViews.metadata.refresh(view.Id, refreshOptions);
    assert.equal(recovered.Failures, 0); assert.ok(recovered.Item.DateLastRefreshed);
    assert.ok((await database.rows('BaseItems', { where: { Id: view.Id } }))[0].DateLastRefreshed);
  });
}

test('the frozen dynamic provider controlled query executes before its cancellation-aware save stage', async t => {
  const { provider, library, view } = await fixture(t);
  let QueryCount = 0;
  library.queryItems = async () => { QueryCount++; return { Items: [] }; };
  const signal = AbortSignal.abort(new Error('Controlled cancellation'));
  const updateType = await provider.fetch(view, { signal });
  assert.deepEqual({ name: 'cancelled-empty-query', updateType, QueryCount, collageCalls: 0, saveCalls: 0 }, native.output[2]);
  library.queryItems = async () => { QueryCount++; const failure = new Error(native.output[3].Message); failure.name = native.output[3].error; throw failure; };
  let error;
  try { await provider.fetch(view, { signal }); } catch (failure) { error = failure; }
  assert.deepEqual({ name: 'cancelled-failing-query', error: error?.name, Message: error?.message, QueryCount, collageCalls: 0, saveCalls: 0 }, native.output[3]);
  // The fifth raw native record reaches a controlled collage processor and
  // SaveImage. Candidate real local collage inputs remain explicit 501.
  assert.deepEqual(native.output[4], { name: 'cancelled-local-source', error: 'TaskCanceledException', QueryCount: 3, collageCalls: 1, saveCalls: 1 });
});

const lifecycleReason = reason => reason.split(', ').reduce((result, name) => result | ItemUpdateType[name], 0);
const lifecycleEvents = events => events.filter(event => ['repository-save-attempt', 'custom-fetch', 'custom-fetch-start'].includes(event.kind))
  .map(event => event.kind.startsWith('custom-fetch') ? 'fetch' : lifecycleReason(event.reason));
async function lifecycleFixture(t, dialect) {
  const value = await fixture(t, dialect);
  const Path = path.join(value.directory, 'metadata', 'views', idKey(value.view.Id));
  await mkdir(Path, { recursive: true });
  await value.database.update('BaseItems', { Id: value.view.Id }, { Path });
  return value;
}

for (const dialect of ['postgres']) {
  const options = {};
  for (const failure of ['none', 'error', 'cancel']) test(`${dialect}: first UserView ${failure} saves the native key and MetadataImport before the provider`, options, async t => {
    const { database, library, view } = await lifecycleFixture(t, dialect);
    const events = [];
    library.userViews.metadata.updates.on('ItemUpdated', event => events.push(event.UpdateReason));
    library.userViews.metadata.registry.register({ id: 'lifecycle', name: 'Controlled lifecycle', providers: [{
      id: 'lifecycle', name: 'Controlled lifecycle', kind: 'custom', itemTypes: ['UserView'],
      async fetch(item) {
        events.push('fetch');
        const persisted = (await database.rows('BaseItems', { where: { Id: view.Id } }))[0];
        assert.equal(item.PresentationUniqueKey, idKey(view.Id));
        assert.equal(persisted.PresentationUniqueKey, item.PresentationUniqueKey);
        assert.ok(persisted.DateLastSaved);
        assert.equal(persisted.DateLastRefreshed, null);
        if (failure === 'error') throw new Error('Controlled custom failure');
        if (failure === 'cancel') throw Object.assign(new Error('Controlled custom cancellation'), { name: 'AbortError' });
        return ItemUpdateType.None;
      }
    }] });
    const expected = lifecycle.results.find(value => value.name === `actual-metadata-first-refresh-${failure}`);
    let result;
    if (failure === 'cancel') await assert.rejects(library.userViews.metadata.refresh(view.Id, {
      MetadataRefreshMode: 'Default', ImageRefreshMode: 'None', ForceSave: true
    }), error => error.name === 'AbortError' && error.message === expected.error.Message);
    else {
      result = await library.userViews.metadata.refresh(view.Id, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None', ForceSave: true });
      assert.equal(result.UpdateType, expected.updateType);
      assert.equal(result.Failures, failure === 'error' ? 1 : 0);
    }
    assert.deepEqual(events, lifecycleEvents(expected.events));
    const persisted = (await database.rows('BaseItems', { where: { Id: view.Id } }))[0];
    assert.equal(persisted.PresentationUniqueKey, idKey(view.Id));
    assert.ok(persisted.DateLastSaved);
    assert.equal(Boolean(persisted.DateLastRefreshed), failure === 'none');
  });
  test(`${dialect}: initial refresh rollback preserves its conflict baseline and never calls the provider`, options, async t => {
    const { database, library, view } = await lifecycleFixture(t, dialect);
    const before = await database.rows('BaseItems'), relationships = await database.rows('AncestorIds');
    const loadContext = library.userViews.metadata.loadContext;
    let loaded, baseline;
    library.userViews.metadata.loadContext = async reference => {
      loaded = await loadContext(reference);
      baseline = structuredClone({ snapshot: loaded.snapshot, relationships: loaded.relationships });
      return loaded;
    };
    let calls = 0;
    library.userViews.metadata.registry.register({ id: 'rollback', name: 'Rollback control', providers: [{
      id: 'rollback', name: 'Rollback control', kind: 'custom', itemTypes: ['UserView'],
      fetch() { calls++; return ItemUpdateType.None; }
    }] });
    const persist = database.update.bind(database);
    database.update = async (...args) => {
      const result = await persist(...args);
      if (args[0] === 'BaseItems' && args[1].Id === view.Id) throw new Error('Controlled initial-save failure');
      return result;
    };
    await assert.rejects(library.userViews.metadata.refresh(view.Id, { MetadataRefreshMode: 'Default', ForceSave: true }), /Controlled initial-save failure/);
    database.update = persist;
    assert.equal(calls, 0);
    assert.deepEqual(await database.rows('BaseItems'), before);
    assert.deepEqual(await database.rows('AncestorIds'), relationships);
    assert.deepEqual({ snapshot: loaded.snapshot, relationships: loaded.relationships }, baseline);
    const recovered = await library.userViews.metadata.refresh(view.Id, { MetadataRefreshMode: 'Default', ForceSave: true });
    assert.equal(recovered.Failures, 0);
    assert.equal(calls, 1);
  });
  test(`${dialect}: final refresh save rejects edits made after the initial committed save`, options, async t => {
    const { database, library, view } = await lifecycleFixture(t, dialect);
    const events = [];
    library.userViews.metadata.updates.on('ItemUpdated', event => events.push(event.UpdateReason));
    library.userViews.metadata.registry.register({ id: 'conflict', name: 'Conflict control', providers: [{
      id: 'conflict', name: 'Conflict control', kind: 'custom', itemTypes: ['UserView'],
      async fetch() {
        await database.update('BaseItems', { Id: view.Id }, { Overview: 'Concurrent edit after initial save' });
        return ItemUpdateType.None;
      }
    }] });
    await assert.rejects(library.userViews.metadata.refresh(view.Id, { MetadataRefreshMode: 'Default', ForceSave: true }), error => error.code === 'metadata-conflict');
    assert.deepEqual(events, [ItemUpdateType.MetadataImport]);
    const persisted = (await database.rows('BaseItems', { where: { Id: view.Id } }))[0];
    assert.equal(persisted.Overview, 'Concurrent edit after initial save');
    assert.equal(persisted.PresentationUniqueKey, idKey(view.Id));
    assert.ok(persisted.DateLastSaved);
    assert.equal(persisted.DateLastRefreshed, null);
  });
  for (const scenario of ['all-custom-fail', 'first-cancel-then-success', 'first-success-already-queued']) {
    test(`${dialect}: three serialized refreshes reproduce native ${scenario} provider and save ordering`, options, async t => {
      const { library, view } = await lifecycleFixture(t, dialect);
      const events = [];
      let calls = 0;
      library.userViews.metadata.updates.on('ItemUpdated', event => events.push(event.UpdateReason));
      library.userViews.metadata.registry.register({ id: 'sequence', name: 'Controlled sequence', providers: [{
        id: 'sequence', name: 'Controlled sequence', kind: 'custom', itemTypes: ['UserView'],
        hasChanged: async () => false,
        fetch() {
          calls++; events.push('fetch');
          if (scenario === 'all-custom-fail') throw new Error('Controlled custom failure');
          if (scenario === 'first-cancel-then-success' && calls === 1) throw Object.assign(new Error('Controlled custom cancellation'), { name: 'AbortError' });
          return ItemUpdateType.None;
        }
      }] });
      const results = await Promise.allSettled(Array.from({ length: 3 }, () => library.userViews.metadata.refresh(view.Id, {
        MetadataRefreshMode: 'Default', ImageRefreshMode: 'None', ForceSave: true
      })));
      const expected = lifecycle.results.find(value => value.name === `actual-metadata-queue-${scenario}`);
      assert.deepEqual(events, lifecycleEvents(expected.events));
      assert.equal(calls, expected.events.filter(event => event.kind === 'custom-fetch-start').length);
      assert.equal(results.filter(value => value.status === 'rejected').length, scenario === 'first-cancel-then-success' ? 1 : 0);
      assert.equal(results.filter(value => value.status === 'fulfilled' && value.value.Failures > 0).length, scenario === 'all-custom-fail' ? 3 : 0);
    });
  }
}
