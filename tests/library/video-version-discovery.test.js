import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseLosslessJson } from '../../src/core/json.js';
import { guid, sameId } from '../../src/library/records.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { resolveOrdinaryVideoFile } from '../../src/library/video-file-resolver.js';
import { persistMetadata } from '../../src/metadata/persistence.js';
import { dateText, EMPTY_ID, MIN_DATE, idKey } from '../../src/library/records.js';
import { internalImagePath } from '../../src/metadata/image-paths.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { readCachedFolderChildren, setFolderChildren } from '../../src/library/folder-cache.js';
import { readdir } from 'node:fs/promises';
import { ProbeService } from '../../src/library/probe-service.js';
import { ImageService } from '../../src/images/service.js';
import { nativeGuid } from '../../src/users/native.js';
import { quoteIdentifier } from '../../src/database/model.js';

import { videoData, folderData, typeName, ordinal, integer, discoveryFixture, projectItem, projectDiscovery } from './video-discovery-fixture.js';
import { prepareIgnoreFileFixture } from './ignore-file-fixture.js';
import { fixturePathStyle } from './fixture-state-path.js';
import { makeUdfImage } from '../storage/fixtures/udf-disc-type.js';

const root = new URL('./fixtures/video-version-discovery/', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async name => parseLosslessJson(await readFile(new URL(name, root), 'utf8'))));
const ids = { owner: '98C00000-0000-0000-0000-000000000001', parent: '98C00000-0000-0000-0000-000000000002' };
const movieType = 'MediaBrowser.Controller.Entities.Movies.Movie', videoType = 'MediaBrowser.Controller.Entities.Video';

test('video version discovery recording seals actual resolver/batch/delete scope and exact Int64', async () => {
  for (const file of provenance.fixtureFiles) {
    const source = file.path === 'tests/Directory.Build.props' ? new URL('../../../Directory.Build.props', root)
      : new URL(file.path.split('/').at(-1), root);
    assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'), file.sha256, file.path);
  }
  assert.equal(native.actualFrozenVideoVersionDiscovery, true);
  assert.equal(native.inputSha256, provenance.fixtureFiles[0].sha256);
  assert.equal(native.scope, provenance.scope); assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
  assert.deepEqual(native.results.map(result => result.exception), input.map(sample => sample.expectException ?? null));
  assert.equal(native.results.length, 23);
  const existing = native.results.find(result => result.name === 'update-existing-typed-version-not-reresolved');
  assert.equal(existing.rows.find(row => row.name === 'Old version').runTimeTicks, 9007199254740995n);
});

async function setupVersion(t, dialect, name) {
  const fixture = await setupChildrenFixture(t, dialect);
  // The frozen ServerConfiguration constructor defaults this to true.
  fixture.configuration.EnableCaseSensitiveItemIds = true;
  const sample = input.find(value => value.name === name), expected = native.results.find(value => value.name === name);
  const directory = path.join(fixture.stateRoot, 'media'), target = path.join(directory, sample.files[0]);
  await fixture.adapter.mkdir('/discovery');
  await fixture.adapter.write('/discovery/primary.mkv', Buffer.from('primary control'));
  for (const filename of sample.files) await fixture.adapter.write('/discovery/' + filename,
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('media control')]));
  fixture.identityMap.addPrefix({ identityRoot: directory, accessRoot: '/fixture/discovery', style: fixturePathStyle,
    returnAccess: 'isolated ordinary version resolution controls' });
  await prepareIgnoreFileFixture(fixture);
  fixture.loadContext = fixture.host.loadContext = ownedLoader(fixture);
  const wrongReference = expected.calls.find(call => call.action === 'delete')?.ids[0];
  const wrongId = wrongReference && nativeGuid(wrongReference);
  await fixture.seed({ target: 'owner', items: [
    { key: 'parent', type: 'Folder', Id: ids.parent, Name: 'Parent', Path: directory },
    { key: 'owner', type: 'Movie', Id: ids.owner, Name: 'Stored owner', Path: path.join(directory, 'primary.mkv'),
      parent: 'parent', IsInMixedFolder: sample.mixed ?? false, LocalAlternateVersions: [target] },
    ...(wrongId ? [{ key: 'wrong', type: 'Video', Id: wrongId, Name: 'Old version', Path: target, parent: 'parent' }] : [])
  ] });
  const loaded = await fixture.loadContext(ids.owner);
  if (wrongId) assert.equal(nativeGuid(loaded.getNewItemId(target, videoType)), wrongId);
  loaded.item.Name = 'Updated owner';
  return { fixture, loaded, sample, expected, target, wrongId };
}

for (const dialect of ['postgres']) for (const sample of input) {
  test(`${dialect}: complete native discovery ${sample.name}`, { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const value = await discoveryFixture(t, dialect, sample), { fixture, loaded, calls, target } = value;
    const cancellation = new AbortController();
    if (sample.cancelled) cancellation.abort(Object.assign(new Error('Controlled cancellation'), { nativeException: 'OperationCanceledException' }));
    let resolved = null, exception = null;
    try {
      if (sample.operation === 'resolve') resolved = await loaded.videoVersionDiscovery.resolveAlternateVersion(loaded, target, typeName(sample.expectedType),
        { reportRemoved: (item, parent) => fixture.host.updates.reportItemRemoved(item, parent) });
      else await fixture.host.updates.updateRepository(loaded, { Item: loaded.item, Images: null }, ItemUpdateType.MetadataImport, {
        signal: cancellation.signal,
        saverOperation: async () => { value.activate(); calls.push({ action: 'saver', id: guid(ids.owner), reason: 2 }); return []; },
        persist: async (updated, result, options) => {
          calls.push({ action: 'save', items: [updated.item, ...options.newVersions].map(item => projectItem(item, fixture.stateRoot)), cancellable: true });
          return persistMetadata(fixture.store, loaded, result, options);
        }
      });
    } catch (error) {
      if (error.nativeException) exception = error.nativeException;
      else {
        assert.ok(sample.expectException, error.stack);
        assert.equal(error.code, 'P0001', error.stack);
        exception = sample.failure === 'delete' ? 'SqliteException' : 'DbUpdateException';
      }
    }
    assert.deepEqual(await projectDiscovery(fixture, loaded, sample, { ...value, resolved, exception }), native.results.find(result => result.name === sample.name));
  });
}

for (const dialect of ['postgres']) {
  const databaseTest = (name, run) => test(`${dialect}: ${name}`, { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, run);
  databaseTest('a metadata save resolves and creates its absent typed local version', async t => {
    const { fixture, loaded, expected, target } = await setupVersion(t, dialect, 'update-new-version-inherits-mixed');
    const alternate = expected.rows.find(row => sameId(row.ownerId, ids.owner));
    assert.equal(guid(loaded.getNewItemId(target, movieType)), alternate.id);
    await fixture.host.updates.update(loaded, { Item: loaded.item, Images: null }, ItemUpdateType.MetadataImport);
    const [created] = await fixture.database.rows('BaseItems', { where: { Id: nativeGuid(alternate.id) } });
    assert.ok(created, 'LibraryManager.UpdateItems must create the missing alternate before saving version relations.');
    assert.equal(created.Type, alternate.type); assert.equal(created.Name, alternate.name); assert.equal(created.Path, target);
    assert.equal(created.OwnerId.toLowerCase(), alternate.ownerId); assert.equal(created.PrimaryVersionId.toLowerCase(), alternate.primaryVersionId);
    assert.equal(created.ParentId, alternate.parentId); assert.equal(created.TopParentId, alternate.topParentId);
    assert.equal(created.IsInMixedFolder, alternate.mixed);
    assert.equal(created.DateCreated, alternate.dateCreated); assert.equal(created.DateModified, alternate.dateModified);
    assert.deepEqual((await fixture.database.rows('LinkedChildren', { where: { ParentId: ids.owner } }))
      .map(link => ({ child: link.ChildId.toLowerCase(), type: link.ChildType, order: link.SortOrder })),
    expected.links.map(link => ({ child: link.childId, type: link.childType, order: link.sortOrder })));
  });
  databaseTest('an already-cancelled save retains the independent wrong-type deletion', async t => {
    const { fixture, loaded, wrongId, expected } = await setupVersion(t, dialect, 'update-cancelled-wrong-type-cleanup-still-commits');
    const cancellation = new AbortController();
    cancellation.abort(Object.assign(new Error('Controlled cancellation'), { nativeException: 'OperationCanceledException' }));
    await assert.rejects(fixture.host.updates.update(loaded, { Item: loaded.item, Images: null }, ItemUpdateType.MetadataImport,
      { signal: cancellation.signal }), { nativeException: expected.exception });
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: wrongId } })).length, 0,
      'Fast wrong-type cleanup is an independent boundary before the cancelled SaveItems transaction.');
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: ids.owner } }))[0].Name, 'Stored owner');
  });
  databaseTest('an already-cancelled version batch rejects before any new-version insert SQL', async t => {
    const { fixture, loaded, wrongId, target } = await setupVersion(t, dialect, 'update-cancelled-wrong-type-cleanup-still-commits');
    const alternateId = nativeGuid(loaded.getNewItemId(target, movieType));
    const schema = quoteIdentifier(fixture.database.schemaName);
    await fixture.database.client.query(`CREATE FUNCTION ${schema}.reject_cancelled_version() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW."Id" = '${alternateId}' THEN RAISE EXCEPTION 'Unexpected cancelled version insert'; END IF; RETURN NEW; END; $$`);
    await fixture.database.client.query(`CREATE TRIGGER reject_cancelled_version BEFORE INSERT ON ${schema}."BaseItems"
      FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_cancelled_version()`);
    const cancellation = new AbortController();
    const reason = Object.assign(new Error('Controlled cancellation'), { nativeException: 'OperationCanceledException' });
    cancellation.abort(reason);
    await assert.rejects(fixture.host.updates.update(loaded, { Item: loaded.item, Images: null }, ItemUpdateType.MetadataImport,
      { signal: cancellation.signal }), reason);
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: wrongId } })).length, 0);
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: alternateId } })).length, 0);
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: ids.owner } }))[0].Name, 'Stored owner');
  });
  databaseTest('wrong-type deletion advances only the internally removed version link baseline', async t => {
    const { fixture, wrongId, target } = await setupVersion(t, dialect, 'update-cancelled-wrong-type-cleanup-still-commits');
    await fixture.database.insert('LinkedChildren', { ParentId: ids.owner, ChildId: wrongId, ChildType: 2, SortOrder: 0 });
    const loaded = await fixture.loadContext(ids.owner);
    const serializeWrites = fixture.store.serializeWrites.bind(fixture.store);
    let writerBoundaryDepth = 0, baselinePublications = 0, versionLinks = loaded.versionLinks;
    fixture.store.serializeWrites = (operation, options) => serializeWrites(async database => {
      writerBoundaryDepth++;
      try { return await operation(database); }
      finally { writerBoundaryDepth--; }
    }, options);
    Object.defineProperty(loaded, 'versionLinks', {
      configurable: true,
      enumerable: true,
      get: () => versionLinks,
      set: value => {
        assert.ok(writerBoundaryDepth > 0, 'a committed version-link baseline must publish before releasing the writer lock');
        baselinePublications++;
        versionLinks = value;
      }
    });
    loaded.item.Name = 'Updated owner';
    await fixture.host.updates.update(loaded, { Item: loaded.item, Images: null }, ItemUpdateType.MetadataImport);
    const alternateId = nativeGuid(loaded.getNewItemId(target, movieType));
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: wrongId } })).length, 0);
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: alternateId } })).length, 1);
    assert.ok(baselinePublications >= 2, 'wrong-type cleanup and the final metadata save both publish committed baselines');
    assert.deepEqual(loaded.versionLinks.map(link => link.ChildId), [alternateId]);
  });
  databaseTest('a missing version destination is preflighted before any saver, image or wrong-type deletion', async t => {
    const { fixture, loaded, wrongId } = await setupVersion(t, dialect, 'update-cancelled-wrong-type-cleanup-still-commits');
    const before = await fixture.database.rows('BaseItems'), writes = [];
    const error = Object.assign(new Error('Controlled D3 rejection'), { status: 501 });
    fixture.host.updates.registry = { discover: ({ item }) => [{ name: 'Controlled',
      isEnabledFor: () => true, validateSave: () => { if (!sameId(item.Id, ids.owner)) throw error; },
      save: () => { writes.push(item.Id); } }] };
    loaded.saveLocalMetadataEnabled = true;
    const draftContext = loaded.loadDraftContext;
    loaded.loadDraftContext = async item => ({ ...await draftContext(item), saveLocalMetadataEnabled: true });
    await assert.rejects(fixture.host.updates.update(loaded, { Item: loaded.item, Images: null }, ItemUpdateType.MetadataImport), error);
    assert.deepEqual(writes, []); assert.deepEqual(await fixture.database.rows('BaseItems'), before);
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: wrongId } })).length, 1);
  });
  databaseTest('the technical probe producer includes new versions in its atomic metadata/stream save', async t => {
    const { fixture, target } = await setupVersion(t, dialect, 'update-new-version-inherits-mixed');
    await fixture.database.update('BaseItems', { Id: ids.owner }, { MediaType: 'Video' });
    const probe = new ProbeService({ ...fixture, updates: fixture.host.updates, probe: async () => ({ raw: {
      format: { format_name: 'matroska', duration: '1' }, streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 640, height: 480 }]
    } }) });
    t.after(() => probe.close());
    assert.equal((await probe.refresh(ids.owner, { force: true })).changed, true);
    const loaded = await fixture.loadContext(ids.owner), alternateId = nativeGuid(loaded.getNewItemId(target, movieType));
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: alternateId } }))[0].OwnerId, ids.owner);
    assert.equal((await fixture.database.rows('MediaStreamInfos', { where: { ItemId: ids.owner } })).length, 1);
    assert.deepEqual(loaded.versionLinks.map(link => nativeGuid(link.ChildId)), [alternateId]);
  });
  databaseTest('the production single-file resolver inherits configured movie context from the real parent path', async t => {
    const { fixture, loaded, target } = await setupVersion(t, dialect, 'update-missing-movie-retains-movie-initial-values');
    fixture.configuration.ContentTypes = [{ Name: path.dirname(target), Value: 'movies' }];
    assert.equal(loaded.getVideoVersionCollectionType(), 'movies');
    await fixture.host.updates.updateRepository(loaded, { Item: loaded.item, Images: null }, ItemUpdateType.MetadataImport);
    const [alternate] = await fixture.database.rows('BaseItems', { where: { Id: nativeGuid(loaded.getNewItemId(target, movieType)) } });
    assert.equal(alternate.Name, 'Film'); assert.equal(alternate.ProductionYear, 2025);
    assert.equal(alternate.ParentId, ids.parent); assert.equal(alternate.Size, 16n);
  });
  databaseTest('metadata version discovery reads UDF and preserves disc type only for the resolved native type', async t => {
    const { fixture, loaded, target } = await setupVersion(t, dialect, 'update-missing-movie-retains-movie-initial-values');
    const imagePath = path.join(path.dirname(target), 'Image Version.img');
    await fixture.adapter.write('/discovery/Image Version.img', makeUdfImage({ discType: 'BluRay', metadata: true, extended: true }));
    fixture.configuration.ContentTypes = [{ Name: path.dirname(target), Value: 'movies' }];
    loaded.item.LocalAlternateVersions = [imagePath];
    await fixture.host.updates.updateRepository(loaded, { Item: loaded.item, Images: null }, ItemUpdateType.MetadataImport);
    const alternateId = nativeGuid(loaded.getNewItemId(imagePath, movieType));
    const [alternate] = await fixture.database.rows('BaseItems', { where: { Id: alternateId } });
    assert.equal(alternate.Type, movieType); assert.equal(alternate.Path, imagePath);
    assert.equal(alternate.OwnerId, ids.owner); assert.equal(alternate.PrimaryVersionId, ids.owner);
    assert.equal(alternate.ParentId, ids.parent);
    assert.equal(JSON.parse(alternate.Data).VideoType, 'Iso');
    assert.equal(JSON.parse(alternate.Data).IsoType, 'BluRay');
    fixture.library.itemCreation.unregisterItem(alternateId);
    const cold = await fixture.loadContext(alternateId);
    assert.equal(cold.item.VideoType, 'Iso'); assert.equal(cold.item.IsoType, 'BluRay');
    await cold.dispose();
    const part = await loaded.videoVersionDiscovery.resolveAlternateVersion(loaded, imagePath, videoType);
    assert.equal(part.NativeType, videoType); assert.equal(part.Path, imagePath);
    assert.equal(part.VideoType, 'Iso');
    assert.equal(part.IsoType, null, 'native subtype-to-Video coercion copies five fields and excludes IsoType');
  });
  databaseTest('the custom image persistence producer saves new versions and their relation before recursive propagation', async t => {
    const { fixture, loaded, target } = await setupVersion(t, dialect, 'update-new-version-inherits-mixed');
    const images = new ImageService({fileSystem: testFileSystem,  ...fixture, metadataUpdates: fixture.host.updates, metadataPath: loaded.metadataPath });
    t.after(() => images.close());
    const imageContext = await images.load(ids.owner);
    await images.imageUpdate(imageContext, loaded);
    const alternateId = nativeGuid(loaded.getNewItemId(target, movieType));
    const [alternate] = await fixture.database.rows('BaseItems', { where: { Id: alternateId } });
    assert.equal(alternate.OwnerId, ids.owner); assert.notEqual(alternate.DateLastSaved, null);
    assert.deepEqual((await fixture.loadContext(ids.owner)).versionLinks.map(link => nativeGuid(link.ChildId)), [alternateId]);
  });
}

function ownedLoader(fixture){const base=createMetadataContextLoader({fileSystem:testFileSystem,...fixture}),contexts=new Set();const loader=Object.assign(async(...args)=>{const loaded=await base(...args),dispose=loaded.dispose.bind(loaded);contexts.add(loaded);loaded.dispose=async()=>{try{await dispose();}finally{contexts.delete(loaded);}};return loaded;},base);loader.withContext=async(reference,options,operation)=>{const loaded=await loader(reference,options);try{return await operation(loaded);}finally{await loaded.dispose();}};const close=fixture.host.close.bind(fixture.host);fixture.host.close=async()=>{await close();for(const loaded of contexts)await loaded.dispose();};return loader;}
