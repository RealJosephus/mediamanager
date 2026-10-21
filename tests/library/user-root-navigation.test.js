import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { stringifyNativeJson } from '../../src/core/json.js';
import { prepareUserRootNavigation } from '../../src/library/user-root-navigation.js';
import { isNativeItemEntity } from '../../src/library/native-item-entity.js';
import { dtoOptions, projectItem } from '../../src/library/dto.js';
import { idKey } from '../../src/library/records.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { postgresTestConnectionString } from '../database/postgres-fixture.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';

export const requiredValidationServices = ['postgres'];
// Actual native GetChildren/DTO observations are in the independent root oracle.
// This component executes PostgreSQL, the real resolver/cohort/entity/DTO path,
// with an explicitly controlled all-visible per-occurrence filter below.
export const sourceBindings = Object.freeze([
  { path: 'MediaBrowser.Controller/Entities/Folder.cs', consumer: 'GetChildren materializes links before visibility and keeps first Guid position with the last passing object' },
  { path: 'MediaBrowser.Controller/Entities/UserRootFolder.cs', consumer: 'GetEligibleChildren combines raw and virtual children before linked resolution' },
  { path: 'Jellyfin.Api/Controllers/ItemsController.cs', consumer: 'GetItems plain UserRoot returns the complete GetChildren result to GetBaseItemDtos' },
  { path: 'Emby.Server.Implementations/Dto/DtoService.cs', consumer: 'GetBaseItemDtos reads the returned live entity rather than reloading its repository identity' },
]);
const id = value => `9f730000-0000-0000-0000-${String(value).padStart(12, '0')}`;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const errorInfo = error => ({ name: error.name, message: error.message, code: error.code ?? null });
async function releaseAll(primary, operations) {
  const failures = [];
  for (const operation of operations) try { await operation(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(primary ? [primary, ...failures] : failures,
    primary?.message ?? 'User-root component cleanup failed.', primary ? { cause: primary } : undefined);
}

test('root winner SQL survives its preparation session and projects unsaved full typed values in bounded owned callbacks', {
  skip: !postgresTestConnectionString, timeout: 180000,
}, async t => {
  const fixture = await setupChildrenFixture(t), { library, store, database, linkedChildren } = fixture;
  const output = path.join(validationOutputRoot(), 'user-root-navigation-' + randomUUID());
  await mkdir(output, { recursive: true });
  const report = { schemaVersion: 1, nativeExecutedByThisTest: false, phaseAcceptance: false, releaseAcceptance: false,
    sourceBindings, hydrationPages: [], visibilityPages: [], typedPages: [], cleanup: {} };
  const definitions = Array.from({ length: 131 }, (_, index) => ({ key: 'positive-' + index, type: 'Movie',
    Id: id(100 + index), Path: `Z:\\ChildSelection\\positive-${index}.mkv`, Name: 'Stored ' + index,
    Overview: 'Stored overview ' + index }));
  const rootDefinition = { key: 'root', type: 'UserRootFolder', Id: id(1), IsRoot: true,
    Path: 'Z:\\ChildSelection\\user-root', links: [...definitions.map(item => item.key), 'positive-0'] };
  await fixture.seed({ target: 'root', items: [rootDefinition,
    { key: 'folder', type: 'Folder', Id: id(2), Path: 'Z:\\ChildSelection\\exact-folder', Name: 'Exact Folder' },
    { key: 'rich', type: 'Movie', Id: id(500), Path: 'Z:\\ChildSelection\\unsaved.mkv', Name: 'Persisted rich' },
    ...definitions] });
  // This component seeds an explicit designated root identity. Configure that
  // persisted row before ItemCreation's first load; the fixture's ordinary
  // program-data root would otherwise derive a different transient UserRoot.
  library.options.userRoot = (await database.rows('BaseItems', { where: { Id: id(1) } }))[0];
  const originalLoad = library.load, proceed = deferred();
  let frame, oldSession, rootOwner, folderOwner, richOwner, wrongOwner, held, failure;
  try {
    const liveRoot = await library.itemCreation.getItemById(id(1));
    rootOwner = library.itemCreation.retainItem(liveRoot);
    const exactFolder = await library.itemCreation.getItemById(id(2));
    folderOwner = library.itemCreation.retainItem(exactFolder);
    const rich = await library.itemCreation.getItemById(id(500));
    richOwner = library.itemCreation.retainItem(rich);
    Object.assign(rich, { Name: 'Unsaved rich', Overview: 'Unsaved overview', Genres: ['Unsaved genre'],
      Tags: ['unsaved tag'], Tagline: 'Unsaved tagline', ProviderIds: { Tmdb: 'unsaved-provider' } });
    const wrongSameId = await library.itemCreation.getItemById(id(100));
    wrongOwner = library.itemCreation.retainItem(wrongSameId);
    wrongSameId.Name = 'Unrelated registered same-ID value';
    wrongSameId.Overview = 'Must lose to the positive repository slot';
    const before = await database.rows('BaseItems', { orderBy: [{ column: 'Id', direction: 'ASC' }] });
    library.load = async function (...args) {
      if (args[2]?.includeFolderLinks && args[2]?.baseRows?.length) report.hydrationPages.push(args[2].baseRows.length);
      return originalLoad.apply(this, args);
    };
    await store.run(async session => {
      oldSession = session;
      const state = await library.load(session, null, { baseRows: await session.rows('BaseItems', { where: { Id: id(1) } }),
        includeUserData: false, includeFolderLinks: false, includeLinkGraph: false });
      try {
        assert.equal(idKey(state.userRootId), idKey(liveRoot.Id));
        assert.equal(state.liveUserRoot, liveRoot);
        frame = await prepareUserRootNavigation({ library, session, state, user: null,
          initialItems: () => [wrongSameId, rich, exactFolder],
          filterPage(items, context) {
            assert.ok(items.length > 0 && items.length <= 128);
            report.visibilityPages.push({ source: context.source, count: items.length });
            return items.map(() => true);
          } });
        const remaining = (await session.client.query(`SELECT count(*)::integer AS count FROM pg_catalog.pg_class
          WHERE relnamespace=pg_catalog.pg_my_temp_schema() AND relname LIKE 'mm_user_root_winners_%'`)).rows[0].count;
        assert.equal(remaining, 0, 'The winning TEMP selection must be dropped before its operation session returns.');
        report.cleanup.preparationTempDropped = true;
      } finally { await state.dispose({ session }); }
    });
    library.load = originalLoad;
    assert.equal(oldSession.connectionActive, false, 'Typed consumption must occur after the original checked-out connection returned.');
    assert.equal(oldSession.connectionReleaseError, null);
    report.preparationSessionReturned = true;
    assert.deepEqual(report.hydrationPages, [128, 3], 'The complete positive-ID repository batch is hydrated in bounded pages.');
    assert.deepEqual(await database.rows('BaseItems', { orderBy: [{ column: 'Id', direction: 'ASC' }] }), before,
      'Unsaved root values and typed snapshots cannot save business rows.');
    assert.equal(frame.items.length, 133);
    assert.equal(frame.items[2], exactFolder);
    assert.equal(isNativeItemEntity(frame.items[1]), false);
    assert.equal(Object.hasOwn(frame.items[1], 'Overview'), false, 'Navigation keeps only scalar non-Folder projections.');
    assert.throws(() => frame.withPage({ limit: 129 }, () => {}), TypeError);
    assert.throws(() => frame.withPage({ after: 0 }, () => {}), TypeError);
    // Remove every candidate from the actual bounded registry. Folder ownership
    // must still return its exact object; media must restore the captured slot.
    for (const item of [exactFolder, rich, wrongSameId]) library.itemCreation.unregisterItem(item.Id);
    rich.Name = 'Unsaved after preparation'; rich.Overview = 'Unsaved after preparation overview';
    rich.ProviderIds.Tmdb = 'observed-provider';
    await database.update('BaseItems', { Id: id(100) }, { Name: 'Database changed after capture', Overview: 'New persisted overview' });
    const plan = frame.orderedPlan();
    assert.equal(plan.text.includes('mm_user_root_winners_'), false, 'The exported plan can reference only the retained owned winner relation.');
    const losing = (await database.client.query({ text: `SELECT state.slot_id::text AS slot
      FROM ${q(linkedChildren.schemaName)}.item_states state
      WHERE state.scope_id=(SELECT scope_id FROM ${q(linkedChildren.schemaName)}.item_cohorts WHERE view_id=$1 LIMIT 1)
        AND NOT EXISTS(SELECT 1 FROM (${plan.text}) winner WHERE winner."SlotKey"=state.slot_id) LIMIT 1`,
      values: plan.values })).rows[0];
    assert.ok(losing, 'The overwritten initial same-GUID occurrence remains a nonwinner slot.');
    await assert.rejects(frame.withSlot(losing.slot, () => assert.fail('A nonwinner cannot reach the typed callback.')),
      { message: 'The slot is not a winner in this user-root frame.' });
    const seen = [], slots = new Map();
    let cursor = 0n;
    for (;;) {
      let empty;
      cursor = await frame.withPage({ after: cursor }, async ({ entries, after }) => {
        empty = entries.length === 0;
        report.typedPages.push(entries.length);
        assert.ok(entries.length <= 128);
        for (const { ordinal, slot, item } of entries) {
          assert.equal(typeof ordinal, 'bigint'); assert.equal(isNativeItemEntity(item), true);
          seen.push({ id: idKey(item.Id), name: item.Name }); slots.set(idKey(item.Id), slot);
          if (idKey(item.Id) === idKey(id(2))) assert.equal(item, exactFolder);
          if (idKey(item.Id) === idKey(id(500))) {
            assert.equal(item.Overview, 'Unsaved after preparation overview');
            assert.deepEqual(item.Genres, ['Unsaved genre']);
            assert.deepEqual(item.Tags, ['unsaved tag']);
            await store.run(async session => {
              const state = await library.load(session, null, { baseRows: await session.rows('BaseItems', { where: { Id: item.Id } }),
                includeUserData: false, includeFolderLinks: false, includeLinkGraph: false });
              try {
                library.adoptLiveItem(state, item);
                const dto = await projectItem(item, state, null, dtoOptions({ fields: ['Overview', 'Genres', 'Tags', 'Taglines', 'ProviderIds'],
                  enableimages: false, enableuserdata: false }), library.options);
                assert.equal(dto.Name, 'Unsaved after preparation');
                assert.equal(dto.Overview, 'Unsaved after preparation overview');
                assert.deepEqual(dto.Genres, ['Unsaved genre']); assert.deepEqual(dto.Tags, ['unsaved tag']);
                assert.deepEqual(dto.Taglines, ['Unsaved tagline']); assert.equal(dto.ProviderIds.get('Tmdb'), 'observed-provider');
                report.unsavedDto = { Name: dto.Name, Overview: dto.Overview, Genres: dto.Genres, Tags: dto.Tags,
                  Taglines: dto.Taglines, ProviderIds: Object.fromEntries(dto.ProviderIds) };
              } finally { await state.dispose({ session }); }
            });
          }
        }
        return after;
      });
      if (empty) break;
    }
    assert.deepEqual(report.typedPages, [128, 5, 0]);
    assert.deepEqual(seen.map(item => item.id), [id(100), id(500), id(2), ...definitions.slice(1).map(item => item.Id)].map(idKey));
    assert.equal(seen[0].name, 'Stored 0', 'The last positive repository occurrence wins without moving the first same-GUID position.');
    assert.equal(cursor, 134n, 'Empty pages retain the last bigint ordinal and terminate without a replacement cursor.');
    await frame.withSlot(slots.get(idKey(id(100))), item => {
      assert.notEqual(item, wrongSameId); assert.equal(item.Name, 'Stored 0');
      assert.equal(item.Overview, 'Stored overview 0'); item.Overview = 'Mutation in the winner slot callback';
    });
    await frame.withSlot(slots.get(idKey(id(100))), item => assert.equal(item.Overview, 'Mutation in the winner slot callback'));
    const callbackFailure = new Error('Controlled typed DTO consumer failure');
    await assert.rejects(frame.withPage({ limit: 3 }, () => { throw callbackFailure; }), error => error === callbackFailure);
    report.failedCallbackPreserved = true;
    await frame.withSlot(slots.get(idKey(id(2))).toUpperCase(), item => assert.equal(item, exactFolder));
    await Promise.all(Array.from({ length: 8 }, (_, index) => index % 2
      ? frame.withSlot(slots.get(idKey(id(2))), item => assert.equal(item, exactFolder))
      : frame.withSlot(slots.get(idKey(id(100))), item => assert.equal(item.Overview, 'Mutation in the winner slot callback'))));
    const entered = deferred();
    held = frame.withPage({ limit: 3 }, async ({ entries }) => {
      assert.equal(entries[2].item, exactFolder); entered.resolve(); await proceed.promise;
      assert.equal(entries[0].item.Overview, 'Mutation in the winner slot callback');
      assert.equal(entries[1].item.ProviderIds.Tmdb, 'observed-provider');
      return entries.length;
    });
    await entered.promise;
    let closed = false;
    const closing = frame.close().then(() => { closed = true; });
    assert.throws(() => frame.withPage({}, () => {}), { message: 'The user-root navigation frame has been closed.' });
    assert.throws(() => frame.withSlot(slots.get(idKey(id(100))), () => {}), { message: 'The user-root navigation frame has been closed.' });
    assert.throws(() => frame.orderedPlan(), { message: 'The user-root navigation frame has been closed.' });
    assert.equal(closed, false);
    const during = (await database.client.query(`SELECT count(*)::integer AS count FROM ${q(linkedChildren.schemaName)}.item_states`)).rows[0].count;
    assert.ok(during >= 133, 'Pending typed consumers retain their SQL snapshots and all active entity owners.');
    proceed.resolve(); assert.equal(await held, 3); await closing;
    assert.equal(closed, true); report.heldClose = { rejectedNewWork: true, retainedStatesDuringCallback: during, drained: true };
    frame = null;
  } catch (error) { failure = error; throw error; }
  finally {
    library.load = originalLoad; proceed.resolve();
    await releaseAll(failure, [() => held?.catch(() => {}), () => frame?.close(failure),
      () => wrongOwner?.release(), () => richOwner?.release(), () => folderOwner?.release(), () => rootOwner?.release(),
      () => linkedChildren.flushReleases(), async () => {
        const counts = (await database.client.query(`SELECT
          (SELECT count(*)::integer FROM ${q(linkedChildren.schemaName)}.item_states) AS states,
          (SELECT count(*)::integer FROM ${q(linkedChildren.schemaName)}.item_cohorts) AS cohorts,
          (SELECT count(*)::integer FROM ${q(linkedChildren.schemaName)}.pins) AS pins`)).rows[0];
        report.cleanup.retainedSqlCounts = counts; assert.deepEqual(counts, { states: 0, cohorts: 0, pins: 0 });
      }, async () => {
        report.error = failure ? errorInfo(failure) : null;
        await writeFile(path.join(output, 'report.json'), stringifyNativeJson(report) + '\n');
      }]);
  }
});
