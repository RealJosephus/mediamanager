import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { dateTicks } from '../../src/library/records.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { discoverInstanceState } from '../../src/migration/instance-state.js';
import { startProductionInstance } from '../../src/main.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { databaseFilename, guid, idKey, mediaFiles, portableMountContract, seedRecordings, sha,
  relocateOriginalSeed, snapshot, sqliteSnapshot, stateFiles, storageDocument } from './fixtures/live-tv-recordings-http/scenario.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const inputBytes = await readFile(new URL('./fixtures/live-tv-recordings-http/input.json', import.meta.url));
const input = JSON.parse(inputBytes);
const enabled = process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_JELLYFIN_DLL;
const authorization = token => `MediaBrowser Client="Existing Live TV recordings", Device="Isolated", DeviceId="existing-live-tv-recordings", Version="1"${token ? `, Token="${token}"` : ''}`;
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const unusedPort = () => new Promise((resolve, reject) => {
  const server = createServer(); server.once('error', reject).listen(0, '127.0.0.1', () => {
    const port = server.address().port; server.close(error => error ? reject(error) : resolve(port));
  });
});
const portAvailable = port => new Promise(resolve => {
  const server = createServer(); server.once('error', () => resolve(false)).listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
});
const dateFields = new Set(['DateCreated', 'DateLastSaved', 'DateLastRefreshed', 'DateLastMediaAdded', 'PremiereDate', 'LastPlayedDate', 'StartDate', 'EndDate']);
function wire(response) {
  const project = (value, key) => {
    if (Array.isArray(value)) return value.map(entry => project(entry));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, project(entry, name)]));
    if (key === 'traceId') { assert.ok(typeof value === 'string' && value); return '$trace'; }
    if (dateFields.has(key) && typeof value === 'string') return { ticks: String(dateTicks(value)), utc: value.endsWith('Z') };
    return value;
  };
  return { status: response.status, contentType: response.contentType,
    body: Object.hasOwn(response, 'bodyJson') ? project(response.bodyJson) : response.bodyText };
}
const delta = (before, after) => Object.fromEntries(Object.keys(before).map(table => [table, {
  removed: before[table].filter(row => !after[table].includes(row)),
  added: after[table].filter(row => !before[table].includes(row)),
}]));

test('existing recordings list, folders, detail and retained-file deletion match actual native HTTP and production PostgreSQL', {
  skip: !enabled, timeout: 540000,
}, async () => {
  const output = await createPrivateFilterOutput(path.join(validationOutputRoot(), 'live-tv-recordings-http-' + randomUUID()));
  output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  await mkdir(output.root);
  const root = await realpath(output.root), referenceRoot = path.join(root, 'reference'), mediaRoot = path.join(root, 'media');
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const report = { inputSha256: sha(inputBytes), cases: [], differences: [], processes: [], cleanup: [], runtimeErrors: [] };
  let current, native, database, application, failure, graph, userRootId;
  const tokens = { anonymous: undefined, invalid: 'invalid-recordings-token' }, users = {};
  const request = async (server, route, { mode, token = tokens[mode], method = 'GET', body } = {}) => {
    const response = await fetch(server + route, { method, signal: AbortSignal.timeout(30000), headers: {
      Authorization: authorization(token), Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const bodyText = await response.text(); let bodyJson;
    try { if (bodyText !== '') bodyJson = JSON.parse(bodyText); } catch { /* Preserve empty and non-JSON response bodies. */ }
    return { status: response.status, contentType: response.headers.get('content-type'), bodyText,
      ...(bodyJson === undefined ? {} : { bodyJson }) };
  };
  const stopNative = async label => {
    if (!native) return;
    const result = await native.stop(async () => (await request(origin, '/System/Shutdown', {
      token: current.accessToken, method: 'POST' })).status, () => portAvailable(port));
    report.processes.push({ label, ...result }); native = undefined;
    assert.ok(result.cleanShutdown && result.pidGone && result.portAvailable, label);
  };
  const captureNative = async () => ({ database: await sqliteSnapshot(referenceRoot), state: await stateFiles(referenceRoot, graph), media: await mediaFiles(graph) });
  const captureNode = async () => ({ database: await application.store.run(snapshot), state: await stateFiles(referenceRoot, graph), media: await mediaFiles(graph) });
  const collect = (name, action) => { try { action(); } catch (error) { report.differences.push({ name, message: error.message }); } };
  const readCases = () => {
    const samples = [], add = (name, route, modes = ['allowed', 'apiKey']) => samples.push({ name, route, modes });
    for (const route of ['/LiveTv/Recordings', '/LiveTv/Recordings/Folders', '/LiveTv/Recordings/Series', '/LiveTv/Recordings/Groups',
      '/LiveTv/Recordings/' + idKey(graph.ids.movie)]) add('authorization ' + route, route,
      ['anonymous', 'invalid', 'denied', 'allowed', 'restricted', 'admin', 'apiKey']);
    for (const query of ['isMovie=true', 'isMovie=false', 'isSeries=true', 'isSeries=false', 'isMovie=true&isSeries=true',
      'isSports=true', 'isSports=false', 'isKids=true', 'isKids=false', 'isSports=true&isKids=true',
      'isNews=true&isLibraryItem=false&channelId=not-a-guid&seriesTimerId=not-a-guid&status=Error',
      'status=unknown', 'status=999', 'isInProgress=true&limit=1', 'isInProgress=true&startIndex=2&limit=0&enableTotalRecordCount=false',
      'isInProgress=false', 'startIndex=1&limit=2', 'startIndex=-2&limit=2', 'limit=0', 'limit=-1',
      'startIndex=999', 'enableTotalRecordCount=false&limit=2', 'enableTotalRecordCount=false&limit=0',
      'fields=CanDelete,CanDownload,DisplayPreferencesId,Etag,Overview,Path,Tags,Genres,MediaStreams',
      'enableImages=false&enableUserData=false', 'imageTypeLimit=0&enableImageTypes=Primary,Thumb,unknown',
      'fields=Path,unknown&fields=Overview', 'isMovie=invalid', 'limit=invalid', 'userId=invalid', 'enableTotalRecordCount=invalid']) {
      add('list ' + query, '/LiveTv/Recordings?' + query);
    }
    for (const route of ['/LiveTv/Recordings', '/LiveTv/Recordings/Folders', '/LiveTv/Recordings/' + idKey(graph.ids.restricted)]) {
      add('self user ' + route, route + '?userId=' + idKey(users.allowed.Id), ['allowed']);
      add('selected user ' + route, route + '?userId=' + idKey(users.restricted.Id), ['admin', 'apiKey', 'allowed']);
      add('empty user ' + route, route + '?userId=' + '0'.repeat(32), ['allowed', 'apiKey']);
      add('missing user ' + route, route + '?userId=' + 'f'.repeat(32), ['admin']);
    }
    for (const [key, id] of Object.entries(graph.ids)) {
      add('detail arbitrary persisted type ' + key, '/LiveTv/Recordings/' + idKey(id), ['allowed', 'restricted', 'apiKey']);
    }
    add('detail Guid D format', '/LiveTv/Recordings/' + guid(graph.ids.movie), ['allowed']);
    add('detail empty identity is user root', '/LiveTv/Recordings/' + '0'.repeat(32));
    add('detail missing', '/LiveTv/Recordings/' + 'f'.repeat(32));
    add('detail invalid', '/LiveTv/Recordings/not-a-guid');
    add('obsolete series binds unused bool', '/LiveTv/Recordings/Series?isInProgress=invalid&userId=invalid');
    add('obsolete series ignores unbound flags and requested user', '/LiveTv/Recordings/Series?isMovie=invalid&userId=' + idKey(users.restricted.Id), ['allowed']);
    add('obsolete groups binds user', '/LiveTv/Recordings/Groups?userId=invalid');
    add('obsolete groups does not select requested user', '/LiveTv/Recordings/Groups?userId=' + idKey(users.restricted.Id), ['allowed']);
    return samples;
  };
  const deletionCases = () => [
    { name: 'anonymous delete', route: '/LiveTv/Recordings/' + idKey(graph.ids.delete), mode: 'anonymous' },
    { name: 'access without management delete', route: '/LiveTv/Recordings/' + idKey(graph.ids.delete), mode: 'allowed' },
    { name: 'invalid delete binding', route: '/LiveTv/Recordings/not-a-guid', mode: 'manager' },
    { name: 'empty delete identity is not a root selector', route: '/LiveTv/Recordings/' + '0'.repeat(32), mode: 'manager' },
    { name: 'missing delete', route: '/LiveTv/Recordings/' + 'f'.repeat(32), mode: 'manager' },
    { name: 'API key authorizes userless missing delete', route: '/LiveTv/Recordings/' + 'f'.repeat(32), mode: 'apiKey' },
    { name: 'administrator bypasses disabled management for missing delete', route: '/LiveTv/Recordings/' + 'f'.repeat(32), mode: 'admin' },
    { name: 'management retains media despite disabled content deletion', route: '/LiveTv/Recordings/' + idKey(graph.ids.delete), mode: 'manager' },
    { name: 'repeated delete', route: '/LiveTv/Recordings/' + idKey(graph.ids.delete), mode: 'manager' },
  ];
  const observe = async (label, server, samples, method = 'GET') => {
    const values = [];
    for (const sample of samples) for (const mode of sample.modes ?? [sample.mode]) {
      const errorIndex = report.runtimeErrors.length, response = await request(server, sample.route, { mode, method });
      const value = { name: sample.name, mode, request: { method, route: sample.route }, response };
      if (label === 'node' && response.status < 500) assert.deepEqual(report.runtimeErrors.slice(errorIndex), [], sample.name + ': no hidden background error');
      values.push(value);
      await writeFile(path.join(root, label + '-' + method.toLowerCase() + '-progress.log'), filterEvidenceJson(value) + '\n', { flag: 'a' });
    }
    return values;
  };
  const compare = (label, candidate, expected) => {
    assert.equal(candidate.length, expected.length);
    for (const [index, value] of candidate.entries()) {
      report.cases.push({ stage: label, ...value, native: expected[index].response });
      collect(label + ': ' + value.name + ':' + value.mode, () => {
        assert.deepEqual(value.request, expected[index].request); assert.equal(value.mode, expected[index].mode);
        assert.deepEqual(wire(value.response), wire(expected[index].response));
      });
    }
  };
  try {
    current = await currentNativeReference(); output.addSecret(current.accessToken); report.input = current.preparation;
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/LiveTvController.cs',
      'src/Jellyfin.LiveTv/LiveTvManager.cs', 'src/Jellyfin.LiveTv/Recordings/RecordingsManager.cs',
      'MediaBrowser.Controller/Entities/BaseItem.cs', 'MediaBrowser.Controller/Entities/Video.cs',
      'MediaBrowser.Controller/Entities/CollectionFolder.cs', 'Emby.Server.Implementations/Library/LibraryManager.cs',
      'Emby.Server.Implementations/Dto/DtoService.cs', 'MediaBrowser.Controller/Providers/DirectoryService.cs',
      'Emby.Server.Implementations/ScheduledTasks/Tasks/RefreshMediaLibraryTask.cs', 'Jellyfin.Api/Controllers/ScheduledTasksController.cs']);
    await cp(current.sourceRoot, referenceRoot, { recursive: true, filter: filename => !path.relative(current.sourceRoot, filename).replaceAll('\\', '/').startsWith('log/') });
    await mkdir(path.join(referenceRoot, 'log'), { recursive: true }); await current.prepareClone(referenceRoot, port);
    report.originalSeedPreparation = await relocateOriginalSeed(referenceRoot, mediaRoot);
    report.recordingDirectoryPreparation = { beforeFirstNativeStartup: true, files: {} };
    assert.equal(path.basename(input.registration.filename), input.registration.filename);
    for (const name of ['main', 'movies']) {
      const directory = path.join(mediaRoot, name), filename = path.join(directory, input.registration.filename);
      const bytes = Buffer.from(input.registration.text); await mkdir(directory, { recursive: true }); await writeFile(filename, bytes, { flag: 'wx' });
      report.recordingDirectoryPreparation.files[name] = { path: filename, bytes: bytes.length, sha256: sha(bytes) };
    }
    const mainPath = path.join(mediaRoot, 'main'), moviePath = path.join(mediaRoot, 'movies');
    await writeFile(path.join(referenceRoot, 'config/livetv.xml'), '<LiveTvOptions><RecordingPath>' + xml(mainPath)
      + '</RecordingPath><MovieRecordingPath>' + xml(moviePath) + '</MovieRecordingPath><SeriesRecordingPath>' + xml(mainPath)
      + '</SeriesRecordingPath><TunerHosts /></LiveTvOptions>');
    await mkdir(path.join(referenceRoot, 'data/data/livetv'), { recursive: true });
    for (const name of ['timers.json', 'seriestimers.json']) await writeFile(path.join(referenceRoot, 'data/data/livetv', name), '[]\n');
    native = current.start({ referenceRoot, outputRoot: root, label: 'native-registration', origin }); await native.ready();
    const rootResponse = await request(origin, '/Items/Root', { token: current.accessToken }); assert.equal(rootResponse.status, 200);
    userRootId = rootResponse.bodyJson.Id; report.userRoot = rootResponse.bodyJson;
    const deadline = Date.now() + 45000;
    while (true) {
      const listed = await request(origin, '/Library/VirtualFolders', { token: current.accessToken }); assert.equal(listed.status, 200);
      const locations = listed.bodyJson.flatMap(folder => folder.Locations);
      const tasks = await request(origin, '/ScheduledTasks', { token: current.accessToken }); assert.equal(tasks.status, 200);
      if (locations.includes(mainPath) && locations.includes(moviePath) && tasks.bodyJson.every(task => task.State !== 'Running' && task.State !== 'Cancelling')) {
        report.registeredFolders = listed.bodyJson; report.registrationTasks = tasks.bodyJson; break;
      }
      assert.ok(Date.now() < deadline, 'Native startup must register both nonempty recording paths and finish its startup tasks.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    for (const folder of report.registeredFolders.filter(folder => folder.Locations.some(location => [mainPath, moviePath].includes(location)))) {
      assert.equal((await request(origin, '/Library/VirtualFolders/LibraryOptions', { token: current.accessToken, method: 'POST',
        body: { Id: folder.ItemId, LibraryOptions: { ...folder.LibraryOptions, EnableRealtimeMonitor: false } } })).status, 204);
    }
    for (const task of report.registrationTasks) assert.equal((await request(origin, '/ScheduledTasks/' + task.Id + '/Triggers', {
      token: current.accessToken, method: 'POST', body: [] })).status, 204);
    const disabledTasks = await request(origin, '/ScheduledTasks', { token: current.accessToken }); assert.equal(disabledTasks.status, 200);
    assert.ok(disabledTasks.bodyJson.length > 0 && disabledTasks.bodyJson.every(task => task.Triggers.length === 0));
    const disabledLibraries = await request(origin, '/Library/VirtualFolders', { token: current.accessToken }); assert.equal(disabledLibraries.status, 200);
    const recordingLibraries = disabledLibraries.bodyJson.filter(folder => folder.Locations.some(location => [mainPath, moviePath].includes(location)));
    assert.equal(recordingLibraries.length, 2); assert.ok(recordingLibraries.every(folder => folder.LibraryOptions.EnableRealtimeMonitor === false));
    report.backgroundControls = { tasks: disabledTasks.bodyJson, libraries: recordingLibraries };
    // Recording-directory registration can request its scan before the host has
    // registered scheduled workers. Invoke the actual now-registered task and
    // require a new completed execution before relying on its physical roots.
    const scanTask = disabledTasks.bodyJson.find(task => task.Key === 'RefreshLibrary');
    assert.ok(scanTask, 'The actual native RefreshLibrary task must be registered.');
    const previousScanStart = scanTask.LastExecutionResult?.StartTimeUtc;
    report.registrationScan = { before: scanTask };
    assert.equal((await request(origin, '/ScheduledTasks/Running/' + scanTask.Id, { token: current.accessToken, method: 'POST' })).status, 204);
    const scanDeadline = Date.now() + 90000;
    while (true) {
      const taskResponse = await request(origin, '/ScheduledTasks/' + scanTask.Id, { token: current.accessToken }); assert.equal(taskResponse.status, 200);
      const observed = taskResponse.bodyJson, result = observed.LastExecutionResult;
      report.registrationScan.after = observed;
      if (observed.State === 'Idle' && result && result.StartTimeUtc !== previousScanStart) {
        assert.equal(result.Status, 'Completed', 'The real native recording-root scan must finish successfully.'); break;
      }
      assert.ok(Date.now() < scanDeadline, 'The real native recording-root scan must publish a new completed execution.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const recordingFolders = await request(origin, '/LiveTv/Recordings/Folders', { token: current.accessToken });
    assert.equal(recordingFolders.status, 200); report.registeredFolderDtos = recordingFolders.bodyJson.Items;
    assert.deepEqual(report.registeredFolderDtos.map(folder => idKey(folder.Id)).sort(), recordingLibraries.map(folder => idKey(folder.ItemId)).sort(),
      'The actual native recording reader must resolve both newly scanned collection folders.');
    const policies = {
      allowed: { EnableLiveTvAccess: true, EnableLiveTvManagement: false },
      restricted: { EnableLiveTvAccess: true, EnableLiveTvManagement: false, BlockedTags: ['restricted'] },
      denied: { EnableLiveTvAccess: false, EnableLiveTvManagement: false },
      admin: { IsAdministrator: true, EnableLiveTvAccess: false, EnableLiveTvManagement: false },
      manager: { EnableLiveTvAccess: true, EnableLiveTvManagement: true, EnableContentDeletion: false },
    };
    for (const [mode, policy] of Object.entries(policies)) {
      const name = 'Recordings_' + mode + '_' + randomUUID().slice(0, 8), password = randomUUID(); output.addSecret(password);
      const created = await request(origin, '/Users/New', { token: current.accessToken, method: 'POST', body: { Name: name, Password: password } });
      assert.equal(created.status, 200); users[mode] = created.bodyJson;
      assert.equal((await request(origin, '/Users/' + created.bodyJson.Id + '/Policy', { token: current.accessToken,
        method: 'POST', body: { ...created.bodyJson.Policy, ...policy } })).status, 204);
      const login = await request(origin, '/Users/AuthenticateByName', { method: 'POST', body: { Username: name, Pw: password } });
      assert.equal(login.status, 200); tokens[mode] = login.bodyJson.AccessToken; output.addSecret(tokens[mode]);
    }
    const app = 'Recording fixture ' + randomUUID();
    assert.equal((await request(origin, '/Auth/Keys?app=' + encodeURIComponent(app), { token: current.accessToken, method: 'POST' })).status, 204);
    const keys = await request(origin, '/Auth/Keys', { token: current.accessToken }); assert.equal(keys.status, 200);
    tokens.apiKey = keys.bodyJson.Items.find(key => key.AppName === app).AccessToken; output.addSecret(tokens.apiKey);
    await stopNative('native-registration');
    graph = await seedRecordings(referenceRoot, mediaRoot, input, userRootId, report.registeredFolderDtos,
      report.originalSeedPreparation, report.recordingDirectoryPreparation); report.graph = graph;
    native = current.start({ referenceRoot, outputRoot: root, label: 'native-reads', origin }); await native.ready();
    assert.equal((await request(origin, '/UserFavoriteItems/' + idKey(graph.ids.movie), { mode: 'allowed', method: 'POST' })).status, 200);
    for (const route of ['/LiveTv/Recordings', '/LiveTv/Recordings/Folders', '/LiveTv/Recordings/' + idKey(graph.ids.movie)]) {
      assert.equal((await request(origin, route, { mode: 'allowed' })).status, 200);
    }
    report.nativeBeforeReads = await captureNative();
    report.nativeReads = await observe('native', origin, readCases());
    report.nativeAfterReads = await captureNative(); assert.deepEqual(report.nativeAfterReads, report.nativeBeforeReads);
    await stopNative('native-reads'); report.nativeAfterReadShutdown = await captureNative();
    assert.deepEqual(report.nativeAfterReadShutdown, report.nativeAfterReads);
    const source = new SqliteDatabase(databaseFilename(referenceRoot), { readOnly: true, requireMigrationHistory: true });
    try {
      database = await createPostgresTestDatabase(null, 'recording_http');
      const instance = await discoverInstanceState({ instanceRoot: referenceRoot });
      report.transfer = await transferDatabase(source, database, { instanceBinding: {
        serverId: current.preparation.nativeServerId, originIdentityDigest: instance.identity.digest }, portableMountContract: portableMountContract(mediaRoot) });
    } finally { source.close(); }
    await database.close();
    native = current.start({ referenceRoot, outputRoot: root, label: 'native-deletion', origin }); await native.ready();
    report.nativeBeforeDelete = await captureNative();
    report.nativeDeletes = await observe('native', origin, deletionCases(), 'DELETE');
    report.nativeAfterDelete = await captureNative();
    assert.deepEqual(report.nativeAfterDelete.media, report.nativeBeforeDelete.media);
    assert.deepEqual(report.nativeAfterDelete.state, report.nativeBeforeDelete.state);
    await stopNative('native-deletion'); report.nativeAfterDeleteShutdown = await captureNative();
    assert.deepEqual(report.nativeAfterDeleteShutdown, report.nativeAfterDelete);
    const storage = path.join(referenceRoot, 'recording-storage.json');
    await writeFile(storage, JSON.stringify(storageDocument(mediaRoot)));
    application = await startProductionInstance({ environment: { ...process.env, MEDIAMANAGER_INSTANCE: referenceRoot,
      MEDIAMANAGER_POSTGRES: process.env.MEDIAMANAGER_TEST_POSTGRES, MEDIAMANAGER_POSTGRES_SCHEMA: database.schemaName,
      MEDIAMANAGER_STORAGE: storage, MEDIAMANAGER_PORT: '0' },
    onError: error => report.runtimeErrors.push({ name: error.name, message: error.message, stack: error.stack }) });
    const closeStore = application.store.close.bind(application.store);
    application.store.close = async () => { report.nodeBeforeStoreClose = await captureNode(); return closeStore(); };
    const nodeOrigin = `http://127.0.0.1:${application.server.address().port}`; report.nodePort = application.server.address().port;
    assert.deepEqual(report.runtimeErrors, [], 'Production startup must not hide background failures.');
    report.nodeBeforeReads = await captureNode();
    assert.deepEqual(report.nodeBeforeReads, report.nativeBeforeReads, 'Production must start from the same complete migrated media graph, user data and source bytes.');
    report.nodeReads = await observe('node', nodeOrigin, readCases()); compare('reads', report.nodeReads, report.nativeReads);
    report.nodeAfterReads = await captureNode(); assert.deepEqual(report.nodeAfterReads, report.nodeBeforeReads);
    report.nodeDeletes = await observe('node', nodeOrigin, deletionCases(), 'DELETE'); compare('deletion', report.nodeDeletes, report.nativeDeletes);
    report.nodeAfterDelete = await captureNode();
    assert.deepEqual(report.nodeAfterDelete.media, report.nodeBeforeReads.media);
    assert.deepEqual(report.nodeAfterDelete.state, report.nodeBeforeReads.state);
    report.nativeDeletionChanges = delta(report.nativeBeforeDelete.database, report.nativeAfterDelete.database);
    report.nodeDeletionChanges = delta(report.nodeBeforeReads.database, report.nodeAfterDelete.database);
    assert.deepEqual(report.nodeDeletionChanges, report.nativeDeletionChanges, 'Native and Node delete the same item/relation/user-data rows while preserving all media bytes.');
    const deleted = report.nativeDeletes.find(value => value.name === 'management retains media despite disabled content deletion');
    assert.equal(deleted.response.status, 204);
    assert.equal(report.nativeDeletes.find(value => value.name === 'repeated delete').response.status, 404);
    assert.equal(report.nativeDeletionChanges.BaseItems.removed.length, 1);
    assert.ok(JSON.parse(report.nativeDeletionChanges.BaseItems.removed[0]).Id.replaceAll('-', '').toLowerCase() === idKey(graph.ids.delete));
    const list = report.nativeReads.find(value => value.name === 'authorization /LiveTv/Recordings' && value.mode === 'allowed').response.bodyJson;
    assert.ok(list.Items.some(item => item.Id === idKey(graph.ids.movie)) && list.Items.some(item => item.Id === idKey(graph.ids.episode)));
    assert.ok(!list.Items.some(item => [graph.ids.virtual, graph.ids.outside].some(id => item.Id === idKey(id))));
    const progress = report.nativeReads.find(value => value.name === 'list isInProgress=true&limit=1' && value.mode === 'allowed').response.bodyJson;
    assert.deepEqual(progress.Items.map(item => item.Id), [idKey(graph.ids.live)]);
    assert.equal(progress.TotalRecordCount, 1);
    await application.close(); application = undefined;
    assert.deepEqual(report.nodeBeforeStoreClose, report.nodeAfterDelete, 'Shutdown must preserve the final recorded database, permissions, preferences and source bytes.');
    assert.equal(await portAvailable(report.nodePort), true);
    report.cleanup.push({ name: 'production-runtime', closed: true, listenerReleased: true });
    assert.deepEqual(report.differences, []);
  } catch (error) { failure = error; report.failure = { name: error.name, message: error.message, stack: error.stack }; }
  finally {
    try { await stopNative('native-finally'); } catch (error) { failure ??= error; report.cleanup.push({ name: 'native', error: error.message }); }
    if (application) try { await application.close(); report.cleanup.push({ name: 'production-runtime-finally', closed: true }); }
    catch (error) { failure ??= error; report.cleanup.push({ name: 'production-runtime', error: error.message }); }
    try { await dropPostgresTestDatabase(database); report.cleanup.push({ name: 'postgres-schema', removed: true }); }
    catch (error) { failure ??= error; report.cleanup.push({ name: 'postgres-schema', error: error.message }); }
    if (current) try { await current.finish(); report.cleanup.push({ name: 'protected-inputs', unchanged: true }); }
    catch (error) { failure ??= error; report.inputVerificationFailure = error.message; }
    report.passed = !failure; report.phaseAcceptance = false; report.releaseAcceptance = false;
    report.boundary = 'Actual designated native HTTP, stopped native registration/SQLite seed, real database transfer and production PostgreSQL entry with mapped local media. No recording execution, tuner/listing execution, plugin channel provider, pixel delivery or complete Live TV release acceptance.';
    await writeFile(path.join(root, 'report.json'), filterEvidenceJson(report)); await output.publishAndClose();
  }
  if (failure) throw output.publicError(failure);
});
