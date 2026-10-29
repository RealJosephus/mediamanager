import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { createRuntime } from '../../src/runtime.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { canonicalCell } from '../../src/database/values.js';
import { transferDatabase, exportCurrentSqlite } from '../../src/migration/database-transfer.js';
import { dateTicks, idKey } from '../../src/library/records.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { compileOracle } from '../../tools/validation/oracle.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { orderedExchangeSnapshot } from '../helpers/ordered-exchange-snapshot.js';
import { errorObservation } from '../helpers/error-observation.js';

export const requiredValidationServices = ['postgres', 'nativeInstance', 'dotnet', 'jellyfinDll'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE
  && process.env.MEDIAMANAGER_JELLYFIN_DLL);
const inputBytes = await readFile(new URL('./fixtures/guid-case-refresh-current/input.json', import.meta.url));
const input = JSON.parse(inputBytes);
const asset = new URL('../fixtures/frozen-av/source.m2ts', import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
const nativeSources = [
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.Querying.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs',
  'Jellyfin.Server.Implementations/Item/ItemPersistenceService.cs',
  'Emby.Server.Implementations/Library/LibraryManager.cs',
  'Emby.Server.Implementations/ServerApplicationPaths.cs', 'MediaBrowser.Providers/Manager/ProviderManager.cs',
  'MediaBrowser.Controller/Entities/BaseItem.cs', 'MediaBrowser.Controller/Entities/Video.cs',
  'MediaBrowser.Controller/LiveTv/IRecordingsManager.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/JellyfinDbContext.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/ModelConfiguration/BaseItemConfiguration.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Providers.Sqlite/SqliteDatabaseProvider.cs',
];
const projection = item => item == null ? null : {
  id: idKey(item.id ?? item.Id), nativeType: item.nativeType ?? item.NativeType,
  name: item.name ?? item.Name, path: item.path ?? item.Path,
  parentId: idKey(item.parentId ?? item.ParentId), overview: item.overview ?? item.Overview ?? null,
  providerIds: { ...(item.providerIds ?? item.ProviderIds) },
  runTimeTicks: (item.runTimeTicks ?? item.RunTimeTicks)?.toString() ?? null,
  dateCreated: dateTicks(item.dateCreated ?? item.DateCreated).toString(),
  dateModified: dateTicks(item.dateModified ?? item.DateModified).toString(),
};
function rawStorage(database, id = input.itemId) {
  const rows = database.database.prepare('SELECT "Id", hex(CAST("Id" AS BLOB)) AS "idHex", "Data", '
    + 'hex(CAST("Data" AS BLOB)) AS "dataHex" FROM "BaseItems" WHERE CAST("Id" AS BLOB) IN (CAST(? AS BLOB), CAST(? AS BLOB))')
    .all(id, id.toLowerCase());
  assert.equal(rows.length, 1);
  return { rawId: rows[0].Id, idHex: rows[0].idHex, data: rows[0].Data, dataHex: rows[0].dataHex };
}
async function rootRowEvidence(database) {
  const result = {};
  for (const name of ['BaseItems', 'AncestorIds']) {
    const table = tableDefinition(name), rows = await database.rows(name, { consumer: 'exchange', limit: 65 });
    result[name] = { diagnosticLimit: 64, truncated: rows.length > 64, rows: rows.slice(0, 64).map(row => ({
      primaryKey: Object.fromEntries(table.primaryKey.map(key => [key, canonicalCell(row[key])])),
      cells: Object.fromEntries(table.columns.map(column => [column.name, canonicalCell(row[column.name])])),
    })) };
  }
  return result;
}

test('same-run Native SQLite Guid spelling is measured through real cold/warm readers and exact PG export before metadata claims', {
  skip: !enabled, timeout: 360000,
}, async t => {
  const destination = path.join(validationOutputRoot(), 'guid-case-premise-' + randomUUID());
  const output = await createPrivateFilterOutput(destination); await mkdir(output.root);
  output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  const secrets = new Set([process.env.MEDIAMANAGER_TEST_POSTGRES]);
  const root = output.root;
  const report = { schemaVersion: 1, stage: input.stage, scope: input.scope, inputSha256: sha(inputBytes),
    input: { bytes: inputBytes.length, sha256: sha(inputBytes), base64: inputBytes.toString('base64') },
    native: [], cases: [], cleanup: {}, metadataRefreshExecuted: false, externalDataInvalidationExecuted: false,
    metadataRefreshVerified: false, phaseAcceptance: false, releaseAcceptance: false, fullInstanceVerified: false,
    productionScaleVerified: false, passed: false };
  const owners = [], schemas = [], runtimes = [], sqliteOwners = [], postgresScopes = new Map();
  const runtimeClosing = new Map(), closedSqlite = new Set();
  const closeRuntime = runtime => {
    if (!runtimeClosing.has(runtime)) runtimeClosing.set(runtime, Promise.resolve().then(() => runtime.close()));
    return runtimeClosing.get(runtime);
  };
  const closeSqlite = database => { if (!closedSqlite.has(database)) { database.close(); closedSqlite.add(database); } };
  const ownPostgres = database => {
    owners.push(database);
    if (!postgresScopes.has(database.schemaName)) schemas.push(database.schemaName, database.controlSchema);
    postgresScopes.set(database.schemaName, database);
    return database;
  };
  const originalFile = async filename => {
    const bytes = await readFile(filename);
    return { bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString('base64') };
  };
  let current, failed = false, failure, ownerCloseFailed = false;
  const record = async (oracle, mode, label, producerRoot, filename) => {
    t.signal.throwIfAborted();
    const directory = path.join(root, label), observation = { label, mode }; report.native.push(observation);
    let receipt;
    try {
      receipt = await oracle.record({ output: directory,
        args: [mode, path.join(root, 'input.json'), '{output}/native.json', producerRoot, filename] });
    } finally {
      observation.originalOutputs = {};
      for (const name of ['native.json', 'record.json', 'stdout.txt', 'stderr.txt']) {
        try { observation.originalOutputs[name] = await originalFile(path.join(directory, name)); }
        catch (error) { (observation.outputReadErrors ??= []).push({ name, error: errorObservation(error) }); }
      }
      try {
        observation.raw = observation.originalOutputs['native.json'];
        observation.result = JSON.parse(Buffer.from(observation.raw.base64, 'base64'));
      } catch (error) { observation.outputReadError = errorObservation(error); }
      if (!receipt) {
        try { observation.receipt = JSON.parse(Buffer.from(observation.originalOutputs['record.json'].base64, 'base64')); }
        catch (error) { observation.receiptReadError = errorObservation(error); }
      }
      const actualProcess = (receipt ?? observation.receipt)?.process;
      if (actualProcess) {
        observation.normalProcessExit = actualProcess.status === 0 && actualProcess.signal === null && !actualProcess.errorCode;
        if (!observation.normalProcessExit) ownerCloseFailed = true;
      }
    }
    observation.receipt = receipt;
    assert.equal(receipt.passed, true); assert.equal(receipt.process.status, 0); assert.equal(receipt.process.signal, null);
    assert.equal(observation.result.passed, true); assert.equal(observation.result.inputSha256, sha(inputBytes));
    assert.equal(observation.result.componentResourcesDisposed, true);
    assert.deepEqual(observation.result.recordingInput, input.recordings);
    for (const request of observation.result.recordingRequests) {
      assert.equal(request.method, 'GetActiveRecordingInfo'); assert.equal(request.result, null);
      assert.ok(['movie.m2ts', 'other.m2ts'].map(name => path.join(producerRoot, 'media', name)).includes(request.path));
    }
    assert.equal(observation.result.sourceUnchanged, true);
    assert.equal(receipt.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, observation.raw.sha256);
    for (const library of [...observation.result.assemblies, observation.result.nativeLibrary]) {
      assert.equal((await describeFile(library.filename)).sha256, library.sha256);
    }
    t.signal.throwIfAborted(); return observation.result;
  };
  try {
    await writeFile(path.join(root, 'input.json'), inputBytes, { flag: 'wx' });
    const media = await readFile(asset); assert.equal(media.length, input.asset.bytes); assert.equal(sha(media), input.asset.sha256);
    report.asset = { ...input.asset, actualBytes: media.length, actualSha256: sha(media), mediaFabricated: false };
    current = await currentNativeReference(); output.addSecret(current.accessToken); secrets.add(current.accessToken);
    report.preparation = current.preparation; report.sourceBindings = await current.sourceBindings(nativeSources);
    report.sourceDatabase = await describeFile(current.sourceDatabase);
    let oracle;
    try { oracle = await compileOracle({ project: 'tests/metadata/fixtures/guid-case-refresh-current/Oracle.csproj',
      output: path.join(root, 'build'), environment: current.environment }); }
    finally {
      report.buildOutputs = {};
      for (const name of ['oracle-build.json', 'build.stdout.txt', 'build.stderr.txt']) {
        try { report.buildOutputs[name] = await originalFile(path.join(root, 'build', name)); }
        catch (error) { (report.buildOutputReadErrors ??= []).push({ name, error: errorObservation(error) }); }
      }
    }
    report.build = oracle.buildRecord;
    let first;
    for (const repetition of ['first', 'repeat']) {
      const producerRoot = path.join(root, 'producer-' + repetition);
      await mkdir(path.join(producerRoot, 'media'), { recursive: true });
      for (const name of ['movie.m2ts', 'other.m2ts']) await copyFile(asset, path.join(producerRoot, 'media', name));
      const produced = await record(oracle, 'produce', repetition + '-producer', producerRoot, current.sourceDatabase);
      assert.equal(produced.actualSaveItems, true); assert.equal(produced.schemaCreated, false);
      assert.equal(produced.actualRootFolderInitialization, true);
      assert.deepEqual(produced.rootInitialization.input, input.rootInitialization);
      assert.equal(produced.schemaHistoryPreserved, true); assert.equal(produced.credentialsClearedAndVacuumed, true);
      assert.equal(produced.typedWriterStorage.row.rawId, input.itemId, 'The actual normal writer is the uppercase-D positive control.');
      assert.equal(produced.lowercaseProducer.allOtherCellsPreserved, true);
      assert.equal(produced.lowercaseProducer.observations.find(value => value.table === 'BaseItems' && value.column === 'Id').changed, 1);
      for (const table of ['KeyframeData', 'MediaSegments', 'TrickplayInfos', 'Chapters']) {
        assert.equal(produced.lowercaseProducer.observations.find(value => value.table === table && value.column === 'ItemId').changed, 1);
      }
      for (const table of produced.lowercaseProducer.verification) assert.equal(table.actualSha256, table.expectedSha256);
      assert.deepEqual(produced.controls.find(value => value.name === 'lower').unrelatedStorage,
        produced.controls.find(value => value.name === 'upper').unrelatedStorage);
      const observed = {};
      for (const control of produced.controls) {
        assert.ok(['upper', 'lower'].includes(control.name));
        assert.equal(control.storage.row.rawId, control.name === 'upper' ? input.itemId : input.itemId.toLowerCase());
        assert.equal(control.storage.row.data, input.data);
        assert.equal(control.storage.row.dataHex.toLowerCase(), Buffer.from(input.data).toString('hex'));
        assert.equal(control.storage.providers.find(value => value.key === 'OpaqueProvider').value, input.opaqueProvider);
        assert.equal(control.storage.providers.find(value => value.key === 'OpaqueProvider').valueHex.toLowerCase(), Buffer.from(input.opaqueProvider).toString('hex'));
        assert.equal(control.unrelatedStorage.row.rawId, input.otherId);
        assert.equal(control.unrelatedStorage.row.data, input.data);
        assert.equal(control.unrelatedStorage.providers.find(value => value.key === 'OpaqueProvider').value, 'unrelated:' + input.itemId);
        const bytes = await readFile(control.filename); assert.equal(sha(bytes), control.sha256);
        assert.ok(!bytes.includes(Buffer.from(current.accessToken)), 'Cleared controlled SQLite bytes must not expose the input device token.');
        const reading = await record(oracle, 'read', repetition + '-native-' + control.name, producerRoot, control.filename);
        assert.equal(reading.actualRepositoryAndMapper, true); assert.equal(reading.actualLibraryManager, true);
        assert.equal(reading.beforeTables, reading.afterTables);
        assert.deepEqual(reading.storage.row, control.storage.row);
        assert.equal(reading.repository !== null, reading.cold !== null);
        assert.equal(reading.warmExecuted, reading.cold !== null);
        if (reading.cold !== null) {
          assert.equal(idKey(reading.cold.id), idKey(input.itemId));
          assert.equal(reading.cold.name, input.name); assert.equal(reading.warm.name, input.warmName);
        } else assert.equal(typeof reading.warmNotExecutedReason, 'string');
        if (control.name === 'upper') assert.notEqual(reading.cold, null);
        observed[control.name] = { control, reading, originalSqlite: { bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString('base64') } };
      }
      assert.deepEqual(Object.keys(observed).sort(), ['lower', 'upper']);
      if (!first) first = { producerRoot, produced, observed };
      else for (const name of ['upper', 'lower']) {
        assert.equal(observed[name].reading.cold !== null, first.observed[name].reading.cold !== null,
          'Independent fresh Native processes must reproduce the same actual lookup outcome.');
      }
    }
    const lowerAccepted = first.observed.lower.reading.cold !== null;
    report.premise = { nativeLowerColdReadAccepted: lowerAccepted,
      conclusion: lowerAccepted ? 'Actual Native accepted the controlled lowercase input; metadata refresh remains to be compared.'
        : 'Actual Native cold lookup rejected this physically present lowercase input; a Native-supported refresh premise is not established.',
      metadataStageTwoRequired: lowerAccepted, nativeWarmManufactured: false, exactExchangeCompleted: false,
      metadataNotExecutedReason: lowerAccepted ? 'This first stage only measures acquisition and exact exchange; refresh is a separate required follow-up.'
        : 'The real Native cold acquisition returned no item; no artificial warm item was supplied to force an unreachable refresh.' };
    for (const name of ['upper', 'lower']) {
      const { control, reading, originalSqlite } = first.observed[name];
      const observation = { name, source: originalSqlite, nativeColdFound: reading.cold !== null,
        nativeWarmExecuted: reading.warmExecuted, metadataRefreshExecuted: false, externalDataInvalidationExecuted: false };
      report.cases.push(observation);
      let source = new SqliteDatabase(control.filename, { readOnly: true, requireMigrationHistory: true }); sqliteOwners.push(source);
      const original = await orderedExchangeSnapshot(source, { signal: t.signal });
      assert.equal(original.tables.length, 31); assert.equal(Object.keys(original.insertionOrder).length, 6);
      observation.original = original;
      observation.originalRootRows = await rootRowEvidence(source);
      const database = ownPostgres(await createPostgresTestDatabase(null, 'guid_premise', { deferRuntimeSchemaInitialization: true }));
      const contract = { mounts: [{ mountId: 'guid-control', identityRoot: first.producerRoot, accessRoot: '/guid-control',
        pathStyle: process.platform === 'win32' ? 'windows' : 'posix', caseSensitive: process.platform !== 'win32', returnPolicy: 'required' }] };
      observation.transfer = await transferDatabase(source, database, { signal: t.signal, portableMountContract: contract,
        instanceBinding: { serverId: current.preparation.nativeServerId, originIdentityDigest: control.sha256 } });
      closeSqlite(source);
      await database.initializeRuntimeSchema();
      assert.deepEqual(await orderedExchangeSnapshot(database, { signal: t.signal }), original);
      observation.beforeRuntimeRows = await rootRowEvidence(database);
      const storageConfiguration = path.join(root, 'storage-' + name + '.json');
      await writeFile(storageConfiguration, JSON.stringify({ instances: [{ id: 'control', type: 'local',
        config: { root: first.producerRoot, writable: true } }], mounts: [{ path: '/guid-control', instanceId: 'control',
        capabilities: { create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } }],
        prefixes: [{ identityRoot: first.producerRoot, accessRoot: '/guid-control',
          style: process.platform === 'win32' ? 'windows' : 'posix', caseSensitive: process.platform !== 'win32',
          returnAccess: 'Only this independently owned controlled Native producer namespace.' }] }, null, 2) + '\n', { flag: 'wx' });
      const runtime = await createRuntime({ database, programDataPath: first.produced.programDataPath,
        serverId: current.preparation.nativeServerId, portableMountContract: contract, storageConfiguration,
        configuration: { CacheSize: 64, IsStartupWizardCompleted: true, UICulture: 'en-US', EnableCaseSensitiveItemIds: true },
        networkConfiguration: { InternalHttpPort: 0, LocalNetworkAddresses: ['127.0.0.1'], AutoDiscovery: false } });
      runtimes.push(runtime);
      observation.afterRuntimeRows = await rootRowEvidence(database);
      observation.afterRuntime = await orderedExchangeSnapshot(database, { signal: t.signal });
      assert.deepEqual(observation.afterRuntime, original, 'The actual Native root producer must make runtime construction preserve all 31 tables and six sequences.');
      const item = await runtime.itemCreation.getItemById(input.itemId);
      observation.nodeCold = projection(item); observation.nodeWarmExecuted = item != null;
      if (name === 'upper' || reading.cold !== null) assert.deepEqual(projection(item), projection(reading.cold));
      if (item != null) {
        const previous = item.Name; item.Name = input.warmName;
        observation.nodeWarm = projection(await runtime.itemCreation.getItemById(input.itemId));
        assert.equal(observation.nodeWarm.name, input.warmName); item.Name = previous;
      }
      observation.afterReadRows = await rootRowEvidence(database);
      observation.afterRead = await orderedExchangeSnapshot(database, { signal: t.signal });
      assert.deepEqual(observation.afterRead, original);
      await closeRuntime(runtime); observation.runtimeClosed = true; assert.equal(database.closed, true);
      const reopened = ownPostgres(await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema: database.schemaName }));
      assert.deepEqual(await orderedExchangeSnapshot(reopened, { signal: t.signal }), original);
      const exported = path.join(root, 'export-' + name + '.db');
      observation.export = await exportCurrentSqlite(reopened, exported, { signal: t.signal });
      assert.equal(observation.export.verified, true);
      const exportedDatabase = new SqliteDatabase(exported, { readOnly: true, requireMigrationHistory: true }); sqliteOwners.push(exportedDatabase);
      observation.exported = await orderedExchangeSnapshot(exportedDatabase, { signal: t.signal });
      assert.deepEqual(observation.exported, original);
      assert.deepEqual(rawStorage(exportedDatabase), control.storage.row);
      assert.deepEqual(rawStorage(exportedDatabase, input.otherId), control.unrelatedStorage.row);
      closeSqlite(exportedDatabase);
      const returned = await record(oracle, 'read', 'returned-native-' + name, first.producerRoot, exported);
      observation.returnedNative = returned;
      assert.deepEqual(projection(returned.cold), projection(reading.cold));
      assert.equal(returned.warmExecuted, reading.warmExecuted);
      assert.deepEqual(returned.storage.row, control.storage.row);
      assert.equal((await describeFile(control.filename)).sha256, control.sha256);
    }
    report.premise.exactExchangeCompleted = true;
  } catch (error) { failed = true; failure = error; report.error = errorObservation(error); }
  finally {
    const errors = [];
    for (const operation of [...runtimes.map(runtime => () => closeRuntime(runtime)), ...sqliteOwners.map(database => () => closeSqlite(database)),
      ...[...postgresScopes.values()].map(database => () => dropPostgresTestDatabase(database)),
      ...owners.map(database => () => database.close()), async () => {
        if (!current) return;
        for (const source of report.sourceBindings ?? []) assert.equal((await describeFile(source.path)).sha256, source.sha256);
        assert.equal((await describeFile(current.sourceDatabase)).sha256, report.sourceDatabase.sha256);
        await current.finish(); report.cleanup.nativeInputsUnchanged = true;
        assert.equal(sha(await readFile(asset)), input.asset.sha256); report.cleanup.frozenMediaUnchanged = true;
      }]) {
      try { await operation(); } catch (error) { ownerCloseFailed = true; errors.push(error); }
    }
    let client;
    try {
      client = new pg.Client({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, connectionTimeoutMillis: 10000,
        query_timeout: 10000, statement_timeout: 10000 }); await client.connect();
      const result = await client.query('SELECT nspname FROM pg_namespace WHERE nspname=ANY($1::text[])', [schemas]);
      assert.deepEqual(result.rows, []); report.cleanup.schemasIndependentlyAbsent = true;
    } catch (error) { ownerCloseFailed = true; errors.push(error); }
    finally { try { await client?.end(); } catch (error) { ownerCloseFailed = true; errors.push(error); } }
    report.cleanup = { ...report.cleanup, ownersClosedNormally: !ownerCloseFailed,
      oracleProcesses: report.native.map(value => ({ label: value.label, process: value.receipt?.process,
        normalProcessExit: value.normalProcessExit ?? null })), errors: errors.map(errorObservation) };
    if (errors.length) { failure = new AggregateError(failed ? [failure, ...errors] : errors,
      'Guid premise recording and cleanup failed.', failed ? { cause: failure } : undefined); failed = true; report.error = errorObservation(failure); }
    if (t.signal.aborted && !failed) { failed = true; failure = t.signal.reason; report.error = errorObservation(failure); }
    report.passed = !failed;
    if (ownerCloseFailed) report.privateRootRetained = true;
    try {
      await writeFile(path.join(root, 'report.json'), JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
      if (!ownerCloseFailed) await output.publishAndClose();
      else { await mkdir(destination); await writeFile(path.join(destination, 'report.json'), filterEvidenceJson(report, secrets)); }
    } catch (error) {
      failure = new AggregateError(failed ? [failure, error] : [error], 'Guid premise report publication failed.', failed ? { cause: failure } : { cause: error });
      failed = true; report.passed = false; report.error = errorObservation(failure);
      try {
        await mkdir(destination, { recursive: true });
        await writeFile(path.join(destination, 'report.json'), filterEvidenceJson(report, secrets));
      } catch (recordingError) {
        failure = new AggregateError([failure, recordingError], 'Guid premise failure publication also failed.', { cause: failure });
      }
    }
  }
  if (failed) throw failure instanceof Error ? output.publicError(failure) : failure;
});
