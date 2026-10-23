import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { copyFile, cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { WebSocket } from 'ws';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot, assertValidationOutputChild } from '../../tools/validation/paths.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { transferDatabase, exportCurrentSqlite } from '../../src/migration/database-transfer.js';
import { nativeGuid } from '../../src/users/native.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { sha, idKey, databaseFilename, unusedPort, portAvailable, fileIdentity, stoppedDatabase, completeSnapshot,
  removeSyntheticPreparation, installStoppedExport, canonicalUtc, publicUserData, storedUtc } from './fixtures/date-roundtrip-current/scenario.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const profileUrl = new URL('./fixtures/date-roundtrip-current/current-profile.json', import.meta.url);
let pending;
export const currentDateRoundtrip = () => pending ??= capture();

async function capture() {
  const profile = JSON.parse(await readFile(profileUrl, 'utf8'));
  const outputRoot = path.join(validationOutputRoot(), 'date-roundtrip-current-' + randomUUID());
  assertValidationOutputChild(outputRoot); await mkdir(outputRoot);
  const captureReport = { schemaVersion: 1, scope: profile.scope, inputs: [], sourceBindings: [],
    phaseAcceptance: false, releaseAcceptance: false };
  try {
    for (const expected of profile.inputs) {
      const actual = await describeFile(fileURLToPath(new URL(expected.filename, profileUrl)));
      assert.equal(actual.available, true, expected.filename); assert.equal(actual.bytes, expected.bytes, expected.filename);
      assert.equal(actual.sha256, expected.sha256, expected.filename); captureReport.inputs.push({ role: expected.role, ...actual });
    }
    const inputFilename = fileURLToPath(new URL('input.json', profileUrl)), inputBytes = await readFile(inputFilename);
    const input = JSON.parse(inputBytes);
    assert.equal(input.cases.length, profile.cases); assert.equal(input.zones.length, profile.zones);
    assert.equal(new Set(input.cases.map(value => value.name)).size, input.cases.length);
    const build = await verifyNativeBuild();
    captureReport.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const manifest = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    for (const relative of profile.sourcePaths) {
      const pinned = manifest.files.find(entry => entry.path === relative); assert.ok(pinned, relative);
      const source = await describeFile(path.join(build.root, 'source', relative)); assert.equal(source.sha256, pinned.sha256, relative);
      captureReport.sourceBindings.push({ relativePath: relative, source });
    }
    const nativeRoot = path.join(outputRoot, 'native-date-consumer');
    const project = fileURLToPath(new URL('Oracle.csproj', profileUrl));
    const record = await recordOracle({ project, output: nativeRoot, args: [inputFilename, '{output}/native.json'] });
    const observationFile = path.join(nativeRoot, 'native.json'), nativeBytes = await readFile(observationFile), oracle = JSON.parse(nativeBytes);
    captureReport.native = { record, observation: await describeFile(observationFile) };
    assert.equal(record.passed, true); assert.equal(oracle.actualExecution, true); assert.equal(oracle.inputSha256, sha(inputBytes));
    assert.equal(record.outputs.find(value => value.filename === observationFile)?.sha256, sha(nativeBytes));
    assert.deepEqual(oracle.observations.map(value => value.name), input.cases.map(value => value.name));
    for (const assembly of oracle.assemblies) {
      const actual = await describeFile(path.join(build.runtime, assembly.name + '.dll'));
      assert.equal(actual.available, true); assert.equal(actual.sha256, assembly.sha256, assembly.name);
    }
    const exchange = await runExchange({ input, inputBytes, inputFilename, oracle, outputRoot, sourcePaths: profile.sourcePaths });
    captureReport.actualHttpExchange = exchange.passed;
    return { input, oracle, exchange, outputRoot };
  } catch (error) { captureReport.failure = { name: error.name, message: error.message, stack: error.stack }; throw error; }
  finally { await writeFile(path.join(outputRoot, 'capture-report.json'), filterEvidenceJson(captureReport)); }
}

async function runExchange({ input, inputBytes, inputFilename, oracle, outputRoot, sourcePaths }) {
  const destination = path.join(outputRoot, 'exchange'), output = await createPrivateFilterOutput(destination);
  const secrets = new Set([process.env.MEDIAMANAGER_TEST_POSTGRES].filter(Boolean));
  output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  await mkdir(output.root);
  const root = await realpath(output.root), instanceRoot = path.join(root, 'instance');
  const nativePort = await unusedPort(), nativeOrigin = `http://127.0.0.1:${nativePort}`;
  const report = { schemaVersion: 1, inputSha256: sha(inputBytes), requests: [], notifications: [], cleanup: [], errors: [], zones: [],
    nativeTimezone: oracle.timezone, snapshots: {}, phaseAcceptance: false, releaseAcceptance: false,
    fullInstanceVerified: false, completeLibraryVerified: false,
    scope: 'Eight actual scanned Photos provide UserData targets. Current Native HTTP and three separate Node timezone processes write full 100ns dates; complete SQLite/PostgreSQL transfers, cold reads and actual Native continuation are verified. This does not establish arbitrary libraries, a complete state package or release acceptance.' };
  let current, native, node, database, returnedDatabase, sqlite, failure, token, ids, notifications;
  let safeToRemove = true;
  const request = async (origin, route, { method = 'GET', body } = {}) => {
    const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(30000),
      headers: { Authorization: `MediaBrowser Token="${token}"`, Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const bodyText = await response.text(); let bodyJson;
    try { if (bodyText) bodyJson = JSON.parse(bodyText); } catch { /* Retain original non-JSON failure bodies. */ }
    const result = { status: response.status, contentType: response.headers.get('content-type'), bodyText,
      ...(bodyJson === undefined ? {} : { bodyJson }) };
    report.requests.push({ origin, route, method, ...(body === undefined ? {} : { body }), response: result });
    return result;
  };
  const idleTasks = async origin => {
    const deadline = Date.now() + 90000;
    while (true) {
      const response = await request(origin, '/ScheduledTasks'); assert.equal(response.status, 200);
      if (response.bodyJson.every(task => !['Running', 'Cancelling'].includes(task.State))) return response.bodyJson;
      assert.ok(Date.now() < deadline, 'Scheduled workers must stop before ownership transfer.'); await delay(100);
    }
  };
  const startNativeNotifications = async label => {
    assert.equal(notifications, undefined);
    const observation = { label, userId: current.userId, opened: false, messages: [], errors: [], batches: [] };
    report.notifications.push(observation);
    const socket = new WebSocket(nativeOrigin.replace(/^http/u, 'ws') + '/socket?deviceId=fixture-oracle', {
      headers: { Authorization: `MediaBrowser Client="CompatibilityValidation", Device="IsolatedReference", DeviceId="fixture-oracle", Version="1.0", Token="${token}"` },
      handshakeTimeout: 10000,
    });
    const listeners = new Set(), changed = () => { for (const listener of listeners) listener(); };
    const closed = new Promise(resolve => socket.once('close', (code, reason) => {
      observation.close = { code, reason: reason.toString(), at: new Date().toISOString() }; changed(); resolve();
    }));
    notifications = { socket, observation, closed, waitFor: (predicate, description) => new Promise((resolve, reject) => {
      let timeout;
      const done = error => { clearTimeout(timeout); listeners.delete(inspect); error ? reject(error) : resolve(); };
      const inspect = () => {
        try {
          if (observation.errors.length) return done(new Error(label + ': ' + observation.errors[0].message));
          if (predicate()) return done();
          if (observation.close) return done(new Error(label + ' closed before ' + description));
        } catch (error) { done(error); }
      };
      listeners.add(inspect);
      timeout = setTimeout(() => done(new Error(label + ' did not receive ' + description + ' within 30 seconds.')), 30000);
      inspect();
    }) };
    socket.on('open', () => { observation.opened = true; changed(); });
    socket.on('error', error => { observation.errors.push({ name: error.name, message: error.message }); changed(); });
    socket.on('message', bytes => {
      const raw = bytes.toString(), entry = { receivedAt: new Date().toISOString(), raw }; observation.messages.push(entry);
      try {
        entry.message = JSON.parse(raw);
        if (entry.message.MessageType === 'ForceKeepAlive' && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ MessageType: 'KeepAlive' }));
        }
      } catch (error) { observation.errors.push({ name: error.name, message: error.message }); }
      changed();
    });
    await notifications.waitFor(() => observation.opened
      && observation.messages.some(entry => entry.message?.MessageType === 'ForceKeepAlive'), 'authenticated session readiness');
  };
  const drainNativeNotifications = async (start, expected) => {
    const active = notifications, batch = { messageStart: start, expected, observed: [], complete: false };
    active.observation.batches.push(batch);
    const expectedById = new Map(expected.map(value => [idKey(value.ItemId), { ...value, ItemId: idKey(value.ItemId) }]));
    await active.waitFor(() => {
      const latest = new Map();
      for (const entry of active.observation.messages.slice(start)) {
        const message = entry.message;
        if (message?.MessageType !== 'UserDataChanged' || idKey(message.Data?.UserId ?? '') !== idKey(current.userId)) continue;
        for (const value of message.Data.UserDataList ?? []) {
          const id = idKey(value.ItemId ?? '');
          if (expectedById.has(id)) latest.set(id, { ...publicUserData(value), ItemId: id });
        }
      }
      batch.observed = ids.filter(id => latest.has(id)).map(id => latest.get(id));
      return expectedById.size === input.cases.length
        && [...expectedById].every(([id, expectedValue]) => isDeepStrictEqual(latest.get(id), expectedValue));
    }, 'UserDataChanged for every final saved item value');
    batch.complete = true;
  };
  const stopNativeNotifications = async () => {
    if (!notifications) return;
    const closing = notifications; let timeout, forced = false;
    const waitClosed = milliseconds => Promise.race([closing.closed.then(() => true), new Promise(resolve => {
      timeout = setTimeout(() => resolve(false), milliseconds);
    })]).finally(() => clearTimeout(timeout));
    if (closing.socket.readyState === WebSocket.OPEN) closing.socket.close(1000, 'Date notifications consumed');
    else if (closing.socket.readyState === WebSocket.CONNECTING) { forced = true; closing.socket.terminate(); }
    let stopped = await waitClosed(10000);
    if (!stopped) { forced = true; closing.socket.terminate(); stopped = await waitClosed(5000); }
    report.cleanup.push({ name: closing.observation.label + '-websocket', stopped, forced,
      close: closing.observation.close, errors: closing.observation.errors });
    safeToRemove &&= stopped; if (stopped) notifications = undefined;
    assert.ok(stopped && !forced && closing.observation.close?.code === 1000
      && closing.observation.errors.length === 0, 'The Native notification reader must close normally.');
  };
  const stopNative = async label => {
    let notificationFailure;
    try { await stopNativeNotifications(); } catch (error) { notificationFailure = error; }
    if (!native) { if (notificationFailure) throw notificationFailure; return; }
    const result = await native.stop(async () => (await request(nativeOrigin, '/System/Shutdown', { method: 'POST' })).status,
      () => portAvailable(nativePort));
    report.cleanup.push({ name: label, ...result }); safeToRemove &&= result.pidGone;
    if (result.pidGone) native = undefined;
    assert.ok(result.cleanShutdown && result.pidGone && result.portAvailable, label);
    if (notificationFailure) throw notificationFailure;
  };
  const startNode = async (target, zone, label) => {
    const stdout = openSync(path.join(root, label + '-stdout.log'), 'wx');
    let stderr, child;
    try { stderr = openSync(path.join(root, label + '-stderr.log'), 'wx'); }
    catch (error) { closeSync(stdout); throw error; }
    try {
      child = spawn(process.execPath, [fileURLToPath(new URL('node-host.js', profileUrl)), inputFilename], {
        env: { ...process.env, TZ: zone.tz, MEDIAMANAGER_INSTANCE: instanceRoot,
          MEDIAMANAGER_POSTGRES: process.env.MEDIAMANAGER_TEST_POSTGRES, MEDIAMANAGER_POSTGRES_SCHEMA: target.schemaName,
          MEDIAMANAGER_STORAGE: path.join(root, 'storage.json'), MEDIAMANAGER_PORT: '0' },
        windowsHide: true, stdio: ['ignore', stdout, stderr, 'ipc'],
      });
    } catch (error) { closeSync(stdout); closeSync(stderr); throw error; }
    const messages = [], exit = new Promise(resolve => child.once('close', (code, signal) => {
      closeSync(stdout); closeSync(stderr); resolve({ code, signal });
    }));
    node = { child, messages, exit, label };
    const ready = new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', () => reject(new Error(label + ' exited before readiness.')));
      child.on('message', message => {
        messages.push(message);
        if (message.kind === 'ready') resolve(message);
        if (message.kind === 'failure') reject(new Error(message.error.message));
        if (message.kind === 'runtime-error') report.errors.push(message.error);
      });
    });
    let timeout;
    try {
      const value = await Promise.race([ready, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(label + ' did not become ready.')), 60000);
      })]);
      assert.equal(value.requestedTimezone, zone.tz);
      assert.deepEqual(value.dates.map(entry => entry.name), input.cases.map(sample => sample.name));
      node.origin = value.origin; node.port = Number(new URL(value.origin).port); node.ready = value;
      await idleTasks(value.origin); return value;
    } finally { clearTimeout(timeout); }
  };
  const stopNode = async label => {
    if (!node) return;
    const closing = node; let forced = false, timeout;
    if (closing.child.connected) closing.child.send('close');
    const result = await Promise.race([closing.exit, new Promise(resolve => {
      timeout = setTimeout(() => resolve(null), 30000);
    })]);
    clearTimeout(timeout);
    let exit = result;
    if (!exit) {
      forced = true; closing.child.kill('SIGKILL');
      exit = await Promise.race([closing.exit, delay(5000, null)]);
    }
    const stopped = Boolean(exit), released = closing.port == null || await portAvailable(closing.port);
    report.cleanup.push({ name: label, stopped, forced, exit, portAvailable: released,
      closeAcknowledged: closing.messages.some(message => message.kind === 'closed') });
    safeToRemove &&= stopped; if (stopped) node = undefined;
    assert.ok(stopped && !forced && exit.code === 0 && released && closing.messages.some(message => message.kind === 'closed'), label);
  };
  const readUserData = async (origin, expected, label) => {
    const observations = [];
    for (const [index, id] of ids.entries()) {
      const response = await request(origin, '/UserItems/' + id + '/UserData'); assert.equal(response.status, 200, label);
      assert.ok(response.contentType.startsWith('application/json'));
      assert.equal(idKey(response.bodyJson.ItemId), id);
      const body = publicUserData(response.bodyJson);
      if (expected) assert.deepEqual(body, expected[index], label + ': ' + input.cases[index].name);
      observations.push(body);
    }
    return observations;
  };
  const writeDates = async (origin, field, playCount, favorite) => {
    if (origin === nativeOrigin) assert.ok(notifications, 'Native writes require an authenticated notification reader.');
    const notificationStart = origin === nativeOrigin ? notifications.observation.messages.length : undefined;
    const result = [];
    for (const [index, id] of ids.entries()) {
      const response = await request(origin, '/UserItems/' + id + '/UserData', { method: 'POST',
        body: { LastPlayedDate: input.cases[index][field], PlayCount: playCount, IsFavorite: favorite } });
      assert.equal(response.status, 200); assert.ok(response.contentType.startsWith('application/json'));
      result.push(publicUserData(response.bodyJson));
    }
    assert.deepEqual(await readUserData(origin, result, 'immediate persisted reads'), result);
    if (notificationStart !== undefined) await drainNativeNotifications(notificationStart, result);
    return result;
  };
  const rows = async (target, expected) => {
    const values = [];
    for (const [index, id] of ids.entries()) {
      const selected = await target.rows('UserData', { where: { ItemId: nativeGuid(id), UserId: current.userId } });
      assert.equal(selected.length, 1, input.cases[index].name + ' must have one actual UserData row');
      const row = selected[0]; assert.equal(storedUtc(row.LastPlayedDate), expected[index].LastPlayedDate);
      assert.equal(row.PlayCount, expected[index].PlayCount); assert.equal(row.IsFavorite, expected[index].IsFavorite);
      values.push({ ...row });
    }
    return values;
  };
  const captureSqlite = async filename => {
    await stoppedDatabase(filename);
    const source = new SqliteDatabase(filename, { readOnly: true, requireMigrationHistory: true });
    try { return await completeSnapshot(source); } finally { source.close(); }
  };
  try {
    current = await currentNativeReference(); token = current.accessToken; secrets.add(token); output.addSecret(token);
    report.input = current.preparation; report.sourceBindings = await current.sourceBindings(sourcePaths);
    await cp(current.sourceRoot, instanceRoot, { recursive: true, force: false, errorOnExist: true });
    await current.prepareClone(instanceRoot, nativePort); report.syntheticPreparation = removeSyntheticPreparation(instanceRoot);
    const mediaRoot = path.join(root, 'media'); await mkdir(mediaRoot);
    const photoBytes = await readFile(new URL('../images/fixtures/processor/single.png', import.meta.url));
    const files = input.cases.map(sample => path.join(mediaRoot, sample.name + '.png'));
    for (const filename of files) await writeFile(filename, photoBytes, { flag: 'wx' });
    report.mediaInput = { bytes: photoBytes.length, sha256: sha(photoBytes), files };
    native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label: 'native-initial', origin: nativeOrigin });
    await native.ready();
    for (const task of await idleTasks(nativeOrigin)) assert.equal((await request(nativeOrigin, '/ScheduledTasks/' + task.Id + '/Triggers',
      { method: 'POST', body: [] })).status, 204);
    const quietTasks = await idleTasks(nativeOrigin);
    assert.ok(quietTasks.length && quietTasks.every(task => task.Triggers.length === 0));
    const libraryOptions = { Enabled: true, EnablePhotos: true, EnableRealtimeMonitor: false, EnableInternetProviders: false,
      SaveLocalMetadata: false, AutomaticRefreshIntervalDays: 0, MetadataSavers: [], PathInfos: [{ Path: mediaRoot }],
      TypeOptions: ['Photo', 'PhotoAlbum', 'Folder', 'CollectionFolder'].map(Type => ({ Type,
        MetadataFetchers: [], MetadataFetcherOrder: [], ImageFetchers: [], ImageFetcherOrder: [] })) };
    assert.equal((await request(nativeOrigin, '/Library/VirtualFolders?name=' + encodeURIComponent(input.libraryName)
      + '&collectionType=homevideos&refreshLibrary=false', { method: 'POST', body: { LibraryOptions: libraryOptions } })).status, 204);
    const scan = (await idleTasks(nativeOrigin)).find(task => task.Key === 'RefreshLibrary'); assert.ok(scan);
    assert.equal((await request(nativeOrigin, '/ScheduledTasks/Running/' + scan.Id, { method: 'POST' })).status, 204);
    const deadline = Date.now() + 120000;
    while (true) {
      const result = await request(nativeOrigin, '/ScheduledTasks/' + scan.Id); assert.equal(result.status, 200);
      if (result.bodyJson.State === 'Idle' && result.bodyJson.LastExecutionResult
        && result.bodyJson.LastExecutionResult.StartTimeUtc !== scan.LastExecutionResult?.StartTimeUtc) {
        assert.equal(result.bodyJson.LastExecutionResult.Status, 'Completed'); report.scan = result.bodyJson; break;
      }
      assert.ok(Date.now() < deadline, 'A new Native scan must complete.'); await delay(100);
    }
    const listed = await request(nativeOrigin, '/Items?Recursive=true&IncludeItemTypes=Photo&Fields=Path');
    assert.equal(listed.status, 200); assert.equal(listed.bodyJson.Items.length, input.cases.length);
    ids = files.map(filename => {
      const found = listed.bodyJson.Items.filter(item => item.Path === filename); assert.equal(found.length, 1);
      return idKey(found[0].Id);
    });
    assert.equal(new Set(ids).size, input.cases.length); report.identities = listed.bodyJson.Items;
    await startNativeNotifications('native-initial');
    report.nativeInitial = await writeDates(nativeOrigin, 'input', 7, false);
    for (const [index, observation] of oracle.observations.entries()) {
      assert.equal(report.nativeInitial[index].LastPlayedDate, canonicalUtc(observation.wire));
      assert.equal(storedUtc(observation.stored), canonicalUtc(observation.wire));
    }
    await idleTasks(nativeOrigin); await stopNative('native-initial');
    const initialFilename = path.join(root, 'initial-native.db');
    await stoppedDatabase(databaseFilename(instanceRoot)); await copyFile(databaseFilename(instanceRoot), initialFilename);
    report.snapshots.nativeInitial = await captureSqlite(initialFilename);
    const style = process.platform === 'win32' ? 'windows' : 'posix', caseSensitive = style === 'posix';
    report.mountContract = { mounts: [{ mountId: 'date-exchange', identityRoot: root, accessRoot: '/date-exchange',
      pathStyle: style, caseSensitive, returnPolicy: 'required' }] };
    const emptyAncestors = path.join(root, 'empty-ancestors'); await mkdir(emptyAncestors);
    await writeFile(path.join(root, 'storage.json'), JSON.stringify({
      instances: [{ id: 'date-exchange', type: 'local', config: { root, writable: true } },
        { id: 'empty-ancestors', type: 'local', config: { root: emptyAncestors, writable: false } }],
      mounts: [{ path: '/date-exchange', instanceId: 'date-exchange', capabilities: {
        create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } },
        { path: '/empty-ancestors', instanceId: 'empty-ancestors', capabilities: {} }],
      prefixes: [{ identityRoot: root, accessRoot: '/date-exchange', style, caseSensitive,
        returnAccess: 'The same owned files remain available to current Native after the date exchange.' }],
      ignorePrefixes: [{ identityRoot: path.parse(root).root, accessRoot: '/empty-ancestors', style, caseSensitive,
        returnAccess: 'Explicit empty ancestors of the private date scenario.' }],
    }, null, 2) + '\n', { flag: 'wx' });
    report.binding = { serverId: current.preparation.nativeServerId, originIdentityDigest: sha(await readFile(initialFilename)) };
    for (const zone of input.zones) {
      const branch = { ...zone, snapshots: {}, timezoneObservations: [] }; report.zones.push(branch);
      sqlite = new SqliteDatabase(initialFilename, { readOnly: true, requireMigrationHistory: true });
      try {
        branch.nativeInitialRows = await rows(sqlite, report.nativeInitial);
        database = await createPostgresTestDatabase(null, 'date_exchange');
        branch.importReceipt = await transferDatabase(sqlite, database,
          { instanceBinding: report.binding, portableMountContract: report.mountContract });
      } finally { sqlite.close(); sqlite = undefined; }
      branch.snapshots.postgresImported = await completeSnapshot(database);
      assert.deepEqual(branch.snapshots.postgresImported, report.snapshots.nativeInitial);
      branch.nodeProcess = await startNode(database, zone, 'node-' + zone.name + '-writes');
      branch.nodeImportedReads = await readUserData(node.origin, report.nativeInitial, 'Node reads original Native dates');
      branch.nodeWrites = await writeDates(node.origin, 'input', 17, false);
      for (const [index, value] of branch.nodeWrites.entries()) {
        const expectedDate = canonicalUtc(branch.nodeProcess.dates[index].date);
        assert.equal(value.LastPlayedDate, expectedDate, input.cases[index].name + ' uses the requested Node timezone without losing 100ns digits');
        assert.deepEqual(value, { ...report.nativeInitial[index], PlayCount: 17, LastPlayedDate: expectedDate });
        const explicitZone = /(?:Z|[+-]\d{2}:\d{2})$/u.test(input.cases[index].input);
        if (explicitZone) assert.equal(value.LastPlayedDate, report.nativeInitial[index].LastPlayedDate);
        branch.timezoneObservations.push({ name: input.cases[index].name, input: input.cases[index].input,
          nativeUtc: report.nativeInitial[index].LastPlayedDate, nodeUtc: value.LastPlayedDate,
          explicitZone, sameInstant: value.LastPlayedDate === report.nativeInitial[index].LastPlayedDate });
      }
      branch.postgresRows = await rows(database, branch.nodeWrites);
      await stopNode('node-' + zone.name + '-writes');
      await database.close(); database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
        schema: database.schemaName });
      assert.deepEqual(await rows(database, branch.nodeWrites), branch.postgresRows);
      await startNode(database, zone, 'node-' + zone.name + '-cold');
      branch.nodeColdReads = await readUserData(node.origin, branch.nodeWrites, 'Cold Node date readback');
      await stopNode('node-' + zone.name + '-cold');
      assert.deepEqual(await rows(database, branch.nodeWrites), branch.postgresRows);
      branch.snapshots.nodeClosed = await completeSnapshot(database);
      const exported = path.join(root, zone.name + '-node-export.db');
      branch.exportReceipt = await exportCurrentSqlite(database, exported); assert.equal(branch.exportReceipt.verified, true);
      branch.snapshots.nodeExport = await captureSqlite(exported);
      assert.deepEqual(branch.snapshots.nodeExport, branch.snapshots.nodeClosed);
      sqlite = new SqliteDatabase(exported, { readOnly: true, requireMigrationHistory: true });
      try { branch.sqliteRows = await rows(sqlite, branch.nodeWrites); assert.deepEqual(branch.sqliteRows, branch.postgresRows); }
      finally { sqlite.close(); sqlite = undefined; }
      await installStoppedExport({ root, instanceRoot, exported, label: zone.name });
      native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label: 'native-' + zone.name, origin: nativeOrigin });
      await native.ready(); await idleTasks(nativeOrigin);
      branch.nativeImportedReads = await readUserData(nativeOrigin, branch.nodeWrites, 'Native reads Node-persisted UTC dates');
      await startNativeNotifications('native-' + zone.name);
      branch.nativeContinued = await writeDates(nativeOrigin, 'continued', 42, true);
      for (const [index, value] of branch.nativeContinued.entries()) assert.deepEqual(value, { ...branch.nodeWrites[index],
        PlayCount: 42, IsFavorite: true, LastPlayedDate: canonicalUtc(input.cases[index].continued) });
      await stopNative('native-' + zone.name);
      const returnedFilename = path.join(root, zone.name + '-native-returned.db');
      await stoppedDatabase(databaseFilename(instanceRoot)); await copyFile(databaseFilename(instanceRoot), returnedFilename);
      branch.snapshots.nativeReturned = await captureSqlite(returnedFilename);
      sqlite = new SqliteDatabase(returnedFilename, { readOnly: true, requireMigrationHistory: true });
      try {
        branch.nativeReturnedRows = await rows(sqlite, branch.nativeContinued);
        returnedDatabase = await createPostgresTestDatabase(null, 'date_return');
        branch.reimportReceipt = await transferDatabase(sqlite, returnedDatabase,
          { instanceBinding: report.binding, portableMountContract: report.mountContract });
      } finally { sqlite.close(); sqlite = undefined; }
      branch.snapshots.postgresReimported = await completeSnapshot(returnedDatabase);
      assert.deepEqual(branch.snapshots.postgresReimported, branch.snapshots.nativeReturned);
      branch.freshPostgresRows = await rows(returnedDatabase, branch.nativeContinued);
      assert.deepEqual(branch.freshPostgresRows, branch.nativeReturnedRows);
      await startNode(returnedDatabase, zone, 'node-' + zone.name + '-returned');
      branch.freshNodeReads = await readUserData(node.origin, branch.nativeContinued, 'Fresh PostgreSQL reads actual Native continuation');
      await stopNode('node-' + zone.name + '-returned');
      for (const filename of files) assert.deepEqual(await fileIdentity(filename), { bytes: photoBytes.length, sha256: sha(photoBytes) });
      await dropPostgresTestDatabase(returnedDatabase); returnedDatabase = undefined;
      await dropPostgresTestDatabase(database); database = undefined;
      report.cleanup.push({ name: zone.name + '-postgres', initialDropped: true, returnedDropped: true });
      branch.passed = true;
    }
    assert.deepEqual(report.errors, []); report.passed = true;
  } catch (error) { failure = error; report.failure = { name: error.name, message: error.message, stack: error.stack }; }
  finally {
    const attempt = async operation => { try { await operation(); } catch (error) {
      failure ??= error; report.cleanup.push({ error: { name: error.name, message: error.message } });
    } };
    await attempt(() => stopNative('native-finally')); await attempt(() => stopNode('node-finally'));
    await attempt(() => { sqlite?.close(); sqlite = undefined; });
    if (!node) {
      await attempt(async () => { await dropPostgresTestDatabase(returnedDatabase); });
      await attempt(async () => { await dropPostgresTestDatabase(database); });
    } else {
      safeToRemove = false; await attempt(() => returnedDatabase?.close()); await attempt(() => database?.close());
    }
    await attempt(() => current?.finish());
    report.passed = !failure;
    await writeFile(path.join(root, 'report.json'), filterEvidenceJson(report, secrets));
    await writeFile(path.join(root, 'provenance.json'), filterEvidenceJson({ inputSha256: sha(inputBytes), nativeInput: current?.preparation,
      sourceBindings: report.sourceBindings, actualNativeHttp: Boolean(report.nativeInitial && report.zones.length === input.zones.length
        && report.zones.every(zone => zone.nativeContinued?.length === input.cases.length)),
      productionPostgresRuntime: Boolean(report.zones.length === input.zones.length && report.zones.every(zone => zone.freshNodeReads)),
      nativeNotificationsConsumed: report.notifications.length === input.zones.length + 1
        && report.notifications.every(value => value.batches.length === 1 && value.batches[0].complete
          && value.batches[0].observed.length === input.cases.length && value.close?.code === 1000 && value.errors.length === 0),
      completeLibraryVerified: false, fullInstanceVerified: false, phaseAcceptance: false }, secrets));
    if (native || node || notifications) safeToRemove = false;
    if (safeToRemove) await attempt(() => output.publishAndClose());
    else {
      await mkdir(destination); await writeFile(path.join(destination, 'report.json'), filterEvidenceJson({ ...report, privateRootRetained: true }, secrets));
      failure ??= new Error('A date exchange runtime did not release its private root.');
    }
  }
  if (failure) throw output.publicError(failure);
  return report;
}
