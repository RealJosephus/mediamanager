import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseLosslessJson } from '../../src/core/json.js';
import { createRuntime } from '../../src/runtime.js';
import { tableDefinition } from '../../src/database/model.js';
import { StorageError } from '../../src/storage/errors.js';
import {
  boxSetNativeType, createBoxSetItemResolver, createPlaylistItemResolver, createResolvedItemEntity,
  DirectoryItemResolverPipeline, ItemCreationService, newNativeItemEntity, playlistNativeType,
} from '../../src/library/index.js';
import { setFolderChildren, readCachedFolderChildren } from '../../src/library/folder-cache.js';
import { nativeFileName } from '../../src/library/native-path.js';
import { projectStored } from './native-resolver-entity-types-fixture.js';
import { setupChildrenFixture, useIdentityPathReversalControl } from '../metadata/children-fixture.js';
import { PostgresDatabase } from '../../src/database/postgres.js';

const root = new URL('./fixtures/collection-playlist-resolution/', import.meta.url);
const inputBytes = await readFile(new URL('input.json', root));
const input = JSON.parse(inputBytes);
const native = parseLosslessJson(await readFile(new URL('native.json', root), 'utf8'));
const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const parentId = '15000000-0000-0000-0000-000000000099';
const subjectId = index => `15000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
const created = '2026-10-09T01:02:03.0000000Z', modified = '2026-10-09T02:03:04.0000000Z';
const stateRoot = 'Z:\\CollectionResolverFixture';

function sampleContext(sample, sampleRoot = stateRoot) {
  const media = path.win32.join(sampleRoot, 'media');
  const entries = new Map();
  const add = (relative, kind) => {
    const parts = relative.split('/');
    for (let index = 1; index < parts.length; index++) entries.set(parts.slice(0, index).join('/'), 'directory');
    entries.set(relative, kind);
  };
  for (const name of sample.directories ?? []) add(name, 'directory');
  for (const name of sample.files ?? []) add(name, 'file');
  const candidates = [...entries].map(([relative, kind]) => ({
    identityPath: path.win32.join(media, ...relative.split('/')),
    accessPath: '/fixture/collection-resolver/' + relative,
    entry: { name: relative.split('/').at(-1), kind, size: kind === 'file' ? 20n : null, created, modified }
  }));
  const target = candidates.find(candidate => candidate.identityPath === path.win32.join(media, ...sample.target.split('/')));
  assert.ok(target, `${sample.name}: neutral input must create its target`);
  const children = candidates.filter(candidate => path.win32.dirname(candidate.identityPath) === target.identityPath);
  if (sample.trailingSeparator) target.identityPath += '\\';
  if (sample.enumerationError) target.identityPath = path.win32.join(media, 'absent-native-directory');
  const parent = newNativeItemEntity(sample.parentKind === 'PlaylistsFolder'
    ? 'Emby.Server.Implementations.Playlists.PlaylistsFolder' : 'MediaBrowser.Controller.Entities.Folder');
  Object.assign(parent, { Id: parentId, Name: 'Physical root', Path: media });
  return {
    parent, candidate: target, collectionContext: { collectionType: sample.collectionType ?? null },
    deletionSafe: true,
    peekDirectory: async () => {
      if (sample.enumerationError) throw new StorageError('not-found', 'Controlled missing directory.');
      return { listing: { deletionSafe: true }, candidates: children };
    }
  };
}

async function resolve(sample, index, sampleRoot = stateRoot) {
  const context = sampleContext(sample, sampleRoot);
  const resolvers = sample.resolver === 'chain' ? [createPlaylistItemResolver(), createBoxSetItemResolver()]
    : sample.resolver === 'playlist' ? [createPlaylistItemResolver()] : [createBoxSetItemResolver()];
  const method = context.candidate.entry.kind === 'file' ? 'resolveFile' : 'resolveDirectory';
  let claim;
  for (const resolver of resolvers) {
    claim = await resolver[method]?.(context);
    if (claim) break;
  }
  if (!claim) return { priority: resolvers[0].priority, item: null, context };
  assert.notEqual(claim.withhold, true, 'Strong neutral snapshots must not be withheld.');
  const item = createResolvedItemEntity({ ...claim, Id: subjectId(index),
    identityPath: claim.primary.identityPath, entry: claim.primary.entry }, { parent: context.parent });
  // These are the same explicit identity/timestamp controls as the native
  // oracle, not a normalization that removes runtime date differences.
  item.DateCreated = created; item.DateModified = modified;
  return { priority: resolvers[0].priority, item, context, claim };
}

function project(item, sampleRoot = stateRoot) {
  if (item == null) return null;
  return {
    type: item.NativeType, name: item.Name,
    path: item.Path.replace(sampleRoot, '$STATE').replaceAll('\\', '/'),
    IsFolder: item.IsFolder, mediaType: item.MediaType, IsInMixedFolder: item.IsInMixedFolder,
    isRoot: item.IsRoot, IsLocked: item.IsLocked, size: item.Size == null ? null : Number(item.Size),
    openAccess: item.Type === 'Playlist' ? item.OpenAccess : null,
    playlistMediaType: item.Type === 'Playlist' ? item.PlaylistMediaType : null,
    providers: item.ProviderIds
  };
}

async function verify(entry) {
  assert.equal(entry.available, true, entry.filename);
  const bytes = await readFile(entry.filename);
  assert.equal(bytes.length, entry.bytes, entry.filename);
  assert.equal(hash(bytes), entry.sha256, entry.filename);
}

test('Collection/Playlist oracle seals actual native execution and explicitly controlled boundaries', async () => {
  assert.equal(native.candidateVerified, false);
  assert.equal(provenance.candidateVerified, false);
  assert.equal(provenance.native.sha256, '79f198cb53da8c29030b152c6299a68a1e51eaad4659e8a6814e7f3b70402368');
  assert.equal(hash(await readFile(new URL('provenance.json', root))),
    '29f517fd1e53a3ddf6e8eb5ad8550f0abed7f3a4a7324cb05654c3caad1aecf7');
  assert.equal(native.inputSha256, hash(inputBytes));
  assert.equal(provenance.jellyfin.commit, '208c278b75abd897aefa1e1175126eac5e4dbfaa');
  const git = args => execFileSync('git', ['-C', provenance.jellyfin.source, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  assert.equal(git(['rev-parse', 'HEAD']), provenance.jellyfin.commit);
  assert.equal(git(['status', '--short']), '');
  for (const entry of [provenance.record, provenance.raw, provenance.native, provenance.dotnet,
    provenance.jellyfinDll, ...provenance.files, ...provenance.jellyfin.sources, ...provenance.resolution]) await verify(entry);
  for (const entry of [...native.assemblies, native.nativeSqlite]) assert.equal(hash(await readFile(entry.path)), entry.sha256, entry.path);
  const recording = JSON.parse(await readFile(provenance.record.filename, 'utf8'));
  assert.equal(recording.passed, true);
  assert.equal(recording.build.status, 0);
  assert.equal(recording.process.status, 0);
  assert.deepEqual(native.discoveryOrder, [
    'Emby.Server.Implementations.Library.Resolvers.PlaylistResolver',
    'Emby.Server.Implementations.Library.Resolvers.Movies.BoxSetResolver'
  ]);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
  assert.equal(native.results.length, 32);
  const columns = tableDefinition('BaseItems').columns.map(column => column.name).sort();
  for (const result of native.results) if (result.stored) {
    assert.equal(result.stored.columnCount, 72);
    assert.deepEqual(Object.keys(result.stored.columns).sort(), columns);
    assert.equal(JSON.stringify(result.stored.data), result.stored.dataText, 'Complete raw Data remains in native order.');
    assert.ok(result.lookup, 'Actual native cold hydration must be recorded.');
  }
  assert.match(native.boundary, /not complete LibraryManager resolver composition/u);
});

for (const [index, sample] of input.entries()) test(`native Collection/Playlist resolution: ${sample.name}`, async () => {
  const result = await resolve(sample, index + 1);
  const expected = native.results[index];
  assert.equal(result.priority, expected.priority);
  assert.deepEqual(project(result.item), expected.resolved);
  if (result.item) assert.equal(result.claim.traversal, result.item.Type === 'Playlist' ? 'none' : 'children');
});

test('PostgreSQL saves all 72 columns, exact Data and cold entities from actual special resolver drafts', async t => {
  assert.ok(process.env.MEDIAMANAGER_TEST_POSTGRES, 'Real PostgreSQL is required; this differential cannot skip.');
  const fixture = await setupChildrenFixture(t);
  useIdentityPathReversalControl(fixture);
  const creator = new ItemCreationService(fixture);
  fixture.library.itemCreation = creator;
  for (const [index, sample] of input.entries()) {
    const sampleRoot = path.win32.join(stateRoot, sample.name);
    fixture.identityMap.addPrefix({ identityRoot: sampleRoot, accessRoot: `/fixture/collection-resolver/${sample.name}`,
      style: 'windows', returnAccess: 'Controlled special-resolver oracle identity namespace.' });
    const result = await resolve(sample, index + 1, sampleRoot), expected = native.results[index];
    if (!result.item) continue;
    await creator.saveItems([result.context.parent]);
    await creator.saveItems([result.item]);
    const stored = await projectStored(fixture.database, result.item.Id, sampleRoot);
    const providers = await fixture.database.rows('BaseItemProviders', { where: { ItemId: result.item.Id },
      orderBy: [{ column: 'ProviderId', direction: 'ASC' }] });
    assert.deepEqual({ ...stored, providers: providers.map(({ ProviderId, ProviderValue }) => ({ ProviderId, ProviderValue })) },
      expected.stored, `${sample.name}: full PostgreSQL native persistence`);
    const cold = await creator.getItemById(result.item.Id);
    assert.notEqual(cold, result.item, 'A cold native entity must not be the live draft.');
    assert.deepEqual(project(cold, sampleRoot), expected.lookup, `${sample.name}: cold hydration`);
  }
});

test('Special resolver snapshots preserve uncertainty and propagate permission/protocol/cancellation faults', async () => {
  const context = sampleContext(input.find(sample => sample.name === 'playlist-xml-suffix'));
  for (const factory of [createPlaylistItemResolver, createBoxSetItemResolver]) {
    const resolver = factory();
    assert.deepEqual(await resolver.resolveDirectory({ ...context,
      peekDirectory: async () => ({ listing: { deletionSafe: false }, candidates: [] }) }), { withhold: true });
    for (const code of ['permission-denied', 'authentication-required', 'invalid-response', 'cancelled', 'unavailable']) {
      const error = new StorageError(code, 'Controlled directory failure.');
      await assert.rejects(resolver.resolveDirectory({ ...context, peekDirectory: async () => { throw error; } }),
        failure => failure === error);
    }
  }
  let calls = 0;
  const peekDirectory = async () => { calls++; throw new Error('This marker must not enumerate.'); };
  const marker = sampleContext(input.find(sample => sample.name === 'playlist-marker'));
  assert.equal((await createPlaylistItemResolver().resolveDirectory({ ...marker, peekDirectory })).nativeType, playlistNativeType);
  const internal = sampleContext(input.find(sample => sample.name === 'playlist-internal-no-xml'));
  assert.equal((await createPlaylistItemResolver().resolveDirectory({ ...internal, peekDirectory })).nativeType, playlistNativeType);
  const box = sampleContext(input.find(sample => sample.name === 'boxset-marker'));
  assert.equal((await createBoxSetItemResolver().resolveDirectory({ ...box, peekDirectory })).nativeType, boxSetNativeType);
  assert.equal(calls, 0);
});

test('Equal-priority pipeline selects Playlist before BoxSet and retains host observation failures', async () => {
  const pipeline = new DirectoryItemResolverPipeline({ programDataPath: 'D:\\ControlledProgramData',
    resolvers: [createPlaylistItemResolver(), createBoxSetItemResolver()] });
  for (const name of ['chain-both-markers', 'chain-both-xml', 'chain-boxset-with-music']) {
    const context = sampleContext(input.find(sample => sample.name === name));
    const result = await pipeline.resolve({ ...context, candidates: [context.candidate] });
    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].nativeType, native.results.find(value => value.name === name).resolved.type);
  }
  const context = sampleContext(input.find(sample => sample.name === 'playlist-xml-suffix'));
  const error = new StorageError('invalid-response', 'Controlled protocol failure.');
  await assert.rejects(pipeline.resolve({ ...context, candidates: [context.candidate], peekDirectory: async () => { throw error; } }),
    failure => failure === error);
});

test('Playlist child validation matches native no-op before cancellation, storage, progress and persistence', async t => {
  const { runtime } = await runtimeFixture(t);
  const playlist = newNativeItemEntity(playlistNativeType);
  playlist.Path = 'Z:\\Unavailable\\not-a-directory.m3u';
  const nested = newNativeItemEntity('MediaBrowser.Controller.Entities.Folder');
  setFolderChildren(playlist, [nested]); setFolderChildren(nested, []);
  const calls = [], service = runtime.folderValidation;
  const original = { list: service.vfs.list, run: service.store.run, refreshes: service.refreshes };
  service.vfs.list = () => { throw new Error('Playlist must not list.'); };
  service.store.run = () => { throw new Error('Playlist must not query.'); };
  service.refreshes = { reportStarted: () => calls.push('start'), reportProgress: value => calls.push(value),
    reportCompleted: () => calls.push('complete') };
  try {
    const controller = new AbortController(); controller.abort();
    const result = await service.validateChildren(playlist, { recursive: true, allowRemoveRoot: true,
      signal: controller.signal, reportProgress: value => calls.push(value) });
    assert.deepEqual(result, { created: [], resolved: [], skipped: false });
    assert.deepEqual(calls, native.playlistValidation.progress);
    assert.equal(native.playlistValidation.completedWithCancelledToken, true);
    assert.deepEqual(readCachedFolderChildren(playlist, {}, () => ['reloaded']), ['reloaded']);
    assert.deepEqual(readCachedFolderChildren(nested, {}, () => ['nested-reloaded']), ['nested-reloaded']);
  } finally {
    service.vfs.list = original.list; service.store.run = original.run; service.refreshes = original.refreshes;
  }
});

async function runtimeFixture(t, contentTypes = []) {
  assert.ok(process.env.MEDIAMANAGER_TEST_POSTGRES, 'Real PostgreSQL is required for production assembly.');
  const fixture = await setupChildrenFixture(t);
  // Runtime owns its connection pool; the fixture's independent pool retains
  // ownership of the exact random schemas used for teardown.
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
    schema: fixture.database.schemaName });
  const runtime = await createRuntime({ database, programDataPath: fixture.stateRoot,
    vfs: fixture.vfs, identityMap: fixture.identityMap,
    configuration: { IsStartupWizardCompleted: true, UICulture: 'en-US', ContentTypes: contentTypes },
    serverId: 'special-resolver-runtime' });
  t.after(() => runtime.close());
  return { fixture, runtime };
}

test('Production runtime registers special resolvers without claiming full scanning or physical Playlist traversal', async t => {
  const { runtime } = await runtimeFixture(t);
  const pipeline = runtime.folderValidation.resolverPipeline;
  assert.ok(pipeline.nativeTypes.includes(playlistNativeType));
  assert.ok(pipeline.nativeTypes.includes(boxSetNativeType));
  const context = sampleContext(input.find(sample => sample.name === 'chain-both-markers'));
  const result = await pipeline.resolve({ ...context, candidates: [context.candidate] });
  assert.equal(result.claims[0].nativeType, playlistNativeType);
  assert.equal(result.claims[0].traversal, 'none');
  assert.equal(runtime.folderScanner.supports(createResolvedItemEntity(result.claims[0], { parent: context.parent })), false);
  assert.equal(runtime.libraryScanner.capabilities.completeLibraryScan, false);
});

test('Production folder validation persists external and directory Playlists without discovering physical children', async t => {
  const { fixture, runtime } = await runtimeFixture(t);
  const media = 'Z:\\PlaylistValidation';
  fixture.identityMap.addPrefix({ identityRoot: media, accessRoot: '/fixture/playlists', style: 'windows',
    returnAccess: 'Isolated production Playlist validation.' });
  await fixture.adapter.mkdir('/playlists');
  await fixture.adapter.mkdir('/playlists/Favorites [playlist]');
  await fixture.adapter.write('/playlists/Favorites [playlist]/must-not-be-discovered.mp3', Buffer.from('neutral media'));
  await fixture.adapter.write('/playlists/Road Trip.M3U', Buffer.from('neutral playlist'));
  await fixture.seed({ target: 'root', items: [
    { key: 'root', type: 'Folder', Id: parentId, Path: media, TopParentId: parentId },
    { key: 'linked', type: 'Audio', Id: subjectId(80), Name: 'Linked music', Path: null }
  ] });
  const parent = await runtime.itemCreation.getItemById(parentId);
  const listed = [], list = fixture.vfs.list.bind(fixture.vfs);
  fixture.vfs.list = async (...args) => { listed.push(args[0]); return list(...args); };
  const createdItems = await runtime.library.validateChildren(parent, { collectionType: 'music',
    recursive: true, refreshChildMetadata: false });
  assert.equal(createdItems.created.length, 2);
  assert.ok(createdItems.created.every(item => item.Type === 'Playlist'));
  assert.equal(listed.some(value => value.includes('Favorites [playlist]')), false, 'Playlist overrides do not enumerate their physical contents.');
  const directory = createdItems.created.find(item => item.Name === 'Favorites');
  const file = createdItems.created.find(item => item.Name === 'Road Trip');
  assert.equal(directory.OpenAccess, true);
  assert.equal(file.OpenAccess, true);
  assert.equal(file.MediaType, 'Audio');
  assert.equal(file.IsFolder, true);
  assert.equal(file.IsInMixedFolder, true);
  assert.deepEqual(await fixture.database.rows('BaseItems', { where: { ParentId: directory.Id } }), []);
  await fixture.database.insert('LinkedChildren', { ParentId: directory.Id, ChildId: subjectId(80), SortOrder: 0, ChildType: 0 });
  const before = await fixture.database.rows('LinkedChildren', { where: { ParentId: directory.Id } });
  const controller = new AbortController(); controller.abort();
  assert.equal((await runtime.library.validateChildren(directory, { recursive: true, signal: controller.signal })).skipped, false);
  await runtime.library.validateChildren(parent, { collectionType: 'music', recursive: true, refreshChildMetadata: false });
  assert.deepEqual(await fixture.database.rows('LinkedChildren', { where: { ParentId: directory.Id } }), before);
  assert.equal(listed.some(value => value.includes('Favorites [playlist]')), false);
  runtime.itemCreation.unregisterItem(file.Id);
  const cold = await runtime.itemCreation.getItemById(file.Id);
  assert.equal(cold.MediaType, 'Audio'); assert.equal(cold.OpenAccess, true);
});

test('Production validation retains internal Playlist identity and links after playlist.xml disappears', async t => {
  const { fixture, runtime } = await runtimeFixture(t);
  const media = 'Z:\\InternalPlaylistValidation';
  fixture.identityMap.addPrefix({ identityRoot: media, accessRoot: '/fixture/internal-playlists', style: 'windows',
    returnAccess: 'Mapped PlaylistsFolder type control; not actual local state-folder traversal.' });
  await fixture.adapter.mkdir('/internal-playlists');
  await fixture.adapter.mkdir('/internal-playlists/Favorites');
  await fixture.adapter.write('/internal-playlists/Favorites/playlist.xml', Buffer.from('neutral XML'));
  const parent = newNativeItemEntity('Emby.Server.Implementations.Playlists.PlaylistsFolder');
  Object.assign(parent, { Id: parentId, Path: media });
  await runtime.itemCreation.saveItems([parent]);
  const linked = newNativeItemEntity('MediaBrowser.Controller.Entities.Audio.Audio');
  Object.assign(linked, { Id: subjectId(80), Name: 'Linked music' });
  await runtime.itemCreation.saveItems([linked]);
  const first = await runtime.library.validateChildren(parent, { recursive: true, refreshChildMetadata: false });
  assert.equal(first.created.length, 1);
  const playlist = first.created[0];
  await fixture.database.insert('LinkedChildren', { ParentId: playlist.Id, ChildId: linked.Id, SortOrder: 0, ChildType: 0 });
  const before = await fixture.database.rows('LinkedChildren', { where: { ParentId: playlist.Id } });
  await fixture.adapter.delete('/internal-playlists/Favorites/playlist.xml');
  const second = await runtime.library.validateChildren(parent, { recursive: true, refreshChildMetadata: false });
  assert.equal(second.created.length, 0);
  assert.equal(second.resolved.length, 1);
  assert.equal(second.resolved[0].Id, playlist.Id);
  assert.deepEqual(await fixture.database.rows('LinkedChildren', { where: { ParentId: playlist.Id } }), before);
});

test('Production validation recursively creates BoxSet children and persists only its own TMDB attribute', async t => {
  const { fixture, runtime } = await runtimeFixture(t);
  const media = 'Z:\\BoxSetValidation [tmdb=999]';
  fixture.identityMap.addPrefix({ identityRoot: media, accessRoot: '/fixture/boxsets', style: 'windows',
    returnAccess: 'Isolated production BoxSet validation.' });
  await fixture.adapter.mkdir('/boxsets');
  await fixture.adapter.mkdir('/boxsets/Saga [boxset] [tmdb=007]');
  await fixture.adapter.write('/boxsets/Saga [boxset] [tmdb=007]/One.epub', Buffer.from('neutral book'));
  await fixture.seed({ target: 'root', items: [
    { key: 'root', type: 'Folder', Id: parentId, Path: media, TopParentId: parentId }
  ] });
  const rootItem = await runtime.itemCreation.getItemById(parentId);
  const result = await runtime.library.validateChildren(rootItem, { collectionType: 'books',
    recursive: true, refreshChildMetadata: false });
  assert.equal(result.created.length, 1);
  const boxSet = result.created[0];
  assert.equal(boxSet.NativeType, boxSetNativeType);
  assert.equal(boxSet.ProviderIds.Tmdb, '007');
  const children = await fixture.database.rows('BaseItems', { where: { ParentId: boxSet.Id } });
  assert.equal(children.length, 1);
  assert.equal(children[0].Type, 'MediaBrowser.Controller.Entities.Book');
  assert.equal(children[0].Name, 'One');
  runtime.itemCreation.unregisterItem(boxSet.Id);
  const cold = await runtime.itemCreation.getItemById(boxSet.Id);
  assert.equal(cold.ProviderIds.Tmdb, '007');
  assert.equal(cold.DisplayOrder, 'PremiereDate');
});

test('Production structural scan traverses BoxSet but never physical Playlist contents', async t => {
  const media = 'Z:\\SpecialStructuralScan';
  const { fixture, runtime } = await runtimeFixture(t, [{ Name: media, Value: 'books' }]);
  fixture.identityMap.addPrefix({ identityRoot: media, accessRoot: '/fixture/special-scan', style: 'windows',
    returnAccess: 'Controlled strong-snapshot structural scan.' });
  await fixture.adapter.mkdir('/special-scan');
  await fixture.adapter.mkdir('/special-scan/Favorites [playlist]');
  await fixture.adapter.write('/special-scan/Favorites [playlist]/must-not-be-discovered.epub', Buffer.from('neutral book'));
  await fixture.adapter.mkdir('/special-scan/Saga [boxset] [tmdb=007]');
  await fixture.adapter.write('/special-scan/Saga [boxset] [tmdb=007]/One.epub', Buffer.from('neutral book'));
  await fixture.seed({ target: 'root', items: [
    { key: 'root', type: 'Folder', Id: parentId, Path: media, TopParentId: parentId }
  ] });
  const listed = [], list = fixture.vfs.list.bind(fixture.vfs);
  fixture.vfs.list = async (...args) => { listed.push(args[0]); return list(...args); };
  const result = await runtime.folderScanner.scan({ Id: parentId }, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None' });
  assert.equal(result.added, 3, 'The structural receipt must include BoxSet, Book and Playlist.');
  const direct = await fixture.database.rows('BaseItems', { where: { ParentId: parentId } });
  assert.equal(direct.length, 2);
  const playlist = direct.find(row => row.Type === playlistNativeType), boxSet = direct.find(row => row.Type === boxSetNativeType);
  assert.ok(playlist); assert.ok(boxSet);
  assert.equal(JSON.parse(playlist.Data).OpenAccess, true);
  assert.equal(listed.some(value => value.includes('Favorites [playlist]')), false);
  assert.deepEqual(await fixture.database.rows('BaseItems', { where: { ParentId: playlist.Id } }), []);
  const children = await fixture.database.rows('BaseItems', { where: { ParentId: boxSet.Id } });
  assert.equal(children.length, 1);
  assert.equal(children[0].Type, 'MediaBrowser.Controller.Entities.Book');
  assert.deepEqual(await fixture.database.rows('BaseItemProviders', { where: { ItemId: boxSet.Id } }),
    [{ ItemId: boxSet.Id, ProviderId: 'Tmdb', ProviderValue: '007' }]);
  assert.equal(runtime.libraryScanner.capabilities.completeLibraryScan, false);
});
