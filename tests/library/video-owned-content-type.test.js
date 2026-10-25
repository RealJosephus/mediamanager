import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { testFileSystem } from '../storage/plugin-files.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { movieNativeType, videoNativeType } from '../../src/library/video-file-resolver.js';
import { idKey } from '../../src/library/records.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { nativeGuid } from '../../src/users/native.js';
import { folderData, videoData } from './video-discovery-fixture.js';
import { prepareIgnoreFileFixture } from './ignore-file-fixture.js';
import { fixturePathStyle } from './fixture-state-path.js';
import { makeUdfImage } from '../storage/fixtures/udf-disc-type.js';

export const requiredValidationServices = ['postgres'];
const options = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000 };
const ids = Object.fromEntries(['owner', 'parent', 'ancestor', 'aggregate', 'root', 'collection']
  .map((key, index) => [key, `98d10000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`]));
const observeFailure = t => error => {
  t.diagnostic(JSON.stringify({ name: error.name, message: error.message, code: error.code, status: error.status,
    nativeException: error.nativeException, parameterName: error.parameterName, stack: error.stack }));
  return true;
};

// LibraryManager.GetContentType is the owned-video producer. The repository
// batch deliberately uses GetTopFolderContentType(parent) instead. Existing
// native-scan-context recordings independently seal the former's enum and
// first-match rules; these controls exercise their actual async producers.
async function setup(t, { collectionParents = false } = {}) {
  const fixture = await setupChildrenFixture(t);
  fixture.configuration.EnableCaseSensitiveItemIds = true;
  const directory = path.join(fixture.stateRoot, 'media');
  const ancestorPath = path.join(fixture.stateRoot, 'unrelated-parent');
  const rootPath = path.join(fixture.stateRoot, 'root', 'default');
  fixture.library.options.userRoot = { Id: ids.root, Type: 'MediaBrowser.Controller.Entities.UserRootFolder',
    Path: rootPath, IsFolder: true, IsRoot: true };
  fixture.identityMap.addPrefix({ identityRoot: directory, accessRoot: '/fixture/owned-content', style: fixturePathStyle,
    returnAccess: 'Isolated owned-video content-type files.' });
  await fixture.adapter.mkdir('/owned-content');
  await fixture.adapter.write('/owned-content/primary.mkv', Buffer.from('primary control'));
  await prepareIgnoreFileFixture(fixture);
  await fixture.seed({ target: 'owner', items: [
    { ...folderData(), key: 'aggregate', type: 'AggregateFolder', Id: ids.aggregate,
      Path: path.join(fixture.stateRoot, 'aggregate'), IsRoot: true },
    ...(collectionParents ? [{ ...folderData(), key: 'ancestor', type: 'CollectionFolder', Id: ids.ancestor,
      Path: ancestorPath, parent: 'aggregate', CollectionType: 'books', PhysicalLocationsList: [] }] : []),
    { ...folderData(), key: 'parent', type: collectionParents ? 'CollectionFolder' : 'Folder', Id: ids.parent,
      Path: directory, parent: collectionParents ? 'ancestor' : 'aggregate',
      ...(collectionParents ? { CollectionType: 'photos', PhysicalLocationsList: [] } : {}) },
    { ...folderData(), key: 'root', type: 'UserRootFolder', Id: ids.root, Path: rootPath, IsRoot: true },
    { ...folderData(), key: 'collection', type: 'CollectionFolder', Id: ids.collection, parent: 'root',
      Path: path.join(rootPath, 'Music videos'), CollectionType: 'musicvideos',
      PhysicalLocationsList: [collectionParents ? ancestorPath : directory] },
    { ...videoData(), key: 'owner', type: 'Movie', Id: ids.owner, Path: path.join(directory, 'primary.mkv'),
      parent: 'parent', IsInMixedFolder: true, MediaType: 'Video' },
  ] });
  // Native GetUserRootFolder keeps one root instance before its first Children
  // read. Register that root without warming Children or replaying its IDs.
  const root = await fixture.library.itemCreation.getItemById(ids.root);
  assert.equal(root.NativeType, 'MediaBrowser.Controller.Entities.UserRootFolder');
  const loader = fixture.trackContextLoader(createMetadataContextLoader({ fileSystem: testFileSystem, ...fixture }));
  const loaded = await loader(ids.owner);
  // Cold LoadChildren returns its repository occurrence, which may differ from
  // a later manager lookup. Mutate the actual root occurrence used by metadata.
  assert.equal(loaded.collectionFolders.length, 1);
  const [collection] = loaded.collectionFolders;
  assert.equal(idKey(collection.Id), idKey(ids.collection));
  assert.equal(collection.NativeType, 'MediaBrowser.Controller.Entities.CollectionFolder');
  const state = await loaded.loadLibraryState();
  try {
    await fixture.library.withRootFolderPlan(state, async ({ session, plan, withSlot }) => {
      const { rows } = await session.client.query({ text: `SELECT "SlotKey" FROM (${plan.text}) roots ORDER BY "Ordinal" LIMIT 2`,
        values: plan.values });
      assert.equal(rows.length, 1);
      await withSlot(rows[0].SlotKey, item => {
        assert.equal(idKey(item.Id), idKey(collection.Id));
        assert.equal(item.NativeType, collection.NativeType); assert.equal(item.Path, collection.Path);
        const locations = collection.PhysicalLocationsList, changed = path.join(fixture.stateRoot, 'live-root-location');
        try {
          item.PhysicalLocationsList = [changed];
          assert.deepEqual(collection.PhysicalLocationsList, [changed], 'The scalar root mutation reaches the active metadata root.');
          collection.PhysicalLocationsList = locations;
          assert.deepEqual(item.PhysicalLocationsList, locations, 'The metadata root mutation reaches the borrowed scalar consumer.');
        } finally { collection.PhysicalLocationsList = locations; }
      });
    });
  } finally { await state.dispose(); }
  return { fixture, loaded, collection, directory };
}

test('postgres: owned content type preserves direct/inherited override priority and the first matching failure prefix', options, async t => {
  const { fixture, loaded, directory } = await setup(t);
  const configuration = fixture.configuration;
  try {
    configuration.ContentTypes = [{ Name: fixture.stateRoot, Value: 'music' }, { Name: directory, Value: 'movies' }];
    assert.equal(await loaded.getOwnedVideoCollectionType(), 'movies', 'Direct configuration precedes an earlier ancestor prefix.');
    assert.equal(await loaded.getVideoVersionCollectionType(), 'musicvideos', 'Repository updates ignore ContentTypes.');
    configuration.ContentTypes = [{ Name: fixture.stateRoot, Value: 'music' }, { Name: directory, Value: 'invalid' }];
    assert.equal(await loaded.getOwnedVideoCollectionType(), 'music', 'A failed direct parse starts the separate inherited pass.');
    for (const value of [null, '', '   ', 'invalid', 'Movies']) {
      configuration.ContentTypes = [{ Name: directory, Value: value }, { Name: directory, Value: 'movies' }, null];
      assert.equal(await loaded.getOwnedVideoCollectionType(), 'musicvideos',
        `The first matching ${JSON.stringify(value)} value hides later matches and null members in both passes.`);
    }
    configuration.ContentTypes = [{ Name: directory, Value: 'movies' }, null];
    assert.equal(await loaded.getOwnedVideoCollectionType(), 'movies');
    configuration.ContentTypes = [null, { Name: directory, Value: 'movies' }];
    await assert.rejects(loaded.getOwnedVideoCollectionType(), observeFailure(t));
    configuration.ContentTypes = null;
    await assert.rejects(loaded.getOwnedVideoCollectionType(), observeFailure(t));
    assert.equal(await loaded.getVideoVersionCollectionType(), 'musicvideos');
  } finally { await loaded.dispose(); }
});

test('postgres: owned content type reads the live root only after overrides and then uses the last configured physical parent', options, async t => {
  const { fixture, loaded, collection, directory } = await setup(t, { collectionParents: true });
  try {
    assert.equal(await loaded.getOwnedVideoCollectionType(), 'musicvideos', 'A matched root type precedes physical-parent configuration.');
    collection.PhysicalLocationsList = [];
    assert.equal(await loaded.getOwnedVideoCollectionType(), 'books', 'Parent configuration retains Native LastOrDefault order.');
    fixture.configuration.ContentTypes = null;
    assert.equal(await loaded.getOwnedVideoCollectionType(loaded.parents[0]), 'photos', 'ICollectionFolder does not enumerate ContentTypes.');
    collection.PhysicalLocationsList = null;
    fixture.configuration.ContentTypes = [{ Name: directory, Value: 'movies' }];
    assert.equal(await loaded.getOwnedVideoCollectionType(), 'movies', 'A configured result must not read an invalid root list.');
    await assert.rejects(loaded.getVideoVersionCollectionType(), observeFailure(t));
    fixture.configuration.ContentTypes = [];
    await assert.rejects(loaded.getOwnedVideoCollectionType(), observeFailure(t));
  } finally { await loaded.dispose(); }
});

test('postgres: owned UDF creation and repository alternates use their distinct native content-type producers', options, async t => {
  const { fixture, loaded, directory } = await setup(t);
  try {
    fixture.configuration.ContentTypes = [{ Name: directory, Value: 'movies' }];
    const image = makeUdfImage({ discType: 'BluRay', metadata: true, extended: true });
    const repositoryPath = path.join(directory, 'Repository Version.img'), ownedPath = path.join(directory, 'Owned Version.img');
    await fixture.adapter.write('/owned-content/Repository Version.img', image);
    await fixture.adapter.write('/owned-content/Owned Version.img', image);
    loaded.item.LocalAlternateVersions = [repositoryPath];
    await fixture.host.updates.updateRepository(loaded, { Item: loaded.item, Images: null }, ItemUpdateType.MetadataImport);
    const repositoryId = nativeGuid(loaded.getNewItemId(repositoryPath, movieNativeType));
    const [repository] = await fixture.database.rows('BaseItems', { where: { Id: repositoryId } });
    assert.equal(repository.Type, movieNativeType);
    assert.equal(repository.ParentId, null, 'MusicVideo-to-Movie coercion drops resolver ParentId.');
    assert.equal(JSON.parse(repository.Data).VideoType, 'Iso');
    assert.equal(Object.hasOwn(JSON.parse(repository.Data), 'IsoType'), false,
      'The five-field coercion leaves IsoType at its omitted native JSON default.');
    const owned = await loaded.videoVersionDiscovery.createOwnedVideo(loaded, ownedPath, movieNativeType, { alternate: true });
    assert.equal(owned.created, true);
    assert.equal(owned.item.NativeType, movieNativeType);
    assert.equal(idKey(owned.item.ParentId), idKey(ids.parent));
    assert.equal(owned.item.IsoType, 'BluRay', 'The configured Movie needs no subtype coercion.');
    const [stored] = await fixture.database.rows('BaseItems', { where: { Id: owned.item.Id } });
    assert.equal(idKey(stored.ParentId), idKey(ids.parent));
    assert.equal(idKey(stored.OwnerId), idKey(ids.owner));
    assert.equal(JSON.parse(stored.Data).IsoType, 'BluRay');
  } finally { await loaded.dispose(); }
});

test('postgres: owned configuration failure precedes wrong-type deletion and absent part previews skip configuration', options, async t => {
  const { fixture, loaded, directory } = await setup(t);
  try {
    const alternatePath = path.join(directory, 'New Version.mkv');
    await fixture.adapter.write('/owned-content/New Version.mkv', Buffer.from('new version'));
    const wrongId = nativeGuid(loaded.getNewItemId(alternatePath, videoNativeType));
    await fixture.database.insert('BaseItems', { ...loaded.snapshot, Id: wrongId, Type: videoNativeType,
      Name: 'Existing wrong-type video', Path: loaded.reversePath(alternatePath), Data: JSON.stringify(videoData()) });
    fixture.configuration.ContentTypes = null;
    await assert.rejects(loaded.videoVersionDiscovery.createOwnedVideo(loaded, alternatePath, movieNativeType, { alternate: true }),
      observeFailure(t));
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: wrongId } })).length, 1);
    loaded.item.AdditionalParts = [path.join(directory, 'Absent Part.mkv')];
    assert.deepEqual(await loaded.videoVersionDiscovery.previewOwnedParts(loaded), []);
  } finally { await loaded.dispose(); }
});
