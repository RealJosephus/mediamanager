import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DomainStore } from '../../src/database/domain-store.js';
import { PostgresLinkedChildrenStore, emptyLinkedChildrenPlan } from '../../src/library/postgres-linked-children.js';
import { LibraryChangedNotifier } from '../../src/sessions/library-changed-notifier.js';
import { RefreshProgressNotifier } from '../../src/sessions/refresh-progress-notifier.js';
import { UserDataChangeNotifier } from '../../src/sessions/user-data-notifier.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';

const userId = 'ed730000-0000-0000-0000-000000000001';
const item = { Id: 'ed730000-0000-0000-0000-000000000002', Type: 'Folder',
  Path: 'Z:\\Notifier', IsFolder: true, IsTopParent: true, SourceType: 'Library' };

for (const kind of ['library', 'progress', 'user-data']) for (const mode of kind === 'progress' ? ['immediate'] : ['immediate', 'timer']) {
  test(`${kind} ${mode} delivery owns SQL while its producer keeps a read-only transaction open`, {
    skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000,
  }, async () => {
    const database = await createPostgresTestDatabase(null, 'notifier_scope');
    const store = new DomainStore(database), links = new PostgresLinkedChildrenStore({ database });
    const events = new EventEmitter(), errors = [], messages = [], consumers = [];
    let notifier, timer, producerBackend;
    try {
      await links.initialize();
      const read = () => store.run(async db => {
        assert.equal(db.inTransaction, false);
        const row = (await db.client.query(`SELECT pg_backend_pid() AS backend, current_setting('transaction_read_only') AS readonly`)).rows[0];
        assert.notEqual(row.backend, producerBackend);
        assert.equal(row.readonly, 'off');
        // This is the actual autocommitted relation publication that failed
        // when the notifier inherited its producer's read-only connection.
        const handle = await links.createFromSession({ session: db, parentId: item.Id, plan: emptyLinkedChildrenPlan() });
        try { assert.equal(await links.count(handle, { session: db }), 0n); consumers.push(row.backend); }
        finally { await links.release(handle, { session: db }); }
      });
      const sessions = {
        getPrimaryUserIds: () => [userId],
        async sendMessageToUserSessions(users, type, value) { messages.push({ users, type, value: typeof value === 'function' ? await value() : value }); },
        async sendMessageToAdminSessions(type, value) { messages.push({ type, value }); },
      };
      const options = { sessions, onError: error => errors.push(error), runBackground: operation => store.runDetached(operation),
        maxBatchSize: mode === 'immediate' ? 1 : 2000, schedule: callback => { timer = callback; return {}; }, cancel() {} };
      if (kind === 'library') notifier = new LibraryChangedNotifier({ ...options, events,
        users: { getUser: async () => ({ Id: userId }) },
        library: { async getLibraryUpdateInfo() { await read(); return { ItemsAdded: [item.Id], ItemsUpdated: [], ItemsRemoved: [],
          FoldersAddedTo: [], FoldersRemovedFrom: [], CollectionFolders: [] }; } } });
      else if (kind === 'progress') notifier = new RefreshProgressNotifier({ ...options, refreshes: events,
        library: { async getCollectionFolders() { await read(); return []; } } });
      else notifier = new UserDataChangeNotifier({ ...options, userData: Object.assign(events,
        { async getMany() { await read(); return [{ ItemId: item.Id, Played: true }]; } }) });
      notifier.start();
      await store.run(async db => {
        producerBackend = (await db.client.query('SELECT pg_backend_pid() AS backend')).rows[0].backend;
        if (kind === 'library') events.emit('ItemAdded', { Item: item });
        else if (kind === 'progress') events.emit('RefreshStarted', { Item: item });
        else events.emit('UserDataSaved', { UserId: userId, Item: item, SaveReason: 'TogglePlayed' });
        if (mode === 'timer') await timer();
        await notifier.drain();
        assert.deepEqual(errors, []);
        assert.equal(consumers.length, 1);
        assert.equal(messages.length, 1);
        assert.equal(messages[0].type, kind === 'library' ? 'LibraryChanged' : kind === 'progress' ? 'RefreshProgress' : 'UserDataChanged');
        assert.equal(db.inTransaction, true);
        assert.equal((await db.client.query(`SELECT current_setting('transaction_read_only') AS readonly`)).rows[0].readonly, 'on');
      }, { readOnly: true });
    } finally {
      try { await notifier?.close(); }
      finally { try { await links.close(); } finally { try { await store.close(); } finally { await dropPostgresTestDatabase(database); } } }
    }
  });
}
