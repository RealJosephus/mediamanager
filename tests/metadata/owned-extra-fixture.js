import { testFileSystem } from '../storage/plugin-files.js';
import { observeBaseItemDeletes } from '../database/postgres-faults.js';
import path from 'node:path';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseLosslessJson } from '../../src/core/json.js';
import { dateText, EMPTY_ID, MIN_DATE, VIDEO_TYPES, guid, idKey, mapRecord } from '../../src/library/records.js';
import { nativeGuid } from '../../src/users/native.js';
import { setupChildrenFixture } from './children-fixture.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { resolveOwnedExtraFile } from '../../src/library/owned-extra-discovery.js';
import { internalImagePath } from '../../src/metadata/image-paths.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { cachedFolderChildrenSnapshot, setFolderChildren } from '../../src/library/folder-cache.js';
import { createMetadataChildren } from '../../src/library/metadata-children.js';
import { readUserDataRows } from '../../src/sessions/user-data.js';
import { encodeIgnoreFile } from '../library/dot-ignore-fixture.js';
import { IdentityAccessMap } from '../../src/storage/identity-mapping.js';
import { DotIgnoreRule } from '../../src/library/dot-ignore-rule.js';
import { fixturePathStyle, projectStatePath } from '../library/fixture-state-path.js';

const ownerId = '98c00000-0000-0000-0000-000000000001', parentId = '98c00000-0000-0000-0000-000000000002';
const typeName = type => `MediaBrowser.Controller.Entities.${type === 'Movie' ? 'Movies.' : ['Audio', 'MusicArtist', 'MusicAlbum'].includes(type) ? 'Audio.' : ['Series', 'Season', 'Episode'].includes(type) ? 'TV.' : ''}${type}`;
const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const integer = value => typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
const videoData = () => ({ AdditionalParts: [], LocalAlternateVersions: [], LinkedAlternateVersions: [], SubtitleFiles: [], AudioFiles: [],
  HasSubtitles: false, IsPlaceHolder: false, VideoType: 'VideoFile', IsHD: false, IsShortcut: false,
  Width: 0, Height: 0, DateLastSaved: MIN_DATE, RemoteTrailers: [] });
const folderData = () => ({ IsRoot: false, IsHD: false, IsShortcut: false, Width: 0, Height: 0, DateLastSaved: MIN_DATE, RemoteTrailers: [] });

export function projectItem(item, stateRoot, projectPath = (_, value) => projectStatePath(value, stateRoot) ?? null) {
  const normalize = value => projectStatePath(value, stateRoot) ?? null;
  return { id: guid(item.Id), type: item.NativeType, name: item.Name, path: projectPath(item.Id, item.Path),
    parentId: guid(item.ParentId ?? EMPTY_ID), ownerId: guid(item.OwnerId ?? EMPTY_ID),
    primaryVersionId: item.PrimaryVersionId ? guid(item.PrimaryVersionId) : null,
    mixed: item.IsInMixedFolder ?? false, locked: item.IsLocked ?? false, productionYear: item.ProductionYear ?? null,
    size: integer(item.Size ?? null), runTimeTicks: item.RunTimeTicks ?? null,
    dateCreated: dateText(item.DateCreated ?? MIN_DATE), dateModified: dateText(item.DateModified ?? MIN_DATE),
    dateLastSavedSet: item.DateLastSaved != null && dateText(item.DateLastSaved) !== MIN_DATE,
    videoType: VIDEO_TYPES.has(item.Type) ? item.VideoType ?? 'VideoFile' : null, extraType: item.ExtraType ?? null,
    parts: VIDEO_TYPES.has(item.Type) ? (item.AdditionalParts ?? []).map(normalize) : null,
    alternates: VIDEO_TYPES.has(item.Type) ? (item.LocalAlternateVersions ?? []).map(normalize) : null,
    genres: item.Genres ?? [], overview: item.Overview ?? null };
}

export async function setup(t, dialect, sample, { recordInserts = true } = {}) {
  const fixture = await setupChildrenFixture(t, dialect), calls = [];
  fixture.configuration.EnableCaseSensitiveItemIds = true;
  // Path.Combine preserves separators inside the supplied relative filename.
  // Existing native rows keep that spelling even when directory enumeration
  // later presents the same path with the host's separators.
  const directory = path.join(fixture.stateRoot, 'media'), target = directory + path.sep + sample.files[0];
  fixture.vfs.mount({ path: '/owned-discovery-write', instanceId: 'fixture', capabilities: { create: true, replace: true, mkdir: true, delete: true } });
  fixture.identityMap.addPrefix({ identityRoot: directory, accessRoot: '/owned-discovery-write/owned-discovery', style: fixturePathStyle, returnAccess: 'isolated owned video discovery controls' });
  // The recorded native ancestors contain no .ignore outside this controlled
  // state. Model that namespace explicitly instead of inferring absence from
  // a missing media access mapping.
  fixture.vfs.mount({ path: '/owned-discovery-ancestors', root: '/owned-ancestors', instanceId: 'fixture', capabilities: {
    create: true, replace: true, mkdir: true, delete: true
  } });
  const ignoreMap = new IdentityAccessMap();
  for (const prefix of fixture.identityMap.exportState().prefixes) ignoreMap.addPrefix(prefix);
  ignoreMap.addPrefix({ identityRoot: path.parse(fixture.stateRoot).root, accessRoot: '/owned-discovery-ancestors',
    style: fixturePathStyle, returnAccess: 'Controlled complete ancestor namespace for the actual .ignore recording.' });
  fixture.ignoreIdentityMap = ignoreMap;
  fixture.ignoreRule = new DotIgnoreRule({ vfs: fixture.vfs, identityMap: ignoreMap });
  await fixture.adapter.mkdir('/owned-ancestors');
  await fixture.adapter.mkdir('/owned-discovery');
  if (sample.ownerPath) await fixture.adapter.mkdir('/owned-discovery/' + sample.ownerPath);
  else await fixture.adapter.write('/owned-discovery/primary.mkv', Buffer.from('primary control'));
  const directories = new Set(['/owned-discovery', ...(sample.ownerPath ? ['/owned-discovery/' + sample.ownerPath] : [])]);
  for (const filename of sample.files) {
    const directory = path.posix.dirname('/owned-discovery/' + filename);
    if (!directories.has(directory)) { await fixture.adapter.mkdir(directory); directories.add(directory); }
    await fixture.adapter.write('/owned-discovery/' + filename,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('media control')]), { modified: '2025-01-03T04:05:06.0000000Z' });
  }
  for (const file of sample.ignoreFiles ?? []) {
    const accessPath = ignoreMap.resolve({ identityPath: path.join(fixture.stateRoot, file.path), style: fixturePathStyle });
    const resolved = fixture.vfs.resolve(accessPath);
    let parent = '';
    for (const segment of path.posix.dirname(resolved.path).split('/').filter(Boolean)) {
      parent += '/' + segment;
      try { await fixture.adapter.mkdir(parent); } catch (error) { if (error.code !== 'already-exists') throw error; }
    }
    await fixture.vfs.write(accessPath, encodeIgnoreFile(file.text, file.encoding), { modified: '2025-01-03T04:05:06.0000000Z' });
  }
  // Media access and bytes remain VFS operations; only creation time is controlled.
  const stat = fixture.adapter.stat.bind(fixture.adapter);
  fixture.adapter.stat = async (...args) => {
    const result = await stat(...args);
    return result.kind === 'file' ? { ...result, created: '2025-01-02T03:04:05.0000000Z' } : result;
  };
  const loader = fixture.trackContextLoader(createMetadataContextLoader({fileSystem: testFileSystem,  ...fixture, extraPathResolver: (candidate, options) => {
    if (!options.preview && options.nativeType === typeName('Audio')) calls.push({ action: 'resolve', path: projectStatePath(candidate.identityPath, fixture.stateRoot) });
    return resolveOwnedExtraFile(candidate, options);
  } }));
  fixture.loadContext = fixture.host.loadContext = loader;
  const definitions = [
    { key: 'parent', type: 'Folder', Id: parentId, Name: 'Parent', Path: directory },
    { key: 'owner', type: sample.expectedType, Id: ownerId, Name: 'Stored owner', parent: 'parent',
      Path: path.join(directory, sample.ownerPath ?? 'primary.mkv'), IsInMixedFolder: sample.mixed ?? false }
  ];
  await fixture.seed({ target: 'owner', items: definitions });
  let loaded = await loader(ownerId);
  const oldType = 'Trailer';
  const oldId = nativeGuid(loaded.getNewItemId(target, typeName(oldType)));
  // The existing row was seeded with Path.Combine(directory, input filename),
  // whose supplied filename can contain '/'. POSIX relocation makes that
  // separator indistinguishable from an enumerated path, so retain the input
  // spelling only for this seeded identity and verify its complete live path.
  const projectPath = (id, value) => {
    if (sample.existingType && idKey(id) === idKey(oldId)) {
      assert.equal(value, target);
      return projectStatePath(directory, fixture.stateRoot) + '\\' + sample.files[0];
    }
    return projectStatePath(value, fixture.stateRoot) ?? null;
  };
  const projectOwnedItem = item => projectItem(item, fixture.stateRoot, projectPath);
  if (sample.existingType) definitions.push({ key: 'old', type: oldType, Id: oldId,
    Name: sample.oldName ?? 'Old version', Path: target, ...(sample.attached ? { parent: 'parent' } : {}), OwnerId: ownerId,
    ExtraType: 2, LockedFields: sample.lockedName ? ['Name'] : [] });
  await fixture.seed({ target: 'owner', items: definitions });
  for (const definition of definitions) await fixture.database.update('BaseItems', { Id: definition.Id }, {
    DateCreated: null, DateModified: null, DateLastSaved: null, DateLastRefreshed: null,
    Data: ['Season', 'MusicArtist', 'MusicAlbum'].includes(definition.type) ? null : JSON.stringify(
      ['Folder', 'Series'].includes(definition.type) ? { ...(definition.type === 'Series' ? { AirDays: [] } : {}), ...folderData() }
        : { ...videoData(), ...(definition.type === 'Trailer' ? { TrailerTypes: [] } : {}) })
  });
  loaded = await loader(ownerId);
  if (sample.existingType) {
    const old = await loaded.videoVersionDiscovery.lookup(loaded, oldId);
    const assets = new MetadataImageAssets({fileSystem: testFileSystem,  vfs: fixture.vfs, identityMap: fixture.identityMap,
      metadataPath: loaded.metadataPath, stateRoots: [loaded.dataPath] });
    for (const directory of new Set([internalImagePath(old, loaded.metadataPath), ...loaded.videoVersionDiscovery.externalData.paths(old, loaded)]))
      await assets.write(path.join(directory, 'marker.txt'), Buffer.from('owned marker'));
  }
  const parentChildren = sample.existingType
    ? [loaded.item, await loaded.videoVersionDiscovery.lookup(loaded, oldId)] : [loaded.item];
  loaded.parent.UserData = []; setFolderChildren(loaded.parent, parentChildren);
  if (sample.missing) await fixture.adapter.delete('/owned-discovery/' + sample.files[0]);
  loaded.item.Name = 'Updated owner'; loaded.item.Genres = ['Owner genre']; loaded.item.Overview = 'Owner overview';
  loaded.item.AdditionalParts = []; loaded.item.LocalAlternateVersions = [];
  const external = loaded.videoVersionDiscovery.externalData, deleteFiles = external.deleteItemFiles.bind(external);
  external.deleteItemFiles = (item, options) => { calls.push({ action: 'external-files', id: guid(item.Id) }); return deleteFiles(item, options); };
  const insert = fixture.database.insert.bind(fixture.database);
  fixture.database.insert = async (table, row) => {
    if (table === 'BaseItems' && recordInserts) calls.push({ action: 'save', items: [projectOwnedItem(mapRecord(row))], cancellable: false });
    return insert(table, row);
  };
  observeBaseItemDeletes(fixture.database, ids => calls.push({ action: 'delete', ids: ids.map(guid) }));
  for (const [name, kind] of [['ItemAdded', 'added'], ['ItemRemoved', 'removed']]) fixture.host.updates.on(name,
    event => calls.push({ action: 'event', kind, id: guid(event.Item.Id) }));
  if (sample.newFailure || sample.failure) {
    const action = sample.failure ? 'UPDATE' : sample.newFailure === 'delete' ? 'DELETE' : 'INSERT';
    const failingName = sample.newFailure === 'first-insert' ? 'other' : sample.newFailure === 'second-insert' ? 'some' : null;
    await fixture.database.client.query(`CREATE FUNCTION owned_discovery_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${failingName ? `IF NEW."Name" = '${failingName}' THEN` : ''} RAISE EXCEPTION 'Controlled owned discovery failure'; ${failingName ? 'END IF; RETURN NEW;' : ''} END $$`);
    await fixture.database.client.query(`CREATE TRIGGER owned_discovery_failure BEFORE ${action} ON "BaseItems" FOR EACH ROW EXECUTE FUNCTION owned_discovery_failure()`);
  }
  return { fixture, loaded, calls, oldId, projectPath, projectItem: projectOwnedItem,
    parentInputIds: parentChildren.map(item => guid(item.Id)) };
}

export async function assertOwnedParentConsumers(t, value, expected, projectChild = value.projectItem) {
  const { fixture, loaded, oldId, parentInputIds } = value;
  const cacheDiagnostic = { childrenCachePresent: cachedFolderChildrenSnapshot(loaded.parent) !== undefined,
    attachedUserData: loaded.parent.UserData };
  const children = await createMetadataChildren(fixture).physical(loaded.parent), observed = [];
  try { for await (const page of children.pages()) for (const child of page) observed.push(await projectChild(child)); }
  finally { await children.close(); }
  // The producer explicitly assigns this warm Children input. It records the
  // owner and lookup values, but no post-refresh parent Children/UserData DTO.
  assert.deepEqual(observed.map(item => item.id), parentInputIds);
  assert.deepEqual(observed.find(item => item.id === expected.liveOwner.id), expected.liveOwner);
  const old = parentInputIds.length > 1 ? await fixture.library.itemCreation.getItemById(oldId) : null;
  assert.equal(old?.Name ?? null, expected.oldLookupName);
  if (old) {
    assert.equal(guid(old.Id), guid(oldId));
    assert.equal(observed.find(item => item.id === guid(oldId))?.name, expected.oldLookupName);
  }
  const userData = await fixture.store.run(async db => readUserDataRows(db, loaded.parent,
    loaded.parent.UserData ?? await db.rows('UserData', { where: { ItemId: loaded.parent.Id } })));
  assert.deepEqual(userData, { Key: guid(loaded.parent.Id), AudioStreamIndex: null, SubtitleStreamIndex: null,
    IsFavorite: false, LastPlayedDate: null, Likes: null, PlaybackPositionTicks: 0n, PlayCount: 0,
    Played: false, Rating: null });
  t.diagnostic(JSON.stringify({ parentCacheDiagnostic: cacheDiagnostic, parentConsumers: { children: observed,
    oldLookupName: old?.Name ?? null, userData }, nativeParentPublicValuesRecorded: false },
  (_, entry) => typeof entry === 'bigint' ? JSON.rawJSON(String(entry)) : entry));
}

export async function project(value, sample, failed, { repository = false } = {}) {
  const { fixture, loaded, calls, oldId } = value;
  const normalize = name => projectStatePath(name, fixture.stateRoot) ?? null;
  const rewrite = value => Array.isArray(value) ? value.map(rewrite) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewrite(entry)]))
    : typeof value === 'string' ? value === fixture.now && repository ? '$UTC_SAVE' : normalize(value) : value;
  const rows = (await fixture.database.rows('BaseItems')).filter(row => row.Type !== 'PLACEHOLDER').map(row => ({
    id: guid(row.Id), type: row.Type, name: row.Name, path: value.projectPath(row.Id, row.Path), parentId: row.ParentId && guid(row.ParentId),
    topParentId: row.TopParentId && guid(row.TopParentId), ownerId: row.OwnerId && guid(row.OwnerId), primaryVersionId: row.PrimaryVersionId && guid(row.PrimaryVersionId),
    presentationUniqueKey: row.PresentationUniqueKey, mixed: row.IsInMixedFolder, locked: row.IsLocked,
    ...(repository ? { extraType: row.ExtraType } : {}),
    productionYear: row.ProductionYear, size: integer(row.Size), runTimeTicks: row.RunTimeTicks,
    dateCreated: row.DateCreated && dateText(row.DateCreated), dateModified: row.DateModified && dateText(row.DateModified),
    dateLastSavedSet: row.DateLastSaved != null, data: rewrite(parseLosslessJson(row.Data))
  })).sort((a, b) => ordinal(a.id, b.id));
  if (repository) for (const row of await fixture.database.rows('BaseItems')) if (row.DateLastSaved != null) {
    assert.equal(dateText(row.DateLastSaved), fixture.now);
    assert.equal(dateText(parseLosslessJson(row.Data).DateLastSaved), dateText(row.DateLastSaved));
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
  for (const file of (sample.ignoreFiles ?? []).filter(file => !file.path.startsWith('media/'))) {
    const identityPath = path.join(fixture.stateRoot, file.path);
    const handle = await fixture.vfs.openRead(fixture.ignoreIdentityMap.resolve({ identityPath, style: fixturePathStyle })), chunks = [];
    try { for await (const bytes of handle.stream) chunks.push(Buffer.from(bytes)); } finally { await handle.close(); }
    hashFile(identityPath, Buffer.concat(chunks));
  }
  files.sort((a, b) => ordinal(a.path, b.path));
  const old = sample.existingType ? await loaded.videoVersionDiscovery.lookup(loaded, oldId) : null;
  return { name: sample.name, failed, liveOwner: value.projectItem(loaded.item), calls, rows, links, files, oldLookupName: old?.Name ?? null };
}
