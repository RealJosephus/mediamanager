import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { transferDatabase, databaseDigest } from '../../src/migration/database-transfer.js';
import { runNativeCompleteLibraryScan } from '../../src/migration/complete-library-verifier.js';
import { startProductionInstance } from '../../src/main.js';
import { dateText } from '../../src/library/records.js';
import { nativeGuid } from '../../src/users/native.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { declareFileTestResource } from '../helpers/file-test-resource.js';
import { projectProblemTrace } from '../helpers/http-body-projection.js';
import { databaseFilename, idKey, portAvailable, removeSyntheticPreparation, sha, stoppedDatabase,
  unusedPort } from '../helpers/library-exchange-state.js';
import { startDownloadSource } from './fixtures/item-download-http/source.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES
  && process.env.MEDIAMANAGER_JELLYFIN_DLL;
const sourceLease = declareFileTestResource('native-media-5244', { enabled: Boolean(enabled) });
const discovery = declareFileTestResource('hdhomerun-discovery-65001', { enabled: Boolean(enabled) });
const inputBytes = await readFile(new URL('./fixtures/item-download-http/input.json', import.meta.url));
const input = JSON.parse(inputBytes);
const sourceBytes = Buffer.from('000102030405060708090a0b0c0d0e0f1020ff80fe7f0040424446484a4c4e50', 'hex');
const authorization = (token, deviceId = 'download-consumer') => `MediaBrowser Client="${input.client}", Device="${input.device}", DeviceId="${deviceId}", Version="1"${token ? `, Token="${token}"` : ''}`;
const nativeTypes = { Audio: 'Audio.Audio', Movie: 'Movies.Movie' };

function responseProjection(response, method) {
  if (response.transportError) return { transportError: response.transportError };
  const headers = Object.fromEntries(['content-type', 'content-disposition', 'content-range', 'accept-ranges', 'allow']
    .filter(name => response.headers[name] !== undefined).map(name => [name, response.headers[name]]));
  let json;
  if (response.headers['content-type']?.includes('json') && response.bytes) json = JSON.parse(Buffer.from(response.base64, 'base64').toString('utf8'));
  json = projectProblemTrace(json, response.status);
  if (json !== undefined) return { status: response.status, headers, json };
  const length = response.headers['content-length'];
  if (length !== undefined && method !== 'HEAD' && !response.headers['content-encoding']) {
    assert.match(length, /^\d+$/u);
    assert.equal(BigInt(length), BigInt(response.bytes), 'A declared entity length must match its fully consumed body.');
  }
  return { status: response.status, headers, bytes: response.bytes, sha256: response.sha256 };
}

function activityProjection(row, clock) {
  assert.ok(Number.isSafeInteger(row.Id) && row.Id > 0);
  const instant = Date.parse(dateText(row.DateCreated));
  assert.ok(instant >= clock.started - 1000 && instant <= clock.completed + 1000, 'The persisted download time belongs to this request.');
  return { Name: row.Name, Overview: row.Overview, ShortOverview: row.ShortOverview, Type: row.Type,
    UserId: idKey(row.UserId), ItemId: row.ItemId, LogSeverity: row.LogSeverity, RowVersion: String(row.RowVersion) };
}

test('actual Download authorization, typed gates, attachment bytes and committed activity match Native HTTP', {
  skip: !enabled, timeout: 900000,
}, async t => sourceLease.run(() => discovery.run(async () => {
  const destination = path.join(validationOutputRoot(), 'item-download-http-' + randomUUID());
  const output = await createPrivateFilterOutput(destination); output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  const secrets = new Set([process.env.MEDIAMANAGER_TEST_POSTGRES].filter(Boolean));
  await mkdir(output.root);
  const root = await realpath(output.root), instanceRoot = path.join(root, 'instance');
  const allowedRoot = path.join(root, 'media/Allowed'), hiddenRoot = path.join(root, 'media/Hidden');
  await mkdir(allowedRoot, { recursive: true }); await mkdir(hiddenRoot, { recursive: true });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`, remoteOrigin = 'http://127.0.0.1:5244/remote';
  const report = { inputSha256: sha(inputBytes), preparationRequests: [], sourceReads: [],
    native: [], node: [], dto: {}, mismatches: [], cleanup: [], diagnostics: [],
    fullInstanceVerified: false, completeLibraryVerified: false, phaseAcceptance: false, releaseAcceptance: false };
  let current, native, runtime, database, reader, nativeFailureDatabase, source, restoreSourceRead, failure, phase, activeCase, readLogs;
  let safeToRemove = true;
  const identities = {}, items = input.items.map((item, index) => ({ ...item,
    Id: `89000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
    Name: 'Download ' + item.key,
    path: item.noPath ? null : item.remote ? remoteOrigin + '/' + item.remote
      : path.join(item.hidden ? hiddenRoot : allowedRoot, item.file ?? item.key),
    bytes: item.shortcut ? Buffer.from(remoteOrigin + '/photo.jpg\n') : sourceBytes,
  }));
  const byKey = new Map(items.map(item => [item.key, item]));
  const observeSource = async target => {
    if (!activeCase || !readLogs) return null;
    const rows = (await readLogs()).filter(row => !activeCase.before.has(row.Id));
    const observed = { runtime: phase, case: activeCase.name, target: target.key ?? target.path ?? null,
      rows, observedAt: new Date().toISOString() };
    report.sourceReads.push(observed); return observed;
  };
  const request = async (route, { token = identities.admin?.token, method = 'GET', body, headers = {}, cleanup = false,
    deviceId, diagnostic = false } = {}) => {
    if (!cleanup) t.signal.throwIfAborted();
    const started = Date.now();
    let result;
    try {
      const response = await fetch(origin + route, { method,
        signal: cleanup ? AbortSignal.timeout(30000) : AbortSignal.any([t.signal, AbortSignal.timeout(30000)]),
        headers: { Authorization: authorization(token, deviceId), Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const bytes = Buffer.from(await response.arrayBuffer());
      result = { status: response.status, headers: Object.fromEntries(response.headers), bytes: bytes.length,
        sha256: sha(bytes), base64: bytes.toString('base64'), clock: { started, completed: Date.now() } };
      if (response.headers.get('content-type')?.includes('json') && bytes.length) result.json = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      result = { transportError: { name: error.name, code: error.code, message: error.message }, clock: { started, completed: Date.now() } };
    }
    if (diagnostic) report.preparationRequests.push({ route, method, result });
    return result;
  };
  const idle = async () => {
    const deadline = performance.now() + 120000;
    for (;;) {
      const result = await request('/ScheduledTasks'); assert.equal(result.status, 200);
      if (result.json.every(task => !['Running', 'Cancelling'].includes(task.State))) return result.json;
      assert.ok(performance.now() < deadline, 'Actual scheduled owners must drain before fixture snapshots.');
      await delay(100, undefined, { signal: t.signal });
    }
  };
  const stopNative = async label => {
    if (!native) return;
    const result = await native.stop(async () => (await request('/System/Shutdown', { method: 'POST', cleanup: true })).status, () => portAvailable(port));
    report.cleanup.push({ label, ...result }); safeToRemove &&= result.pidGone;
    if (result.pidGone) native = undefined;
    assert.ok(result.cleanShutdown && result.pidGone && result.portAvailable, label);
  };
  const closeNativeFailure = () => {
    const handle = nativeFailureDatabase;
    if (!handle) return;
    try { handle.database.exec('DROP TRIGGER download_activity_failure'); }
    finally { handle.close(); nativeFailureDatabase = undefined; }
  };
  const failureTrigger = async enabled => {
    if (phase === 'native') {
      if (!enabled) return closeNativeFailure();
      const handle = new SqliteDatabase(databaseFilename(instanceRoot), { requireMigrationHistory: true });
      try {
        handle.database.exec(`CREATE TRIGGER download_activity_failure BEFORE INSERT ON ActivityLogs WHEN NEW.Type = 'UserDownloadingContent' BEGIN SELECT RAISE(ABORT, 'Controlled download activity failure'); END`);
        nativeFailureDatabase = handle;
      } catch (error) { handle.close(); throw error; }
    } else if (enabled) {
      await database.client.query(`CREATE FUNCTION ${q(database.schemaName)}.download_activity_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Controlled download activity failure'; END $$`);
      await database.client.query(`CREATE TRIGGER download_activity_failure BEFORE INSERT ON ${q(database.schemaName)}."ActivityLogs" FOR EACH ROW WHEN (NEW."Type" = convert_to('UserDownloadingContent','UTF8')) EXECUTE FUNCTION ${q(database.schemaName)}.download_activity_failure()`);
    } else {
      await database.client.query(`DROP TRIGGER download_activity_failure ON ${q(database.schemaName)}."ActivityLogs"`);
      await database.client.query(`DROP FUNCTION ${q(database.schemaName)}.download_activity_failure()`);
    }
  };
  const captureDtos = async () => {
    const result = {};
    for (const identity of ['allowed', 'blocked', 'blockedAdmin', 'api']) {
      result[identity] = {};
      for (const item of items.filter(item => !item.hidden)) {
        const response = await request('/Items?Ids=' + idKey(item.Id) + '&Fields=CanDownload&EnableImages=false&EnableUserData=false',
          { token: identities[identity].token, deviceId: identities[identity].deviceId });
        assert.equal(response.status, 200);
        assert.equal(response.json.Items.length, 1);
        result[identity][item.key] = response.json.Items[0].CanDownload;
      }
    }
    return result;
  };
  const runCases = async label => {
    phase = label; report.dto[label] = await captureDtos();
    for (const sample of input.cases) {
      const identity = sample.identity === 'anonymous' ? { token: null } : sample.identity === 'invalid' ? { token: 'invalid-download-token' }
        : identities[sample.identity ?? 'allowed'];
      const item = byKey.get(sample.item), route = sample.route ?? '/Items/' + idKey(item.Id) + '/Download';
      const before = await readLogs();
      activeCase = { name: sample.name, item: sample.item, before: new Set(before.map(row => row.Id)) };
      const observed = { name: sample.name, route, method: sample.method ?? 'GET', item: sample.item ?? null, before };
      report[label].push(observed);
      try {
        if (sample.activityFailure) await failureTrigger(true);
        observed.response = await request(route, { token: identity.token, deviceId: identity.deviceId,
          method: sample.method ?? 'GET', headers: { ...(sample.range ? { Range: sample.range } : {}),
            ...(sample.ifRange ? { 'If-Range': sample.ifRange } : {}) } });
      } finally {
        if (sample.activityFailure) await failureTrigger(false);
        observed.after = await readLogs();
        observed.added = observed.after.filter(row => !activeCase.before.has(row.Id));
        activeCase = null;
      }
      observed.functional = { response: responseProjection(observed.response, sample.method ?? 'GET'),
        activity: observed.added.map(row => activityProjection(row, observed.response.clock)) };
      assert.equal(observed.response.transportError, undefined, sample.name + ' must complete its actual HTTP response.');
      if (label === 'native') assert.equal(observed.added.length, sample.logs, sample.name + ' Native activity prefix');
      if (label === 'native' && sample.status !== undefined) assert.equal(observed.response.status, sample.status, sample.name);
      if (sample.logs === 1 && observed.added.length === 1) {
        assert.equal(observed.added[0].Type, 'UserDownloadingContent');
        assert.equal(observed.added[0].ItemId, idKey(item.Id)); assert.equal(idKey(observed.added[0].UserId), idKey(identity.id));
      }
    }
  };
  try {
    current = await currentNativeReference(); identities.admin = { token: current.accessToken, id: current.userId };
    output.addSecret(current.accessToken); secrets.add(current.accessToken);
    report.input = current.preparation;
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/LibraryController.cs',
      'Jellyfin.Api/Auth/UserPermissionPolicy/UserPermissionHandler.cs', 'Jellyfin.Api/Helpers/FileStreamResponseHelpers.cs',
      'MediaBrowser.Controller/Entities/BaseItem.cs', 'MediaBrowser.Controller/Entities/Book.cs',
      'MediaBrowser.Controller/Entities/Photo.cs', 'MediaBrowser.Controller/Entities/Audio/Audio.cs',
      'MediaBrowser.Controller/Entities/AudioBook.cs', 'MediaBrowser.Controller/Entities/Video.cs',
      'MediaBrowser.Controller/Entities/Movies/Movie.cs', 'Emby.Server.Implementations/Library/MediaSourceManager.cs',
      'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs',
      'MediaBrowser.Model/Net/MimeTypes.cs', 'Jellyfin.Api/Middleware/ExceptionMiddleware.cs',
      'Jellyfin.Server.Implementations/Activity/ActivityManager.cs',
      'src/Jellyfin.Database/Jellyfin.Database.Implementations/Entities/ActivityLog.cs',
      'src/Jellyfin.Database/Jellyfin.Database.Implementations/JellyfinDbContext.cs']);
    await cp(current.sourceRoot, instanceRoot, { recursive: true, force: false, errorOnExist: true });
    await current.prepareClone(instanceRoot, port); report.syntheticPreparation = removeSyntheticPreparation(instanceRoot);
    native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label: 'native-download-preparation', origin });
    await native.ready();
    for (const task of await idle()) assert.equal((await request('/ScheduledTasks/' + task.Id + '/Triggers', { method: 'POST', body: [] })).status, 204);
    const folders = [];
    for (const [name, folder] of [['Allowed downloads', allowedRoot], ['Hidden downloads', hiddenRoot]]) {
      const options = { Enabled: true, EnableRealtimeMonitor: false, EnableInternetProviders: false, MetadataSavers: [],
        EnableChapterImageExtraction: false, ExtractChapterImagesDuringLibraryScan: false,
        EnableTrickplayImageExtraction: false, ExtractTrickplayImagesDuringLibraryScan: false, PathInfos: [{ Path: folder }] };
      assert.equal((await request('/Library/VirtualFolders?name=' + encodeURIComponent(name) + '&collectionType=homevideos&refreshLibrary=false',
        { method: 'POST', body: { LibraryOptions: options }, diagnostic: true })).status, 204);
      folders.push(name);
    }
    await idle();
    report.emptyScan = await runNativeCompleteLibraryScan({ baseUrl: origin, accessToken: current.accessToken,
      signal: t.signal, scanTimeoutMs: 180000 });
    const views = await request('/Library/VirtualFolders'); assert.equal(views.status, 200);
    const allowedFolder = views.json.find(folder => folder.Name === folders[0]), hiddenFolder = views.json.find(folder => folder.Name === folders[1]);
    assert.ok(allowedFolder?.ItemId && hiddenFolder?.ItemId);
    for (const [key, administrator, downloading] of [['allowed', false, true], ['blocked', false, false], ['blockedAdmin', true, false]]) {
      const username = 'Download_' + key, password = randomUUID(), deviceId = 'download-' + key;
      output.addSecret(password); secrets.add(password);
      const created = await request('/Users/New', { method: 'POST', body: { Name: username, Password: password }, diagnostic: true });
      assert.equal(created.status, 200);
      assert.equal((await request('/Users/' + created.json.Id + '/Policy', { method: 'POST', body: { ...created.json.Policy,
        IsAdministrator: administrator, EnableContentDownloading: downloading, EnableAllFolders: true,
        BlockedTags: ['download-hidden'] }, diagnostic: true })).status, 204);
      const login = await request('/Users/AuthenticateByName', { token: null, deviceId, method: 'POST',
        body: { Username: username, Pw: password } });
      assert.equal(login.status, 200); identities[key] = { id: created.json.Id, token: login.json.AccessToken, username, deviceId };
      output.addSecret(login.json.AccessToken); secrets.add(login.json.AccessToken);
    }
    assert.equal((await request('/Auth/Keys?app=DownloadConsumer', { method: 'POST' })).status, 204);
    const keys = await request('/Auth/Keys'); assert.equal(keys.status, 200);
    const key = keys.json.Items.find(entry => entry.AppName === 'DownloadConsumer'); assert.ok(key?.AccessToken);
    identities.api = { token: key.AccessToken }; output.addSecret(key.AccessToken); secrets.add(key.AccessToken);
    await stopNative('native-download-preparation');
    reader = new SqliteDatabase(databaseFilename(instanceRoot), { requireMigrationHistory: true });
    try {
      for (const item of items) {
        if (!item.noPath && !item.remote) {
          if (item.folder) await mkdir(item.path, { recursive: true });
          else await writeFile(item.path, item.bytes, { flag: 'wx' });
        }
        const parentId = nativeGuid(item.hidden ? hiddenFolder.ItemId : allowedFolder.ItemId);
        const data = { ...(item.type === 'Movie' || item.type === 'Video' ? { VideoType: item.videoType ?? 'VideoFile' } : {}),
          ...(item.shortcut ? { IsShortcut: true, ShortcutPath: remoteOrigin + '/photo.jpg' } : {}) };
        reader.insert('BaseItems', postgresTestRow('BaseItems', { Id: item.Id, Name: item.Name,
          Type: 'MediaBrowser.Controller.Entities.' + (nativeTypes[item.type] ?? item.type),
          Path: item.path, ParentId: parentId, TopParentId: parentId, IsFolder: item.type === 'Folder',
          Tags: item.hidden ? 'download-hidden' : null,
          MediaType: ['Book', 'Photo', 'Audio', 'AudioBook'].includes(item.type) ? item.type === 'AudioBook' ? 'Audio' : item.type
            : ['Movie', 'Video'].includes(item.type) ? 'Video' : null,
          DateCreated: '2026-10-20 12:34:56.1234567', Data: JSON.stringify(data) }));
        reader.insert('AncestorIds', { ItemId: item.Id, ParentItemId: parentId });
      }
      report.seedRows = await reader.rows('BaseItems', { whereIn: { Id: items.map(item => item.Id) } });
    } finally { reader.close(); reader = undefined; }
    const baseline = path.join(root, 'baseline.db'); await stoppedDatabase(databaseFilename(instanceRoot));
    await copyFile(databaseFilename(instanceRoot), baseline); report.baselineSha256 = sha(await readFile(baseline));
    source = await startDownloadSource({ localFiles: items.filter(item => !item.noPath && !item.remote && !item.folder),
      remoteFiles: items.filter(item => item.remote), observe: observeSource }); report.source = source.report;
    native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label: 'native-download-matrix', origin });
    await native.ready(); await idle();
    reader = new SqliteDatabase(databaseFilename(instanceRoot), { readOnly: true, requireMigrationHistory: true });
    readLogs = () => reader.rows('ActivityLogs', { where: { Type: 'UserDownloadingContent' } });
    await runCases('native'); reader.close(); reader = undefined; await stopNative('native-download-matrix');
    const ancestors = path.join(root, 'empty-ignore-ancestors'); await mkdir(ancestors);
    const style = process.platform === 'win32' ? 'windows' : 'posix', caseSensitive = style === 'posix';
    const contract = { mounts: [{ mountId: 'download-files', identityRoot: root, accessRoot: '/download-files', pathStyle: style,
      caseSensitive, returnPolicy: 'required' }] };
    await writeFile(path.join(root, 'storage.json'), JSON.stringify({
      instances: [{ id: 'download-files', type: 'local', config: { root, writable: true } },
        { id: 'download-http', type: 'http', config: {} }, { id: 'empty-ancestors', type: 'local', config: { root: ancestors, writable: false } }],
      mounts: [{ path: '/download-files', instanceId: 'download-files', capabilities: {} },
        { path: '/download-http', instanceId: 'download-http', capabilities: {} },
        { path: '/empty-ignore-ancestors', instanceId: 'empty-ancestors', capabilities: {} }],
      prefixes: [{ identityRoot: root, accessRoot: '/download-files', style, caseSensitive, returnAccess: 'Explicit private download source files.' },
        { identityRoot: remoteOrigin, accessRoot: '/download-http', style: 'uri', caseSensitive: true, returnAccess: 'The same owned real HTTP download source.' }],
      ignorePrefixes: [{ identityRoot: path.parse(root).root, accessRoot: '/empty-ignore-ancestors', style, caseSensitive,
        returnAccess: 'Declared empty host ancestors for the isolated download roots.' }],
    }, null, 2) + '\n');
    database = await createPostgresTestDatabase(null, 'download_http');
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
    readLogs = () => database.rows('ActivityLogs', { where: { Type: 'UserDownloadingContent' } });
    // The VFS and plugin adapter both expose facades. Observe the actual
    // installed Local prototype, scoped to this root and declared case path.
    const sourceAdapter = runtime.playback.vfs.resolve('/download-files').adapter;
    const sourcePaths = new Map(items.filter(item => !item.noPath && !item.remote && !item.folder).map(item => {
      const accessPath = path.posix.join('/download-files', path.relative(root, item.path).split(path.sep).join('/'));
      return [item.key, runtime.playback.vfs.resolve(accessPath).path];
    }));
    const sourceRoot = sourceAdapter.root, sourcePrototype = Object.getPrototypeOf(sourceAdapter);
    const readDescriptor = Object.getOwnPropertyDescriptor(sourcePrototype, 'openRead'), openRead = readDescriptor.value;
    Object.defineProperty(sourcePrototype, 'openRead', { ...readDescriptor, value: async function (...args) {
      if (this.root === sourceRoot && activeCase && args[0] === sourcePaths.get(activeCase.item)) {
        await observeSource({ key: activeCase.item, path: args[0] });
      }
      return openRead.apply(this, args);
    } });
    restoreSourceRead = () => Object.defineProperty(sourcePrototype, 'openRead', readDescriptor);
    await idle(); await runCases('node');
    assert.deepEqual(report.dto.node, report.dto.native);
    for (const sample of input.cases) {
      const expected = report.native.find(entry => entry.name === sample.name), actual = report.node.find(entry => entry.name === sample.name);
      try {
        assert.deepEqual(actual.functional, expected.functional);
        const expectedReads = report.sourceReads.filter(entry => entry.runtime === 'native' && entry.case === sample.name);
        const actualReads = report.sourceReads.filter(entry => entry.runtime === 'node' && entry.case === sample.name);
        if (expectedReads.length) {
          assert.ok(actualReads.length, 'The candidate must actually open its declared source.');
          for (const observed of [...expectedReads, ...actualReads]) assert.equal(observed.rows.length, sample.logs,
            'The persistent download activity prefix must be committed before storage is opened.');
        }
      } catch (error) { report.mismatches.push({ name: sample.name, message: error.message }); }
    }
    assert.deepEqual(report.mismatches, []);
  } catch (error) { failure = error; report.failure = { name: error.name, code: error.code, message: error.message, stack: error.stack }; }
  finally {
    const attempt = async operation => { try { await operation(); } catch (error) {
      failure ??= error; report.cleanup.push({ error: { name: error.name, code: error.code, message: error.message } });
    } };
    activeCase = null;
    await attempt(closeNativeFailure);
    await attempt(() => stopNative('native-finally'));
    await attempt(() => { reader?.close(); reader = undefined; });
    await attempt(() => { restoreSourceRead?.(); restoreSourceRead = undefined; });
    await attempt(async () => {
      if (!runtime) return;
      const listeners = runtime.networkHost.listeners; await runtime.close(); runtime = undefined;
      assert.ok(listeners.every(listener => !listener.server.listening)); assert.equal(await portAvailable(port), true);
      report.cleanup.push({ runtimeClosed: true, portAvailable: true });
    });
    if (!runtime) await attempt(async () => { await dropPostgresTestDatabase(database); report.cleanup.push({ postgresSchemaRemoved: true }); });
    else { safeToRemove = false; await attempt(() => database?.close()); }
    await attempt(async () => { if (source) { await source.close(); assert.equal(source.report.closed, true);
      assert.equal(await portAvailable(5244), true); source = undefined; } });
    await attempt(() => current?.finish());
    report.passed = !failure;
    await writeFile(path.join(root, 'report.json'), filterEvidenceJson(report, secrets));
    await writeFile(path.join(root, 'provenance.json'), filterEvidenceJson({ inputSha256: sha(inputBytes), sourceBindings: report.sourceBindings,
      actualNativeHttp: report.native.length === input.cases.length, productionNodeHttp: report.node.length === input.cases.length,
      sourceReadsObserved: report.sourceReads.length, noProbeOrMediaEncoding: true,
      fullInstanceVerified: false, completeLibraryVerified: false, phaseAcceptance: false, releaseAcceptance: false }, secrets));
    if (native || runtime || source) safeToRemove = false;
    if (safeToRemove) await attempt(() => output.publishAndClose());
    else {
      await mkdir(destination); await writeFile(path.join(destination, 'report.json'), filterEvidenceJson({ ...report, privateRootRetained: true }, secrets));
      failure ??= new Error('The owned Download fixture did not release its private root.');
    }
  }
  if (failure) throw output.publicError(failure);
}, { signal: t.signal }), { signal: t.signal }));
