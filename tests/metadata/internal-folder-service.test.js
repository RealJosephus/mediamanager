import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseLosslessJson } from '../../src/core/json.js';
import { beforeMetadataRefresh } from '../../src/metadata/before-refresh.js';
import { MetadataRefreshHost } from '../../src/metadata/refresh-host.js';
import { dateTicks, idKey, MIN_DATE } from '../../src/library/records.js';
import { createVirtualPathReverser } from '../../src/library/options.js';
import { cachedFolderChildren } from '../../src/library/collection-membership.js';
import { folderChildIds, setFolderChildren, releaseCachedFolderChildren } from '../../src/library/folder-cache.js';
import { markInternalFolderRefresh, internalFolderRefreshFlag, requiresInternalFolderRefresh } from '../../src/metadata/internal-folder-refresh.js';
import { RootFolderFileData, nativeDirectoryFullName } from '../../src/library/root-folder-file-data.js';
import { setupChildrenFixture } from './children-fixture.js';
const hash = value => createHash('sha256').update(value).digest('hex');
const compare = (actual, expected) => assert.deepEqual(actual, expected);
const recent = '2026-10-05T02:00:00.0000000Z', initial = '2026-10-04T12:00:00.0000000Z';
const id = '97810000-0000-0000-0000-000000000001';
const typeName = type => type === 'PlaylistsFolder' ? 'Emby.Server.Implementations.Playlists.PlaylistsFolder' : 'MediaBrowser.Controller.Entities.' + type;
async function fixtureFor(name, count, flag) {
  const root = new URL('./fixtures/' + name + '/', import.meta.url);
  const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json'].map(async file => parseLosslessJson(await readFile(new URL(file, root), 'utf8'))));
  test(name + ' seals actual native entry points and declared projection controls', async () => {
    for (const file of Object.values(provenance.files)) assert.equal(hash(await readFile(new URL('../../' + file.path, import.meta.url))), file.sha256, file.path);
    assert.equal(native.inputSha256, provenance.files.input.sha256); assert.equal(native.sourceFilesSha256, provenance.sourceFilesSha256);
    assert.equal(native[flag], true); assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
    assert.equal(input.length, count); assert.equal(native.results.length, count);
    assert.equal(provenance.runtime.jellyfinDll.sha256, '29c34541350089dc0522c4309ecd617e78fd402774681f32491d089803939c03');
    compare(native.results.map(value => value.name), input.map(value => value.name)); assert.ok(native.results.every(value => value.exception === null));
  });
  return { input, native };
}
const identity = (value, stateRoot) => value?.replaceAll('$STATE', stateRoot);
const project = (value, stateRoot) => value?.replaceAll(stateRoot, '$STATE');
function stateProjection(item, stateRoot) {
  return { Name: item.Name, Path: project(item.Path, stateRoot), refreshFlag: internalFolderRefreshFlag(item),
    cacheCleared: ['AggregateFolder', 'UserRootFolder'].includes(item.Type) ? folderChildIds(item) == null : null,
    locations: ['AggregateFolder', 'CollectionFolder'].includes(item.Type) ? item.PhysicalLocationsList.map(value => project(value, stateRoot)) : null,
    physicalIds: item.Type === 'CollectionFolder' ? item.PhysicalFolderIds : null };
}
async function seedSample(fixture, sample) {
  const itemPath = identity(sample.path, fixture.stateRoot);
  await mkdir(itemPath, { recursive: true });
  for (const directory of sample.directories ?? []) await mkdir(path.join(itemPath, directory), { recursive: true });
  for (const directory of sample.stateDirectories ?? []) await mkdir(path.join(fixture.stateRoot, directory), { recursive: true });
  for (const [relative, value] of Object.entries(sample.files ?? {})) {
    const target = path.join(itemPath, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, identity(value, fixture.stateRoot));
  }
  const lists = sample.useResolvedLocations ? [nativeDirectoryFullName(itemPath)] : (sample.locations ?? []).map(value => identity(value, fixture.stateRoot));
  const fields = ['AggregateFolder', 'CollectionFolder'].includes(sample.type) ? { PhysicalLocationsList: lists } : {};
  if (sample.type === 'CollectionFolder') fields.PhysicalFolderIds = sample.physicalIds ?? [];
  await fixture.seed({ target: 'target', items: [{ key: 'target', type: sample.type, Id: id, Name: sample.itemName, Path: itemPath,
    DateLastRefreshed: sample.first ? MIN_DATE : initial, DateModified: MIN_DATE, ...fields }] });
  await fixture.database.update('BaseItems', { Id: id }, { Type: typeName(sample.type), IsFolder: true,
    Path: createVirtualPathReverser({ programDataPath: fixture.stateRoot })(itemPath), ...(sample.type === 'PlaylistsFolder' ? { Data: null } : {}) });
  return fixture.loadContext(id);
}

const full = await fixtureFor('internal-folder-service', 53, 'actualFrozenInternalFolderService');
function dataProjection(data, stateRoot) {
  if (data == null) return null;
  const value = parseLosslessJson(data);
  return { locations: value.PhysicalLocationsList?.map(location => project(location, stateRoot)) ?? null,
    physicalIds: value.PhysicalFolderIds?.map(idKey) ?? null };
}
test('service projection rejects extra structural location writes or missing first save', () => {
  const expected = full.native.results.find(value => value.name === 'AggregateFolder-empty-FullRefresh-false-true').result;
  const wrong = structuredClone(expected); wrong.calls.shift(); assert.throws(() => compare(wrong, expected), assert.AssertionError);
  const value = dataProjection(expected.Data, 'irrelevant');
  assert.throws(() => compare({ ...value, locations: ['changed'] }, value), assert.AssertionError);
});
for (const dialect of ['postgres']) for (const sample of full.input) {
  test(dialect + ': actual four internal folder MetadataService ' + sample.name,
    async t => {
      const fixture = await setupChildrenFixture(t, dialect), calls = [], loaded = await seedSample(fixture, sample);
      const host = new MetadataRefreshHost({ registry: fixture.registry, store: fixture.store, vfs: fixture.vfs, loadContext: fixture.loadContext, linkedChildren: fixture.linkedChildren, spoolRoot: fixture.spoolRoot, now: () => recent });
      const originalClose = fixture.host.close.bind(fixture.host);
      fixture.host.close = async () => {
        const errors = [];
        for (const close of [() => host.close(), originalClose]) try { await close(); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, 'Metadata host cleanup failed.');
      };
      host.updates.on('ItemUpdated', ({ Item, UpdateReason }) => calls.push({ action: 'save', Name: Item.Name, Path: project(Item.Path, fixture.stateRoot), reason: UpdateReason }));
      host.updates.on('UserDataReattached', () => calls.push({ action: 'reattach' }));
      const result = await host.refresh(id, { MetadataRefreshMode: sample.metadataMode, ImageRefreshMode: 'None', ForceSave: sample.force });
      const row = (await fixture.database.rows('BaseItems', { where: { Id: id } }))[0], current = await fixture.loadContext(id);
      const expected = full.native.results.find(value => value.name === sample.name).result;
      // saved.Path is deliberately raw in the oracle. Project only its recorded
      // isolated state root, retaining virtual-path tokens and all separators.
      const nativeStateRoot = path.win32.resolve(path.win32.dirname(full.native.assemblies[0].path), '..', '..', '..', 'state', sample.name);
      compare({ updateType: result.UpdateType, calls, Name: current.item.Name, Path: project(current.item.Path, fixture.stateRoot),
        storedPath: project(row.Path, fixture.stateRoot), data: dataProjection(row.Data, fixture.stateRoot),
        stampChanged: dateTicks(current.item.DateLastRefreshed) !== dateTicks(loaded.item.DateLastRefreshed) },
      { updateType: expected.updateType, calls: expected.calls, Name: expected.Name, Path: expected.Path,
        storedPath: project(expected.storedPath, nativeStateRoot), data: dataProjection(expected.Data, nativeStateRoot), stampChanged: expected.stampChanged });
    });
}
