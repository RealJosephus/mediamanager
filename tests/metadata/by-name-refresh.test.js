import test from 'node:test';
import { assertProjectedEqual, observeComparison } from '../comparison-observations.js';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { beforeMetadataRefresh } from '../../src/metadata/before-refresh.js';
import { rebasedMetadataPath } from '../../src/metadata/by-name-path.js';
import { createVirtualPathReverser } from '../../src/library/options.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { dateTicks } from '../../src/library/records.js';
import { MetadataRefreshHost } from '../../src/metadata/refresh-host.js';
import { PeopleMetadataLifecycleHost } from '../../src/metadata/people-lifecycle.js';
import { IdentityAccessMap } from '../../src/storage/identity-mapping.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { setupChildrenFixture } from './children-fixture.js';

const root = new URL('./fixtures/by-name-refresh/', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json'].map(async name => JSON.parse(await readFile(new URL(name, root), 'utf8'))));
const hash = value => createHash('sha256').update(value).digest('hex');
const compare = (actual, expected) => assert.deepEqual(actual, expected);
const id = '97810000-0000-0000-0000-000000000001', parentId = '97810000-0000-0000-0000-000000000002';
const recent = '2026-10-05T02:00:00.0000000Z', initial = '2026-10-04T12:00:00.0000000Z';
const nullRoot = new URL('./fixtures/by-name-path-errors/', import.meta.url);
const [nullInput, nullNative, nullProvenance] = await Promise.all(['input.json', 'native.json', 'provenance.json'].map(async name => JSON.parse(await readFile(new URL(name, nullRoot), 'utf8'))));

test('native by-name refresh seals actual hooks, metadata services, directories, reverse paths and EF', async () => {
  for (const file of Object.values(provenance.files)) assert.equal(hash(await readFile(new URL('../../' + file.path, import.meta.url))), file.sha256, file.path);
  assert.equal(native.inputSha256, provenance.files.input.sha256);
  assert.equal(native.sourceFilesSha256, provenance.sourceFilesSha256);
  assert.equal(provenance.runtime.jellyfinDll.sha256, '29c34541350089dc0522c4309ecd617e78fd402774681f32491d089803939c03');
  assert.equal(native.actualFrozenByNameRefresh, true); assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
  assert.equal(input.length, 92); assert.equal(native.results.length, input.length);
  assert.deepEqual(native.results.map(value => value.name), input.map(value => value.name));
  assert.ok(native.results.every(value => value.exception == null)); assert.equal(native.assemblies.length, 7);
});

test('comparison rejects changed rebase order, virtual path and serialized state', () => {
  const expected = native.results.find(value => value.name === 'Person-first-Default').result;
  for (const change of [value => value.calls.reverse(), value => { value.storedPath = value.Path; }, value => { value.Data = '{}'; }, value => { value.Path += '-changed'; }]) {
    const actual = structuredClone(expected); change(actual);
    assert.throws(() => compare(actual, expected), assert.AssertionError);
  }
});

for (const sample of input.filter(value => value.mode === 'before')) test(`native by-name Before hook ${sample.name}`, () => {
  const stateRoot = 'D:\\Isolated\\ByName';
  const item = { Type: sample.type, Name: sample.itemName, Path: sample.path.replaceAll('$STATE', stateRoot),
    IsAccessedByName: !sample.physicalArtist, ParentId: sample.physicalArtist ? parentId : null };
  const changed = beforeMetadataRefresh(item, { metadataPath: path.win32.join(stateRoot, 'metadata') });
  compare({ changed, Name: item.Name, Path: item.Path.replace(stateRoot, '$STATE') }, native.results.find(value => value.name === sample.name).result);
});

for (const dialect of ['postgres']) for (const sample of input.filter(value => value.mode !== 'before')) {
  test(`${dialect}: real by-name refresh ${sample.name}`, async t => {
    const fixture = await setupChildrenFixture(t, dialect), calls = [];
    const itemPath = sample.path.replaceAll('$STATE', fixture.stateRoot);
    await mkdir(itemPath, { recursive: true });
    await fixture.seed({ target: 'target', items: [{ key: 'target', type: sample.type, Id: id, Name: sample.itemName, Path: itemPath,
      DateLastRefreshed: sample.first ? '0001-01-01T00:00:00.0000000Z' : initial, DateModified: '0001-01-01T00:00:00.0000000Z' }] });
    // The source classes in this fixture store no JSON payload. Hydrate their
    // real native namespaces and instance-relative paths before refreshing.
    await fixture.database.update('BaseItems', { Id: id }, { Data: null,
      Type: `MediaBrowser.Controller.Entities.${['MusicGenre', 'MusicArtist'].includes(sample.type) ? 'Audio.' : ''}${sample.type}`,
      Path: createVirtualPathReverser({ programDataPath: fixture.stateRoot })(itemPath) });
    const loaded = await fixture.loadContext(id);
    const expected = native.results.find(value => value.name === sample.name).result;
    if (sample.mode === 'requires') {
      compare({ requiresRefresh: await loaded.requiresRefresh(), Name: loaded.item.Name, Path: loaded.item.Path.replace(fixture.stateRoot, '$STATE') }, expected);
      return;
    }
    const host = new MetadataRefreshHost({ registry: fixture.registry, store: fixture.store, linkedChildren: fixture.linkedChildren, vfs: fixture.vfs,
      loadContext: fixture.loadContext, now: () => recent });
    const closeFixtureHost = fixture.host.close.bind(fixture.host);
    fixture.host.close = async () => {
      const errors = [];
      for (const close of [() => host.close(), closeFixtureHost]) {
        try { await close(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Metadata fixture host cleanup failed.');
    };
    host.updates.on('ItemUpdated', ({ Item, UpdateReason }) => calls.push({ action: 'save', Name: Item.Name, Path: Item.Path.replace(fixture.stateRoot, '$STATE'), reason: UpdateReason }));
    host.updates.on('UserDataReattached', () => calls.push({ action: 'reattach' }));
    const result = await host.refresh(id, { MetadataRefreshMode: sample.metadataMode, ImageRefreshMode: 'None', ForceSave: sample.force ?? false });
    const row = (await fixture.database.rows('BaseItems', { where: { Id: id } }))[0], current = await fixture.loadContext(id);
    compare({ updateType: result.UpdateType, calls, Name: current.item.Name, Path: current.item.Path.replace(fixture.stateRoot, '$STATE'),
      storedPath: row.Path, Data: row.Data, stampChanged: dateTicks(current.item.DateLastRefreshed) !== dateTicks(loaded.item.DateLastRefreshed) }, expected);
  });
}

test('physical artist leaves its media path intact and rebase ignores presentation names', () => {
  const item = { Type: 'MusicArtist', ParentId: parentId, Name: 'Changed Name', Path: 'Z:\\Music\\Artist', IsAccessedByName: false };
  assert.equal(rebasedMetadataPath(item, { metadataPath: 'D:\\State\\metadata' }), null);
  assert.equal(rebasedMetadataPath({ Type: 'Genre', Name: 'Changed Name', Path: 'D:\\State\\metadata\\older\\Preserved.Name' },
    { metadataPath: 'D:\\State\\metadata' }), 'D:\\State\\metadata\\Genre\\Preserved.Name');
});

for (const dialect of ['postgres']) {
  test(`${dialect}: by-name rebase follows metadata storage instead of an overlapping media binding`, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const oldPath = path.join(fixture.stateRoot, 'metadata', 'old-scope', 'Leaf.Name');
    const newPath = path.join(fixture.stateRoot, 'metadata', 'Genre', 'Leaf.Name');
    const oldRoot = path.join(fixture.stateRoot, 'old-metadata-storage'), newRoot = path.join(fixture.stateRoot, 'new-metadata-storage');
    const metadataIdentityMap = new IdentityAccessMap();
    fixture.storage.registerType('by-name-local', configuration => LocalAdapter.open(configuration));
    for (const [instanceId, root, identityRoot] of [['old-metadata', oldRoot, oldPath], ['new-metadata', newRoot, newPath]]) {
      await fixture.storage.createInstance(instanceId, 'by-name-local', { root, createRoot: true, writable: true });
      fixture.vfs.mount({ path: '/' + instanceId, instanceId, capabilities: { create: true, replace: true, mkdir: true, delete: true, rename: true } });
      metadataIdentityMap.addPrefix({ identityRoot, accessRoot: '/' + instanceId, style: 'windows', returnAccess: 'Isolated by-name metadata storage.' });
    }
    const fileSystem = new StorageFileSystem({ vfs: fixture.vfs, identityMap: metadataIdentityMap });
    fixture.loadContext = fixture.host.loadContext = fixture.trackContextLoader(createMetadataContextLoader({ ...fixture, fileSystem, metadataIdentityMap }));
    await fileSystem.writeFile(path.join(oldPath, 'marker.txt'), 'old metadata storage');
    await fileSystem.writeFile(path.join(newPath, 'marker.txt'), 'new metadata storage');
    await fixture.adapter.mkdir('/by-name-old');
    await fixture.adapter.write('/by-name-old/marker.txt', Buffer.from('media binding must not supply metadata'));
    fixture.identityMap.addPrefix({ identityRoot: oldPath, accessRoot: '/fixture/by-name-old', style: 'windows', returnAccess: 'isolated old by-name location' });
    await fixture.seed({ target: 'target', items: [{ key: 'target', type: 'Genre', Id: id, Name: 'Presentation Name', Path: oldPath }] });
    const before = await fixture.loadContext(id);
    assert.equal(before.context.accessPath, undefined);
    assert.equal(before.context.localPath, oldPath);
    assert.equal((await before.imageAssets.read(path.join(oldPath, 'marker.txt'))).toString(), 'old metadata storage');
    assert.equal((await before.fileSystemMetadata()).kind, 'directory');
    const observations = [];
    fixture.registry.register({ id: 'by-name-access', name: 'By-name access', providers: [{
      id: 'by-name-access-local', name: 'By-name access', kind: 'local', itemTypes: ['Genre'],
      getMetadata: async (item, context) => {
        const marker = await context.fileSystem.readFile(path.join(context.localPath, 'marker.txt'), 'utf8');
        observations.push({ Path: item.Path, accessPath: context.accessPath, localPath: context.localPath, marker });
        await context.fileSystem.writeFile(path.join(context.localPath, 'visited.txt'), marker);
        return { HasMetadata: false };
      }
    }] });
    const result = await fixture.host.refresh(id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
    assert.equal(result.Failures, 0);
    assert.deepEqual(observations, [{ Path: newPath, accessPath: undefined, localPath: newPath, marker: 'new metadata storage' }]);
    assert.equal(await readFile(path.join(newRoot, 'visited.txt'), 'utf8'), 'new metadata storage');
    await assert.rejects(readFile(path.join(oldRoot, 'visited.txt')), { code: 'ENOENT' });
    await assert.rejects(fixture.adapter.stat('/by-name-old/visited.txt'), { code: 'not-found' });
    const current = await fixture.loadContext(id);
    assert.equal(current.context.accessPath, undefined);
    assert.equal((await current.imageAssets.resolve(current.item.Path)).localPath, newPath);
    assert.equal((await current.fileSystemMetadata()).kind, 'directory');
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: id } }))[0].Path, '%MetadataPath%\\Genre\\Leaf.Name');
  });

  test(`${dialect}: creating and resaving a person persists a virtual path and reloads the physical directory`, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    await fixture.seed({ target: 'parent', items: [{ key: 'parent', type: 'Movie', Id: parentId, Name: 'Parent' }] });
    const loaded = await fixture.loadContext(parentId);
    const lifecycle = new PeopleMetadataLifecycleHost({ store: fixture.store, loaded, updates: fixture.host.updates });
    const person = await lifecycle.createPerson('First Person');
    const identity = loaded.personIdentity('First Person');
    assert.equal(person.item.Path, identity.Path);
    const storedPath = createVirtualPathReverser({ programDataPath: fixture.stateRoot })(identity.Path);
    assert.match(storedPath, /^%MetadataPath%\\People\\/);
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: identity.Id } }))[0].Path, storedPath);
    await lifecycle.createItems(person);
    assert.equal((await fixture.loadContext(identity.Id)).item.Path, identity.Path);
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: identity.Id } }))[0].Path, storedPath);
  });
}

test('native null-path hooks seal type-specific exceptions independently of the key controls', async () => {
  for (const file of Object.values(nullProvenance.files)) assert.equal(hash(await readFile(new URL('../../' + file.path, import.meta.url))), file.sha256, file.path);
  assert.equal(nullNative.inputSha256, nullProvenance.files.input.sha256);
  assert.equal(nullNative.sourceFilesSha256, nullProvenance.sourceFilesSha256);
  assert.equal(nullNative.actualFrozenNullPathHooks, true);
  assert.equal(nullNative.candidateVerified, false); assert.equal(nullProvenance.candidateVerified, false);
  assert.equal(nullInput.length, 12); assert.equal(nullNative.results.length, 12);
  assert.deepEqual(nullNative.results.map(value => value.name), nullInput.map(value => value.name));
});

test('null-path raw observations retain Person and other by-name exception labels', t => {
  const expected = nullNative.results.find(value => value.name === 'Person-before');
  observeComparison(t, 'null-path diagnostic labels', expected.exception, 'ArgumentNullException');
  assertProjectedEqual(t, 'null-path functional outcome', { ...expected, exception: 'ArgumentNullException' }, expected,
    ({ exception, ...value }) => ({ ...value, failed: exception != null }));
});

for (const sample of nullInput) test(`native null-path hook ${sample.name}`, t => {
  const item = { Type: sample.type, Name: sample.type, Path: null, ParentId: null };
  let exception = null, changed = null;
  try { changed = sample.mode === 'before' ? beforeMetadataRefresh(item, { metadataPath: 'D:\\State\\metadata' })
    : rebasedMetadataPath(item, { metadataPath: 'D:\\State\\metadata' }) != null; }
  catch (error) {
    assert.ok(error instanceof TypeError); assert.ok(error.message);
    exception = error.nativeException ?? error.name;
    observeComparison(t, sample.name + ' actual error', { name: error.name, message: error.message, nativeException: error.nativeException },
      nullNative.results.find(value => value.name === sample.name).exception);
  }
  assertProjectedEqual(t, sample.name, { name: sample.name, exception, changed, itemName: item.Name, Path: item.Path },
    nullNative.results.find(value => value.name === sample.name),
    ({ exception, ...value }) => ({ ...value, failed: exception != null }));
});

for (const dialect of ['postgres']) for (const sample of nullInput.filter(value => value.mode === 'requires')) {
  test(`${dialect}: actual context preserves the null-path exception ${sample.type}`, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    await fixture.seed({ target: 'target', items: [{ key: 'target', type: sample.type, Id: id, Name: sample.type, Path: null }] });
    const loaded = await fixture.loadContext(id);
    const before = await fixture.database.rows('BaseItems');
    await assert.rejects(loaded.requiresRefresh(), error => {
      assert.ok(error instanceof TypeError); assert.ok(error.message);
      observeComparison(t, sample.name + ' context error', { name: error.name, message: error.message, nativeException: error.nativeException },
        nullNative.results.find(value => value.name === sample.name).exception);
      return true;
    });
    assert.deepEqual(await fixture.database.rows('BaseItems'), before);
  });
}
