import { testFileSystem } from '../storage/plugin-files.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseLosslessJson } from '../../src/core/json.js';
import { dateText, EMPTY_ID, MIN_DATE, guid, idKey, mapRecord } from '../../src/library/records.js';
import { nativeGuid } from '../../src/users/native.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { resolveOrdinaryVideoFile } from '../../src/library/video-file-resolver.js';
import { internalImagePath } from '../../src/metadata/image-paths.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { readCachedFolderChildren, setFolderChildren } from '../../src/library/folder-cache.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';
import { prepareIgnoreFileFixture, projectAncestorIgnoreFiles, ensureFixtureDirectory } from './ignore-file-fixture.js';
const ids = { owner: '98C00000-0000-0000-0000-000000000001', parent: '98C00000-0000-0000-0000-000000000002' };
// Independent constructor defaults, as recorded by the real native mapper.
export const videoData = () => ({ AdditionalParts: [], LocalAlternateVersions: [], LinkedAlternateVersions: [], SubtitleFiles: [], AudioFiles: [],
  HasSubtitles: false, IsPlaceHolder: false, VideoType: 'VideoFile', IsHD: false, IsShortcut: false,
  Width: 0, Height: 0, DateLastSaved: MIN_DATE, RemoteTrailers: [] });
export const folderData = () => ({ IsRoot: false, IsHD: false, IsShortcut: false, Width: 0, Height: 0, DateLastSaved: MIN_DATE, RemoteTrailers: [] });
export const typeName = name => `MediaBrowser.Controller.Entities.${name === 'Movie' ? 'Movies.' : name === 'Episode' ? 'TV.' : ''}${name}`;
export const ordinal = (left, right) => left < right ? -1 : left > right ? 1 : 0;
export const integer = value => typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
const folderTypes = new Set(['Folder', 'Series', 'Season', 'MusicAlbum', 'BoxSet', 'AggregateFolder', 'UserRootFolder', 'CollectionFolder']);
const nativeFolderData = type => type === 'BoxSet' ? { DisplayOrder: 'PremiereDate', ...folderData() } : folderData();

export async function discoveryFixture(t, dialect, sample, { resolveFile, captureDatabaseDeletes = true, captureMetadataEvents = true,
  shouldFailDirectory = () => true } = {}) {
  const fixture = await setupChildrenFixture(t, dialect), calls = [];
  fixture.configuration.EnableCaseSensitiveItemIds = true;
  const seed = fixture.seed;
  fixture.seed = async scenario => {
    await seed(scenario);
    for (const definition of scenario.items) await fixture.database.update('BaseItems', { Id: definition.Id }, {
      DateLastSaved: null, DateLastRefreshed: null,
      Data: JSON.stringify(folderTypes.has(definition.type) ? nativeFolderData(definition.type) : { ...videoData(), LocalAlternateVersions: definition.LocalAlternateVersions ?? [],
        ...(definition.type === 'Trailer' ? { TrailerTypes: [] } : {}) })
    });
  };
  const parentDirectory = sample.parentDirectory ?? 'media';
  const directory = path.join(fixture.stateRoot, parentDirectory), nativePath = name => directory + path.sep + name;
  const target = nativePath(sample.files[0]);
  fixture.vfs.mount({ path: '/discovery-write', instanceId: 'fixture', capabilities: { create: true, replace: true, mkdir: true, delete: true } });
  fixture.identityMap.addPrefix({ identityRoot: directory, accessRoot: '/discovery-write/discovery', style: 'windows', returnAccess: 'isolated native discovery files' });
  await fixture.adapter.mkdir('/discovery');
  await prepareIgnoreFileFixture(fixture, sample.ignoreFiles);
  await fixture.adapter.write('/discovery/primary.mkv', Buffer.from('primary control'));
  for (const name of sample.files) {
    await ensureFixtureDirectory(fixture, path.posix.dirname('/discovery-write/discovery/' + name));
    await fixture.adapter.write('/discovery/' + name,
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('media control')]), { modified: '2025-01-03T04:05:06.0000000Z' });
  }
  // Memory VFS has no creation-time setter; only its file creation time is a
  // control. Bytes, sizes, enumeration, cleanup and both databases are real.
  let active = sample.operation === 'resolve', failedDirectory = false;
  const stat = fixture.adapter.stat.bind(fixture.adapter);
  fixture.adapter.stat = async (...args) => {
    const result = await stat(...args);
    return result.kind === 'file' ? { ...result, created: '2025-01-02T03:04:05.0000000Z' } : result;
  };
  const list = fixture.adapter.listPage.bind(fixture.adapter);
  fixture.adapter.listPage = async (...args) => {
    const requested = String(args[0]).replaceAll('\\', '/');
    const failed = sample.failDirectory && `/discovery/${sample.failDirectory}`.replaceAll('\\', '/');
    if (active && failed && requested === failed && !failedDirectory && shouldFailDirectory()) {
      failedDirectory = true;
      const error = new Error('Controlled nested enumeration failure');
      error.code = 'io';
      throw error;
    }
    const result = await list(...args);
    return { ...result, entries: result.entries.map(entry => entry.kind === 'file'
      ? { ...entry, created: '2025-01-02T03:04:05.0000000Z' } : entry) };
  };
  const baseLoader = createMetadataContextLoader({fileSystem: testFileSystem,  ...fixture, videoPathResolver: (candidate, options) => {
    if (active) calls.push({ action: 'resolve', path: candidate.identityPath.replace(fixture.stateRoot, '$STATE') });
    if (candidate.entry.exists === false && candidate.entry.kind === 'directory' && sample.deleteCreated) {
      // Explicit empty MovieResolver / generic Folder fallback control. The
      // actual fallback is a Folder and cannot be returned as a Video.
      if (active) calls.push({ action: 'folder', path: candidate.identityPath.replace(fixture.stateRoot, '$STATE') });
      return null;
    }
    return resolveFile ? resolveFile(candidate, options)
      : resolveOrdinaryVideoFile(candidate, { ...options, nativeType: typeName(sample.resolverType), parseName: sample.parseName ?? false });
  } });
  const contexts=new Set();
  const loader=Object.assign(async(...args)=>{const loaded=await baseLoader(...args);contexts.add(loaded);return loaded;},baseLoader);
  loader.withContext=async(reference,options,operation)=>{const loaded=await loader(reference,options);try{return await operation(loaded);}finally{await loaded.dispose();contexts.delete(loaded);}};
  const close=fixture.host.close.bind(fixture.host);fixture.host.close=async()=>{await close();for(const loaded of contexts)await loaded.dispose();contexts.clear();};
  fixture.loadContext = fixture.host.loadContext = loader;
  const blankOwner = { ...videoData(), Id: ids.owner, key: 'owner', type: sample.expectedType, Name: 'Stored owner',
    Path: path.join(directory, 'primary.mkv'), parent: 'parent', IsInMixedFolder: sample.mixed ?? false };
  const parentType = sample.parentType ?? 'Folder';
  await fixture.seed({ target: 'owner', items: [
    { ...nativeFolderData(parentType), key: 'parent', type: parentType, Id: ids.parent, Name: 'Parent', Path: directory }, blankOwner ] });
  let loaded = await loader(ids.owner);
  const oldType = sample.wrongType ? 'Video' : sample.expectedType;
  const oldId = nativeGuid(loaded.getNewItemId(target, typeName(oldType)));
  if (sample.wrongType || sample.existingType || sample.dropExisting) {
    await fixture.seed({ target: 'owner', items: [
      { ...nativeFolderData(parentType), key: 'parent', type: parentType, Id: ids.parent, Name: 'Parent', Path: directory },
      { ...blankOwner, LocalAlternateVersions: sample.dropExisting ? [target] : [] },
      { ...videoData(), key: 'old', type: oldType, Id: oldId, Name: 'Old version', Path: target, parent: 'parent',
        ...(sample.runtimeTicks ? { RunTimeTicks: BigInt(sample.runtimeTicks) } : {}),
        ...(sample.dropExisting ? { PrimaryVersionId: ids.owner, PresentationUniqueKey: idKey(ids.owner) } : {}) }
    ] });
    if (sample.dropExisting) await fixture.database.insert('LinkedChildren', { ParentId: ids.owner, ChildId: oldId, ChildType: 2, SortOrder: 0 });
    await loaded.dispose();contexts.delete(loaded);loaded = await loader(ids.owner);
    const old = await loaded.videoVersionDiscovery.lookup(loaded, oldId);
    const assets = new MetadataImageAssets({fileSystem: testFileSystem,  vfs: fixture.vfs, identityMap: fixture.identityMap, metadataPath: loaded.metadataPath, stateRoots: [loaded.dataPath] });
    for (const directory of new Set([internalImagePath(old, loaded.metadataPath), ...loaded.videoVersionDiscovery.externalData.paths(old, loaded)])) {
      await assets.write(path.join(directory, 'marker.txt'), Buffer.from('owned marker'));
    }
    if (sample.dropExisting) old.Name = 'Cached stale name';
  }
  loaded.item.Name = 'Updated owner';
  loaded.item.LocalAlternateVersions = (sample.versions ?? sample.files).map(name => name == null || name === '' ? name : nativePath(name));
  loaded.parent.UserData = []; setFolderChildren(loaded.parent, [loaded.item]);
  const cold = [{ sentinel: true }];
  const childrenCleared = () => readCachedFolderChildren(loaded.parent, null, () => cold) === cold;
  const discovery = loaded.videoVersionDiscovery, external = discovery.externalData;
  const externalFiles = external.deleteItemFiles.bind(external);
  external.deleteItemFiles = async (item, options) => {
    calls.push({ action: 'external-files', id: guid(item.Id) }); return externalFiles(item, options);
  };
  const originalDelete = fixture.database.delete.bind(fixture.database);
  fixture.database.delete = async (table, where) => {
    if (captureDatabaseDeletes && table === 'BaseItems') calls.push({ action: 'delete', ids: [guid(where.Id)] });
    return originalDelete(table, where);
  };
  if (captureDatabaseDeletes && dialect === 'postgres') {
    const originalQuery = fixture.database.client.query.bind(fixture.database.client);
    fixture.database.client.query = async (...args) => {
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
      const values = typeof args[0] === 'object' && args[0] !== null ? args[0].values : args[1];
      // PostgreSQL item deletion is intentionally set-based and therefore no
      // longer passes through database.delete. Preserve the native operation
      // trace by observing the one scoped BaseItems mutation instead of
      // weakening production back into per-row calls for this fixture.
      if (text.includes(`DELETE FROM "${fixture.database.schemaName}"."BaseItems" item`)) {
        const scope = /^\s*WITH scope AS \(([\s\S]+)\)\s*DELETE FROM/u.exec(text);
        assert.ok(scope, 'The actual item deletion exposes its SQL scope.');
        const rows = (await originalQuery({ text: `WITH scope AS (${scope[1]}) SELECT "Key" FROM scope ORDER BY "Key" COLLATE "C"`, values })).rows;
        calls.push({ action: 'delete', ids: rows.map(row => guid(row.Key)) });
      }
      return originalQuery(...args);
    };
  }
  for (const [name, kind] of captureMetadataEvents ? [['ItemUpdated', 'updated'], ['ItemAdded', 'added'], ['ItemRemoved', 'removed']] : []) {
    fixture.host.updates.on(name, event => calls.push({ action: 'event', kind, id: guid(event.Item.Id),
      ...(kind === 'updated' ? { reason: event.UpdateReason } : {}) }));
  }
  if (sample.failure) {
    const action = sample.failure === 'delete' ? 'DELETE' : 'UPDATE';
    await fixture.database.client.query(`CREATE FUNCTION discovery_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Controlled discovery failure'; END $$`);
    await fixture.database.client.query(`CREATE TRIGGER discovery_failure BEFORE ${action} ON "BaseItems" FOR EACH ROW EXECUTE FUNCTION discovery_failure()`);
  }
  return { fixture, loaded, calls, target, oldId, childrenCleared, activate: () => { active = true; } };
}

export function projectItem(item, root) {
  if (!item) return null;
  const normalize = value => value?.replace(root, '$STATE');
  return { id: guid(item.Id), type: item.NativeType, name: item.Name, path: normalize(item.Path),
    parentId: guid(item.ParentId ?? EMPTY_ID), ownerId: guid(item.OwnerId ?? EMPTY_ID), primaryVersionId: item.PrimaryVersionId ? guid(item.PrimaryVersionId) : null,
    mixed: item.IsInMixedFolder, locked: item.IsLocked, productionYear: item.ProductionYear, size: integer(item.Size), runTimeTicks: item.RunTimeTicks,
    dateCreated: dateText(item.DateCreated), dateModified: dateText(item.DateModified), dateLastSavedSet: item.DateLastSaved !== MIN_DATE,
    videoType: item.VideoType, extraType: item.ExtraType ?? null, parts: item.AdditionalParts.map(normalize) };
}

export async function projectDiscovery(fixture, loaded, sample, { resolved, exception, calls, childrenCleared, oldId }) {
  const parentDirectory = sample.parentDirectory ?? 'media';
  const normalize = value => value?.replace(fixture.stateRoot, '$STATE') ?? null;
  const rows = (await fixture.database.rows('BaseItems')).filter(row => row.Type !== 'PLACEHOLDER').map(row => {
    const data = parseLosslessJson(row.Data);
    const savedDate = value => {
      assert.equal(dateText(value), dateText(fixture.now), 'The candidate must use the supplied save clock.');
      assert.equal(dateText(row.DateLastSaved), dateText(value), 'Stored Data and column timestamps must agree.');
      return '$UTC_SAVE';
    };
    const rewrite = value => Array.isArray(value) ? value.map(rewrite) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === 'DateLastSaved' && entry !== MIN_DATE ? savedDate(entry) : rewrite(entry)]))
      : typeof value === 'string' ? normalize(value) : value;
    return { id: guid(row.Id), type: row.Type, name: row.Name, path: normalize(row.Path), parentId: row.ParentId && guid(row.ParentId),
      topParentId: row.TopParentId && guid(row.TopParentId), ownerId: row.OwnerId && guid(row.OwnerId), primaryVersionId: row.PrimaryVersionId && guid(row.PrimaryVersionId),
      presentationUniqueKey: row.PresentationUniqueKey, mixed: row.IsInMixedFolder, locked: row.IsLocked, productionYear: row.ProductionYear,
      size: integer(row.Size), runTimeTicks: row.RunTimeTicks, dateCreated: row.DateCreated && dateText(row.DateCreated),
      dateModified: row.DateModified && dateText(row.DateModified), dateLastSavedSet: row.DateLastSaved != null, data: rewrite(data) };
  }).sort((left, right) => ordinal(left.id, right.id));
  const links = (await fixture.database.rows('LinkedChildren')).map(row => ({ parentId: guid(row.ParentId), childId: guid(row.ChildId), childType: row.ChildType, sortOrder: row.SortOrder }))
    .sort((left, right) => ordinal(left.parentId, right.parentId) || left.sortOrder - right.sortOrder);
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
        const handle = await fixture.vfs.openRead(child), bytes = [];
        try { for await (const chunk of handle.stream) bytes.push(Buffer.from(chunk)); } finally { await handle.close(); }
        hashFile(path.join(fixture.stateRoot, parentDirectory, path.posix.relative('/discovery-write/discovery', child)), Buffer.concat(bytes));
      }
    }
  };
  if (!sample.removeParentDirectory) await mediaFiles('/discovery-write/discovery');
  await projectAncestorIgnoreFiles(fixture, hashFile); files.sort((left, right) => ordinal(left.path, right.path));
  const old = sample.wrongType || sample.existingType || sample.dropExisting ? await loaded.videoVersionDiscovery.lookup(loaded, oldId) : null;
  return { name: sample.name, exception, resolved: projectItem(resolved, fixture.stateRoot), calls, rows, links, files,
    parentChildrenCleared: childrenCleared(), parentUserDataCleared: loaded.parent.UserData === null, oldLookupName: old?.Name ?? null };
}
