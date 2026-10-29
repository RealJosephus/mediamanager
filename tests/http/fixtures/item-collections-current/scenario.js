import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { nativeModel } from '../../../../src/database/model.js';
import { stringifyNativeJson } from '../../../../src/core/json.js';
import { dateTicks, idKey } from '../../../../src/library/records.js';
import { SqliteDatabase } from '../../../../src/database/sqlite.js';
import { PostgresDatabase } from '../../../../src/database/postgres.js';
import { transferDatabase } from '../../../../src/migration/database-transfer.js';
import { createTestRuntime } from '../../../helpers/runtime.js';
import { projectItemBody, projectProblemTrace } from '../../../helpers/http-body-projection.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../../../database/postgres-fixture.js';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function errorRecord(reason, ancestors = new Set()) {
  if (reason === null || !['object', 'function'].includes(typeof reason)) return { reasonType: reason === null ? 'null' : typeof reason,
    ...(reason === undefined ? { undefinedValue: true } : { value: ['bigint', 'symbol'].includes(typeof reason) ? String(reason) : reason }) };
  if (ancestors.has(reason)) return { circularReference: true };
  const nested = new Set(ancestors).add(reason), value = entry => entry !== null && ['object', 'function', 'bigint', 'symbol'].includes(typeof entry)
    ? errorRecord(entry, nested) : entry;
  if (Array.isArray(reason)) return reason.map(value);
  const record = Object.fromEntries(Object.entries(reason).map(([key, entry]) => [key, value(entry)]));
  if (reason instanceof Error) {
    Object.assign(record, { name: reason.name, message: reason.message, stack: reason.stack });
    for (const key of ['status', 'code']) if (key in reason) record[key] = value(reason[key]);
    if ('cause' in reason) record.cause = errorRecord(reason.cause, nested);
    if (Array.isArray(reason.errors)) record.errors = reason.errors.map(entry => errorRecord(entry, nested));
  }
  return record;
}
export async function within(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), 30000); })]); }
  finally { clearTimeout(timer); }
}
export function project(value) {
  // Full timestamp value, including every 100ns tick, is retained. Native wire
  // and the PostgreSQL date writer need not use the same zero-fraction spelling.
  return projectItemBody(value, { date: value => ({ ticks: dateTicks(value).toString() }) });
}
export const wire = response => ({ status: response.status, contentType: response.contentType, allow: response.allow,
  body: response.json === undefined || response.json === null && response.body !== 'null' ? response.body : project(projectProblemTrace(response.json, response.status)) });
export async function files(root) {
  const entries = {};
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name), relative = path.relative(root, filename).replaceAll('\\', '/');
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) await visit(filename);
      else { assert.equal(entry.isFile(), true); const bytes = await readFile(filename); entries[relative] = { bytes: bytes.length, sha256: sha(bytes) }; }
    }
  }
  await visit(root); return entries;
}
export async function rows(database) {
  const result = {};
  for (const table of nativeModel.tables) {
    const values = (await database.rows(table.name)).map(row => stringifyNativeJson(row)).sort();
    result[table.name] = { count: values.length, sha256: sha(JSON.stringify(values)) };
  }
  return result;
}
export async function prepareDirectories(root) {
  for (const name of ['root/default/A', 'root/default/B', 'data/playlists', 'data/collections', 'metadata', 'cache', 'config', 'media/A', 'media/B', 'neutral'])
    await mkdir(path.join(root, name), { recursive: true });
  for (const name of ['A', 'B']) await writeFile(path.join(root, 'root/default', name, 'options.xml'),
    '<LibraryOptions><Enabled>true</Enabled><EnableRealtimeMonitor>false</EnableRealtimeMonitor><PathInfos /></LibraryOptions>');
  await writeFile(path.join(root, 'config/system.xml'), '<ServerConfiguration><IsStartupWizardCompleted>true</IsStartupWizardCompleted><UICulture>en-US</UICulture><EnableCaseSensitiveItemIds>true</EnableCaseSensitiveItemIds><MetadataCountryCode>US</MetadataCountryCode></ServerConfiguration>');
}
export async function removePrivateRoot(root, parent, prefix) {
  root = path.resolve(root); parent = path.resolve(parent);
  assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith(prefix));
  assert.equal(await realpath(parent), parent);
  async function inspect(filename) {
    const stat = await lstat(filename); assert.equal(stat.isSymbolicLink(), false);
    assert.equal(await realpath(filename), filename);
    if (stat.isDirectory()) for (const name of await readdir(filename)) await inspect(path.join(filename, name));
    else assert.equal(stat.isFile(), true);
  }
  await inspect(root); await rm(root, { recursive: true }); await assert.rejects(lstat(root), { code: 'ENOENT' });
}

/** The first actual native recorder's stopped controlled database is the only
 * media/user/relation seed. transferDatabase preserves its real schema envelope;
 * no hand-built PostgreSQL item substitute or hidden setState is used. */
export async function openScenario(input, seedFilename, report, rootIds) {
  let database, runtime, source, closing, held, currentCase;
  const owners = [], errors = report.runtimeErrors = [], queries = report.queries = [];
  const queryTimings = report.queryTimings = [], slowQueries = report.slowQueries = [];
  const requestTimings = report.requestTimings = [];
  const explainPlans = report.explainPlans = [], explained = new Set(), recentSlowReads = new WeakMap();
  const timedOutCases = new Set();
  const slowQueryThresholdMs = 1000;
  report.queryTimingPolicy = { clock: 'performance.now', slowQueryThresholdMs,
    timedSqlOnlyForSlowOrFailed: true, timedParametersRetained: false, controlledGateExcludedFromSqlDuration: true,
    recentSlowReadParameters: 'Only the latest successful slow read is retained in memory per active operation session.',
    explainAnalyze: 'Before the next SQL dispatch after that case has actually exceeded its original HTTP deadline: replay its latest successful slow read once per SQL hash through the same still-owned physical session. CREATE TEMP TABLE AS replays only its read projection.' };
  const readProjection = text => {
    const statement = text.replace(/^\s*\/\*[\s\S]*?\*\//u, '').trimStart();
    const read = statement.replace(/^CREATE TEMP TABLE "mm_recordings_[0-9a-f]+" AS\s+/u, '');
    // Replay only these generated read plans, never arbitrary WITH statements
    // that could contain writes or acquire a second advisory lock.
    const knownRead = read !== statement || /^WITH RECURSIVE (?:native_visibility_input\(|requested AS \()/u.test(read)
      || /^\/\* (?:page-relationship-graph|item-collections-result-page) \*\//u.test(text);
    return knownRead ? { readText: read, readProjectionOnly: read !== statement } : null;
  };
  const tokens = {}, credentials = new Set([process.env.MEDIAMANAGER_TEST_POSTGRES]);
  const root = input.root, metadata = { Client: 'Collections current', Device: 'Isolated', DeviceId: 'collections-current', Version: '1' };
  const authorization = token => 'MediaBrowser Client="' + metadata.Client + '", Device="' + metadata.Device + '", DeviceId="' + metadata.DeviceId + '", Version="1"' + (token ? ', Token="' + token + '"' : '');
  let originalQuery;
  const close = () => closing ??= (async () => {
    held?.release.resolve();
    const failures = [], attempt = async action => { try { await action(); } catch (error) { failures.push(error); } };
    for (const owner of owners.splice(0)) await attempt(() => owner.release());
    await attempt(() => runtime?.linkedChildren.flushReleases());
    await attempt(() => runtime?.close());
    if (database && originalQuery) database.client.query = originalQuery;
    await attempt(() => source?.close()); await attempt(() => dropPostgresTestDatabase(database));
    if (failures.length) throw new AggregateError(failures, 'Collections PostgreSQL/runtime owners failed to close.');
  })();
  const safe = value => {
    let text = stringifyNativeJson(value);
    for (const secret of credentials) if (secret) text = text.replaceAll(secret, '[fixture-secret]');
    return text;
  };
  try {
    source = new SqliteDatabase(seedFilename, { readOnly: true, requireMigrationHistory: true });
    database = await createPostgresTestDatabase(null, 'item_collections');
    const style = process.platform === 'win32' ? 'windows' : 'posix';
    const mountContract = { mounts: [{ mountId: 'collections', identityRoot: root, accessRoot: '/collections', pathStyle: style,
      caseSensitive: process.platform !== 'win32', returnPolicy: 'required' }] };
    report.transfer = await transferDatabase(source, database, { instanceBinding: { serverId: input.serverId, originIdentityDigest: sha(await readFile(seedFilename)) }, portableMountContract: mountContract });
    source.close(); source = undefined;
    const storageFilename = path.join(root, 'config/storage.json');
    await writeFile(storageFilename, JSON.stringify({
      instances: [{ id: 'collections', type: 'local', config: { root, writable: true } }],
      mounts: [{ path: '/collections', instanceId: 'collections', root: '/', capabilities: {
        create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true, conditionalWrite: false,
      } }],
      prefixes: [{ identityRoot: root, accessRoot: '/collections', style, caseSensitive: process.platform !== 'win32', purpose: 'library', returnAccess: 'Same isolated absolute identity for both real repositories.' }],
    }));
    runtime = await createTestRuntime({ database, serverId: input.serverId, programDataPath: root, dataPath: path.join(root, 'data'), metadataPath: path.join(root, 'metadata'),
      configurationDirectoryPath: path.join(root, 'config'), configuration: { IsStartupWizardCompleted: true, UICulture: 'en-US', MetadataCountryCode: 'US', EnableCaseSensitiveItemIds: true },
      portableMountContract: mountContract, storageConfiguration: storageFilename,
      onError: error => errors.push({ case: currentCase ?? null, ...errorRecord(error) }) });
    const hostLockFilename = path.join(root, 'plugins', 'node', 'host.lock');
    assert.equal(runtime.plugins.directory, path.dirname(hostLockFilename));
    const lockBytes = await readFile(hostLockFilename);
    report.pluginHostLease = { path: 'plugins/node/host.lock', filename: hostLockFilename,
      pid: process.pid, bytes: lockBytes.length, sha256: sha(lockBytes),
      implementation: { path: 'src/plugins/host.js', sha256: sha(await readFile(new URL('../../../../src/plugins/host.js', import.meta.url))) },
      observedAt: new Date().toISOString(), diagnosticOnly: true };
    const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}`;
    // Native authentication supplies a controlled principal. Keep this lane's
    // real token authentication from advancing its unrelated activity clock.
    const authenticationInstant = Date.now();
    runtime.authentication.now = () => new Date(authenticationInstant);
    report.authenticationClock = { fixedUtc: new Date(authenticationInstant).toISOString(),
      scope: 'Isolated token setup and authentication only; real HTTP deadlines and SQL timing remain unchanged.',
      deviceActivityRowsExcluded: false };
    for (const user of input.users) {
      const password = 'Controlled Collections ' + user.key + ' password'; credentials.add(password);
      await runtime.users.changePassword(user.id, password);
      const login = await runtime.authentication.login({ Username: user.name, Pw: password }, metadata, { remoteEndPoint: '127.0.0.1' });
      tokens[user.key] = login.AccessToken; credentials.add(login.AccessToken);
      assert.equal(login.User.Id.replaceAll('-', '').toLowerCase(), user.id.replaceAll('-', ''));
    }
    tokens.apiKey = (await runtime.apiKeys.create('Collections current HTTP')).AccessToken; credentials.add(tokens.apiKey);
    originalQuery = database.client.query;
    database.client.query = async (...args) => {
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
      const values = typeof args[0] === 'string' ? args[1] : args[0]?.values;
      const comment = text.match(/\/\* ([^*]+) \*\//u)?.[1] ?? null;
      const admittedAt = performance.now();
      const session = database.root.operationContext.getStore();
      const visibilityItems = text.includes('native_visibility_input("Id","OfficialRating","CustomRating","LibraryFolderIds")')
        && Array.isArray(values?.[0]) ? values[0].length : null;
      const timing = currentCase ? { ordinal: queryTimings.length + 1, case: currentCase, comment,
        textSha256: sha(text), textLength: text.length, parameterCount: Array.isArray(values) ? values.length : 0,
        ...(visibilityItems === null ? {} : { visibilityItems }),
        admittedAt: new Date().toISOString(), status: 'waiting' } : null;
      if (timing) queryTimings.push(timing);
      let dispatchedAt, queryFailed = false;
      try {
        if (held && text.includes('/* item-collections-manual-parents */') && !held.enteredOnce) {
          const gateStartedAt = performance.now();
          held.enteredOnce = true; held.entered.resolve(); await held.release.promise;
          if (timing) timing.controlledGateMs = performance.now() - gateStartedAt;
        }
        const recent = session?.connectionActive ? recentSlowReads.get(session) : undefined;
        const explainKey = recent && timing ? timing.case + '\0' + recent.textSha256 : null;
        if (timing && timedOutCases.has(timing.case) && recent?.case === timing.case && !explained.has(explainKey)) {
          explained.add(explainKey);
          const capture = { case: recent.case, ordinal: recent.ordinal, textSha256: recent.textSha256,
            text: recent.text, readText: recent.readText, readProjectionOnly: recent.readProjectionOnly,
            parameterCount: recent.values?.length ?? 0, observedDurationMs: recent.durationMs,
            observedFinishedAt: recent.finishedAt, beforeDispatchOrdinal: timing.ordinal,
            startedAt: new Date().toISOString() };
          explainPlans.push(capture);
          const started = performance.now();
          try {
            const result = await session.client.physicalClient.query({
              text: 'EXPLAIN (ANALYZE, BUFFERS, TIMING TRUE, SETTINGS, FORMAT JSON) ' + recent.readText, values: recent.values });
            capture.plan = result.rows[0]['QUERY PLAN'];
          } catch (error) { capture.error = errorRecord(error); }
          finally {
            capture.durationMs = performance.now() - started; capture.finishedAt = new Date().toISOString();
            timing.afterDeadlineExplainMs = capture.durationMs;
          }
        }
        dispatchedAt = performance.now();
        if (timing) { timing.status = 'running'; timing.dispatchedAt = new Date().toISOString(); }
        const result = await originalQuery(...args);
        if (timing) { timing.status = 'completed'; timing.returned = result.rows?.length ?? 0;
          timing.rowCount = result.rowCount ?? null; timing.command = result.command ?? null; }
        if (timing && (/item-collections-/u.test(text) || /page-relationship-graph/u.test(text))) {
          queries.push({ case: timing.case, comment: comment ?? 'relationship', text, values, returned: result.rows?.length ?? 0,
            ...(comment === 'item-collections-count' ? { count: Number(result.rows[0].count) } : {}) });
        }
        return result;
      } catch (error) {
        queryFailed = true;
        if (timing) { timing.status = 'failed'; timing.error = errorRecord(error); }
        throw error;
      } finally {
        if (timing) {
          timing.durationMs = dispatchedAt === undefined ? null : performance.now() - dispatchedAt;
          timing.elapsedMs = performance.now() - admittedAt;
          timing.finishedAt = new Date().toISOString();
          if (queryFailed || timing.durationMs >= slowQueryThresholdMs) {
            slowQueries.push({ ordinal: timing.ordinal, textSha256: timing.textSha256, text });
          }
          if (!queryFailed && session?.connectionActive && timing.durationMs >= slowQueryThresholdMs) {
            const projection = readProjection(text);
            if (projection) recentSlowReads.set(session, { case: timing.case, ordinal: timing.ordinal,
              textSha256: timing.textSha256, text, ...projection, values, durationMs: timing.durationMs, finishedAt: timing.finishedAt });
          }
        }
      }
    };
    const request = async (route, auth = 'all') => {
      route = route.replaceAll('$user-root', idKey(rootIds['user-root']));
      const caseName = currentCase, signal = AbortSignal.timeout(30000);
      const startedAt = performance.now(), observation = { case: caseName, route, auth,
        startedAt: new Date().toISOString(), deadlineMs: 30000 };
      requestTimings.push(observation);
      const timeout = () => timedOutCases.add(caseName);
      signal.addEventListener('abort', timeout, { once: true });
      try {
        const response = await fetch(origin + route, { signal, headers: { Accept: 'application/json', Authorization: authorization(tokens[auth]) } });
        observation.status = response.status;
        const body = await response.text(); let json;
        try { json = JSON.parse(body); } catch { /* Keep complete non-JSON error body. */ }
        return { route, status: response.status, contentType: response.headers.get('content-type'), allow: response.headers.get('allow') ?? '', body, ...(json === undefined ? {} : { json }) };
      } catch (error) { observation.error = errorRecord(error); throw error; }
      finally {
        observation.elapsedMs = performance.now() - startedAt;
        observation.finishedAt = new Date().toISOString();
        signal.removeEventListener('abort', timeout);
      }
    };
    const snapshot = async () => ({ database: await rows(database), files: await files(root) });
    const run = async sample => {
      currentCase = sample.name;
      if (sample.warm) {
        const item = await runtime.itemCreation.getItemById(sample.warm.id); assert.ok(item); owners.push(runtime.itemCreation.retainItem(item));
        for (const [source, field] of [['name', 'Name'], ['sort', 'SortName'], ['officialRating', 'OfficialRating'], ['customRating', 'CustomRating'], ['libraryFolderIds', 'LibraryFolderIds']])
          if (Object.hasOwn(sample.warm, source)) item[field] = sample.warm[source];
      }
      return await request(sample.path, sample.auth);
    };
    const drain = async sample => {
      const preShutdownLock = await readFile(hostLockFilename);
      assert.deepEqual(preShutdownLock, lockBytes); assert.equal(sha(preShutdownLock), report.pluginHostLease.sha256);
      report.pluginHostLease.preShutdownIdentityUnchanged = true;
      held = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
      let pending, libraryClosing, runtimeClosing, libraryDone = false, runtimeDone = false;
      try {
        currentCase = 'held SQL close'; pending = request(sample.path); void pending.catch(() => {});
        await within(held.entered.promise, 'actual admitted collection manual relation SQL');
        libraryClosing = runtime.library.close(); libraryClosing.then(() => { libraryDone = true; }, () => { libraryDone = true; });
        const user = await runtime.users.getUser(input.users[0].id);
        await assert.rejects(runtime.library.getItemCollections(input.target, { user }), { status: 503 });
        // The runtime still owns its real item cache. Release this fixture's
        // additional retention before asking that owner to close and drain.
        for (const owner of owners.splice(0)) owner.release();
        await runtime.linkedChildren.flushReleases();
        runtimeClosing = runtime.close(); runtimeClosing.then(() => { runtimeDone = true; }, () => { runtimeDone = true; });
        assert.equal((await request(sample.path)).status, 503);
        assert.equal(libraryDone, false); assert.equal(runtimeDone, false);
        held.release.resolve();
        const response = await within(pending, 'held actual collection HTTP'); assert.equal(response.status, 200);
        await within(libraryClosing, 'collection SQL/cohort drain'); await within(runtimeClosing, 'production runtime drain');
        assert.equal(database.closed, true); assert.equal(runtime.networkHost.listeners.some(listener => listener.server.listening), false);
        await assert.rejects(lstat(hostLockFilename), { code: 'ENOENT' });
        report.pluginHostLease.removedAfterRuntimeClose = true; report.pluginHostLease.removedAt = new Date().toISOString();
        const reopened = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema: database.schemaName });
        let afterShutdown;
        try { afterShutdown = { database: await rows(reopened), files: await files(root) }; }
        finally { await reopened.close(); }
        return { response, directAdmissionRejected: true, httpAdmissionRejected: true, activeQueryCompleted: true, libraryDrained: libraryDone, runtimeDrained: runtimeDone,
          databaseClosed: database.closed, pluginHostLeaseRemoved: true, independentReopenedConnectionClosed: reopened.closed, afterShutdown };
      } finally {
        held.release.resolve(); await Promise.allSettled([pending, libraryClosing, runtimeClosing]); held = undefined;
      }
    };
    return { database, runtime, run, request, snapshot, drain, close, safe, errors, queries };
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Collections preparation and owner cleanup failed.', { cause: error }); }
    throw error;
  }
}
