import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { nativeGuid } from '../../src/users/native.js';
import { MIN_DATE } from '../../src/library/records.js';
import { lyricProviderId } from '../../src/lyrics/providers.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';
import { lyricProviderInput } from './fixtures/lyrics-providers-current/input.js';
import { createLyricProviderPackage } from './fixtures/lyrics-providers-current/plugin.js';
import { lyricProviderSource } from './fixtures/lyrics-providers-current/source.js';
import { hash, inputAsset, inputSha256, bytesAt, responseValue } from './fixtures/lyrics-management/scenario.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && postgresTestConnectionString;
const wire = value => ({ ...responseValue(value), allow: value.allow ?? null });
const idKey = value => value.replaceAll('-', '').toLowerCase();

test('installed Node lyric providers match actual Native MVC/manager results and admitted downloads commit after client disconnect', {
  skip: !enabled, timeout: 600000,
}, async t => {
  const destination = path.join(validationOutputRoot(), 'lyrics-providers-' + randomUUID()), output = await createPrivateFilterOutput(destination);
  await mkdir(output.root); const root = output.root, input = lyricProviderInput(root), programDataPath = path.join(root, 'program'),
    storageConfiguration = path.join(root, 'storage.json'), serverId = 'fa6e1000000000000000000000000099',
    report = { scope: { actualNativeMvcManagerParsers: true, actualNodeRuntimeHttp: true, actualPostgresLocal: true, actualInstalledNodePlugin: true,
      controlled: ['Native principals/library item/options lookup and metadata queue boundary', 'synthetic original provider results'],
      excluded: ['Native plugin installation', 'Native refresh execution in this oracle', 'full instance/release acceptance'] },
    cases: [], requests: [], publications: [], lifecycle: [], cleanup: [], differences: [], releaseAcceptance: false };
  const secrets = new Set([postgresTestConnectionString]); output.addSecret(postgresTestConnectionString);
  let current, database, runtime, runtimeClosing, source, failed = false, primary;
  const tokens = {}, users = {};
  const paths = () => ['track.lrc', 'track.txt'].map(name => path.join(input.metadataPath, 'library', input.itemId.slice(0, 2), input.itemId, name));
  const snapshots = async () => Promise.all(paths().map(async filename => {
    const value = await bytesAt(filename);
    return { name: path.basename(filename), exists: value.exists, sha256: value.sha256 ?? null, base64: value.base64 ?? null };
  }));
  const start = async () => {
    runtime = await createTestRuntime({ database, serverId, programDataPath, storageConfiguration, configurationDirectoryPath: path.join(root, 'node-config'),
      configuration: { IsStartupWizardCompleted: true, UICulture: 'en-US' },
      mediaEncoderOptions: { startupFFmpegPath: current.ffmpeg },
      pluginOptions: { options: { 'lyric-provider-fixture': { providers: input.providers, sourceUrl: source.url } } },
      onError: (error, context) => report.lifecycle.push({ diagnosticOnly: true, route: context?.request?.url, message: error?.message, code: error?.code }) });
  };
  const closeRuntime = async () => {
    const owner = runtime; runtime = undefined; if (!owner) return runtimeClosing;
    const listeners = owner.networkHost.listeners;
    runtimeClosing = owner.close().then(() => assert.ok(listeners.every(value => !value.server.listening)));
    return runtimeClosing;
  };
  const request = async (sample, signal = t.signal) => {
    const identity = sample.identity ?? 'admin', token = identity === 'anonymous' ? null : tokens[identity],
      origin = 'http://127.0.0.1:' + runtime.networkHost.listeners.find(value => value.scheme === 'http').port;
    const response = await fetch(origin + sample.path, { method: sample.method ?? 'GET',
      headers: { Accept: 'application/json', ...(token ? { Authorization: 'MediaBrowser Token="' + token + '"' } : {}) },
      signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]) });
    return { name: sample.name, status: response.status, contentType: response.headers.get('content-type'),
      allow: response.headers.get('allow'), body: await response.text() };
  };
  const published = async (filename, selectedFilename = filename) => {
    const deadline = Date.now() + 90000;
    for (;;) {
      const streams = await database.rows('MediaStreamInfos', { where: { ItemId: nativeGuid(input.itemId) } });
      const item = await database.rows('BaseItems', { where: { Id: nativeGuid(input.itemId) } }), data = parseLosslessJson(item[0].Data),
        ready = data.HasLyrics === true && data.LyricFiles?.includes(filename)
          && streams.some(stream => stream.StreamType === 5 && (runtime.library.options.expandPath?.(stream.Path) ?? stream.Path) === selectedFilename);
      if (ready || Date.now() >= deadline) report.publications.push({ filename, selectedFilename, ready, streams, item, files: await snapshots(),
        metadataPath: runtime.library.options.metadataPath });
      if (ready) return streams;
      assert.ok(Date.now() < deadline, 'The actual queued metadata refresh must publish the downloaded file.');
      await delay(50, undefined, { signal: t.signal });
    }
  };
  try {
    current = await currentNativeReference();
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/LyricsController.cs', 'MediaBrowser.Providers/Lyric/LyricManager.cs',
      'MediaBrowser.Providers/MediaInfo/AudioFileProber.cs', 'Jellyfin.Server.Implementations/Item/MediaStreamRepository.cs',
      'MediaBrowser.Controller/Lyrics/ILyricProvider.cs', 'MediaBrowser.Model/Lyrics/LyricMetadata.cs', 'MediaBrowser.Model/Lyrics/LyricResponse.cs',
      'Jellyfin.Api/Auth/UserPermissionPolicy/UserPermissionHandler.cs', 'Jellyfin.Api/Auth/DefaultAuthorizationPolicy/DefaultAuthorizationHandler.cs']);
    await mkdir(path.dirname(input.mediaPath), { recursive: true }); await copyFile(inputAsset, input.mediaPath);
    assert.equal(hash(await readFile(input.mediaPath)), inputSha256);
    await writeFile(storageConfiguration, JSON.stringify({ instances: [{ id: 'private', type: 'local', config: { root, writable: true } }],
      mounts: [{ path: '/lyrics', instanceId: 'private', capabilities: { create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } }],
      prefixes: [{ identityRoot: root, accessRoot: '/lyrics', style: process.platform === 'win32' ? 'windows' : 'posix',
        caseSensitive: process.platform !== 'win32', returnAccess: 'Actual isolated original audio, provider bytes and runtime state.' }] }));
    const disconnected = input.providers[1].entries.find(entry => entry.id === 'download-disconnect');
    source = await lyricProviderSource(Buffer.from(disconnected.bytes, 'base64'));
    database = await createPostgresTestDatabase(null, 'lyric_providers'); await start();
    const password = randomUUID(); secrets.add(password); output.addSecret(password);
    for (const [identity, administrator, management] of [['admin', true, true], ['manager', false, true], ['denied', false, false]]) {
      const user = await runtime.users.createUser({ Name: 'Lyric provider ' + identity, Password: password });
      const original = await runtime.users.getUser(user.Id);
      await runtime.users.updatePolicy(user.Id, { ...original.Policy, IsAdministrator: administrator, EnableAllFolders: true, EnableLyricManagement: management });
      users[identity] = await runtime.users.getUser(user.Id);
      const login = await runtime.authentication.login({ Username: users[identity].Username, Pw: password },
        { Client: 'Lyric provider test', Device: 'Private', DeviceId: 'lyric-provider-' + identity, Version: '1' }, { remoteEndPoint: '127.0.0.1' });
      tokens[identity] = login.AccessToken; secrets.add(login.AccessToken); output.addSecret(login.AccessToken);
    }
    tokens.apiKey = (await runtime.apiKeys.create('Lyric provider test')).AccessToken; secrets.add(tokens.apiKey); output.addSecret(tokens.apiKey);
    input.userId = idKey(users.admin.Id); input.managerId = idKey(users.manager.Id); input.deniedId = idKey(users.denied.Id);
    const rows = [
      postgresTestRow('BaseItems', { Id: nativeGuid(input.itemId), Type: 'MediaBrowser.Controller.Entities.Audio.Audio',
        Name: input.songName, CleanName: input.songName, SortName: input.songName, Album: input.albumName,
        AlbumArtists: input.albumArtistsNames.join('|'), Artists: input.artistNames.join('|'), MediaType: 'Audio', IsFolder: false,
        RunTimeTicks: BigInt(input.duration), Path: input.mediaPath, PresentationUniqueKey: input.itemId, Data: '{}',
        DateCreated: MIN_DATE, DateModified: MIN_DATE, DateLastSaved: MIN_DATE, DateLastRefreshed: MIN_DATE }),
      postgresTestRow('BaseItems', { Id: nativeGuid(input.bookId), Type: 'MediaBrowser.Controller.Entities.Book', MediaType: 'Book',
        Name: 'Not audio', Path: path.join(root, 'audio', 'book.txt'), Data: '{}', DateCreated: MIN_DATE, DateModified: MIN_DATE }),
    ];
    for (const row of rows) await database.insert('BaseItems', row);
    const beforeReads = await database.rows('BaseItems', { whereIn: { Id: rows.map(row => row.Id) } });
    const packageSource = await createLyricProviderPackage(root);
    const preparedSchema = database.schemaName; await closeRuntime();
    const inputFile = path.join(root, 'input.json'), inputBytes = Buffer.from(JSON.stringify(input));
    await writeFile(inputFile, inputBytes, { flag: 'wx' });
    report.oracle = await recordOracle({ project: 'tests/http/fixtures/lyrics-providers-current/Oracle.csproj',
      output: path.join(root, 'native'), environment: current.environment,
      args: [inputFile, '{output}/native.json', path.join(root, 'native-program')] });
    assert.equal(report.oracle.passed, true);
    const native = parseLosslessJson(await readFile(path.join(root, 'native', 'native.json'), 'utf8')); report.native = native;
    assert.equal(native.inputSha256, hash(inputBytes)); assert.equal(native.originalAudioSha256, inputSha256);
    for (const assembly of native.assemblies) assert.equal(hash(await readFile(assembly.filename)), assembly.sha256);
    // The actual Native writes are retained in native.json; Node starts from
    // the same clean sidecar state without changing the original audio.
    for (const filename of paths()) await rm(filename, { force: true });
    database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema: preparedSchema }); await start();
    assert.equal((await runtime.plugins.install(packageSource)).status, 'active');
    for (const [index, sample] of input.cases.entries()) {
      const expected = native.results[index]; assert.equal(expected.name, sample.name);
      if (sample.disconnect) {
        const controller = new AbortController(), gate = source.gate('download-disconnect');
        const sending = request(sample, AbortSignal.any([controller.signal, t.signal]));
        const settled = sending.then(value => ({ value }), error => ({ aborted: true, message: error?.message }));
        await Promise.race([gate.entered.promise, settled.then(() => { throw new Error('The download ended before its real upstream request.'); })]);
        controller.abort(); const client = await settled;
        assert.equal(client.aborted, true);
        gate.released.resolve();
        // Native keeps every discovered LyricFiles path but publishes only
        // the first external lyric stream; the earlier LRC remains selected.
        const streams = await published(paths()[1], paths()[0]); await runtime.metadata.drain();
        const files = await snapshots(); assert.deepEqual(files, expected.files);
        report.cases.push({ sample, expected, client, files, streams });
      } else {
        const actual = await request(sample);
        const files = await snapshots(); report.cases.push({ sample, expected, actual, files });
        try { assert.deepEqual(wire(actual), wire(expected)); assert.deepEqual(files, expected.files); }
        catch (error) { report.differences.push({ sample: sample.name, message: error.message }); }
        if (sample.method === 'POST' && actual.status === 200) await published(paths()[0]);
        if (sample.name === 'API key provider search') assert.deepEqual(await database.rows('BaseItems',
          { whereIn: { Id: rows.map(row => row.Id) } }), beforeReads);
      }
    }
    const requestsFile = path.join(runtime.plugins.directory, 'data', 'lyric-provider-fixture', 'requests.jsonl'),
      observed = (await readFile(requestsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
      ordered = values => values.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    report.requests = observed; assert.deepEqual(ordered(observed), ordered(native.requests));
    assert.deepEqual(report.differences, []);
    assert.equal(hash(await readFile(input.mediaPath)), inputSha256);

    // Plugin disable must cancel and drain an actual upstream body. This is a
    // Node SDK lifecycle case, separate from the paired Native HTTP consumer.
    const held = source.gate('lifecycle-held'), pending = request({ name: 'plugin lifecycle held read',
      path: '/Providers/Lyrics/' + lyricProviderId(input.providers[1].name) + '_lifecycle-held' });
    const delivered = pending.then(value => value, error => ({ aborted: true, message: error?.message }));
    await Promise.race([held.entered.promise, delivered.then(() => { throw new Error('The provider read ended before its real upstream request.'); })]);
    await runtime.plugins.setEnabled('lyric-provider-fixture', false);
    const upstream = await held.closed.promise, cancelled = await delivered;
    assert.equal(upstream.completed, false); assert.equal(runtime.plugins.get('lyric-provider-fixture').status, 'disabled');
    assert.equal(cancelled.status, 500);
    assert.equal((await request({ name: 'disabled provider no longer serves', path: input.cases[8].path })).status, 404);
    assert.deepEqual(await snapshots(), native.results.at(-1).files);
    report.lifecycle.push({ action: 'disable', upstream, response: cancelled, files: await snapshots() });
    await runtime.plugins.setEnabled('lyric-provider-fixture', true);
    assert.equal((await request({ name: 'provider reenabled recovers', path: input.cases[8].path })).status, 200);
    const schema = database.schemaName; await closeRuntime();
    database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema }); await start();
    assert.equal((await request({ name: 'cold installed provider read', path: input.cases[8].path })).status, 200);
    const local = await request({ name: 'cold actual metadata lyrics', path: '/Audio/' + input.itemId + '/Lyrics' });
    assert.equal(local.status, 200); assert.equal(parseLosslessJson(local.body).Lyrics[0].Text, 'Downloaded original');
    assert.equal(hash(await readFile(input.mediaPath)), inputSha256);

    // Application shutdown owns this signal; a disconnected client above did
    // not cancel the admitted download. A pending provider body must release
    // before the runtime can finish draining its actual HTTP requests.
    for (const method of ['GET', 'POST']) {
      const schema = database.schemaName; await closeRuntime(); await source.close();
      source = await lyricProviderSource(Buffer.from(disconnected.bytes, 'base64'));
      database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema }); await start();
      const before = await snapshots(), gate = source.gate('lifecycle-held'),
        pending = request({ name: 'runtime shutdown held ' + method, method, path: method === 'GET'
          ? '/Providers/Lyrics/' + lyricProviderId(input.providers[1].name) + '_lifecycle-held'
          : '/Audio/' + input.itemId + '/RemoteSearch/Lyrics/' + lyricProviderId(input.providers[1].name) + '_lifecycle-held' }),
        delivered = pending.then(response => response, error => ({ aborted: true, message: error?.message }));
      await Promise.race([gate.entered.promise, delivered.then(() => { throw new Error('The shutdown consumer ended before its actual upstream request.'); })]);
      const closing = closeRuntime(), deadline = new AbortController();
      try {
        const [, upstream, response] = await Promise.race([Promise.all([closing, gate.closed.promise, delivered]),
          delay(90000, undefined, { signal: AbortSignal.any([t.signal, deadline.signal]) })
            .then(() => { throw new Error('Runtime shutdown must cancel the upstream before waiting for the admitted lyric HTTP request.'); })]);
        assert.equal(upstream.completed, false); assert.equal(response.status, 500);
        assert.deepEqual(await snapshots(), before, 'A provider response cancelled before delivery must not replace any saved lyric bytes.');
        await assert.rejects(() => database.rows('BaseItems'));
        report.lifecycle.push({ action: 'runtime close held ' + method, upstream, response, files: await snapshots() });
      } finally { deadline.abort(); gate.released.resolve(); }
    }
    database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema: database.schemaName }); await start();
    assert.equal((await request({ name: 'cold provider recovers after runtime cancellation', path: input.cases[8].path })).status, 200);
    const afterShutdown = await request({ name: 'cold committed lyrics survive cancelled provider requests', path: '/Audio/' + input.itemId + '/Lyrics' });
    assert.deepEqual(wire(afterShutdown), wire(local));
    assert.equal(hash(await readFile(input.mediaPath)), inputSha256);
    report.passed = true;
  } catch (error) { failed = true; primary = error; report.failure = { name: error?.name, message: error?.message, stack: error?.stack }; }
  const cleanupErrors = [];
  for (const [label, close] of [['runtime', closeRuntime], ['postgres', () => dropPostgresTestDatabase(database)],
    ['source', () => source?.close()], ['reference', () => current?.finish()]]) {
    try { await close(); report.cleanup.push({ label, closed: true }); }
    catch (error) { cleanupErrors.push(error); report.cleanup.push({ label, closed: false, message: error?.message }); }
  }
  await writeFile(path.join(root, 'report.json'), filterEvidenceJson(report, secrets));
  if (!runtime) await output.publishAndClose();
  const errors = [...(failed ? [primary] : []), ...cleanupErrors];
  if (errors.length === 1) throw output.publicError(errors[0]);
  if (errors.length > 1) throw output.publicError(new AggregateError(errors, 'Lyric provider validation and cleanup failed.', { cause: errors[0] }));
});
