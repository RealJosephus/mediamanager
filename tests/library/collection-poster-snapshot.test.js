import test from 'node:test';
import assert from 'node:assert/strict';
import { CollectionPosterVerifyPostScanTask } from '../../src/library/collection-poster-post-scan-task.js';
import { LibraryScanHost } from '../../src/library/library-scan-host.js';
import { LibraryService } from '../../src/library/library-service.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { setFolderChildren } from '../../src/library/folder-cache.js';
import { idKey } from '../../src/library/records.js';
import { StorageError } from '../../src/storage/errors.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';

const pg = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 30000 };
const id = number => 'cb620000-0000-0000-0000-' + String(number).padStart(12, '0');
const collectionType = 'MediaBrowser.Controller.Entities.CollectionFolder';
const folderType = 'MediaBrowser.Controller.Entities.Folder';
const item = (number, fields = {}) => Object.assign(newNativeItemEntity(collectionType), {
  Id: id(number), Name: 'Library ' + number, ...fields
});

async function fixture(t) {
  const database = await createPostgresTestDatabase(null, 'poster_snapshot', { max: 1 });
  const store = new DomainStore(database), links = new PostgresLinkedChildrenStore({ database });
  let library, host;
  t.after(async () => {
    const failures = [];
    for (const close of [() => host?.close(), () => library?.close(), () => links.close(),
      () => store.close(), () => dropPostgresTestDatabase(database)]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Poster snapshot cleanup failed.');
  });
  await links.initialize();
  assert.equal(database.pool.options.max, 1);
  assert.equal(links.relationDatabase.pool.options.max, 1);
  library = new LibraryService({ store, linkedChildren: links, serverId: 'poster-snapshot' });
  library.itemCreation = { linkedChildren: links };
  host = new LibraryScanHost({ store, library, itemCreation: library.itemCreation, metadataScanner: {}, topLevelValidation: {} });
  const root = Object.assign(newNativeItemEntity('MediaBrowser.Controller.Entities.UserRootFolder'), { Id: id(1) });
  host.getUserRootFolder = async () => root;
  const seed = (number, fields = {}) => database.insert('BaseItems', postgresTestRow('BaseItems', {
    Id: id(number), Type: collectionType, ParentId: root.Id, IsFolder: true, Data: '{}',
    Name: 'Library ' + number, SortName: String(number).padStart(4, '0'),
    DateCreated: '2026-10-16 00:00:00.0000000', DateModified: '2026-10-16 00:00:00.0000000', ...fields
  }));
  await seed(1, { Type: root.NativeType, ParentId: null });
  const assertReleased = async () => {
    await links.flushOwnedReleases();
    await links.flushReleases();
    for (const table of ['item_states', 'item_cohorts', 'pins', 'sets']) {
      assert.equal(BigInt((await database.client.query(`SELECT count(*) AS count FROM "${links.schemaName}".${table}`)).rows[0].count), 0n, table);
    }
    assert.deepEqual((await database.client.query(`SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema()
      AND (relname LIKE 'mm_metadata_%' OR relname LIKE 'mm_scan_%')`)).rows, []);
  };
  const task = refreshLiveItem => new CollectionPosterVerifyPostScanTask({ host, metadataScanner: { refreshLiveItem } });
  return { database, store, links, library, host, root, seed, assertReleased, task };
}

test('postgres: poster captures more than two pages before refresh and keeps membership, order and values in SQL', pg, async t => {
  const f = await fixture(t);
  await f.database.transaction(async () => {
    for (let number = 2; number <= 261; number++) await f.seed(number);
    for (let number = 300; number <= 305; number++) await f.seed(number, { Type: folderType });
    await f.seed(400, { Type: 'Unknown.Plugin.Item', SortName: '0000' });
    await f.seed(401, { OwnerId: id(2) });
    await f.seed(402, { PrimaryVersionId: id(2) });
  });
  const load = f.library.load.bind(f.library), hydrationSizes = [], seen = [], progress = [];
  f.library.load = (db, user, options) => {
    hydrationSizes.push(options.baseRows.length);
    return load(db, user, options);
  };
  await f.task(async current => {
    if (!seen.length) {
      assert.ok(hydrationSizes.length >= 3, 'The complete source is hydrated before the first refresh.');
      await f.seed(999);
      await f.database.update('BaseItems', { Id: id(261) }, { Name: 'Updated after capture' });
      await f.database.delete('BaseItems', { Id: id(260) });
    }
    seen.push({ Id: idKey(current.Id), Name: current.Name });
  }).run({ reportProgress: value => progress.push(value) });
  assert.ok(hydrationSizes.every(size => size <= 128));
  assert.deepEqual(seen, Array.from({ length: 260 }, (_, index) => ({ Id: idKey(id(index + 2)), Name: 'Library ' + (index + 2) })));
  assert.deepEqual(progress, [...Array.from({ length: 260 }, (_, index) => (index + 1) / 260 * 100), 100]);
  assert.equal((await f.database.rows('BaseItems', { where: { Id: id(261) } }))[0].Name, 'Updated after capture');
  assert.equal((await f.database.rows('BaseItems', { where: { Id: id(999) } })).length, 1);
  await f.assertReleased();
});

test('postgres: poster observes immediate and late sibling changes, duplicate references and distinct same-ID objects', pg, async t => {
  const f = await fixture(t), children = Array.from({ length: 130 }, (_, index) => item(index + 2));
  const first = children[0], immediate = children[1], late = children.at(-1);
  const distinct = item(2, { Name: 'Distinct same-ID object' });
  children.push(first, distinct, Object.assign(newNativeItemEntity(folderType), { Id: id(600) }));
  setFolderChildren(f.root, children);
  const seen = [], progress = [];
  await f.task(async current => {
    seen.push({ Id: idKey(current.Id), Name: current.Name });
    if (seen.length === 1) {
      immediate.ImageInfos = [{ Type: 'Primary', Path: null }];
      late.Name = 'Changed late sibling';
      first.Name = 'Changed repeated reference';
      children.splice(2, 1);
      children.push(item(999));
    }
  }).run({ reportProgress: value => progress.push(value) });
  assert.equal(seen.length, 131);
  assert.equal(seen[0].Name, 'Library 2');
  assert.ok(!seen.some(current => current.Id === idKey(immediate.Id)));
  assert.ok(seen.some(current => current.Id === idKey(id(4))), 'Removing a child after capture does not remove its slot.');
  assert.ok(!seen.some(current => current.Id === idKey(id(999))));
  assert.deepEqual(seen.slice(-3).map(current => current.Name), ['Changed late sibling', 'Changed repeated reference', 'Distinct same-ID object']);
  assert.deepEqual(progress, [...Array.from({ length: 132 }, (_, index) => (index + 1) / 132 * 100), 100]);
  await f.assertReleased();
});

test('postgres: poster releases captured slots after cancellation and provider or progress failure without losing committed writes', pg, async t => {
  const f = await fixture(t);
  await f.seed(2);
  for (const kind of ['cancel', 'provider', 'progress']) await t.test(kind, async () => {
    const children = Array.from({ length: 132 }, (_, index) => item(index + 2));
    setFolderChildren(f.root, children);
    const controller = new AbortController(), failure = kind === 'cancel'
      ? new StorageError('cancelled', 'Controlled cancellation') : new Error('Controlled ' + kind + ' failure');
    let calls = 0, reports = 0;
    await assert.rejects(f.task(async () => {
      calls++;
      if (calls === 1) await f.store.transaction(db => db.update('BaseItems', { Id: id(2) }, { Name: 'Committed ' + kind }));
      if (calls === 129 && kind === 'provider') throw failure;
      if (calls === 129 && kind === 'cancel') controller.abort(failure);
    }).run({ signal: controller.signal, reportProgress: () => {
      if (++reports === 129 && kind === 'progress') throw failure;
    } }), error => error === failure);
    assert.equal(calls, 129);
    assert.equal(reports, kind === 'provider' ? 128 : 129);
    assert.equal((await f.database.rows('BaseItems', { where: { Id: id(2) } }))[0].Name, 'Committed ' + kind);
    await f.assertReleased();
  });
});

test('postgres: poster fails late hydration before any callback, even before an initial cancellation check', pg, async t => {
  const f = await fixture(t);
  await f.database.transaction(async () => {
    for (let number = 2; number <= 131; number++) await f.seed(number);
    await f.seed(132, { Type: 'MediaBrowser.Controller.Entities.UserView', Data: '{"DisplayParentId":"invalid-guid"}' });
  });
  const controller = new AbortController();
  controller.abort(new StorageError('cancelled', 'Controlled cancellation'));
  let called = false;
  await assert.rejects(f.task(async () => { called = true; }).run({ signal: controller.signal }), error => error.code !== 'cancelled');
  assert.equal(called, false);
  await f.assertReleased();
});

test('postgres: poster completes an empty type selection despite cancellation and releases it on a final progress error', pg, async t => {
  const f = await fixture(t);
  await f.seed(2, { Type: folderType });
  const controller = new AbortController(); controller.abort();
  const progress = [], task = f.task(async () => assert.fail('An ordinary Folder is not a poster target.'));
  await task.run({ signal: controller.signal, reportProgress: value => progress.push(value) });
  assert.deepEqual(progress, [100]);
  const failure = new Error('Controlled final progress failure');
  await assert.rejects(task.run({ reportProgress: () => { throw failure; } }), error => error === failure);
  await f.assertReleased();
});
