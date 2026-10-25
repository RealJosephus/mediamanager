import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setupPlaylistDeletion, playlistDeletionId as id } from './playlist-deletion-fixture.js';
import { discoveryFixture } from './video-discovery-fixture.js';
import { cloneNativeItemEntity, newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { idKey } from '../../src/library/records.js';
import { tableDefinition } from '../../src/database/model.js';
import { updateLiveItemRepository } from '../../src/library/live-item-repository.js';
import { persistMetadata } from '../../src/metadata/persistence.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { currentWarmFixture } from './warm-fixture.js';
const { input, current } = await currentWarmFixture(new URL('./fixtures/warm-item-deletion/', import.meta.url), 'warm-item-deletion');
export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const enabled = { skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 240000 };
const postgres = { ...enabled, skip: enabled.skip || !process.env.MEDIAMANAGER_TEST_POSTGRES };

test('current Native warm deletion records all hydrated and created entity lifecycles', enabled, async () => {
  const native = await current();
  assert.equal(native.actualWarmItemDeletion, true);
  assert.equal(input.length, 24);
  assert.deepEqual(native.results.map(row => row.name), input.map(row => row.name));
  assert.equal(input.filter(row => row.created).length, 8);
  for (const row of native.results) {
    assert.equal(row.exception, null); assert.equal(row.secondException, null); assert.equal(row.closureLookup, false);
    assert.ok(row.initialRows.every(item => Object.keys(item).length === 72));
    assert.ok(row.rows.every(item => Object.keys(item).length === 72));
    assert.equal(row.firstRows.some(item => item.Id === id(4)), false);
  }
});
for (const sample of input) test('postgres: warm item deletion matches current Native ' + sample.name, postgres, async t => {
  const native = await current();
  const expected = native.results.find(result => result.name === sample.name);
  const value = await setupPlaylistDeletion(t, sample, expected);
  if (sample.created) {
    // The clone contains only recorded initial entity values. Real creation
    // must retain this distinct live draft and publish its frame after COMMIT.
    const draft = cloneNativeItemEntity(await value.creator.getItemById(id(4)));
    value.creator.unregisterItem(draft.Id);
    await value.creator.createItems([draft], await value.creator.getItemById(id(2)));
    const initial = await value.project(null);
    assert.deepEqual(initial.rows, value.normalizeRows(expected.initialRows));
    assert.deepEqual(initial.files, expected.initialFiles); assert.deepEqual(initial.links, expected.initialLinks);
  }
  await value.operation();
  const first = await value.project(null);
  assert.deepEqual(first.rows, value.normalizeRows(expected.firstRows));
  assert.deepEqual(first.links, expected.firstLinks);
  assert.deepEqual(first.files, expected.firstFiles); assert.deepEqual(first.calls, expected.firstCalls);
  const item = await value.creator.getItemById(id(4));
  assert.equal(item !== null, expected.lookupAfterFirst);
  value.calls.length = 0; value.events.length = 0;
  if (item) await value.fixture.library.deleteItem(item, { DeleteFileLocation: sample.secondSource });
  const final = await value.project(null);
  assert.deepEqual(final.rows, value.normalizeRows(expected.rows));
  assert.deepEqual(final.links, expected.links); assert.deepEqual(final.files, expected.files);
  assert.deepEqual(final.calls, expected.calls); assert.equal(final.closureLookup, expected.closureLookup);
  assert.equal(final.targetParentId, expected.targetParentId); assert.equal(final.targetLookup, expected.targetLookup);
});
async function setupWarm(t) {
  const native = await current();
  const sample = input.find(sample => sample.name === 'video-warm-source');
  const expected = native.results.find(row => row.name === sample.name);
  const value = await setupPlaylistDeletion(t, sample, expected);
  const row = (await value.fixture.database.rows('BaseItems', { where: { Id: id(4) } }))[0];
  await value.operation();
  const item = await value.creator.getItemById(id(4)); assert.ok(item);
  return { ...value, item, row };
}

for (const suffix of ['db', 'source']) test('postgres: warm Folder deletion ignores a drifted stored folder flag ' + suffix, postgres, async t => {
  const native = await current();
  const sample = input.find(row => row.name === 'folder-warm-' + suffix);
  const expected = native.results.find(row => row.name === sample.name);
  const value = await setupPlaylistDeletion(t, sample, expected);
  const cached = await value.creator.getItemById(id(4));
  assert.equal(cached.IsFolder, true);
  assert.equal(await value.fixture.database.update('BaseItems', { Id: id(4) }, { IsFolder: false }), 1n);
  assert.equal((await value.fixture.database.rows('BaseItems', { where: { Id: id(4) } }))[0].IsFolder, false);
  await value.operation();
  const retained = await value.creator.getItemById(id(4));
  assert.ok(retained); assert.equal(retained.IsFolder, true); assert.equal(retained.Path, cached.Path);
  const first = await value.project(null);
  assert.deepEqual(first.rows, value.normalizeRows(expected.firstRows));
  assert.deepEqual(first.files, expected.firstFiles); assert.deepEqual(first.calls, expected.firstCalls);
  value.calls.length = 0; value.events.length = 0;
  await value.fixture.library.deleteItem(retained, { DeleteFileLocation: suffix === 'source' });
  const final = await value.project(null);
  assert.deepEqual(final.rows, value.normalizeRows(expected.rows));
  assert.deepEqual(final.links, expected.links); assert.deepEqual(final.files, expected.files);
  assert.deepEqual(final.calls, expected.calls);
});
for (const scenario of ['unregistered-clone', 'registered-clone', 'changed-source-path', 'missing-save']) {
  test('postgres: missing-row warm lifecycle rejects ' + scenario, postgres, async t => {
    const value = await setupWarm(t), before = await value.project(null);
    let item = value.item;
    if (scenario.endsWith('clone')) item = cloneNativeItemEntity(item);
    if (scenario === 'registered-clone') value.creator.registerItem(item);
    if (scenario === 'changed-source-path') item.Path = item.Path.replace('closure.mkv', 'sibling.keep');
    const operation = scenario === 'missing-save'
      ? () => updateLiveItemRepository(item, { loadContext: value.fixture.loadContext, itemCreation: value.creator,
        updates: { update: () => assert.fail('Missing-row save must not reach a saver/provider.') } })
      : () => value.fixture.library.deleteItem(item, { DeleteFileLocation: true });
    await assert.rejects(operation, { code: 'metadata-conflict', status: 409 });
    assert.deepEqual(await value.project(null), before);
  });
}
test('postgres: warm deletion detects a reinserted row before file/provider side effects', postgres, async t => {
  const value = await setupWarm(t), before = await value.project(null);
  const load = value.fixture.loadContext; let inserted = false;
  value.fixture.library.itemDeletion.loadContext = async (...args) => {
    const loaded = await load(...args);
    if (args[0] === value.item.Id && !inserted) {
      assert.equal(loaded.snapshot, undefined);
      await value.fixture.database.insert('BaseItems', { ...value.row, OwnerId: null }); inserted = true;
    }
    return loaded;
  };
  await assert.rejects(() => value.fixture.library.deleteItem(value.item, { DeleteFileLocation: true }), { code: 'metadata-conflict', status: 409 });
  assert.equal(inserted, true);
  const after = await value.project(null);
  assert.deepEqual(after.files, before.files); assert.deepEqual(after.calls, before.calls);
  assert.equal(after.rows.filter(row => row.Id === id(4)).length, 1);
});
test('postgres: bounded accessed-item pressure leaves a deleted row absent after cache eviction', postgres, async t => {
  const value = await setupWarm(t);
  for (let index = 100; index < 4000; index += 1) {
    const item = newNativeItemEntity('MediaBrowser.Controller.Entities.Video'); item.Id = id(index); item.Name = 'cache-pressure-' + index;
    value.creator.registerItem(item);
    const accessed = await value.creator.getItemById(item.Id);
    assert.ok(accessed); assert.equal(idKey(accessed.Id), idKey(item.Id)); assert.equal(accessed.Name, item.Name);
  }
  assert.equal(await value.creator.getItemById(id(4)), null);
  const after = await value.project(null);
  assert.equal(after.rows.some(row => row.Id === id(4)), false); assert.equal(after.closureLookup, false);
});

for (const scenario of ['committed', 'rolled-back']) test('postgres: live repository frames advance only after a ' + scenario + ' batch save', postgres, async t => {
  const native = await current();
  const sample = input.find(sample => sample.name === 'video-warm-source');
  const value = await setupPlaylistDeletion(t, sample, native.results.find(row => row.name === sample.name));
  const item = await value.creator.getItemById(id(4)), before = structuredClone(value.creator.retainedRepositorySnapshot(item));
  assert.ok(before); assert.equal(Object.keys(before).length, 72);
  const rows = await value.fixture.database.rows('BaseItems'); item.Name = 'saved-warm-frame';
  if (scenario === 'rolled-back') {
    await value.fixture.database.client.query("CREATE FUNCTION warm_frame_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.\"Id\" = '" + value.item.Id + "' THEN RAISE EXCEPTION 'Controlled second-item save failure'; END IF; RETURN NEW; END $$");
    await value.fixture.database.client.query('CREATE TRIGGER warm_frame_failure BEFORE UPDATE ON "BaseItems" FOR EACH ROW EXECUTE FUNCTION warm_frame_failure()');
    await assert.rejects(() => value.creator.saveItems([item, value.item]), /Controlled second-item save failure/u);
    assert.deepEqual(value.creator.retainedRepositorySnapshot(item), before);
    assert.deepEqual(await value.fixture.database.rows('BaseItems'), rows);
  } else {
    await value.creator.saveItems([item]);
    const saved = (await value.fixture.database.rows('BaseItems', { where: { Id: item.Id } }))[0];
    assert.equal(saved.Name, item.Name); assert.deepEqual(value.creator.retainedRepositorySnapshot(item), saved);
    await value.fixture.database.delete('BaseItems', { Id: item.Id });
    const retained = await value.creator.getItemById(item.Id);
    assert.ok(retained); assert.equal(idKey(retained.Id), idKey(saved.Id)); assert.equal(retained.Name, saved.Name);
    assert.deepEqual(value.creator.retainedRepositorySnapshot(retained), saved);
  }
});

test('postgres: bounded version-frame query publishes actual committed rows before warm row deletion', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const samples = JSON.parse(await readFile(new URL('./fixtures/video-version-discovery/input.json', import.meta.url)));
  const sample = samples.find(row => row.name === 'update-new-version-inherits-mixed');
  const { fixture, loaded } = await discoveryFixture(t, 'postgres', sample);
  const creator = new ItemCreationService(fixture); fixture.library.itemCreation = creator;
  await fixture.host.updates.updateRepository(loaded, { Item: loaded.item, Images: null }, ItemUpdateType.MetadataImport, {
    persist: (updated, result, options) => persistMetadata(fixture.store, loaded, result, options),
  });
  assert.equal(loaded.newVersionSnapshots.length, 1);
  const [frame] = loaded.newVersionSnapshots;
  const [persisted] = await fixture.database.rows('BaseItems', { where: { Id: frame.Id } });
  assert.deepEqual(frame, persisted); assert.equal(Object.keys(frame).length, 72);
  const cached = await creator.getItemById(frame.Id);
  assert.equal(idKey(cached.Id), idKey(frame.Id)); assert.deepEqual(creator.retainedRepositorySnapshot(cached), persisted);
  for (const link of await fixture.database.rows('LinkedChildren', { where: { ChildId: frame.Id } })) {
    await fixture.database.delete('LinkedChildren', Object.fromEntries(tableDefinition('LinkedChildren').primaryKey.map(key => [key, link[key]])));
  }
  await fixture.database.delete('BaseItems', { Id: frame.Id });
  const retained = await creator.getItemById(frame.Id);
  assert.ok(retained); assert.equal(idKey(retained.Id), idKey(persisted.Id)); assert.equal(retained.Name, persisted.Name);
  assert.deepEqual(creator.retainedRepositorySnapshot(retained), persisted);
});
