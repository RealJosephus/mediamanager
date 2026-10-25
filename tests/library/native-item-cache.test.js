import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedItemCache } from '../../src/library/bounded-item-cache.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';
import { currentWarmFixture } from './warm-fixture.js';
import { assertProjectedEqual, observeComparison } from '../comparison-observations.js';

const { input, current } = await currentWarmFixture(new URL('./fixtures/native-item-cache/', import.meta.url), 'native-item-cache');
const key = number => '99e00000-0000-0000-0000-' + String(number).padStart(12, '0');
const nonCacheTypes = new Set(['Audio', 'AudioBook', 'Book', 'Photo', 'LiveTvProgram', 'Person', 'Genre', 'MusicGenre', 'Studio', 'Year']);
export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const enabled = { skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 240000 };

test('current Native item cache consumes every neutral registration and lookup operation', enabled, async t => {
  const native = await current();
  assert.equal(native.actualNativeLibraryManagerCache, true);
  observeComparison(t, 'Native default cache capacity', native.defaultCacheSize, native.processorCount * 100);
  assert.equal(input.cases.length, 40);
  assert.deepEqual(native.results.map(row => row.name), input.cases.map(row => row.name));
  assert.equal(native.results.reduce((sum, row) => sum + row.observations.length, 0), 2428);
  for (const sample of input.cases) {
    const observed = native.results.find(row => row.name === sample.name);
    assert.equal(observed.observations.length, sample.operations.length, sample.name);
    assert.equal(observed.resources.length, sample.operations.length, sample.name);
  }
});

for (const sample of input.cases) test('current Native item cache lookup: ' + sample.name, enabled, async t => {
  const expected = (await current()).results.find(row => row.name === sample.name);
  if (sample.capacity < 3) {
    assert.ok(expected.constructorException, 'Native rejects the invalid capacity.');
    assert.throws(() => new BoundedItemCache(sample.capacity), error => {
      observeComparison(t, 'Constructor rejection class', error?.name, expected.constructorException);
      return true;
    });
    return;
  }
  assert.equal(expected.constructorException, null);
  const cache = new BoundedItemCache(sample.capacity), items = new Map(), reads = [];
  const register = item => { if (!nonCacheTypes.has(item.type.split('.').at(-1))) cache.set(item.id, item); };
  for (const [index, operation] of sample.operations.entries()) {
    const id = key(operation.id ?? 0); let returned = null;
    if (operation.action === 'register' || operation.action === 'seed') {
      const item = { id, name: operation.name, type: operation.type }; items.set(id, item);
      if (operation.action === 'register') register(item);
    } else if (operation.action === 'get') {
      let item = cache.get(id);
      if (!item) { reads.push(id); item = items.get(id); if (item) register(item); }
      returned = item?.name ?? null;
    } else if (operation.action === 'drop-row') items.delete(id);
    else if (operation.action === 'remove') cache.delete(id);
    else if (operation.action === 'clear') cache.clear();
    else throw new Error(operation.action);
    assertProjectedEqual(t, 'Native operation ' + index,
      { action: operation.action, id, returned, exception: null, reads: [...reads] }, expected.observations[index]);
    assert.ok(cache.size <= cache.capacity);
  }
});

const compareReleased = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
for (const sample of input.cases.filter(sample => sample.capacity >= 3)) test('current Native cache resource release: ' + sample.name, enabled, async t => {
  const expected = (await current()).results.find(row => row.name === sample.name).resources;
  const released = [], rows = new Map();
  const cache = new BoundedItemCache(sample.capacity, { onRemove: item => released.push({ id: item.id, name: item.name }) });
  for (const [index, operation] of sample.operations.entries()) {
    const id = key(operation.id ?? 0); let returned = null;
    if (operation.action === 'register' || operation.action === 'seed') {
      rows.set(id, operation.name);
      if (operation.action === 'register') cache.set(id, { id, name: operation.name });
    } else if (operation.action === 'get') {
      let resource = cache.get(id);
      if (!resource && rows.has(id)) { resource = { id, name: rows.get(id) }; cache.set(id, resource); }
      returned = resource?.name ?? null;
    } else if (operation.action === 'drop-row') rows.delete(id);
    else if (operation.action === 'remove') cache.delete(id);
    else if (operation.action === 'clear') cache.clear();
    else throw new Error(operation.action);
    assertProjectedEqual(t, 'Native resource operation ' + index,
      { action: operation.action, id, returned, released: [...released].sort(compareReleased) }, expected[index]);
    assert.ok(cache.size <= cache.capacity);
  }
});

test('postgres: live-item registration retains the same missing-row lookups as current Native', {
  ...enabled, skip: enabled.skip || !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const native = await current();
  const value = await setupChildrenFixture(t);
  const registrations = input.cases.filter(sample => sample.name.startsWith('registration-'));
  const capturedTypes = registrations.map(sample => sample.name.slice('registration-'.length));
  assert.ok(capturedTypes.length > 0);
  await value.seed({ target: capturedTypes[0], items: capturedTypes.map((type, index) => ({ key: type,
    type: type.split('.').at(-1), Id: key(index + 1), Name: registrations[index].operations[0].name })) });
  for (const [index, type] of capturedTypes.entries()) await value.database.update('BaseItems', { Id: key(index + 1) }, { Type: type });
  const creator = new ItemCreationService(value);
  value.library.itemCreation = creator;
  for (const [index, type] of capturedTypes.entries()) {
    const id = key(index + 1), item = await creator.getItemById(id); assert.ok(item, type);
    await value.database.delete('BaseItems', { Id: id });
    const expected = native.results.find(result => result.name === 'registration-' + type).observations[3].returned;
    const retained = await creator.getItemById(id);
    assert.equal(retained?.Name ?? null, expected, type);
    if (retained) {
      assert.equal(retained.Id, item.Id);
      assert.equal(retained.NativeType, type);
    }
  }
});
