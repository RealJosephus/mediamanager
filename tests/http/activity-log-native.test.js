import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { get } from 'node:http';
import { copyFile, cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { transferDatabase, databaseDigest } from '../../src/migration/database-transfer.js';
import { startProductionInstance } from '../../src/main.js';
import { dateText } from '../../src/library/records.js';
import { nativeGuid, wireGuid } from '../../src/users/native.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { declareFileTestResource } from '../helpers/file-test-resource.js';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import { projectProblemTrace } from '../helpers/http-body-projection.js';
import { databaseFilename, portAvailable, removeSyntheticPreparation, sha, stoppedDatabase,
  unusedPort } from '../helpers/library-exchange-state.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES
  && process.env.MEDIAMANAGER_JELLYFIN_DLL;
const nativeCallback = declareNativeHttpTestFile({ enabled: Boolean(enabled) });
const discovery = declareFileTestResource('hdhomerun-discovery-65001', { enabled: Boolean(enabled) });
const inputBytes = await readFile(new URL('./fixtures/activity-log-current/input.json', import.meta.url));
const input = JSON.parse(inputBytes);
const authorization = (token, deviceId = 'activity-consumer') => `MediaBrowser Client="${input.client}", Device="${input.device}", DeviceId="${deviceId}", Version="1"${token ? `, Token="${token}"` : ''}`;
const timeout = (promise, label) => Promise.race([promise, delay(30000, undefined, { ref: false }).then(() => {
  throw new Error(label + ' did not finish within 30 seconds.');
})]);

function projection(response) {
  const headers = Object.fromEntries(['content-type', 'allow'].filter(name => response.headers[name] !== undefined)
    .map(name => [name, name === 'allow' ? response.headers[name].split(',').map(value => value.trim()).sort() : response.headers[name]]));
  if (response.json !== undefined) {
    const json = projectProblemTrace(structuredClone(response.json), response.status);
    for (const row of json.Items ?? json.items ?? []) {
      const property = Object.hasOwn(row, 'Date') ? 'Date' : 'date';
      // DateTime's fractional zero spelling may differ; all seven tick digits
      // and the public value stay observable in the retained original bytes.
      row[property] = dateText(row[property]);
    }
    return { status: response.status, headers, json };
  }
  return { status: response.status, headers, body: response.body };
}

const persisted = rows => rows.map(row => ({ ...row, UserId: wireGuid(row.UserId), RowVersion: String(row.RowVersion) }))
  .sort((left, right) => left.Id - right.Id);

test('actual ActivityLog HTTP authorization, MVC binding, SQL filters/count/order/page and ownership match Native', {
  skip: !enabled, timeout: 900000,
}, nativeCallback(async t => discovery.run(async () => {
  const destination = path.join(validationOutputRoot(), 'activity-log-http-' + randomUUID());
  const output = await createPrivateFilterOutput(destination); output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  const secrets = new Set([process.env.MEDIAMANAGER_TEST_POSTGRES].filter(Boolean));
  await mkdir(output.root);
  const root = await realpath(output.root), instanceRoot = path.join(root, 'instance');
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const report = { inputSha256: sha(inputBytes), native: [], node: [], preparation: [], states: {}, cleanup: [],
    mismatches: [], nativeExpectations: [], diagnostics: [], fullInstanceVerified: false, completeLibraryVerified: false,
    phaseAcceptance: false, releaseAcceptance: false, preservedStoppedInput: false };
  const identities = {}, seedIds = [];
  let current, native, runtime, database, reader, failure, safeToRemove = true;
  const request = async (route, { token = identities.admin?.token, method = 'GET', body,
    accept = 'application/json', deviceId, cleanup = false } = {}) => {
    if (!cleanup) t.signal.throwIfAborted();
    const response = await fetch(origin + route, { method,
      signal: cleanup ? AbortSignal.timeout(30000) : AbortSignal.any([t.signal, AbortSignal.timeout(30000)]),
      headers: { Authorization: authorization(token, deviceId), Accept: accept,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const bytes = Buffer.from(await response.arrayBuffer()), result = { status: response.status,
      headers: Object.fromEntries(response.headers), bytes: bytes.length, sha256: sha(bytes), body: bytes.toString('utf8') };
    if (response.headers.get('content-type')?.includes('json') && bytes.length) result.json = JSON.parse(result.body);
    return result;
  };
  const idle = async () => {
    const deadline = performance.now() + 120000;
    for (;;) {
      const result = await request('/ScheduledTasks'); assert.equal(result.status, 200);
      if (result.json.every(task => !['Running', 'Cancelling'].includes(task.State))) return result.json;
      assert.ok(performance.now() < deadline, 'Native scheduled work must drain before the owned database controls.');
      await delay(100, undefined, { signal: t.signal });
    }
  };
  const stopNative = async label => {
    if (!native) return;
    const outcome = await native.stop(async () => (await request('/System/Shutdown', { method: 'POST', cleanup: true })).status,
      () => portAvailable(port));
    report.cleanup.push({ label, ...outcome }); safeToRemove &&= outcome.pidGone;
    if (outcome.pidGone) native = undefined;
    assert.ok(outcome.cleanShutdown && outcome.pidGone && outcome.portAvailable, label);
  };
  const sqliteRows = () => persisted(reader.rows('ActivityLogs'));
  const pgRows = async () => persisted(await database.rows('ActivityLogs'));
  const runCases = async (label, rows) => {
    report.states[label] = { before: await rows() };
    for (const sample of input.cases) {
      const identity = sample.identity === 'anonymous' ? { token: null } : sample.identity === 'invalid' ? { token: 'invalid-activity-token' }
        : identities[sample.identity ?? 'admin'];
      const route = '/System/ActivityLog/Entries' + (sample.query?.length ? '?' + new URLSearchParams(sample.query) : '');
      const response = await request(route, { token: identity.token, deviceId: identity.deviceId,
        method: sample.method, accept: sample.accept });
      const observation = { name: sample.name, route, identity: sample.identity ?? 'admin', response };
      report[label].push(observation); observation.functional = projection(response);
      // Native responses are observations from this running source, including
      // each invalid-binding response and the real controller exception.
      if (label === 'native') {
        try {
          assert.equal(response.status, sample.status, sample.name);
          if (response.status === 200) {
            const values = response.json.Items ?? response.json.items;
            assert.equal(Array.isArray(values), true, sample.name);
            if (sample.items !== undefined) assert.equal(values.length, sample.items, sample.name);
            if (sample.all) assert.equal(values.length, seedIds.length, sample.name);
            const count = response.json.TotalRecordCount ?? response.json.totalRecordCount;
            assert.ok(Number.isSafeInteger(count) && count >= values.length, sample.name);
            for (const row of values) {
              assert.ok(seedIds.includes(row.Id ?? row.id), sample.name + ' returns the actual controlled persisted rows.');
              assert.equal(Object.hasOwn(row, 'Username') || Object.hasOwn(row, 'username'), false);
              assert.equal(Object.hasOwn(row, 'RowVersion') || Object.hasOwn(row, 'rowVersion'), false);
            }
          }
        } catch (error) {
          report.nativeExpectations.push({ name: sample.name, message: error.message });
        }
      }
    }
    report.states[label].after = await rows();
    assert.deepEqual(report.states[label].after, report.states[label].before, label + ' reads preserve committed activity rows.');
  };
  const openSlowResponse = async label => {
    const ready = Promise.withResolvers(), closed = Promise.withResolvers();
    let response, received = 0, prefix = '', settled = false;
    const pending = get(origin + '/System/ActivityLog/Entries?type=Lifecycle.Activity&limit=-1', {
      signal: AbortSignal.any([t.signal, AbortSignal.timeout(30000)]), agent: false,
      headers: { Authorization: authorization(identities.admin.token), Accept: 'application/json' },
    }, incoming => {
      response = incoming;
      incoming.on('data', bytes => {
        received += bytes.length; if (prefix.length < 4096) prefix += bytes.toString('utf8');
        if (!settled && prefix.includes('"Id"')) {
          settled = true; incoming.pause(); ready.resolve({ pending, response: incoming, closed: closed.promise,
            observation: { label, status: incoming.statusCode, received, prefix } });
        }
      });
      incoming.once('error', error => { if (!settled) ready.reject(error); });
      incoming.once('end', () => { if (!settled) ready.reject(new Error(label + ' ended before an activity row.')); });
      incoming.once('close', () => closed.resolve());
    });
    pending.once('error', error => { if (!settled) ready.reject(error); });
    try { return await timeout(ready.promise, label); }
    catch (error) { pending.destroy(); response?.destroy(); throw error; }
  };
  try {
    current = await currentNativeReference(); identities.admin = { id: current.userId, token: current.accessToken };
    output.addSecret(current.accessToken); secrets.add(current.accessToken); report.input = current.preparation;
    report.sourceBindings = await current.sourceBindings([
      'Jellyfin.Api/Controllers/ActivityLogController.cs', 'Jellyfin.Server.Implementations/Activity/ActivityManager.cs',
      'Jellyfin.Data/Queries/ActivityLogQuery.cs', 'Jellyfin.Data/Queries/PaginatedQuery.cs', 'Jellyfin.Data/Enums/ActivityLogSortBy.cs',
      'Jellyfin.Api/Helpers/RequestHelpers.cs', 'Jellyfin.Api/ModelBinders/NullableEnumModelBinder.cs',
      'Jellyfin.Api/ModelBinders/NullableEnumModelBinderProvider.cs', 'Jellyfin.Server/Extensions/ApiServiceCollectionExtensions.cs',
      'Jellyfin.Api/Auth/DefaultAuthorizationPolicy/DefaultAuthorizationHandler.cs',
      'Jellyfin.Api/Auth/UserPermissionPolicy/UserPermissionHandler.cs', 'MediaBrowser.Model/Activity/ActivityLogEntry.cs',
      'MediaBrowser.Model/Querying/QueryResult.cs', 'src/Jellyfin.Database/Jellyfin.Database.Implementations/Entities/ActivityLog.cs',
      'src/Jellyfin.Database/Jellyfin.Database.Implementations/Enums/SortOrder.cs',
      'src/Jellyfin.Database/Jellyfin.Database.Providers.Sqlite/ValueConverters/DateTimeKindValueConverter.cs',
    ]);
    await cp(current.sourceRoot, instanceRoot, { recursive: true, force: false, errorOnExist: true });
    await current.prepareClone(instanceRoot, port); report.syntheticPreparation = removeSyntheticPreparation(instanceRoot);
    native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label: 'native-activity-preparation', origin });
    await native.ready();
    for (const task of await idle()) assert.equal((await request('/ScheduledTasks/' + task.Id + '/Triggers', { method: 'POST', body: [] })).status, 204);
    const password = randomUUID(), deviceId = 'activity-ordinary'; output.addSecret(password); secrets.add(password);
    const created = await request('/Users/New', { method: 'POST', body: { Name: 'Activity_ordinary', Password: password } });
    assert.equal(created.status, 200); assert.equal(created.json.Policy.IsAdministrator, false);
    const login = await request('/Users/AuthenticateByName', { token: null, deviceId, method: 'POST',
      body: { Username: 'Activity_ordinary', Pw: password } });
    assert.equal(login.status, 200);
    identities.ordinary = { id: created.json.Id, token: login.json.AccessToken, deviceId };
    output.addSecret(login.json.AccessToken); secrets.add(login.json.AccessToken);
    assert.equal((await request('/Auth/Keys?app=ActivityLogConsumer', { method: 'POST' })).status, 204);
    const keys = await request('/Auth/Keys'); assert.equal(keys.status, 200);
    const key = keys.json.Items.find(entry => entry.AppName === 'ActivityLogConsumer'); assert.ok(key?.AccessToken);
    identities.api = { token: key.AccessToken }; output.addSecret(key.AccessToken); secrets.add(key.AccessToken);
    report.preparation.push({ ordinaryUserId: created.json.Id, ordinaryPolicy: created.json.Policy,
      apiKeyCreated: true, credentialsRecorded: false });
    await idle(); await stopNative('native-activity-preparation');
    reader = new SqliteDatabase(databaseFilename(instanceRoot), { requireMigrationHistory: true });
    try {
      const rows = [...input.rows, ...Array.from({ length: input.bulkCount }, (_, index) => ({ key: 'bulk-' + index,
        user: ['admin', 'ordinary', 'empty'][index % 3], Name: 'Bulk ' + String(index).padStart(4, '0'),
        Overview: 'Bulk details ' + index, ShortOverview: 'Bulk digest ' + index, Type: 'Bulk.Activity',
        DateCreated: new Date(Date.UTC(2026, 9, 19) + index * 1000).toISOString().replace('T', ' ').replace('.000Z', ''),
        LogSeverity: index % 7 }))];
      reader.transaction(() => {
        reader.database.exec('DELETE FROM "ActivityLogs"');
        rows.forEach((row, index) => {
          const { user, key: rowKey, ...values } = row, Id = 10000 + index;
          const userId = user === 'empty' ? '00000000000000000000000000000000'
            : user === 'missing' ? 'aaaaaaaa111122223333444444444444' : identities[user].id;
          seedIds.push(Id);
          reader.insert('ActivityLogs', postgresTestRow('ActivityLogs', { ...values, Id, UserId: nativeGuid(userId), RowVersion: 1n }));
        });
      });
      report.seedRows = sqliteRows(); assert.equal(report.seedRows.length, input.rows.length + input.bulkCount);
    } finally { reader.close(); reader = undefined; }
    const baseline = path.join(root, 'baseline.db'); await stoppedDatabase(databaseFilename(instanceRoot));
    await copyFile(databaseFilename(instanceRoot), baseline); report.baselineSha256 = sha(await readFile(baseline));
    native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label: 'native-activity-matrix', origin });
    await native.ready(); await idle();
    // Only this owned clone is changed. Startup activity is outside the fixed
    // GET input, so remove it after real host startup instead of mocking clocks.
    reader = new SqliteDatabase(databaseFilename(instanceRoot), { requireMigrationHistory: true });
    reader.database.exec(`DELETE FROM "ActivityLogs" WHERE "Id" NOT IN (${seedIds.join(',')})`);
    reader.close(); reader = new SqliteDatabase(databaseFilename(instanceRoot), { readOnly: true, requireMigrationHistory: true });
    assert.deepEqual(sqliteRows(), report.seedRows); await runCases('native', sqliteRows);
    reader.close(); reader = undefined; await stopNative('native-activity-matrix');
    reader = new SqliteDatabase(databaseFilename(instanceRoot), { readOnly: true, requireMigrationHistory: true });
    report.states.native.afterShutdown = persisted(reader.rows('ActivityLogs', { whereIn: { Id: seedIds } }));
    assert.deepEqual(report.states.native.afterShutdown, report.seedRows); reader.close(); reader = undefined;
    const ancestors = path.join(root, 'empty-ancestors'); await mkdir(ancestors);
    const style = process.platform === 'win32' ? 'windows' : 'posix', caseSensitive = style === 'posix';
    const contract = { mounts: [{ mountId: 'activity-instance', identityRoot: root, accessRoot: '/activity-instance', pathStyle: style,
      caseSensitive, returnPolicy: 'required' }] };
    await writeFile(path.join(root, 'storage.json'), JSON.stringify({
      instances: [{ id: 'activity-instance', type: 'local', config: { root, writable: true } },
        { id: 'empty-ancestors', type: 'local', config: { root: ancestors, writable: false } }],
      mounts: [{ path: '/activity-instance', instanceId: 'activity-instance', capabilities: {} },
        { path: '/empty-ancestors', instanceId: 'empty-ancestors', capabilities: {} }],
      prefixes: [{ identityRoot: root, accessRoot: '/activity-instance', style, caseSensitive,
        returnAccess: 'The owned activity HTTP instance and its internal metadata.' }],
      ignorePrefixes: [{ identityRoot: path.parse(root).root, accessRoot: '/empty-ancestors', style, caseSensitive,
        returnAccess: 'Declared empty ancestors of the isolated activity instance.' }],
    }, null, 2) + '\n');
    database = await createPostgresTestDatabase(null, 'activity_http');
    reader = new SqliteDatabase(baseline, { readOnly: true, requireMigrationHistory: true });
    try {
      report.imported = await transferDatabase(reader, database, { instanceBinding: { serverId: current.preparation.nativeServerId,
        originIdentityDigest: report.baselineSha256 }, portableMountContract: contract });
      assert.deepEqual(await databaseDigest(database), await databaseDigest(reader));
    } finally { reader.close(); reader = undefined; }
    runtime = await startProductionInstance({ environment: { ...process.env, MEDIAMANAGER_INSTANCE: instanceRoot,
      MEDIAMANAGER_POSTGRES: process.env.MEDIAMANAGER_TEST_POSTGRES, MEDIAMANAGER_POSTGRES_SCHEMA: database.schemaName,
      MEDIAMANAGER_STORAGE: path.join(root, 'storage.json') },
      onError: error => report.diagnostics.push({ name: error.name, code: error.code, message: error.message }) });
    report.registeredRoutes = runtime.implementedRoutes.filter(route => route.includes('/System/ActivityLog/'));
    await idle(); assert.deepEqual(await pgRows(), report.seedRows); await runCases('node', pgRows);
    for (const sample of input.cases) {
      const expected = report.native.find(row => row.name === sample.name), actual = report.node.find(row => row.name === sample.name);
      try { assert.deepEqual(actual.functional, expected.functional); }
      catch (error) { report.mismatches.push({ name: sample.name, message: error.message }); }
    }
    assert.deepEqual(report.mismatches, []);
    assert.deepEqual(report.nativeExpectations, []);
    // Use real HTTP sockets and a large stored result to exercise disconnect
    // and shutdown while a consumer has stopped reading. No SQL plan/counter
    // or private cursor representation controls the assertion.
    await database.client.query(`INSERT INTO ${q(database.schemaName)}."ActivityLogs"
      ("Name", "Overview", "ShortOverview", "Type", "ItemId", "DateCreated", "UserId", "LogSeverity", "RowVersion")
      SELECT convert_to(repeat('N', 490) || i::text, 'UTF8'), convert_to(repeat('O', 512), 'UTF8'),
        convert_to(repeat('S', 512), 'UTF8'), convert_to('Lifecycle.Activity', 'UTF8'), NULL,
        convert_to('2026-10-21 00:00:00', 'UTF8'), convert_to('00000000-0000-0000-0000-000000000000', 'UTF8'), 2, 1
      FROM generate_series(1, 13000) i`);
    const disconnected = await openSlowResponse('client-disconnect'); assert.equal(disconnected.observation.status, 200);
    report.disconnect = disconnected.observation; disconnected.pending.destroy(); disconnected.response.destroy();
    await timeout(disconnected.closed, 'Disconnected activity socket');
    const subsequent = await request('/System/ActivityLog/Entries?type=Lifecycle.Activity&limit=1');
    assert.equal(subsequent.status, 200); assert.equal(subsequent.json.TotalRecordCount, 13000); assert.equal(subsequent.json.Items.length, 1);
    report.disconnect.subsequent = projection(subsequent);
    const slow = await openSlowResponse('shutdown-with-slow-consumer'); assert.equal(slow.observation.status, 200);
    report.shutdown = slow.observation;
    try {
      const listeners = runtime.networkHost.listeners;
      await timeout(runtime.close(), 'Production activity owner shutdown'); runtime = undefined;
      await timeout(slow.closed, 'Shutdown activity socket');
      assert.ok(listeners.every(listener => !listener.server.listening)); assert.equal(await portAvailable(port), true);
      report.cleanup.push({ runtimeClosed: true, portAvailable: true, slowConsumerReleased: true });
    } finally { slow.pending.destroy(); slow.response.destroy(); }
    report.states.node.afterShutdown = persisted(await database.rows('ActivityLogs', { whereIn: { Id: seedIds } }));
    assert.deepEqual(report.states.node.afterShutdown, report.seedRows);
    assert.equal(sha(await readFile(baseline)), report.baselineSha256);
  } catch (error) { failure = error; report.failure = { name: error.name, code: error.code, message: error.message, stack: error.stack }; }
  finally {
    const attempt = async operation => { try { await operation(); } catch (error) {
      failure ??= error; report.cleanup.push({ error: { name: error.name, code: error.code, message: error.message } });
    } };
    await attempt(() => { reader?.close(); reader = undefined; });
    await attempt(() => stopNative('native-finally'));
    await attempt(async () => {
      if (!runtime) return;
      const listeners = runtime.networkHost.listeners; await runtime.close(); runtime = undefined;
      assert.ok(listeners.every(listener => !listener.server.listening)); assert.equal(await portAvailable(port), true);
      report.cleanup.push({ runtimeClosed: true, portAvailable: true });
    });
    if (!runtime) await attempt(async () => {
      if (database) { await dropPostgresTestDatabase(database); report.cleanup.push({ postgresSchemaRemoved: true }); }
    });
    else { safeToRemove = false; await attempt(() => database?.close()); }
    await attempt(async () => {
      if (current) { await current.finish(); report.preservedStoppedInput = true; }
    });
    report.passed = !failure;
    await writeFile(path.join(root, 'report.json'), filterEvidenceJson(report, secrets));
    await writeFile(path.join(root, 'provenance.json'), filterEvidenceJson({ inputSha256: sha(inputBytes), sourceBindings: report.sourceBindings,
      actualNativeHttp: report.native.length === input.cases.length, productionNodeHttp: report.node.length === input.cases.length,
      registeredRoutes: report.registeredRoutes, preservedStoppedInput: report.preservedStoppedInput,
      fullInstanceVerified: false, completeLibraryVerified: false, phaseAcceptance: false, releaseAcceptance: false }, secrets));
    if (native || runtime) safeToRemove = false;
    if (safeToRemove) await attempt(() => output.publishAndClose());
    else {
      await mkdir(destination); await writeFile(path.join(destination, 'report.json'), filterEvidenceJson({ ...report, privateRootRetained: true }, secrets));
      failure ??= new Error('The owned ActivityLog HTTP fixture did not release its private root.');
    }
  }
  if (failure) throw output.publicError(failure);
}, { signal: t.signal })));
