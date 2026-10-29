import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CollectionPosterVerifyPostScanTask } from '../../src/library/collection-poster-post-scan-task.js';
import { LibraryScanHost } from '../../src/library/library-scan-host.js';
import { LibraryService } from '../../src/library/library-service.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { releaseCachedFolderChildren, setFolderChildren } from '../../src/library/folder-cache.js';
import { idKey } from '../../src/library/records.js';
import { StorageError } from '../../src/storage/errors.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';

const pg = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 30000 };
const id = number => 'cb620000-0000-0000-0000-' + String(number).padStart(12, '0');
const collectionType = 'MediaBrowser.Controller.Entities.CollectionFolder';
const folderType = 'MediaBrowser.Controller.Entities.Folder';
const failureValues = error => ({ code: error?.code ?? null, message: error?.message ?? null, status: error?.status ?? null });
const assertFailureValues = (t, actual, expected) => {
  t.diagnostic(JSON.stringify({ failureDiagnostic: { ...failureValues(actual), stack: actual?.stack } }));
  assert.deepEqual(failureValues(actual), failureValues(expected));
  return true;
};
const item = (number, fields = {}) => Object.assign(newNativeItemEntity(collectionType), {
  Id: id(number), Name: 'Library ' + number, ...fields
});

async function fixture(t, { stage = () => {}, observeSql = () => {}, formalItemManager = false } = {}) {
  stage('database-create:start');
  const database = await createPostgresTestDatabase(null, 'poster_snapshot', { max: 1 });
  stage('database-create:done'); observeSql(database, 'main-and-relations');
  const store = new DomainStore(database), links = new PostgresLinkedChildrenStore({ database });
  let library, host, manager;
  t.after(async () => {
    const failures = [];
    for (const [owner, close] of [['host', () => host?.close()], ['item-manager', () => manager?.close()],
      ['library', () => library?.close()], ['links', () => links.close()],
      ['store', () => store.close()], ['database-drop', () => dropPostgresTestDatabase(database)]]) {
      stage('owner-close:start', { owner });
      try { await close(); stage('owner-close:done', { owner }); }
      catch (error) { stage('owner-close:failed', { owner, ...failureValues(error) }); failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Poster snapshot cleanup failed.');
  });
  stage('links-initialize:start'); await links.initialize(); stage('links-initialize:done');
  // The relation database already delegates its read-only queryHook to this root.
  assert.equal(database.pool.options.max, 1);
  assert.equal(links.relationDatabase.pool.options.max, 1);
  library = new LibraryService({ store, linkedChildren: links, serverId: 'poster-snapshot' });
  if (formalItemManager) manager = new ItemCreationService({ store, library, linkedChildren: links,
    loadContext: async () => { throw new Error('Metadata writes are outside this poster child-read scenario.'); } });
  library.itemCreation = manager ?? { linkedChildren: links };
  host = new LibraryScanHost({ store, library, itemCreation: library.itemCreation, metadataScanner: {}, topLevelValidation: {} });
  let root = Object.assign(newNativeItemEntity('MediaBrowser.Controller.Entities.UserRootFolder'), { Id: id(1) });
  host.getUserRootFolder = async () => root;
  const seed = (number, fields = {}) => database.insert('BaseItems', postgresTestRow('BaseItems', {
    Id: id(number), Type: collectionType, ParentId: root.Id, IsFolder: true, Data: '{}',
    Name: 'Library ' + number, SortName: String(number).padStart(4, '0'),
    DateCreated: '2026-10-16 00:00:00.0000000', DateModified: '2026-10-16 00:00:00.0000000', ...fields
  }));
  await seed(1, { Type: root.NativeType, ParentId: null });
  if (manager) root = await manager.getItemById(root.Id);
  const assertReleased = async () => {
    stage('release:start');
    await links.flushOwnedReleases();
    await links.flushReleases();
    for (const table of ['item_states', 'item_cohorts', 'pins', 'sets']) {
      assert.equal(BigInt((await database.client.query(`SELECT count(*) AS count FROM "${links.schemaName}".${table}`)).rows[0].count), 0n, table);
    }
    assert.deepEqual((await database.client.query(`SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema()
      AND (relname LIKE 'mm_metadata_%' OR relname LIKE 'mm_scan_%')`)).rows, []);
    stage('release:done');
  };
  const task = refreshLiveItem => new CollectionPosterVerifyPostScanTask({ host, metadataScanner: { refreshLiveItem } });
  return { database, store, links, library, host, manager, root, seed, assertReleased, task };
}

test('postgres: poster captures more than two pages before refresh and keeps membership, order and values in SQL', pg, async t => {
  const started = process.hrtime.bigint(), activeSql = new Map(), sqlGroups = new Map();
  let currentPhase, currentPage = null, queryOrdinal = 0, slowQueries = 0;
  const elapsed = start => Number(process.hrtime.bigint() - start) / 1e6;
  const stage = (phase, details = {}) => {
    currentPhase = phase;
    currentPage = details.page ?? null;
    process.stderr.write('[poster-snapshot-stage] ' + JSON.stringify({ phase, milliseconds: elapsed(started), ...details }) + '\n');
  };
  const summarizeSql = label => process.stderr.write('[poster-snapshot-sql-summary] ' + JSON.stringify({ label,
    milliseconds: elapsed(started), groups: [...sqlGroups.values()].sort((a, b) => b.totalMilliseconds - a.totalMilliseconds).slice(0, 12) }) + '\n');
  const observeSql = (database, owner) => {
    const query = database.client.query.bind(database.client);
    database.queryHook = async (...args) => {
      const text = typeof args[0] === 'string' ? args[0] : args[0].text;
      const values = typeof args[0] === 'string' ? args[1] : args[0].values;
      const ordinal = ++queryOrdinal, begin = process.hrtime.bigint();
      const shape = text.replace(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|[a-f0-9]{32}/giu, '{uuid}')
        .replace(/poster_snapshot_[a-f0-9]+/giu, 'poster_snapshot_{id}').replace(/\s+/gu, ' ').trim();
      const observation = { owner, phase: currentPhase, page: currentPage, command: text.trim().split(/\s/u)[0],
        sha256: createHash('sha256').update(text).digest('hex'), parameters: Array.isArray(values) ? values.length : 0 };
      const shapeSha256 = createHash('sha256').update(shape).digest('hex');
      const key = JSON.stringify([observation.phase, observation.page, shapeSha256]);
      activeSql.set(ordinal, { ...observation, begin });
      try { return await query(...args); }
      finally {
        activeSql.delete(ordinal);
        const milliseconds = elapsed(begin), group = sqlGroups.get(key) ?? { owner, phase: observation.phase, page: observation.page,
          command: observation.command, shapeSha256, statementPrefix: shape.slice(0, 240), count: 0, totalMilliseconds: 0, maxMilliseconds: 0 };
        group.count++; group.totalMilliseconds += milliseconds; group.maxMilliseconds = Math.max(group.maxMilliseconds, milliseconds);
        sqlGroups.set(key, group);
        if (milliseconds >= 100 && slowQueries++ < 8) process.stderr.write('[poster-snapshot-sql] '
          + JSON.stringify({ ...observation, milliseconds }) + '\n');
      }
    };
  };
  const aborted = () => {
    process.stderr.write('[poster-snapshot-stage] ' + JSON.stringify({ phase: 'test-aborted', milliseconds: elapsed(started), lastPhase: currentPhase,
      activeSql: [...activeSql.values()].map(({ begin, ...query }) => ({ ...query, milliseconds: elapsed(begin) })) }) + '\n');
    summarizeSql('test-aborted');
  };
  t.signal.addEventListener('abort', aborted, { once: true });
  const f = await fixture(t, { stage, observeSql });
  t.after(() => { t.signal.removeEventListener('abort', aborted); summarizeSql('after-owner-close'); });
  stage('seed:start');
  await f.database.transaction(async () => {
    for (let number = 2; number <= 261; number++) await f.seed(number);
    for (let number = 300; number <= 305; number++) await f.seed(number, { Type: folderType });
    await f.seed(400, { Type: 'Unknown.Plugin.Item', SortName: '0000' });
    await f.seed(401, { OwnerId: id(2) });
    await f.seed(402, { PrimaryVersionId: id(2) });
  });
  stage('seed:done');
  const load = f.library.load.bind(f.library), hydrationSizes = [], seen = [], progress = [];
  f.library.load = async (db, user, options) => {
    const page = hydrationSizes.push(options.baseRows.length);
    stage('hydrate:start', { page, rows: options.baseRows.length });
    const result = await load(db, user, options);
    stage('hydrate:done', { page, rows: options.baseRows.length });
    const dispose = result.dispose;
    result.dispose = function (...args) {
      stage('hydrate-dispose:start', { page });
      let pending;
      try { pending = dispose.apply(this, args); }
      catch (error) { stage('hydrate-dispose:failed', { page, ...failureValues(error) }); throw error; }
      void Promise.resolve(pending).then(() => stage('hydrate-dispose:done', { page }),
        error => stage('hydrate-dispose:failed', { page, ...failureValues(error) })).catch(() => {});
      return pending;
    };
    return result;
  };
  const snapshot = f.host.withChildSnapshot;
  f.host.withChildSnapshot = function (parent, operation, ...args) {
    return snapshot.call(this, parent, sequence => { stage('snapshot-ready'); return operation(sequence); }, ...args);
  };
  stage('poster-run:start');
  await f.task(async current => {
    if (!seen.length) {
      summarizeSql('before-first-refresh');
      stage('first-refresh:start', { hydratedPages: hydrationSizes.length });
      assert.ok(hydrationSizes.length >= 3, 'The complete source is hydrated before the first refresh.');
      stage('first-refresh-insert:start'); await f.seed(999); stage('first-refresh-insert:done');
      stage('first-refresh-update:start');
      await f.database.update('BaseItems', { Id: id(261) }, { Name: 'Updated after capture' });
      stage('first-refresh-update:done'); stage('first-refresh-delete:start');
      await f.database.delete('BaseItems', { Id: id(260) });
      stage('first-refresh-delete:done'); stage('first-refresh:done');
    }
    seen.push({ Id: idKey(current.Id), Name: current.Name });
    if (seen.length === 128 || seen.length === 256 || seen.length === 260) stage('refresh-prefix', { completed: seen.length });
  }).run({ reportProgress: value => progress.push(value) });
  stage('poster-run:done');
  summarizeSql('after-poster-run');
  assert.ok(hydrationSizes.every(size => size <= 128));
  assert.deepEqual(seen, Array.from({ length: 260 }, (_, index) => ({ Id: idKey(id(index + 2)), Name: 'Library ' + (index + 2) })));
  assert.deepEqual(progress, [...Array.from({ length: 260 }, (_, index) => (index + 1) / 260 * 100), 100]);
  assert.equal((await f.database.rows('BaseItems', { where: { Id: id(261) } }))[0].Name, 'Updated after capture');
  assert.equal((await f.database.rows('BaseItems', { where: { Id: id(999) } })).length, 1);
  await f.assertReleased();
  summarizeSql('after-release');
  stage('body:done');
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
    } }), error => assertFailureValues(t, error, failure));
    assert.equal(controller.signal.aborted, kind === 'cancel');
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
  const f = await fixture(t, { formalItemManager: true });
  await f.seed(2, { Type: folderType });
  const controller = new AbortController(); controller.abort();
  const progress = [], task = f.task(async () => assert.fail('An ordinary Folder is not a poster target.'));
  await task.run({ signal: controller.signal, reportProgress: value => progress.push(value) });
  assert.deepEqual(progress, [100]);
  // The manager retains the actual SQL root while the populated Children value
  // is withdrawn. The next run must replay its captured IDs through that owner.
  releaseCachedFolderChildren(f.root);
  const failure = new Error('Controlled final progress failure');
  await assert.rejects(task.run({ reportProgress: () => { throw failure; } }), error => assertFailureValues(t, error, failure));
  await f.manager.close();
  await f.assertReleased();
});
