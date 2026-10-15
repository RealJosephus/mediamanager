import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { ResolvedItemLifecycleHost } from '../../src/library/resolved-item-lifecycle.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';

const itemId = 'A7400000-0000-0000-0000-000000000001';
const imageId = 'A7400000-0000-0000-0000-000000000002';
const expected = item => ({ Id: item.Id, Type: item.NativeType ?? item.Type, ParentId: item.ParentId,
  TopParentId: item.TopParentId, OwnerId: item.OwnerId, PrimaryVersionId: item.PrimaryVersionId,
  IsFolder: item.IsFolder, IsVirtualItem: item.IsVirtualItem, SourceType: item.SourceType,
  CanDelete: item.CanDelete, Path: item.Path,
  SeriesId: item.SeriesId, SeasonId: item.SeasonId, IndexNumber: item.IndexNumber,
  ParentIndexNumber: item.ParentIndexNumber });
const blank = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated)
  .map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? ''
    : ['long', 'uint'].includes(column.clrType) ? 0n : 0]));

test('changed resolved items use MetadataImport and the complete metadata update host', async () => {
  const calls = [];
  const item = { Id: itemId, Type: 'Movie', IsFileProtocol: false, IsInMixedFolder: false };
  const sourceImages = [{ Type: 'Primary', Path: 'Z:\\Movie\\poster.jpg', Width: 1, Height: 1, Blurhash: 'hash' }];
  const loaded = { dispose: async () => {}, item, context: { images: sourceImages }, libraryOptions: {}, exists: async () => false,
    getLocalAlternateVersionIds: async () => [] };
  const updates = {
    registry: null,
    async update(actualLoaded, result, reason, options) {
      calls.push({ actualLoaded, result, reason, options });
      return Object.freeze(['saved']);
    }
  };
  const host = new ResolvedItemLifecycleHost({ store: {}, loadContext: async () => loaded, updates,
    images: { async updateImages() { throw new Error('The independent image branch must not run.'); } } });
  const controller = new AbortController();
  const result = await host.apply(itemId, { resolved: { Type: 'Movie', IsInMixedFolder: true },
    expected: expected(item), signal: controller.signal });

  assert.deepEqual(result, { branch: 'save', changed: true, imagesChanged: null, saves: ['saved'] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].actualLoaded.item, loaded.item);
  assert.equal(calls[0].actualLoaded.snapshot, loaded.snapshot);
  assert.equal(calls[0].result.Item, item);
  assert.notEqual(calls[0].result.Images, sourceImages);
  assert.deepEqual(calls[0].result.Images, sourceImages);
  assert.equal(calls[0].reason, 2);
  assert.equal(calls[0].options.signal, controller.signal);
  assert.deepEqual(Object.keys(calls[0].options), ['signal']);
});

test('unchanged resolved items persist only independently refreshed image rows', async t => {
  const database = await createPostgresTestDatabase(t, 'resolved_item_lifecycle');
  const store = new DomainStore(database);
  t.after(() => store.close());
  const original = await database.insert('BaseItems', { ...blank('BaseItems'), Id: itemId,
    Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Name: 'Movie', Path: 'Z:\\Movie\\movie.mkv',
    IsFolder: false, Data: '{}', DateLastSaved: '2026-10-01 00:00:00' });
  await database.insert('BaseItemImageInfos', { ...blank('BaseItemImageInfos'), Id: imageId, ItemId: itemId,
    ImageType: 0, Path: 'Z:\\Movie\\poster.jpg', DateModified: '2026-10-01 00:00:00', Width: 0, Height: 0 });
  const loaded = { dispose: async () => {}, item: { Id: itemId, Type: 'Movie' }, context: { images: [{ Type: 'Primary',
    Path: 'Z:\\Movie\\poster.jpg', DateModified: '2026-10-01 00:00:00', Width: 0, Height: 0, Blurhash: null }] },
  relationships: {} };
  let metadataUpdates = 0, irreversible = 0;
  const host = new ResolvedItemLifecycleHost({ store, loadContext: async () => loaded,
    updates: { async update() { metadataUpdates++; } }, images: {
      async updateImages(actualLoaded, images, { persistImages, markIrreversible }) {
        assert.equal(actualLoaded.item, loaded.item);
        assert.equal(actualLoaded.snapshot, loaded.snapshot);
        Object.assign(images[0], { Width: 1920, Height: 1080, Blurhash: Buffer.from('native-hash') });
        markIrreversible();
        await persistImages(images);
        return true;
      }
    } });

  const result = await host.apply(itemId, { resolved: { Type: 'Movie', IsInMixedFolder: false },
    expected: expected(loaded.item), markIrreversible: () => { irreversible++; } });
  assert.deepEqual(result, { branch: 'images', changed: false, imagesChanged: true, saves: [] });
  assert.equal(metadataUpdates, 0);
  assert.equal(irreversible, 1);
  assert.deepEqual(await database.rows('BaseItems', { where: { Id: itemId } }), [original]);
  const [image] = await database.rows('BaseItemImageInfos', { where: { ItemId: itemId } });
  assert.equal(image.Width, 1920);
  assert.equal(image.Height, 1080);
  assert.equal(image.Blurhash.toString('utf8'), 'native-hash');
});

test('resolved-item lifecycle validates its branch before loading mutable context', async () => {
  let loads = 0;
  const host = new ResolvedItemLifecycleHost({ store: {}, loadContext: async () => { loads++; return {}; },
    updates: { async update() {} }, images: { async updateImages() {} } });
  await assert.rejects(host.apply(itemId), /item draft and structural snapshot/u);
  assert.equal(loads, 0);
});

test('unchanged items stay retryable until image work reaches a write boundary', async () => {
  const item = { Id: itemId, Type: 'Movie', SourceType: 'Library', CanDelete: true, IsInMixedFolder: false };
  let irreversible = 0;
  const host = new ResolvedItemLifecycleHost({ store: {}, loadContext: async () => ({ dispose: async () => {}, item, context: { images: [
    { Type: 'Primary', Path: 'Z:\\Movie\\poster.jpg', Width: 1920, Height: 1080,
      Blurhash: Buffer.from('current'), DateModified: '2026-10-01 00:00:00' }
  ] } }), updates: { async update() {} }, images: {
    async updateImages(_loaded, _images, { markIrreversible }) {
      assert.equal(typeof markIrreversible, 'function');
      return false;
    }
  } });

  assert.equal((await host.apply(itemId, { resolved: { Type: 'Movie', IsInMixedFolder: false },
    expected: expected(item), markIrreversible: () => { irreversible++; } })).changed, false);
  assert.equal(irreversible, 0);
});

for (const mutation of [
  item => { item.SourceType = 'Channel'; },
  item => { item.CanDelete = false; }
]) test('authoritative eligibility changes fail before lifecycle side effects', async () => {
  const enumerated = { Id: itemId, Type: 'Movie', SourceType: 'Library', CanDelete: true,
    IsFolder: false, IsVirtualItem: false, Path: 'Z:\\Movie\\movie.mkv' };
  const authoritative = structuredClone(enumerated);
  mutation(authoritative);
  let imageCalls = 0, updateCalls = 0;
  const host = new ResolvedItemLifecycleHost({ store: {},
    loadContext: async () => ({ dispose: async () => {}, item: authoritative, context: { images: [] } }),
    updates: { async update() { updateCalls++; } },
    images: { async updateImages() { imageCalls++; } } });

  await assert.rejects(host.apply(itemId, { resolved: { Type: 'Movie', IsInMixedFolder: false },
    expected: expected(enumerated) }), { code: 'version-changed' });
  assert.equal(imageCalls, 0);
  assert.equal(updateCalls, 0);
});

test('each remote conversion reuses and advances the outer conflict baseline', async () => {
  const item = { Id: itemId, Type: 'Movie', IsInMixedFolder: false };
  const loaded = { dispose: async () => {}, item, snapshot: { version: 1 }, relationships: {}, getLocalAlternateVersionIds: async () => [], context: { images: [
    { Type: 'Primary', Path: 'https://example.invalid/poster.jpg', Width: 0, Height: 0, Blurhash: null },
    { Type: 'Backdrop', Path: 'https://example.invalid/backdrop.jpg', Width: 0, Height: 0, Blurhash: null }
  ] } };
  const calls = [];
  let lifecycleLoaded;
  const updates = {
    registry: null,
    async update(actualLoaded, _result, reason, options) {
      lifecycleLoaded ??= actualLoaded;
      assert.equal(actualLoaded, lifecycleLoaded);
      calls.push({ reason, options, version: actualLoaded.snapshot.version });
      actualLoaded.snapshot = { version: actualLoaded.snapshot.version + 1 };
      actualLoaded.relationships = { BaseItemImageInfos: [{ Id: `${imageId}-${actualLoaded.snapshot.version}` }] };
      return [];
    }
  };
  const images = {
    async updateImages(actualLoaded, current) {
      current[0].Path = 'Z:\\Movie\\poster.jpg';
      await actualLoaded.onImageRemoteChange();
      assert.deepEqual(actualLoaded.snapshot, { version: 2 });
      current[1].Path = 'Z:\\Movie\\backdrop.jpg';
      await actualLoaded.onImageRemoteChange();
      assert.deepEqual(actualLoaded.snapshot, { version: 3 });
      assert.deepEqual(actualLoaded.relationships,
        { BaseItemImageInfos: [{ Id: `${imageId}-3` }] });
      return true;
    }
  };
  const host = new ResolvedItemLifecycleHost({ store: {}, loadContext: async () => loaded, updates, images });

  const result = await host.apply(itemId, { resolved: { Type: 'Movie', IsInMixedFolder: false },
    expected: expected(item) });

  assert.equal(result.branch, 'images');
  assert.deepEqual(calls.map(call => call.reason), [4, 4]);
  assert.deepEqual(calls.map(call => call.version), [1, 2]);
  assert.deepEqual(calls[0].options, {});
});
