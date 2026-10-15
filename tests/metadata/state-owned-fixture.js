import { testFileSystem } from '../storage/plugin-files.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { setupChildrenFixture, useIdentityPathReversalControl } from './children-fixture.js';
import { projectItem as ordinaryProjectItem } from './owned-extra-fixture.js';
import { observeBaseItemDeletes } from '../database/postgres-faults.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { resolveOwnedExtraFile } from '../../src/library/owned-extra-discovery.js';
import { IdentityAccessMap } from '../../src/storage/identity-mapping.js';
import { DotIgnoreRule } from '../../src/library/dot-ignore-rule.js';
import { guid, MIN_DATE, dateText } from '../../src/library/records.js';
import { nativeDateFromUnixNanoseconds } from '../../src/users/native.js';
import { internalImagePath } from '../../src/metadata/image-paths.js';
import { readCachedFolderChildren, setFolderChildren } from '../../src/library/folder-cache.js';
import { encodeIgnoreFile } from '../library/dot-ignore-fixture.js';
import { parseLosslessJson } from '../../src/core/json.js';

export const ownerId = '98c00000-0000-0000-0000-000000000001';
const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const integer = value => typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
const nativeType = type => 'MediaBrowser.Controller.Entities.' + (type === 'Audio' ? 'Audio.' : '') + type;
const rewrite = (value, replace) => Array.isArray(value) ? value.map(entry => rewrite(entry, replace))
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewrite(entry, replace)]))
    : typeof value === 'string' ? replace(value) : value;

// Seed from the separately recorded PRE-refresh native frame, never its final
// expected result. Media bindings are per-item and cannot authorize state roots.
export async function setupStateOwned(t, sample, recorded, { bindMedia = true, ancestors = true } = {}) {
  const fixture = await setupChildrenFixture(t), calls = [], startedAt = Date.now();
  fixture.configuration.EnableCaseSensitiveItemIds = true;
  const expand = text => text.replaceAll('$STATE', fixture.stateRoot);
  const initialRows = recorded.initialRows.map(source => ({ ...rewrite(source, expand),
    Data: source.Data == null ? null : JSON.stringify(rewrite(parseLosslessJson(source.Data), expand)) }));
  const pending = [...initialRows], ordered = [];
  while (pending.length) {
    const index = pending.findIndex(row => ['ParentId', 'OwnerId', 'PrimaryVersionId', 'TopParentId', 'SeriesId', 'SeasonId']
      .every(key => !row[key] || ordered.some(parent => parent.Id === row[key]) || !initialRows.some(parent => parent.Id === row[key])));
    assert.ok(index >= 0, 'The recorded initial item-reference graph must be acyclic.');
    ordered.push(pending.splice(index, 1)[0]);
  }
  for (const row of ordered) {
    const existing = (await fixture.database.rows('BaseItems', { where: { Id: row.Id } }))[0];
    if (existing) await fixture.database.update('BaseItems', { Id: row.Id }, row);
    else await fixture.database.insert('BaseItems', row);
  }
  for (const row of recorded.initialMetadataFields) await fixture.database.insert('BaseItemMetadataFields', row);
  const normalizeRows = rows => rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    key === 'Data' && value != null ? JSON.stringify(rewrite(parseLosslessJson(value), text => text.replaceAll(fixture.stateRoot, '$STATE')))
      : key.startsWith('Date') && value != null ? dateText(value)
        : typeof value === 'string' ? value.replaceAll(fixture.stateRoot, '$STATE') : value])))
    .sort((a, b) => ordinal(a.Id, b.Id));
  assert.deepEqual(normalizeRows(await fixture.database.rows('BaseItems')), [...recorded.initialRows].sort((a, b) => ordinal(a.Id, b.Id)));
  assert.deepEqual(await fixture.database.rows('BaseItemMetadataFields'), recorded.initialMetadataFields);
  fixture.initialFrame = { initialRows: recorded.initialRows, initialMetadataFields: recorded.initialMetadataFields };
  const parentPath = initialRows.find(row => row.Type === 'MediaBrowser.Controller.Entities.Folder').Path;
  const write = async (filename, bytes, fixedTime = true) => {
    await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes);
    if (fixedTime) await utimes(filename, new Date('2025-01-03T04:05:06Z'), new Date('2025-01-03T04:05:06Z'));
  };
  for (const filename of sample.files) await write(path.join(parentPath, filename),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('media control')]));
  for (const file of sample.ignoreFiles) await write(path.join(fixture.stateRoot, file.path), encodeIgnoreFile(file.text, file.encoding));
  const ignoreMap = new IdentityAccessMap();
  if (ancestors) {
    await fixture.storage.createInstance('state-ignore-ancestors', 'memory', {});
    fixture.vfs.mount({ path: '/state-ignore-ancestors', instanceId: 'state-ignore-ancestors', capabilities: {} });
    ignoreMap.addPrefix({ identityRoot: path.parse(fixture.stateRoot).root, accessRoot: '/state-ignore-ancestors',
      style: 'windows', returnAccess: 'Explicit complete empty external .ignore ancestors for this isolated recording.' });
  }
  fixture.ignoreIdentityMap = ignoreMap;
  fixture.ignoreRule = new DotIgnoreRule({ vfs: fixture.vfs, identityMap: ignoreMap });
  const loader = fixture.trackContextLoader(createMetadataContextLoader({fileSystem: testFileSystem,  ...fixture, extraPathResolver: (candidate, options) => {
    if (!options.preview && options.nativeType === nativeType('Audio')) calls.push({ action: 'resolve', path: candidate.identityPath.replace(fixture.stateRoot, '$STATE') });
    return resolveOwnedExtraFile(candidate, options);
  } }));
  fixture.loadContext = fixture.host.loadContext = loader; useIdentityPathReversalControl(fixture);
  const loaded = await fixture.loadContext(ownerId);
  await mkdir(loaded.item.Path, { recursive: true });
  fixture.vfs.mount({ path: '/state-owned-media', instanceId: 'fixture', capabilities: {} });
  await fixture.adapter.mkdir('/bound');
  if (bindMedia) for (const [index, filename] of sample.files.entries()) {
    const localPath = path.join(parentPath, filename);
    const accessPath = '/state-owned-media/bound/' + index;
    await fixture.adapter.write('/bound/' + index, Buffer.from('network media control'),
      { modified: '2025-01-03T04:05:06.0000000Z' });
    for (const type of ['Video', 'Trailer', 'Audio']) fixture.identityMap.bind(
      loaded.getNewItemId(localPath, nativeType(type)), accessPath);
  }
  const oldRow = initialRows.find(row => row.ExtraType != null), oldId = oldRow?.Id ?? null;
  if (oldRow) {
    if (bindMedia) fixture.identityMap.bind(oldId, '/state-owned-media/bound/0');
    const old = await loaded.videoVersionDiscovery.lookup(loaded, oldId);
    for (const directory of new Set([internalImagePath(old, loaded.metadataPath), ...loaded.videoVersionDiscovery.externalData.paths(old, loaded)]))
      await write(path.join(directory, 'marker.txt'), Buffer.from('owned marker'), false);
  }
  loaded.parent.UserData = []; setFolderChildren(loaded.parent,
    oldRow ? [loaded.item, await loaded.videoVersionDiscovery.lookup(loaded, oldId)] : [loaded.item]);
  if (sample.missing) await unlink(path.join(parentPath, sample.files[0]));
  loaded.item.Name = 'Updated owner'; loaded.item.Genres = ['Owner genre']; loaded.item.Overview = 'Owner overview';
  const external = loaded.videoVersionDiscovery.externalData, deleteFiles = external.deleteItemFiles.bind(external);
  external.deleteItemFiles = (item, options) => { calls.push({ action: 'external-files', id: guid(item.Id) }); return deleteFiles(item, options); };
  observeBaseItemDeletes(fixture.database, ids => calls.push({ action: 'delete', ids: ids.map(guid) }));
  for (const [name, kind] of [['ItemAdded', 'added'], ['ItemRemoved', 'removed']]) fixture.host.updates.on(name,
    event => calls.push({ action: 'event', kind, id: guid(event.Item.Id) }));
  const cold = [];
  return { fixture, loaded, calls, oldId, startedAt, sample,
    childrenCleared: () => readCachedFolderChildren(loaded.parent, null, () => cold) === cold };
}

export async function projectStateItem(item, value) {
  const projected = ordinaryProjectItem(item, value.fixture.stateRoot);
  if (projected.dateCreated !== MIN_DATE) {
    const actual = await stat(item.Path, { bigint: true });
    assert.equal(projected.dateCreated, dateText(nativeDateFromUnixNanoseconds(actual.birthtimeNs)));
    assert.ok(Number(actual.birthtimeNs / 1_000_000n) >= value.startedAt - 1);
    assert.ok(Number(actual.birthtimeNs / 1_000_000n) <= Date.now());
    projected.dateCreated = '$FILE_CREATED';
  }
  return projected;
}

export async function projectStateOwned(value, exception) {
  const { fixture, loaded, calls, oldId, childrenCleared } = value;
  const normalize = text => text?.replaceAll(fixture.stateRoot, '$STATE') ?? null;
  const rows = (await fixture.database.rows('BaseItems')).filter(row => row.Type !== 'PLACEHOLDER').map(row => ({
    id: guid(row.Id), type: row.Type, name: row.Name, path: normalize(row.Path), parentId: row.ParentId && guid(row.ParentId),
    topParentId: row.TopParentId && guid(row.TopParentId), ownerId: row.OwnerId && guid(row.OwnerId), primaryVersionId: row.PrimaryVersionId && guid(row.PrimaryVersionId),
    presentationUniqueKey: row.PresentationUniqueKey, mixed: row.IsInMixedFolder, locked: row.IsLocked,
    productionYear: row.ProductionYear, size: integer(row.Size), runTimeTicks: row.RunTimeTicks,
    dateCreated: row.DateCreated && dateText(row.DateCreated), dateModified: row.DateModified && dateText(row.DateModified),
    dateLastSavedSet: row.DateLastSaved != null, data: rewrite(parseLosslessJson(row.Data), normalize)
  })).sort((a, b) => ordinal(a.id, b.id));
  const links = (await fixture.database.rows('LinkedChildren')).map(row => ({ parentId: guid(row.ParentId), childId: guid(row.ChildId), childType: row.ChildType, sortOrder: row.SortOrder }))
    .sort((a, b) => ordinal(a.parentId, b.parentId) || a.sortOrder - b.sortOrder);
  const files = [];
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else files.push({ path: normalize(filename), sha256: createHash('sha256').update(await readFile(filename)).digest('hex') });
    }
  };
  await visit(fixture.stateRoot); files.sort((a, b) => ordinal(a.path, b.path));
  const old = oldId ? await loaded.videoVersionDiscovery.lookup(loaded, oldId) : null;
  return { name: value.sample.name, ...fixture.initialFrame, exception, liveOwner: await projectStateItem(loaded.item, value), calls, rows, links, files,
    parentChildrenCleared: childrenCleared(), parentUserDataCleared: loaded.parent.UserData === null, oldLookupName: old?.Name ?? null };
}
