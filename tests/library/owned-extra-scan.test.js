import { testFileSystem } from '../storage/plugin-files.js';
import { failBaseItemDelete } from '../database/postgres-faults.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { getNewItemId } from '../../src/core/identity.js';
import { nativeGuid } from '../../src/users/native.js';
import { DirectoryItemResolverPipeline } from '../../src/library/directory-item-resolver.js';
import { createOwnedFolderValidationFixture, ownedStatePaths, ownedRefreshOptions, withoutSaveTime } from '../helpers/owned-folder-validation-fixture.js';
import { createResolvedItemLifecycleFixture } from './resolved-item-lifecycle-fixture.js';
import { LibraryService } from '../../src/library/library-service.js';
import { idKey } from '../../src/library/records.js';
import {
  createVideoFileResolver,
  movieNativeType,
  trailerNativeType,
  videoNativeType
} from '../../src/library/video-file-resolver.js';
import { audioNativeType } from '../../src/library/audio-item-resolver.js';
import { ProviderRefreshService } from '../../src/metadata/provider-refresh-service.js';
import { IdentityAccessMap, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { knownAncestorIgnoreRule } from './ignore-namespace-fixture.js';

const programDataPath = 'C:\\ProgramData\\MediaManager';
const physicalRootPath = 'Z:\\Movies';
const movieFolderPath = `${physicalRootPath}\\Film`;
const aggregateId = 'A7200000-0000-0000-0000-000000000001';
const userRootId = 'A7200000-0000-0000-0000-000000000002';
const rootId = 'A7200000-0000-0000-0000-000000000003';
const collectionId = 'A7200000-0000-0000-0000-000000000004';
const folderNativeType = 'MediaBrowser.Controller.Entities.Folder';
const movieFolderId = nativeGuid(getNewItemId(movieFolderPath, folderNativeType, {
  programDataPath,
  enableCaseSensitiveItemIds: false
}));
const blank = Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => !column.generated).map(column => [column.name,
  column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));

function deterministicId(relativePath, nativeType) {
  return nativeGuid(getNewItemId(`${movieFolderPath}\\${relativePath}`, nativeType, {
    programDataPath,
    enableCaseSensitiveItemIds: false
  }));
}

function row(Id, Type, values = {}) {
  return {
    ...blank,
    Id,
    Type,
    Name: values.Name ?? Type.split('.').at(-1),
    CleanName: values.CleanName ?? '',
    SortName: values.SortName ?? '',
    IsFolder: values.IsFolder ?? false,
    MediaType: values.MediaType ?? 'Unknown',
    Data: values.Data ?? (Type.includes('CollectionFolder') ? JSON.stringify({}) : null),
    ...values
  };
}

async function databaseFor(dialect) {
  const schema = `owned_extras_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  return { database: await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
    schema,
    create: true
  }), schema };
}

async function fixture(t, dialect) {
  const { database, schema } = await databaseFor(dialect);
  const store = new DomainStore(database);
  const registry = new StorageRegistry();
  let library, validationFixture, lifecycleFixture, referenceOwner, rootOwner;
  t.after(async () => {
    referenceOwner?.release(); rootOwner?.release(); await validationFixture?.close(); await lifecycleFixture?.close();
    await library?.close();
    await registry.close();
    if (dialect === 'postgres') {
      await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    }
    await database.close();
  });
  registry.registerType('memory', options => new MemoryStorageAdapter(options));
  const adapter = await registry.createInstance('movies', 'memory', {});
  await adapter.mkdir('/Film');
  await adapter.mkdir('/Film/trailers');
  await adapter.mkdir('/Film/theme-music');
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/movies', instanceId: 'movies', capabilities: {} });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({
    identityRoot: physicalRootPath,
    accessRoot: '/movies',
    style: 'windows',
    returnAccess: 'Owned-extra scan fixture'
  });
  await database.insert('BaseItems', row(aggregateId, 'MediaBrowser.Controller.Entities.AggregateFolder', { IsFolder: true }));
  await database.insert('BaseItems', row(userRootId, 'MediaBrowser.Controller.Entities.UserRootFolder', { IsFolder: true }));
  await database.insert('BaseItems', row(rootId, folderNativeType, {
    Name: 'Movies', Path: physicalRootPath, ParentId: aggregateId, TopParentId: rootId, IsFolder: true,
    Data: JSON.stringify({ SourceType: 'Library' })
  }));
  await database.insert('BaseItems', row(movieFolderId, folderNativeType, {
    Name: 'Film', Path: movieFolderPath, ParentId: rootId, TopParentId: rootId, IsFolder: true,
    Data: JSON.stringify({ SourceType: 'Library' })
  }));
  await database.insert('BaseItems', row(collectionId, 'MediaBrowser.Controller.Entities.CollectionFolder', {
    Name: 'Movies', ParentId: userRootId, IsFolder: true,
    Data: JSON.stringify({ CollectionType: 'movies', PhysicalFolderIds: [rootId], PhysicalLocationsList: [physicalRootPath] })
  }));
  // The seeded library root is the authoritative GetUserRootFolder singleton;
  // the instance storage path must not synthesize a different library graph.
  const [userRoot] = await database.rows('BaseItems', { where: { Id: userRootId } });
  library = new LibraryService({fileSystem: testFileSystem, ...await ownedStatePaths(t), store, programDataPath,
    userRoot, serverId: 'owned-extra-scan' });
  const ignoreRule = await knownAncestorIgnoreRule({ registry, vfs, identityMap, identityRoots: [physicalRootPath] });
  ignoreRule.normalizePath = true;
  lifecycleFixture = await createResolvedItemLifecycleFixture({ store, library, vfs, identityMap, ignoreRule });
  const resolverPipeline = new DirectoryItemResolverPipeline({
    programDataPath,
    resolvers: [createVideoFileResolver()]
  });
  validationFixture = createOwnedFolderValidationFixture({
    ignoreRule,
    store,
    library,
    vfs,
    identityMap,
    refreshes: new ProviderRefreshService(),
    programDataPath,
    resolverPipeline,
    lifecycleFixture, configuration: { LibraryScanFanoutConcurrency: 1 }
  });
  const { validation, itemCreation, metadata, errors } = validationFixture;
  const reference = await itemCreation.getItemById(movieFolderId);
  referenceOwner = itemCreation.retainItem(reference);
  const rootReference = await itemCreation.getItemById(rootId);
  rootOwner = itemCreation.retainItem(rootReference);
  return { database, adapter, vfs, validation, metadata, errors, library, reference, rootReference };
}

async function state(database) {
  const items = (await database.rows('BaseItems')).filter(value => [movieNativeType, trailerNativeType,
    videoNativeType, audioNativeType].includes(value.Type)).map(withoutSaveTime)
    .toSorted((left, right) => String(left.Path).localeCompare(String(right.Path)));
  const ancestors = (await database.rows('AncestorIds')).filter(value => items.some(item => idKey(item.Id) === idKey(value.ItemId)));
  return { items, ancestors };
}

function extraAt(snapshot, relativePath, nativeType) {
  return snapshot.items.find(item => idKey(item.Id) === idKey(deterministicId(relativePath, nativeType)));
}

for (const dialect of ['postgres']) test(`${dialect}: core-hidden extras do not change the primary movie mixed count`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, validation, errors, reference } = await fixture(t, dialect);
  await adapter.write('/Film/Film.mkv', Buffer.from('main'));
  await adapter.write('/Film/.hidden-trailer.mkv', Buffer.from('hidden trailer'));
  await adapter.write('/Film/theme.mp3', Buffer.from('theme'));
  await validation.validateChildren(reference, ownedRefreshOptions);
  const snapshot = await state(database), movie = snapshot.items.find(item => item.Type === movieNativeType);
  assert.equal(movie.IsInMixedFolder, false, 'Core/DotIgnore filters the primary resolver list before MovieResolver counts extras');
  assert.equal(snapshot.items.some(item => item.Path.endsWith('\\.hidden-trailer.mkv')), false);
  assert.ok(extraAt(snapshot, 'theme.mp3', audioNativeType), 'FindExtras resolves theme audio with a null parent');
});

for (const dialect of ['postgres']) test(`${dialect}: ignore rescans renumber retained extras and require authority before removing filtered rows`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, vfs, validation, errors, rootReference } = await fixture(t, dialect);
  for (const filename of ['Film.mkv', 'trailer.mkv', 'trailer.mp4']) await adapter.write('/Film/' + filename, Buffer.from(filename));
  await validation.validateChildren(rootReference, ownedRefreshOptions);
  const original = await state(database), retained = extraAt(original, 'trailer.mp4', trailerNativeType);
  assert.equal(retained.Name, 'Trailer 2');
  assert.equal(extraAt(original, 'trailer.mkv', trailerNativeType).Name, 'Trailer');
  await adapter.write('/Film/.ignore', Buffer.from('trailer.mkv'));
  validation.ignoreRule.clearDirectoryCache();
  await validation.validateChildren(rootReference, ownedRefreshOptions);
  const filtered = await state(database);
  assert.equal(extraAt(filtered, 'trailer.mp4', trailerNativeType).Id, retained.Id);
  assert.equal(extraAt(filtered, 'trailer.mp4', trailerNativeType).Name, 'Trailer');
  assert.equal(extraAt(filtered, 'trailer.mkv', trailerNativeType), undefined);
  assert.equal((await vfs.stat('/movies/Film/trailer.mkv')).kind, 'file', 'ignore reconciliation retains the physical source');
  await adapter.write('/Film/.ignore', Buffer.from('trailer.*'));
  validation.ignoreRule.clearDirectoryCache();
  const list = vfs.list.bind(vfs);
  vfs.list = async (...args) => ({ ...await list(...args), deletionSafe: false, strong: false });
  await assert.rejects(validation.validateChildren(rootReference, ownedRefreshOptions), { code: 'not-supported' });
  assert.deepEqual(await state(database), filtered, 'a weak observation cannot remove or rewrite an existing owned family');
});

for (const dialect of ['postgres']) for (const collapse of [false, true]) for (const filter of ['dot', 'core']) {
  test(`${dialect}: ${collapse ? 'collapsed' : 'direct'} extras retain the native mixed count before ${filter} filtering`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
  }, async t => {
    const { database, adapter, vfs, validation, errors, reference, rootReference } = await fixture(t, dialect);
    await adapter.mkdir('/Film/extras');
    await adapter.write('/Film/Film.mkv', Buffer.from('main'));
    await adapter.write('/Film/extras/Bonus.mkv', Buffer.from('bonus'));
    await adapter.write(`/Film/extras/${filter === 'dot' ? 'Removed.mp4' : '.hidden.mkv'}`, Buffer.from('filtered'));
    if (filter === 'dot') await adapter.write('/Film/extras/.ignore', Buffer.from('*.mp4'));
    await validation.validateChildren(collapse ? rootReference : reference, ownedRefreshOptions);
    const snapshot = await state(database), bonus = extraAt(snapshot, 'extras\\Bonus.mkv', videoNativeType);
    assert.ok(bonus);
    assert.equal(bonus.IsInMixedFolder, true, 'native FindExtras counts all nested files before ResolveExtraFile filtering');
    assert.deepEqual(snapshot.items.filter(item => item.OwnerId != null).map(item => item.Path), [`${movieFolderPath}\\extras\\Bonus.mkv`]);
  });
}

for (const dialect of ['postgres']) test(`${dialect}: owned movie extras persist, transfer and delete through metadata refresh`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, validation, errors, rootReference } = await fixture(t, dialect);
  for (const [name, bytes] of [
    ['Film.mkv', 'main'],
    ['Film - [2160p].mkv', 'version'],
    ['Film-trailer.mkv', 'main trailer'],
    ['Film - [2160p]-trailer.mkv', 'version trailer'],
    ['Recording the audio-behindthescenes.mkv', 'feature'],
    ['trailers/Teaser.mkv', 'teaser'],
    ['trailers/Official.mkv', 'official'],
    ['theme-music/theme.mp3', 'theme']
  ]) await adapter.write(`/Film/${name}`, Buffer.from(bytes));

  const created = await validation.validateChildren(rootReference, ownedRefreshOptions);
  assert.equal(created.created.length, 1, 'only the resolved primary is a direct CreateItems addition');
  let snapshot = await state(database);
  const primary = snapshot.items.find(item => item.Path === `${movieFolderPath}\\Film.mkv`);
  const alternate = snapshot.items.find(item => item.Path === `${movieFolderPath}\\Film - [2160p].mkv`);
  assert.ok(primary);
  assert.ok(alternate);
  const mainTrailer = extraAt(snapshot, 'Film-trailer.mkv', trailerNativeType);
  const versionTrailer = extraAt(snapshot, 'Film - [2160p]-trailer.mkv', trailerNativeType);
  const feature = extraAt(snapshot, 'Recording the audio-behindthescenes.mkv', videoNativeType);
  const teaser = extraAt(snapshot, 'trailers\\Teaser.mkv', trailerNativeType);
  const official = extraAt(snapshot, 'trailers\\Official.mkv', trailerNativeType);
  const theme = extraAt(snapshot, 'theme-music\\theme.mp3', audioNativeType);
  for (const [label, extra] of Object.entries({ mainTrailer, versionTrailer, feature, teaser, official, theme })) {
    assert.ok(extra, `resolved extra is persisted: ${label}; rows=${snapshot.items.map(item => `${item.Type}:${item.Path}`).join(',')}`);
    assert.equal(extra.ParentId, null);
    assert.equal(extra.TopParentId, null);
    assert.equal(extra.PrimaryVersionId, null);
  }
  assert.equal(idKey(mainTrailer.OwnerId), idKey(primary.Id));
  assert.equal(idKey(versionTrailer.OwnerId), idKey(alternate.Id), 'longest same-directory version prefix owns the extra');
  assert.equal(idKey(feature.OwnerId), idKey(primary.Id));
  assert.equal(idKey(teaser.OwnerId), idKey(primary.Id), 'subfolder extras default to the primary');
  assert.equal(idKey(theme.OwnerId), idKey(primary.Id));
  assert.equal(mainTrailer.ExtraType, 2);
  assert.equal(versionTrailer.Name, 'Film -', 'a non-owner cleaned title remains descriptive');
  assert.equal(mainTrailer.Name, 'Trailer', 'only extras named after the owner consume localized numbering');
  assert.equal(feature.Name, 'Recording the audio');
  assert.equal(teaser.IsInMixedFolder, true);
  assert.equal(official.IsInMixedFolder, true);
  assert.ok(snapshot.ancestors.filter(value => idKey(value.ItemId) === idKey(mainTrailer.Id))
    .some(value => idKey(value.ParentItemId) === idKey(collectionId)));

  const stable = structuredClone(snapshot);
  assert.equal((await validation.validateChildren(rootReference, ownedRefreshOptions)).created.length, 0);
  assert.deepEqual(await state(database), stable);

  await adapter.delete('/Film/Recording the audio-behindthescenes.mkv');
  await validation.validateChildren(rootReference, ownedRefreshOptions);
  snapshot = await state(database);
  assert.equal(extraAt(snapshot, 'Recording the audio-behindthescenes.mkv', videoNativeType), undefined);

  await adapter.delete('/Film/Film.mkv');
  await validation.validateChildren(rootReference, ownedRefreshOptions);
  snapshot = await state(database);
  const promoted = snapshot.items.find(item => item.Path === `${movieFolderPath}\\Film - [2160p].mkv`);
  assert.ok(promoted);
  assert.equal(snapshot.items.some(item => item.Path === `${movieFolderPath}\\Film.mkv`), false);
  for (const extra of snapshot.items.filter(item => item.ExtraType != null)) {
    assert.equal(idKey(extra.OwnerId), idKey(promoted.Id), `${extra.Path} transfers before old-primary deletion`);
  }
});

for (const dialect of ['postgres']) test(`${dialect}: weak extra subfolder snapshots preserve missing rows until a strong scan`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, vfs, validation, errors, reference } = await fixture(t, dialect);
  await adapter.write('/Film/Film.mkv', Buffer.from('main'));
  await adapter.write('/Film/trailers/Teaser.mkv', Buffer.from('teaser'));
  await validation.validateChildren(reference, ownedRefreshOptions);
  const before = await state(database);
  await adapter.delete('/Film/trailers/Teaser.mkv');
  const list = vfs.list.bind(vfs);
  vfs.list = async (path, options) => path.replaceAll('\\', '/').replace(/\/$/u, '').endsWith('/Film/trailers')
    ? { ...await list(path, options), consistency: 'weak', snapshot: null, deletionSafe: false }
    : list(path, options);
  await validation.validateChildren(reference, ownedRefreshOptions);
  assert.ok(errors.some(error => error.code === 'metadata-conflict'), 'owned refresh refuses a non-authoritative removal');
  assert.deepEqual(await state(database), before);
  vfs.list = list;
  await validation.validateChildren(reference, ownedRefreshOptions);
  assert.equal(extraAt(await state(database), 'trailers\\Teaser.mkv', trailerNativeType), undefined);
});

for (const dialect of ['postgres']) test(`${dialect}: owned-extra insert failure is logged while the independent owner remains saved`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, validation, errors, rootReference } = await fixture(t, dialect);
  await adapter.write('/Film/Film.mkv', Buffer.from('main'));
  await validation.validateChildren(rootReference, ownedRefreshOptions);
  const before = await state(database);
  await adapter.write('/Film/Film-trailer.mkv', Buffer.from('trailer'));
  const insert = database.insert.bind(database);
  database.insert = async (table, values) => {
    if (table === 'BaseItems' && values.ExtraType === 2) throw new Error('controlled owned-extra insert failure');
    return insert(table, values);
  };
  try { await validation.validateChildren(rootReference, ownedRefreshOptions); }
  finally { database.insert = insert; }
  assert.ok(errors.some(error => /controlled owned-extra insert failure/u.test(error.message)));
  assert.deepEqual(await state(database), before);
  await validation.validateChildren(rootReference, ownedRefreshOptions);
  assert.ok(extraAt(await state(database), 'Film-trailer.mkv', trailerNativeType));
});

for (const dialect of ['postgres']) test(`${dialect}: an informational series reference does not own a missing extra`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, validation, errors, rootReference } = await fixture(t, dialect);
  await adapter.write('/Film/Film.mkv', Buffer.from('main'));
  await adapter.write('/Film/Film-trailer.mkv', Buffer.from('trailer'));
  await validation.validateChildren(rootReference, ownedRefreshOptions);
  const trailer = extraAt(await state(database), 'Film-trailer.mkv', trailerNativeType);
  assert.ok(trailer);
  const referenceId = randomUUID();
  await database.insert('BaseItems', row(referenceId, 'Plugin.Entities.ExternalReference', {
    Name: 'External reference',
    Path: 'X:\\External\\Reference',
    SeriesId: trailer.Id,
    IsFolder: false
  }));
  await adapter.delete('/Film/Film-trailer.mkv');

  await validation.validateChildren(rootReference, ownedRefreshOptions);
  assert.deepEqual(errors, []);
  assert.equal(extraAt(await state(database), 'Film-trailer.mkv', trailerNativeType), undefined);
  assert.equal((await database.rows('BaseItems', { where: { Id: referenceId } }))[0].SeriesId, trailer.Id,
    'SeriesId has no native FK or ownership semantics; the unrelated row is retained');
});

for (const dialect of ['postgres']) test(`${dialect}: owned-extra delete failure retains the row for a later metadata refresh`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, validation, errors, rootReference } = await fixture(t, dialect);
  await adapter.write('/Film/Film.mkv', Buffer.from('main'));
  await adapter.write('/Film/Film-trailer.mkv', Buffer.from('trailer'));
  await validation.validateChildren(rootReference, ownedRefreshOptions);
  const before = await state(database);
  const trailer = extraAt(before, 'Film-trailer.mkv', trailerNativeType);
  await adapter.delete('/Film/Film-trailer.mkv');
  const restoreDelete = await failBaseItemDelete(database, trailer.Id, 'controlled owned-extra delete failure');
  try {
    await validation.validateChildren(rootReference, ownedRefreshOptions);
    assert.ok(errors.some(error => /controlled owned-extra delete failure/u.test(error.message)));
  } finally {
    await restoreDelete();
  }

  assert.deepEqual(await state(database), before);
  await validation.validateChildren(rootReference, ownedRefreshOptions);
  assert.equal(extraAt(await state(database), 'Film-trailer.mkv', trailerNativeType), undefined);
});

for (const dialect of ['postgres']) test(`${dialect}: owned-extra rescans preserve a locked name and specific extra type`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, validation, errors, library, rootReference } = await fixture(t, dialect);
  await adapter.mkdir('/Film/extras');
  await adapter.write('/Film/Film.mkv', Buffer.from('main'));
  await adapter.write('/Film/Film-trailer.mkv', Buffer.from('trailer'));
  await adapter.write('/Film/extras/Bonus.mkv', Buffer.from('bonus'));
  await validation.validateChildren(rootReference, ownedRefreshOptions);
  let snapshot = await state(database);
  const trailer = extraAt(snapshot, 'Film-trailer.mkv', trailerNativeType);
  const bonus = extraAt(snapshot, 'extras\\Bonus.mkv', videoNativeType);
  assert.ok(trailer);
  assert.ok(bonus);
  await database.update('BaseItems', { Id: trailer.Id }, {
    Name: 'Pinned trailer title',
    CleanName: 'pinned trailer title',
    SortName: 'pinned trailer title'
  });
  await database.insert('BaseItemMetadataFields', { ItemId: trailer.Id, Id: 5 });
  await database.update('BaseItems', { Id: bonus.Id }, { ExtraType: 10 });
  library.itemCreation.unregisterItem(trailer.Id);
  library.itemCreation.unregisterItem(bonus.Id);

  await validation.validateChildren(rootReference, ownedRefreshOptions);

  snapshot = await state(database);
  assert.equal(extraAt(snapshot, 'Film-trailer.mkv', trailerNativeType).Name, 'Pinned trailer title');
  assert.equal(extraAt(snapshot, 'extras\\Bonus.mkv', videoNativeType).ExtraType, 10,
    'a generic directory classification does not erase a more specific stored type');

  await database.delete('BaseItemMetadataFields', { ItemId: trailer.Id, Id: 5 });
  library.itemCreation.unregisterItem(trailer.Id);
  await validation.validateChildren(rootReference, ownedRefreshOptions);
  assert.equal(extraAt(await state(database), 'Film-trailer.mkv', trailerNativeType).Name, 'Trailer');
});

for (const dialect of ['postgres']) test(`${dialect}: collapsed movie-directory replacement refreshes its owned extras after creation`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, validation, errors, rootReference } = await fixture(t, dialect);
  await adapter.write('/Film/Film.mkv', Buffer.from('main'));
  await adapter.write('/Film/Film-trailer.mkv', Buffer.from('trailer'));
  await adapter.write('/Film/trailers/Teaser.mkv', Buffer.from('teaser'));

  await validation.validateChildren(rootReference, ownedRefreshOptions);
  const snapshot = await state(database);
  const movie = snapshot.items.find(item => item.Path === `${movieFolderPath}\\Film.mkv`);
  const direct = extraAt(snapshot, 'Film-trailer.mkv', trailerNativeType);
  const nested = extraAt(snapshot, 'trailers\\Teaser.mkv', trailerNativeType);
  assert.ok(movie);
  assert.ok(direct);
  assert.ok(nested);
  assert.equal(idKey(direct.OwnerId), idKey(movie.Id));
  assert.equal(idKey(nested.OwnerId), idKey(movie.Id));
  assert.equal((await database.rows('BaseItems', { where: { Id: movieFolderId } })).length, 0,
    'the stale generic folder is removed before creating its movie replacement');
});

for (const dialect of ['postgres']) test(`${dialect}: a mixed-folder transition completes without reassigning prior extras`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, validation, metadata, errors, reference } = await fixture(t, dialect);
  await adapter.write('/Film/Film.mkv', Buffer.from('main'));
  await validation.validateChildren(reference, ownedRefreshOptions);
  const initial = (await state(database)).items.find(item => item.Path === `${movieFolderPath}\\Film.mkv`);
  assert.equal(initial.IsInMixedFolder, false);
  await adapter.write('/Film/Film-trailer.mkv', Buffer.from('trailer'));
  // The new extra is discovered by the existing non-mixed owner's real
  // metadata refresh before structural resolution observes the mixed folder.
  await metadata.refresh(initial.Id, ownedRefreshOptions);
  const before = await state(database);
  const primary = before.items.find(item => item.Path === `${movieFolderPath}\\Film.mkv`);
  const trailer = extraAt(before, 'Film-trailer.mkv', trailerNativeType);
  assert.ok(primary);
  assert.ok(trailer);

  await adapter.write('/Film/Other.mkv', Buffer.from('other'));
  await validation.validateChildren(reference, ownedRefreshOptions);
  const mixedState = await state(database);
  const preserved = extraAt(mixedState, 'Film-trailer.mkv', trailerNativeType);
  assert.deepEqual(preserved, trailer);
  assert.equal(idKey(preserved.OwnerId), idKey(primary.Id));
  assert.equal(mixedState.items.find(item => item.Path === primary.Path).IsInMixedFolder, true);
  assert.ok(mixedState.items.some(item => item.Path === `${movieFolderPath}\\Other.mkv` && item.Type === movieNativeType));
  await validation.validateChildren(reference, ownedRefreshOptions);
  assert.deepEqual(await state(database), mixedState, 'a repeated scan keeps the cold database rows and ownership unchanged');

  await adapter.delete('/Film/Other.mkv');
  await validation.validateChildren(reference, ownedRefreshOptions);
  assert.equal(idKey(extraAt(await state(database), 'Film-trailer.mkv', trailerNativeType).OwnerId), idKey(primary.Id));
});

for (const dialect of ['postgres']) test(`${dialect}: collapsed stack-primary changes refresh extras for the replacement owner`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, validation, errors, rootReference } = await fixture(t, dialect);
  await adapter.write('/Film/Film cd1.mkv', Buffer.from('one'));
  await adapter.write('/Film/Film cd2.mkv', Buffer.from('two'));
  await adapter.write('/Film/Film-trailer.mkv', Buffer.from('trailer'));
  await validation.validateChildren(rootReference, ownedRefreshOptions);
  let snapshot = await state(database);
  let primary = snapshot.items.find(item => item.Type === movieNativeType
    && item.Path === `${movieFolderPath}\\Film cd1.mkv`);
  let trailer = extraAt(snapshot, 'Film-trailer.mkv', trailerNativeType);
  assert.ok(primary);
  assert.ok(trailer);
  assert.equal(idKey(trailer.OwnerId), idKey(primary.Id));

  await adapter.write('/Film/Film cd0.mkv', Buffer.from('zero'));
  await validation.validateChildren(rootReference, ownedRefreshOptions);
  snapshot = await state(database);
  primary = snapshot.items.find(item => item.Type === movieNativeType
    && item.Path === `${movieFolderPath}\\Film cd0.mkv`);
  trailer = extraAt(snapshot, 'Film-trailer.mkv', trailerNativeType);
  const demoted = snapshot.items.find(item => item.Type === videoNativeType
    && item.Path === `${movieFolderPath}\\Film cd1.mkv`);
  assert.ok(primary);
  assert.ok(demoted);
  assert.equal(idKey(demoted.OwnerId), idKey(primary.Id));
  assert.equal(idKey(trailer.OwnerId), idKey(primary.Id));
  assert.equal(snapshot.items.some(item => idKey(item.Id) === idKey(deterministicId('Film cd1.mkv', movieNativeType))), false);

  await adapter.delete('/Film/Film cd0.mkv');
  await validation.validateChildren(rootReference, ownedRefreshOptions);
  snapshot = await state(database);
  primary = snapshot.items.find(item => item.Type === movieNativeType
    && item.Path === `${movieFolderPath}\\Film cd1.mkv`);
  trailer = extraAt(snapshot, 'Film-trailer.mkv', trailerNativeType);
  assert.ok(primary);
  assert.equal(idKey(trailer.OwnerId), idKey(primary.Id));
});
