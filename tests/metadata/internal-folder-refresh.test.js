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
import { fixturePathStyle, projectStatePath } from '../library/fixture-state-path.js';
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
    compare(native.results.map(value => value.name), input.map(value => value.name));
    compare(native.results.map(value => value.exception), input.map(value => value.expectException ?? null));
  });
  return { input, native };
}
const identity = (value, stateRoot) => value == null ? value : value.replaceAll('$STATE', stateRoot);
const project = (value, stateRoot) => value == null ? value : value.replaceAll(stateRoot, '$STATE');
const resolvedLocationLists = new WeakSet();
const virtualLocations = new Map();
const projectLocations = (locations, stateRoot, resolved = false) => locations?.map((value, index) =>
  resolved && index === 0 ? projectStatePath(value, stateRoot) : virtualLocations.get(stateRoot)?.get(value) ?? project(value, stateRoot)) ?? null;
const projectFilePath = (value, stateRoot) => projectStatePath(projectStatePath(projectStatePath(value, stateRoot),
  process.cwd(), '$WORKSPACE'), 'D:\\mediamanager', '$WORKSPACE');
const expectedResult = result => result.files ? { ...result,
  files: result.files.map(file => ({ ...file, Path: projectFilePath(file.Path, '$STATE') })) } : result;
function stateProjection(item, stateRoot) {
  return { Name: item.Name, Path: project(item.Path, stateRoot), refreshFlag: internalFolderRefreshFlag(item),
    cacheCleared: ['AggregateFolder', 'UserRootFolder'].includes(item.Type) ? folderChildIds(item) == null : null,
    locations: ['AggregateFolder', 'CollectionFolder'].includes(item.Type)
      ? projectLocations(item.PhysicalLocationsList, stateRoot, resolvedLocationLists.has(item.PhysicalLocationsList)) : null,
    physicalIds: item.Type === 'CollectionFolder' ? item.PhysicalFolderIds : null };
}
function encodedText(value, encoding) {
  if (encoding === 'utf8-bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(value)]);
  if (encoding?.startsWith('utf16')) {
    const bytes = Buffer.from(value, 'utf16le');
    if (encoding === 'utf16-be') bytes.swap16();
    return Buffer.concat([Buffer.from(encoding === 'utf16-be' ? [0xfe, 0xff] : [0xff, 0xfe]), bytes]);
  }
  if (encoding?.startsWith('utf32')) {
    const scalars = [...value].map(character => character.codePointAt(0)), bytes = Buffer.alloc(4 + scalars.length * 4);
    const write = encoding === 'utf32-be' ? bytes.writeUInt32BE.bind(bytes) : bytes.writeUInt32LE.bind(bytes);
    write(0xfeff, 0); scalars.forEach((scalar, index) => write(scalar, (index + 1) * 4)); return bytes;
  }
  return Buffer.from(value);
}
async function seedSample(fixture, sample) {
  const itemPath = identity(sample.path, fixture.stateRoot);
  const virtualTargets = new Map();
  for (const value of Object.values(sample.files ?? {})) if (/%(?:AppDataPath|MetadataPath)%/u.test(value)) {
    virtualTargets.set(value.replaceAll('%AppDataPath%', path.join(fixture.stateRoot, 'data')).replaceAll('%MetadataPath%', path.join(fixture.stateRoot, 'metadata')),
      value.replaceAll('%AppDataPath%', '$STATE\\data').replaceAll('%MetadataPath%', '$STATE\\metadata'));
  }
  virtualLocations.set(fixture.stateRoot, virtualTargets);
  // This oracle's missing-directory control is outside RootFolderPath.
  // Map it to a missing VFS directory instead of granting host-file access.
  if (sample.overridePath === '$STATE/missing-root') fixture.identityMap.addPrefix({
    identityRoot: path.join(fixture.stateRoot, 'missing-root'), accessRoot: '/fixture/missing-root',
    style: fixturePathStyle, caseSensitive: false, returnAccess: 'isolated missing directory control'
  });
  await mkdir(itemPath, { recursive: true });
  for (const directory of sample.directories ?? []) await mkdir(path.join(itemPath, directory), { recursive: true });
  for (const directory of sample.stateDirectories ?? []) await mkdir(path.join(fixture.stateRoot, directory), { recursive: true });
  if ((sample.stateDirectories ?? []).some(value => value === 'media' || value.startsWith('media/'))) {
    fixture.identityMap.addPrefix({ identityRoot: path.join(fixture.stateRoot, 'media'), accessRoot: '/fixture/targets',
      style: fixturePathStyle, caseSensitive: false, returnAccess: 'isolated native shortcut target control' });
    const directories = new Set(['/targets']);
    for (const value of sample.stateDirectories.filter(value => value === 'media' || value.startsWith('media/'))) {
      const components = value.split('/').slice(1); let target = '/targets';
      for (const component of components) { target += '/' + component; directories.add(target); }
    }
    for (const directory of directories) await fixture.adapter.mkdir(directory);
  }
  for (const [relative, value] of Object.entries(sample.files ?? {})) {
    const target = path.join(itemPath, relative); await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, encodedText(identity(value, fixture.stateRoot), sample.encoding));
  }
  const lists = sample.useResolvedLocations ? [nativeDirectoryFullName(itemPath)] : (sample.locations ?? []).map(value => identity(value, fixture.stateRoot));
  const fields = ['AggregateFolder', 'CollectionFolder'].includes(sample.type) ? { PhysicalLocationsList: lists } : {};
  if (sample.type === 'CollectionFolder') fields.PhysicalFolderIds = sample.physicalIds ?? [];
  await fixture.seed({ target: 'target', items: [{ key: 'target', type: sample.type, Id: id, Name: sample.itemName, Path: itemPath,
    DateLastRefreshed: sample.first ? MIN_DATE : initial, DateModified: MIN_DATE, ...fields }] });
  await fixture.database.update('BaseItems', { Id: id }, { Type: typeName(sample.type), IsFolder: true,
    Path: createVirtualPathReverser({ programDataPath: fixture.stateRoot })(itemPath), ...(sample.type === 'PlaylistsFolder' ? { Data: null } : {}) });
  const loaded = await fixture.loadContext(id);
  if (sample.useResolvedLocations) resolvedLocationLists.add(loaded.item.PhysicalLocationsList);
  return loaded;
}

const direct = await fixtureFor('internal-folder-refresh', 37, 'actualFrozenInternalFolderRefresh');
const resolved = await fixtureFor('internal-folder-resolve', 48, 'actualFrozenInternalFolderResolve');
const cache = await fixtureFor('internal-folder-cache', 14, 'actualFrozenInternalFolderCache');
const edges = await fixtureFor('internal-folder-resolve-edges', 48, 'actualFrozenInternalFolderResolveEdges');
test('internal hook comparison detects lost default name, stale refresh flag and ID cache', () => {
  const expected = direct.native.results.find(value => value.name === 'UserRootFolder-before-default-none').result;
  for (const change of [value => { value.state.Name = 'default'; }, value => { value.state.cacheCleared = false; }]) {
    const value = structuredClone(expected); change(value); assert.throws(() => compare(value, expected), assert.AssertionError);
  }
});
test('root resolve comparison rejects canonicalizing shortcut text and dropping duplicate locations', () => {
  const expected = resolved.native.results.find(value => value.name === 'AggregateFolder-link-duplicate-target-false').result;
  for (const change of [value => { value.locations.pop(); }, value => { value.locations[1] = value.files[0].Path; }]) {
    const value = structuredClone(expected); change(value); assert.throws(() => compare(value, expected), assert.AssertionError);
  }
});
for (const dialect of ['postgres']) {
  const options = {};
  for (const sample of edges.input) test(dialect + ': actual internal directory resolve edge ' + sample.name, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect), loaded = await seedSample(fixture, sample), item = loaded.item;
    if (item.Type === 'AggregateFolder') cachedFolderChildren(item, await fixture.state());
    if (Object.hasOwn(sample, 'flag')) markInternalFolderRefresh(item, sample.flag);
    if (sample.locationsNull) item.PhysicalLocationsList = null;
    if (sample.physicalIdsNull) item.PhysicalFolderIds = null;
    if (Object.hasOwn(sample, 'overridePath')) item.Path = identity(sample.overridePath, fixture.stateRoot);
    let exception = null, parameterName = null, result;
    try {
      if (sample.mode === 'resolve') {
        const resolved = await loaded.rootFolderResolveArgs(sample.setLocations);
        if (sample.setLocations) resolvedLocationLists.add(item.PhysicalLocationsList);
        result = { state: stateProjection(item, fixture.stateRoot), locations: projectLocations(resolved.locations, fixture.stateRoot, true),
          files: resolved.files.map(value => ({ ...value, Path: projectFilePath(value.Path, fixture.stateRoot) })) };
      } else if (sample.mode === 'before') result = { changed: beforeMetadataRefresh(item, loaded), state: stateProjection(item, fixture.stateRoot) };
      else {
        const requiresRefresh = await loaded.requiresRefresh(), state = stateProjection(item, fixture.stateRoot);
        result = { requiresRefresh, state, changedAfter: beforeMetadataRefresh(item, loaded), after: stateProjection(item, fixture.stateRoot) };
      }
    } catch (error) { exception = error.nativeException ?? error.name; parameterName = error.parameterName ?? null; result = { state: stateProjection(item, fixture.stateRoot) }; }
    const expected = edges.native.results.find(value => value.name === sample.name);
    compare({ exception, parameterName, result }, { exception: expected.exception, parameterName: expected.parameterName, result: expectedResult(expected.result) });
  });
  for (const sample of direct.input) test(dialect + ': actual internal directory hook ' + sample.name, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect), loaded = await seedSample(fixture, sample), item = loaded.item;
    if (Object.hasOwn(sample, 'flag')) markInternalFolderRefresh(item, sample.flag);
    // The native direct controls explicitly warm only the ID list. Read a real
    // empty repository list here; its nonnull ID list is observable without a private-field injection.
    if (['AggregateFolder', 'UserRootFolder'].includes(item.Type)) cachedFolderChildren(item, await fixture.state());
    let actual;
    if (sample.mode === 'before') actual = { changed: beforeMetadataRefresh(item, loaded), state: stateProjection(item, fixture.stateRoot) };
    else {
      const requiresRefresh = await loaded.requiresRefresh(), state = stateProjection(item, fixture.stateRoot);
      actual = { requiresRefresh, state, changedAfter: beforeMetadataRefresh(item, loaded), after: stateProjection(item, fixture.stateRoot) };
    }
    compare(actual, direct.native.results.find(value => value.name === sample.name).result);
  });
  for (const sample of resolved.input) test(dialect + ': actual internal directory resolve args ' + sample.name, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect), loaded = await seedSample(fixture, sample), item = loaded.item;
    const result = await loaded.rootFolderResolveArgs(sample.setLocations);
    if (sample.setLocations) resolvedLocationLists.add(item.PhysicalLocationsList);
    compare({ state: stateProjection(item, fixture.stateRoot), locations: projectLocations(result.locations, fixture.stateRoot, true),
      files: result.files.map(file => ({ ...file, Path: projectFilePath(file.Path, fixture.stateRoot) })) },
    expectedResult(resolved.native.results.find(value => value.name === sample.name).result));
  });
  for (const sample of cache.input) test(dialect + ': actual EF-backed root child cache ' + sample.name, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect), loaded = await seedSample(fixture, sample), item = loaded.item;
    const childId = '97c00000-0000-0000-0000-000000000010', newId = '97c00000-0000-0000-0000-000000000011';
    const base = (await fixture.database.rows('BaseItems', { where: { Id: id } }))[0];
    await fixture.database.insert('BaseItems', { ...base, Id: childId, Type: typeName('Folder'), ParentId: id, Name: 'Old child', SortName: 'first', Data: '{}' });
    const state = await fixture.state();
    const children = () => cachedFolderChildren(item, state).map(value => ({ Id: value.Id, Name: value.Name }));
    const warm = children();
    await fixture.database.update('BaseItems', { Id: childId }, { Name: 'Changed child' });
    await fixture.database.insert('BaseItems', { ...base, Id: newId, Type: typeName('Folder'), ParentId: id, Name: 'New child', SortName: 'second', Data: '{}' });
    const current = await fixture.state(); Object.assign(state, { items: current.items, byId: current.byId });
    const observations = [];
    for (const operation of sample.operations) {
      let changed = null;
      if (operation === 'before') changed = beforeMetadataRefresh(item, loaded);
      else if (operation === 'requires') changed = await loaded.requiresRefresh();
      else if (operation === 'release') releaseCachedFolderChildren(item);
      else if (operation === 'setter') setFolderChildren(item, null);
      observations.push({ operation, changed, state: stateProjection(item, fixture.stateRoot) });
    }
    compare({ warm, observations, children: children(), state: stateProjection(item, fixture.stateRoot) }, cache.native.results.find(value => value.name === sample.name).result);
  });
}
