import { nativeTextBytes, decodeNativeTextBytes } from '../../src/database/native-text.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseLosslessJson } from '../../src/core/json.js';
import { tableDefinition, quoteIdentifier as q } from '../../src/database/model.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { orderNativeItemBatch, scanNativeRelationRows } from '../../src/database/native-relation-order.js';
import { databaseDigest, transferDatabase } from '../../src/migration/database-transfer.js';
import { buildPostgresArtistBatchLookupQuery } from '../../src/library/postgres-artist-maintenance.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { nativeArtistIdentity } from '../../src/library/identity.js';
import { guid, idKey, MIN_DATE } from '../../src/library/records.js';
import { nativeGuid } from '../../src/users/native.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';
import { fixturePathStyle } from './fixture-state-path.js';

const fixture = new URL('./fixtures/artist-maintenance/', import.meta.url);
const [nativeBytes, inputBytes, provenanceBytes] = await Promise.all(['native.json', 'input.json', 'provenance.json'].map(name => readFile(new URL(name, fixture))));
const native = parseLosslessJson(nativeBytes.toString()), input = JSON.parse(inputBytes), provenance = JSON.parse(provenanceBytes);
const reverseFixture = new URL('reverse/', fixture);
const [reverseBytes, reverseInputBytes, reverseProvenanceBytes] = await Promise.all(['native.json', 'input.json', 'provenance.json'].map(name => readFile(new URL(name, reverseFixture))));
const reverse = parseLosslessJson(reverseBytes.toString()), reverseInput = JSON.parse(reverseInputBytes), reverseProvenance = JSON.parse(reverseProvenanceBytes);
const recordings = [...native.results, ...reverse.results];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const columns = tableDefinition('BaseItems').columns;
const placeholder = '00000000000000000000000000000001';
const id = number => `BA380000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const readOrder = async database => {
  const ids = []; let after;
  while (true) {
    const page = await scanNativeRelationRows(database, 'BaseItems', { after, limit: 2 });
    ids.push(...page.rows.map(row => guid(row.Id))); after = page.after;
    if (page.rows.length < 2) return ids;
  }
};
const selected = async (database, names) => {
  const query = buildPostgresArtistBatchLookupQuery(database, { text: `SELECT value AS "Name", ordinal AS "Ordinal"
    FROM unnest($1::bytea[]) WITH ORDINALITY requested(value, ordinal)`, values: [names.map(nativeTextBytes)] });
  return (await database.client.query(query)).rows.map(row => ({ name: decodeNativeTextBytes(row.__name, 'runtime'), id: row.Id ? guid(decodeNativeTextBytes(row.Id, 'runtime')) : null }));
};
const expectedSelection = recording => recording.names.map(name => {
  const candidates = recording.selections[name] ?? [];
  const winner = candidates.find(item => !item.IsAccessedByName) ?? candidates[0];
  return { name, id: winner?.Id ?? null };
});

test('native Artist observations bind raw insertion sequence to the actual batch lookup consumer', async () => {
  assert.equal(hash(nativeBytes), provenance.nativeSha256); assert.equal(hash(inputBytes), provenance.inputSha256);
  assert.equal(native.results.length, 36); assert.equal(input.length, 36); assert.equal(columns.length, 72);
  assert.equal(native.actualLibraryManager, true); assert.equal(native.actualRepository, true);
  assert.equal(native.actualSqlitePersistence, true); assert.equal(native.metadataProviderControlled, true);
  assert.equal(provenance.build.status, 0); assert.equal(provenance.process.status, 0);
  assert.deepEqual(native.sqliteRuntime, provenance.sqliteRuntime);
  for (const source of provenance.oracleSources) assert.equal(hash(await readFile(source.name === 'Directory.Build.props'
    ? new URL('../Directory.Build.props', import.meta.url) : new URL(source.name, fixture))), source.sha256);
  assert.equal(hash(reverseBytes), reverseProvenance.nativeSha256); assert.equal(hash(reverseInputBytes), reverseProvenance.inputSha256);
  assert.equal(reverse.results.length, 2); assert.equal(reverseInput.length, 2);
  for (const source of reverseProvenance.oracleSources) assert.equal(hash(await readFile(source.name === 'Directory.Build.props'
    ? new URL('../Directory.Build.props', import.meta.url) : new URL(source.name, reverseFixture))), source.sha256);
  for (const recording of native.results) assert.deepEqual(recording.before.insertionOrder.toSorted(), recording.before.rows.map(row => row.Id).toSorted());
  assert.equal(expectedSelection(native.results.find(row => row.sample.Name === 'physical-tie-separate'))[0].id, guid(id(150)));
  assert.equal(expectedSelection(native.results.find(row => row.sample.Name === 'named-tie-reverse'))[0].id, guid(id(102)));
});

for (const recording of recordings) test('postgres: native Artist insertion order and lookup survive exchange ' + recording.sample.Name, {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const target = await createPostgresTestDatabase(t, 'item_order');
  const source = new SqliteDatabase(':memory:', { create: true }), exported = new SqliteDatabase(':memory:', { create: true });
  t.after(() => { source.close(); exported.close(); });
  const inputs = new Map(recording.before.rows.map(row => [idKey(row.Id), row]));
  source.transaction(() => {
    source.database.exec('PRAGMA defer_foreign_keys = ON');
    for (const identity of recording.before.insertionOrder) {
      const row = inputs.get(idKey(identity));
      source.insert('BaseItems', Object.fromEntries(columns.map(column => [column.name,
        row[column.name] != null && column.clrType.includes('Guid') ? nativeGuid(row[column.name]) : row[column.name]])));
    }
  });
  await transferDatabase(source, target, { batchSize: 2,
    instanceBinding: { serverId: 'ba380000000000000000000000000001', originIdentityDigest: '8'.repeat(64) } });
  assert.deepEqual(await readOrder(target), recording.before.insertionOrder);
  assert.deepEqual(await selected(target, recording.names), expectedSelection(recording));
  const reopened = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema: target.schemaName });
  try { assert.deepEqual(await readOrder(reopened), recording.before.insertionOrder); }
  finally { await reopened.close(); }
  await transferDatabase(target, exported, { batchSize: 1 });
  assert.deepEqual(await readOrder(exported), recording.before.insertionOrder);
  assert.deepEqual(await databaseDigest(target, { batchSize: 3 }), await databaseDigest(exported, { batchSize: 2 }));
  const returned = await createPostgresTestDatabase(t, 'returned_items');
  await transferDatabase(exported, returned, { batchSize: 3 });
  assert.deepEqual(await selected(returned, recording.names), expectedSelection(recording));
});

function constructorItems(sample, stateRoot, options) {
  const sources = [], named = [];
  const create = (type, number, Name, fields = {}) => Object.assign(newNativeItemEntity('MediaBrowser.Controller.Entities.' + type),
    { Id: id(number), Name, ...fields });
  const addSource = (number, name, type = 'Movies.Movie') => sources.push(create(type, number, name + ' source'));
  for (const [index, name] of sample.Names.entries()) addSource(index + 1, name);
  if (sample.SourceKinds) for (const [number, name, type] of [[10, 'Audio', 'Audio.Audio'], [11, 'Book', 'AudioBook'],
    [12, 'MusicVideo', 'MusicVideo'], [13, 'Album', 'Audio.MusicAlbum'], [14, 'Artist', 'Audio.MusicArtist'],
    [15, 'Unmapped', 'Movies.Movie'], [16, 'Z lower', 'Movies.Movie'], [17, 'A upper', 'Movies.Movie'],
    [18, 'Tag', 'Movies.Movie'], [19, 'AlbumArtist', 'Movies.Movie']]) addSource(number, name, type);
  const addNamed = (number, name, locked = false) => {
    const item = create('Audio.MusicArtist', number, name, { Path: path.join(stateRoot, 'metadata/artists', 'Initial' + number),
      DateLastRefreshed: sample.NeverRefreshed ? MIN_DATE : '2026-10-01T00:00:00.0000000Z', IsLocked: locked, Overview: 'Curated ' + (name ?? '') });
    named.push(item); return item;
  };
  for (const [index, name] of sample.Existing.entries()) addNamed(100 + index, name);
  if (sample.InitialLookup != null) {
    const item = addNamed(106, sample.InitialName); item.Id = nativeArtistIdentity(sample.InitialLookup, options).Id;
    if (sample.InitialOwner || sample.InitialAlternate) sources.push(create('Folder', 901, 'Initial identity anchor'));
    if (sample.InitialOwner) item.OwnerId = id(901);
  }
  if (sample.Physical) {
    sources.push(create('Folder', 905, 'Physical parent', { Path: path.join(stateRoot, 'physical') }));
    Object.assign(addNamed(150, 'Rock'), { ParentId: id(905), Path: path.join(stateRoot, 'physical/Rock'), ForcedSortName: 'zz physical' });
    if (sample.PhysicalTwin) Object.assign(addNamed(149, 'Rock'), { ParentId: id(905), Path: path.join(stateRoot, 'physical/Rock Twin'), ForcedSortName: 'aa physical' });
  }
  if (sample.NullInitialName) addNamed(105, null);
  if (sample.Dead) { addNamed(200, 'DeadFirst'); addNamed(201, 'DeadSecond'); }
  if (sample.Locked) addNamed(203, 'DeadLocked', true);
  if (sample.DeadNullPath) named.find(item => item.Id === id(201)).Path = null;
  return { sources, named };
}

for (const recording of recordings) test('postgres: native SaveItems batch insertion layers ' + recording.sample.Name, {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const { database, store, library, stateRoot, loadContext, identityMap, linkedChildren } = await setupChildrenFixture(t);
  identityMap.addPrefix({ identityRoot: path.join(stateRoot, 'physical'), accessRoot: '/fixture/physical', style: fixturePathStyle, returnAccess: 'isolated order fixture' });
  library.options.configuration.EnableNormalizedItemByNameIds = true;
  const creator = new ItemCreationService({ store, library, loadContext, linkedChildren }); t.after(() => creator.close());
  library.itemCreation = creator;
  const { sources, named } = constructorItems(recording.sample, stateRoot, library.options);
  if (recording.sample.SeparateSeeds) {
    await creator.saveItems(sources);
    for (const item of recording.sample.ReverseSeeds ? named.toReversed() : named) await creator.saveItems([item]);
  } else await creator.saveItems(recording.sample.ReverseBatch ? [...sources, ...named].toReversed() : [...sources, ...named]);
  assert.deepEqual(await readOrder(database), recording.before.insertionOrder.filter(identity => idKey(identity) !== placeholder));
  assert.deepEqual(await selected(database, recording.names), expectedSelection(recording));
});

test('postgres: item insertion positions survive updates and rollback and renew after reinsertion', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const { database, store, library, loadContext, linkedChildren } = await setupChildrenFixture(t);
  const creator = new ItemCreationService({ store, library, loadContext, linkedChildren }); t.after(() => creator.close());
  const first = Object.assign(newNativeItemEntity('MediaBrowser.Controller.Entities.Audio.MusicArtist'), { Id: id(90), Name: 'First' });
  const second = Object.assign(newNativeItemEntity('MediaBrowser.Controller.Entities.Audio.MusicArtist'), { Id: id(80), Name: 'Second' });
  await creator.saveItems([first]); await creator.saveItems([second]);
  await creator.saveItems([first, second]); assert.deepEqual(await readOrder(database), [guid(first.Id), guid(second.Id)]);
  await assert.rejects(store.transaction(async db => { await db.delete('BaseItems', { Id: first.Id }); throw new Error('controlled rollback'); }), /controlled rollback/);
  assert.deepEqual(await readOrder(database), [guid(first.Id), guid(second.Id)]);
  await database.delete('BaseItems', { Id: first.Id }); await creator.saveItems([first]);
  assert.deepEqual(await readOrder(database), [guid(second.Id), guid(first.Id)]);
  await database.preflight();
  await database.client.query(`DELETE FROM ${q(database.controlSchema)}.item_order WHERE item_id = $1`, [first.Id]);
  await assert.rejects(database.preflight(), /native relation order is incomplete/);
});

test('postgres: item batch ordering bounds overlapping dependency paths and rejects cycles atomically', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const database = await createPostgresTestDatabase(t, 'item_order_dag');
  const template = native.results.find(row => row.sample.Name === 'existing').before.rows.find(row => row.Name === 'Rock');
  const identities = Array.from({ length: 40 }, (_, index) => id(500 + index));
  await database.transaction(async db => {
    await db.client.query('SET CONSTRAINTS ALL DEFERRED');
    await db.client.query("SET LOCAL statement_timeout = '5s'");
    for (let index = identities.length - 1; index >= 0; index--) await db.insert('BaseItems', {
      ...template, Id: identities[index], Name: 'Dependency ' + index,
      ParentId: index > 0 ? identities[index - 1] : null, OwnerId: index > 1 ? identities[index - 2] : null,
    });
    await orderNativeItemBatch(db, identities);
  });
  assert.deepEqual(await readOrder(database), identities.map(guid));
  const before = await readOrder(database);
  await assert.rejects(database.transaction(async db => {
    await db.update('BaseItems', { Id: identities[0] }, { OwnerId: identities.at(-1) });
    await orderNativeItemBatch(db, identities);
  }), /acyclic insertion dependencies/);
  assert.deepEqual(await readOrder(database), before);
  assert.equal((await database.rows('BaseItems', { where: { Id: identities[0] } }))[0].OwnerId, null);
});
