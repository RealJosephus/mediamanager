import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setupChildrenFixture, useIdentityPathReversalControl } from '../metadata/children-fixture.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { ItemDeletionService } from '../../src/library/item-deletion-service.js';
import { ExternalDataManager } from '../../src/library/external-data.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { internalImagePath } from '../../src/metadata/image-paths.js';
import { EMPTY_ID, VIDEO_TYPES, guid, idKey } from '../../src/library/records.js';
import { readCachedFolderChildren, setFolderChildren } from '../../src/library/folder-cache.js';

const root = new URL('./fixtures/general-leaf-deletion/', import.meta.url);
const [input, native, provenance, differences] = await Promise.all(['input.json', 'native.json', 'provenance.json', 'candidate-differences.json']
  .map(async name => JSON.parse(await readFile(new URL(name, root), 'utf8'))));
const ids = {
  target: 'A1100000-0000-0000-0000-000000000001', parent: 'A1100000-0000-0000-0000-000000000002',
  owner: 'A1100000-0000-0000-0000-000000000003', closure: 'A1100000-0000-0000-0000-000000000004',
  channel: 'A1100000-0000-0000-0000-000000000009'
};
const byName = new Map(native.results.map(result => [result.name, result]));
const withheld = new Set(differences.withheldScenes.map(sample => sample.name));
const sourceName = sample => sample.sourceName ?? (sample.type === 'Book' ? 'book.epub' : 'track.flac');
const internalFolder = sample => sample.type === 'Person' ? path.join('People', 'T', 'Target')
  : path.join(sample.type === 'MusicArtist' ? 'artists' : sample.type, 'Target');

async function setup(t, dialect, sample) {
  const fixture = await setupChildrenFixture(t, dialect), calls = [];
  useIdentityPathReversalControl(fixture);
  const originalListPage = fixture.adapter.listPage.bind(fixture.adapter);
  fixture.vfs.mount({ path: '/leaf-write', instanceId: 'fixture', capabilities: { create: true, replace: true, mkdir: true, delete: true } });
  fixture.identityMap.addPrefix({ identityRoot: 'Z:\\LeafDeletion', accessRoot: '/leaf-write/media', style: 'windows',
    returnAccess: 'isolated general leaf deletion fixture' });
  await fixture.adapter.mkdir('/media');
  const sourceIdentity = sample.internalItem ? path.join(fixture.stateRoot, 'metadata', internalFolder(sample))
    : sample.stateSource ? path.join(fixture.stateRoot, 'data', 'collections', sourceName(sample))
      : `Z:\\LeafDeletion\\${sourceName(sample)}`;
  const localSource = sample.internalItem || sample.stateSource;
  const sourceAccess = localSource ? sourceIdentity : `/leaf-write/media/${sourceName(sample)}`;
  if (!localSource && !sample.virtual && !sample.missingSource) {
    if (sample.sourceDirectory) {
      await fixture.adapter.mkdir(`/media/${sourceName(sample)}`);
      await fixture.adapter.write(`/media/${sourceName(sample)}/source.txt`, Buffer.from('source'));
    } else await fixture.adapter.write(`/media/${sourceName(sample)}`, Buffer.from('source'));
  }
  await fixture.adapter.write('/media/sibling.keep', Buffer.from('sibling'));
  await fixture.adapter.write('/media/track.nfo', Buffer.from('nfo'));
  await fixture.adapter.write('/media/track-cover.jpg', Buffer.from('image'));
  for (const filename of sample.sidecars ?? []) await fixture.adapter.write(`/media/${filename}`, Buffer.from('sidecar'));
  for (const directory of sample.sidecarDirectories ?? []) {
    await fixture.adapter.mkdir(`/media/${directory}`);
    await fixture.adapter.write(`/media/${directory}/track.nfo`, Buffer.from('nested'));
  }
  const targetPath = sample.virtual ? null : sourceIdentity;
  const definitions = [
    { key: 'parent', type: 'Folder', Id: ids.parent, Name: 'Parent', Path: 'Z:\\LeafDeletion' },
    ...(sample.ownedItem || sample.primaryVersion ? [{ key: 'owner', type: 'Audio', Id: ids.owner, Name: 'Owner',
      Path: 'Z:\\LeafDeletion\\owner.flac', parent: 'parent' }] : []),
    { key: 'target', type: sample.type, Id: ids.target, Name: 'Target', Path: targetPath,
      ...(sample.internalItem ? {} : { parent: 'parent' }),
      IsInMixedFolder: sample.mixed ?? false, IsVirtualItem: sample.virtual ?? false,
      IsShortcut: sample.shortcut ?? false, ShortcutPath: sample.shortcut ? 'https://example.invalid/source' : null,
      ...(VIDEO_TYPES.has(sample.type) ? { VideoType: sample.videoType ?? 'VideoFile', IsPlaceHolder: sample.placeholder ?? false,
        AdditionalParts: [], LocalAlternateVersions: [], LinkedAlternateVersions: [] } : {}),
      ChannelId: sample.channel ? ids.channel : null,
      OwnerId: sample.ownedItem ? ids.owner : null, PrimaryVersionId: sample.primaryVersion ? ids.owner : null },
    ...(sample.ownedChild || sample.parentChild ? [{ key: 'closure', type: sample.childType ?? 'Audio', Id: ids.closure, Name: 'Closure',
      Path: `Z:\\LeafDeletion\\${sample.childType === 'Photo' ? 'closure.jpg' : 'closure.flac'}`, ParentId: sample.parentChild ? ids.target : ids.parent,
      OwnerId: sample.ownedChild ? ids.target : null }] : [])
  ];
  await fixture.seed({ target: 'target', items: definitions });
  if (sample.ownedItem || sample.primaryVersion) await fixture.adapter.write('/media/owner.flac', Buffer.from('owner'));
  if (sample.ownedChild || sample.parentChild) await fixture.adapter.write(`/media/${sample.childType === 'Photo' ? 'closure.jpg' : 'closure.flac'}`, Buffer.from('closure'));
  const creator = new ItemCreationService(fixture);
  t.after(() => creator.close());
  fixture.library.itemCreation = creator;
  const parent = await creator.getItemById(ids.parent), item = await creator.getItemById(ids.target);
  creator.registerItem(parent); creator.registerItem(item);
  if (sample.liveVirtualDrift) item.IsVirtualItem = true;
  parent.UserData = []; setFolderChildren(parent, [item]);
  const loaded = await fixture.loadContext(item.Id, { draft: item });
  if (localSource && !sample.virtual && !sample.missingSource) {
    await loaded.imageAssets.write(path.join(sourceIdentity, 'source.txt'), Buffer.from('source'));
  }
  const external = new ExternalDataManager({fileSystem: testFileSystem,  ...fixture, dataPath: loaded.dataPath, metadataPath: loaded.metadataPath });
  // The native oracle supplies a controlled external provider with a single
  // marker directory. Match that dependency input instead of introducing an
  // additional media-side Trickplay directory into only the candidate fixture.
  external.paths = current => [path.join(loaded.dataPath, 'fixture-external', guid(current.Id))];
  const assets = new MetadataImageAssets({fileSystem: testFileSystem,  ...fixture, metadataPath: loaded.metadataPath, stateRoots: [loaded.dataPath] });
  const internalMarker = path.join(internalImagePath(item, loaded.metadataPath), 'marker.txt');
  const externalMarkers = external.paths(item, loaded).map(directory => path.join(directory, 'marker.txt'));
  await assets.write(internalMarker, Buffer.from('internal'));
  for (const marker of externalMarkers) await assets.write(marker, Buffer.from('external'));
  let closure = null;
  if (sample.ownedChild || sample.parentChild) {
    closure = await creator.getItemById(ids.closure);
    creator.registerItem(closure);
    await assets.write(path.join(internalImagePath(closure, loaded.metadataPath), 'marker.txt'), Buffer.from('closure-internal'));
  }
  const exists = async (target, operation) => { try { await operation(target); return true; } catch { return false; } };
  const state = async () => ({
    sourceExists: await exists(sourceAccess, value => localSource ? assets.stat(value) : fixture.vfs.stat(value)),
    internalExists: await exists(internalMarker, value => assets.stat(value)),
    externalExists: (await Promise.all(externalMarkers.map(marker => exists(marker, value => assets.stat(value))))).some(Boolean),
    databaseExists: (await fixture.database.rows('BaseItems', { where: { Id: item.Id } })).length !== 0,
    parentId: guid(item.ParentId)
  });
  const deleteItemFiles = external.deleteItemFiles.bind(external);
  external.deleteItemFiles = async (...args) => {
    calls.push({ action: 'external', id: guid(args[0].Id), state: await state() });
    if (sample.externalFailure) throw Object.assign(new Error('Controlled external cleanup failure.'), { code: 'io' });
    return deleteItemFiles(...args);
  };
  const channelDelete = async current => {
    calls.push({ action: 'channel', id: guid(current.Id), state: await state() });
    if (sample.channel === 'argument') throw Object.assign(new Error('Missing channel'), { nativeException: 'ArgumentException' });
    if (sample.channel === 'failure') throw new Error('Controlled channel failure');
  };
  const channelManager = { admitOperation: () => ({ deleteItem: channelDelete, release() {} }) };
  const loadDeletionContext = async (...args) => {
    const context = await fixture.loadContext(...args);
    if (sample.channel && VIDEO_TYPES.has(context.item.Type)) {
      const getMediaSources = context.getMediaSources;
      context.getMediaSources = current => {
        if (current.SourceType !== 'Channel') return getMediaSources(current);
        // The sealed oracle's channel manager returns no static sources.
        // Video then supplies itself; this fixture has no alternate versions.
        // Internal cleanup consumes only that source's ID.
        assert.equal(guid(current.Id), guid(ids.target));
        assert.equal(current.PrimaryVersionId == null || guid(current.PrimaryVersionId) === guid(EMPTY_ID), true);
        assert.deepEqual(current.LocalAlternateVersions, []);
        assert.deepEqual(current.LinkedAlternateVersions, []);
        return [{ Id: idKey(current.Id) }];
      };
    }
    return context;
  };
  Object.assign(loadDeletionContext, fixture.loadContext);
  loadDeletionContext.withContext = async (reference, options, operation) => {
    const context = await loadDeletionContext(reference, options);
    try { return await operation(context); } finally { await context.dispose(); }
  };
  const deletion = new ItemDeletionService({ ...fixture, itemCreation: creator, updates: fixture.host.updates, externalData: external,
    loadContext: loadDeletionContext, linkedChildReferences: { reroute: async () => [] }, channelManager, now: () => fixture.now });
  const deleteItems = deletion.deleteItems.bind(deletion);
  deletion.deleteItems = async (idsPlan, scope, publishDeletedPage) => {
    const values = [];
    let previous = -1n;
    for (;;) {
      const rows = (await scope.database.client.query({ text: `SELECT requested.* FROM (${idsPlan.text}) requested
        WHERE requested."Ordinal" > $${idsPlan.values.length + 1} ORDER BY requested."Ordinal" LIMIT 128`,
        values: [...idsPlan.values, previous] })).rows;
      for (const row of rows) values.push(guid(row.Key));
      if (rows.length < 128) break;
      previous = BigInt(rows.at(-1).Ordinal);
    }
    calls.push({ action: 'delete', ids: values, state: await state() });
    return deleteItems(idsPlan, scope, publishDeletedPage);
  };
  fixture.library.itemDeletion = deletion;
  fixture.library.on('ItemRemoved', event => calls.push({ action: 'event', id: guid(event.Item.Id),
    parentId: event.Parent ? guid(event.Parent.Id) : null, state: null }));
  if (sample.sourceFailure) {
    const resolved = fixture.vfs.resolve(sourceAccess), remove = fixture.adapter.delete.bind(fixture.adapter);
    fixture.adapter.delete = async (location, options) => {
      if (location === resolved.path) throw Object.assign(new Error('Controlled source failure'), { code: 'io' });
      return remove(location, options);
    };
  }
  if (sample.sidecarFailure) {
    const remove = fixture.adapter.delete.bind(fixture.adapter);
    fixture.adapter.delete = async (location, options) => {
      if (location === `/media/${sample.sidecarFailure}`) throw Object.assign(new Error('Controlled sidecar failure'), { code: 'io' });
      return remove(location, options);
    };
  }
  if (sample.enumerationFailure || sample.partialEnumerationFailure) {
    const list = fixture.adapter.listPage.bind(fixture.adapter);
    fixture.adapter.listPage = async (location, options) => {
      if (location === '/media') {
        if (sample.enumerationFailure || options?.cursor) throw Object.assign(new Error('Controlled enumeration failure'), { code: 'io' });
        const page = await list(location, options);
        return { ...page, entries: page.entries.slice(0, 1), complete: false, nextCursor: { partial: true } };
      }
      return list(location, options);
    };
  }
  if (sample.sqlFailure) {
    await fixture.database.client.query("CREATE FUNCTION deletion_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Controlled deletion failure'; END $$");
    await fixture.database.client.query('CREATE TRIGGER deletion_failure BEFORE DELETE ON "BaseItems" FOR EACH ROW EXECUTE FUNCTION deletion_failure()');
  }
  const abort = new AbortController(); if (sample.callerCancelled) abort.abort();
  const operation = () => fixture.library.deleteItem(item, { DeleteFileLocation: sample.deleteSource ?? false,
    DeleteFromExternalProvider: sample.deleteFromExternalProvider ?? true, signal: abort.signal }, sample.defaultParent ? undefined : parent);
  return { fixture, creator, parent, item, closure, calls, state, assets, internalMarker, externalMarkers,
    sourceAccess, operation, originalListPage };
}

test('actual general leaf deletion fixture is sealed and records the pinned shared BaseItem lifecycle', async () => {
  const inputBytes = await readFile(new URL('input.json', root)), nativeBytes = await readFile(new URL('native.json', root));
  const repository = new URL('../../', import.meta.url);
  for (const file of provenance.fixtureFiles) assert.equal(createHash('sha256')
    .update(await readFile(new URL(file.path, repository))).digest('hex'), file.sha256, file.path);
  assert.equal(createHash('sha256').update(inputBytes).digest('hex'), native.inputSha256);
  assert.equal(native.actualFrozenGeneralLeafDeletion, true);
  assert.equal(native.results.length, 105);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
  assert.equal(nativeBytes.includes(13), false); assert.equal(nativeBytes.at(-1), 10);
  assert.equal(createHash('sha256').update(nativeBytes).digest('hex'), provenance.record.portableNativeSha256);
  assert.equal(createHash('sha256').update(Buffer.concat([
    Buffer.from(nativeBytes.subarray(0, -2).toString('utf8').replaceAll('\n', '\r\n')), nativeBytes.subarray(-2)
  ])).digest('hex'), provenance.record.rawNativeSha256);
  assert.deepEqual(native.assemblies, provenance.assemblies.map(({ name, sha256 }) => ({ name, sha256 })));
  assert.equal(native.scope, provenance.scope);
  assert.equal(provenance.workspaceComparison.every(file => file.deletionImplementationEquivalent), true);
  assert.deepEqual(provenance.workspaceComparison.filter(file => !file.normalizedWorkspaceEquivalent)
    .map(({ path, difference }) => ({ path, difference })), [
      {
        path: 'Emby.Server.Implementations/Library/LibraryManager.cs',
        difference: 'One added LogDebug line in ResolvePaths, outside DeleteItem and its dependency chain.'
      },
      {
        path: 'MediaBrowser.Controller/Entities/Folder.cs',
        difference: 'Workspace-only directory validation and scan-progress logging do not change GetRecursiveChildren used by deletion.'
      }
    ]);
  assert.deepEqual(provenance.reference, {
    head: '208c278b75abd897aefa1e1175126eac5e4dbfaa', clean: true,
    sourceContentDigest: '1f0a32123e929472b704f6b48e7bd189273c2fabe70b2ae781180bbbc50e9fcb'
  });
  assert.equal(provenance.runtime.dotnet.sha256, '21a46f1e5235cf4e844b9de5429f0e198b9c97a41f0503a66442f1d639ca3ee6');
  assert.equal(provenance.runtime.jellyfinDll.sha256, '14a821378e554f3a1476610b02ef7ad3795fbb4050872413180ee423bd612d01');
  assert.equal(provenance.record.sourceFilesSha256, '25079fbb48f87ca6dcaff691bb805543521911dcd07d4baf9ec22576c03f99a1');
  assert.equal(provenance.record.oracleAssemblySha256, '56f977570c9dd18ef445b5771068c3770ea978006702cd8f224c8e7d05581e15');
  assert.equal(provenance.candidateVerified, true); assert.equal(differences.candidateVerified, true);
  assert.equal(differences.supportedScenes.length + differences.withheldScenes.length, input.length);
  assert.deepEqual(new Set([...differences.supportedScenes, ...withheld]), new Set(input.map(sample => sample.name)));
  assert.deepEqual(new Set(differences.supportedScenes), new Set(input.filter(sample => !withheld.has(sample.name)).map(sample => sample.name)));
  assert.equal(differences.withheldScenes.every(scene => input.find(sample => sample.name === scene.name)?.candidateControl), true);
  for (const name of ['audio-db-only', 'book-db-only', 'audio-delete-source', 'book-delete-source']) {
    const result = byName.get(name);
    assert.deepEqual(result.calls.map(call => call.action), ['plan', 'external', 'delete', 'event']);
    assert.equal(result.calls[1].state.internalExists, false);
    assert.equal(result.calls[1].state.sourceExists, !name.includes('delete-source'));
    assert.equal(result.calls[2].state.externalExists, false);
    assert.equal(result.calls[3].state.databaseExists, false);
  }
  assert.deepEqual(byName.get('audio-channel-failure').calls.map(call => call.action), ['plan', 'channel']);
  assert.deepEqual(byName.get('audio-source-io-failure').calls.map(call => call.action), ['plan']);
  assert.deepEqual(byName.get('audio-external-failure').calls.map(call => call.action), ['plan', 'external']);
  assert.deepEqual(byName.get('audio-sql-failure').calls.map(call => call.action), ['plan', 'external', 'delete']);
  assert.deepEqual(byName.get('audio-mixed-source').files, ['$STATE\\media\\sibling.keep']);
  for (const name of ['audio-owned-closure', 'audio-child-closure']) {
    const result = byName.get(name);
    assert.equal(result.rows.some(row => row.id.endsWith('0004')), false);
    assert.equal(result.files.some(file => file.endsWith('closure.flac')), true);
    assert.equal(result.files.some(file => file.includes('a1100000000000000000000000000004')), true);
  }
  assert.equal(byName.get('audio-owned-item').calls.at(-1).parentId, 'a1100000-0000-0000-0000-000000000002');
  for (const name of ['audio-owned-item-default-parent', 'audiobook-owned-item-default-parent',
    'book-owned-item-source-default-parent']) {
    assert.equal(byName.get(name).calls.at(-1).parentId, 'a1100000-0000-0000-0000-000000000003');
  }
  assert.equal(byName.get('book-owned-item-source-default-parent').files.includes('$STATE\\media\\book.epub'), false);
  assert.equal(native.scope.includes('non-cancellable API'), true);
});

for (const dialect of ['postgres']) for (const sample of input.filter(sample => !withheld.has(sample.name))) test(`${dialect}: actual ${sample.name}`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const value = await setup(t, dialect, sample), expected = byName.get(sample.name);
  let error = null;
  try { await value.operation(); } catch (caught) { error = caught; }
  assert.equal(Boolean(error), expected.exception != null, error?.stack);
  assert.deepEqual(value.calls.map(call => call.action), expected.calls.slice(1).map(call => call.action));
  for (const [index, call] of value.calls.entries()) if (call.state) {
    assert.deepEqual(call.state, expected.calls[index + 1].state);
  }
  const final = await value.state();
  assert.deepEqual(value.calls.map(call => ({ ...call, state: call.state ?? final })), expected.calls.slice(1));
  const expectedSource = sample.internalItem ? `$STATE\\metadata\\${internalFolder(sample).replaceAll('/', '\\')}`
    : sample.stateSource ? `$STATE\\data\\collections\\${sourceName(sample)}` : `$STATE\\media\\${sourceName(sample)}`;
  assert.equal(final.sourceExists, expected.files.some(file => file === expectedSource || file.startsWith(`${expectedSource}\\`)));
  const mediaFiles = async directory => {
    try { await value.fixture.vfs.stat(directory); }
    catch (error) { if (error.code === 'not-found') return []; throw error; }
    const listing = await value.fixture.vfs.list(directory), files = [];
    for (const entry of listing.entries) {
      const filename = `${directory}/${entry.name}`;
      if (entry.kind === 'file') files.push(filename.slice('/leaf-write/media/'.length).replaceAll('/', '\\'));
      else files.push(...await mediaFiles(filename));
    }
    return files;
  };
  // Fault injection is specific to DeleteItem's enumeration; the final state
  // projection reads the actual adapter again after that invocation finishes.
  if (sample.enumerationFailure || sample.partialEnumerationFailure) value.fixture.adapter.listPage = value.originalListPage;
  assert.deepEqual((await mediaFiles('/leaf-write/media')).sort(), expected.files.filter(file => file.startsWith('$STATE\\media\\'))
    .map(file => file.slice('$STATE\\media\\'.length)).sort());
  assert.equal(final.internalExists, expected.files.some(file => file.includes('\\metadata\\')
    && file.includes('a1100000000000000000000000000001') && file.endsWith('marker.txt')));
  assert.equal(final.externalExists, expected.files.some(file => file.startsWith('$STATE\\external\\a1100000-0000-0000-0000-000000000001')));
  assert.equal(final.databaseExists, expected.targetLookup);
  const rows = (await value.fixture.database.rows('BaseItems')).map(row => ({
    id: guid(row.Id), type: row.Type, parentId: row.ParentId ? guid(row.ParentId) : null,
    ownerId: row.OwnerId ? guid(row.OwnerId) : null, primaryVersionId: row.PrimaryVersionId ? guid(row.PrimaryVersionId) : null
  })).sort((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(rows, expected.rows);
  assert.equal(guid(value.item.ParentId), expected.targetParentId);
  assert.equal(readCachedFolderChildren(value.parent, {}, () => null) === null, expected.parentChildrenCleared);
  assert.equal(value.parent.UserData === null, expected.parentUserDataCleared);
  assert.equal(value.calls.some(call => call.action === 'event'), expected.calls.some(call => call.action === 'event'));
  if (value.closure) assert.equal(await value.creator.getItemById(ids.closure) != null, expected.closureLookup);
  await value.creator.close();
});

for (const dialect of ['postgres']) for (const sample of input.filter(sample => withheld.has(sample.name))) test(`${dialect}: withhold ${sample.name} before side effects`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const value = await setup(t, dialect, sample);
  const before = await value.fixture.database.rows('BaseItems'), source = await value.state();
  await assert.rejects(value.operation(), { status: 501 });
  assert.deepEqual(await value.fixture.database.rows('BaseItems'), before);
  assert.deepEqual(await value.state(), source);
  assert.deepEqual(value.calls, []);
  assert.equal(value.item.ParentId, ids.parent);
  assert.deepEqual(readCachedFolderChildren(value.parent, {}, () => { throw new Error('parent cache invalidated'); }), [value.item]);
  assert.equal(value.parent.UserData === null, false);
  await value.creator.close();
});

for (const dialect of ['postgres']) {
  const options = { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES };
  for (const deleteSource of [false, true]) test(`${dialect}: Book extension-named directory ${deleteSource ? 'deletes only its actual source' : 'preserves source during DB-only deletion'}`, options, async t => {
    // BookResolver.GetBook accepts its one extension-matching child regardless
    // of physical kind, as in the existing book-extension-named-directory case.
    const value = await setup(t, dialect, { ...input.find(sample => sample.name === 'book-db-only'),
      sourceDirectory: true, deleteSource, sidecars: ['book.nfo'] });
    assert.equal(value.item.Type, 'Book');
    assert.equal(value.item.IsFolder, false);
    assert.equal((await value.fixture.vfs.stat(value.sourceAccess)).kind, 'directory');
    const deleted = [], remove = value.fixture.adapter.delete.bind(value.fixture.adapter);
    value.fixture.adapter.delete = async (location, settings) => {
      deleted.push({ location, recursive: settings?.recursive === true });
      assert.equal((await value.state()).internalExists, false, 'internal metadata is cleaned before source deletion');
      return remove(location, settings);
    };

    await value.operation();

    assert.deepEqual(deleted, deleteSource ? [{ location: '/media/book.epub', recursive: true }] : []);
    assert.deepEqual(await value.state(), { sourceExists: !deleteSource, internalExists: false,
      externalExists: false, databaseExists: false, parentId: guid(EMPTY_ID) });
    assert.equal(await value.creator.getItemById(value.item.Id), null);
    assert.deepEqual((await value.fixture.database.rows('BaseItems')).map(row => guid(row.Id)), [guid(ids.parent)]);
    assert.equal(readCachedFolderChildren(value.parent, {}, () => null), null);
    assert.deepEqual(value.calls.map(call => call.action), ['external', 'delete', 'event']);
    for (const filename of ['sibling.keep', 'book.nfo', 'track.nfo', 'track-cover.jpg']) {
      assert.equal((await value.fixture.vfs.stat(`/leaf-write/media/${filename}`)).kind, 'file');
    }
    if (!deleteSource) assert.equal((await value.fixture.vfs.stat(`${value.sourceAccess}/source.txt`)).kind, 'file');
    assert.equal((await value.fixture.vfs.stat('/leaf-write/media')).kind, 'directory');
  });
  for (const scene of [
    { name: 'movie-mixed-source', removed: ['/media/track.strm', '/media/track.nfo', '/media/track-cover.jpg'],
      remaining: ['sibling.keep'] },
    { name: 'movie-directory-source', removed: ['/media'], remaining: null },
    { name: 'episode-file-source', removed: ['/media/track.strm'],
      remaining: ['sibling.keep', 'track-cover.jpg', 'track.nfo'] }
  ]) test(`${dialect}: ${scene.name} deletes local STRM sources without following their remote target`, options, async t => {
    const value = await setup(t, dialect, { ...input.find(sample => sample.name === scene.name),
      sourceName: 'track.strm', shortcut: true });
    const remoteTarget = value.item.ShortcutPath;
    assert.equal(remoteTarget, 'https://example.invalid/source');
    assert.equal(value.item.IsShortcut, true);
    assert.equal(value.item.VideoType, 'VideoFile');
    await value.fixture.adapter.write('/media/track.strm', Buffer.from(`${remoteTarget}\n`));
    await value.fixture.adapter.write('/outside.keep', Buffer.from('outside'));
    const removed = [], remove = value.fixture.adapter.delete.bind(value.fixture.adapter);
    value.fixture.adapter.delete = async (location, settings) => {
      removed.push(location);
      return remove(location, settings);
    };

    await value.operation();

    assert.deepEqual(removed.sort(), [...scene.removed].sort());
    const final = await value.state();
    assert.equal(final.sourceExists, false);
    assert.equal(final.databaseExists, false);
    assert.equal(final.internalExists, false);
    assert.equal(final.externalExists, false);
    assert.equal(Boolean(await value.creator.getItemById(value.item.Id)), false);
    assert.deepEqual((await value.fixture.database.rows('BaseItems')).map(row => guid(row.Id)), [guid(ids.parent)]);
    assert.deepEqual(value.calls.map(call => call.action), ['external', 'delete', 'event']);
    assert.equal((await value.fixture.vfs.stat('/leaf-write/outside.keep')).kind, 'file');
    if (scene.remaining === null) await assert.rejects(value.fixture.vfs.stat('/leaf-write/media'), { code: 'not-found' });
    else assert.deepEqual((await value.fixture.vfs.list('/leaf-write/media')).entries.map(entry => entry.name).sort(), scene.remaining);
  });
  for (const scene of [
    { name: 'movie-mixed-source', sourceName: 'track.disc', videoType: 'VideoFile', remaining: ['sibling.keep'] },
    { name: 'movie-directory-source', sourceName: 'track.dvd.disc', videoType: 'Dvd', remaining: null },
    { name: 'episode-file-source', sourceName: 'track.bluray.disc', videoType: 'BluRay',
      remaining: ['sibling.keep', 'track-cover.jpg', 'track.nfo'] },
    { name: 'movie-mixed-source', sourceName: 'track.iso', videoType: 'Iso', placeholder: false, remaining: ['sibling.keep'] },
    { name: 'movie-directory-source', sourceName: 'track.dvd.iso', videoType: 'Iso', placeholder: false, remaining: null },
    { name: 'episode-file-source', sourceName: 'track.bluray.img', videoType: 'Iso', placeholder: false,
      remaining: ['sibling.keep', 'track-cover.jpg', 'track.nfo'] }
  ]) test(`${dialect}: ${scene.sourceName} uses ${scene.name} deletion paths`, options, async t => {
    const value = await setup(t, dialect, { ...input.find(sample => sample.name === scene.name),
      sourceName: scene.sourceName, videoType: scene.videoType, placeholder: scene.placeholder ?? true });
    assert.equal(value.item.IsPlaceHolder, scene.placeholder ?? true);
    assert.equal(value.item.VideoType, scene.videoType);
    await value.fixture.adapter.write('/outside.keep', Buffer.from('outside'));

    await value.operation();

    const final = await value.state();
    assert.equal(final.sourceExists, false);
    assert.equal(final.databaseExists, false);
    assert.equal(final.internalExists, false);
    assert.equal(final.externalExists, false);
    assert.equal(Boolean(await value.creator.getItemById(value.item.Id)), false);
    assert.deepEqual((await value.fixture.database.rows('BaseItems')).map(row => guid(row.Id)), [guid(ids.parent)]);
    assert.equal((await value.fixture.vfs.stat('/leaf-write/outside.keep')).kind, 'file');
    if (scene.remaining === null) await assert.rejects(value.fixture.vfs.stat('/leaf-write/media'), { code: 'not-found' });
    else assert.deepEqual((await value.fixture.vfs.list('/leaf-write/media')).entries.map(entry => entry.name).sort(), scene.remaining);
  });
  test(`${dialect}: managed BoxSet source deletion rejects a different state root before side effects`, options, async t => {
    const value = await setup(t, dialect, input.find(sample => sample.name === 'boxset-state-source'));
    const wrong = path.join(value.fixture.stateRoot, 'data', 'not-collections', 'Target [boxset]');
    await value.assets.write(path.join(wrong, 'source.txt'), Buffer.from('wrong-root'));
    await value.fixture.database.update('BaseItems', { Id: value.item.Id }, { Path: wrong });
    value.item.Path = wrong;
    const before = await value.fixture.database.rows('BaseItems'), state = await value.state();
    await assert.rejects(value.operation(), { status: 501 });
    assert.deepEqual(await value.fixture.database.rows('BaseItems'), before);
    assert.deepEqual(await value.state(), state);
    assert.equal((await value.assets.stat(wrong)).kind, 'directory');
    assert.deepEqual(value.calls, []);
  });
  test(`${dialect}: managed BoxSet source deletion cannot remove the shared collections root`, options, async t => {
    const value = await setup(t, dialect, input.find(sample => sample.name === 'boxset-state-source'));
    const rootPath = path.join(value.fixture.stateRoot, 'data', 'collections');
    await value.fixture.database.update('BaseItems', { Id: value.item.Id }, { Path: rootPath });
    value.item.Path = rootPath;
    const before = await value.fixture.database.rows('BaseItems'), state = await value.state();
    await assert.rejects(value.operation(), { status: 501 });
    assert.deepEqual(await value.fixture.database.rows('BaseItems'), before);
    assert.deepEqual(await value.state(), state);
    assert.equal((await value.assets.stat(rootPath)).kind, 'directory');
    assert.deepEqual(value.calls, []);
  });
  test(`${dialect}: by-name deletion rejects a different internal type root before side effects`, options, async t => {
    const value = await setup(t, dialect, input.find(sample => sample.name === 'person-internal-delete'));
    const wrong = path.join(value.fixture.stateRoot, 'metadata', 'Genre', 'Target');
    await value.assets.write(path.join(wrong, 'source.txt'), Buffer.from('wrong-root'));
    await value.fixture.database.update('BaseItems', { Id: value.item.Id }, { Path: wrong });
    value.item.Path = wrong;
    const before = await value.fixture.database.rows('BaseItems'), state = await value.state();
    await assert.rejects(value.operation(), { status: 501 });
    assert.deepEqual(await value.fixture.database.rows('BaseItems'), before);
    assert.deepEqual(await value.state(), state);
    assert.equal((await value.assets.stat(wrong)).kind, 'directory');
    assert.deepEqual(value.calls, []);
  });
  test(`${dialect}: by-name deletion cannot remove its shared internal root`, options, async t => {
    const value = await setup(t, dialect, input.find(sample => sample.name === 'person-internal-delete'));
    const rootPath = path.join(value.fixture.stateRoot, 'metadata', 'People');
    await value.fixture.database.update('BaseItems', { Id: value.item.Id }, { Path: rootPath });
    value.item.Path = rootPath;
    const before = await value.fixture.database.rows('BaseItems'), state = await value.state();
    await assert.rejects(value.operation(), { status: 501 });
    assert.deepEqual(await value.fixture.database.rows('BaseItems'), before);
    assert.deepEqual(await value.state(), state);
    assert.equal((await value.assets.stat(rootPath)).kind, 'directory');
    assert.deepEqual(value.calls, []);
  });
  test(`${dialect}: DB-only container source-shape drift fails before side effects`, options, async t => {
    const value = await setup(t, dialect, input.find(sample => sample.name === 'photoalbum-db-only'));
    value.item.IsVirtualItem = !value.item.IsVirtualItem;
    const before = await value.state(), rows = await value.fixture.database.rows('BaseItems');
    await assert.rejects(value.operation(), { status: 501 });
    assert.deepEqual(await value.state(), before);
    assert.deepEqual(await value.fixture.database.rows('BaseItems'), rows);
    assert.deepEqual(value.calls, []);
  });
  for (const [field, replacement] of [['IsInMixedFolder', false], ['IsVirtualItem', true], ['ChannelId', ids.channel], ['IsPlaceHolder', true]]) {
    test(`${dialect}: video ${field} drift fails before source or metadata cleanup`, options, async t => {
      const value = await setup(t, dialect, input.find(sample => sample.name === 'movie-mixed-source'));
      value.item[field] = replacement;
      const rows = await value.fixture.database.rows('BaseItems'), before = await value.state();
      await assert.rejects(value.operation(), { status: 501 });
      assert.deepEqual(await value.fixture.database.rows('BaseItems'), rows);
      assert.deepEqual(await value.state(), before);
      assert.deepEqual(value.calls, []);
      assert.deepEqual(readCachedFolderChildren(value.parent, {}, () => { throw new Error('parent cache invalidated'); }), [value.item]);
    });
  }
  for (const type of ['Trailer']) test(`${dialect}: ${type} directory disc remains withheld before side effects`, options, async t => {
    const value = await setup(t, dialect, input.find(sample => sample.type === type && sample.deleteSource));
    await value.fixture.adapter.mkdir('/media/disc');
    await value.fixture.adapter.write('/media/disc/marker.vob', Buffer.from('disc'));
    const [row] = await value.fixture.database.rows('BaseItems', { where: { Id: value.item.Id } });
    value.item.Path = 'Z:\\LeafDeletion\\disc'; value.item.VideoType = 'Dvd';
    await value.fixture.database.update('BaseItems', { Id: value.item.Id }, {
      Path: value.item.Path, Data: JSON.stringify({ ...JSON.parse(row.Data), VideoType: 'Dvd' })
    });
    const rows = await value.fixture.database.rows('BaseItems'), before = await value.state();
    await assert.rejects(value.operation(), { status: 501 });
    assert.deepEqual(await value.fixture.database.rows('BaseItems'), rows);
    assert.deepEqual(await value.state(), before);
    assert.equal((await value.fixture.vfs.stat('/leaf-write/media/disc/marker.vob')).kind, 'file');
    assert.deepEqual(value.calls, []);
  });
  for (const mode of ['readonly', 'root']) test(`${dialect}: mixed leaf ${mode} binding fails before cleanup`, options, async t => {
    const value = await setup(t, dialect, input.find(sample => sample.name === 'audio-mixed-source'));
    const mount = `/leaf-${mode}`;
    value.fixture.vfs.mount({ path: mount, instanceId: 'fixture', capabilities: mode === 'readonly' ? {} : { delete: true } });
    value.fixture.identityMap.bind(value.item.Id, mode === 'readonly' ? `${mount}/media/track.flac` : mount);
    const before = await value.state(), rows = await value.fixture.database.rows('BaseItems');
    await assert.rejects(value.operation(), { code: mode === 'readonly' ? 'not-supported' : 'permission-denied' });
    assert.deepEqual(await value.state(), before);
    assert.deepEqual(await value.fixture.database.rows('BaseItems'), rows);
    assert.deepEqual(value.calls, []);
  });

  test(`${dialect}: explicit mixed deletion accepts a complete weak listing`, options, async t => {
    const value = await setup(t, dialect, input.find(sample => sample.name === 'audio-mixed-source'));
    const list = value.originalListPage;
    value.fixture.adapter.listPage = async (...args) => ({ ...await list(...args), consistency: 'weak', snapshot: null, deletionSafe: false });
    await value.operation();
    assert.equal((await value.state()).databaseExists, false);
    assert.deepEqual((await value.fixture.vfs.list('/leaf-write/media')).entries.map(entry => entry.name), ['sibling.keep']);
  });

  for (const code of ['permission-denied', 'invalid-response']) test(`${dialect}: optional mixed sidecar ${code} preserves its failure boundary`, options, async t => {
    const value = await setup(t, dialect, input.find(sample => sample.name === 'audio-mixed-source'));
    const remove = value.fixture.adapter.delete.bind(value.fixture.adapter);
    value.fixture.adapter.delete = async (location, settings) => {
      if (location === '/media/track.nfo') throw Object.assign(new Error('Controlled sidecar failure'), { code });
      return remove(location, settings);
    };
    if (code === 'permission-denied') await value.operation();
    else await assert.rejects(value.operation(), { code });
    const state = await value.state();
    assert.equal(state.sourceExists, false); assert.equal(state.internalExists, false);
    assert.equal(state.databaseExists, code === 'invalid-response');
    assert.equal(state.externalExists, code === 'invalid-response');
    assert.equal(state.parentId, code === 'invalid-response' ? guid(ids.parent) : guid(EMPTY_ID));
    assert.equal((await value.fixture.vfs.stat('/leaf-write/media/track.nfo')).kind, 'file');
    if (code === 'permission-denied') await assert.rejects(value.fixture.vfs.stat('/leaf-write/media/track-cover.jpg'), { code: 'not-found' });
    else assert.equal((await value.fixture.vfs.stat('/leaf-write/media/track-cover.jpg')).kind, 'file');
  });

  test(`${dialect}: mixed deletion preserves sidecars hidden by a mount directory`, options, async t => {
    const value = await setup(t, dialect, input.find(sample => sample.name === 'audio-mixed-source'));
    value.fixture.vfs.mount({ path: '/leaf-write/media/track.nfo', instanceId: 'fixture', capabilities: {} });
    await value.operation();
    assert.equal((await value.state()).databaseExists, false);
    assert.equal((await value.fixture.adapter.stat('/media/track.nfo')).kind, 'file');
    assert.equal((await value.fixture.vfs.stat('/leaf-write/media/track.nfo')).kind, 'directory');
  });

  test(`${dialect}: mixed deletion uses the ID binding with the native identity filename`, options, async t => {
    const value = await setup(t, dialect, input.find(sample => sample.name === 'audio-mixed-source'));
    await value.fixture.adapter.mkdir('/alias');
    for (const filename of ['renamed.flac', 'track.nfo', 'TRACK-cover.jpg', 'renamed.nfo']) {
      await value.fixture.adapter.write(`/alias/${filename}`, Buffer.from(filename));
    }
    value.fixture.identityMap.bind(value.item.Id, '/leaf-write/alias/renamed.flac');
    await value.operation();
    assert.equal((await value.state()).databaseExists, false);
    assert.equal((await value.state()).sourceExists, true);
    assert.deepEqual((await value.fixture.vfs.list('/leaf-write/alias')).entries.map(entry => entry.name), ['renamed.nfo']);
    assert.equal((await value.fixture.vfs.stat('/leaf-write/media/track.nfo')).kind, 'file');
  });
}
