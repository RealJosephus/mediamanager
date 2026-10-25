import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { mapRecord } from '../../src/library/records.js';
import { itemRequiresJson } from '../../src/library/item-data.js';
import { persistMetadata } from '../../src/metadata/persistence.js';
const root = new URL('./fixtures/item-data-policy/', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json'].map(async name => JSON.parse(await readFile(new URL(name, root), 'utf8'))));
const hash = value => createHash('sha256').update(value).digest('hex');
const compare = (actual, expected) => assert.deepEqual(actual, expected);
const blank = Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => !column.generated).map(column => [column.name,
  column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));
test('native item JSON policy seals actual class attributes, mapper hydration and EF saves', async () => {
  for (const file of Object.values(provenance.files)) assert.equal(hash(await readFile(new URL('../../' + file.path, import.meta.url))), file.sha256, file.path);
  assert.equal(native.inputSha256, provenance.files.input.sha256); assert.equal(native.sourceFilesSha256, provenance.sourceFilesSha256);
  assert.equal(native.actualFrozenItemDataPolicy, true); assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
  assert.equal(input.length, 66); assert.equal(native.results.length, 66);
  assert.deepEqual(native.results.map(value => value.name), input.map(value => value.name));
  assert.ok(native.results.every(value => value.exception == null));
  assert.equal(new Set(input.map(value => value.item.type)).size, 27);
});
test('JSON policy comparison rejects reading payloads on source-serialized classes or preserving their Data', () => {
  const expected = native.results.find(value => value.name === 'type-Book-poison');
  for (const changes of [{ trailers: ['https://invalid.example/poison'] }, { storedDataIsNull: false }, { requiresJson: true }]) {
    assert.throws(() => compare({ ...expected, ...changes }, expected), assert.AssertionError);
  }
});
for (const sample of input) test(`native item Data hydration ${sample.name}`, () => {
  const expected = native.results.find(value => value.name === sample.name);
  const row = { ...blank, Id: sample.item.id, Type: expected.nativeType, Name: sample.item.type, Data: sample.hydrationData };
  const item = mapRecord(row);
  compare({ requiresJson: itemRequiresJson(item), trailers: item.RemoteTrailers.map(trailer => trailer.Url) },
    { requiresJson: expected.requiresJson, trailers: expected.trailers });
  assert.equal(item.NativeData, sample.hydrationData, 'repository filters retain the unparsed SQL text');
  assert.equal(item.Name, sample.item.type);
});
for (const dialect of ['postgres']) for (const sample of input) test(`${dialect}: native item Data save ${sample.name}`,
  { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const schema = 'item_data_' + randomUUID().replaceAll('-', '').slice(0, 16);
    const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
    const store = new DomainStore(database);
    t.after(async () => {
      await database.client.query(`DROP SCHEMA "${schema}" CASCADE`); await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
      await store.close();
    });
    const expected = native.results.find(value => value.name === sample.name);
    const snapshot = { ...blank, Id: sample.item.id, Type: expected.nativeType, Name: sample.item.type,
      Data: sample.hydrationData ?? '{"RemoteTrailers":[{"Url":"https://invalid.example/initial"}]}' };
    await database.insert('BaseItems', snapshot);
    const item = mapRecord(snapshot);
    item.ProviderIds = {}; item.LockedFields = [];
    const loaded = { item, snapshot: (await database.rows('BaseItems', { where: { Id: item.Id } }))[0],
      relationships: {}, parents: [], collectionFolders: [], sortName: () => sample.item.type,
      capturePathScope: () => ({ reversePath: value => value }) };
    await persistMetadata(store, loaded, { Item: item });
    const stored = (await database.rows('BaseItems', { where: { Id: item.Id } }))[0];
    compare({ requiresJson: itemRequiresJson(item), storedDataIsNull: stored.Data === null },
      { requiresJson: expected.requiresJson, storedDataIsNull: expected.storedDataIsNull });
    const current = mapRecord(stored);
    assert.equal(current.Name, sample.item.type);
    if (!expected.requiresJson) assert.deepEqual(current.RemoteTrailers, []);
  });
