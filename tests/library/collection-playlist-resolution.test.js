import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tableDefinition } from '../../src/database/model.js';
import { StorageError } from '../../src/storage/errors.js';
import {
  boxSetNativeType, createBoxSetItemResolver, createPlaylistItemResolver, createResolvedItemEntity,
  DirectoryItemResolverPipeline, ItemCreationService, newNativeItemEntity, playlistNativeType,
} from '../../src/library/index.js';
import { setFolderChildren, readCachedFolderChildren } from '../../src/library/folder-cache.js';
import { guid } from '../../src/library/records.js';
import { projectStored } from './native-resolver-entity-types-fixture.js';
import { setupChildrenFixture, useIdentityPathReversalControl } from '../metadata/children-fixture.js';

import { subjectId, created, modified, sampleContext, runtimeFixture } from './collection-playlist-runtime-fixture.js';
import { input, captureCurrentNative, currentSampleContext, mediaTree, recordCandidate }
  from './fixtures/collection-playlist-resolution/current/capture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];

async function resolve(sample, index, sampleRoot) {
  const context = await currentSampleContext(sample, sampleRoot);
  const resolvers = sample.resolver === 'chain' ? [createPlaylistItemResolver(), createBoxSetItemResolver()]
    : sample.resolver === 'playlist' ? [createPlaylistItemResolver()] : [createBoxSetItemResolver()];
  const method = context.candidate.entry.kind === 'file' ? 'resolveFile' : 'resolveDirectory';
  let claim;
  for (const resolver of resolvers) {
    claim = await resolver[method]?.(context);
    if (claim) break;
  }
  if (!claim) return { item: null, context };
  assert.notEqual(claim.withhold, true, 'Strong neutral snapshots must not be withheld.');
  const item = createResolvedItemEntity({ ...claim, Id: subjectId(index),
    identityPath: claim.primary.identityPath, entry: claim.primary.entry }, { parent: context.parent });
  // These are the same explicit identity/timestamp controls as the native
  // oracle, not a normalization that removes runtime date differences.
  item.DateCreated = created; item.DateModified = modified;
  return { item, context, claim };
}

function project(item, sampleRoot) {
  if (item == null) return null;
  return {
    type: item.NativeType, id: guid(item.Id), parentId: guid(item.ParentId), name: item.Name,
    path: item.Path.replace(sampleRoot, '$STATE').replaceAll('\\', '/'),
    IsFolder: item.IsFolder, mediaType: item.MediaType, IsInMixedFolder: item.IsInMixedFolder,
    isRoot: item.IsRoot, IsLocked: item.IsLocked, size: item.Size == null ? null : Number(item.Size),
    openAccess: item.Type === 'Playlist' ? item.OpenAccess : null,
    playlistMediaType: item.Type === 'Playlist' ? item.PlaylistMediaType : null,
    providers: item.ProviderIds
  };
}

test('Collection/Playlist captures this run’s designated Native, real files and persistence boundary', async () => {
  const { native, report } = await captureCurrentNative();
  assert.equal(report.nativeExecutionRecorded, true);
  assert.equal(native.results.length, 32);
  const columns = tableDefinition('BaseItems').columns.map(column => column.name).sort();
  for (const result of native.results) if (result.stored) {
    assert.equal(result.stored.columnCount, 72);
    assert.deepEqual(Object.keys(result.stored.columns).sort(), columns);
    assert.ok(result.lookup, 'Actual native cold hydration must be recorded.');
  }
});

for (const [index, sample] of input.entries()) test(`current Native Collection/Playlist resolution: ${sample.name}`, async () => {
  const { native, stateRoot } = await captureCurrentNative(), sampleRoot = path.join(stateRoot, sample.name);
  const filesBefore = await mediaTree(sampleRoot), result = await resolve(sample, index + 1, sampleRoot);
  const observation = { name: sample.name, resolved: project(result.item, sampleRoot),
    filesBefore, filesAfter: await mediaTree(sampleRoot) };
  await recordCandidate('resolution', observation);
  const expected = native.results[index];
  assert.deepEqual(observation.resolved, expected.resolved);
  assert.deepEqual(observation.filesBefore, expected.filesBefore);
  assert.deepEqual(observation.filesAfter, expected.filesAfter);
  if (result.item) assert.equal(result.claim.traversal, result.item.Type === 'Playlist' ? 'none' : 'children');
});

test('PostgreSQL saves all 72 columns, exact Data and cold entities from actual special resolver drafts', async t => {
  const { native, stateRoot } = await captureCurrentNative();
  assert.ok(process.env.MEDIAMANAGER_TEST_POSTGRES, 'Real PostgreSQL is required; this differential cannot skip.');
  const fixture = await setupChildrenFixture(t);
  useIdentityPathReversalControl(fixture);
  const creator = new ItemCreationService(fixture);
  fixture.library.itemCreation = creator;
  for (const [index, sample] of input.entries()) {
    const sampleRoot = path.join(stateRoot, sample.name);
    fixture.identityMap.addPrefix({ identityRoot: sampleRoot, accessRoot: `/fixture/collection-resolver/${sample.name}`,
      style: process.platform === 'win32' ? 'windows' : 'posix', returnAccess: 'Same-run special-resolver media paths.' });
    const result = await resolve(sample, index + 1, sampleRoot), expected = native.results[index];
    if (!result.item) continue;
    await creator.saveItems([result.context.parent]);
    await creator.saveItems([result.item]);
    const stored = await projectStored(fixture.database, result.item.Id, sampleRoot);
    const providers = await fixture.database.rows('BaseItemProviders', { where: { ItemId: result.item.Id },
      orderBy: [{ column: 'ProviderId', direction: 'ASC' }] });
    const storedProjection = { ...stored, providers: providers.map(({ ProviderId, ProviderValue }) => ({ ProviderId, ProviderValue })) };
    // A fresh service reads the persisted row by identity.
    const reader = new ItemCreationService(fixture);
    let lookup;
    try { lookup = project(await reader.getItemById(result.item.Id), sampleRoot); }
    finally { await reader.close(); }
    const observation = { name: sample.name, stored: storedProjection, lookup, filesAfter: await mediaTree(sampleRoot) };
    await recordCandidate('persistence', observation);
    assert.deepEqual(storedProjection, expected.stored, `${sample.name}: full PostgreSQL native persistence`);
    assert.deepEqual(lookup, expected.lookup, `${sample.name}: cold hydration`);
    assert.deepEqual(observation.filesAfter, expected.filesAfter, `${sample.name}: persistence preserves media files`);
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
        failure => failure?.code === code);
    }
  }
  const peekDirectory = async () => { throw new Error('This marker must not enumerate.'); };
  const marker = sampleContext(input.find(sample => sample.name === 'playlist-marker'));
  assert.equal((await createPlaylistItemResolver().resolveDirectory({ ...marker, peekDirectory })).nativeType, playlistNativeType);
  const internal = sampleContext(input.find(sample => sample.name === 'playlist-internal-no-xml'));
  assert.equal((await createPlaylistItemResolver().resolveDirectory({ ...internal, peekDirectory })).nativeType, playlistNativeType);
  const box = sampleContext(input.find(sample => sample.name === 'boxset-marker'));
  assert.equal((await createBoxSetItemResolver().resolveDirectory({ ...box, peekDirectory })).nativeType, boxSetNativeType);
});

test('Resolver pipeline selects the same winner as current Native and reports unreadable inputs without creating a fallback', async () => {
  const { native, stateRoot } = await captureCurrentNative();
  const failures = [];
  const pipeline = new DirectoryItemResolverPipeline({ programDataPath: path.join(stateRoot, 'controlled-program-data'),
    resolvers: [createPlaylistItemResolver(), createBoxSetItemResolver()], onError: error => failures.push(error) });
  for (const name of ['chain-both-markers', 'chain-both-xml', 'chain-boxset-with-music']) {
    const context = await currentSampleContext(input.find(sample => sample.name === name), path.join(stateRoot, name));
    const result = await pipeline.resolve({ ...context, candidates: [context.candidate] });
    assert.equal(result.claims.length, 1);
    await recordCandidate('pipeline', { name, selectedType: result.claims[0].nativeType });
    assert.equal(result.claims[0].nativeType, native.results.find(value => value.name === name).resolved.type);
  }
  const context = sampleContext(input.find(sample => sample.name === 'playlist-xml-suffix'));
  const error = new StorageError('invalid-response', 'Controlled protocol failure.');
  const result = await pipeline.resolve({ ...context, candidates: [context.candidate], peekDirectory: async () => { throw error; } });
  await recordCandidate('pipeline', { name: 'unreadable-input', createdTypes: result.claims.map(claim => claim.nativeType),
    unclaimedPaths: result.unclaimedPaths, diagnostics: failures.map(failure => ({
      code: failure.code, name: failure.name, message: failure.message })) });
  assert.deepEqual(result.claims, []);
  assert.ok(result.unclaimedPaths.includes(context.candidate.identityPath));
  assert.ok(failures.some(failure => failure.code === error.code), 'The failed observation must reach the host reporter.');
});

test('Playlist child validation matches native no-op before cancellation, storage, progress and persistence', async t => {
  const { native, stateRoot } = await captureCurrentNative();
  const { runtime } = await runtimeFixture(t);
  const playlist = newNativeItemEntity(playlistNativeType);
  playlist.Path = path.join(stateRoot, 'no-real-directory.m3u');
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
    await recordCandidate('validation', { name: 'cancelled-inaccessible-playlist', result, progress: calls,
      completedWithCancelledToken: true });
    assert.deepEqual(result, { created: [], resolved: [], skipped: false });
    assert.deepEqual(calls, native.playlistValidation.progress);
    assert.equal(native.playlistValidation.completedWithCancelledToken, true);
    assert.deepEqual(readCachedFolderChildren(playlist, {}, () => ['reloaded']), ['reloaded']);
    assert.deepEqual(readCachedFolderChildren(nested, {}, () => ['nested-reloaded']), ['nested-reloaded']);
  } finally {
    service.vfs.list = original.list; service.store.run = original.run; service.refreshes = original.refreshes;
  }
});
