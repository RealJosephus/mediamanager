import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { LyricService } from '../../src/lyrics/service.js';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { nativeGuid } from '../../src/users/native.js';
import { idKey, MIN_DATE } from '../../src/library/records.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { acquireTestResource } from '../helpers/test-resource-lease.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { projectProblemTrace } from '../helpers/http-body-projection.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';
import { lyricInput } from './fixtures/lyrics-current/input.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && postgresTestConnectionString;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const errorValue = value => value === null || !['object', 'function'].includes(typeof value) ? value
  : { name: value.name, message: value.message, code: value.code, status: value.status, statusCode: value.statusCode,
    stack: value.stack, ...(Object.hasOwn(value, 'cause') ? { cause: errorValue(value.cause) } : {}),
    ...(value instanceof AggregateError ? { errors: value.errors.map(errorValue) } : {}) };
function wire(response) {
  let json;
  try { json = parseLosslessJson(response.body); } catch { }
  json = projectProblemTrace(json, response.status);
  return { status: response.status, contentType: response.contentType?.trim() ?? null,
    ...(json === undefined ? { body: response.body } : { json }) };
}

async function lyricSource(files) {
  // recordOracle owns a synchronous child process. Its real HTTP input must
  // keep serving while this test's JavaScript event loop waits for that child.
  const worker = new Worker(new URL('./fixtures/lyrics-current/source-worker.js', import.meta.url), { workerData: files });
  const exited = new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', code => code === 0 ? resolve() : reject(new Error('Lyric source worker exited with code ' + code)));
  });
  void exited.catch(() => {});
  const stoppedEarly = () => exited.then(() => { throw new Error('Lyric source exited before returning its response.'); });
  try {
    const [ready] = await Promise.race([once(worker, 'message'), stoppedEarly()]);
    assert.equal(ready.type, 'ready');
  } catch (error) { await worker.terminate(); throw error; }
  const source = { requests: [], async close() {
    const closed = once(worker, 'message'); worker.postMessage('close');
    const [message] = await Promise.race([closed, stoppedEarly()]);
    assert.equal(message.type, 'closed'); source.requests = message.requests;
    await exited;
  } };
  return source;
}

test('Lyrics GET matches actual Native parsing/stream selection through Local and HTTP storage, PostgreSQL and cold HTTP consumers', {
  skip: !enabled, timeout: 600000,
}, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mediamanager-lyrics-'))), mediaRoot = path.join(root, 'lyrics');
  const output = path.join(validationOutputRoot(), 'lyrics-' + randomUUID()); await mkdir(output, { recursive: true });
  const report = { scope: { actualNativeMvcManagerParsersMediaStreamRepository: true, actualNodeRuntimeHttp: true,
    actualPostgres: true, actualLocalVfs: true, actualHttpStorage: true,
    controlled: ['Native authentication principal and library visibility lookup', 'Native virtual-path application roots', 'private original source files and proxy response headers'],
    excluded: ['full Native host authentication', 'lyric upload/delete/refresh', 'remote lyric providers', 'media execution', 'release acceptance'] },
    sourceRequests: [], cases: [], differences: [], diagnostics: [], faults: [], cleanup: [], releaseAcceptance: false };
  const secrets = new Set([postgresTestConnectionString]);
  let current, database, runtime, source, resource, failed = false, primary;
  const programDataPath = path.join(root, 'program'), configurationDirectoryPath = path.join(root, 'config'), storageConfiguration = path.join(root, 'storage.json'),
    serverId = randomUUID().replaceAll('-', '');
  const start = async () => {
    runtime = await createTestRuntime({ database, programDataPath, configurationDirectoryPath, storageConfiguration, serverId,
      configuration: { IsStartupWizardCompleted: true, UICulture: 'en-US', EnableCaseSensitiveItemIds: true },
      onError: (error, context) => report.diagnostics.push({ route: context?.request?.url, phase: context?.phase, error: errorValue(error) }) });
  };
  const closeRuntime = async () => {
    const owned = runtime; runtime = undefined; if (!owned) return;
    const listeners = owned.networkHost.listeners; await owned.close(); assert.ok(listeners.every(value => !value.server.listening));
  };
  try {
    current = await currentNativeReference();
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/LyricsController.cs', 'MediaBrowser.Providers/Lyric/LyricManager.cs',
      'MediaBrowser.Providers/Lyric/LrcLyricParser.cs', 'MediaBrowser.Providers/Lyric/TxtLyricParser.cs', 'Directory.Packages.props',
      'MediaBrowser.Controller/IO/LocalMediaProxy.cs', 'Jellyfin.Server.Implementations/Item/MediaStreamRepository.cs',
      'Emby.Server.Implementations/ApplicationHost.cs',
      'Emby.Server.Implementations/Library/MediaSourceManager.cs', 'MediaBrowser.Model/Lyrics/LyricLine.cs', 'MediaBrowser.Model/Lyrics/LyricLineCue.cs',
      'Jellyfin.Api/Auth/DefaultAuthorizationPolicy/DefaultAuthorizationHandler.cs', 'Jellyfin.Api/Middleware/ExceptionMiddleware.cs']);
    resource = await acquireTestResource('native-media-5244', { signal: t.signal });
    await mkdir(mediaRoot); const metadataPath = path.join(programDataPath, 'metadata'), input = lyricInput(mediaRoot, { metadataPath });
    for (const file of input.files) {
      await mkdir(path.dirname(file.filename), { recursive: true });
      await writeFile(file.filename, Buffer.from(file.base64, 'base64'), { flag: 'wx', mode: 0o600 });
    }
    report.originalSources = input.files.map(file => ({ name: file.name, filename: file.filename, identity: file.identity, sha256: hash(Buffer.from(file.base64, 'base64')),
      proxyContentType: file.contentType ?? 'text/plain', sourceStatus: file.sourceStatus ?? 200 }));
    source = await lyricSource(input.files);
    database = await createPostgresTestDatabase(null, 'lyrics_http'); await start();
    const definition = runtime.storage.configuration();
    definition.instances.push({ id: 'lyrics-local', type: 'local', config: { root: mediaRoot, writable: false } }, { id: 'lyrics-http', type: 'http', config: {} });
    await runtime.storage.configure(definition);
    await runtime.storage.bindPath({ identityRoot: mediaRoot, instanceId: 'lyrics-local', purpose: 'library', style: process.platform === 'win32' ? 'windows' : 'posix',
      caseSensitive: process.platform !== 'win32', capabilities: {}, returnAccess: 'Read the private original lyric files without changing their database identities.' });
    await runtime.storage.bindPath({ identityRoot: 'http://127.0.0.1:5244/lyrics', instanceId: 'lyrics-http', purpose: 'library', style: 'uri',
      caseSensitive: true, capabilities: {}, returnAccess: 'Retain the original HTTP lyric identity and response charset.' });
    const password = randomUUID(); secrets.add(password); const users = {}, tokens = {};
    for (const [identity, administrator] of [['admin', true], ['regular', false]]) {
      const created = await runtime.users.createUser({ Name: 'Lyrics ' + identity, Password: password });
      const user = await runtime.users.getUser(created.Id);
      await runtime.users.updatePolicy(user.Id, { ...user.Policy, IsAdministrator: administrator, EnableAllFolders: true,
        EnableLyricManagement: false, BlockedTags: administrator ? [] : ['lyrics-hidden'] });
      users[identity] = await runtime.users.getUser(user.Id);
      const login = await runtime.authentication.login({ Username: users[identity].Username, Pw: password }, {
        Client: 'Lyrics HTTP consumer', Device: 'Private', DeviceId: 'lyrics-' + identity, Version: '1',
      }, { remoteEndPoint: '127.0.0.1' });
      tokens[identity] = login.AccessToken; secrets.add(login.AccessToken);
    }
    tokens.apiKey = (await runtime.apiKeys.create('Lyrics HTTP consumer')).AccessToken; secrets.add(tokens.apiKey);
    const itemRows = input.items.map(item => postgresTestRow('BaseItems', { Id: nativeGuid(item.id),
      Type: item.type === 'Audio' ? 'MediaBrowser.Controller.Entities.Audio.Audio' : 'MediaBrowser.Controller.Entities.' + item.type,
      Name: item.name, CleanName: item.name, SortName: item.name, MediaType: item.type === 'Book' ? 'Book' : 'Audio', IsFolder: false,
      Path: path.join(mediaRoot, 'unused.mp3'), PresentationUniqueKey: item.id, DateCreated: MIN_DATE, DateModified: MIN_DATE,
      DateLastSaved: MIN_DATE, DateLastRefreshed: MIN_DATE, Tags: item.hidden ? 'lyrics-hidden' : null, Data: '{}' }));
    const streamRows = input.items.flatMap(item => item.streams.map(stream => postgresTestRow('MediaStreamInfos', {
      ItemId: nativeGuid(item.id), StreamIndex: stream.index, StreamType: stream.type, Path: stream.path,
      IsExternal: true, IsDefault: stream.isDefault ?? false, Language: stream.language ?? null,
    })));
    // Insert in reverse order so a successful public result depends on the
    // repository's StreamIndex ordering, rather than physical insertion order.
    for (const row of itemRows) await database.insert('BaseItems', row);
    for (const row of [...streamRows].reverse()) await database.insert('MediaStreamInfos', row);
    const tagId = nativeGuid(randomUUID()); await database.insert('ItemValues', { ItemValueId: tagId, Type: 4, Value: 'lyrics-hidden', CleanValue: 'lyrics-hidden' });
    for (const item of input.items.filter(item => item.hidden)) await database.insert('ItemValuesMap', { ItemId: nativeGuid(item.id), ItemValueId: tagId });
    Object.assign(input, { userId: idKey(users.admin.Id), readerId: idKey(users.regular.Id), mediaRoot, metadataPath, dataPath: path.join(programDataPath, 'data'),
      databaseRows: [{ name: 'BaseItems', rows: itemRows }, { name: 'MediaStreamInfos', rows: [...streamRows].reverse() }] });
    const inputFile = path.join(output, 'input.json'), inputBytes = Buffer.from(stringifyNativeJson(input)); await writeFile(inputFile, inputBytes);
    const receipt = await recordOracle({ project: 'tests/http/fixtures/lyrics-current/Oracle.csproj', output: path.join(output, 'native'),
      environment: current.environment, args: [inputFile, '{output}/native.json', path.join(output, 'native-data'), current.sourceDatabase] });
    report.oracle = receipt; assert.equal(receipt.passed, true);
    const native = parseLosslessJson(await readFile(path.join(output, 'native', 'native.json'), 'utf8')); report.native = native;
    assert.equal(native.inputSha256, hash(inputBytes)); assert.equal(native.before, native.after);
    for (const flag of ['actualMvc', 'actualController', 'actualManager', 'actualParsers', 'actualMediaStreamRepository', 'actualEfSqlite', 'hostStopped', 'hostDisposed']) assert.equal(native[flag], true);
    for (const assembly of native.assemblies) assert.equal(hash(await readFile(assembly.filename)), assembly.sha256);
    const readRows = () => database.rows('MediaStreamInfos', { whereIn: { ItemId: itemRows.map(row => row.Id) } });
    const before = stringifyNativeJson(await readRows());
    const request = async sample => {
      const origin = 'http://127.0.0.1:' + runtime.networkHost.listeners.find(value => value.scheme === 'http').port,
        identity = sample.identity ?? 'admin', token = identity === 'anonymous' ? null : identity === 'invalid' ? 'invalid-lyrics-token' : tokens[identity];
      const response = await fetch(origin + sample.path + (sample.suffix ?? ''), { method: sample.method ?? 'GET',
        headers: { Accept: sample.accept ?? 'application/json', ...(token ? { Authorization: `MediaBrowser Token="${token}"` } : {}) },
        signal: AbortSignal.any([t.signal, AbortSignal.timeout(30000)]) });
      return { name: sample.name, status: response.status, contentType: response.headers.get('content-type'), body: await response.text() };
    };
    const compare = async phase => {
      for (const [index, sample] of input.cases.entries()) {
        const expected = native.results[index]; assert.equal(expected.name, sample.name); assert.equal(expected.status, sample.status, sample.name);
        const actual = await request(sample); report.cases.push({ phase, sample, expected, actual });
        try { assert.deepEqual(wire(actual), wire(expected), phase + ': ' + sample.name); }
        catch (error) { report.differences.push({ phase, sample: sample.name, expected: wire(expected), actual: wire(actual), error: errorValue(error) }); }
      }
      assert.equal(stringifyNativeJson(await readRows()), before, 'GET does not change stored lyric streams.');
    };
    await compare('warm');
    const schema = database.schemaName; await closeRuntime();
    database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema }); await start();
    await compare('cold'); assert.deepEqual(report.differences, []);

    const baseline = wire(await request(input.cases[0]));
    for (const reason of [false, Object.assign(new Error('Consumer rejected the actual lyric bytes.'), { code: 'lyric-consumer', status: 409, statusCode: 409 })]) {
      const cleanup = new Error('Injected close failure after the real Local handle closed.');
      const vfs = { openRead: async (...args) => {
        const handle = await runtime.storage.vfs.openRead(...args);
        return { ...handle, stream: (async function* () {
          const iterator = handle.stream[Symbol.asyncIterator]();
          try { await iterator.next(); throw reason; } finally { await iterator.return?.(); }
        })(), close: async () => { await handle.close(); throw cleanup; } };
      } };
      const service = new LyricService({ store: runtime.store, library: runtime.library, vfs, identityMap: runtime.storage.identityMap });
      let rejected = false;
      try { await service.read(input.items[0].id, { user: users.admin }); }
      catch (error) {
        rejected = true; assert.ok(error instanceof AggregateError); assert.deepEqual(error.cause, reason); assert.deepEqual(error.errors, [reason, cleanup]);
        if (reason !== false) for (const key of ['code', 'status', 'statusCode']) assert.equal(error[key], reason[key]);
        report.faults.push({ scope: 'Node-only injected consumer/close failure over actual Local/VFS and PostgreSQL', error: errorValue(error) });
      }
      assert.equal(rejected, true); assert.deepEqual(wire(await request(input.cases[0])), baseline, 'The same HTTP consumer recovers after actual read/close cleanup.');
    }
    let inject = true, backend, sqlError;
    database.queryHook = async function (...args) {
      if (inject && args[0] === 'FETCH FORWARD 128 FROM lyric_stream_entries') {
        inject = false; backend = Number((await this.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        try { return await this.query('SELECT * FROM pg_catalog.mediamanager_missing_lyric_relation'); }
        catch (error) { sqlError = error; throw error; }
      }
      return this.query(...args);
    };
    const failedRead = await request(input.cases[0]); database.queryHook = undefined;
    assert.equal(failedRead.status, 500); assert.equal(sqlError.code, '42P01');
    const active = await database.client.query('SELECT pid FROM pg_catalog.pg_stat_activity WHERE pid=$1', [backend]); assert.deepEqual(active.rows, []);
    report.faults.push({ scope: 'Node-only actual PostgreSQL read failure and aborted-transaction CLOSE', error: errorValue(sqlError), backendGone: active.rows.length === 0 });
    assert.deepEqual(wire(await request(input.cases[0])), baseline);
    for (const file of input.files) assert.equal(hash(await readFile(file.filename)), hash(Buffer.from(file.base64, 'base64')));
    assert.equal(stringifyNativeJson(await readRows()), before);
  } catch (error) { failed = true; primary = error; report.failure = errorValue(error); }
  if (database) database.queryHook = undefined;
  const cleanupErrors = [];
  for (const [label, close] of [['runtime', closeRuntime], ['postgres', () => dropPostgresTestDatabase(database)],
    ['lyric-source', async () => { await source?.close(); report.sourceRequests = source?.requests ?? []; }],
    ['5244-lease', () => resource?.release()], ['reference', () => current?.finish()], ['private-files', async () => {
      assert.equal(path.dirname(root), await realpath(tmpdir())); assert.ok(path.basename(root).startsWith('mediamanager-lyrics-')); await rm(root, { recursive: true, force: true });
    }]]) {
    try { await close(); report.cleanup.push({ label, closed: true }); }
    catch (error) { cleanupErrors.push(error); report.cleanup.push({ label, error: errorValue(error) }); }
  }
  try { await writeFile(path.join(output, 'report.json'), filterEvidenceJson(report, secrets)); }
  catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) throw new AggregateError(failed ? [primary, ...cleanupErrors] : cleanupErrors, 'Lyric differential cleanup failed.', failed ? { cause: primary } : undefined);
  if (failed) throw primary;
});
