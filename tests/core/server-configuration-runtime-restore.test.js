import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { createRuntime } from '../../src/runtime.js';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { serializeConfiguration } from '../../src/core/configuration-file.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { nativeGuid } from '../../src/users/native.js';
import { configurationJson } from './fixtures/configuration/observations.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['postgres'];
const enabled = { skip: !postgresTestConnectionString, timeout: 180000 };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bytesValue = bytes => ({ bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString('base64') });
const missing = error => error.code === 'ENOENT' || error.code === 'ENOTDIR';

function errorValue(input, diagnostic = false, seen = new WeakSet()) {
  if (input === null || typeof input !== 'object') return input;
  if (seen.has(input)) return '[Circular]';
  seen.add(input);
  try {
    if (Array.isArray(input)) return input.map(value => errorValue(value, diagnostic, seen));
    const names = input instanceof Error ? Object.getOwnPropertyNames(input) : Object.keys(input);
    const value = Object.fromEntries(names.filter(name => diagnostic || !['name', 'stack'].includes(name))
      .map(name => [name, errorValue(input[name], diagnostic, seen)]));
    if (diagnostic && input instanceof Error) value.name = input.name;
    return value;
  } finally { seen.delete(input); }
}

async function scenario(label, run) {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'configuration-runtime-restore-' + label + '-'));
  assertValidationOutputChild(root);
  const context = new AsyncLocalStorage(), diagnostics = [], boundaries = [], requests = [], stages = [], closures = [], effects = [];
  const pendingRequests = new Set(), protectedFiles = new Map();
  const state = { root, programDataPath: path.join(root, 'data'), generation: 0, phase: 'prepare', runtime: undefined, database: undefined };
  const report = { schemaVersion: 1, scope: label, actualPostgres: true, requests, boundaries, diagnostics, stages, closures, effects,
    fileReads: [], originals: [],
    phaseAcceptance: false, releaseAcceptance: false };
  let failure;
  const cleanupErrors = [];
  const onError = error => {
    const owner = context.getStore() ?? {}, request = requests[owner.requestId], boundary = boundaries[owner.boundaryId];
    diagnostics.push({ generation: state.generation, phase: state.phase, owner: { ...owner },
      requestOpen: request?.open === true, boundaryOpen: boundary?.open === true,
      failure: errorValue(error), diagnostic: errorValue(error, true) });
  };
  state.open = async () => {
    state.generation++; state.phase = 'opening';
    if (!state.database) state.database = await createPostgresTestDatabase(null, 'config_restore');
    else state.database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema: state.database.schemaName });
    const inherited = context.getStore();
    await context.run({ ...inherited, kind: 'open', generation: state.generation }, async () => {
      const settings = await readInstanceConfiguration(root, { onError });
      state.runtime = await createRuntime({ ...settings, database: state.database, onError });
      await state.runtime.start();
      for (const { server } of state.runtime.networkHost.listeners) server.prependListener('request', incoming => {
        const matching = [...pendingRequests].filter(request => request.generation === state.generation
          && request.method === incoming.method && request.route === incoming.url);
        const request = matching.length === 1 ? matching[0] : null;
        context.enterWith(request ? { kind: 'http', generation: request.generation, requestId: request.index,
          boundaryId: request.boundaryId } : { kind: 'unclassified-http', generation: state.generation });
      });
    });
    state.phase = 'running';
  };
  state.close = async () => {
    const runtime = state.runtime; if (!runtime) return;
    state.phase = 'closing'; const observation = { generation: state.generation, completed: false }; closures.push(observation);
    try {
      await context.run({ kind: 'close', generation: state.generation }, () => runtime.close());
      observation.completed = true;
    } catch (error) { observation.error = errorValue(error, true); throw error; }
    finally { state.runtime = undefined; state.phase = 'closed'; }
  };
  state.call = async (route, { method = 'GET', body, binary = false } = {}) => {
    const observation = { index: requests.length, generation: state.generation, route, method,
      boundaryId: context.getStore()?.boundaryId, open: true }; requests.push(observation); pendingRequests.add(observation);
    try {
      const response = await fetch(`http://127.0.0.1:${state.runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port}${route}`, { method,
        headers: { Accept: 'application/json', 'X-Emby-Token': state.token,
          ...(body !== undefined && { 'Content-Type': 'application/json' }) },
        ...(body !== undefined && { body: configurationJson(body) }) });
      const bytes = Buffer.from(await response.arrayBuffer()), text = binary ? undefined : bytes.toString('utf8');
      let value = null; if (!binary && text !== '') try { value = parseLosslessJson(text); } catch { value = text; }
      Object.assign(observation, { status: response.status, contentType: response.headers.get('content-type'),
        ...(binary ? { payload: bytesValue(bytes) } : { text, body: value }) });
      return { ...observation, bytes, body: value };
    } finally { observation.open = false; pendingRequests.delete(observation); }
  };
  state.principals = async () => {
    state.token = (await state.runtime.apiKeys.create('Configuration restart ' + label)).AccessToken;
    const user = await state.runtime.users.createUser({ Name: 'Configuration restart ' + label });
    state.userId = user.Id; state.userName = user.Name;
    state.userRows = await state.database.rows('Users', { where: { Id: nativeGuid(user.Id) } });
    state.keyRows = await state.database.rows('ApiKeys', { columns: ['Name', 'DateCreated'], where: { AccessToken: state.token } });
    assert.equal(state.userRows.length, 1); assert.equal(state.keyRows.length, 1);
    report.principals = { userId: user.Id, userName: user.Name, userRows: state.userRows, apiKeyRows: state.keyRows };
  };
  state.protect = async (filename, purpose) => {
    const bytes = await fs.readFile(filename); protectedFiles.set(filename, { bytes, purpose }); return bytes;
  };
  state.assertProtected = async () => {
    for (const [filename, expected] of protectedFiles) {
      const bytes = await fs.readFile(filename);
      report.fileReads.push({ generation: state.generation, phase: state.phase, filename, purpose: expected.purpose, actual: bytesValue(bytes) });
      assert.deepEqual(bytes, expected.bytes, expected.purpose + ': ' + filename);
    }
  };
  state.seedMedia = async () => {
    const id = nativeGuid(randomUUID()), filename = path.join(state.programDataPath, 'media', 'original.mkv');
    const bytes = Buffer.from('Original isolated media bytes\0survive configuration and storage recovery.\n');
    await state.runtime.fileSystem.mkdir(path.dirname(filename), { recursive: true }); await state.runtime.fileSystem.writeFile(filename, bytes);
    await state.database.insert('BaseItems', postgresTestRow('BaseItems', { Id: id,
      Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Name: 'Original recovery movie', CleanName: 'original recovery movie', SortName: 'original recovery movie',
      Path: filename, IsMovie: true, MediaType: 'Video', RunTimeTicks: 100000000n,
      Data: '{"VideoType":"VideoFile","Container":"mkv","SourceType":"Library"}' }));
    state.media = { id, filename, bytes, rows: await state.database.rows('BaseItems', { where: { Id: id } }) };
    report.media = { id, filename, ...bytesValue(bytes), rows: state.media.rows };
    await state.protect(filename, 'Original media');
  };
  state.originals = async () => {
    await state.assertProtected();
    const actual = { generation: state.generation,
      users: await state.database.rows('Users', { where: { Id: nativeGuid(state.userId) } }),
      apiKeys: await state.database.rows('ApiKeys', { columns: ['Name', 'DateCreated'], where: { AccessToken: state.token } }),
      media: await state.database.rows('BaseItems', { where: { Id: state.media.id } }) };
    report.originals.push(actual);
    assert.deepEqual(actual.users, state.userRows); assert.deepEqual(actual.apiKeys, state.keyRows); assert.deepEqual(actual.media, state.media.rows);
    const user = await state.call('/Users/' + state.userId); assert.equal(user.status, 200); assert.equal(user.body.Name, state.userName);
    const media = await state.call('/Items/' + state.media.id + '/File', { binary: true });
    assert.equal(media.status, 200); assert.deepEqual(media.bytes, state.media.bytes);
  };
  state.snapshot = async (label, metadataPath, cachePath, version, expectedConfiguration) => {
    const configuration = await state.call('/System/Configuration'), info = await state.call('/System/Info');
    assert.equal(configuration.status, 200); assert.match(configuration.contentType, /application\/json/u);
    assert.equal(info.status, 200); assert.equal(info.body.InternalMetadataPath, metadataPath); assert.equal(info.body.ItemsByNamePath, metadataPath);
    assert.equal(info.body.CachePath, cachePath); assert.equal(info.body.ProgramDataPath, state.programDataPath);
    assert.equal(configuration.body.PreviousVersion, version); assert.equal(configuration.body.PreviousVersionStr, version);
    if (expectedConfiguration) assert.deepEqual(configuration.body, expectedConfiguration);
    const system = await fs.readFile(path.join(root, 'config/system.xml'));
    stages.push({ label, generation: state.generation, schema: state.database.schemaName, configurationRequest: configuration.index,
      systemInfoRequest: info.index, systemXml: bytesValue(system), serverId: info.body.Id });
    if (state.serverId) assert.equal(info.body.Id, state.serverId); else state.serverId = info.body.Id;
    return configuration.body;
  };
  state.exercise = async (label, metadataPath, cachePath, width) => {
    const studio = await state.runtime.library.getStudio('Restart studio ' + label);
    assert.equal(path.relative(metadataPath, studio.Path).split(path.sep)[0], 'Studio');
    assert.equal((await state.runtime.fileSystem.stat(studio.Path)).isDirectory(), true);
    const witness = path.join(studio.Path, 'restart-proof.txt');
    await state.runtime.fileSystem.writeFile(witness, 'Metadata storage after ' + label);
    await state.protect(witness, 'Metadata write ' + label);
    const source = path.join(state.programDataPath, 'data', 'cache-source-' + label + '.png');
    const original = await fs.readFile(new URL('../images/fixtures/processor/grid.png', import.meta.url));
    await state.runtime.fileSystem.writeFile(source, original); await state.protect(source, 'Image source ' + label);
    const processed = await state.runtime.imageProcessor.process({ image: { Path: source,
      DateModified: '2024-01-01T00:00:00Z', Width: 20, Height: 12 }, Width: width, Quality: 80, SupportedOutputFormats: ['Png'],
      assets: new MetadataImageAssets({ fileSystem: state.runtime.fileSystem, stateRoots: [state.programDataPath] }) });
    assert.equal(processed.original, false); assert.equal(path.relative(cachePath, processed.path).split(path.sep)[0], 'images');
    assert.deepEqual(await state.runtime.fileSystem.readFile(processed.path), processed.bytes);
    assert.deepEqual(processed.bytes.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'));
    await state.protect(processed.path, 'Image cache ' + label);
    effects.push({ label, generation: state.generation, metadataDirectory: studio.Path, metadataFile: witness,
      imageSource: source, source: bytesValue(original), imageCache: processed.path, cached: bytesValue(processed.bytes) });
  };
  state.unavailable = async boundary => {
    let failure; try { await state.runtime.fileSystem.lstat(state.programDataPath); } catch (error) { failure = error; }
    assert.ok(failure, 'Required application storage must actually reject while local is disabled.');
    assert.ok(['ENOTSUP', 'not-supported', 'unmapped-path'].includes(failure.code));
    boundary.failure = errorValue(failure); boundary.diagnostic = errorValue(failure, true);
    const status = await state.call('/Storage/Status'); assert.equal(status.status, 200);
    assert.equal(status.body.application.ready, false); assert.equal(status.body.application.error, failure.message);
    assert.ok(status.body.instances.some(instance => instance.type === 'local' && !instance.available));
    boundary.storageStatusRequest = status.index;
  };
  state.missingStorage = async (label, operation) => {
    const boundary = { id: boundaries.length, label, generation: state.generation, open: true }; boundaries.push(boundary);
    try { return await context.run({ kind: 'unavailable-operation', boundaryId: boundary.id }, async () => {
      const result = await operation(); boundary.generation = state.generation; await state.unavailable(boundary); return result;
    }); } finally { boundary.open = false; }
  };
  try {
    await fs.mkdir(path.join(root, 'config'));
    await fs.writeFile(path.join(root, 'config/system.xml'), serializeConfiguration('server', { ...defaultConfiguration('server'),
      IsStartupWizardCompleted: true, ServerName: 'Configuration restart ' + label }));
    await fs.writeFile(path.join(root, 'config/network.xml'), serializeConfiguration('network', { ...defaultConfiguration('network'), InternalHttpPort: 0, LocalNetworkAddresses: ['127.0.0.1'], AutoDiscovery: false, EnablePublishedServerUriByRequest: true }));
    await run(state);
  } catch (error) { failure = error; }
  const attempt = async operation => { try { await operation(); } catch (error) { cleanupErrors.push(error); } };
  await attempt(() => state.close());
  await attempt(() => state.assertProtected());
  await attempt(async () => {
    for (const diagnostic of diagnostics) {
      const boundary = boundaries[diagnostic.owner.boundaryId];
      assert.ok(boundary?.failure, 'Unexpected startup, request, background or close error: ' + configurationJson(diagnostic));
      assert.equal(diagnostic.boundaryOpen, true); assert.equal(diagnostic.generation, boundary.generation);
      assert.ok(['open', 'http'].includes(diagnostic.owner.kind));
      if (diagnostic.owner.kind === 'http') assert.equal(diagnostic.requestOpen, true);
      assert.deepEqual(diagnostic.failure, boundary.failure);
    }
  });
  await attempt(() => dropPostgresTestDatabase(state.database));
  report.retainedFiles = [...protectedFiles].map(([filename, value]) => ({ filename, purpose: value.purpose, ...bytesValue(value.bytes) }));
  await attempt(async () => {
    assert.equal(path.dirname(root), output); assert.ok(path.basename(root).startsWith('configuration-runtime-restore-'));
    assert.equal(path.relative(path.toNamespacedPath(root), path.toNamespacedPath(await fs.realpath(root))), '');
    await fs.rm(root, { recursive: true, force: true });
  });
  report.failure = errorValue(failure, true); report.cleanupErrors = cleanupErrors.map(error => errorValue(error, true));
  report.completed = failure === undefined && cleanupErrors.length === 0;
  await attempt(() => fs.writeFile(path.join(output, path.basename(root) + '.json'), configurationJson(report), { flag: 'wx' }));
  context.disable();
  if (failure && cleanupErrors.length) throw new AggregateError([failure, ...cleanupErrors], 'Runtime restoration and cleanup failed.', { cause: failure });
  if (failure) throw failure;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Runtime restoration cleanup failed.', { cause: cleanupErrors[0] });
}

test('postgres: saved paths and version survive a real cold runtime and cleared cache resets only after another cold start', enabled, async () => {
  await scenario('paths', async state => {
    const metadata = path.join(state.programDataPath, 'selected-metadata'), cache = path.join(state.programDataPath, 'selected-cache');
    const defaultMetadata = path.join(state.programDataPath, 'metadata'), defaultCache = path.join(state.programDataPath, 'cache');
    await state.open(); await state.principals(); await state.seedMedia();
    await state.runtime.fileSystem.mkdir(metadata, { recursive: true }); await state.runtime.fileSystem.mkdir(cache, { recursive: true });
    const current = await state.call('/System/Configuration'); assert.equal(current.status, 200);
    const saved = await state.call('/System/Configuration', { method: 'POST', body: { ...current.body,
      MetadataPath: metadata, CachePath: cache, PreviousVersion: '4.5.6', PreviousVersionStr: '4.5.6', ServerName: 'Saved cold configuration' } });
    assert.equal(saved.status, 204); assert.equal(saved.text, '');
    const selected = await state.snapshot('selected-warm', metadata, cache, '4.5.6');
    await state.exercise('selected-warm', metadata, cache, 8); await state.originals();
    await state.close(); await state.open();
    await state.snapshot('selected-cold', metadata, cache, '4.5.6', selected);
    await state.exercise('selected-cold', metadata, cache, 9); await state.originals();
    const cleared = await state.call('/System/Configuration', { method: 'POST', body: { ...selected, MetadataPath: '', CachePath: null } });
    assert.equal(cleared.status, 204); assert.equal(cleared.text, '');
    const empty = await state.snapshot('cleared-warm', defaultMetadata, cache, '4.5.6');
    assert.equal(empty.MetadataPath, ''); assert.equal(Object.hasOwn(empty, 'CachePath'), false);
    await state.exercise('cleared-warm', defaultMetadata, cache, 10); await state.originals();
    await state.close(); await state.open();
    await state.snapshot('cleared-cold', defaultMetadata, defaultCache, '4.5.6', empty);
    await state.exercise('cleared-cold', defaultMetadata, defaultCache, 11); await state.originals();
    assert.match(await fs.readFile(path.join(defaultCache, 'CACHEDIR.TAG'), 'utf8'), /^Signature: 8a477f597d28d172789f06886806bc55\n/u);
    await state.close();
  });
});

test('postgres: a persisted disabled local plugin permits cold management and real storage recovery retries configuration initialization', enabled, async () => {
  await scenario('recovery', async state => {
    const metadata = path.join(state.programDataPath, 'recovered-metadata'), cache = path.join(state.programDataPath, 'recovered-cache');
    await state.open(); await state.principals(); await state.seedMedia();
    await state.runtime.fileSystem.mkdir(metadata, { recursive: true }); await state.runtime.fileSystem.mkdir(cache, { recursive: true });
    const current = await state.call('/System/Configuration'); assert.equal(current.status, 200);
    const saved = await state.call('/System/Configuration', { method: 'POST', body: { ...current.body,
      MetadataPath: metadata, CachePath: cache, PreviousVersion: '7.8.9', PreviousVersionStr: '7.8.9' } });
    assert.equal(saved.status, 204); const configuration = await state.snapshot('enabled-warm', metadata, cache, '7.8.9');
    const beforeStorage = await state.call('/Storage/Configuration'); assert.equal(beforeStorage.status, 200);
    const marker = await fs.readFile(path.join(cache, '.jellyfin-cache')), tag = await fs.readFile(path.join(cache, 'CACHEDIR.TAG'));
    await state.missingStorage('persist-disable-local', async () => {
      const disabled = await state.call('/Plugins/local/Enabled', { method: 'POST', body: { enabled: false } });
      assert.equal(disabled.status, 200); assert.equal(disabled.body.enabled, false); assert.equal(disabled.body.status, 'disabled');
    });
    // These are owned fixture paths. Removing the empty metadata directory and
    // cache markers requires recovery to perform actual initialization IO.
    await fs.rmdir(metadata);
    await state.close();
    await state.missingStorage('cold-open-disabled-local', async () => {
      await state.open();
      const disabled = await state.call('/Plugins/local'); assert.equal(disabled.status, 200);
      assert.equal(disabled.body.enabled, false); assert.equal(disabled.body.status, 'disabled'); assert.equal(disabled.body.installed, true);
      const storage = await state.call('/Storage/Configuration'); assert.equal(storage.status, 200); assert.deepEqual(storage.body, beforeStorage.body);
      await state.snapshot('disabled-cold-management', metadata, cache, '7.8.9', configuration);
    });
    assert.deepEqual(await fs.readFile(state.media.filename), state.media.bytes);
    await assert.rejects(fs.stat(metadata), missing);
    assert.deepEqual(await fs.readFile(path.join(cache, '.jellyfin-cache')), marker);
    assert.deepEqual(await fs.readFile(path.join(cache, 'CACHEDIR.TAG')), tag);
    await fs.unlink(path.join(cache, '.jellyfin-cache')); await fs.unlink(path.join(cache, 'CACHEDIR.TAG'));
    const enabled = await state.call('/Plugins/local/Enabled', { method: 'POST', body: { enabled: true } });
    assert.equal(enabled.status, 200); assert.equal(enabled.body.enabled, true); assert.equal(enabled.body.status, 'active');
    const status = await state.call('/Storage/Status'); assert.equal(status.status, 200); assert.equal(status.body.application.ready, true);
    assert.equal(Object.hasOwn(status.body.application, 'error'), false);
    assert.ok(status.body.instances.some(instance => instance.type === 'local' && instance.available));
    assert.ok(status.body.instances.filter(instance => instance.type === 'local').every(instance => instance.available));
    assert.equal((await state.runtime.fileSystem.stat(metadata)).isDirectory(), true);
    for (const directory of [path.join(state.programDataPath, 'root'), path.join(state.programDataPath, 'data/playlists'),
      path.join(state.programDataPath, 'data/metadata-spool')]) assert.equal((await state.runtime.fileSystem.stat(directory)).isDirectory(), true);
    assert.deepEqual(await fs.readFile(path.join(cache, '.jellyfin-cache')), marker);
    assert.deepEqual(await fs.readFile(path.join(cache, 'CACHEDIR.TAG')), tag);
    await state.snapshot('enabled-recovered', metadata, cache, '7.8.9', configuration);
    await state.exercise('enabled-recovered', metadata, cache, 8); await state.originals();
    await state.close();
  });
});
