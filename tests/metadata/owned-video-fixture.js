import { testFileSystem } from '../storage/plugin-files.js';
import { observeBaseItemDeletes } from '../database/postgres-faults.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseLosslessJson } from '../../src/core/json.js';
import { dateText, EMPTY_ID, MIN_DATE, guid, idKey, mapRecord } from '../../src/library/records.js';
import { nativeGuid } from '../../src/users/native.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { resolveOrdinaryVideoFile } from '../../src/library/video-file-resolver.js';
import { persistMetadata } from '../../src/metadata/persistence.js';
import { internalImagePath } from '../../src/metadata/image-paths.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { readCachedFolderChildren, setFolderChildren } from '../../src/library/folder-cache.js';
import { setupChildrenFixture } from './children-fixture.js';
import { prepareIgnoreFileFixture, projectAncestorIgnoreFiles, ensureFixtureDirectory } from '../library/ignore-file-fixture.js';
const ownerId = '98c00000-0000-0000-0000-000000000001', parentId = '98c00000-0000-0000-0000-000000000002';
const typeName = type => `MediaBrowser.Controller.Entities.${type === 'Movie' ? 'Movies.' : ''}${type}`;
const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const integer = value => typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
const videoData = () => ({ AdditionalParts: [], LocalAlternateVersions: [], LinkedAlternateVersions: [], SubtitleFiles: [], AudioFiles: [],
  HasSubtitles: false, IsPlaceHolder: false, VideoType: 'VideoFile', IsHD: false, IsShortcut: false,
  Width: 0, Height: 0, DateLastSaved: MIN_DATE, RemoteTrailers: [] });
const folderData = () => ({ IsRoot: false, IsHD: false, IsShortcut: false, Width: 0, Height: 0, DateLastSaved: MIN_DATE, RemoteTrailers: [] });

export function projectItem(item, stateRoot) {
  const normalize = value => value?.replace(stateRoot, '$STATE') ?? null;
  return { id: guid(item.Id), type: item.NativeType, name: item.Name, path: normalize(item.Path),
    parentId: guid(item.ParentId ?? EMPTY_ID), ownerId: guid(item.OwnerId ?? EMPTY_ID),
    primaryVersionId: item.PrimaryVersionId ? guid(item.PrimaryVersionId) : null,
    mixed: item.IsInMixedFolder ?? false, locked: item.IsLocked ?? false, productionYear: item.ProductionYear ?? null,
    size: integer(item.Size ?? null), runTimeTicks: item.RunTimeTicks ?? null,
    dateCreated: dateText(item.DateCreated ?? MIN_DATE), dateModified: dateText(item.DateModified ?? MIN_DATE),
    dateLastSavedSet: item.DateLastSaved != null && dateText(item.DateLastSaved) !== MIN_DATE,
    videoType: item.VideoType ?? 'VideoFile', extraType: typeof item.ExtraType === 'number'
      ? ['Unknown', 'Clip', 'Trailer', 'BehindTheScenes', 'DeletedScene', 'Interview', 'Scene', 'Sample', 'ThemeSong', 'ThemeVideo', 'Featurette', 'Short'][item.ExtraType]
      : item.ExtraType ?? null,
    parts: (item.AdditionalParts ?? []).map(normalize), alternates: (item.LocalAlternateVersions ?? []).map(normalize),
    genres: item.Genres ?? [], overview: item.Overview ?? null };
}

export async function setup(t, dialect, sample) {
  const fixture = await setupChildrenFixture(t, dialect), calls = [];
  fixture.configuration.EnableCaseSensitiveItemIds = true;
  const directory = path.join(fixture.stateRoot, 'media'), nativePath = name => directory + path.sep + name;
  const target = nativePath(sample.files[0]);
  fixture.vfs.mount({ path: '/owned-discovery-write', instanceId: 'fixture', capabilities: { create: true, replace: true, mkdir: true, delete: true } });
  fixture.identityMap.addPrefix({ identityRoot: directory, accessRoot: '/owned-discovery-write/owned-discovery', style: 'windows', returnAccess: 'isolated owned video discovery controls' });
  await fixture.adapter.mkdir('/owned-discovery');
  await prepareIgnoreFileFixture(fixture, sample.ignoreFiles);
  await fixture.adapter.write('/owned-discovery/primary.mkv', Buffer.from('primary control'));
  for (const filename of sample.files) {
    await ensureFixtureDirectory(fixture, path.posix.dirname('/owned-discovery-write/owned-discovery/' + filename));
    await fixture.adapter.write('/owned-discovery/' + filename,
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('media control')]), { modified: '2025-01-03T04:05:06.0000000Z' });
  }
  // Media access and bytes remain VFS operations; only creation time is controlled.
  const stat = fixture.adapter.stat.bind(fixture.adapter);
  fixture.adapter.stat = async (...args) => {
    const result = await stat(...args);
    return result.kind === 'file' ? { ...result, created: '2025-01-02T03:04:05.0000000Z' } : result;
  };
  const loader = createMetadataContextLoader({fileSystem: testFileSystem,  ...fixture, videoPathResolver: (candidate, options) => {
    // Read-only D3 destination preflight has no equivalent native dispatch.
    if (!options.preview) calls.push({ action: 'resolve', path: candidate.identityPath.replace(fixture.stateRoot, '$STATE') });
    return resolveOrdinaryVideoFile(candidate, { ...options, nativeType: typeName(sample.resolverType), parseName: sample.parseName });
  } });
  fixture.loadContext = fixture.host.loadContext = loader;
  const definitions = [
    { key: 'parent', type: 'Folder', Id: parentId, Name: 'Parent', Path: directory },
    { key: 'owner', type: sample.expectedType, Id: ownerId, Name: 'Stored owner', parent: 'parent',
      Path: path.join(directory, 'primary.mkv'), IsInMixedFolder: sample.mixed }
  ];
  await fixture.seed({ target: 'owner', items: definitions });
  let loaded = await loader(ownerId);
  const oldType = sample.wrongType ? 'Video' : sample.expectedType;
  const oldId = nativeGuid(loaded.getNewItemId(target, typeName(oldType)));
  if (sample.wrongType || sample.existingType) definitions.push({ key: 'old', type: oldType, Id: oldId,
    Name: 'Old version', Path: target, parent: 'parent', OwnerId: ownerId,
    ...(sample.runtimeTicks ? { RunTimeTicks: BigInt(sample.runtimeTicks) } : {}),
    ...(sample.isAlternate && !sample.wrongType ? { PrimaryVersionId: ownerId, PresentationUniqueKey: idKey(ownerId) } : {}) });
  await fixture.seed({ target: 'owner', items: definitions });
  for (const definition of definitions) await fixture.database.update('BaseItems', { Id: definition.Id }, {
    DateCreated: null, DateModified: null, DateLastSaved: null, DateLastRefreshed: null,
    Data: JSON.stringify(definition.type === 'Folder' ? folderData() : videoData())
  });
  loaded = await loader(ownerId);
  if (sample.wrongType || sample.existingType) {
    const old = await loaded.videoVersionDiscovery.lookup(loaded, oldId);
    const assets = new MetadataImageAssets({fileSystem: testFileSystem,  vfs: fixture.vfs, identityMap: fixture.identityMap,
      metadataPath: loaded.metadataPath, stateRoots: [loaded.dataPath] });
    for (const directory of new Set([internalImagePath(old, loaded.metadataPath), ...loaded.videoVersionDiscovery.externalData.paths(old, loaded)]))
      await assets.write(path.join(directory, 'marker.txt'), Buffer.from('owned marker'));
  }
  loaded.parent.UserData = []; setFolderChildren(loaded.parent, [loaded.item]);
  if (sample.missing) await fixture.adapter.delete('/owned-discovery/' + sample.files[0]);
  loaded.item.Name = 'Updated owner'; loaded.item.Genres = ['Owner genre']; loaded.item.Overview = 'Owner overview';
  const ownedPaths = (sample.versions ?? sample.files).map(nativePath);
  loaded.item.AdditionalParts = sample.isAlternate ? [] : ownedPaths;
  loaded.item.LocalAlternateVersions = sample.isAlternate ? ownedPaths : [];
  const external = loaded.videoVersionDiscovery.externalData, deleteFiles = external.deleteItemFiles.bind(external);
  external.deleteItemFiles = (item, options) => { calls.push({ action: 'external-files', id: guid(item.Id) }); return deleteFiles(item, options); };
  const insert = fixture.database.insert.bind(fixture.database);
  fixture.database.insert = async (table, row) => {
    if (table === 'BaseItems') calls.push({ action: 'save', items: [projectItem(mapRecord(row), fixture.stateRoot)], cancellable: false });
    return insert(table, row);
  };
  observeBaseItemDeletes(fixture.database, ids => calls.push({ action: 'delete', ids: ids.map(guid) }));
  for (const [name, kind] of [['ItemAdded', 'added'], ['ItemRemoved', 'removed'], ['ItemUpdated', 'updated']]) fixture.host.updates.on(name,
    event => calls.push({ action: 'event', kind, id: guid(event.Item.Id), ...(kind === 'updated' ? { reason: event.UpdateReason } : {}) }));
  const updateRepository = fixture.host.updates.updateRepository.bind(fixture.host.updates);
  fixture.host.updates.updateRepository = (loaded, result, reason, options) => updateRepository(loaded, result, reason, {
    ...options,
    saverOperation: async () => { calls.push({ action: 'saver', id: guid(loaded.item.Id), reason }); return []; },
    persist: async (updated, result, options) => {
      calls.push({ action: 'save', items: [updated.item, ...options.newVersions].map(item => projectItem(item, fixture.stateRoot)), cancellable: true });
      return persistMetadata(fixture.store, loaded, result, options);
    }
  });
  if (sample.newFailure) {
    const action = sample.newFailure === 'delete' ? 'DELETE' : 'INSERT';
    await fixture.database.client.query(`CREATE FUNCTION owned_discovery_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Controlled owned discovery failure'; END $$`);
    await fixture.database.client.query(`CREATE TRIGGER owned_discovery_failure BEFORE ${action} ON "BaseItems" FOR EACH ROW EXECUTE FUNCTION owned_discovery_failure()`);
  }
  const cold = [];
  return { fixture, loaded, calls, oldId, childrenCleared: () => readCachedFolderChildren(loaded.parent, null, () => cold) === cold };
}

export async function project(value, sample, exception) {
  const { fixture, loaded, calls, oldId, childrenCleared } = value;
  const normalize = name => name?.replace(fixture.stateRoot, '$STATE') ?? null;
  const rows = (await fixture.database.rows('BaseItems')).filter(row => row.Type !== 'PLACEHOLDER').map(row => ({
    id: guid(row.Id), type: row.Type, name: row.Name, path: normalize(row.Path), parentId: row.ParentId && guid(row.ParentId),
    topParentId: row.TopParentId && guid(row.TopParentId), ownerId: row.OwnerId && guid(row.OwnerId), primaryVersionId: row.PrimaryVersionId && guid(row.PrimaryVersionId),
    presentationUniqueKey: row.PresentationUniqueKey, mixed: row.IsInMixedFolder, locked: row.IsLocked,
    productionYear: row.ProductionYear, size: integer(row.Size), runTimeTicks: row.RunTimeTicks,
    dateCreated: row.DateCreated && dateText(row.DateCreated), dateModified: row.DateModified && dateText(row.DateModified),
    dateLastSavedSet: row.DateLastSaved != null, data: rewriteSavedData(parseLosslessJson(row.Data), row)
  })).sort((a, b) => ordinal(a.id, b.id));
  function rewriteSavedData(data, row) {
    const rewrite = value => Array.isArray(value) ? value.map(rewrite) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, entry]) => {
        if (key !== 'DateLastSaved' || entry === MIN_DATE) return [key, rewrite(entry)];
        assert.equal(dateText(entry), dateText(fixture.now));
        assert.equal(dateText(row.DateLastSaved), dateText(entry));
        return [key, '$UTC_SAVE'];
      })) : typeof value === 'string' ? normalize(value) : value;
    return rewrite(data);
  }
  const links = (await fixture.database.rows('LinkedChildren')).map(row => ({ parentId: guid(row.ParentId), childId: guid(row.ChildId), childType: row.ChildType, sortOrder: row.SortOrder }))
    .sort((a, b) => ordinal(a.parentId, b.parentId) || a.sortOrder - b.sortOrder);
  const files = [];
  const hashFile = (name, bytes) => files.push({ path: normalize(name), sha256: createHash('sha256').update(bytes).digest('hex') });
  const localFiles = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await localFiles(child); else hashFile(child, await readFile(child));
    }
  };
  await localFiles(fixture.stateRoot);
  const mediaFiles = async accessPath => {
    for (const entry of (await fixture.vfs.list(accessPath)).entries) {
      const child = path.posix.join(accessPath, entry.name);
      if (entry.kind === 'directory') await mediaFiles(child);
      else {
        const handle = await fixture.vfs.openRead(child), chunks = [];
        try { for await (const chunk of handle.stream) chunks.push(Buffer.from(chunk)); } finally { await handle.close(); }
        hashFile(path.join(fixture.stateRoot, 'media', path.posix.relative('/owned-discovery-write/owned-discovery', child)), Buffer.concat(chunks));
      }
    }
  };
  await mediaFiles('/owned-discovery-write/owned-discovery');
  await projectAncestorIgnoreFiles(fixture, hashFile);
  files.sort((a, b) => ordinal(a.path, b.path));
  const old = sample.wrongType || sample.existingType ? await loaded.videoVersionDiscovery.lookup(loaded, oldId) : null;
  return { name: sample.name, exception, liveOwner: projectItem(loaded.item, fixture.stateRoot), calls, rows, links, files,
    parentChildrenCleared: childrenCleared(), parentUserDataCleared: loaded.parent.UserData === null, oldLookupName: old?.Name ?? null };
}
