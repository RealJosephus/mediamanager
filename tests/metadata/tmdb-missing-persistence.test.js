import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { quoteIdentifier } from '../../src/database/model.js';
import { pruneDisabledTmdbVirtualEpisodes } from '../../plugins/tmdb/missing-episodes.js';
import { deletePersistedItems } from '../../src/library/item-persistence.js';
import { seedPersistence, persistenceProjection, persistenceIds, emptyRow, placeholderId } from './fixtures/tmdb-missing/persistence-input.mjs';
import { persistedTmdbCleanupLifecycle, createTmdbTestServices } from './tmdb-missing-test-lifecycle.js';
import { failBaseItemDelete } from '../database/postgres-faults.js';

const native = JSON.parse(await readFile(new URL('./fixtures/tmdb-missing/persistence-native.json', import.meta.url)));
const provenance = JSON.parse(await readFile(new URL('./fixtures/tmdb-missing/provenance.json', import.meta.url)));
assert.equal(createHash('sha256').update(await readFile(new URL('./fixtures/tmdb-missing/persistence-native.json', import.meta.url)))
  .digest('hex'), provenance.persistenceNativeSha256);
assert.equal(createHash('sha256').update(await readFile(new URL('./fixtures/tmdb-missing/persistence-input.mjs', import.meta.url)))
  .digest('hex'), provenance.oracleFiles['persistence-input.mjs']);
assert.equal(createHash('sha256').update(await readFile(new URL('../../src/database/native-model.json', import.meta.url)))
  .digest('hex'), provenance.nativeModelSha256);
assert.equal(native.phaseAcceptance, false);
const retentionDate = native.tables.UserData.find(row => row.CustomDataKey === 'shared').RetentionDate;
assert.ok(retentionDate >= native.started && retentionDate <= native.ended);
assert.equal(native.tables.UserData.find(row => row.CustomDataKey === 'unique').RetentionDate, retentionDate);
const sorted = rows => rows.map(row => Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))
  .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const prune = (services, series, { now } = {}) => pruneDisabledTmdbVirtualEpisodes(
  persistedTmdbCleanupLifecycle({ ...services, now }), series);

async function fixture(t) {
  const schema = `tmdb_persistence_${process.pid}_${randomBytes(4).toString('hex')}`;
  const db = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  let services;
  t.after(async () => {
    await services?.close();
    await db.client.query(`DROP SCHEMA ${quoteIdentifier(db.schemaName)} CASCADE`);
    await db.client.query(`DROP SCHEMA ${quoteIdentifier(db.controlSchema)} CASCADE`);
    assert.equal((await db.client.query('SELECT nspname FROM pg_namespace WHERE nspname=ANY($1::text[])',
      [[db.schemaName, db.controlSchema]])).rows.length, 0);
    await db.close();
  });
  await seedPersistence(db);
  const store = new DomainStore(db);
  services = await createTmdbTestServices({ store });
  return { db, ...services };
}

for (const dialect of ['postgres']) test(`${dialect}: TMDB deletion preserves native SQL userdata and ownership`, {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  await t.test('empty deletion identities cannot enter the ownership closure or mutate retained data', async t => {
    const current = await fixture(t, dialect), { db, store } = current, before = await persistenceProjection(db);
    for (const ids of [null, [], [null], [undefined], [''], ['00000000-0000-0000-0000-000000000000'], [placeholderId], [persistenceIds.episode, null]]) {
      await assert.rejects(deletePersistedItems(store, ids), TypeError);
      assert.deepEqual(await persistenceProjection(db), before);
    }
  });
  await t.test('actual ItemPersistenceService SQLite result matches every projected row in twelve tables', async t => {
    const current = await fixture(t, dialect), { db, store } = current;
    const removed = await prune(current, { Id: persistenceIds.series, Type: 'Series' }, { now: () => retentionDate });
    assert.deepEqual(removed, [persistenceIds.episode]);
    const actual = await persistenceProjection(db);
    for (const [table, rows] of Object.entries(actual)) assert.deepEqual(sorted(rows), sorted(native.tables[table]), table);
  });
  await t.test('SQL failure after userdata reattachment rolls back the complete deletion', async t => {
    const current = await fixture(t), { db, store } = current, before = await persistenceProjection(db);
    await failBaseItemDelete(db, persistenceIds.episode, 'Injected deletion failure');
    await assert.rejects(prune(current, { Id: persistenceIds.series, Type: 'Series' }), /Injected deletion failure/);
    assert.deepEqual(await persistenceProjection(db), before);
  });
  for (const failingTable of ['MediaSegments', 'TrickplayInfos']) await t.test(`${failingTable} cleanup failure rolls back deleted BaseItems and preferences`, async t => {
    const current = await fixture(t), { db, store } = current, before = await persistenceProjection(db);
    const functionName = `"${db.schemaName}".test_${failingTable.toLowerCase()}_delete_failure`;
    await db.client.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected ${failingTable} cleanup failure'; END $$`);
    await db.client.query(`CREATE TRIGGER test_${failingTable.toLowerCase()}_delete_failure BEFORE DELETE ON "${failingTable}"
      FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    await assert.rejects(prune(current, { Id: persistenceIds.series, Type: 'Series' }), new RegExp(`Injected ${failingTable} cleanup failure`));
    assert.deepEqual(await persistenceProjection(db), before);
  });
  await t.test('disabled cleanup ignores a refresh cancellation raised during deletion', async t => {
    const current = await fixture(t), { db, store } = current;
    const controller = new AbortController(), query = db.client.query.bind(db.client);
    db.client.query = async (...args) => {
      const result = await query(...args);
      const statement = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
      if (/\bDELETE FROM\s+(?:"[^"]+"\.)?"BaseItems"(?:\s|$)/u.test(statement)) controller.abort(new Error('Injected deletion cancellation'));
      return result;
    };
    await prune(current, { Id: persistenceIds.series, Type: 'Series' }, { now: () => retentionDate });
    db.client.query = query;
    assert.equal(controller.signal.aborted, true);
    const actual = await persistenceProjection(db);
    for (const [table, rows] of Object.entries(actual)) assert.deepEqual(sorted(rows), sorted(native.tables[table]), table);
  });
  await t.test('a later episode SQL failure preserves an earlier committed native deletion', async t => {
    const current = await fixture(t), { db, store } = current;
    await db.update('BaseItems', { Id: persistenceIds.outside }, { IsVirtualItem: true });
    await db.insert('BaseItemProviders', { ItemId: persistenceIds.outside, ProviderId: 'Tmdb', ProviderValue: '202' });
    await db.insert('LinkedChildren', { ParentId: persistenceIds.series, ChildId: persistenceIds.outside, ChildType: 0, SortOrder: 1 });
    await failBaseItemDelete(db, persistenceIds.outside, 'Second episode deletion failure');
    await assert.rejects(prune(current, { Id: persistenceIds.series, Type: 'Series' }, { now: () => retentionDate }), /Second episode deletion failure/);
    assert.equal((await db.rows('BaseItems', { where: { Id: persistenceIds.episode } })).length, 0);
    assert.equal((await db.rows('BaseItems', { where: { Id: persistenceIds.outside } })).length, 1);
    assert.equal((await db.rows('LinkedChildren', { where: { ChildId: persistenceIds.outside } })).length, 1);
    assert.equal((await db.rows('UserData')).length, native.tables.UserData.length);
  });
  for (const transactionNumber of [1, 2]) await t.test(`deletion ${transactionNumber} reloads late ParentId, OwnerId and AncestorIds relations`, async t => {
    const current = await fixture(t, dialect), { db, store } = current;
    const target = transactionNumber === 1 ? persistenceIds.episode : persistenceIds.outside;
    if (transactionNumber === 2) {
      await db.update('BaseItems', { Id: target }, { IsVirtualItem: true });
      await db.insert('BaseItemProviders', { ItemId: target, ProviderId: 'Tmdb', ProviderValue: '202' });
      await db.insert('LinkedChildren', { ParentId: persistenceIds.series, ChildId: target, ChildType: 0, SortOrder: 1 });
    }
    const transaction = store.transaction.bind(store), lateItems = [], keys = [];
    let transactions = 0;
    store.transaction = async (...args) => {
      // Selection already read its entity snapshot. Commit these new persisted
      // relationships before the selected item's independent deletion begins.
      if (++transactions === transactionNumber) {
        for (const [index, relationship] of ['ParentId', 'OwnerId', 'AncestorIds'].entries()) {
          const Id = `F4444444-4444-4444-4444-${String(index + 1).padStart(12, '0')}`;
          const CustomDataKey = `late-${relationship}`;
          lateItems.push(Id); keys.push(CustomDataKey);
          await db.insert('BaseItems', { ...emptyRow('BaseItems'), Id, Name: CustomDataKey, SortName: CustomDataKey,
            Type: 'MediaBrowser.Controller.Entities.TV.Episode', Data: '{}',
            ...(relationship === 'AncestorIds' ? {} : { [relationship]: target }) });
          if (relationship === 'AncestorIds') await db.insert('AncestorIds', { ItemId: Id, ParentItemId: target });
          await db.insert('UserData', { ...emptyRow('UserData'), ItemId: Id, UserId: persistenceIds.user,
            CustomDataKey, PlaybackPositionTicks: 9007199254740999n, PlayCount: 1 });
        }
      }
      return transaction(...args);
    };
    const removed = await prune(current, { Id: persistenceIds.series, Type: 'Series' }, { now: () => retentionDate });
    assert.deepEqual(removed, transactionNumber === 1 ? [persistenceIds.episode] : [persistenceIds.episode, persistenceIds.outside]);
    assert.equal(transactions, transactionNumber);
    for (const Id of lateItems) assert.equal((await db.rows('BaseItems', { where: { Id } })).length, 0);
    for (const CustomDataKey of keys) {
      const [retained] = await db.rows('UserData', { where: { CustomDataKey } });
      assert.equal(retained.ItemId, placeholderId);
      assert.equal(retained.RetentionDate.replace(' ', 'T').replace(/Z?$/, 'Z'), retentionDate);
      assert.equal(retained.PlaybackPositionTicks, 9007199254740999n);
    }
  });
});
