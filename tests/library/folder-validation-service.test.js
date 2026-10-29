import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fstatSync } from 'node:fs';
import { inspect } from 'node:util';
import { nativeModel, quoteIdentifier } from '../../src/database/model.js';
import { DirectoryItemResolverPipeline } from '../../src/library/directory-item-resolver.js';
import { FolderValidationService } from '../../src/library/folder-validation-service.js';
import { LibraryTaskScheduler } from '../../src/library/library-task-scheduler.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { ItemDeletionService } from '../../src/library/item-deletion-service.js';
import { ResolvedItemLifecycleHost } from '../../src/library/resolved-item-lifecycle.js';
import { ProviderRefreshService } from '../../src/metadata/provider-refresh-service.js';
import { dateText, idKey } from '../../src/library/records.js';
import { discoveryFixture } from './video-discovery-fixture.js';
import { readTestLinks } from './collection-test-consumers.js';
import { testFileSystem } from '../storage/plugin-files.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

async function observedItem(item) {
  return JSON.parse(JSON.stringify({ ...item, LinkedChildren: await readTestLinks(item) },
    (_key, value) => typeof value === 'bigint' ? { bigint: String(value) } : value));
}

const test = (name, options, run) => {
  const callbackOnly = typeof options === 'function';
  const settings = callbackOnly ? {} : options;
  return nodeTest(name, { ...settings, skip: settings?.skip || !process.env.MEDIAMANAGER_TEST_POSTGRES },
    callbackOnly ? options : run);
};

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
  let enumerationFailed = false;
  t.after(() => {
    const options = { depth: null, maxArrayLength: null, maxStringLength: null, getters: false, customInspect: false };
    try { t.diagnostic(inspect({ diagnostics: errors }, options)); }
    catch (inspectionFailure) {
      const diagnostics = errors.map(error => {
        if (error === null || typeof error !== 'object') return error;
        return Object.fromEntries(Object.getOwnPropertyNames(error).map(key => {
          try { return [key, Object.getOwnPropertyDescriptor(error, key)]; }
          catch (failure) { return [key, { unavailable: failure.message }]; }
        }));
      });
      t.diagnostic(inspect({ diagnostics, inspectionFailure: inspectionFailure.message }, options));
    }
  });
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
    list: async (...args) => { await fixture.vfs.list(...args); enumerationFailed = true; throw failList; }
  });
  fixture.host.updates.library = fixture.library;
  const validation = new FolderValidationService({
    scheduler: new LibraryTaskScheduler({ configuration: fixture.configuration }),
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
  return { fixture, loaded, parent: loaded.parent, validation, errors, events, childrenCleared, enumerationFailed: () => enumerationFailed };
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
  ['multi resolver', (failure, entered) => ({ resolvers: [{
    id: 'failing-multi',
    nativeTypes: { 'MediaBrowser.Controller.Entities.Movies.Movie': { isFolder: false } },
    resolveMultiple() { entered(); throw failure; }
  }] })]
]) test(`Folder validation reports ${name} failure without reconciling`, async t => {
  const failure = new Error(`controlled ${name} failure`);
  let entered = false;
  const context = await subject(t, setup(failure, () => { entered = true; }));
  const before = await databaseState(context.fixture.database);

  await context.validation.validateChildren(context.parent, { collectionType: sample.collectionType });

  assert.equal(name === 'directory enumeration' ? context.enumerationFailed() : entered, true);
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
  }), { message: reason.message });
  assert.equal(controller.signal.aborted, true);

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
  }), { message: reason.message });
  assert.equal(controller.signal.aborted, true);

  assert.equal(entered, true);
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
    let entered = false;
    const context = await subject(subtest, { resolvers: [{
      id: 'forged-multi-failure',
      nativeTypes: { 'MediaBrowser.Controller.Entities.Movies.Movie': { isFolder: false } },
      resolveMultiple() { entered = true; throw failure; }
    }] });
    const before = await databaseState(context.fixture.database);

    const result = await context.validation.validateChildren(context.parent, { collectionType: sample.collectionType });

    assert.equal(result.skipped, true);
    assert.deepEqual(result.created, []);
    assert.deepEqual(result.resolved, []);
    assert.equal(entered, true);
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

  assert.deepEqual(result.created, []);
  assert.deepEqual(context.events, [['ItemRemoved', staleId]]);
  assert.deepEqual(await context.fixture.database.rows('BaseItems'), before.filter(row => row.Id !== staleId));
  assert.equal(context.childrenCleared(), true);
  assert.equal(context.parent.UserData, null);
  assert.equal((await context.fixture.adapter.stat('/discovery/Film/Film.mkv')).kind, 'file');
});

const rawInspection = value => inspect(value, { depth: null, maxArrayLength: null, maxStringLength: null });
const functionalError = value => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(functionalError);
  return Object.fromEntries(Object.getOwnPropertyNames(value)
    .filter(key => !(value instanceof Error && ['name', 'stack'].includes(key)))
    .map(key => [key, functionalError(value[key])]));
};
const ownCause = value => value !== null && typeof value === 'object' && Object.hasOwn(value, 'cause');
const failureObservation = reason => ({ type: typeof reason, ownCause: ownCause(reason),
  functional: functionalError(reason), raw: rawInspection(reason) });
const fileObservation = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') });
const json = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? JSON.rawJSON(String(entry)) : entry, 2) + '\n';
async function outcome(operation) {
  try { return { failed: false, value: await operation() }; }
  catch (reason) { return { failed: true, reason }; }
}
async function orderedDatabaseState(database) {
  const value = await databaseState(database);
  for (const table of nativeModel.tables) value[table.name].sort((left, right) => {
    for (const key of table.primaryKey) {
      const a = String(left[key]), b = String(right[key]); if (a < b) return -1; if (a > b) return 1;
    }
    return 0;
  });
  return value;
}

test('Folder validation retains real repository and Local prefixes across falsy operation and ordered owner cleanup failures', async t => {
  const directory = path.join(validationOutputRoot(), 'folder-validation-failures-' + randomUUID());
  await mkdir(directory, { recursive: true });
  const reasons = [['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined],
    ['structured-error', Object.assign(new Error('Repository operation rejected.', {
      cause: { name: 'Business cause', stack: 'Retained business stack', value: undefined },
    }), { code: 'repository-failure', status: 409, statusCode: 422,
      errors: [false, 0, '', null, undefined, new Error('Nested failure.', { cause: undefined })] })],
    ['business-object', { name: 'Business rejection', stack: 'Retained business stack', message: 'Business operation rejected.',
      code: 0, status: 422, statusCode: 409, cause: undefined, errors: [false, 0, '', null, undefined] }]];
  const movieType = 'MediaBrowser.Controller.Entities.Movies.Movie';
  const temporaryObjectsSql = 'SELECT oid::text,relname,relkind FROM pg_class WHERE relnamespace=pg_my_temp_schema() ORDER BY oid';
  for (const [label, reason] of reasons) await t.test(label, async subtest => {
    const context = await subject(subtest, { resolvers: [{ id: 'prefix-movie', nativeTypes: { [movieType]: { isFolder: false } },
      resolveDirectory({ candidate }) { return { nativeType: movieType, primary: candidate, consumedPaths: [candidate],
        draft: { Name: 'Film', IsFolder: false, MediaType: 'Video', data: {} } }; } }] });
    const { database, library, linkedChildren } = context.fixture;
    const ownerScopesSql = `SELECT scope_id::text AS id FROM ${quoteIdentifier(linkedChildren.schemaName)}.item_states
      UNION SELECT scope_id::text AS id FROM ${quoteIdentifier(linkedChildren.schemaName)}.item_cohorts ORDER BY id`;
    const row = await createFolderOwner(context), creator = library.itemCreation;
    const source = path.join(context.fixture.stateRoot, 'operation-source.bin');
    const witness = path.join(context.fixture.stateRoot, 'metadata-prefix.bin');
    const original = Buffer.from('Original Local source bytes\0資料 survive failed validation.\n');
    await testFileSystem.writeFile(source, original);
    const report = { schemaVersion: 1, scope: label, expected: failureObservation(reason), cases: [], comparisonsCompleted: false,
      consumer: 'Folder validation component errors and SQL reconciliation ownership; HTTP is not exercised.',
      serialization: 'JSON omits own undefined fields and converts undefined array entries to null; original reason, own cause presence and ordered errors are compared in process. Raw inspections retain undefined.',
      actualPostgres: true, actualLocal: true, actualNativeExecuted: false, phaseAcceptance: false, releaseAcceptance: false };
    const publishReport = async () => {
      await writeFile(path.join(directory, label + '.json'), json(report), { flag: 'wx' });
      await writeFile(path.join(directory, label + '.txt'), rawInspection(report) + '\n', { flag: 'wx' });
      subtest.diagnostic(json({ report: path.join(directory, label + '.json') }));
    };
    let comparisonFailed = false, comparisonFailure;
    try {
      const readMedia = async () => {
        const handle = await context.fixture.vfs.openRead('/discovery-write/discovery/Film/Film.mkv');
        try { const chunks = []; for await (const chunk of handle.stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }
        finally { await handle.close(); }
      };
      const media = await readMedia(); report.original = { local: fileObservation(await testFileSystem.readFile(source)), media: fileObservation(media) };
      for (const stage of ['repository', 'child-metadata']) for (const cleanup of [false, true]) {
        const record = { stage, cleanup }; report.cases.push(record);
        const current = await creator.getItemById(row.Id);
        current.IsInMixedFolder = true; current.Name = 'Curated title'; current.Overview = 'Curated overview';
        await creator.saveItems([current]);
        record.before = await orderedDatabaseState(database);
        record.ownerScopesBefore = (await database.client.query(ownerScopesSql)).rows;
        record.beforeEvents = structuredClone(context.events); context.events.length = 0;
        const load = library.load, apply = context.validation.resolvedItemLifecycle.apply;
        const scan = context.validation.metadataScanner.refreshAccessibleChildren;
        const flush = linkedChildren.flushReleases;
        const flushFailure = Object.assign(new Error('Cleanup after the actual release flush.'), {
          code: 'release-flush', status: 507, statusCode: 503, cause: 0, errors: [undefined, 'released'] });
        let captured = false, resource, ownerFault = false, flushFault = false, dropFault = false, scopeQuery;
        const releaseFile = async owner => {
          if (!resource || resource.closed) return;
          await resource.file.close();
          // Observe this descriptor immediately, before another actual open can reuse it.
          let failure; try { fstatSync(resource.fd); } catch (error) { failure = error; }
          resource.closed = true;
          const observation = failureObservation(failure);
          if (owner) record.ownerFileRelease = observation; else record.fixtureFileRelease = observation;
          assert.equal(failure?.code, 'EBADF');
        };
        library.load = async (...args) => {
          const state = await Reflect.apply(load, library, args);
          if (!captured) {
            captured = true; const dispose = state.dispose.bind(state);
            state.dispose = async (...options) => {
              const failures = [];
              try { await dispose(...options); } catch (error) { failures.push(error); }
              try { await releaseFile(true); } catch (error) { failures.push(error); }
              if (failures.length) throw new AggregateError(failures, 'Fixture state release failed.', { cause: failures[0] });
              if (ownerFault) { ownerFault = false; flushFault = true; throw 0; }
            };
          }
          return state;
        };
        linkedChildren.flushReleases = async (...args) => {
          const result = await Reflect.apply(flush, linkedChildren, args);
          if (flushFault) { flushFault = false; record.completedFlushFailure = failureObservation(flushFailure); throw flushFailure; }
          return result;
        };
        const rejectAfterWork = async () => {
          const sourceBytes = await testFileSystem.readFile(source);
          assert.deepEqual(sourceBytes, original);
          const prefix = Buffer.concat([sourceBytes, Buffer.from(stage + '/' + cleanup + '/' + label + '\n')]);
          await testFileSystem.writeFile(witness, prefix);
          resource = { file: await testFileSystem.open(witness, 'r'), closed: false };
          resource.fd = resource.file.fd;
          assert.equal(fstatSync(resource.fd).isFile(), true);
          const actual = await resource.file.readFile(); assert.deepEqual(actual, prefix);
          record.local = { source: fileObservation(sourceBytes), prefix: fileObservation(actual), fd: resource.fd };
          await writeFile(path.join(directory, label + '-' + stage + '-' + cleanup + '.bin'), actual, { flag: 'wx' });
          record.prefix = await orderedDatabaseState(database); record.events = structuredClone(context.events);
          record.ownedScopes = (await database.client.query(ownerScopesSql)).rows.filter(value => !record.ownerScopesBefore.some(previous => previous.id === value.id));
          const saved = record.prefix.BaseItems.find(value => idKey(value.Id) === idKey(row.Id));
          assert.equal(saved.IsInMixedFolder, false); assert.equal(saved.Name, 'Curated title'); assert.equal(saved.Overview, 'Curated overview');
          for (const table of nativeModel.tables) if (table.name !== 'BaseItems') assert.deepEqual(record.prefix[table.name], record.before[table.name]);
          assert.deepEqual(record.prefix.BaseItems.filter(value => idKey(value.Id) !== idKey(row.Id)), record.before.BaseItems.filter(value => idKey(value.Id) !== idKey(row.Id)));
          if (stage === 'repository') {
            const session = database.operationContext.getStore();
            if (!session) throw new Error('The repository rejection requires its actual PostgreSQL operation owner.');
            const query = session.client.query;
            record.temporaryObjects = (await Reflect.apply(query, session.client, [temporaryObjectsSql])).rows;
            const tables = record.temporaryObjects.filter(value => value.relkind === 'r');
            assert.ok(tables.length > 0);
            record.backend = (await Reflect.apply(query, session.client, [
              'SELECT pid,extract(epoch FROM backend_start)::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()',
            ])).rows[0];
            if (cleanup) {
              scopeQuery = { session, query }; dropFault = true;
              session.client.query = async (...args) => {
                const result = await Reflect.apply(query, session.client, args);
                if (dropFault && typeof args[0] === 'string' && args[0].startsWith('DROP TABLE IF EXISTS ')
                  && tables.every(value => args[0].includes(quoteIdentifier(value.relname)))) {
                  const remaining = (await Reflect.apply(query, session.client, [
                    'SELECT oid::text,relname FROM pg_class WHERE oid=ANY($1::oid[]) ORDER BY oid',
                    [record.temporaryObjects.map(value => value.oid)],
                  ])).rows;
                  const backend = (await Reflect.apply(query, session.client, [
                    'SELECT pid,extract(epoch FROM backend_start)::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()',
                  ])).rows[0];
                  record.scopeRelease = { statement: args[0], backend, tables, remaining };
                  assert.deepEqual(backend, record.backend);
                  assert.deepEqual(remaining, []);
                  dropFault = false;
                  // Reject only after this real operation owner has dropped its
                  // observed objects; relation-pool cleanup cannot consume it.
                  throw 0;
                }
                return result;
              };
            }
          } else ownerFault = cleanup;
          throw reason;
        };
        context.validation.resolvedItemLifecycle.apply = async (...args) => {
          const result = await Reflect.apply(apply, context.validation.resolvedItemLifecycle, args);
          record.repositoryResult = result;
          if (stage === 'repository') await rejectAfterWork();
          return result;
        };
        context.validation.metadataScanner.refreshAccessibleChildren = async (...args) => {
          await Reflect.apply(scan, context.validation.metadataScanner, args);
          const children = [];
          for await (const page of args[0].pages()) for (const child of page) children.push({ Id: child.Id, Path: child.Path, Name: child.Name });
          record.children = children; assert.ok(children.some(value => idKey(value.Id) === idKey(row.Id)));
          await rejectAfterWork();
        };
        let actual;
        try {
          actual = await outcome(() => context.validation.validateChildren(context.parent, { collectionType: 'movies' }));
          record.outcome = { failed: actual.failed, reason: failureObservation(actual.reason) };
        } finally {
          library.load = load; context.validation.resolvedItemLifecycle.apply = apply;
          context.validation.metadataScanner.refreshAccessibleChildren = scan;
          if (scopeQuery) scopeQuery.session.client.query = scopeQuery.query;
          linkedChildren.flushReleases = flush;
          await releaseFile(false);
        }
        assert.equal(actual.failed, true);
        assert.equal(record.repositoryResult.changed, true);
        assert.equal(record.ownerFileRelease?.functional?.code, 'EBADF', 'The operation owner closes the real Local handle before fixture fallback.');
        const closedRead = await outcome(() => resource.file.stat());
        record.closedLocalRead = { failed: closedRead.failed, reason: failureObservation(closedRead.reason) };
        assert.equal(closedRead.failed, true); assert.equal(closedRead.reason.code, 'closed');
        if (cleanup) {
          assert.equal(ownCause(actual.reason), true);
          assert.deepEqual(functionalError(actual.reason.cause), functionalError(reason));
          assert.deepEqual(functionalError(actual.reason.errors), [reason, 0, ...(stage === 'child-metadata' ? [flushFailure] : [])].map(functionalError));
          assert.equal(actual.reason.message, stage === 'repository' ? reason?.message ?? 'Folder validation ownership cleanup failed.' : 'Folder validation ownership cleanup failed.');
          for (const key of ['code', 'status', 'statusCode']) {
            assert.equal(actual.reason[key], reason?.[key]);
            assert.equal(Object.hasOwn(actual.reason, key), reason?.[key] !== undefined);
          }
          if (stage === 'repository') {
            assert.deepEqual(record.scopeRelease.remaining, []);
            record.afterBackend = (await database.client.query('SELECT pid,extract(epoch FROM backend_start)::text AS started FROM pg_stat_activity WHERE pid=$1', [record.backend.pid])).rows;
            assert.equal(record.afterBackend.some(value => value.started === record.backend.started), false);
          }
        } else {
          assert.equal(typeof actual.reason, typeof reason); assert.equal(ownCause(actual.reason), ownCause(reason));
          assert.deepEqual(functionalError(actual.reason), functionalError(reason));
        }
        record.after = await orderedDatabaseState(database); assert.deepEqual(record.after, record.prefix);
        record.remainingScopes = (await database.client.query(ownerScopesSql)).rows.filter(value => record.ownedScopes.some(previous => previous.id === value.id));
        assert.deepEqual(record.remainingScopes, [], 'Each actually observed operation relation is released before fixture cleanup.');
        assert.deepEqual(context.events, record.events);
        assert.deepEqual(await testFileSystem.readFile(source), original);
        assert.deepEqual(await testFileSystem.readFile(witness), Buffer.from(record.local.prefix.base64, 'base64'));
        assert.deepEqual(await readMedia(), media);
        const restored = await context.validation.validateChildren(context.parent, { collectionType: 'movies' });
        record.recovery = { result: restored, database: await orderedDatabaseState(database), events: structuredClone(context.events),
          source: fileObservation(await testFileSystem.readFile(source)), witness: fileObservation(await testFileSystem.readFile(witness)),
          media: fileObservation(await readMedia()) };
        assert.deepEqual(restored.created, []);
        assert.deepEqual(restored.resolved.map(({ Id, nativeType, identityPath }) => ({ Id: idKey(Id), nativeType, identityPath })),
          [{ Id: idKey(row.Id), nativeType: movieType, identityPath: row.Path }]);
        assert.deepEqual(record.recovery.database, record.prefix);
        assert.deepEqual(record.recovery.source, record.local.source); assert.deepEqual(record.recovery.witness, record.local.prefix);
        assert.deepEqual(record.recovery.media, report.original.media);
      }
      report.comparisonsCompleted = true;
    } catch (failure) {
      comparisonFailed = true; comparisonFailure = failure;
      report.failure = failureObservation(failure); throw failure;
    } finally {
      try { await publishReport(); }
      catch (failure) {
        if (!comparisonFailed) throw failure;
        throw new AggregateError([comparisonFailure, failure], 'Folder validation comparison and report publication failed.', { cause: comparisonFailure });
      }
    }
  });
});
