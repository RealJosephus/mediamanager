import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { nativeModel } from '../../src/database/model.js';
import { DirectoryItemResolverPipeline } from '../../src/library/directory-item-resolver.js';
import { FolderValidationService } from '../../src/library/folder-validation-service.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { ItemDeletionService } from '../../src/library/item-deletion-service.js';
import { ResolvedItemLifecycleHost } from '../../src/library/resolved-item-lifecycle.js';
import { ProviderRefreshService } from '../../src/metadata/provider-refresh-service.js';
import { dateText } from '../../src/library/records.js';
import { discoveryFixture } from './video-discovery-fixture.js';
import { readTestLinks } from './collection-test-consumers.js';

async function observedItem(item) {
  return JSON.parse(JSON.stringify({ ...item, LinkedChildren: await readTestLinks(item) },
    (_key, value) => typeof value === 'bigint' ? { bigint: String(value) } : value));
}

const test = (name, options, run) => typeof options === 'function'
  ? nodeTest(name, { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, options)
  : nodeTest(name, { ...options, skip: options?.skip || !process.env.MEDIAMANAGER_TEST_POSTGRES }, run);

const sample = Object.freeze({
  name: 'folder-validation-failure',
  operation: 'resolvepaths',
  expectedType: 'Movie',
  resolverType: 'Movie',
  parseName: true,
  mixed: false,
  collectionType: 'movies',
  entries: ['Film'],
  files: ['Film/Film.mkv'],
  directories: ['Film'],
  ignoreFiles: []
});

async function databaseState(database) {
  return Object.fromEntries(await Promise.all(nativeModel.tables.map(async table => [table.name,
    await database.rows(table.name)])));
}

async function subject(t, { resolvers = [], failList = null } = {}) {
  const value = await discoveryFixture(t, 'postgres', sample, { captureDatabaseDeletes: false });
  const { fixture, loaded, childrenCleared } = value;
  const errors = [];
  const events = [];
  for (const name of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) {
    fixture.library.on(name, event => events.push([name, event.Item.Id]));
  }
  const creator = new ItemCreationService({ ...fixture });
  const linkedChildReferences = { reroute: async () => [] };
  fixture.library.itemCreation = creator;
  creator.registerItem(loaded.parent);
  fixture.library.itemDeletion = new ItemDeletionService({ ...fixture, itemCreation: creator,
    updates: fixture.host.updates, externalData: loaded.videoVersionDiscovery.externalData,
    linkedChildReferences, now: () => fixture.now });
  t.after(() => creator.close());
  const resolverPipeline = new DirectoryItemResolverPipeline({
    resolvers,
    programDataPath: fixture.stateRoot,
    configuration: fixture.configuration,
    onError: error => errors.push(error)
  });
  const vfs = failList == null ? fixture.vfs : Object.assign(Object.create(fixture.vfs), {
    list: async () => { throw failList; }
  });
  fixture.host.updates.library = fixture.library;
  const validation = new FolderValidationService({
    store: fixture.store,
    library: fixture.library,
    itemCreation: creator,
    resolvedItemLifecycle: new ResolvedItemLifecycleHost({ store: fixture.store, loadContext: fixture.loadContext,
      updates: fixture.host.updates, images: fixture.host.images }),
    vfs,
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
    onError: error => errors.push(error)
  });
  return { fixture, loaded, parent: loaded.parent, validation, errors, events, childrenCleared };
}

async function createFolderOwner(context) {
  await context.fixture.database.delete('BaseItems', { Id: context.loaded.item.Id });
  await context.fixture.adapter.delete('/discovery/primary.mkv');
  const result = await context.validation.validateChildren(context.parent, { collectionType: sample.collectionType });
  assert.equal(result.created.length, 1);
  const [owner] = await context.fixture.database.rows('BaseItems', { where: { Id: result.created[0].Id } });
  assert.ok(owner);
  context.events.length = 0;
  return owner;
}

const traversalIds = Object.freeze({
  aggregate: 'fa120000-0000-0000-0000-000000000001',
  series: 'fa120000-0000-0000-0000-000000000002',
  season: 'fa120000-0000-0000-0000-000000000003',
  artist: 'fa120000-0000-0000-0000-000000000004'
});

async function createTraversalParent(context, kind) {
  const [physical] = await context.fixture.database.rows('BaseItems', { where: { Id: context.parent.Id } });
  assert.ok(physical);
  await context.fixture.database.insert('BaseItems', {
    ...physical,
    Id: traversalIds.aggregate,
    Type: 'MediaBrowser.Controller.Entities.AggregateFolder',
    Name: 'Aggregate',
    CleanName: 'aggregate',
    SortName: 'aggregate',
    Path: null,
    ParentId: null,
    TopParentId: null
  });
  await context.fixture.database.update('BaseItems', { Id: physical.Id }, {
    ParentId: traversalIds.aggregate,
    TopParentId: physical.Id
  });
  const seriesPath = path.join(context.parent.Path, 'Shows');
  const seasonPath = path.join(seriesPath, 'Season 1');
  const artistPath = path.join(context.parent.Path, 'Artist');
  const rows = [
    {
      Id: traversalIds.series,
      Type: 'MediaBrowser.Controller.Entities.TV.Series',
      Name: 'Shows',
      Path: seriesPath,
      ParentId: physical.Id
    },
    {
      Id: traversalIds.season,
      Type: 'MediaBrowser.Controller.Entities.TV.Season',
      Name: 'Season 1',
      Path: seasonPath,
      ParentId: traversalIds.series
    },
    {
      Id: traversalIds.artist,
      Type: 'MediaBrowser.Controller.Entities.Audio.MusicArtist',
      Name: 'Artist',
      Path: artistPath,
      ParentId: physical.Id
    }
  ];
  for (const row of rows) await context.fixture.database.insert('BaseItems', {
    ...physical,
    ...row,
    CleanName: row.Name.toLowerCase(),
    SortName: row.Name.toLowerCase(),
    TopParentId: physical.Id
  });
  await context.fixture.adapter.mkdir('/discovery/Shows');
  await context.fixture.adapter.mkdir('/discovery/Shows/Season 1');
  await context.fixture.adapter.mkdir('/discovery/Artist');
  const selected = rows.find(row => row.Type.endsWith(`.${kind}`));
  return {
    request: await context.fixture.library.getItemRecord(selected.Id),
    physicalId: physical.Id,
    immediateParentId: selected.ParentId
  };
}

for (const [name, setup] of [
  ['directory enumeration', failure => ({ failList: failure })],
  ['multi resolver', failure => ({ resolvers: [{
    id: 'failing-multi',
    nativeTypes: { 'MediaBrowser.Controller.Entities.Movies.Movie': { isFolder: false } },
    resolveMultiple() { throw failure; }
  }] })]
]) test(`Folder validation reports ${name} failure without reconciling`, async t => {
  const failure = new Error(`controlled ${name} failure`);
  const context = await subject(t, setup(failure));
  const before = await databaseState(context.fixture.database);

  await context.validation.validateChildren(context.parent, { collectionType: sample.collectionType });

  assert.deepEqual(context.errors, [failure]);
  assert.deepEqual(context.events, []);
  assert.deepEqual(await databaseState(context.fixture.database), before);
  assert.equal(context.childrenCleared(), true);
  assert.deepEqual(context.parent.UserData, []);
});

test('Folder validation propagates cancellation without reporting or reconciling', async t => {
  const context = await subject(t);
  const before = await databaseState(context.fixture.database);
  const controller = new AbortController();
  const reason = new Error('controlled validation cancellation');
  controller.abort(reason);

  await assert.rejects(context.validation.validateChildren(context.parent, {
    collectionType: sample.collectionType,
    signal: controller.signal
  }), error => error === reason);

  assert.deepEqual(context.errors, []);
  assert.deepEqual(context.events, []);
  assert.deepEqual(await databaseState(context.fixture.database), before);
  assert.equal(context.childrenCleared(), true);
  assert.deepEqual(context.parent.UserData, []);
});

test('Folder validation preserves a custom cancellation reason raised during resolution', async t => {
  const controller = new AbortController();
  const reason = new Error('controlled during-resolution cancellation');
  let entered = false;
  const context = await subject(t, { resolvers: [{
    id: 'cancel-during-multi',
    nativeTypes: { 'MediaBrowser.Controller.Entities.Movies.Movie': { isFolder: false } },
    resolveMultiple() {
      entered = true;
      controller.abort(reason);
      return null;
    }
  }] });
  const before = await databaseState(context.fixture.database);

  await assert.rejects(context.validation.validateChildren(context.parent, {
    collectionType: sample.collectionType,
    signal: controller.signal
  }), error => error === reason);

  assert.equal(entered, true);
  assert.deepEqual(context.errors, []);
  assert.deepEqual(context.events, []);
  assert.deepEqual(await databaseState(context.fixture.database), before);
  assert.equal(context.childrenCleared(), true);
  assert.deepEqual(context.parent.UserData, []);
});

test('Folder validation treats forged cancellation and invariant fields as ordinary resolution failures', async t => {
  const failures = [
    ['AbortError name', Object.assign(new Error('forged abort name'), { name: 'AbortError' })],
    ['cancelled code', Object.assign(new Error('forged cancelled code'), { code: 'cancelled' })],
    ['invariant details', Object.assign(new Error('forged invariant details'), {
      details: Object.freeze({ resolverPipelineInvariant: true })
    })],
    ['hostile error getters', (() => {
      const error = new Error('hostile resolution error');
      for (const field of ['name', 'code', 'details']) Object.defineProperty(error, field, {
        configurable: true,
        get() { throw new Error(`resolution error ${field} must not be inspected`); }
      });
      return error;
    })()]
  ];

  for (const [name, failure] of failures) await t.test(name, async subtest => {
    const context = await subject(subtest, { resolvers: [{
      id: 'forged-multi-failure',
      nativeTypes: { 'MediaBrowser.Controller.Entities.Movies.Movie': { isFolder: false } },
      resolveMultiple() { throw failure; }
    }] });
    const before = await databaseState(context.fixture.database);

    const result = await context.validation.validateChildren(context.parent, { collectionType: sample.collectionType });

    assert.equal(result.skipped, true);
    assert.deepEqual(result.created, []);
    assert.deepEqual(result.resolved, []);
    assert.equal(context.errors.length, 1);
    assert.equal(context.errors[0], failure);
    assert.deepEqual(context.events, []);
    assert.deepEqual(await databaseState(context.fixture.database), before);
    assert.equal(context.childrenCleared(), true);
    assert.deepEqual(context.parent.UserData, []);
  });
});

test('Folder validation derives production collection context and preserves explicit unknown type', async t => {
  const observed = [];
  const failure = new Error('stop after observing the production collection context');
  const context = await subject(t, { resolvers: [{
    id: 'observe-collection',
    nativeTypes: { 'MediaBrowser.Controller.Entities.Movies.Movie': { isFolder: false } },
    resolveMultiple({ collectionContext }) { observed.push(collectionContext); throw failure; }
  }] });
  context.fixture.configuration.ContentTypes = [{ Name: context.parent.Path, Value: 'homevideos' }];
  const before = await databaseState(context.fixture.database);

  await context.validation.validateChildren(context.parent);
  await context.validation.validateChildren(context.parent, { collectionType: null });

  assert.equal(observed.length, 2);
  assert.equal(observed[0].collectionType, 'homevideos');
  assert.equal(observed[0].collectionTypeSource, 'content-type-override');
  assert.equal(observed[0].rootPath, context.parent.Path);
  assert.equal(observed[1].collectionType, null);
  assert.deepEqual(context.errors, [failure, failure]);
  assert.deepEqual(context.events, []);
  assert.deepEqual(await databaseState(context.fixture.database), before);
});

for (const [kind, collectionType] of [
  ['Series', 'tvshows'],
  ['Season', 'tvshows'],
  ['MusicArtist', 'music']
]) test(`Folder validation resolves ${kind} children against the physical library root`, async t => {
  const observed = [];
  const failure = new Error(`stop after observing ${kind} traversal context`);
  const context = await subject(t, { resolvers: [{
    id: `observe-${kind.toLowerCase()}-traversal`,
    nativeTypes: { 'MediaBrowser.Controller.Entities.Movies.Movie': { isFolder: false } },
    resolveMultiple(value) {
      observed.push(value);
      throw failure;
    }
  }] });
  const { request, physicalId, immediateParentId } = await createTraversalParent(context, kind);
  request.UserData = [];
  const liveBefore = await observedItem(request);
  const before = await databaseState(context.fixture.database);

  const result = await context.validation.validateChildren(request, { collectionType });

  assert.equal(result.skipped, true);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].parent.Id, request.Id);
  assert.equal(observed[0].root.Id, physicalId);
  assert.notEqual(observed[0].root.Id, request.Id);
  assert.equal(observed[0].collectionContext.rootId, request.Id);
  assert.equal(observed[0].collectionContext.rootPath, request.Path);
  assert.equal(observed[0].collectionContext.rootItem.Id, request.Id);
  assert.equal(observed[0].collectionContext.parents[0].Id, immediateParentId);
  assert.equal(observed[0].collectionContext.collectionType, collectionType);
  assert.deepEqual(context.errors, [failure]);
  assert.deepEqual(context.events, []);
  assert.deepEqual(await databaseState(context.fixture.database), before);
  assert.deepEqual(await observedItem(request), liveBefore);
});

test('Folder validation rejects a withheld partial sibling batch before any persistence', async t => {
  let supported = 0, withheld = 0;
  const movieType = 'MediaBrowser.Controller.Entities.Movies.Movie';
  const context = await subject(t, { resolvers: [{
    id: 'partial-sibling-resolution',
    nativeTypes: { [movieType]: { isFolder: false } },
    resolveFile({ candidate }) {
      supported++;
      return { nativeType: movieType, primary: candidate, consumedPaths: [candidate], draft: {
        Name: 'Supported', IsFolder: false, MediaType: 'Video', SourceType: 'Library'
      } };
    },
    resolveDirectory() {
      withheld++;
      return { withhold: true };
    }
  }] });
  await context.fixture.database.delete('BaseItems', { Id: context.loaded.item.Id });
  const before = await databaseState(context.fixture.database);
  const liveBefore = await observedItem(context.parent);

  await assert.rejects(context.validation.validateChildren(context.parent, {
    collectionType: sample.collectionType
  }), {
    code: 'not-supported',
    message: 'Folder validation cannot persist a partial sibling batch with withheld paths.'
  });

  assert.equal(supported, 1);
  assert.equal(withheld, 1);
  assert.deepEqual(context.errors, []);
  assert.deepEqual(context.events, []);
  assert.deepEqual(await databaseState(context.fixture.database), before);
  assert.deepEqual(await observedItem(context.parent), liveBefore);
  assert.equal(context.childrenCleared(), true);
});

for (const [field, value] of [
  ['IsInMixedFolder', true],
  ['AdditionalParts', ['unpersisted-part.mkv']],
  ['LocalAlternateVersions', ['unpersisted-alternate.mkv']],
  ['VideoType', 'Dvd']
]) test(`Folder validation saves existing ${field} changes before creating new siblings`, async t => {
  const movieType = 'MediaBrowser.Controller.Entities.Movies.Movie';
  const context = await subject(t, { resolvers: [{
    id: 'controlled-structural-child',
    nativeTypes: { [movieType]: { isFolder: false } },
    resolveDirectory({ candidate }) {
      return { nativeType: movieType, primary: candidate, consumedPaths: [candidate], draft: {
        Name: 'Film', IsFolder: false, MediaType: 'Video',
        data: {}
      } };
    }
  }] });
  await context.fixture.database.delete('BaseItems', { Id: context.loaded.item.Id });
  await context.fixture.adapter.delete('/discovery/primary.mkv');
  await context.validation.validateChildren(context.parent, { collectionType: 'movies' });
  const original = await context.fixture.library.itemCreation.getItemById(context.events[0][1]);
  original[field] = value;
  original.Name = 'Curated title';
  original.Overview = 'Preserved overview';
  await context.fixture.library.itemCreation.saveItems([original]);
  await context.fixture.adapter.mkdir('/discovery/NewSibling');
  context.events.length = 0;

  const result = await context.validation.validateChildren(context.parent, { collectionType: 'movies' });
  assert.equal(result.created.length, 1);
  const updated = await context.fixture.library.itemCreation.getItemById(original.Id);
  assert.deepEqual(updated[field], field === 'IsInMixedFolder' ? false : field === 'VideoType' ? 'VideoFile' : []);
  assert.equal(updated.Name, 'Curated title');
  assert.equal(updated.Overview, 'Preserved overview');
  const [row] = await context.fixture.database.rows('BaseItems', { where: { Id: original.Id } });
  assert.equal(row.Name, 'Curated title');
  assert.equal(row.Overview, 'Preserved overview');
  assert.equal(dateText(row.DateLastSaved), dateText(context.fixture.now));
  if (field === 'IsInMixedFolder') assert.equal(row.IsInMixedFolder, false);
  else assert.deepEqual(JSON.parse(row.Data)[field], updated[field]);

  assert.deepEqual(context.errors, []);
  assert.deepEqual(context.events, [['ItemUpdated', original.Id], ['ItemAdded', result.created[0].Id]]);
  assert.equal(context.childrenCleared(), true);
  assert.equal(context.parent.UserData, null);
});

test('Folder validation excludes direct owned non-extra and parentless alternate rows from current children', async t => {
  const context = await subject(t);
  const owner = await createFolderOwner(context);
  await context.fixture.database.insert('BaseItems', {
    ...owner,
    Id: 'fa110000-0000-0000-0000-000000000001',
    Name: 'Owned non-extra',
    Path: path.join(context.parent.Path, 'owned-part.mkv'),
    ParentId: context.parent.Id,
    OwnerId: owner.Id,
    PrimaryVersionId: null,
    ExtraType: null
  });
  await context.fixture.database.insert('BaseItems', {
    ...owner,
    Id: 'fa110000-0000-0000-0000-000000000002',
    Name: 'Parentless alternate',
    Path: path.join(context.parent.Path, 'alternate.mkv'),
    ParentId: null,
    OwnerId: owner.Id,
    PrimaryVersionId: owner.Id,
    ExtraType: null
  });
  const before = await databaseState(context.fixture.database);

  const result = await context.validation.validateChildren(context.parent, { collectionType: sample.collectionType });

  assert.deepEqual(result.created, []);
  assert.equal(result.resolved.length, 1);
  assert.deepEqual(context.errors, []);
  assert.deepEqual(context.events, []);
  assert.deepEqual(await databaseState(context.fixture.database), before);
});

for (const [name, values] of [
  ['direct owned extra', { OwnerId: 'owner', PrimaryVersionId: null, ExtraType: 1 }],
  ['direct alternate included by validation', { OwnerId: null, PrimaryVersionId: 'owner', ExtraType: null }]
]) test(`Folder validation includes and removes stale ${name}`, async t => {
  const context = await subject(t);
  const owner = await createFolderOwner(context);
  const replaceOwner = value => value === 'owner' ? owner.Id : value;
  const staleId = name === 'direct owned extra' ? 'fa110000-0000-0000-0000-000000000003'
    : 'fa110000-0000-0000-0000-000000000004';
  await context.fixture.database.insert('BaseItems', {
    ...owner,
    Id: staleId,
    Name: name,
    Path: path.join(context.parent.Path, `${name}.mkv`),
    ParentId: context.parent.Id,
    OwnerId: replaceOwner(values.OwnerId),
    PrimaryVersionId: replaceOwner(values.PrimaryVersionId),
    ExtraType: values.ExtraType
  });
  const before = await context.fixture.database.rows('BaseItems');

  const result = await context.validation.validateChildren(context.parent, {
    collectionType: sample.collectionType
  });

  assert.deepEqual(context.errors, []);
  assert.deepEqual(result.created, []);
  assert.deepEqual(context.events, [['ItemRemoved', staleId]]);
  assert.deepEqual(await context.fixture.database.rows('BaseItems'), before.filter(row => row.Id !== staleId));
  assert.equal(context.childrenCleared(), true);
  assert.equal(context.parent.UserData, null);
  assert.equal((await context.fixture.adapter.stat('/discovery/Film/Film.mkv')).kind, 'file');
});
