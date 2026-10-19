import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { boxSetNativeType, newNativeItemEntity, playlistNativeType } from '../../src/library/index.js';
import { parentId, subjectId, sampleContext, runtimeFixture } from './collection-playlist-runtime-fixture.js';

test('Production runtime registers special resolvers without physical Playlist traversal', async t => {
  const { runtime } = await runtimeFixture(t);
  const pipeline = runtime.folderValidation.resolverPipeline;
  assert.ok(pipeline.nativeTypes.includes(playlistNativeType));
  assert.ok(pipeline.nativeTypes.includes(boxSetNativeType));
  const context = sampleContext({ name: 'chain-both-markers', resolver: 'chain', target: 'Saga [boxset] [playlist]',
    directories: ['Saga [boxset] [playlist]'] });
  const result = await pipeline.resolve({ ...context, candidates: [context.candidate] });
  assert.equal(result.claims[0].nativeType, playlistNativeType);
  assert.equal(result.claims[0].traversal, 'none');
  assert.equal(runtime.libraryScanner.capabilities.completeLibraryScan, true);
});

test('Production folder validation persists external and directory Playlists without creating physical children', async t => {
  const { fixture, runtime } = await runtimeFixture(t);
  const media = 'Z:\\PlaylistValidation';
  fixture.identityMap.addPrefix({ identityRoot: media, accessRoot: '/fixture/playlists', style: 'windows',
    returnAccess: 'Isolated production Playlist validation.' });
  await fixture.adapter.mkdir('/playlists');
  await fixture.adapter.mkdir('/playlists/Favorites [playlist]');
  await fixture.adapter.write('/playlists/Favorites [playlist]/must-not-be-discovered.mp3', Buffer.from('neutral media'));
  await fixture.adapter.write('/playlists/Road Trip.M3U', Buffer.from('neutral playlist'));
  await fixture.seed({ target: 'root', items: [
    { key: 'root', type: 'Folder', Id: parentId, Path: media, TopParentId: parentId },
    { key: 'linked', type: 'Audio', Id: subjectId(80), Name: 'Linked music', Path: null }
  ] });
  const parent = await runtime.itemCreation.getItemById(parentId);
  const createdItems = await runtime.library.validateChildren(parent, { collectionType: 'music',
    recursive: true, refreshChildMetadata: false });
  assert.equal(createdItems.created.length, 2);
  assert.ok(createdItems.created.every(item => item.Type === 'Playlist'));
  const directory = createdItems.created.find(item => item.Name === 'Favorites');
  const file = createdItems.created.find(item => item.Name === 'Road Trip');
  assert.equal(directory.OpenAccess, true);
  assert.equal(file.OpenAccess, true);
  assert.equal(file.MediaType, 'Audio');
  assert.equal(file.IsFolder, true);
  assert.equal(file.IsInMixedFolder, true);
  assert.deepEqual(await fixture.database.rows('BaseItems', { where: { ParentId: directory.Id } }), []);
  await fixture.database.insert('LinkedChildren', { ParentId: directory.Id, ChildId: subjectId(80), SortOrder: 0, ChildType: 0 });
  const before = await fixture.database.rows('LinkedChildren', { where: { ParentId: directory.Id } });
  const controller = new AbortController(); controller.abort();
  assert.equal((await runtime.library.validateChildren(directory, { recursive: true, signal: controller.signal })).skipped, false);
  await runtime.library.validateChildren(parent, { collectionType: 'music', recursive: true, refreshChildMetadata: false });
  assert.deepEqual(await fixture.database.rows('LinkedChildren', { where: { ParentId: directory.Id } }), before);
  assert.deepEqual(await fixture.database.rows('BaseItems', { where: { ParentId: directory.Id } }), [],
    'Resolution may inspect directory entries; Playlist validation never creates physical children.');
  runtime.itemCreation.unregisterItem(file.Id);
  const cold = await runtime.itemCreation.getItemById(file.Id);
  assert.equal(cold.MediaType, 'Audio'); assert.equal(cold.OpenAccess, true);
});

test('Production validation retains internal Playlist identity and links after playlist.xml disappears', async t => {
  const { fixture, runtime } = await runtimeFixture(t);
  const media = path.join(fixture.stateRoot, 'data', 'playlists');
  const playlistFile = path.join(media, 'Favorites', 'playlist.xml');
  await mkdir(path.dirname(playlistFile), { recursive: true });
  await writeFile(playlistFile, 'neutral XML');
  const parent = newNativeItemEntity('Emby.Server.Implementations.Playlists.PlaylistsFolder');
  Object.assign(parent, { Id: parentId, Path: media });
  await runtime.itemCreation.saveItems([parent]);
  const linked = newNativeItemEntity('MediaBrowser.Controller.Entities.Audio.Audio');
  Object.assign(linked, { Id: subjectId(80), Name: 'Linked music' });
  await runtime.itemCreation.saveItems([linked]);
  const first = await runtime.library.validateChildren(parent, { recursive: true, refreshChildMetadata: false });
  assert.equal(first.created.length, 1);
  const playlist = first.created[0];
  await fixture.database.insert('LinkedChildren', { ParentId: playlist.Id, ChildId: linked.Id, SortOrder: 0, ChildType: 0 });
  const before = await fixture.database.rows('LinkedChildren', { where: { ParentId: playlist.Id } });
  await unlink(playlistFile);
  const second = await runtime.library.validateChildren(parent, { recursive: true, refreshChildMetadata: false });
  assert.equal(second.created.length, 0);
  assert.equal(second.resolved.length, 1);
  assert.equal(second.resolved[0].Id, playlist.Id);
  assert.deepEqual(await fixture.database.rows('LinkedChildren', { where: { ParentId: playlist.Id } }), before);
});

test('Production validation recursively creates BoxSet children and persists only its own TMDB attribute', async t => {
  const { fixture, runtime } = await runtimeFixture(t);
  const media = 'Z:\\BoxSetValidation [tmdb=999]';
  fixture.identityMap.addPrefix({ identityRoot: media, accessRoot: '/fixture/boxsets', style: 'windows',
    returnAccess: 'Isolated production BoxSet validation.' });
  await fixture.adapter.mkdir('/boxsets');
  await fixture.adapter.mkdir('/boxsets/Saga [boxset] [tmdb=007]');
  await fixture.adapter.write('/boxsets/Saga [boxset] [tmdb=007]/One.epub', Buffer.from('neutral book'));
  await fixture.seed({ target: 'root', items: [
    { key: 'root', type: 'Folder', Id: parentId, Path: media, TopParentId: parentId }
  ] });
  const rootItem = await runtime.itemCreation.getItemById(parentId);
  const result = await runtime.library.validateChildren(rootItem, { collectionType: 'books',
    recursive: true, refreshChildMetadata: false });
  assert.equal(result.created.length, 1);
  const boxSet = result.created[0];
  assert.equal(boxSet.NativeType, boxSetNativeType);
  assert.equal(boxSet.ProviderIds.Tmdb, '007');
  const children = await fixture.database.rows('BaseItems', { where: { ParentId: boxSet.Id } });
  assert.equal(children.length, 1);
  assert.equal(children[0].Type, 'MediaBrowser.Controller.Entities.Book');
  assert.equal(children[0].Name, 'One');
  runtime.itemCreation.unregisterItem(boxSet.Id);
  const cold = await runtime.itemCreation.getItemById(boxSet.Id);
  assert.equal(cold.ProviderIds.Tmdb, '007');
  assert.equal(cold.DisplayOrder, 'PremiereDate');
});

test('Production folder validation creates BoxSet children and preserves logical Playlists', async t => {
  const media = 'Z:\\SpecialStructuralScan';
  const { fixture, runtime } = await runtimeFixture(t, [{ Name: media, Value: 'books' }]);
  fixture.identityMap.addPrefix({ identityRoot: media, accessRoot: '/fixture/special-scan', style: 'windows',
    returnAccess: 'Controlled production Folder validation.' });
  await fixture.adapter.mkdir('/special-scan');
  await fixture.adapter.mkdir('/special-scan/Favorites [playlist]');
  await fixture.adapter.write('/special-scan/Favorites [playlist]/must-not-be-discovered.epub', Buffer.from('neutral book'));
  await fixture.adapter.mkdir('/special-scan/Saga [boxset] [tmdb=007]');
  await fixture.adapter.write('/special-scan/Saga [boxset] [tmdb=007]/One.epub', Buffer.from('neutral book'));
  await fixture.seed({ target: 'root', items: [
    { key: 'root', type: 'Folder', Id: parentId, Path: media, TopParentId: parentId }
  ] });
  await runtime.itemCreation.withItem(parentId, async parent => {
    const result = await runtime.library.validateChildren(parent, { recursive: true, refreshChildMetadata: false });
    assert.equal(result.created.length, 2, 'Folder validation creates the direct BoxSet and Playlist.');
  });
  const direct = await fixture.database.rows('BaseItems', { where: { ParentId: parentId } });
  assert.equal(direct.length, 2);
  const playlist = direct.find(row => row.Type === playlistNativeType), boxSet = direct.find(row => row.Type === boxSetNativeType);
  assert.ok(playlist); assert.ok(boxSet);
  assert.equal(JSON.parse(playlist.Data).OpenAccess, true);
  assert.deepEqual(await fixture.database.rows('BaseItems', { where: { ParentId: playlist.Id } }), []);
  const children = await fixture.database.rows('BaseItems', { where: { ParentId: boxSet.Id } });
  assert.equal(children.length, 1);
  assert.equal(children[0].Type, 'MediaBrowser.Controller.Entities.Book');
  assert.deepEqual(await fixture.database.rows('BaseItemProviders', { where: { ItemId: boxSet.Id } }),
    [{ ItemId: boxSet.Id, ProviderId: 'Tmdb', ProviderValue: '007' }]);
  assert.equal(runtime.libraryScanner.capabilities.completeLibraryScan, true);
});
