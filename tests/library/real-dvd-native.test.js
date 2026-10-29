import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { startProductionInstance } from '../../src/main.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { transferDatabase, exportCurrentSqlite } from '../../src/migration/database-transfer.js';
import { runNativeCompleteLibraryScan } from '../../src/migration/complete-library-verifier.js';
import { getDvdMediaFiles } from '../../src/storage/dvd-media-files.js';
import { normalizeProbe } from '../../src/storage/probe-normalizer.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { compileOracle } from '../../tools/validation/oracle.js';
import { describeFile, sha256 } from '../../tools/validation/inventory.js';
import { dvdReferenceInputs } from '../../tools/validation/dvd-reference-inputs.js';
import { validationExecutable, validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { declareFileTestResource } from '../helpers/file-test-resource.js';
import { databaseFilename, idKey, installStoppedExport, portAvailable, removeSyntheticPreparation,
  stoppedDatabase, unusedPort } from '../helpers/library-exchange-state.js';
import { orderedExchangeSnapshot } from '../helpers/ordered-exchange-snapshot.js';
import { errorObservation } from '../helpers/error-observation.js';
import { configureStorage, discRows, functionalJson, libraryOptions, materializeOriginalDvd,
  probeValues, technicalDto, verifyOriginalDvd } from './fixtures/real-dvd-current/scenario.js';
import { startDvdMediaProxy } from './fixtures/real-dvd-current/media-proxy.js';

export const requiredValidationServices = ['dvdReference', 'dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_DVD_REFERENCE && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE
  && process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_POSTGRES);
const mediaLease = declareFileTestResource('native-media-5244', { enabled });
const discovery = declareFileTestResource('hdhomerun-discovery-65001', { enabled });

test('the complete original DVD survives actual Native and Node VFS probing, fresh scans, SQLite continuation and cold PostgreSQL', {
  skip: !enabled, timeout: 900000,
}, async t => mediaLease.run(() => discovery.run(async () => {
  const identity = randomUUID(), destination = path.join(validationOutputRoot(), 'real-dvd-' + identity);
  const output = await createPrivateFilterOutput(destination); output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  await mkdir(output.root);
  const root = await realpath(output.root), instanceRoot = path.join(root, 'instance'), mediaRoot = path.join(root, 'media'),
    disc = path.join(mediaRoot, 'Big Buck Bunny (2008)'), componentRoot = path.join(validationOutputRoot(), 'real-dvd-components-' + identity);
  const port = await unusedPort(), origin = 'http://127.0.0.1:' + port;
  const report = { schemaVersion: 1, phaseAcceptance: false, releaseAcceptance: false,
    scope: { originalInput: 'Complete original NTSC VIDEO_TS, every menu, backup and video object.',
      baseline: 'Actual designated Native server scan and separate MediaEncoder/ffprobe executions.',
      candidate: 'Independent first PostgreSQL scan, Local read-only VFS media and separately writable instance metadata.',
      exchange: 'All native business tables and insertion sequences at each SQLite/PostgreSQL transfer boundary.',
      dto: 'Declared technical Movie/source fields and full stream/chapter values, metadata edits and user favorite state.',
      excluded: ['full Movie DTO parity', 'Blu-ray', 'DVD navigation or decoded playback', 'production scale', 'full instance packaging'] },
    requests: [], scans: [], snapshots: {}, rows: {}, shutdowns: [], nodeProbes: [], runtimeErrors: [], cleanup: {} };
  let current, native, runtime, database, returned, sqlite, supply, proxy, token, itemId, failed = false, failure, stage = 'prepare';
  const setStage = value => { stage = value; if (proxy) proxy.report.phase = value; };
  const request = async (route, { method = 'GET', body, cleanup = false } = {}) => {
    const observed = { stage, route, method, ...(body === undefined ? {} : { body }) }; report.requests.push(observed);
    const response = await fetch(origin + route, { method, redirect: 'error',
      signal: cleanup ? AbortSignal.timeout(30000) : AbortSignal.any([t.signal, AbortSignal.timeout(30000)]),
      headers: { Authorization: `MediaBrowser Token="${token}"`, Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: stringifyNativeJson(body) }) });
    const text = await response.text();
    observed.response = { status: response.status, headers: Object.fromEntries(response.headers), bodyText: text };
    return { status: response.status, value: text ? parseLosslessJson(text) : null, raw: observed.response };
  };
  const idle = async () => {
    const deadline = performance.now() + 120000;
    for (;;) {
      const response = await request('/ScheduledTasks'); assert.equal(response.status, 200);
      if (response.value.every(task => !['Running', 'Cancelling'].includes(task.State))) return response.value;
      assert.ok(performance.now() < deadline, 'The actual scan and metadata owners must settle.');
      await delay(100, undefined, { signal: t.signal });
    }
  };
  const scan = async label => {
    setStage(label); await idle();
    const result = await runNativeCompleteLibraryScan({ baseUrl: origin, accessToken: token, signal: t.signal,
      scanTimeoutMs: 180000, pollIntervalMs: 100 });
    report.scans.push({ stage, ...result }); assert.equal(result.status, 'Completed'); await idle();
  };
  const startNative = async label => {
    setStage(label); await current.prepareClone(instanceRoot, port);
    native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label, origin }); await native.ready(); await idle();
  };
  const stopNative = async label => {
    if (!native) return;
    const result = await native.stop(async () => (await request('/System/Shutdown', { method: 'POST', cleanup: true })).status,
      () => portAvailable(port));
    report.shutdowns.push({ label, ...result }); if (result.pidGone) native = undefined;
    assert.equal(result.cleanShutdown, true); assert.equal(result.pidGone, true); assert.equal(result.portAvailable, true);
  };
  const startNode = async (target, label) => {
    setStage(label);
    runtime = await startProductionInstance({ environment: { ...process.env, MEDIAMANAGER_INSTANCE: instanceRoot,
      MEDIAMANAGER_POSTGRES: process.env.MEDIAMANAGER_TEST_POSTGRES, MEDIAMANAGER_POSTGRES_SCHEMA: target.schemaName,
      MEDIAMANAGER_STORAGE: path.join(root, 'storage.json') },
    onError: (error, context) => report.runtimeErrors.push({ stage, route: context?.request?.url, error: errorObservation(error) }) });
    assert.ok(runtime.networkHost.listeners.some(listener => listener.port === port && listener.scheme === 'http'));
    const actualProbe = runtime.probe.probe;
    runtime.probe.probe = async function (bridge, virtualPath, options) {
      const result = await actualProbe.call(this, bridge, virtualPath, options);
      report.nodeProbes.push({ stage, virtualPath, result: structuredClone(result) }); return result;
    };
    await idle();
  };
  const stopNode = async label => {
    if (!runtime) return;
    const active = runtime, listeners = active.networkHost.listeners; await active.close(); runtime = undefined;
    const result = { label, listenersClosed: listeners.every(listener => !listener.server.listening),
      databaseClosed: active.store.database.closed, portAvailable: await portAvailable(port) };
    report.shutdowns.push(result); assert.equal(result.listenersClosed, true); assert.equal(result.databaseClosed, true); assert.equal(result.portAvailable, true);
  };
  const withSqlite = async (filename, operation) => {
    await stoppedDatabase(filename); sqlite = new SqliteDatabase(filename, { readOnly: true, requireMigrationHistory: true });
    try { return await operation(sqlite); } finally { sqlite.close(); sqlite = undefined; }
  };
  const detail = async label => {
    setStage(label);
    const result = await request('/Items/' + idKey(itemId) + '?Fields=MediaSources,MediaStreams,Chapters,Path,Overview,Tags,ProviderIds,OriginalTitle');
    assert.equal(result.status, 200); assert.equal(idKey(result.value.Id), idKey(itemId));
    assert.equal(result.raw.headers['content-type']?.split(';')[0], 'application/json');
    assert.equal(result.value.Path, disc); assert.equal(result.value.VideoType, 'Dvd');
    assert.ok(result.value.RunTimeTicks > 0); assert.ok(result.value.MediaStreams.some(stream => stream.Type === 'Video'));
    assert.equal(result.value.MediaSources.length, 1);
    return { raw: result.raw, value: result.value, technical: technicalDto(result.value) };
  };
  const edit = async fields => {
    const previous = await detail(stage + '-before-edit');
    assert.equal((await request('/Items/' + idKey(itemId), { method: 'POST', body: { ...previous.value, ...fields } })).status, 204);
  };
  try {
    supply = await dvdReferenceInputs(); report.original = { receipt: supply.receipt, manifest: supply.manifest };
    const refusal = path.join(root, 'empty-disc-refusal'), falseRoot = path.join(refusal, 'mediamanager-disc-reference');
    await mkdir(falseRoot, { recursive: true });
    await cp(supply.evidence, path.join(falseRoot, 'evidence'), { recursive: true, force: false, errorOnExist: true });
    await mkdir(path.join(falseRoot, 'media'));
    const falseReceipt = path.join(falseRoot, 'evidence', 'receipt.json');
    await writeFile(falseReceipt, JSON.stringify({ ...supply.receipt, mediaRoot: path.join(falseRoot, 'media') }) + '\n');
    await assert.rejects(dvdReferenceInputs({ ...process.env, RUNNER_TEMP: refusal, MEDIAMANAGER_TEST_DVD_REFERENCE: falseReceipt }),
      error => Array.isArray(error.actual) && error.actual.length === 0
        && JSON.stringify(error.expected) === JSON.stringify(supply.manifest));
    report.emptyPayloadRejected = true;
    current = await currentNativeReference(); token = current.accessToken; output.addSecret(token); report.nativeInput = current.preparation;
    report.sourceBindings = await current.sourceBindings(['MediaBrowser.MediaEncoding/Encoder/MediaEncoder.cs',
      'MediaBrowser.Providers/MediaInfo/FFProbeVideoInfo.cs', 'Emby.Server.Implementations/Library/Resolvers/Movies/MovieResolver.cs',
      'Emby.Server.Implementations/Library/LibraryManager.cs', 'Jellyfin.Api/Controllers/LibraryController.cs',
      'Jellyfin.Api/Controllers/ItemUpdateController.cs', 'MediaBrowser.Controller/Entities/Video.cs', 'MediaBrowser.Controller/IO/LocalMediaProxy.cs']);
    await cp(current.sourceRoot, instanceRoot, { recursive: true, force: false, errorOnExist: true });
    await current.prepareClone(instanceRoot, port); report.syntheticPreparation = removeSyntheticPreparation(instanceRoot);
    await mkdir(mediaRoot);
    const storage = await configureStorage(root, mediaRoot); report.mountContract = storage.mountContract;
    await startNative('native-dvd-empty');
    for (const task of await idle()) assert.equal((await request('/ScheduledTasks/' + task.Id + '/Triggers', { method: 'POST', body: [] })).status, 204);
    assert.equal((await request('/Library/VirtualFolders?name=Original%20DVD&collectionType=movies&refreshLibrary=false',
      { method: 'POST', body: { LibraryOptions: libraryOptions(mediaRoot) } })).status, 204);
    await scan('native-empty-scan'); await stopNative('native-empty-stopped');
    const emptyInstance = path.join(root, 'saved-empty-instance');
    await cp(instanceRoot, emptyInstance, { recursive: true, force: false, errorOnExist: true });
    report.emptyConfiguration = await describeFile(path.join(emptyInstance, 'config'));
    const emptyFile = path.join(root, 'native-empty.db'); await copyFile(databaseFilename(instanceRoot), emptyFile);
    report.binding = { serverId: current.preparation.nativeServerId, originIdentityDigest: sha256(await readFile(emptyFile)) };
    database = await createPostgresTestDatabase(null, 'real_dvd');
    await withSqlite(emptyFile, async source => {
      report.snapshots.empty = await orderedExchangeSnapshot(source, { signal: t.signal });
      report.imported = await transferDatabase(source, database, { signal: t.signal,
        instanceBinding: report.binding, portableMountContract: storage.mountContract });
    });
    assert.deepEqual(await orderedExchangeSnapshot(database, { signal: t.signal }), report.snapshots.empty);
    report.materialized = await materializeOriginalDvd(supply, disc);
    await mkdir(componentRoot);
    const componentInput = { files: supply.manifest.filter(member => member.type === 'file'), titles: [null, 1, 99],
      originalIsoSha256: supply.receipt.download.sha256, ffprobe: validationExecutable('ffprobe') };
    const bytes = Buffer.from(JSON.stringify(componentInput, null, 2) + '\n'), inputFile = path.join(componentRoot, 'input.json');
    await writeFile(inputFile, bytes, { flag: 'wx' });
    const oracle = await compileOracle({ project: 'tests/library/fixtures/real-dvd-current/Oracle.csproj', output: path.join(componentRoot, 'build') });
    report.components = [];
    for (const label of ['native', 'native-repeat']) {
      const resultRoot = path.join(componentRoot, label);
      const receipt = await oracle.record({ output: resultRoot, args: [inputFile, disc, validationExecutable('ffmpeg'), '{output}'] });
      const captureBytes = await readFile(path.join(resultRoot, 'native.json')), capture = parseLosslessJson(captureBytes.toString('utf8'));
      assert.equal(receipt.passed, true); assert.equal(capture.inputSha256, sha256(bytes));
      assert.equal(receipt.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, sha256(captureBytes));
      for (const flag of ['actualManagedFileSystem', 'actualMediaEncoder', 'actualFfprobe']) assert.equal(capture[flag], true);
      assert.equal(capture.proxy.closed, true);
      for (const probe of capture.probes) assert.ok(capture.proxy.requests.some(request => request.Method === 'GET' && request.file === probe.file),
        'The component must read each original VOB through the designated source media proxy.');
      for (const assembly of capture.assemblies) assert.equal((await describeFile(assembly.filename)).sha256, assembly.sha256);
      assert.deepEqual(functionalJson(capture.sourceFiles), componentInput.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })));
      report.components.push({ label, receipt, sha256: sha256(captureBytes), capture });
    }
    const component = report.components[0].capture;
    assert.deepEqual(functionalJson(report.components[1].capture.selections), functionalJson(component.selections));
    assert.deepEqual(report.components[1].capture.probes.map(probe => probeValues(probe.information)), component.probes.map(probe => probeValues(probe.information)));
    proxy = await startDvdMediaProxy(disc, supply.manifest); report.proxy = proxy.report;
    await startNative('native-dvd-baseline'); await scan('native-original-dvd-scan');
    await stopNative('native-baseline-scanned');
    await withSqlite(databaseFilename(instanceRoot), async source => {
      report.rows.native = await discRows(source, disc); itemId = report.rows.native.row.Id;
      report.snapshots.native = await orderedExchangeSnapshot(source, { signal: t.signal });
      assert.equal(functionalJson(report.rows.native.row.RunTimeTicks), component.totalTicks);
    });
    for (const file of component.selections[0].files) assert.ok(report.proxy.requests.some(request =>
      request.phase === 'native-original-dvd-scan' && request.file === file && request.method === 'GET'
      && request.readBytes > 0 && request.handleClosed === true), 'The real Native scan must read every selected original VOB.');
    await startNative('native-dvd-public'); report.native = await detail('native-original-dvd-detail'); await stopNative('native-baseline-complete');
    await rename(instanceRoot, path.join(root, 'retained-native-instance'));
    await cp(emptyInstance, instanceRoot, { recursive: true, force: false, errorOnExist: true });
    assert.deepEqual((await describeFile(path.join(instanceRoot, 'config'))).entries, report.emptyConfiguration.entries);
    await withSqlite(databaseFilename(instanceRoot), async source => assert.deepEqual(await orderedExchangeSnapshot(source, { signal: t.signal }), report.snapshots.empty));
    await startNode(database, 'node-dvd-first');
    const virtualDisc = '/dvd-instance/media/Big Buck Bunny (2008)';
    assert.equal(runtime.probe.vfs.capabilities(virtualDisc).create, false);
    report.nodeSelections = [];
    for (const selection of component.selections) {
      const files = await getDvdMediaFiles(runtime.probe.vfs, virtualDisc, { signal: t.signal,
        ...(selection.title == null ? {} : { titleNumber: selection.title }) });
      const actual = { title: selection.title, files: files.map(file => file.virtualPath.slice(virtualDisc.length + 1)) };
      assert.deepEqual(actual, selection); report.nodeSelections.push(actual);
    }
    await scan('node-original-dvd-first-scan');
    report.rows.node = await discRows(database, disc); assert.equal(idKey(report.rows.node.row.Id), idKey(itemId));
    assert.deepEqual(report.rows.node.technical, report.rows.native.technical);
    report.node = await detail('node-original-dvd-detail'); assert.deepEqual(report.node.technical, report.native.technical);
    const actualProbes = report.nodeProbes.filter(probe => probe.stage === 'node-original-dvd-first-scan');
    assert.equal(actualProbes.length, component.probes.length, 'The fresh Node scan must probe every actually selected original VOB.');
    for (const [index, probe] of actualProbes.entries()) {
      const expected = component.probes[index]; assert.equal(probe.virtualPath, virtualDisc + '/' + expected.file);
      assert.deepEqual(probeValues(normalizeProbe(probe.result.raw, { path: path.join(disc, ...expected.file.split('/')), isAudio: false })), probeValues(expected.information));
    }
    await edit({ Overview: 'Node original DVD edit & 保留', ProviderIds: { DiscOpaque: 'opaque:traceId:complete-original' }, Tags: ['Original DVD', '保留'] });
    assert.equal((await request('/UserFavoriteItems/' + idKey(itemId), { method: 'POST' })).status, 200);
    report.nodeChanged = await detail('node-dvd-changed'); assert.equal(report.nodeChanged.value.UserData.IsFavorite, true);
    await stopNode('node-before-cold');
    const schema = database.schemaName; await database.close(); database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema });
    report.snapshots.node = await orderedExchangeSnapshot(database, { signal: t.signal });
    await startNode(database, 'node-dvd-cold'); report.nodeCold = await detail('node-dvd-cold-detail');
    assert.deepEqual(report.nodeCold.technical, report.nodeChanged.technical); assert.equal(report.nodeCold.value.UserData.IsFavorite, true);
    await stopNode('node-cold-stopped');
    assert.deepEqual(await orderedExchangeSnapshot(database, { signal: t.signal }), report.snapshots.node);
    const exported = path.join(root, 'node-export.db'); report.exported = await exportCurrentSqlite(database, exported, { signal: t.signal });
    assert.equal(report.exported.verified, true);
    await withSqlite(exported, async source => assert.deepEqual(await orderedExchangeSnapshot(source, { signal: t.signal }), report.snapshots.node));
    await installStoppedExport({ root, instanceRoot, exported });
    await startNative('native-dvd-continuation'); report.nativeImported = await detail('native-imported-dvd');
    assert.deepEqual(report.nativeImported.technical, report.nodeCold.technical); assert.equal(report.nativeImported.value.UserData.IsFavorite, true);
    await edit({ Overview: 'Native continued original DVD & 保留' });
    report.nativeContinued = await detail('native-continued-dvd');
    assert.equal(report.nativeContinued.value.Overview, 'Native continued original DVD & 保留');
    assert.equal(report.nativeContinued.value.ProviderIds.DiscOpaque, 'opaque:traceId:complete-original');
    await stopNative('native-continuation-stopped');
    returned = await createPostgresTestDatabase(null, 'real_dvd_return');
    await withSqlite(databaseFilename(instanceRoot), async source => {
      report.snapshots.continued = await orderedExchangeSnapshot(source, { signal: t.signal }); report.rows.continued = await discRows(source, disc);
      report.returned = await transferDatabase(source, returned, { signal: t.signal,
        instanceBinding: report.binding, portableMountContract: storage.mountContract });
    });
    assert.deepEqual(await orderedExchangeSnapshot(returned, { signal: t.signal }), report.snapshots.continued);
    await startNode(returned, 'node-dvd-returned-cold'); report.returnedCold = await detail('node-returned-dvd-detail');
    assert.deepEqual(report.returnedCold.technical, report.nativeContinued.technical); assert.equal(report.returnedCold.value.UserData.IsFavorite, true);
    assert.equal(report.returnedCold.value.Overview, 'Native continued original DVD & 保留');
    await stopNode('node-returned-stopped');
    assert.deepEqual(await orderedExchangeSnapshot(returned, { signal: t.signal }), report.snapshots.continued);
    assert.deepEqual(await orderedExchangeSnapshot(database, { signal: t.signal }), report.snapshots.node);
    report.mediaAfter = await verifyOriginalDvd(supply, disc); assert.deepEqual(report.mediaAfter, report.materialized);
    assert.deepEqual((await dvdReferenceInputs()).inputs, supply.inputs); report.originalInputsUnchanged = true;
    t.signal.throwIfAborted();
    report.acceptance = { originalCompleteVideoTs: true, actualNativeAndNodeProbe: true, independentFirstScan: true,
      exactDatabaseExchange: true, nativeContinuedEdit: true, coldPostgresRead: true, fullDtoParity: false, phaseAcceptance: false };
  } catch (error) { failed = true; failure = error; report.failure = errorObservation(error); }
  finally {
    const errors = [];
    for (const operation of [() => stopNode('finally-node'), () => stopNative('finally-native'),
      () => { sqlite?.close(); sqlite = undefined; }, () => proxy?.close(), () => dropPostgresTestDatabase(returned),
      () => dropPostgresTestDatabase(database), () => current?.finish()]) {
      try { await operation(); } catch (error) { errors.push(error); }
    }
    report.cleanup = { runtimeClosed: runtime === undefined, nativeExited: native === undefined,
      portAvailable: await portAvailable(port), mediaPortAvailable: await portAvailable(5244), proxyClosed: !proxy || proxy.report.closed === true,
      databaseOwnersClosed: [database, returned].filter(Boolean).every(value => value.closed) };
    try { assert.deepEqual(report.cleanup, { runtimeClosed: true, nativeExited: true, portAvailable: true,
      mediaPortAvailable: true, proxyClosed: true, databaseOwnersClosed: true }); }
    catch (error) { errors.push(error); }
    report.cleanup.errors = errors.map(error => errorObservation(error));
    if (t.signal.aborted && !failed) { failed = true; failure = t.signal.reason; report.failure = errorObservation(failure); }
    report.passed = !failed && errors.length === 0;
    await writeFile(path.join(root, 'report.json'), JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
    if (!runtime && !native && (!proxy || proxy.report.closed === true)) await output.publishAndClose();
    else {
      await mkdir(destination);
      await writeFile(path.join(destination, 'report.json'), filterEvidenceJson({ ...report, passed: false, privateRootRetained: true }));
    }
    if (errors.length) { failure = new AggregateError(failed ? [failure, ...errors] : errors, 'Real DVD validation and cleanup failed.', failed ? { cause: failure } : undefined); failed = true; }
  }
  if (failed) throw output.publicError(failure);
}, { signal: t.signal }), { signal: t.signal }));
