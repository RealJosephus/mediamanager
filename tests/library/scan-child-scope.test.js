import test from 'node:test';
import assert from 'node:assert/strict';
import { LibraryService } from '../../src/library/library-service.js';
import { LibraryScanHost } from '../../src/library/library-scan-host.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { setFolderChildren } from '../../src/library/folder-cache.js';
import { nativeTextBytes } from '../../src/database/native-text.js';
import { idKey } from '../../src/library/records.js';
import { createPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';

const pg = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES };
const id = number => 'cb600000-0000-0000-0000-' + String(number).padStart(12, '0');
const folderType = 'MediaBrowser.Controller.Entities.Folder';
const collectionType = 'MediaBrowser.Controller.Entities.CollectionFolder';
const failureValues = error => ({ code: error?.code ?? null, message: error?.message ?? null, status: error?.status ?? null });

async function fixture(t) {
  const database = await createPostgresTestDatabase(t, 'scan_children', { max: 1 });
  const store = new DomainStore(database), links = new PostgresLinkedChildrenStore({ database });
  await links.initialize();
  const library = new LibraryService({ store, linkedChildren: links, serverId: 'scan-child-scope' });
  const unregistered = [], itemCreation = { linkedChildren: links, unregisterItem: value => unregistered.push(idKey(value)) };
  library.itemCreation = itemCreation;
  const host = new LibraryScanHost({ store, library, itemCreation, metadataScanner: {}, topLevelValidation: {} });
  t.after(async () => { await host.close(); await library.close(); await links.close(); await store.close(); });
  const root = newNativeItemEntity('MediaBrowser.Controller.Entities.UserRootFolder');
  root.Id = id(1);
  const seed = (number, fields = {}) => database.insert('BaseItems', postgresTestRow('BaseItems', {
    Id: id(number), Type: collectionType, ParentId: root.Id, IsFolder: true,
    Name: 'Library ' + String(number).padStart(4, '0'), SortName: String(number).padStart(4, '0'),
    Data: '{}', DateCreated: '2026-10-16 00:00:00.0000000', DateModified: '2026-10-16 00:00:00.0000000',
    ...fields
  }));
  await seed(1, { Type: root.NativeType, ParentId: null });
  const assertReleased = async () => {
    await links.flushOwnedReleases();
    await links.flushReleases();
    const relations = await database.client.query(`SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema()
      AND relname LIKE 'mm_scan_missing_%'`);
    assert.deepEqual(relations.rows, []);
    for (const table of ['item_states', 'item_cohorts']) {
      assert.equal(BigInt((await database.client.query(`SELECT count(*) AS count FROM "${links.schemaName}".${table}`)).rows[0].count), 0n);
    }
  };
  return { database, store, library, links, host, root, seed, unregistered, assertReleased };
}

test('postgres: top-level children freeze late pages and batch the full deletion closure with one connection', pg, async t => {
  const f = await fixture(t);
  await f.database.transaction(async () => {
    for (let number = 2; number <= 261; number++) await f.seed(number);
    await f.seed(300, { Type: 'Unknown.Plugin.Item', SortName: '0000' });
    await f.seed(400, { Type: folderType, ParentId: id(2) });
    await f.seed(401, { Type: folderType, OwnerId: id(400), ParentId: null });
  });
  const seen = [], lengths = [];
  const load = f.library.load.bind(f.library), hydrationSizes = [];
  f.library.load = (db, user, options) => {
    hydrationSizes.push(options.baseRows.length);
    return load(db, user, options);
  };
  let escaped;
  await f.host.withChildren(f.root, async children => {
    escaped = children;
    // Mutations after capture must not change a later page's membership or value.
    await f.seed(999);
    await f.database.update('BaseItems', { Id: id(261) }, { Name: 'Changed after capture' });
    for await (const page of children.pages()) {
      lengths.push(page.length);
      for (const child of page) {
        seen.push({ Id: idKey(child.Id), Name: child.Name });
        if ([idKey(id(2)), idKey(id(260))].includes(idKey(child.Id))) await children.markForDeletion(child.Id);
      }
    }
    assert.equal((await f.database.rows('BaseItems', { where: { Id: id(2) } })).length, 1);
    await children.deleteMarked();
  });
  assert.ok(lengths.length >= 3); assert.ok(lengths.every(length => length <= 128));
  assert.ok(hydrationSizes.length >= 3); assert.ok(hydrationSizes.every(length => length <= 128));
  assert.equal(seen.length, 260);
  assert.equal(seen.at(-1).Name, 'Library 0261');
  assert.ok(!seen.some(row => row.Id === idKey(id(999))));
  assert.deepEqual(f.unregistered.sort(), [2, 260, 400, 401].map(number => idKey(id(number))).sort());
  for (const number of [2, 260, 400, 401]) assert.deepEqual(await f.database.rows('BaseItems', { where: { Id: id(number) } }), []);
  assert.equal((await f.database.rows('BaseItems', { where: { Id: id(999) } })).length, 1);
  await assert.rejects(escaped.markForDeletion(id(3)), /released/);
  await f.assertReleased();
});

test('postgres: captured root objects retain sibling mutations and repeated identities across pages', pg, async t => {
  const f = await fixture(t), children = [];
  for (let number = 2; number <= 131; number++) {
    const child = newNativeItemEntity(collectionType); child.Id = id(number); child.Name = 'Captured ' + number;
    children.push(child);
  }
  const repeated = children[0];
  const sameIdDifferentObject = Object.assign(newNativeItemEntity(collectionType), { Id: repeated.Id, Name: 'Distinct same-ID object' });
  children.push(repeated, sameIdDifferentObject);
  setFolderChildren(f.root, children);
  await f.host.withChildren(f.root, async sequence => {
    children[129].Name = 'Changed captured sibling';
    children.push(Object.assign(newNativeItemEntity(collectionType), { Id: id(999) }));
    const seen = [];
    for await (const page of sequence.pages()) {
      seen.push(...page.map(child => child.Name));
      repeated.Name = 'Changed repeated reference';
    }
    assert.equal(seen.length, 132); assert.equal(seen[0], 'Captured 2');
    assert.deepEqual(seen.slice(-3), ['Changed captured sibling', 'Changed repeated reference', 'Distinct same-ID object']);
    await sequence.deleteMarked();
  });
  await f.assertReleased();
});

test('postgres: failed refresh retains all marked children and releases its SQL cohort', pg, async t => {
  const f = await fixture(t); await f.seed(2); await f.seed(3);
  const failure = new Error('Controlled refresh failure');
  await assert.rejects(f.host.withChildren(f.root, async children => {
    for await (const page of children.pages()) {
      await children.markForDeletion(page[0].Id);
      throw failure;
    }
  }), error => {
    t.diagnostic(JSON.stringify({ failureDiagnostic: { ...failureValues(error), stack: error?.stack } }));
    assert.deepEqual(failureValues(error), failureValues(failure));
    return true;
  });
  assert.equal((await f.database.rows('BaseItems', { where: { ParentId: f.root.Id } })).length, 2);
  assert.deepEqual(f.unregistered, []); await f.assertReleased();
});

test('postgres: one failed child deletion rolls back the batch and preserves earlier refresh writes', pg, async t => {
  const f = await fixture(t); await f.seed(2); await f.seed(3); await f.seed(4);
  await f.database.client.query(`CREATE FUNCTION "${f.database.schemaName}".reject_child_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF OLD."Id"=decode('${nativeTextBytes(id(3)).toString('hex')}','hex') THEN
      RAISE EXCEPTION 'Controlled child deletion failure'; END IF; RETURN OLD; END $$;
    CREATE TRIGGER reject_child_delete BEFORE DELETE ON "${f.database.schemaName}"."BaseItems"
    FOR EACH ROW EXECUTE FUNCTION "${f.database.schemaName}".reject_child_delete()`);
  await assert.rejects(f.host.withChildren(f.root, async children => {
    await f.store.transaction(db => db.update('BaseItems', { Id: id(4) }, { Name: 'Committed refresh' }));
    for await (const page of children.pages()) for (const child of page) if (idKey(child.Id) !== idKey(id(4))) await children.markForDeletion(child.Id);
    await children.deleteMarked();
  }), /Controlled child deletion failure/);
  assert.equal((await f.database.rows('BaseItems', { where: { ParentId: f.root.Id } })).length, 3);
  assert.equal((await f.database.rows('BaseItems', { where: { Id: id(4) } }))[0].Name, 'Committed refresh');
  assert.deepEqual(f.unregistered, []); await f.assertReleased();
});

test('postgres: malformed late child hydration fails before any metadata callback', pg, async t => {
  const f = await fixture(t);
  await f.database.transaction(async () => {
    for (let number = 2; number <= 131; number++) await f.seed(number);
    await f.seed(132, { Data: '{"PhysicalFolderIds":["invalid-guid"]}' });
  });
  let called = false;
  await assert.rejects(f.host.withChildren(f.root, async () => { called = true; }));
  assert.equal(called, false); assert.deepEqual(f.unregistered, []); await f.assertReleased();
});
