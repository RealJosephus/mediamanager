import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, statfs, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { readConfigurationFile } from '../../src/core/configuration-file.js';
import { getNewItemId } from '../../src/core/identity.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { dateText, idKey } from '../../src/library/records.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { nativeGuid } from '../../src/users/native.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { projectProblemTrace } from '../helpers/http-body-projection.js';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import { createTestRuntime } from '../helpers/runtime.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES);
const nativeCase = declareNativeHttpTestFile({ enabled });
const fixtureTime = new Date('2025-11-07T15:23:17Z');
const selectedLogs = { 'contract-older.LOG': 'older\n', 'contract-newest.txt': 'newest – 測試\n', 'contract-raw.dat': 'unlisted\n' };
const auth = token => `MediaBrowser Client="System information fixture", Device="Isolated", DeviceId="isolated-system-info", Version="1"${token ? `, Token="${token}"` : ''}`;
const available = port => new Promise(resolve => {
  const probe = createServer();
  probe.once('error', () => resolve(false)).listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
});

async function request(origin, { route, method = 'GET', token, headers, body }) {
  const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(15000),
    headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', Authorization: auth(token), Connection: 'close',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }) });
  const text = await response.text(), contentType = response.headers.get('content-type');
  return { status: response.status, contentType, text,
    length: response.headers.get('content-length'), range: response.headers.get('content-range'),
    ...(text && contentType?.includes('json') ? { json: JSON.parse(text) } : {}) };
}

async function checkEncodedConfiguration(origin, token, directory) {
  const route = '/Startup/Configuration';
  const initial = await request(origin, { route, token });
  assert.equal(initial.status, 200);
  const rows = [];
  try {
    let expectedName = initial.json.ServerName;
    for (const [charset, encoding, name, expectedStatus] of [
      ['utf-8', 'utf8', '配置 中文 A', 204],
      ['utf-16', 'utf16le', '配置 中文 B', 204],
      ['"UTF-16"', 'utf16le', '配置 中文 C', 204],
      ['iso-8859-1', 'latin1', 'Unsupported charset', 415],
    ]) {
      const body = Buffer.from(JSON.stringify({ ...initial.json, ServerName: name }), encoding);
      const update = await request(origin, { route, token, method: 'POST', headers: { 'Content-Type': 'application/json; charset=' + charset }, body });
      assert.equal(update.status, expectedStatus, charset);
      if (expectedStatus === 204) expectedName = name;
      const get = await request(origin, { route, token });
      const saved = await readConfigurationFile(path.join(directory, 'system.xml'), 'server');
      assert.equal(get.status, 200);
      assert.equal(get.json.ServerName, expectedName);
      assert.equal(saved.ServerName, expectedName);
      rows.push({ charset, status: update.status, readback: get.json.ServerName, persisted: saved.ServerName });
    }
    return rows;
  } finally { assert.equal((await request(origin, { route, token, method: 'POST', body: initial.json })).status, 204); }
}

async function seedLibrary(settings) {
  const { programDataPath, dataPath, configuration } = settings;
  const nativeType = type => 'MediaBrowser.Controller.Entities.' + type;
  const identity = (filename, type) => nativeGuid(getNewItemId(filename, nativeType(type), {
    programDataPath, enableCaseSensitiveItemIds: configuration.EnableCaseSensitiveItemIds,
  }));
  const Name = 'Storage contract library';
  const root = path.join(programDataPath, 'root', 'default');
  const virtual = path.join(root, Name), physical = path.join(programDataPath, 'system-capacity-library');
  await mkdir(virtual, { recursive: true });
  await mkdir(physical);
  await writeFile(path.join(virtual, 'movies.collection'), '');
  await writeFile(path.join(virtual, 'media.mblink'), physical);
  await writeFile(path.join(virtual, 'options.xml'), '<LibraryOptions><EnableRealtimeMonitor>false</EnableRealtimeMonitor></LibraryOptions>');
  const databasePath = path.join(dataPath, 'jellyfin.db');
  const sqlite = new SqliteDatabase(databasePath, { requireMigrationHistory: true });
  const Id = identity(virtual, 'CollectionFolder'), physicalId = identity(physical, 'Folder');
  try {
    sqlite.transaction(() => {
      const addFolder = (type, row) => sqlite.insert('BaseItems', postgresTestRow('BaseItems', {
        Type: nativeType(type), IsFolder: true, MediaType: 'Unknown', Data: '{}', ...row,
      }));
      const aggregate = sqlite.rows('BaseItems', { where: { Type: nativeType('AggregateFolder') } })[0];
      const userRoot = sqlite.rows('BaseItems', { where: { Type: nativeType('UserRootFolder') } })[0];
      const rootId = userRoot?.Id ?? identity(root, 'UserRootFolder');
      if (!userRoot) addFolder('UserRootFolder', { Id: rootId, Name: 'default', Path: root, Data: '{"IsRoot":true}' });
      addFolder('Folder', { Id: physicalId, Name, Path: physical, ParentId: aggregate.Id, TopParentId: physicalId });
      addFolder('CollectionFolder', { Id, Name, Path: virtual, ParentId: rootId,
        Data: JSON.stringify({ CollectionType: 'movies', PhysicalFolderIds: [physicalId], PhysicalLocationsList: [physical] }) });
    });
  } finally { sqlite.close(); }
  return { Id: idKey(Id), Name, physical, databasePath };
}

test('system storage and the log browser use the authoritative application and library paths', {
  skip: !enabled, timeout: 300000,
}, nativeCase(async (t, port) => {
  const output = await createPrivateFilterOutput(path.join(validationOutputRoot(), 'system-information-' + randomUUID()));
  await mkdir(output.root);
  const root = path.join(output.root, 'reference');
  const nativeOrigin = `http://127.0.0.1:${port}`;
  const report = { cases: [], cleanup: [], differences: [] };
  let current, native, database, runtime, stopped = false, failure;
  const stopNative = async () => {
    if (!native || stopped) return;
    stopped = true;
    report.nativeCleanup = await native.stop(async () => (await request(nativeOrigin,
      { route: '/System/Shutdown', method: 'POST', token: current.accessToken })).status, () => available(port));
    assert.ok(report.nativeCleanup.cleanShutdown && report.nativeCleanup.pidGone && report.nativeCleanup.portAvailable);
  };
  try {
    current = await currentNativeReference();
    output.addSecret(current.accessToken);
    output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
    report.reference = current.preparation;
    report.sources = await current.sourceBindings(['Jellyfin.Api/Controllers/SystemController.cs',
      'Emby.Server.Implementations/SystemManager.cs', 'Emby.Server.Implementations/IO/ManagedFileSystem.cs',
      'Jellyfin.Server.Implementations/StorageHelpers/StorageHelper.cs', 'Jellyfin.Api/Models/SystemInfoDtos/SystemStorageDto.cs']);
    await cp(current.sourceRoot, root, { recursive: true });
    await current.prepareClone(root, port);
    const settings = await readInstanceConfiguration(root);
    const { programDataPath, logDirectoryPath, metadataPath } = settings;
    const cachePath = settings.configuration.CachePath?.trim() || path.join(root, 'cache');
    const fixture = await seedLibrary(settings);
    await mkdir(path.join(cachePath, 'images'), { recursive: true });
    await mkdir(path.join(logDirectoryPath, 'contract-subfolder.log'), { recursive: true });
    await writeFile(path.join(logDirectoryPath, 'contract-subfolder.log', 'contract-nested.log'), 'nested');
    for (const [offset, [name, contents]] of Object.entries(selectedLogs).entries()) {
      const filename = path.join(logDirectoryPath, name), timestamp = new Date(fixtureTime.valueOf() + offset * 1000);
      await writeFile(filename, contents);
      await utimes(filename, timestamp, timestamp);
    }
    native = current.start({ referenceRoot: root, outputRoot: output.root, label: 'native', origin: nativeOrigin });
    await native.ready();
    const username = 'Logs Reader ' + randomUUID().slice(0, 8), password = randomUUID();
    output.addSecret(password);
    const created = await request(nativeOrigin, { route: '/Users/New', method: 'POST',
      token: current.accessToken, body: { Name: username, Password: password } });
    assert.equal(created.status, 200);
    const login = await request(nativeOrigin, { route: '/Users/AuthenticateByName', method: 'POST', body: { Username: username, Pw: password } });
    assert.equal(login.status, 200);
    const reader = login.json.AccessToken;
    output.addSecret(reader);
    const key = (name, route, status = 200, options = {}) => ({ name, route, status, ...options });
    const logRoute = name => '/System/Logs/Log?name=' + encodeURIComponent(name);
    const samples = [
      key('mixed-case JSON ping', '/System/Ping', 200, { identity: 'anonymous', headers: { Accept: 'Application/JSON' } }),
      key('storage', '/System/Info/Storage'),
      key('list', '/System/Logs'),
      key('read by ordinal case-insensitive name', logRoute('CONTRACT-NEWEST.TXT')),
      key('read arbitrary enumerated file', logRoute('contract-raw.dat')),
      key('range is ignored', logRoute('contract-older.LOG'), 200, { headers: { Range: 'bytes=1-2' } }),
      key('missing log name', logRoute('missing.log'), 404),
      key('nested file is outside the listed entries', logRoute('contract-subfolder.log/contract-nested.log'), 404),
      key('required log name', '/System/Logs/Log', 400),
      ...['/System/Info/Storage', '/System/Logs', logRoute('contract-newest.txt')].flatMap(route => [
        key('anonymous ' + route, route, 401, { identity: 'anonymous' }), key('ordinary user ' + route, route, 403, { identity: 'reader' }),
      ]),
    ];
    const observe = (origin, sample) => request(origin, { ...sample,
      token: sample.identity === 'anonymous' ? undefined : sample.identity === 'reader' ? reader : current.accessToken });
    report.charset = { native: await checkEncodedConfiguration(nativeOrigin, current.accessToken, settings.configurationDirectoryPath) };
    for (const sample of samples) report.cases.push({ sample, native: await observe(nativeOrigin, sample) });
    await stopNative();
    const sqlite = new SqliteDatabase(fixture.databasePath, { readOnly: true, requireMigrationHistory: true });
    try {
      database = await createPostgresTestDatabase(null, 'system_information');
      await transferDatabase(sqlite, database, { instanceBinding: { serverId: settings.serverId,
        originIdentityDigest: createHash('sha256').update(await readFile(fixture.databasePath)).digest('hex') } });
    } finally { sqlite.close(); }
    runtime = await createTestRuntime({ ...settings, cachePath, database });
    const nodeOrigin = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port}`;
    report.charset.node = await checkEncodedConfiguration(nodeOrigin, current.accessToken, settings.configurationDirectoryPath);
    assert.deepEqual(report.charset.node, report.charset.native);
    const shape = ({ status, contentType, json, text, length, range }) => ({
      status, contentType, body: json === undefined ? text : projectProblemTrace(json, status),
      ...(status === 200 && contentType?.startsWith('text/plain') ? { length, range } : {}),
    });
    const logs = response => response.json.filter(log => Object.hasOwn(selectedLogs, log.Name))
      .map(log => ({ ...log, DateCreated: dateText(log.DateCreated), DateModified: dateText(log.DateModified) }));
    const checkCapacity = async (folder, filename) => {
      assert.equal(folder.Path, filename);
      assert.equal(typeof folder.StorageType, 'string');
      assert.equal(typeof folder.DeviceId, 'string');
      const info = await statfs(filename, { bigint: true });
      assert.ok(folder.FreeSpace >= 0 && folder.UsedSpace >= 0);
      assert.equal(BigInt(folder.FreeSpace) + BigInt(folder.UsedSpace), info.blocks * info.bsize);
    };
    for (const entry of report.cases) {
      entry.node = await observe(nodeOrigin, entry.sample);
      try {
        assert.equal(entry.native.status, entry.sample.status); assert.equal(entry.node.status, entry.sample.status);
        if (entry.sample.name === 'storage') {
          assert.equal(entry.node.contentType, entry.native.contentType);
          for (const response of [entry.native, entry.node]) {
            const library = response.json.Libraries.find(item => item.Name === fixture.Name);
            assert.equal(library.Id, fixture.Id);
            assert.equal(library.Folders.length, 1);
            await checkCapacity(library.Folders[0], fixture.physical);
            for (const [field, filename] of Object.entries({ ProgramDataFolder: programDataPath,
              CacheFolder: cachePath, LogFolder: logDirectoryPath, InternalMetadataFolder: metadataPath,
              ImageCacheFolder: path.join(cachePath, 'images'), TranscodingTempFolder: path.join(cachePath, 'transcodes') })) {
              await checkCapacity(response.json[field], filename);
            }
          }
          assert.deepEqual(entry.node.json.WebFolder, { Path: '', FreeSpace: -1, UsedSpace: -1 });
        } else if (entry.sample.name === 'list') {
          assert.equal(entry.node.contentType, entry.native.contentType);
          assert.deepEqual(logs(entry.node), logs(entry.native));
          assert.deepEqual(logs(entry.node).map(log => log.Name), ['contract-newest.txt', 'contract-older.LOG']);
          assert.equal(entry.node.json.some(log => /contract-(raw|nested|subfolder)/u.test(log.Name)), false);
        } else if (entry.sample.name === 'mixed-case JSON ping') {
          assert.equal(entry.node.contentType, entry.native.contentType);
          assert.equal(entry.native.text, '"Jellyfin Server"');
          assert.equal(entry.node.text, '"MediaManager"');
        } else {
          assert.deepEqual(shape(entry.node), shape(entry.native));
          if (entry.sample.name === 'read by ordinal case-insensitive name') assert.equal(entry.node.text, selectedLogs['contract-newest.txt']);
        }
      } catch (error) { report.differences.push({ name: entry.sample.name, message: error.message }); }
    }
    assert.deepEqual(report.differences, []);
    t.diagnostic('Compared the designated native log HTTP and isolated filesystem capacity using the shared on-disk bytes.');
  } catch (error) { failure = output.publicError(error); throw failure; }
  finally {
    const errors = [];
    for (const [name, close] of [['Native process', stopNative], ['Node runtime', () => runtime?.close()],
      ['PostgreSQL schema', () => dropPostgresTestDatabase(database)], ['reference input', () => current?.finish()]]) {
      try { await close(); report.cleanup.push({ name, closed: true }); }
      catch (error) { errors.push(output.publicError(error)); report.cleanup.push({ name, closed: false }); }
    }
    try {
      await writeFile(path.join(output.root, 'observations.json'), filterEvidenceJson(report));
      await output.publishAndClose();
    } catch (error) { errors.push(output.publicError(error)); }
    if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors, 'System information fixture cleanup failed.', { cause: failure });
  }
}));
