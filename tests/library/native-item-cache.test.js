import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedItemCache } from '../../src/library/bounded-item-cache.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';
import { readWarmFixture, assertWarmFixtureSeal } from './warm-fixture-seal.js';
import { assertProjectedEqual } from '../comparison-observations.js';
const resident = ({ hot, warm, cold, ...value }) => value;
const fixture = await readWarmFixture(new URL('./fixtures/native-item-cache/', import.meta.url));
const { input, native } = fixture;
const key = number => '99e00000-0000-0000-0000-' + String(number).padStart(12, '0');
const nonCacheTypes = new Set(['Audio', 'AudioBook', 'Book', 'Photo', 'LiveTvProgram', 'Person', 'Genre', 'MusicGenre', 'Studio', 'Year']);
test('native item cache seals actual LibraryManager and independent queue observations', async () => {
  await assertWarmFixtureSeal(fixture, { flag: 'actualNativeLibraryManagerCache', count: 40 });
  assert.equal(native.defaultCacheSize, native.processorCount * 100);
  assert.deepEqual(native.results.map(row => row.name), input.cases.map(row => row.name));
  assert.equal(native.results.reduce((sum, row) => sum + row.observations.length, 0), 2428);
});
for (const sample of input.cases) test('native bounded item cache: ' + sample.name, t => {
  const expected = native.results.find(row => row.name === sample.name);
  if (expected.constructorException) {
    assert.throws(() => new BoundedItemCache(sample.capacity), { nativeException: expected.constructorException }); return;
  }
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
    assertProjectedEqual(t, 'Native operation ' + index, { action: operation.action, id, returned, exception: null, reads: [...reads],
      entries: [...cache].map(([id, item]) => ({ id, name: item.name })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      count: cache.size, capacity: cache.capacity, ...cache.queueCounts }, expected.observations[index], resident);
    assert.ok(cache.size <= cache.capacity);
    assert.ok(Object.values(cache.queueCounts).reduce((sum, value) => sum + value, 0) <= cache.capacity + 1);
  }
});
test('bounded item cache capacity cannot be mutated after queue partitioning', () => {
  const cache = new BoundedItemCache(3);
  assert.throws(() => { cache.capacity = 100; }, TypeError); assert.equal(cache.capacity, 3);
});
test('postgres: actual live-item registration agrees with the sealed native constructor cases', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const value = await setupChildrenFixture(t);
  // This immutable capture predates retained Channel support. Its case set is
  // authoritative for this comparison; current DLL Channel evidence lives in
  // live-tv-recordings.test.js rather than being attributed to this old seal.
  const capturedTypes = input.cases.filter(sample => sample.name.startsWith('registration-')).map(sample => sample.name.slice('registration-'.length));
  assert.ok(capturedTypes.length > 0);
  await value.seed({ target: capturedTypes[0], items: capturedTypes.map((type, index) => ({ key: type, type: type.split('.').at(-1), Id: key(index + 1) })) });
  for (const [index, type] of capturedTypes.entries()) await value.database.update('BaseItems', { Id: key(index + 1) }, { Type: type });
  const creator = new ItemCreationService(value);
  value.library.itemCreation = creator;
  for (const [index, type] of capturedTypes.entries()) {
    const id = key(index + 1), item = await creator.getItemById(id); assert.ok(item, type);
    await value.database.delete('BaseItems', { Id: id });
    const expected = native.results.find(result => result.name === 'registration-' + type).observations[0].count > 0;
    const retained = await creator.getItemById(id);
    assert.equal(retained !== null, expected, type);
    if (expected) assert.equal(retained, item, 'A retained native-cache entity keeps its identity.');
  }
});
