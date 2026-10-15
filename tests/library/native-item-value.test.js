import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneNativeItemValue } from '../../src/library/native-item-value.js';
import { newNativeItemEntity, applyNativeItemValues, cloneNativeItemEntity,
  captureNativeItemState, restoreNativeItemState } from '../../src/library/native-item-entity.js';
import { loadLibrary } from '../../src/library/records.js';
import { trySetProviderId } from '../../src/metadata/provider-ids.js';
import { mergeMetadata } from '../../src/metadata/merge.js';
import { createPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';

const own = (object, key, value) => Object.defineProperty(object, key, {
  value, enumerable: true, configurable: true, writable: true
});

test('native DTO clone preserves own __proto__ through nested proxies, arrays and cycles', () => {
  const dictionary = own({ regular: 'kept' }, '__proto__', { nested: ['value'] });
  const input = new Proxy(own({ dictionary: new Proxy(dictionary, {}) }, '__proto__', 'root'), {});
  input.items = [dictionary]; input.self = input;
  const copied = cloneNativeItemValue(input);
  assert.equal(Object.getPrototypeOf(copied), Object.prototype);
  assert.equal(Object.getPrototypeOf(copied.dictionary), Object.prototype);
  assert.equal(Object.hasOwn(copied, '__proto__'), true);
  assert.equal(copied.__proto__, 'root');
  assert.deepEqual(copied.dictionary.__proto__, { nested: ['value'] });
  assert.equal(copied.self, copied);
  assert.equal(copied.items.length, 1);
  assert.notEqual(copied.dictionary.__proto__, dictionary.__proto__);
  copied.dictionary.__proto__.nested.push('clone');
  assert.deepEqual(dictionary.__proto__.nested, ['value']);
});

test('native entity value, clone and binary snapshot preserve special own dictionary and DTO keys', async () => {
  const source = newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.Movie');
  applyNativeItemValues(source, own({ ProviderIds: own({}, '__proto__', 'provider'),
    Data: own({}, '__proto__', { nested: true }) }, '__proto__', { unknown: 'retained' }));
  const clone = cloneNativeItemEntity(source);
  const restored = await restoreNativeItemState(await captureNativeItemState(source));
  for (const item of [source, clone, restored]) {
    assert.equal(Object.getPrototypeOf(item), Object.prototype);
    assert.equal(Object.hasOwn(item, '__proto__'), true);
    assert.deepEqual(item.__proto__, { unknown: 'retained' });
    assert.equal(Object.hasOwn(item.ProviderIds, '__proto__'), true);
    assert.equal(item.ProviderIds.__proto__, 'provider');
    assert.equal(Object.getPrototypeOf(item.ProviderIds), Object.prototype);
    assert.deepEqual(item.Data.__proto__, { nested: true });
  }
});

test('provider setter and metadata merge retain literal own provider keys', async () => {
  const source = newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.Movie');
  const target = newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.Movie');
  assert.equal(trySetProviderId(source, '__proto__', 'valid-unknown-provider'), true);
  assert.equal(Object.hasOwn(source.ProviderIds, '__proto__'), true);
  await mergeMetadata({ Item: source }, { Item: target });
  assert.equal(Object.hasOwn(target.ProviderIds, '__proto__'), true);
  assert.equal(target.ProviderIds.__proto__, 'valid-unknown-provider');
  assert.equal(Object.getPrototypeOf(target.ProviderIds), Object.prototype);
});

test('postgres: cold provider hydration preserves the literal __proto__ provider key',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const database = await createPostgresTestDatabase(t, 'provider_own', { maxPoolSize: 1 });
    const id = '95500000000000000000000000000099';
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: id,
      Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Data: '{}' }));
    await database.insert('BaseItemProviders', { ItemId: id, ProviderId: '__proto__', ProviderValue: 'native-provider' });
    const state = await loadLibrary(database, {}, { baseRows: await database.rows('BaseItems') });
    try {
      const item = state.items[0];
      assert.equal(Object.hasOwn(item.ProviderIds, '__proto__'), true);
      assert.equal(item.ProviderIds.__proto__, 'native-provider');
      assert.equal(Object.getPrototypeOf(item.ProviderIds), Object.prototype);
      assert.equal(cloneNativeItemEntity(item).ProviderIds.__proto__, 'native-provider');
    } finally { await state.dispose(); }
  });
