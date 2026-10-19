import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionFoldersForItem } from '../../src/library/collection-membership.js';
import { buildScanCollectionContext, scanCollectionContextForItem } from '../../src/library/scan-context.js';

const root = Object.freeze({ Id: '10000000-0000-0000-0000-000000000001', Type: 'Folder', IsFolder: true, Path: '/media/library' });
const ids = ['20000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001'];
const collection = (Id, CollectionType, fields = {}) => ({ Id, Type: 'CollectionFolder', IsFolder: true, CollectionType,
  Path: '/views/' + Id, PhysicalLocationsList: [root.Path], ...fields });

test('collection provenance uses literal native discovery rather than inferred mappings', () => {
  const folders = [collection(ids[0], 'movies', { PhysicalLocationsList: [], PhysicalFolderIds: [root.Id] }),
    collection(ids[1], 'movies', { PhysicalLocationsList: [root.Path] })];
  const context = buildScanCollectionContext({ root, collectionFolders: collectionFoldersForItem(root, { byId: new Map([[root.Id, root]]) }, folders) });
  assert.deepEqual(context.collectionFolderIds, [ids[1]]);
  assert.deepEqual(context.collections[0].physicalLocations, [root.Path]);
});
test('native user-root order selects the first typed collection and first CollectionFolder options independently', () => {
  const folders = [collection(ids[0], null), collection(ids[1], 'music')];
  const context = buildScanCollectionContext({ root, collectionFolders: folders,
    libraryOptions: new Map([[ids[0], { Marker: 'first' }], [ids[1], { Marker: 'second' }]]) });
  assert.deepEqual(context.collectionFolderIds, ids);
  assert.equal(context.collectionType, 'music');
  assert.equal(context.primaryCollectionFolderId, ids[0]);
  assert.equal(context.libraryOptions.Marker, 'first');
});
test('different mapped types follow cached child order', () => {
  const folders = [collection(ids[0], 'movies'), collection(ids[1], 'music')];
  assert.equal(buildScanCollectionContext({ root, collectionFolders: folders }).collectionType, 'movies');
  assert.equal(buildScanCollectionContext({ root, collectionFolders: [...folders].reverse() }).collectionType, 'music');
});
test('ContentTypes selects the first matching entry before parsing its value', () => {
  const folders = [collection(ids[0], 'music')], configuration = { ContentTypes: [
    { Name: root.Path, Value: 'invalid' }, { Name: root.Path, Value: 'movies' }] };
  const context = buildScanCollectionContext({ root, collectionFolders: folders, configuration });
  assert.equal(context.collectionType, 'music');
  assert.equal(context.contentTypeOverrides.length, 2);
});
test('exact child overrides precede inherited paths and parent collection types', () => {
  const base = buildScanCollectionContext({ root, collectionFolders: [collection(ids[0], 'music')], configuration: { ContentTypes: [
    { Name: root.Path + '/special', Value: 'homevideos' }, { Name: root.Path + '/special/exact', Value: 'movies' }] } });
  const contextFor = Path => scanCollectionContextForItem(base, { Type: 'Folder', IsFolder: true, Path }, [root]);
  assert.equal(contextFor(root.Path + '/special/nested').collectionType, 'homevideos');
  assert.equal(contextFor(root.Path + '/special/exact').collectionType, 'movies');
  assert.equal(contextFor(root.Path + '/ordinary').collectionType, 'music');
});
test('context provenance and options are deeply immutable without mutating their source', () => {
  const options = { Enabled: true, Nested: { order: ['first', 'second'] } };
  const source = collection(ids[0], 'homevideos'), context = buildScanCollectionContext({ root, collectionFolders: [source],
    libraryOptions: new Map([[ids[0], options]]), configuration: { ContentTypes: [{ Name: root.Path + '/special', Value: 'movies' }] } });
  for (const value of [context, context.rootItem, context.topFolders, context.topFolders[0], context.collections, context.collections[0],
    context.collections[0].physicalFolderIds, context.collectionFolderIds, context.libraryOptions, context.libraryOptions.Nested,
    context.libraryOptions.Nested.order, context.contentTypeOverrides, context.contentTypeOverrides[0]]) assert.equal(Object.isFrozen(value), true);
  assert.throws(() => { context.libraryOptions.Nested.order.push('third'); }, TypeError);
  assert.throws(() => { context.collections[0].physicalLocations.push('/other'); }, TypeError);
  assert.equal(Object.isFrozen(options), false); assert.equal(Object.isFrozen(source), false);
});
test('attempt signature preserves meaningful collection and list order while ignoring object key insertion order', () => {
  const folders = [collection(ids[0], 'homevideos'), collection(ids[1], 'movies')];
  const first = buildScanCollectionContext({ root, collectionFolders: folders,
    libraryOptions: new Map([[ids[0], { Enabled: true, Marker: { A: 1, B: 2 } }]]) });
  const same = buildScanCollectionContext({ root, collectionFolders: folders,
    libraryOptions: new Map([[ids[0], { Marker: { B: 2, A: 1 }, Enabled: true }]]) });
  const reordered = buildScanCollectionContext({ root, collectionFolders: [...folders].reverse() });
  const changed = buildScanCollectionContext({ root, collectionFolders: folders,
    libraryOptions: new Map([[ids[0], { Enabled: false, Marker: { A: 1, B: 2 } }]]) });
  assert.equal(first.signature, same.signature);
  assert.notEqual(first.signature, reordered.signature);
  assert.notEqual(first.signature, changed.signature);
});
