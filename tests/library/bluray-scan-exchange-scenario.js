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
import { readBlurayDiscInfo, verifyBlurayDiscInfo } from '../../src/storage/bluray-disc-info.js';
import { normalizeProbe } from '../../src/storage/probe-normalizer.js';
import { nativeDate } from '../../src/users/native.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { compileOracle } from '../../tools/validation/oracle.js';
import { describeFile, sha256 } from '../../tools/validation/inventory.js';
import { validationExecutable, validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { declareFileTestResource } from '../helpers/file-test-resource.js';
import { captureDiscPlayback } from '../helpers/disc-playback.js';
import { databaseFilename, idKey, installStoppedExport, portAvailable, removeSyntheticPreparation,
  stoppedDatabase, unusedPort } from '../helpers/library-exchange-state.js';
import { observeAuthenticatedExchangeRead, orderedExchangeSnapshot } from '../helpers/ordered-exchange-snapshot.js';
import { errorObservation } from '../helpers/error-observation.js';
import { configureStorage, discRows, functionalJson, libraryOptions, materializeBluray,
  probeValues, technicalDto, verifyBluray } from './fixtures/real-bluray-current/scenario.js';
import { startDvdMediaProxy as startDiscMediaProxy } from './fixtures/real-dvd-current/media-proxy.js';

export function createBlurayScanExchange({ enabled, original = false, playback = false, movieName, prepareInput }) {
  const mediaLease = declareFileTestResource('native-media-5244', { enabled });
  const discovery = declareFileTestResource('hdhomerun-discovery-65001', { enabled });
  const fixture = original ? 'real-bluray' : playback ? 'compact-bluray-playback' : 'compact-bluray';
  return t => mediaLease.run(() => discovery.run(
    () => runBlurayScanExchange(t, { fixture, original, playback, movieName, prepareInput }), { signal: t.signal }), { signal: t.signal });
}

async function runBlurayScanExchange(t, { fixture, original, playback, movieName, prepareInput }) {
  const identity = randomUUID(), destination = path.join(validationOutputRoot(), fixture + '-' + identity);
  const output = await createPrivateFilterOutput(destination); output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  await mkdir(output.root);
  const root = await realpath(output.root), instanceRoot = path.join(root, 'instance'), mediaRoot = path.join(root, 'media'),
    disc = path.join(mediaRoot, movieName), componentRoot = path.join(validationOutputRoot(), fixture + '-components-' + identity);
  const port = await unusedPort(), origin = 'http://127.0.0.1:' + port;
  const report = { schemaVersion: 1, phaseAcceptance: false, releaseAcceptance: false,
    scope: { [original ? 'originalInput' : 'input']: original ? 'Complete original Sintel ISO/BDMV, every descriptor, backup and both complete transport streams.'
      : 'Authored MPLS and CLPI with the complete frozen M2TS clips.',
      baseline: 'Actual designated Native server scan and separate MediaEncoder/ffprobe executions.',
      candidate: 'Independent first PostgreSQL scan, Local read-only VFS media and separately writable instance metadata.',
      exchange: 'All native business tables and insertion sequences at each SQLite/PostgreSQL transfer boundary.',
      dto: 'Declared technical Movie/source fields and full stream/chapter values, metadata edits and user favorite state.',
      excluded: ['full Movie DTO parity', 'commercial or encrypted Blu-ray', 'Blu-ray menu decoding', ...(playback ? [] : ['decoded playback']),
        'production scale', 'full instance packaging'] },
    requests: [], scans: [], snapshots: {}, rows: {}, shutdowns: [], nodeProbes: [], runtimeErrors: [], cleanup: {} };
  let current, native, runtime, database, returned, sqlite, supply, proxy, token, itemId, nativePlayback, failed = false, failure, stage = 'prepare', ownerCloseFailed = false;
  const databaseOwners = new Set(), closedDatabaseOwners = new Set();
  const ownDatabase = value => { databaseOwners.add(value); return value; };
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
    if (result.cleanShutdown !== true || result.pidGone !== true || result.portAvailable !== true) ownerCloseFailed = true;
    assert.equal(result.cleanShutdown, true); assert.equal(result.pidGone, true); assert.equal(result.portAvailable, true);
  };
  const startNode = async (target, label) => {
    setStage(label);
    runtime = await startProductionInstance({ environment: { ...process.env, MEDIAMANAGER_INSTANCE: instanceRoot,
      MEDIAMANAGER_POSTGRES: process.env.MEDIAMANAGER_TEST_POSTGRES, MEDIAMANAGER_POSTGRES_SCHEMA: target.schemaName,
      MEDIAMANAGER_STORAGE: path.join(root, 'storage.json') },
    onError: (error, context) => report.runtimeErrors.push({ stage, route: context?.request?.url, error: errorObservation(error) }) });
    assert.ok(runtime.networkHost.listeners.some(listener => listener.port === port && listener.scheme === 'http'));
    if (original) runtime.extraction.onProcess = entry => (report.nodeSubtitleProcesses ??= []).push(entry);
    const actualProbe = runtime.probe.probe;
    runtime.probe.probe = async function (bridge, virtualPath, options) {
      const result = await actualProbe.call(this, bridge, virtualPath, options);
      report.nodeProbes.push({ stage, virtualPath, result: structuredClone(result) }); return result;
    };
    await idle();
  };
  const stopNode = async label => {
    if (!runtime) return;
    const active = runtime, listeners = active.networkHost.listeners;
    try { await active.close(); } catch (error) { ownerCloseFailed = true; throw error; }
    const result = { label, listenersClosed: listeners.every(listener => !listener.server.listening),
      databaseClosed: active.store.database.closed, portAvailable: await portAvailable(port) };
    report.shutdowns.push(result);
    if (!result.listenersClosed || !result.databaseClosed || !result.portAvailable) ownerCloseFailed = true;
    assert.equal(result.listenersClosed, true); assert.equal(result.databaseClosed, true); assert.equal(result.portAvailable, true);
    runtime = undefined;
  };
  const withSqlite = async (filename, operation) => {
    await stoppedDatabase(filename); sqlite = new SqliteDatabase(filename, { readOnly: true, requireMigrationHistory: true });
    let value, operationFailed = false, operationError;
    try { value = await operation(sqlite); } catch (error) { operationFailed = true; operationError = error; }
    try { sqlite.close(); sqlite = undefined; }
    catch (error) {
      ownerCloseFailed = true;
      throw operationFailed ? new AggregateError([operationError, error], 'Blu-ray SQLite observation and owner close failed.', { cause: operationError }) : error;
    }
    if (operationFailed) throw operationError;
    return value;
  };
  const detail = async label => {
    setStage(label);
    const result = await request('/Items/' + idKey(itemId) + '?Fields=MediaSources,MediaStreams,Chapters,Path,Overview,Tags,ProviderIds,OriginalTitle');
    assert.equal(result.status, 200); assert.equal(idKey(result.value.Id), idKey(itemId));
    assert.equal(result.raw.headers['content-type']?.split(';')[0], 'application/json');
    assert.equal(result.value.Path, disc); assert.equal(result.value.VideoType, 'BluRay');
    assert.ok(result.value.RunTimeTicks > 0); assert.ok(result.value.MediaStreams.some(stream => stream.Type === 'Video'));
    assert.equal(result.value.MediaSources.length, 1);
    return { raw: result.raw, value: result.value, technical: technicalDto(result.value) };
  };
  const capturePgs = async (side, detail) => {
    setStage(side + '-original-bluray-pgs');
    const tracks = detail.MediaStreams.filter(stream => stream.Type === 'Subtitle' && stream.Codec === 'pgssub' && !stream.IsExternal);
    assert.ok(tracks.length > 0, 'The original disc must supply an embedded PGS track.');
    const track = tracks.find(stream => stream.Language === 'eng') ?? tracks[0];
    const requestBody = { MediaSourceId: idKey(itemId), SubtitleStreamIndex: track.Index, EnableDirectPlay: false, EnableDirectStream: false,
      DeviceProfile: { MaxStreamingBitrate: 120000000,
        TranscodingProfiles: [{ Type: 'Video', Context: 'Streaming', Protocol: 'http', Container: 'ts', VideoCodec: 'h264', AudioCodec: 'ac3' }],
        SubtitleProfiles: [{ Format: 'pgssub', Method: 'External' }] } };
    const playback = await request('/Items/' + idKey(itemId) + '/PlaybackInfo', { method: 'POST', body: requestBody });
    assert.equal(playback.status, 200);
    const [source] = playback.value.MediaSources;
    assert.equal(source.VideoType, 'BluRay');
    assert.equal(source.SupportsTranscoding, true);
    const selected = source.MediaStreams.find(stream => stream.Type === 'Subtitle' && stream.Index === track.Index);
    assert.equal(selected?.DeliveryMethod, 'External');
    assert.equal(selected.SupportsExternalStream, true);
    const url = new URL(selected.DeliveryUrl, origin);
    assert.equal(url.origin, origin);
    assert.match(url.pathname, /\/Stream\.pgssub$/u);
    const response = await fetch(url, { redirect: 'error', signal: t.signal, headers: { Authorization: `MediaBrowser Token="${token}"` } });
    const bytes = Buffer.from(await response.arrayBuffer());
    const result = report.subtitles[side] = { trackIndex: track.Index, codec: selected.Codec, tracks: tracks.length,
      pathname: url.pathname, status: response.status, mime: response.headers.get('content-type')?.split(';')[0],
      bytes: bytes.length, sha256: sha256(bytes), segments: 0, presentations: 0 };
    assert.equal(response.status, 200, bytes.subarray(0, 240).toString());
    for (let offset = 0; offset < bytes.length;) {
      assert.ok(bytes.length - offset >= 13, 'The PGS segment header must be complete.');
      assert.equal(bytes.readUInt16BE(offset), 0x5047);
      const pts = bytes.readUInt32BE(offset + 2);
      result.firstPts ??= pts;
      result.lastPts = pts;
      result.segments++;
      if (bytes[offset + 10] === 0x16) result.presentations++;
      offset += 13 + bytes.readUInt16BE(offset + 11);
      assert.ok(offset <= bytes.length, 'The PGS segment payload must be complete.');
    }
    assert.ok(result.presentations > 1 && result.lastPts > result.firstPts);
  };
  const edit = async fields => {
    const previous = await detail(stage + '-before-edit');
    assert.equal((await request('/Items/' + idKey(itemId), { method: 'POST', body: { ...previous.value, ...fields } })).status, 204);
  };
  const editedMetadata = { Overview: 'Node original Blu-ray edit & 保留',
    ProviderIds: { DiscOpaque: 'opaque:traceId:complete-original' }, Tags: ['Original Blu-ray', '保留'] };
  const verifyEditedMetadata = (observation, overview = editedMetadata.Overview) => {
    assert.equal(observation.value.Overview, overview);
    assert.deepEqual(observation.value.Tags, editedMetadata.Tags);
    assert.equal(observation.value.ProviderIds.DiscOpaque, editedMetadata.ProviderIds.DiscOpaque);
  };
  try {
    supply = await prepareInput({ root, signal: t.signal });
    report[original ? 'original' : 'input'] = { receipt: supply.receipt, manifest: supply.manifest };
    current = await currentNativeReference(); token = current.accessToken; output.addSecret(token); report.nativeInput = current.preparation;
    report.sourceBindings = await current.sourceBindings(['MediaBrowser.MediaEncoding/Encoder/MediaEncoder.cs',
      'MediaBrowser.Providers/MediaInfo/FFProbeVideoInfo.cs', 'MediaBrowser.MediaEncoding/BdInfo/BdInfoExaminer.cs', 'Emby.Server.Implementations/Library/Resolvers/Movies/MovieResolver.cs',
      'MediaBrowser.MediaEncoding/Probing/MediaStreamInfo.cs', 'MediaBrowser.MediaEncoding/Probing/ProbeResultNormalizer.cs',
      'Emby.Server.Implementations/Library/LibraryManager.cs', 'Jellyfin.Api/Controllers/LibraryController.cs',
      'Jellyfin.Api/Controllers/ItemUpdateController.cs', 'MediaBrowser.Controller/Entities/Video.cs', 'MediaBrowser.Controller/IO/LocalMediaProxy.cs',
      'MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs']);
    if (original) report.subtitleSourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/SubtitleController.cs',
      'MediaBrowser.MediaEncoding/Subtitles/SubtitleEncoder.cs', 'MediaBrowser.MediaEncoding/Encoder/EncodingUtils.cs', 'MediaBrowser.Model/Dlna/StreamBuilder.cs']);
    await cp(current.sourceRoot, instanceRoot, { recursive: true, force: false, errorOnExist: true });
    await current.prepareClone(instanceRoot, port); report.syntheticPreparation = removeSyntheticPreparation(instanceRoot);
    await mkdir(mediaRoot);
    const storage = await configureStorage(root, mediaRoot); report.mountContract = storage.mountContract;
    await startNative('native-bluray-empty');
    for (const task of await idle()) assert.equal((await request('/ScheduledTasks/' + task.Id + '/Triggers', { method: 'POST', body: [] })).status, 204);
    assert.equal((await request('/Library/VirtualFolders?name=Original%20Blu-ray&collectionType=movies&refreshLibrary=false',
      { method: 'POST', body: { LibraryOptions: libraryOptions(mediaRoot) } })).status, 204);
    await scan('native-empty-scan'); await stopNative('native-empty-stopped');
    const emptyInstance = path.join(root, 'saved-empty-instance');
    await cp(instanceRoot, emptyInstance, { recursive: true, force: false, errorOnExist: true });
    report.emptyConfiguration = await describeFile(path.join(emptyInstance, 'config'));
    const emptyFile = path.join(root, 'native-empty.db'); await copyFile(databaseFilename(instanceRoot), emptyFile);
    report.binding = { serverId: current.preparation.nativeServerId, originIdentityDigest: sha256(await readFile(emptyFile)) };
    database = ownDatabase(await createPostgresTestDatabase(null, 'real_bluray'));
    await withSqlite(emptyFile, async source => {
      report.snapshots.empty = await orderedExchangeSnapshot(source, { signal: t.signal });
      report.imported = await transferDatabase(source, database, { signal: t.signal,
        instanceBinding: report.binding, portableMountContract: storage.mountContract });
    });
    assert.deepEqual(await orderedExchangeSnapshot(database, { signal: t.signal }), report.snapshots.empty);
    report.materialized = await materializeBluray(supply, disc);
    await mkdir(componentRoot);
    const componentInput = { files: supply.manifest.filter(member => member.kind === 'file'),
      ...(original ? { originalIsoSha256: supply.receipt.download.sha256 } : {}), ffprobe: validationExecutable('ffprobe') };
    const bytes = Buffer.from(JSON.stringify(componentInput, null, 2) + '\n'), inputFile = path.join(componentRoot, 'input.json');
    await writeFile(inputFile, bytes, { flag: 'wx' });
    report.componentInput = { bytes: bytes.length, sha256: sha256(bytes), base64: bytes.toString('base64') };
    const oracle = await compileOracle({ project: 'tests/library/fixtures/real-bluray-current/Oracle.csproj', output: path.join(componentRoot, 'build') });
    report.components = [];
    for (const label of ['native', 'native-repeat']) {
      const resultRoot = path.join(componentRoot, label);
      const receipt = await oracle.record({ output: resultRoot, args: [inputFile, disc, validationExecutable('ffmpeg'), '{output}'] });
      const captureBytes = await readFile(path.join(resultRoot, 'native.json'));
      const observation = { label, receipt, raw: { bytes: captureBytes.length, sha256: sha256(captureBytes), base64: captureBytes.toString('base64') } };
      report.components.push(observation);
      const capture = parseLosslessJson(captureBytes.toString('utf8')); observation.capture = capture;
      assert.equal(receipt.passed, true); assert.equal(capture.inputSha256, sha256(bytes));
      assert.equal(receipt.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, sha256(captureBytes));
      for (const flag of ['actualManagedFileSystem', 'actualMediaEncoder', 'actualFfprobe', 'actualNativeBdInfo']) assert.equal(capture[flag], true);
      assert.equal(capture.proxy.closed, true);
      for (const probe of capture.probes) assert.ok(capture.proxy.requests.some(request => request.Method === 'GET' && request.file === probe.file),
        'The component must read each selected M2TS through the designated source media proxy.');
      for (const assembly of capture.assemblies) assert.equal((await describeFile(assembly.filename)).sha256, assembly.sha256);
      assert.deepEqual(functionalJson(capture.sourceFiles), componentInput.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })));
    }
    const component = report.components[0].capture;
    assert.deepEqual(functionalJson(report.components[1].capture.plan), functionalJson(component.plan));
    assert.deepEqual(functionalJson(report.components[1].capture.selections), functionalJson(component.selections));
    assert.deepEqual(report.components[1].capture.probes.map(probe => probeValues(probe.information)), component.probes.map(probe => probeValues(probe.information)));
    proxy = await startDiscMediaProxy(disc, supply.manifest.map(({ kind, ...member }) => ({ ...member, type: kind }))); report.proxy = proxy.report;
    await startNative('native-bluray-baseline'); await scan('native-original-bluray-scan');
    await stopNative('native-baseline-scanned');
    await withSqlite(databaseFilename(instanceRoot), async source => {
      report.rows.native = await discRows(source, disc); itemId = report.rows.native.row.Id;
      report.snapshots.native = await orderedExchangeSnapshot(source, { signal: t.signal });
      assert.equal(functionalJson(report.rows.native.row.RunTimeTicks), component.actualDiscInfo.RunTimeTicks);
    });
    const firstNativeFile = component.plan.files[0].virtualPath;
    assert.ok(report.proxy.requests.some(request => request.phase === 'native-original-bluray-scan'
      && request.file === firstNativeFile && request.method === 'GET' && request.readBytes > 0 && request.handleClosed === true),
    'The Native first scan must probe the first M2TS selected by its BDInfo result.');
    await startNative('native-bluray-public'); report.native = await detail('native-original-bluray-detail');
    if (original) { report.subtitles = {}; await capturePgs('native', report.native.value); }
    if (playback) {
      report.playback = { native: {}, node: {} };
      nativePlayback = await captureDiscPlayback({ origin, token, itemId: idKey(itemId), detail: report.native.value,
        root, label: 'native-disc', report: report.playback.native, signal: t.signal });
    }
    await stopNative('native-baseline-complete');
    await rename(instanceRoot, path.join(root, 'retained-native-instance'));
    await cp(emptyInstance, instanceRoot, { recursive: true, force: false, errorOnExist: true });
    assert.deepEqual((await describeFile(path.join(instanceRoot, 'config'))).entries, report.emptyConfiguration.entries);
    await withSqlite(databaseFilename(instanceRoot), async source => assert.deepEqual(await orderedExchangeSnapshot(source, { signal: t.signal }), report.snapshots.empty));
    await startNode(database, 'node-bluray-first');
    const virtualDisc = '/bluray-instance/media/' + movieName;
    assert.equal(runtime.probe.vfs.capabilities(virtualDisc).create, false);
    const plan = await readBlurayDiscInfo(runtime.probe.vfs, virtualDisc, { signal: t.signal });
    assert.ok(plan); report.nodePlan = plan;
    const relative = value => value.slice(virtualDisc.length + 1);
    const projectedPlan = { playlistName: plan.playlistName, runTimeTicks: plan.runTimeTicks, chapters: plan.chapters,
      files: plan.files.map(file => ({ virtualPath: relative(file.virtualPath), timeIn: file.timeIn,
        timeOut: file.timeOut, relativeTimeIn: file.relativeTimeIn })) };
    assert.deepEqual(functionalJson(projectedPlan), functionalJson(component.plan));
    assert.deepEqual(plan.files.map(file => relative(file.virtualPath)), component.selections[0].files);
    await scan('node-original-bluray-first-scan');
    report.rows.node = await discRows(database, disc); assert.equal(idKey(report.rows.node.row.Id), idKey(itemId));
    assert.deepEqual(report.rows.node.technical, report.rows.native.technical);
    report.node = await detail('node-original-bluray-detail'); assert.deepEqual(report.node.technical, report.native.technical);
    if (original) {
      await capturePgs('node', report.node.value);
      assert.deepEqual(report.subtitles.node, report.subtitles.native);
      const args = report.nodeSubtitleProcesses?.find(({ args }) => args.includes('sup'))?.args;
      assert.ok(args, 'The Node production subtitle extractor must generate SUP.');
      assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 2), ['-map', `0:${report.subtitles.node.trackIndex}`]);
      assert.ok(args.includes('[private source]'));
    }
    if (nativePlayback) {
      const nodePlayback = await captureDiscPlayback({ origin, token, itemId: idKey(itemId), detail: report.node.value,
        root, label: 'node-disc', report: report.playback.node, signal: t.signal });
      assert.deepEqual(nodePlayback, nativePlayback);
    }
    const actualProbes = report.nodeProbes.filter(probe => probe.stage === 'node-original-bluray-first-scan');
    const firstProbe = actualProbes.find(probe => probe.virtualPath === virtualDisc + '/' + firstNativeFile);
    assert.ok(firstProbe, 'The independent first scan must probe the same first M2TS as Native.');
    for (const probe of actualProbes) {
      const expected = component.probes.find(entry => probe.virtualPath === virtualDisc + '/' + entry.file);
      assert.ok(expected, 'Every Node scan probe must consume a selected M2TS.');
      assert.deepEqual(probeValues(normalizeProbe(probe.result.raw, { path: path.join(disc, ...expected.file.split('/')), isAudio: false })), probeValues(expected.information));
    }
    await verifyBlurayDiscInfo(runtime.probe.vfs, plan, { signal: t.signal });
    await edit(editedMetadata);
    assert.equal((await request('/UserFavoriteItems/' + idKey(itemId), { method: 'POST' })).status, 200);
    report.nodeChanged = await detail('node-bluray-changed'); assert.equal(report.nodeChanged.value.UserData.IsFavorite, true);
    verifyEditedMetadata(report.nodeChanged);
    await stopNode('node-before-cold');
    const schema = database.schemaName;
    await database.close(); closedDatabaseOwners.add(database);
    database = ownDatabase(await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema }));
    if (!original && !playback) {
      const [device] = await database.rows('Devices', { where: { AccessToken: token }, limit: 1 });
      assert.ok(device);
      await database.update('Devices', { Id: device.Id }, { DateLastActivity: nativeDate(new Date(Date.now() - 181000)) });
    }
    report.snapshots.node = await orderedExchangeSnapshot(database, { signal: t.signal });
    const verifyColdRead = await observeAuthenticatedExchangeRead(database, token, { signal: t.signal });
    await startNode(database, 'node-bluray-cold'); report.nodeCold = await detail('node-bluray-cold-detail');
    assert.deepEqual(report.nodeCold.technical, report.nodeChanged.technical); assert.equal(report.nodeCold.value.UserData.IsFavorite, true);
    verifyEditedMetadata(report.nodeCold);
    await stopNode('node-cold-stopped');
    const cold = await verifyColdRead(report.snapshots.node);
    report.snapshots.nodeCold = cold.snapshot;
    report.deviceActivity = { nodeCold: cold.activity };
    if (!original && !playback) assert.ok(cold.activity, 'The stale device must refresh during the cold authenticated read.');
    const exported = path.join(root, 'node-export.db'); report.exported = await exportCurrentSqlite(database, exported, { signal: t.signal });
    assert.equal(report.exported.verified, true);
    await withSqlite(exported, async source => assert.deepEqual(await orderedExchangeSnapshot(source, { signal: t.signal }), report.snapshots.nodeCold));
    await installStoppedExport({ root, instanceRoot, exported });
    await startNative('native-bluray-continuation'); report.nativeImported = await detail('native-imported-bluray');
    assert.deepEqual(report.nativeImported.technical, report.nodeCold.technical); assert.equal(report.nativeImported.value.UserData.IsFavorite, true);
    verifyEditedMetadata(report.nativeImported);
    await edit({ Overview: 'Native continued original Blu-ray & 保留' });
    report.nativeContinued = await detail('native-continued-bluray');
    assert.equal(report.nativeContinued.value.Overview, 'Native continued original Blu-ray & 保留');
    assert.equal(report.nativeContinued.value.ProviderIds.DiscOpaque, 'opaque:traceId:complete-original');
    verifyEditedMetadata(report.nativeContinued, 'Native continued original Blu-ray & 保留');
    await stopNative('native-continuation-stopped');
    returned = ownDatabase(await createPostgresTestDatabase(null, 'real_bluray_return'));
    await withSqlite(databaseFilename(instanceRoot), async source => {
      report.snapshots.continued = await orderedExchangeSnapshot(source, { signal: t.signal }); report.rows.continued = await discRows(source, disc);
      report.returned = await transferDatabase(source, returned, { signal: t.signal,
        instanceBinding: report.binding, portableMountContract: storage.mountContract });
    });
    assert.deepEqual(await orderedExchangeSnapshot(returned, { signal: t.signal }), report.snapshots.continued);
    const verifyReturnedRead = await observeAuthenticatedExchangeRead(returned, token, { signal: t.signal });
    await startNode(returned, 'node-bluray-returned-cold'); report.returnedCold = await detail('node-returned-bluray-detail');
    assert.deepEqual(report.returnedCold.technical, report.nativeContinued.technical); assert.equal(report.returnedCold.value.UserData.IsFavorite, true);
    assert.equal(report.returnedCold.value.Overview, 'Native continued original Blu-ray & 保留');
    verifyEditedMetadata(report.returnedCold, 'Native continued original Blu-ray & 保留');
    await stopNode('node-returned-stopped');
    const returnedCold = await verifyReturnedRead(report.snapshots.continued);
    report.snapshots.returnedCold = returnedCold.snapshot;
    report.deviceActivity.returnedCold = returnedCold.activity;
    assert.deepEqual(await orderedExchangeSnapshot(database, { signal: t.signal }), report.snapshots.nodeCold);
    report.mediaAfter = await verifyBluray(supply, disc); assert.deepEqual(report.mediaAfter, report.materialized);
    await supply.verifyInputs();
    report[original ? 'originalInputsUnchanged' : 'inputsUnchanged'] = true;
    t.signal.throwIfAborted();
    report.acceptance = { originalCompleteBdmv: original, actualNativeAndNodeProbe: true, independentFirstScan: true,
      exactDatabaseExchange: true, nativeContinuedEdit: true, coldPostgresRead: true, fullDtoParity: false, phaseAcceptance: false };
  } catch (error) { failed = true; failure = error; report.failure = errorObservation(error); }
  finally {
    const errors = [];
    for (const operation of [() => stopNode('finally-node'), () => stopNative('finally-native'),
      () => { sqlite?.close(); sqlite = undefined; }, () => proxy?.close(), () => dropPostgresTestDatabase(returned),
      () => dropPostgresTestDatabase(database), ...[...databaseOwners].map(owner => async () => {
        await owner.close(); closedDatabaseOwners.add(owner);
      }), () => current?.finish()]) {
      try { await operation(); } catch (error) { ownerCloseFailed = true; errors.push(error); }
    }
    report.cleanup = { runtimeClosed: runtime === undefined, nativeExited: native === undefined,
      portAvailable: await portAvailable(port), mediaPortAvailable: await portAvailable(5244), proxyClosed: !proxy || proxy.report.closed === true,
      proxyStorageClosed: !proxy || proxy.report.registryClosed === true, sqliteOwnerClosed: sqlite === undefined,
      databaseOwnersClosed: closedDatabaseOwners.size === databaseOwners.size, normalOwnerClosure: !ownerCloseFailed };
    try { assert.deepEqual(report.cleanup, { runtimeClosed: true, nativeExited: true, portAvailable: true,
      mediaPortAvailable: true, proxyClosed: true, proxyStorageClosed: true, sqliteOwnerClosed: true,
      databaseOwnersClosed: true, normalOwnerClosure: true }); }
    catch (error) { ownerCloseFailed = true; errors.push(error); }
    report.cleanup.normalOwnerClosure = !ownerCloseFailed;
    report.cleanup.errors = errors.map(error => errorObservation(error));
    if (t.signal.aborted && !failed) { failed = true; failure = t.signal.reason; report.failure = errorObservation(failure); }
    if (errors.length) {
      failure = new AggregateError(failed ? [failure, ...errors] : errors, 'Blu-ray validation and cleanup failed.', failed ? { cause: failure } : undefined);
      failed = true; report.failure = errorObservation(failure);
    }
    report.passed = !failed;
    if (report.acceptance) report.acceptance.normalOwnerClosure = !ownerCloseFailed;
    if (ownerCloseFailed) report.privateRootRetained = true;
    await writeFile(path.join(root, 'report.json'), JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
    if (!ownerCloseFailed) await output.publishAndClose();
    else {
      await mkdir(destination);
      await writeFile(path.join(destination, 'report.json'), filterEvidenceJson({ ...report, passed: false, privateRootRetained: true }));
    }
  }
  if (failed) throw output.publicError(failure instanceof Error ? failure : new Error(String(failure), { cause: failure }));
}
