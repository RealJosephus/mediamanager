import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { buildPostgresItemPageQuery, queryPostgresItemPage } from '../../src/database/postgres-item-query.js';
import { postgresRuntimeIndexNames } from '../../src/database/postgres-runtime-schema.js';
import { transferDatabase, exportCurrentSqlite } from '../../src/migration/database-transfer.js';
import { nativeGuid } from '../../src/users/native.js';
import { dateTicks } from '../../src/library/records.js';
import { currentNativeSqliteInputs } from '../../tools/validation/current-native-sqlite-inputs.js';
import { compileOracle } from '../../tools/validation/oracle.js';
import { createPrivateFilterOutput } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { orderedExchangeSnapshot } from '../helpers/ordered-exchange-snapshot.js';
import { assertRemoved, idKey, itemSnapshot, sha, stoppedDatabase } from '../helpers/library-exchange-state.js';
import { observeDatabaseMetrics } from './fixtures/large-catalog-exchange/database-metrics.js';

export const requiredValidationServices = ['postgres', 'currentNativeSqlite', 'dotnet', 'jellyfinDll'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE
  && process.env.MEDIAMANAGER_JELLYFIN_DLL);
const inputBytes = await readFile(new URL('./fixtures/large-catalog-exchange/input.json', import.meta.url));
const input = JSON.parse(inputBytes);
assert.equal(input.items, 100000);
const Id = ordinal => nativeGuid(input.idPrefix + String(ordinal).padStart(12, '0'));
const ticksBase = BigInt(input.ticksBase);
const failureObservation = error => ({ name: error?.name, message: error?.message, stack: error?.stack, code: error?.code });
const dataDigest = count => {
  const hash = createHash('sha256');
  for (let index = 0; index < count; index++) hash.update(input.data);
  return hash.digest('hex');
};
const nativePage = rows => rows.map(row => ({ id: nativeGuid(row.Id), Name: row.Name, SortName: row.SortName,
  ProductionYear: row.ProductionYear, runTimeTicks: row.RunTimeTicks?.toString() ?? null }));

test('100000 actual Native model items retain bounded PG selection and complete values through Node mutations, Native continuation and fresh PG', {
  skip: !enabled, timeout: 900000,
}, async t => {
  const destination = path.join(validationOutputRoot(), 'large-catalog-exchange-' + randomUUID());
  const output = await createPrivateFilterOutput(destination); output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  await mkdir(output.root);
  const root = await realpath(output.root), mediaRoot = path.join(root, 'catalog-media'); await mkdir(mediaRoot);
  const sourceFilename = path.join(root, 'native-source.db'), exported = path.join(root, 'node-export.db');
  const report = { schemaVersion: 1, scope: input.scope, inputSha256: sha(inputBytes), stages: [], snapshots: {},
    queries: [], native: {}, cleanup: {}, productionScaleVerified: false, completeLibraryVerified: false,
    fullInstanceVerified: false, phaseAcceptance: false, releaseAcceptance: false };
  const metrics = observeDatabaseMetrics();
  report.databaseMetrics = { inclusiveCallDurations: true, diagnosticOnly: true, calls: metrics.records };
  let source, database, fresh, supplied, failed = false, failure;
  const stage = async (name, operation) => {
    const observation = { name, startedAt: new Date().toISOString() }; report.stages.push(observation);
    const started = performance.now(), cpu = process.cpuUsage();
    observation.resourcesBefore = process.resourceUsage(); observation.memoryBefore = process.memoryUsage();
    metrics.setPhase(name);
    try {
      t.signal.throwIfAborted();
      const result = await operation();
      t.signal.throwIfAborted();
      observation.completed = true; return result;
    }
    catch (error) { observation.error = failureObservation(error); throw error; }
    finally {
      observation.elapsedMilliseconds = performance.now() - started; observation.finishedAt = new Date().toISOString();
      observation.processCpuMicroseconds = process.cpuUsage(cpu);
      observation.resourcesAfter = process.resourceUsage(); observation.memoryAfter = process.memoryUsage();
      metrics.setPhase('between-stages');
    }
  };
  const stopped = async (filename, operation) => {
    await stoppedDatabase(filename);
    source = new SqliteDatabase(filename, { readOnly: true, requireMigrationHistory: true });
    try { return await operation(source); } finally { source.close(); source = undefined; }
  };
  const query = async (target, label, parameters, expected) => stage(label, () => target.withConnection(async session => {
    const initial = (await session.client.query("SELECT current_setting('statement_timeout') AS timeout, pg_backend_pid() AS pid, current_setting('jit') AS jit, pg_jit_available() AS jit_available, current_setting('jit_above_cost') AS jit_above_cost")).rows[0];
    const planned = buildPostgresItemPageQuery(session, parameters, { userId: report.userId,
      scope: { ancestorId: input.parentId } });
    const attempt = { label, parameters, backend: initial, statementSha256: sha(Buffer.from(planned.text)),
      statement: planned.text, statementValues: planned.values, startedAt: new Date().toISOString() };
    (report.queryAttempts ??= []).push(attempt);
    const rows = session.rows.bind(session), hydration = [];
    session.rows = async (name, options) => {
      if (name === 'BaseItems') {
        assert.ok(Array.isArray(options?.whereIn?.Id), 'The production selector hydrates an explicit result page.');
        assert.ok(options.whereIn.Id.length <= 128, 'The large catalog must not be hydrated outside its selected page.');
        hydration.push(options.whereIn.Id.length);
      }
      return rows(name, options);
    };
    let result, operationFailed = false, operationFailure;
    try {
      // Retain the ordinary 30-second HTTP query budget at the real SQL boundary.
      await session.client.query("SET statement_timeout = '30s'");
      result = await queryPostgresItemPage(session, parameters, { userId: report.userId,
        scope: { ancestorId: input.parentId }, signal: t.signal });
      assert.equal(result.total, expected.total); assert.equal(result.startIndex, parameters.startindex);
      assert.deepEqual(result.rows.map(row => idKey(row.Id)), expected.ordinals.map(ordinal => idKey(Id(ordinal))));
      assert.ok(result.rows.length <= 128);
      const observation = { label, parameters, total: result.total, startIndex: result.startIndex,
        rows: result.rows, hydration, statementSha256: sha(Buffer.from(result.plan.text)),
        statement: result.plan.text, statementValues: result.plan.values,
        backendPid: initial.pid, diagnosticOnlyTiming: true };
      report.queries.push(observation);
      if (label === 'pg-empty-page-retains-complete-count') {
        const explained = await session.client.query({ text: 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + result.plan.text,
          values: result.plan.values, signal: t.signal });
        observation.executionPlan = explained.rows[0]['QUERY PLAN'];
        const visit = node => {
          if (node['Node Type'] === 'WindowAgg') assert.equal(node['Actual Loops'], 0,
            'The exhausted catalog page must not execute the full item ordering.');
          for (const child of node.Plans ?? []) visit(child);
        };
        visit(observation.executionPlan[0].Plan);
      } else {
        // Planning is diagnostic only; do not replay a successful large read.
        try {
          const explained = await session.client.query({ text: 'EXPLAIN (FORMAT JSON) ' + result.plan.text,
            values: result.plan.values, signal: t.signal });
          observation.estimatedPlan = explained.rows[0]['QUERY PLAN'];
        } catch (diagnosticError) { observation.planError = failureObservation(diagnosticError); }
      }
    } catch (error) {
      operationFailed = true; operationFailure = error; attempt.failure = failureObservation(error);
      if (error.code === '57014' && !t.signal.aborted) {
        // Planning the same readonly statement supplies diagnosis without
        // replaying a timed-out read or increasing its execution allowance.
        try {
          const explained = await session.client.query({ text: 'EXPLAIN (FORMAT JSON) ' + planned.text,
            values: planned.values, signal: t.signal });
          attempt.failurePlan = explained.rows[0]['QUERY PLAN'];
        } catch (diagnosticError) { attempt.planError = failureObservation(diagnosticError); }
      }
    }
    attempt.finishedAt = new Date().toISOString();
    session.rows = rows;
    try { await session.client.query("SELECT set_config('statement_timeout', $1, false)", [initial.timeout]); }
    catch (error) {
      if (operationFailed) throw new AggregateError([operationFailure, error], 'Large catalog query and restoration failed.', { cause: operationFailure });
      throw error;
    }
    if (operationFailed) throw operationFailure;
    return result;
  }));
  const filteredOrdinals = () => {
    const ordinals = [];
    for (let ordinal = 1; ordinal <= input.items; ordinal++) {
      if (ordinal !== input.deletedByNode && 1980 + ordinal % 50 === input.query.year && ordinal % 3 === 0) ordinals.push(ordinal);
    }
    return ordinals;
  };
  const filteredQuery = { includeitemtypes: ['Movie'], mediatypes: ['Video'], years: [input.query.year], isfavorite: true,
    sortby: ['SortName'], sortorder: ['Ascending'], startindex: input.query.startIndex, limit: input.query.limit };
  const selectFiltered = async (target, label, native) => {
    const eligible = filteredOrdinals(), expected = { total: eligible.length,
      ordinals: eligible.slice(input.query.startIndex, input.query.startIndex + input.query.limit) };
    const result = await query(target, label, filteredQuery, expected);
    assert.equal(native.filteredCount, expected.total); assert.deepEqual(nativePage(result.rows), native.page);
    return result;
  };
  try {
    supplied = await stage('verify-current-native-input', () => currentNativeSqliteInputs());
    await copyFile(supplied.filename, sourceFilename);
    assert.equal(sha(await readFile(sourceFilename)), supplied.receipt.input.sha256);
    await stopped(sourceFilename, async initial => {
      const users = await initial.rows('Users', { limit: 1 }); assert.equal(users.length, 1);
      report.userId = users[0].Id;
    });
    const fixture = { ...input, userId: report.userId, mediaRoot };
    const fixtureFile = path.join(root, 'catalog-input.json'); await writeFile(fixtureFile, JSON.stringify(fixture));
    const oracle = await stage('compile-native-catalog-owner', () => compileOracle({
      project: 'tests/migration/fixtures/large-catalog-exchange/Oracle.csproj', output: path.join(root, 'oracle-build') }));
    report.native.build = oracle.buildRecord;
    const record = async (mode, filename) => stage('native-' + mode, async () => {
      const outputRoot = path.join(root, 'native-' + mode);
      const receipt = await oracle.record({ output: outputRoot, args: [mode, filename, fixtureFile, '{output}/native.json'] });
      assert.equal(receipt.passed, true); assert.equal(receipt.process.status, 0);
      const native = JSON.parse(await readFile(path.join(outputRoot, 'native.json'), 'utf8'));
      assert.equal(native.mode, mode); assert.equal(native.processId, receipt.process.pid);
      report.native[mode] = { receipt, native }; return native;
    });
    const seeded = await record('seed', sourceFilename);
    assert.equal(seeded.observation.rows, input.items); assert.equal(seeded.observation.userStateRows, input.items);
    assert.equal(seeded.observation.ordinalSum, String(input.items * (input.items + 1) / 2));
    assert.equal(seeded.observation.dataSha256, dataDigest(input.items));
    assert.equal(seeded.observation.retained.Data, input.data);
    report.input = { sourceSha256: supplied.receipt.input.sha256, sourceBytes: supplied.receipt.input.bytes,
      nativeSchemaFingerprint: supplied.receipt.schema.canonicalFingerprint, build: supplied.receipt.build,
      bindings: supplied.inputs, generatedCatalog: true, physicalMediaFilesCreated: false };
    const contract = { mounts: [{ mountId: 'large-catalog-media', identityRoot: mediaRoot, accessRoot: '/large-catalog-media',
      pathStyle: process.platform === 'win32' ? 'windows' : 'posix', caseSensitive: process.platform !== 'win32',
      returnPolicy: 'required' }] };
    const binding = { serverId: supplied.initialization.serverId, originIdentityDigest: sha(await readFile(sourceFilename)) };
    database = await createPostgresTestDatabase(null, 'catalog_large', { deferRuntimeSchemaInitialization: true });
    await stopped(sourceFilename, async initial => {
      report.snapshots.nativeSeeded = await stage('snapshot-native-seeded', () => orderedExchangeSnapshot(initial, { signal: t.signal }));
      report.imported = await stage('import-full-native-catalog', () => transferDatabase(initial, database,
        { instanceBinding: binding, portableMountContract: contract, signal: t.signal }));
    });
    report.initialRuntimeSchema = await stage('initialize-full-pg-runtime-schema', () => database.initializeRuntimeSchema());
    await stage('verify-full-pg-runtime-schema', () => database.preflight());
    report.runtimePlannerStatistics = await stage('observe-initial-pg-planner-statistics', async () => ({
      diagnosticOnly: true,
      rows: (await database.client.query(`SELECT tablename, attname, null_frac, n_distinct,
        most_common_vals::text AS most_common_values, most_common_freqs AS most_common_frequencies
        FROM pg_catalog.pg_stats WHERE schemaname = $1 AND tablename = ANY($2::text[]) ORDER BY tablename, attname`,
      [database.schemaName, ['BaseItems', 'AncestorIds', 'UserData', ...postgresRuntimeIndexNames]])).rows,
    }));
    assert.deepEqual(await stage('snapshot-pg-imported', () => orderedExchangeSnapshot(database, { signal: t.signal })), report.snapshots.nativeSeeded);
    report.primaryKeyPagePlans = await stage('observe-primary-key-page-plans', () => database.withConnection(async session => {
      const observations = [];
      for (const statement of metrics.primaryKeyPageStatements()) {
        const observation = { diagnosticOnly: true, ...statement }; observations.push(observation);
        for (const [label, text] of [['current', statement.text], ['legacyNullsFirst', statement.legacyText]]) {
          try {
            const explained = await session.client.query({ text: 'EXPLAIN (FORMAT JSON) ' + text,
              values: statement.values, signal: t.signal });
            observation[label] = explained.rows[0]['QUERY PLAN'];
          } catch (error) { observation[label + 'Error'] = failureObservation(error); }
        }
      }
      return observations;
    }));
    await selectFiltered(database, 'pg-initial-filtered-page', seeded.observation);
    const deepStart = input.items - 130;
    await query(database, 'pg-deep-count-and-page', { includeitemtypes: ['Movie'], sortby: ['SortName'], sortorder: ['Ascending'],
      startindex: deepStart, limit: 128 }, { total: input.items, ordinals: Array.from({ length: 128 }, (_value, index) => deepStart + index + 1) });
    await query(database, 'pg-empty-page-retains-complete-count', { includeitemtypes: ['Movie'], sortby: ['SortName'],
      sortorder: ['Ascending'], startindex: input.items + 1, limit: 128 }, { total: input.items, ordinals: [] });
    await stage('node-transaction-insert-update-delete', () => database.transaction(async transaction => {
      const [template] = await transaction.rows('BaseItems', { where: { Id: Id(1) } }); assert.ok(template);
      await transaction.update('BaseItems', { Id: Id(input.retained) }, { Name: 'Edited by Node at production cardinality',
        RunTimeTicks: ticksBase + BigInt(input.retained) + 10003n });
      await transaction.update('UserData', { ItemId: Id(input.retained), UserId: report.userId, CustomDataKey: Id(input.retained) },
        { PlaybackPositionTicks: ticksBase + BigInt(input.retained) + 3n, PlayCount: 2 });
      await transaction.delete('BaseItems', { Id: Id(input.deletedByNode) });
      const ordinal = input.addedByNode;
      await transaction.insert('BaseItems', { ...template, Id: Id(ordinal), Name: 'Large catalog ' + String(ordinal).padStart(7, '0'),
        SortName: 'large catalog ' + String(ordinal).padStart(7, '0'), CleanName: 'large catalog ' + String(ordinal).padStart(7, '0'),
        Path: path.join(mediaRoot, String(ordinal).padStart(7, '0') + '.mkv'), PresentationUniqueKey: Id(ordinal),
        ProductionYear: 1980 + ordinal % 50, RunTimeTicks: ticksBase + BigInt(ordinal) + 10000n });
      await transaction.insert('AncestorIds', { ItemId: Id(ordinal), ParentItemId: nativeGuid(input.parentId) });
      const [user] = await transaction.rows('UserData', { where: { ItemId: Id(1), UserId: report.userId } }); assert.ok(user);
      await transaction.insert('UserData', { ...user, ItemId: Id(ordinal), CustomDataKey: Id(ordinal), IsFavorite: true,
        PlaybackPositionTicks: ticksBase + BigInt(ordinal), Played: false });
    }));
    assertRemoved(await itemSnapshot(database, [Id(input.deletedByNode)]), Id(input.deletedByNode));
    report.snapshots.nodeChanged = await stage('snapshot-node-changed', () => orderedExchangeSnapshot(database, { signal: t.signal }));
    report.exported = await stage('export-complete-current-sqlite', () => exportCurrentSqlite(database, exported, { signal: t.signal }));
    assert.equal(report.exported.verified, true);
    await stopped(exported, async sqlite => assert.deepEqual(await stage('snapshot-exported-sqlite',
      () => orderedExchangeSnapshot(sqlite, { signal: t.signal })), report.snapshots.nodeChanged));
    const continued = await record('continue', exported);
    assert.equal(continued.before.rows, input.items); assert.equal(continued.before.userStateRows, input.items);
    assert.equal(continued.before.ordinalSum, String(input.items * (input.items + 1) / 2 - input.deletedByNode + input.addedByNode));
    assert.equal(continued.before.nodeAddedItemPresent, true); assert.equal(continued.before.deletedItemPresent, false);
    assert.equal(continued.before.retained.runTimeTicks, (ticksBase + BigInt(input.retained) + 10003n).toString());
    assert.equal(continued.before.retained.playbackPositionTicks, (ticksBase + BigInt(input.retained) + 3n).toString());
    assert.equal(continued.after.rows, input.items); assert.equal(continued.after.userStateRows, input.items);
    assert.equal(continued.after.ordinalSum, String(input.items * (input.items + 1) / 2 - input.deletedByNode + input.addedByNative));
    assert.equal(continued.after.nodeAddedItemPresent, false); assert.equal(continued.after.nativeAddedItemPresent, true);
    assert.equal(continued.after.dataSha256, dataDigest(input.items));
    assert.equal(continued.after.retained.Name, 'Native continued at production cardinality');
    await selectFiltered(database, 'pg-after-mutations-vs-native-reader', continued.before);
    fresh = await createPostgresTestDatabase(null, 'catalog_return', { deferRuntimeSchemaInitialization: true });
    await stopped(exported, async sqlite => {
      report.snapshots.nativeContinued = await stage('snapshot-native-continued', () => orderedExchangeSnapshot(sqlite, { signal: t.signal }));
      report.reimported = await stage('import-complete-native-continuation', () => transferDatabase(sqlite, fresh,
        { instanceBinding: binding, portableMountContract: contract, signal: t.signal }));
    });
    report.returnRuntimeSchema = await stage('initialize-full-return-runtime-schema', () => fresh.initializeRuntimeSchema());
    await stage('verify-full-return-runtime-schema', () => fresh.preflight());
    assert.deepEqual(await stage('snapshot-fresh-pg', () => orderedExchangeSnapshot(fresh, { signal: t.signal })), report.snapshots.nativeContinued);
    assert.deepEqual(report.reimported.migrationHistory, report.imported.migrationHistory);
    const schema = fresh.schemaName; await fresh.close();
    fresh = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema });
    assert.deepEqual(await stage('snapshot-cold-fresh-pg', () => orderedExchangeSnapshot(fresh, { signal: t.signal })), report.snapshots.nativeContinued);
    await selectFiltered(fresh, 'fresh-pg-vs-native-reader', continued.after);
    for (const ordinal of [input.deletedByNode, input.addedByNode]) assertRemoved(await itemSnapshot(fresh, [Id(ordinal)]), Id(ordinal));
    const [retained] = await fresh.rows('BaseItems', { where: { Id: Id(input.retained) } });
    assert.equal(retained.Data, input.data); assert.equal(retained.Name, continued.after.retained.Name);
    assert.equal(retained.RunTimeTicks.toString(), continued.after.retained.runTimeTicks);
    const [state] = await fresh.rows('UserData', { where: { ItemId: Id(input.retained), UserId: report.userId } });
    assert.equal(state.PlaybackPositionTicks.toString(), continued.after.retained.playbackPositionTicks);
    assert.equal(state.PlayCount, 3);
    assert.equal(dateTicks(state.LastPlayedDate), dateTicks(continued.after.retained.lastPlayedDate));
    assert.deepEqual(await stage('snapshot-original-pg-still-current', () => orderedExchangeSnapshot(database, { signal: t.signal })), report.snapshots.nodeChanged);
    t.signal.throwIfAborted();
    report.productionScaleVerified = true;
    report.acceptanceScope = { kind: 'ci-generated-catalog', nativeMediaRows: input.items, ancestorRows: input.items,
      userStateRows: input.items, productionSqlResultPageLimit: 128, fullNativeTables: report.snapshots.nativeContinued.tables.length,
      insertionStreams: Object.keys(report.snapshots.nativeContinued.insertionOrder), nativeEfReadEveryItem: true,
      physicalMediaAccessVerified: false, userProductionData: false };
  } catch (error) { failed = true; failure = error; report.error = failureObservation(error); }
  finally {
    metrics.setPhase('cleanup');
    if (t.signal.aborted) {
      report.productionScaleVerified = false;
      if (!failed) { failed = true; failure = t.signal.reason; report.error = failureObservation(failure); }
    }
    const cleanupErrors = [];
    for (const operation of [() => { source?.close(); source = undefined; },
      () => dropPostgresTestDatabase(fresh), () => dropPostgresTestDatabase(database), async () => {
        if (!supplied) return;
        const after = await currentNativeSqliteInputs(); assert.deepEqual(after.inputs, supplied.inputs);
      }]) try { await operation(); } catch (error) { cleanupErrors.push(error); }
    report.cleanup = { sqliteOwnersClosed: source === undefined,
      postgresOwnersClosed: [database, fresh].filter(Boolean).every(owner => owner.closed),
      protectedCurrentInputUnchanged: supplied ? cleanupErrors.length === 0 : null, errors: cleanupErrors.map(failureObservation) };
    if (t.signal.aborted && !failed) { failed = true; failure = t.signal.reason; report.error = failureObservation(failure); }
    report.passed = !failed && cleanupErrors.length === 0;
    if (!report.passed) report.productionScaleVerified = false;
    metrics.restore();
    await writeFile(path.join(root, 'report.json'), JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
    await output.publishAndClose();
    if (cleanupErrors.length) {
      failure = new AggregateError(failed ? [failure, ...cleanupErrors] : cleanupErrors, 'Large catalog exchange or cleanup failed.',
        failed ? { cause: failure } : undefined); failed = true;
    }
  }
  if (failed) throw output.publicError(failure);
});
