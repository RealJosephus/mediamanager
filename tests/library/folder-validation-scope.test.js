import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainStore } from '../../src/database/domain-store.js';
import { LibraryService } from '../../src/library/library-service.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { withFolderValidationScope } from '../../src/library/folder-validation-scope.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { idKey } from '../../src/library/records.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString,
  postgresTestRow } from '../database/postgres-fixture.js';

const pg = { skip: !postgresTestConnectionString, timeout: 20000 };
const folderType = 'MediaBrowser.Controller.Entities.Folder';
const movieType = 'MediaBrowser.Controller.Entities.Movies.Movie';
const id = number => 'ce710000-0000-0000-0000-' + String(number).padStart(12, '0');

async function fixture(t) {
  const database = await createPostgresTestDatabase(null, 'folder_cohort', { max: 1 });
  const store = new DomainStore(database), links = new PostgresLinkedChildrenStore({ database });
  let library;
  t.after(async () => {
    const errors = [];
    for (const close of [() => library?.close(), () => links.close(), () => store.close(), () => dropPostgresTestDatabase(database)]) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Folder cohort fixture cleanup failed.');
  });
  await links.initialize();
  assert.equal(database.pool.options.max, 1);
  assert.equal(links.relationDatabase.pool.options.max, 1);
  library = new LibraryService({ store, linkedChildren: links, serverId: 'folder-cohort' });
  const parent = Object.assign(newNativeItemEntity(folderType), { Id: id(1), Path: '/library', Name: 'Library' });
  const seed = (number, fields = {}) => database.insert('BaseItems', postgresTestRow('BaseItems', {
    Id: id(number), Type: movieType, ParentId: parent.Id, Path: '/library/film-' + number + '.mkv',
    Name: 'Film ' + number, SortName: String(number).padStart(4, '0'), Data: '{}',
    DateCreated: '2026-10-16 00:00:00.0000000', DateModified: '2026-10-16 00:00:00.0000000', ...fields
  }));
  await seed(1, { Type: folderType, ParentId: null, IsFolder: true, Path: parent.Path });
  const run = operation => store.run(session => withFolderValidationScope({ session, store, library,
    linkedChildren: links, parent }, operation));
  const released = async () => {
    for (const table of ['item_states', 'item_cohorts', 'pins', 'sets']) {
      assert.equal(BigInt((await database.client.query(`SELECT count(*) AS count FROM "${links.schemaName}".${table}`)).rows[0].count), 0n, table);
    }
    assert.deepEqual((await database.client.query(`SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema()
      AND relname LIKE 'mm_folder_%'`)).rows, []);
  };
  return { database, store, links, library, parent, seed, run, released };
}

test('postgres: folder validation freezes ordered repository children before mutation and bounds hydration to 128', pg, async t => {
  const f = await fixture(t);
  await f.database.transaction(async () => {
    for (let number = 2; number <= 261; number++) await f.seed(number);
    await f.seed(400, { OwnerId: id(2) });
    await f.seed(401, { OwnerId: id(2), ExtraType: 1 });
    await f.seed(402, { PrimaryVersionId: id(2) });
    await f.seed(403, { Type: 'Unknown.Plugin.Item' });
    await f.seed(404, { ParentId: id(2) });
  });
  const load = f.library.load.bind(f.library), sizes = [];
  f.library.load = (session, user, options) => { sizes.push(options.baseRows.length); return load(session, user, options); };
  await f.run(async scope => {
    assert.ok(sizes.length >= 4, 'Every source page must be hydrated before reconciliation starts.');
    assert.ok(sizes.every(size => size <= 128));
    await f.seed(999);
    await f.database.update('BaseItems', { Id: id(261) }, { Name: 'Changed after capture' });
    await f.database.delete('BaseItems', { Id: id(260) });
    const seen = [];
    await scope.eachRemoval(item => { seen.push([idKey(item.Id), item.Name]); });
    assert.deepEqual(seen, [...Array.from({ length: 260 }, (_, index) => index + 2), 401, 402]
      .map(number => [idKey(id(number)), 'Film ' + number]));
    await scope.withCurrent(id(260), item => assert.equal(item.Name, 'Film 260'));
    await scope.withCurrent(id(999), item => assert.equal(item, null));
  });
  await f.released();
});

test('postgres: folder path replacement keeps the first original case-insensitive occupant', pg, async t => {
  const f = await fixture(t);
  await f.seed(2, { Path: '/library/Same.mkv' });
  await f.seed(3, { Path: '/library/same.mkv' });
  await f.run(async scope => {
    await scope.withPath('/LIBRARY/SAME.MKV', async item => {
      assert.equal(idKey(item.Id), idKey(id(2)));
      await scope.forget(item);
    });
    await scope.withPath('/library/same.mkv', item => assert.equal(item, null));
    await scope.withCurrent(id(3), item => assert.equal(idKey(item.Id), idKey(id(3))));
    await scope.withCurrent(id(2), item => assert.equal(item, null));
    const seen = [];
    await scope.eachRemoval(item => { seen.push(idKey(item.Id)); });
    assert.deepEqual(seen, [idKey(id(3))]);
  });
  await f.released();
});

test('postgres: accessible folder children outlive the request scope with resolver order and observed live changes', pg, async t => {
  const f = await fixture(t);
  const first = Object.assign(newNativeItemEntity(movieType), { Id: id(10), Name: 'First', Path: '/library/first.mkv' });
  const second = Object.assign(newNativeItemEntity(movieType), { Id: id(11), Name: 'Second', Path: '/library/second.mkv' });
  const inaccessible = Object.assign(newNativeItemEntity(folderType), { Id: id(12), Name: 'Unavailable', Path: '/library/unavailable' });
  const children = await f.run(async scope => {
    await scope.valid(second, 2n, true);
    await scope.valid(first, 1n, true);
    await scope.valid(inaccessible, 3n, false);
    return scope.accessible();
  });
  try {
    assert.equal(await children.count(), 2n);
    await children.withItemAtOrdinal(1n, item => {
      assert.equal(item.Name, 'First'); second.Name = 'Changed sibling';
    });
    await children.withItemAtOrdinal(2n, item => assert.equal(item.Name, 'Changed sibling'));
    await f.store.transaction(db => db.update('BaseItems', { Id: f.parent.Id }, { Name: 'Independent request' }));
  } finally { await children.close(); }
  await f.released();
});

test('postgres: malformed late children fail before reconciliation and release every captured page', pg, async t => {
  const f = await fixture(t);
  await f.database.transaction(async () => {
    for (let number = 2; number <= 131; number++) await f.seed(number);
    await f.seed(132, { Type: 'MediaBrowser.Controller.Entities.UserView', Data: '{"DisplayParentId":"invalid-guid"}' });
  });
  let called = false;
  await assert.rejects(f.run(() => { called = true; }), /Guid|GUID|Unrecognized/iu);
  assert.equal(called, false);
  await f.released();
});

test('postgres: weak folder snapshots reject missing deletable children and mismatched claims before writes', pg, async t => {
  const f = await fixture(t);
  await f.seed(2);
  await f.run(async scope => {
    await assert.rejects(scope.checkClaims([], false), error => error.code === 'not-supported');
    await assert.rejects(scope.checkClaims([{ Id: id(2), nativeType: movieType, identityPath: '/library/other.mkv' }], true),
      /structural reconciliation/u);
  });
  await f.released();
});

test('postgres: folder reattachment mutates its captured cache object and excludes an unrelated same-ID cache replacement', pg, async t => {
  const f = await fixture(t);
  const captured = Object.assign(newNativeItemEntity(movieType), { Id: id(2), Name: 'Captured', ProviderIds: { Imdb: 'shared' } });
  const unrelated = Object.assign(newNativeItemEntity(movieType), { Id: id(2), Name: 'Unrelated', ProviderIds: { Imdb: 'different' } });
  const removed = Object.assign(newNativeItemEntity(movieType), { Id: id(3), ProviderIds: { Imdb: 'shared' } });
  let cached = captured;
  f.library.itemCreation = { getCachedItemById: () => cached };
  await f.run(async scope => {
    await scope.valid(captured, 1n, true);
    await scope.removed(removed);
    await scope.reattach(async (_store, item) => {
      assert.equal(item, captured);
      item.UserData = [{ CustomDataKey: 'shared' }];
    });
    assert.deepEqual(captured.UserData, [{ CustomDataKey: 'shared' }]);
  });
  await f.run(async scope => {
    await scope.valid(captured, 1n, true);
    await scope.removed(removed);
    cached = unrelated;
    await scope.reattach(async (_store, item) => {
      assert.notEqual(item, unrelated);
      assert.equal(item.Name, 'Captured');
      item.UserData = [{ CustomDataKey: 'another' }];
    });
    assert.deepEqual(unrelated.UserData, []);
  });
  await f.released();
});

test('postgres: folder user-data intersections span pages and retain earlier reattachments on later failure', pg, async t => {
  const f = await fixture(t), failure = new Error('Controlled reattachment failure'), seen = [];
  const item = (number, imdb) => Object.assign(newNativeItemEntity(movieType), {
    Id: id(number), Name: 'Film ' + number, Path: '/library/film-' + number + '.mkv', ProviderIds: { Imdb: imdb }
  });
  await assert.rejects(f.run(async scope => {
    for (let number = 2; number <= 132; number++) {
      await scope.removed(item(number, 'tt' + number));
      await scope.valid(item(number + 200, 'tt' + number), BigInt(number), true);
    }
    await scope.valid(item(900, 'different'), 900n, true);
    let keyQueries = 0;
    const query = f.database.client.query;
    f.database.client.query = new Proxy(query, { apply(target, receiver, args) {
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
      if (sql?.includes('provider."ProviderIds" AS "__ProviderIds"')) keyQueries++;
      return Reflect.apply(target, receiver, args);
    } });
    try {
      await scope.reattach(async (store, child) => {
        seen.push(idKey(child.Id));
        if (seen.length === 2) throw failure;
        await store.transaction(db => db.update('BaseItems', { Id: f.parent.Id }, { Name: 'First reattachment committed' }));
      });
    } finally {
      f.database.client.query = query;
      assert.equal(keyQueries, 4, 'Key dependencies are loaded by bounded pages, not one native query per child.');
    }
  }), error => error === failure);
  assert.deepEqual(seen, [idKey(id(202)), idKey(id(203))]);
  assert.equal((await f.database.rows('BaseItems', { where: { Id: f.parent.Id } }))[0].Name, 'First reattachment committed');
  await f.released();
});
