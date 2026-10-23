import assert from 'node:assert/strict';
import test from 'node:test';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { nativeTextBytes } from '../../src/database/native-text.js';
import { createPostgresLinkedResolutionWorkspace } from '../../src/library/postgres-linked-resolution-workspace.js';
import { createPostgresCollectionMembership } from '../../src/library/postgres-collection-membership.js';
import { resolvePostgresLinkedChildren } from '../../src/library/postgres-linked-child-resolution.js';
import { createNativeItemCohort } from '../../src/library/native-item-cohort.js';
import { newNativeItemEntity, publishNativeItemLinks, releaseNativeItemLinks } from '../../src/library/native-item-entity.js';
import { createMetadataChildren } from '../../src/library/metadata-children.js';
import { EMPTY_ID, idKey } from '../../src/library/records.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';
import { createPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';

export const requiredValidationServices = ['postgres'];
// This component executes the real SQL workspace, resolver, typed cohort and
// metadata consumer. Hydration/fallback faults below are explicit test controls;
// actual native Folder.ResolveLinkedChildren evidence remains in the existing
// collection and current root-navigation differential fixtures.
export const sourceBindings = Object.freeze([
  'MediaBrowser.Controller/Entities/Folder.cs: ResolveLinkedChildren',
  'MediaBrowser.Controller/Entities/BaseItem.cs: GetLinkedChild/FindLinkedChild',
]);
const id = value => `ed710000-0000-0000-0000-${String(value).padStart(12, '0')}`;
const encoded = value => value == null ? null : nativeTextBytes(value);
const rawPlan = rows => Object.freeze({ text: `SELECT * FROM unnest($1::bigint[],$2::bytea[],$3::integer[],$4::bytea[],$5::bytea[])
  source("Ordinal","ItemId","Type","Path","LibraryItemId")`, values: Object.freeze([
  rows.map((_, index) => BigInt(index + 1)), rows.map(row => encoded(row.ItemId)), rows.map(row => row.Type ?? 0),
  rows.map(row => encoded(row.Path)), rows.map(row => encoded(row.LibraryItemId)),
]) });
const emptyPlan = rawPlan([]);
const tempNames = async session => (await session.client.query(`SELECT relname FROM pg_catalog.pg_class
  WHERE relnamespace=pg_catalog.pg_my_temp_schema() AND relkind='r'
    AND (relname LIKE 'mm_link_resolution_%' OR relname LIKE 'mm_collection_requests_%') ORDER BY relname`)).rows.map(row => row.relname);
async function cleanup(primary, operations) {
  const errors = [];
  for (const operation of operations) try { await operation(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(primary ? [primary, ...errors] : errors,
    primary?.message ?? 'Linked workspace test cleanup failed.', primary ? { cause: primary } : undefined);
}
async function transientRoot(fixture, rows) {
  const root = newNativeItemEntity('MediaBrowser.Controller.Entities.UserRootFolder');
  root.Id = id(999); root.Path = 'Z:\\ChildSelection\\transient-root';
  publishNativeItemLinks(root, await fixture.linkedChildren.createFromPlan({ parentId: root.Id, plan: rawPlan(rows) }));
  return root;
}
async function rootLinks(fixture, root) {
  const result = [];
  for await (const page of fixture.linkedChildren.pages(root.LinkedChildren)) result.push(...page.map(row => ({
    Ordinal: row.Ordinal, ItemId: row.ItemId == null ? null : idKey(row.ItemId), Path: row.Path,
  })));
  return result;
}

test('transient UserRoot metadata links use one complete 131-item repository batch without a persisted parent', {
  skip: !postgresTestConnectionString, timeout: 180000,
}, async t => {
  const fixture = await setupChildrenFixture(t), { library, database, linkedChildren, store } = fixture;
  const definitions = Array.from({ length: 131 }, (_, index) => ({ key: `member-${index}`, type: 'Movie', Id: id(index + 1),
    Path: `Z:\\ChildSelection\\member-${index}.mkv`, Name: `Stored ${index}` }));
  await fixture.seed({ target: 'member-0', items: definitions });
  const warm = newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.Movie');
  warm.Id = id(1); warm.Path = definitions[0].Path; warm.Name = 'Registered warm'; library.itemCreation.registerItem(warm);
  const rows = [{ ItemId: null, Path: definitions[0].Path }, ...definitions.map(item => ({ ItemId: item.Id })),
    { ItemId: id(1) }, { ItemId: EMPTY_ID, Path: definitions[1].Path }];
  const root = await transientRoot(fixture, rows);
  const nativeLoad = library.load.bind(library), hydratedPages = [], names = [], pageSizes = [];
  library.load = async (...args) => {
    const requested = args[2]?.baseRows;
    if (args[2]?.includeFolderLinks && requested?.length) hydratedPages.push(requested.length);
    return nativeLoad(...args);
  };
  let sequence, failure;
  try {
    assert.deepEqual(await database.rows('BaseItems', { where: { Id: root.Id } }), []);
    await store.run(async session => {
      await assert.rejects(createPostgresCollectionMembership(session, { collectionId: root.Id, linksPlan: linkedChildren.plan(root.LinkedChildren) }),
        error => error.status === 400 && error.message === 'No collection exists with the supplied collectionId ' + root.Id);
      assert.deepEqual(await tempNames(session), [], 'The collection business guard precedes workspace creation.');
    });
    sequence = await createMetadataChildren(fixture).linked(root);
    assert.deepEqual(hydratedPages, [128, 3]);
    assert.equal(await sequence.count(), 133n);
    for await (const page of sequence.pages()) {
      pageSizes.push(page.length); names.push(...page.map(item => item.Name));
    }
    assert.deepEqual(pageSizes, [128, 5]);
    assert.deepEqual(names, ['Registered warm', ...definitions.map(item => item.Name), 'Stored 0'],
      'Positive-ID repository objects cannot be replaced by registered same-ID warm objects.');
    const cached = await rootLinks(fixture, root);
    assert.equal(cached[0].ItemId, idKey(id(1))); assert.equal(cached.at(-1).ItemId, idKey(EMPTY_ID));
    assert.equal(cached.length, rows.length);
    assert.deepEqual(await database.rows('LinkedChildren'), [], 'Resolving a live link never saves business membership.');
    assert.deepEqual(await database.rows('BaseItems', { where: { Id: root.Id } }), []);
  } catch (error) { failure = error; throw error; }
  finally {
    library.load = nativeLoad;
    await cleanup(failure, [() => sequence?.close(), () => releaseNativeItemLinks(root), () => linkedChildren.flushReleases()]);
  }
  await store.run(async session => assert.deepEqual(await tempNames(session), []));
  assert.equal(BigInt((await database.client.query(`SELECT count(*) AS count FROM ${q(linkedChildren.schemaName)}.item_states`)).rows[0].count), 0n);
});

test('complete positive lookup failure prevents early fallback; a later fallback failure keeps the live successful prefix', {
  skip: !postgresTestConnectionString, timeout: 180000,
}, async t => {
  const fixture = await setupChildrenFixture(t), { library, store, linkedChildren } = fixture;
  const definitions = Array.from({ length: 131 }, (_, index) => ({ key: `member-${index}`, type: 'Movie', Id: id(index + 1),
    Path: `Z:\\ChildSelection\\member-${index}.mkv`, Name: `Stored ${index}` }));
  await fixture.seed({ target: 'member-0', items: definitions });
  const root = await transientRoot(fixture, [{ ItemId: null, Path: definitions[0].Path }, ...definitions.map(item => ({ ItemId: item.Id }))]);
  const nativeLoad = library.load.bind(library), hydrationFailure = new Error('Controlled late hydration failure');
  const fallbackFailure = new Error('Controlled later fallback failure');
  let fallbackCalls = 0, pages = 0;
  library.load = async (...args) => {
    const state = await nativeLoad(...args);
    if (args[2]?.includeFolderLinks && ++pages === 2) { await state.dispose({ session: args[0] }); throw hydrationFailure; }
    return state;
  };
  const resolve = (current, findByPath) => store.run(async session => {
    const resolution = await createPostgresLinkedResolutionWorkspace(session, { linksPlan: linkedChildren.plan(current.LinkedChildren) });
    let cohort, failure;
    try {
      cohort = await createNativeItemCohort({ linkedChildren });
      await resolvePostgresLinkedChildren({ session, item: current, links: current.LinkedChildren, linkedChildren,
        library, itemCreation: library.itemCreation, findByPath, resolution, cohort });
    } catch (error) { failure = error; throw error; }
    finally {
      await cleanup(failure, [() => cohort?.release(), () => resolution.dispose(failure)]);
      assert.deepEqual(await tempNames(session), [], 'The exact owning connection has no remaining workspace TEMP rows.');
    }
  });
  try {
    await assert.rejects(resolve(root, () => { fallbackCalls++; throw new Error('Fallback must wait for complete hydration.'); }), error => error === hydrationFailure);
    assert.equal(pages, 2); assert.equal(fallbackCalls, 0);
    assert.equal((await rootLinks(fixture, root))[0].ItemId, null);
  } finally { library.load = nativeLoad; releaseNativeItemLinks(root); await linkedChildren.flushReleases(); }
  const next = await transientRoot(fixture, [{ ItemId: null, Path: definitions[0].Path }, { ItemId: null, Path: 'broken.mkv' }]);
  try {
    const first = await library.itemCreation.getItemById(id(1));
    await assert.rejects(resolve(next, async () => { if (++fallbackCalls === 1) return first; throw fallbackFailure; }), error => error === fallbackFailure);
    assert.equal(fallbackCalls, 2);
    assert.deepEqual((await rootLinks(fixture, next)).map(row => row.ItemId), [idKey(id(1)), null]);
  } finally { releaseNativeItemLinks(next); await linkedChildren.flushReleases(); }
  await store.run(async session => assert.deepEqual(await tempNames(session), []));
  assert.equal(BigInt((await fixture.database.client.query(`SELECT count(*) AS count FROM ${q(linkedChildren.schemaName)}.item_states`)).rows[0].count), 0n);
});

test('metadata links propagate a malformed legacy ID without erasing the successful live cache prefix', {
  skip: !postgresTestConnectionString, timeout: 180000,
}, async t => {
  const fixture = await setupChildrenFixture(t), { store, linkedChildren, database } = fixture;
  await fixture.seed({ target: 'member', items: [{ key: 'member', type: 'Movie', Id: id(1),
    Path: 'Z:\\ChildSelection\\member.mkv', Name: 'Stored member' }] });
  const root = await transientRoot(fixture, [
    { ItemId: null, LibraryItemId: id(1) }, { ItemId: null, LibraryItemId: 'invalid-guid' },
  ]);
  const before = await database.rows('LinkedChildren');
  try {
    await assert.rejects(createMetadataChildren(fixture).linked(root), { status: 500 });
    assert.deepEqual((await rootLinks(fixture, root)).map(row => row.ItemId), [idKey(id(1)), null]);
    await assert.rejects(createMetadataChildren(fixture).linked(root), { status: 500 });
    assert.deepEqual((await rootLinks(fixture, root)).map(row => row.ItemId), [idKey(id(1)), null]);
    assert.deepEqual(await database.rows('LinkedChildren'), before);
    await store.run(async session => assert.deepEqual(await tempNames(session), []));
    assert.equal(BigInt((await database.client.query(`SELECT count(*) AS count FROM ${q(linkedChildren.schemaName)}.item_states`)).rows[0].count), 0n);
  } finally { releaseNativeItemLinks(root); await linkedChildren.flushReleases(); }
});

test('workspace disposal drops owned SQL state, preserves transaction failure, and discards a real failed DROP connection', {
  skip: !postgresTestConnectionString, timeout: 180000,
}, async t => {
  const database = await createPostgresTestDatabase(t, 'linked_workspace');
  await database.withConnection(async session => {
    const workspace = await createPostgresLinkedResolutionWorkspace(session, { linksPlan: emptyPlan });
    assert.equal(await workspace.count(), 0); assert.equal((await tempNames(session)).length, 1);
    await assert.rejects(workspace.readLinksPage({ limit: 129 }), TypeError);
    await assert.rejects(workspace.initialSlot(id(1)), /fully captured/u);
    await workspace.dispose(); await workspace.dispose();
    assert.deepEqual(await tempNames(session), []); assert.throws(() => workspace.linksPlan(), /disposed/u);
  });
  await assert.rejects(database.transaction(async session => {
    const workspace = await createPostgresLinkedResolutionWorkspace(session, { linksPlan: emptyPlan });
    let failure;
    try { await session.client.query('SELECT missing_linked_workspace_column'); }
    catch (error) { failure = error; throw error; }
    finally { await workspace.dispose(failure); assert.equal(session.connectionReleaseError, null); }
  }), error => error.code === '42703');
  const dropFailure = Object.assign(new Error('Controlled owned DROP failure'), { code: 'XX000' });
  await database.withConnection(async session => {
    const workspace = await createPostgresLinkedResolutionWorkspace(session, { linksPlan: emptyPlan });
    const query = session.client.query.bind(session.client);
    session.client.query = async (...args) => {
      if (String(typeof args[0] === 'string' ? args[0] : args[0].text).startsWith('DROP TABLE IF EXISTS')) throw dropFailure;
      return query(...args);
    };
    try {
      await assert.rejects(workspace.dispose(), error => error === dropFailure);
      assert.equal(session.connectionReleaseError, dropFailure);
    } finally { session.client.query = query; }
  });
  await database.withConnection(async session => assert.deepEqual(await tempNames(session), []));
});
