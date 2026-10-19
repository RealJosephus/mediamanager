import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseLosslessJson } from '../../src/core/json.js';
import { tableDefinition } from '../../src/database/model.js';
import { StorageError } from '../../src/storage/errors.js';
import {
  boxSetNativeType, createBoxSetItemResolver, createPlaylistItemResolver, createResolvedItemEntity,
  DirectoryItemResolverPipeline, ItemCreationService, newNativeItemEntity, playlistNativeType,
} from '../../src/library/index.js';
import { setFolderChildren, readCachedFolderChildren } from '../../src/library/folder-cache.js';
import { projectStored } from './native-resolver-entity-types-fixture.js';
import { setupChildrenFixture, useIdentityPathReversalControl } from '../metadata/children-fixture.js';

import { subjectId, created, modified, stateRoot, sampleContext, runtimeFixture } from './collection-playlist-runtime-fixture.js';

const root = new URL('./fixtures/collection-playlist-resolution/', import.meta.url);
const inputBytes = await readFile(new URL('input.json', root));
const input = JSON.parse(inputBytes);
const native = parseLosslessJson(await readFile(new URL('native.json', root), 'utf8'));
const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
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
