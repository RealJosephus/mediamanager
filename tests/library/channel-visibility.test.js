import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { LibraryService } from '../../src/library/library-service.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { idKey, nonemptyId } from '../../src/library/records.js';
import { visibleItem } from '../../src/library/permissions.js';
import { loadPostgresItemGraph } from '../../src/library/postgres-library-query.js';
import { createPostgresRecordingQuery } from '../../src/library/postgres-live-tv-recordings-query.js';
import { testFileSystem } from '../storage/plugin-files.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres', 'nativeInstance'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const id = index => `a9400000-0000-0000-0000-${String(index).padStart(12, '0')}`;
const tables = ['BaseItems', 'AncestorIds', 'ItemValues', 'ItemValuesMap'];
const stable = rows => rows.map(row => JSON.stringify(row, (_key, value) => typeof value === 'bigint' ? String(value) : value)).sort();

function fixtureInput() {
  const item = (index, type, parent, extra = {}) => ({ id: id(index), type, name: type + ' ' + index,
    path: '{root}/media/' + index, ...(parent && { parentId: id(parent) }), ...extra });
  const video = (index, extra = {}) => item(index, 'Video', 3, {
    channelId: id(10), ancestors: [id(4)], dateCreated: `2025-01-01T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}Z`, ...extra,
  });
  const items = [
    item(1, 'AggregateFolder', null, { path: '{root}/aggregate' }), item(2, 'UserRootFolder', null, { path: '{root}/user' }),
    item(3, 'Folder', 1, { path: '{root}/media' }),
    item(4, 'CollectionFolder', 2, { physicalLocations: ['{root}/media'], path: '{root}/user/library' }),
    item(5, 'Folder', 3, { tags: ['parent-blocked'] }),
    item(10, 'Channel', 3), item(11, 'Channel', 3, { channelId: id(10) }),
    item(12, 'Channel', 3, { tags: ['root-blocked'] }), item(13, 'Folder', 3),
    video(20), video(21, { channelId: id(11) }), video(22, { channelId: id(999) }), video(23, { channelId: id(13) }),
    video(24, { channelId: '00000000-0000-0000-0000-000000000000' }),
    video(25, { parentId: id(5) }), video(26, { channelId: id(12) }),
    item(30, 'LiveTvChannel', 3, { channelId: id(10) }),
    item(31, 'LiveTvProgram', 3, { channelId: id(10) }), item(32, 'LiveTvProgram', 5, { channelId: id(10) }),
    item(33, 'Video', 3, { ancestors: [id(4)], dateCreated: '2025-01-01T00:00:33Z' }),
    item(40, 'Movie', 3, { channelId: id(10), ancestors: [id(4)], dateCreated: '2025-01-01T00:00:40Z' }),
    ...Array.from({ length: 133 }, (_, index) => video(100 + index, { tags: [index % 3 ? 'allowed' : 'blocked'] })),
  ];
  const defaults = { EnableAllFolders: true, EnableAllChannels: true, EnableLiveTvAccess: false,
    EnabledFolders: [], BlockedMediaFolders: [], EnabledChannels: [], BlockedChannels: [], BlockedTags: [], AllowedTags: [], BlockUnratedItems: [] };
  const policy = (name, values = {}) => ({ name, policy: { ...defaults, ...values } });
  return { schemaVersion: 1, userId: id(900), collectionId: id(4), items,
    policies: [policy('all'), policy('no channels', { EnableAllChannels: false }),
      policy('selected channel and denied library', { EnableAllChannels: false, EnabledChannels: [id(10)], EnableAllFolders: false, BlockedMediaFolders: [id(4)] }),
      policy('blocked overrides all', { BlockedChannels: [id(10)] }),
      policy('unrelated blocked overrides empty enabled', { EnableAllChannels: false, BlockedChannels: [id(999)] }),
      policy('blocked parent and root tags', { BlockedTags: ['PARENT-BLOCKED', 'ROOT-BLOCKED'] }),
      policy('SQL blocked tags', { BlockedTags: ['BLOCKED'] }), policy('SQL allowed tags', { AllowedTags: ['ALLOWED'] }),
      policy('unrated channel content', { BlockUnratedItems: ['ChannelContent'] }),
      policy('unrated LiveTv', { BlockUnratedItems: ['LiveTvChannel', 'LiveTvProgram'] }),
    ], queries: [{ name: 'all', startIndex: 0, limit: 200 }, { name: 'first page', startIndex: 0, limit: 7 },
      { name: 'offset page', startIndex: 7, limit: 9 }, { name: '128 boundary', startIndex: 128, limit: 12 }],
  };
}

function observe(action) {
  try { return { value: action(), failed: false }; }
  catch (error) {
    if (error.status === 400 || error.status === 500) return { value: null, failed: true,
      error: { status: error.status, name: error.name, message: error.message } };
    throw error;
  }
}
const outcome = observation => ({ value: observation.value, failed: observation.failed ?? Boolean(observation.errorType) });

test('Channel and LiveTv visibility match actual native entities, one-hop channel lookup and PostgreSQL recording count/page', {
  timeout: 300000,
}, async t => {
  const startedAt = performance.now();
  const progress = (phase, details = {}) => {
    t.diagnostic(JSON.stringify({ phase, utc: new Date().toISOString(), elapsedMs: performance.now() - startedAt, ...details }));
    t.signal.throwIfAborted();
  };
  const input = fixtureInput(), inputBytes = Buffer.from(JSON.stringify(input));
  const output = path.join(validationOutputRoot(), 'channel-visibility-' + randomUUID()); await mkdir(output);
  const inputFilename = path.join(output, 'input.json'); await writeFile(inputFilename, inputBytes, { flag: 'wx' });
  const privateRoot = path.join(output, 'private-native');
  const report = { comparisons: [], queries: [], queryCosts: [], selectorCosts: [], explainPlans: [], cleanup: {}, evidenceScope: 'Actual repository-hydrated entity visibility, actual ChannelManager one-hop lookup and actual native EF selector versus PG; not HTTP authorization or playback.' };
  let current, source, database, store, linkedChildren, library, failure;
  const recentSlowReads = new WeakMap(), explained = new Set(), slowQueryThresholdMs = 1000;
  report.queryTimingPolicy = { clock: 'performance.now', slowQueryThresholdMs,
    costScopes: { queryCosts: 'Public recording DTO reader', selectorCosts: 'Direct recording selector reader' },
    recentSlowReadParameters: 'Only the latest successful slow read is retained in memory per active operation session.',
    explainAnalyze: 'Before the next SQL dispatch after the original test deadline has actually expired: replay the latest successful slow read from the current case once per SQL hash through the same still-owned physical session. CREATE TEMP TABLE AS replays only its read projection.' };
  const readProjection = text => {
    const statement = text.replace(/^\s*\/\*[\s\S]*?\*\//u, '').trimStart();
    const read = statement.replace(/^CREATE TEMP TABLE "mm_recordings_[0-9a-f]+" AS\s+/u, '');
    // Restrict diagnostics to known generated reads; WITH alone does not imply
    // a read-only statement and generic SELECTs can acquire advisory locks.
    const knownRead = read !== statement || /^WITH RECURSIVE (?:native_visibility_input\(|requested AS \()/u.test(read)
      || /^\/\* page-relationship-graph \*\//u.test(text);
    return knownRead ? { readText: read, readProjectionOnly: read !== statement } : null;
  };
  const observeRecordings = async (sample, request, expected, stage, operation) => {
    const query = database.client.query, started = performance.now();
    const cost = { policy: sample.name, query: request.name, stage, selectedRows: expected.ids.length, sqlQueries: 0, slowest: [] };
    database.client.query = async function observeRecordingRead(...args) {
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
      const values = typeof args[0] === 'string' ? args[1] : args[0]?.values;
      const session = database.root.operationContext.getStore();
      cost.sqlQueries++;
      try {
        const recent = session?.connectionActive ? recentSlowReads.get(session) : undefined;
        const explainKey = recent ? sample.name + '\0' + request.name + '\0' + recent.sqlSha256 : null;
        if (t.signal.aborted && recent?.policy === sample.name && recent.query === request.name && !explained.has(explainKey)) {
          explained.add(explainKey);
          const capture = { policy: recent.policy, query: recent.query, stage: recent.stage, ordinal: recent.ordinal,
            sqlSha256: recent.sqlSha256, sql: recent.sql, readText: recent.readText, readProjectionOnly: recent.readProjectionOnly,
            parameterCount: recent.values?.length ?? 0, observedDurationMs: recent.durationMs,
            observedFinishedAt: recent.finishedAt, beforeDispatchOrdinal: cost.sqlQueries,
            startedAt: new Date().toISOString() };
          report.explainPlans.push(capture);
          const explainedAt = performance.now();
          try {
            const result = await session.client.physicalClient.query({
              text: 'EXPLAIN (ANALYZE, BUFFERS, TIMING TRUE, SETTINGS, FORMAT JSON) ' + recent.readText, values: recent.values });
            capture.plan = result.rows[0]['QUERY PLAN'];
          } catch (error) { capture.error = { code: error.code, message: error.message, stack: error.stack }; }
          finally { capture.durationMs = performance.now() - explainedAt; capture.finishedAt = new Date().toISOString(); }
        }
        const dispatched = performance.now();
        const result = await query.apply(this, args);
        const durationMs = performance.now() - dispatched, sqlSha256 = hash(sql);
        cost.slowest.push({ sqlSha256, label: sql.match(/\/\*\s*([^*\r\n]+)\s*\*\//u)?.[1]?.trim()
          ?? sql.trimStart().split(/\s/u, 1)[0], durationMs, rows: result.rows?.length });
        cost.slowest.sort((left, right) => right.durationMs - left.durationMs); cost.slowest.length = Math.min(cost.slowest.length, 3);
        if (session?.connectionActive && durationMs >= slowQueryThresholdMs) {
          const projection = readProjection(sql);
          if (projection) recentSlowReads.set(session, { policy: sample.name, query: request.name, stage, ordinal: cost.sqlQueries,
            sqlSha256, sql, ...projection, values, durationMs, finishedAt: new Date().toISOString() });
        }
        return result;
      } catch (error) { cost.failure = { code: error.code, message: error.message }; throw error; }
    };
    try { return await operation(); }
    finally {
      database.client.query = query; cost.durationMs = performance.now() - started;
      (stage === 'selector' ? report.selectorCosts : report.queryCosts).push(cost);
    }
  };
  try {
    progress('native-inputs-entered');
    current = await currentNativeReference(); report.preparation = current.preparation;
    report.sourceBindings = await current.sourceBindings(['MediaBrowser.Controller/Entities/BaseItem.cs', 'MediaBrowser.Controller/Channels/Channel.cs',
      'MediaBrowser.Controller/LiveTv/LiveTvChannel.cs', 'MediaBrowser.Controller/LiveTv/LiveTvProgram.cs',
      'MediaBrowser.Controller/Library/LibraryManagerExtensions.cs', 'src/Jellyfin.LiveTv/Channels/ChannelManager.cs',
      'Emby.Server.Implementations/Library/LibraryManager.cs', 'Jellyfin.Server.Implementations/Item/BaseItemRepository.cs',
      'Jellyfin.Server.Implementations/Item/BaseItemRepository.QueryBuilding.cs', 'Jellyfin.Server.Implementations/Item/BaseItemRepository.Querying.cs',
      'Jellyfin.Server.Implementations/Item/BaseItemRepository.TranslateQuery.cs']);
    progress('native-oracle-entered');
    const receipt = await recordOracle({ project: 'tests/library/fixtures/channel-visibility/Oracle.csproj', output: path.join(output, 'native'),
      args: [inputFilename, '{output}/native.json', privateRoot, current.sourceDatabase] });
    progress('native-oracle-returned');
    const nativeBytes = await readFile(path.join(output, 'native/native.json')), native = JSON.parse(nativeBytes);
    assert.ok(receipt.passed && native.actualBaseItemVisibility && native.actualChannelManagerAndLibraryManager && native.actualEfRepositoryCountAndPage);
    assert.equal(native.repositoryHydratedEntities, true); assert.equal(native.recordingExecutorsStarted, false);
    assert.equal(native.inputSha256, hash(inputBytes));
    assert.equal(receipt.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, hash(nativeBytes));
    for (const image of [...native.assemblies, ...native.nativeLibraries]) assert.equal(hash(await readFile(image.filename)), image.sha256);
    assert.equal(native.nativeLibraries[0].requiredPackagedImage, true);
    assert.equal(native.databasePreparation.originalHash, hash(await readFile(current.sourceDatabase)));
    assert.equal(native.databasePreparation.copiedHash, native.databasePreparation.originalHash);
    assert.equal(native.databasePreparation.retainedSchemaAndMigrationHistory, true);
    assert.equal(native.databasePreparation.schemaCreated, false); assert.equal(native.databasePreparation.migrationsApplied, false);
    report.databasePreparation = native.databasePreparation;
    const nativeCase = (policy, index) => native.results.find(row => row.policy === policy && row.id === idKey(id(index)));
    assert.equal(nativeCase('all', 20).standalone.value, true);
    assert.equal(nativeCase('all', 11).standalone.value, true, 'The linked root is checked with IsVisible, without a second standalone lookup.');
    assert.deepEqual(outcome(nativeCase('all', 10).standalone), { value: null, failed: true });
    for (const index of [22, 23]) assert.deepEqual(outcome(nativeCase('all', index).standalone), { value: null, failed: true });
    assert.equal(nativeCase('no channels', 20).visible.value, true);
    assert.equal(nativeCase('no channels', 20).standalone.value, false);
    assert.equal(nativeCase('no channels', 30).standalone.value, true, 'Live TV does not use Channel or LiveTvAccess entity gates.');
    assert.equal(nativeCase('selected channel and denied library', 20).standalone.value, true);
    assert.equal(nativeCase('selected channel and denied library', 30).standalone.value, false);
    assert.equal(nativeCase('unrelated blocked overrides empty enabled', 20).standalone.value, true);
    assert.equal(nativeCase('blocked overrides all', 20).standalone.value, false);
    assert.equal(nativeCase('unrated channel content', 20).visible.value, false);
    assert.equal(nativeCase('unrated channel content', 40).visible.value, true, 'Movie retains its overridden unrated category.');
    for (const index of [30, 31]) assert.equal(nativeCase('unrated LiveTv', index).visible.value, false);
    const allCount = native.queries.find(row => row.policy === 'all' && row.name === 'all').total;
    assert.ok(native.queries.find(row => row.policy === 'SQL blocked tags' && row.name === 'all').total < allCount);
    assert.ok(native.queries.find(row => row.policy === 'SQL allowed tags' && row.name === 'all').total < allCount);
    progress('postgres-entered');
    database = await createPostgresTestDatabase(null, 'channel_access'); store = new DomainStore(database);
    linkedChildren = new PostgresLinkedChildrenStore({ database }); await linkedChildren.initialize();
    source = new SqliteDatabase(native.databaseFilename, { readOnly: true, requireMigrationHistory: true });
    const rows = Object.fromEntries(tables.map(table => [table, source.rows(table)])); source.close(); source = null;
    for (const table of tables) for (const row of rows[table]) await database.insert(table, row);
    const baseline = Object.fromEntries(await Promise.all(tables.map(async table => [table, stable(await database.rows(table))])));
    library = new LibraryService({ store, linkedChildren, fileSystem: testFileSystem, userRoot: rows.BaseItems.find(row => idKey(row.Id) === idKey(id(2))),
      serverId: 'channel-visibility-component', configuration: {} });
    const state = await library.load(database, null, { baseRows: rows.BaseItems });
    progress('postgres-ready');
    try {
      for (const sample of input.policies) {
        progress('policy-entered', { policy: sample.name });
        const user = { Id: input.userId, Policy: sample.policy };
        for (const expected of native.results.filter(row => row.policy === sample.name)) {
          const item = state.byId.get(expected.id); assert.ok(item);
          const actual = { sourceType: item.SourceType, visible: observe(() => visibleItem(item, user, state, { query: false, checkStandaloneParents: false })),
            standalone: observe(() => visibleItem(item, user, state, { query: false })) };
          report.comparisons.push({ policy: sample.name, id: expected.id, actual, expected });
          assert.deepEqual({ sourceType: actual.sourceType, visible: outcome(actual.visible), standalone: outcome(actual.standalone) },
            { sourceType: expected.sourceType, visible: outcome(expected.visible), standalone: outcome(expected.standalone) }, sample.name + ' ' + expected.id);
          if (actual.standalone.failed) {
            const inputItem = input.items.find(item => idKey(item.id) === expected.id);
            assert.equal(actual.standalone.error.status, nonemptyId(inputItem.channelId) ? 500 : 400);
          }
        }
        // The real public library reader loads only the item's finite graph.
        // A missing linked channel must fail; a denied item returns 404 before
        // a malformed later channel reference can be touched.
        for (const index of [10, 11, 20, 21, 22, 23, 24, 25, 26, 30, 31, 32, 33, 40]) {
          const expected = native.results.find(row => row.policy === sample.name && row.id === idKey(id(index))).standalone;
          if (expected.errorType) {
            const inputItem = input.items.find(item => item.id === id(index));
            await assert.rejects(library.getItemRecord(id(index), { user }), { status: nonemptyId(inputItem.channelId) ? 500 : 400 });
          }
          else if (!expected.value) await assert.rejects(library.getItemRecord(id(index), { user }), { status: 404 });
          else assert.equal(idKey((await library.getItemRecord(id(index), { user })).Id), idKey(id(index)));
        }
        const visibility = { blockedTags: sample.policy.BlockedTags, allowedTags: sample.policy.AllowedTags, blockUnratedTypes: sample.policy.BlockUnratedItems };
        for (const request of input.queries) {
          progress('recording-query-entered', { policy: sample.name, query: request.name });
          const expected = native.queries.find(row => row.policy === sample.name && row.name === request.name);
          const actual = await observeRecordings(sample, request, expected, 'selector', () => store.run(async db => {
            const owner = await createPostgresRecordingQuery(db, { startindex: request.startIndex, limit: request.limit },
              { folderIds: [input.collectionId], userId: user.Id, visibility });
            try {
              const selected = [];
              for (let offset = 0; ; offset += 128) {
                const page = await owner.page({ offset, limit: 128 }); selected.push(...page.rows);
                if (page.rows.length < 128) break;
              }
              return { ids: selected.map(row => idKey(row.Id)), total: owner.total,
                visibleIds: selected.map(row => state.byId.get(idKey(row.Id)))
                  .filter(item => visibleItem(item, user, state, { query: false, checkStandaloneParents: false })).map(item => idKey(item.Id)) };
            } finally { await owner.close(); }
          }));
          report.queries.push({ policy: sample.name, name: request.name, actual, expected });
          assert.deepEqual(actual, { ids: expected.ids, total: expected.total, visibleIds: expected.visibleIds }, sample.name + ' ' + request.name);
          progress('recording-selector-returned', { policy: sample.name, query: request.name });
          const projected = await observeRecordings(sample, request, expected, 'dto', () =>
            library.queryLiveTvRecordings({ startindex: request.startIndex, limit: request.limit }, { user, folderIds: [input.collectionId] }));
          assert.deepEqual({ ids: projected.Items.map(item => idKey(item.Id)), total: projected.TotalRecordCount },
            { ids: expected.visibleIds, total: expected.total }, sample.name + ' DTO ' + request.name);
          progress('recording-query-returned', { policy: sample.name, query: request.name });
        }
        progress('policy-returned', { policy: sample.name });
      }
    } finally { await state.dispose(); }
    const graph = await loadPostgresItemGraph(database, [id(21)]);
    assert.ok(graph.some(row => idKey(row.Id) === idKey(id(11))), 'Selected source loads its linked Channel.');
    assert.ok(!graph.some(row => idKey(row.Id) === idKey(id(10))), 'Linked Channel visibility does not recurse into its own ChannelId.');
    assert.ok(graph.length < input.items.length / 4, 'Visibility does not load unrelated source media.');
    report.relationshipGraph = { ids: graph.map(row => idKey(row.Id)), bounded: true, channelLookupDepth: 1 };
    assert.ok(native.queries.some(row => row.name === 'all' && row.ids.length > 128));
    assert.deepEqual(Object.fromEntries(await Promise.all(tables.map(async table => [table, stable(await database.rows(table))]))), baseline);
  } catch (error) { failure = error; }
  finally {
    const errors = [];
    for (const [name, action] of [['sourceClosed', () => source?.close()], ['libraryClosed', () => library?.close()],
      ['relationsClosed', () => linkedChildren?.close()], ['storeClosed', () => store?.close()],
      ['postgresRemoved', () => dropPostgresTestDatabase(database)], ['protectedInputsUnchanged', () => current?.finish()],
      ['privateNativeRemoved', async () => { assert.equal(path.resolve(privateRoot), path.join(path.resolve(output), 'private-native'));
        assert.equal(path.dirname(privateRoot), output); assert.equal(path.basename(privateRoot), 'private-native');
        await rm(privateRoot, { recursive: true, force: true }); }]]) {
      try { await action(); report.cleanup[name] = true; } catch (error) { errors.push(error); report.cleanup[name] = false; }
    }
    if (t.signal.aborted && !failure) failure = t.signal.reason;
    t.diagnostic(JSON.stringify({ phase: 'cleanup-returned', utc: new Date().toISOString(),
      elapsedMs: performance.now() - startedAt, cancelled: t.signal.aborted, cleanup: report.cleanup }));
    await writeFile(path.join(output, 'comparison.json'), JSON.stringify({ ...report, passed: !failure && !errors.length,
      phaseAcceptance: false, releaseAcceptance: false, error: failure?.stack, cleanupErrors: errors.map(error => error.stack) }, null, 2) + '\n');
    if (!failure && errors.length) failure = new AggregateError(errors, 'Channel visibility cleanup failed.');
  }
  if (failure) throw failure;
});
