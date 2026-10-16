import test from 'node:test';
import assert from 'node:assert/strict';
import { LibraryService } from '../../src/library/library-service.js';
import { LibraryScanHost } from '../../src/library/library-scan-host.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { idKey } from '../../src/library/records.js';
import { createPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';

const id = number => 'cb610000-0000-0000-0000-' + String(number).padStart(12, '0');
const collectionType = 'MediaBrowser.Controller.Entities.CollectionFolder';

test('postgres: top-level deletion observes a descendant committed by an independent writer before its lock is released',
  { skip: !postgresTestConnectionString, timeout: 20000 }, async t => {
  const database = await createPostgresTestDatabase(t, 'scan_child_race', { max: 1 });
  const store = new DomainStore(database), links = new PostgresLinkedChildrenStore({ database });
  await links.initialize();
  const library = new LibraryService({ store, linkedChildren: links, serverId: 'scan-child-writer-barrier' });
  const unregistered = [], itemCreation = { linkedChildren: links, unregisterItem: value => unregistered.push(idKey(value)) };
  library.itemCreation = itemCreation;
  const host = new LibraryScanHost({ store, library, itemCreation, metadataScanner: {}, topLevelValidation: {} });
  const otherDatabase = await PostgresDatabase.open({ connectionString: postgresTestConnectionString,
    schema: database.schemaName, max: 1 });
  const otherStore = new DomainStore(otherDatabase);
  const originalQuery = database.client.query;
  t.after(async () => {
    database.client.query = originalQuery;
    await otherStore.close(); await host.close(); await library.close(); await links.close(); await store.close();
  });
  const root = newNativeItemEntity('MediaBrowser.Controller.Entities.UserRootFolder'); root.Id = id(1);
  const record = (number, fields) => postgresTestRow('BaseItems', { Id: id(number), Type: collectionType,
    ParentId: root.Id, IsFolder: true, Name: 'Library ' + number, SortName: String(number), Data: '{}',
    DateCreated: '2026-10-16 00:00:00.0000000', DateModified: '2026-10-16 00:00:00.0000000', ...fields });
  await database.insert('BaseItems', record(1, { Type: root.NativeType, ParentId: null }));
  await database.insert('BaseItems', record(2));

  let failedLockAttempts = 0, deletionPid, writerPid;
  await host.withChildren(root, async children => {
    await children.markForDeletion(id(2));
    const writerEntered = Promise.withResolvers(), releaseWriter = Promise.withResolvers();
    const writer = otherStore.serializeWrites(async db => {
      writerPid = (await db.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      writerEntered.resolve();
      await releaseWriter.promise;
      await otherStore.transaction(session => session.insert('BaseItems', record(3,
        { Type: 'MediaBrowser.Controller.Entities.Folder', ParentId: id(2) })));
    });
    try {
      await writerEntered.promise;
      deletionPid = (await database.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      database.client.query = async (...args) => {
        const result = await originalQuery(...args);
        const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
        if (text?.includes('pg_try_advisory_lock') && result.rows[0]?.locked === false) {
          failedLockAttempts++;
          releaseWriter.resolve();
        }
        return result;
      };
      await children.deleteMarked();
    } finally {
      releaseWriter.resolve();
      await writer;
      database.client.query = originalQuery;
    }
  });
  assert.notEqual(deletionPid, writerPid, 'the writers must use independent PostgreSQL backends');
  assert.ok(failedLockAttempts > 0, 'the deletion must wait for the independent domain writer');
  assert.deepEqual(unregistered.sort(), [idKey(id(2)), idKey(id(3))].sort());
  assert.deepEqual(await database.rows('BaseItems', { whereIn: { Id: [id(2), id(3)] } }), []);
  for (const table of ['item_states', 'item_cohorts']) {
    assert.equal(BigInt((await database.client.query(`SELECT count(*) AS count FROM "${links.schemaName}".${table}`)).rows[0].count), 0n);
  }
});
