import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, stat, writeFile, unlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { nativeModel } from '../../../../src/database/model.js';
import { decodeNativeTextBytes } from '../../../../src/database/native-text.js';
import { dateTicks } from '../../../../src/library/records.js';
import { SqliteDatabase } from '../../../../src/database/sqlite.js';
import { transferDatabase, exportCurrentSqlite } from '../../../../src/migration/database-transfer.js';
import { createRuntime } from '../../../../src/runtime.js';
import { defaultLibraryOptions } from '../../../../src/library/options.js';
import { ItemUpdateType } from '../../../../src/metadata/save-manager.js';
import { serializeLibraryOptions } from '../../../../src/library/library-options-store.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../../../database/postgres-fixture.js';
import { json, sha } from './capture.js';
import { describeFile } from '../../../../tools/validation/inventory.js';

const errorRecord = error => typeof error === 'string' ? { message: error }
  : { name: error.name, code: error.code, message: error.message, stack: error.stack };
const nativeType = item => item.NativeType ?? (String(item.Type).includes('.') ? item.Type : 'MediaBrowser.Controller.Entities.'
  + (['Movie', 'BoxSet'].includes(item.Type) ? 'Movies.' : '') + item.Type);
const itemEvent = item => item == null ? null : ({ id: item.Id, type: nativeType(item), Name: item.Name, path: item.Path,
  ParentId: item.ParentId, OwnerId: item.OwnerId, IsFolder: item.IsFolder, isRoot: item.IsRoot ?? null,
  DateCreated: item.DateCreated, DateModified: item.DateModified, DateLastSaved: item.DateLastSaved,
  DateLastRefreshed: item.DateLastRefreshed, Genres: [...item.Genres ?? []], Studios: [...item.Studios ?? []],
  tmdbCollectionName: item.TmdbCollectionName ?? null, Overview: item.Overview, RunTimeTicks: item.RunTimeTicks,
  ProviderIds: Object.fromEntries(item.ProviderIds instanceof Map ? item.ProviderIds : Object.entries(item.ProviderIds ?? {})), IsLocked: item.IsLocked });

/** A real production PG runtime, importing the same complete frozen SQLite as
 * both native processes. Observers forward calls and never replace workers. */
export async function runMovieCandidate(capture) {
  const { root: output, bound } = capture, specification = bound.specification;
  const root = path.join(output, 'candidate'), program = path.join(root, 'program'), media = path.join(root, 'media');
  const report = { schemaVersion: 1, root, startedAt: new Date().toISOString(), observations: [], trace: [], errors: [],
    clockWindowStart: bound.clockWindowStart,
    inputSha256: capture.report.boundInput.sha256, inputDatabaseSha256: bound.database.sha256,
    media: bound.media,
    preparationExecutedAsBusiness: false, releaseAcceptance: false, cleanup: {} };
  report.timeZone = { id: Intl.DateTimeFormat().resolvedOptions().timeZone, offsetMinutes: -new Date().getTimezoneOffset() };
  assert.equal(report.timeZone.offsetMinutes, specification.localTimezoneOffsetMinutes);
  let database, runtime, source, phase = 'initialization', ordinal = 0, activeQueued = 0, activeBatches = 0, cleanupSequence = 0, failure;
  const queuedContext = new AsyncLocalStorage(), requests = [];
  const trace = (action, detail) => report.trace.push({ ordinal: ++ordinal, phase, action, detail,
    scanRunning: runtime?.libraryScanLifecycle.isScanRunning ?? false });
  const queue = () => { const queued = [...runtime.metadata.getRefreshQueue()];
    return { queued, processing: activeQueued > 0 || activeBatches > 0 || queued.length > 0 }; };
  const write = () => writeFile(path.join(output, 'candidate.json'), process.env.MEDIAMANAGER_TEST_POSTGRES
    ? json(report).replaceAll(process.env.MEDIAMANAGER_TEST_POSTGRES, '[fixture-secret]') : json(report));
  const options = { ...defaultLibraryOptions(), SaveLocalMetadata: true, MetadataSavers: ['Nfo'], AutomaticallyAddToCollection: true,
    EnableRealtimeMonitor: false, EnableInternetProviders: false,
    TypeOptions: ['Movie', 'BoxSet', 'Genre', 'MusicGenre', 'Studio', 'Folder', 'CollectionFolder']
      .map(Type => ({ Type, MetadataFetchers: [], MetadataFetcherOrder: [], ImageFetchers: [],
        ImageFetcherOrder: [], ImageOptions: [], SimilarItemProviders: [], SimilarItemProviderOrder: [] })),
    PathInfos: [{ Path: media }] };
  try {
    await mkdir(root); await mkdir(media); await mkdir(program);
    // Both executors receive an already configured empty Movies library. Native
    // uses CollectionFolder.SaveLibraryOptions; this is the production Node
    // serializer for the identical neutral options, before either global scan.
    const virtual = path.join(program, 'root/default/Movies'); await mkdir(virtual, { recursive: true });
    const serializedOptions = serializeLibraryOptions(options); assert.equal(serializedOptions.failure, undefined);
    await writeFile(path.join(virtual, 'options.xml'), serializedOptions.bytes);
    await writeFile(path.join(virtual, 'movies.collection'), '');
    await writeFile(path.join(virtual, 'location-00.mblink'), media);
    database = await createPostgresTestDatabase(null, 'movie_global');
    report.postgresSchema = database.schemaName;
    const style = process.platform === 'win32' ? 'windows' : 'posix', caseSensitive = process.platform !== 'win32';
    const mountContract = { mounts: [{ mountId: 'movie-global', identityRoot: root, accessRoot: '/case',
      pathStyle: style, caseSensitive, returnPolicy: 'required' }] };
    // Opening SQLite read-only can still create WAL/SHM companions. Give PG's
    // importer its own exact clone, keeping the frozen common input unopened.
    const sourceClone = path.join(root, 'initial-native.db'); await copyFile(bound.database.filename, sourceClone);
    report.sourceClone = await describeFile(sourceClone); assert.equal(report.sourceClone.sha256, bound.database.sha256);
    source = new SqliteDatabase(sourceClone, { readOnly: true, requireMigrationHistory: true });
    report.transfer = await transferDatabase(source, database, { instanceBinding: { serverId: specification.serverId,
      originIdentityDigest: bound.database.sha256 }, portableMountContract: mountContract });
    source.close(); source = undefined;
    assert.equal(sha(await readFile(sourceClone)), bound.database.sha256);
    // Use the production plugin/storage bootstrap with the exact imported
    // portable mapping. Only the declared empty ignore ancestors project to a
    // separate private empty directory; no host ancestor is read.
    const ancestors = path.join(root, 'empty-ignore-ancestors'); await mkdir(ancestors);
    const storageFilename = path.join(root, 'storage.json');
    await writeFile(storageFilename, json({
      instances: [{ id: 'case', type: 'local', config: { root, writable: true } },
        { id: 'empty-ancestors', type: 'local', config: { root: ancestors, writable: false } }],
      mounts: [{ path: '/case', instanceId: 'case', capabilities: { create: true, replace: true,
        mkdir: true, delete: true, rename: true, atomicReplace: true } },
        { path: '/known-ignore-ancestors', instanceId: 'empty-ancestors', capabilities: {} }],
      prefixes: [{ identityRoot: root, accessRoot: '/case', style, caseSensitive, purpose: 'library',
        returnAccess: 'Actual isolated Movie input and application state.' }],
      ignorePrefixes: [{ identityRoot: path.parse(root).root, accessRoot: '/known-ignore-ancestors', style,
        caseSensitive, returnAccess: 'Declared empty ancestors of the isolated Movie scenario.' }],
    }));
    report.storageConfiguration = await describeFile(storageFilename);
    runtime = await createRuntime({ database, programDataPath: program, configurationDirectoryPath: path.join(program, 'config'),
      serverId: specification.serverId, portableMountContract: mountContract, storageConfiguration: storageFilename,
      configuration: { UICulture: specification.culture, IsStartupWizardCompleted: true, LibraryScanFanoutConcurrency: 1,
        MetadataCountryCode: 'US', PreferredMetadataLanguage: 'en', EnableCaseSensitiveItemIds: true },
      probeOptions: { ffprobePath: bound.ffprobe }, onError: error => report.errors.push({ phase, ...errorRecord(error) }) });
    const savedClock = runtime.metadataUpdates.now;
    runtime.metadataUpdates.now = function () {
      const value = savedClock.call(this);
      trace('repository-save-clock', { value, highResolutionUnixMilliseconds: performance.timeOrigin + performance.now() });
      return value;
    };
    for (const [name, action] of [['ItemAdded', 'added'], ['ItemUpdated', 'updated'], ['ItemRemoved', 'removed']]) {
      runtime.library.on(name, event => trace(action, { item: itemEvent(event.Item), parent: event.Parent?.Id ?? null,
        updateReason: event.UpdateReason ?? 0 }));
    }
    for (const [name, method] of [['deleteItemFiles', 'DeleteExternalItemFiles'], ['deleteItemData', 'DeleteExternalItemDataAsync']]) {
      const actual = runtime.externalData[name]; assert.equal(typeof actual, 'function', name);
      runtime.externalData[name] = async function (item, options = {}) {
        const cleanupId = ++cleanupSequence;
        trace('external-cleanup-begin', { cleanupId, method, item: itemEvent(item), snapshot: await externalCleanupSnapshot(item, options.loaded) });
        try {
          const result = await actual.call(this, item, options);
          trace('external-cleanup-completed', { cleanupId, method, item: itemEvent(item), snapshot: await externalCleanupSnapshot(item, options.loaded) });
          return result;
        } catch (error) {
          trace('external-cleanup-failed', { cleanupId, method, item: itemEvent(item), error: errorRecord(error) }); throw error;
        }
      };
    }
    const observedIds = ['MovieNfoProvider', 'MovieNfoSaver', 'BoxSetXmlProvider', 'BoxSetXmlSaver'];
    const declaredIds = runtime.metadata.registry.plugins().flatMap(extension => extension.providers)
      .filter(provider => observedIds.includes(provider.id)).map(provider => provider.id);
    assert.deepEqual(declaredIds.sort(), [...observedIds].sort());
    const observeProvider = provider => observedIds.includes(provider.id) ? new Proxy(provider, {
      get(target, key) {
        const actual = Reflect.get(target, key, target);
        if (typeof actual !== 'function') return actual;
        if (key === 'getMetadata') return async function (item, ...args) {
          trace('local-reader-begin', { provider: provider.id, Path: item.Path });
          const result = await actual.call(target, item, ...args), metadata = result.Item;
          trace('local-reader-completed', { provider: provider.id, Path: item.Path, HasMetadata: result.HasMetadata,
            Name: metadata?.Name ?? null, DateCreated: metadata?.DateCreated ?? null,
            Genres: metadata?.Genres ? [...metadata.Genres] : null,
            Studios: metadata?.Studios ? [...metadata.Studios] : null, tmdbCollectionName: metadata?.TmdbCollectionName ?? null });
          return result;
        };
        if (key === 'hasChanged') return async function (item, ...args) {
          const changed = await actual.call(target, item, ...args);
          trace('local-reader-change-check', { provider: provider.id, itemId: item.Id, Path: item.Path, DateLastSaved: item.DateLastSaved, changed });
          return changed;
        };
        if (key === 'prepareSave') return async function (item, ...args) {
          trace('local-saver-prepare-begin', { saver: provider.id, itemId: item.Id, Path: item.Path });
          const prepared = await actual.call(target, item, ...args);
          trace('local-saver-prepare-completed', { saver: provider.id, itemId: item.Id, Path: item.Path, path: prepared.path, changed: prepared.changed });
          return new Proxy(prepared, { get(resource, property) {
            const value = Reflect.get(resource, property, resource);
            if (property !== 'apply') return value;
            return async function (...values) {
              trace('local-saver-begin', { saver: provider.id, itemId: item.Id, Path: item.Path, filename: prepared.path });
              const result = await value.apply(resource, values);
              trace('local-saver-completed', { saver: provider.id, itemId: item.Id, Path: item.Path, result }); return result;
            };
          } });
        };
        if (key === 'save') return async function (item, ...args) {
          trace('local-saver-begin', { saver: provider.id, itemId: item.Id, Path: item.Path });
          const result = await actual.call(target, item, ...args);
          trace('local-saver-completed', { saver: provider.id, itemId: item.Id, Path: item.Path, result }); return result;
        };
        return actual;
      }
    }) : provider;
    const discover = runtime.metadata.registry.discover;
    runtime.metadata.registry.discover = function (...args) {
      return discover.apply(this, args).map(observeProvider);
    };
    report.observedLocalImplementations = declaredIds;
    const query = database.client.query;
    database.client.query = async function (...args) {
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
      const result = await query.apply(this, args);
      const requests = /UPDATE "(mm_collection_requests_[a-f0-9]{32})" request SET "Addition" = NOT EXISTS/u.exec(text);
      const initial = /FROM "(mm_link_resolution_raw_[a-f0-9]{32})" initial/u.exec(text);
      if (requests && initial) {
        const raw = await query.call(this, `SELECT "Ordinal", "ItemId", "Type", "Path", "LibraryItemId", "ResolvedId"
          FROM "${initial[1]}" ORDER BY "Ordinal" LIMIT 128`);
        const requested = await query.call(this, `SELECT "Ordinal", "Id", "ResolvedId", "Addition"
          FROM "${requests[1]}" ORDER BY "Ordinal" LIMIT 128`);
        const decode = row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
          [key, value instanceof Uint8Array ? decodeNativeTextBytes(value) : value]));
        trace('collection-membership-observed', { raw: raw.rows.map(decode), requests: requested.rows.map(decode),
          scope: 'Actual post-resolution TEMP rows after Addition selection; observation only, on the owning checked-out session.' });
      }
      return result;
    };
    const refresh = runtime.metadata.refresh;
    runtime.metadata.refresh = async function (...args) {
      trace('metadata-begin', { reference: typeof args[0] === 'string' ? args[0] : args[0]?.Id, options: refreshOptions(args[1]) });
      const result = await refresh.apply(this, args);
      trace('metadata-completed', { item: itemEvent(result?.Item), UpdateType: result?.UpdateType ?? null }); return result;
    };
    const probe = runtime.probe.probe;
    runtime.probe.probe = async function (...args) {
      trace('probe-begin', { path: args[1], options: { ffprobePath: args[2]?.ffprobePath,
        extractChapters: args[2]?.extractChapters }, startedAt: new Date().toISOString() });
      try {
        const result = await probe.apply(this, args);
        trace('probe-completed', { path: args[1], result, endedAt: new Date().toISOString() }); return result;
      } catch (error) { trace('probe-failed', { path: args[1], error: errorRecord(error) }); throw error; }
    };
    const admit = runtime.metadata.queue;
    runtime.metadata.queue = function (...args) {
      const reference = typeof args[0] === 'string' ? args[0] : args[0]?.Id;
      const request = { id: requests.length + 1, itemId: reference, options: refreshOptions(args[1]), phase, Started: 0, Completed: 0, Failed: 0,
        workerStarted: 0, workerCompleted: 0, workerFailed: 0, drained: false }; requests.push(request);
      trace('queue-admission-begin', { requestId: request.id, itemId: reference, options: refreshOptions(args[1]), priority: args[2] ?? 0, queue: queue() });
      const task = admit.apply(this, args); trace('queue-admission-returned', { requestId: request.id, itemId: reference, queue: queue() });
      task.then(() => trace('queue-item-completed', { requestId: request.id, itemId: reference }),
        error => trace('queue-item-failed', { requestId: request.id, itemId: reference, error: errorRecord(error) }));
      return task;
    };
    const queuedRefresh = runtime.metadata.queuedRefresh;
    runtime.metadata.queuedRefresh = async function (...args) {
      const id = String(typeof args[0] === 'string' ? args[0] : args[0].Id).replaceAll('-', '').toLowerCase();
      const signature = JSON.stringify(refreshOptions(args[1]));
      const admitted = requests.filter(request => !request.workerStarted && String(request.itemId).replaceAll('-', '').toLowerCase() === id
        && JSON.stringify(request.options) === signature);
      assert.equal(admitted.length, 1, 'The actual target and refresh options must identify one admitted request.');
      const request = admitted[0]; request.workerStarted++; activeQueued++;
      trace('queue-worker-start', { requestId: request.id, itemId: request.itemId });
      try {
        const result = await queuedContext.run(request, () => queuedRefresh.apply(this, args));
        request.workerCompleted++; trace('queue-worker-completed', { requestId: request.id, itemId: request.itemId }); return result;
      } catch (error) {
        request.workerFailed++; trace('queue-worker-failed', { requestId: request.id, itemId: request.itemId, error: errorRecord(error) }); throw error;
      } finally { activeQueued--; }
    };
    const scanMetadata = runtime.metadataScanner.refreshLiveItem;
    runtime.metadataScanner.refreshLiveItem = async function (...args) {
      const request = queuedContext.getStore(), item = args[0];
      const matched = request && String(item.Id).replaceAll('-', '').toLowerCase() === String(request.itemId).replaceAll('-', '').toLowerCase();
      if (matched) { request.Started++; trace('queue-metadata-start', { requestId: request.id, itemId: item.Id, item: itemEvent(item) }); }
      try {
        const result = await scanMetadata.apply(this, args);
        if (matched) { request.Completed++; trace('queue-metadata-completed', { requestId: request.id, itemId: item.Id,
          updateType: result.UpdateType, item: itemEvent(item) }); }
        return result;
      } catch (error) {
        if (matched) { request.Failed++; trace('queue-metadata-failed', { requestId: request.id, itemId: item.Id, error: errorRecord(error) }); }
        throw error;
      }
    };
    for (const [name, begin, end] of [['runQueuedBatch', () => activeBatches++, () => activeBatches--]]) {
      const actual = runtime.metadata[name]; assert.equal(typeof actual, 'function', name);
      runtime.metadata[name] = async function (...args) {
        begin(); trace(name + '-begin', { queue: queue() });
        try { return await actual.apply(this, args); }
        finally { end(); trace(name + '-completed', { queue: queue() }); }
      };
    }
    const tasks = runtime.libraryScanLifecycle.postScanTasks;
    report.registration = { postScanTasks: tasks.map(task => task.name), postScanTaskTypes: tasks.map(task => task.constructor.name),
      capabilities: runtime.libraryScanner.capabilities, externalDataManager: runtime.externalData.constructor.name };
    assert.equal(tasks.length, specification.postScanTasks.length);
    for (const task of tasks) {
      const run = task.run;
      task.run = async function (...args) {
        trace('post-task-begin', { name: task.name, queue: queue() });
        try { return await run.apply(this, args); }
        finally { trace('post-task-completed', { name: task.name, queue: queue() }); }
      };
    }
    await runtime.plugins.setEnabled('tmdb', false);
    for (const name of specification.movies) {
      const filename = path.join(media, name + '.mkv');
      await copyFile(bound.media.filename, filename);
      const modeBefore = (await stat(filename)).mode;
      await chmod(filename, 0o644);
      const copied = await describeFile(filename);
      assert.equal(copied.sha256, bound.media.sha256); assert.equal(copied.bytes, bound.media.bytes);
      trace('controlled-media-copy', { filename, modeBefore, modeAfter: (await stat(filename)).mode,
        bytes: copied.bytes, sha256: copied.sha256, protectedSource: bound.media.filename });
      await writeFile(path.join(media, name + '.nfo'), nfo(name, specification.originalGenre, false));
    }
    trace('input-files-ready', { at: new Date().toISOString(), files: await files(root) });
    await scan('created');
    const first = report.observations.find(row => row.phase === 'created' && row.boundary === 'metadata-drained')
      .snapshot.sql.BaseItems.find(row => row.Path === path.join(media, 'First.mkv'));
    assert.ok(first); const saved = dateTicks(first.DateLastSaved), tolerance = BigInt(specification.nfoChangeToleranceMs) * 10000n;
    while (BigInt(Date.now()) * 10000n + 621355968000000000n <= saved + BigInt(specification.nfoChangeWaitMs) * 10000n)
      await new Promise(resolve => setTimeout(resolve, 20));
    const beforeWrite = new Date().toISOString(), filename = path.join(media, 'First.nfo');
    await writeFile(filename, nfo('Updated First', specification.changedGenre, true));
    const observed = await runtime.storage.vfs.stat('/case/media/First.nfo'), elapsedTicks = dateTicks(observed.modified) - saved;
    report.updateInput = { originalItemId: first.Id, saved: first.DateLastSaved, beforeWrite,
      observedModified: observed.modified, elapsedTicks, toleranceTicks: tolerance, text: await readFile(filename, 'utf8') };
    assert.ok(elapsedTicks > tolerance, 'The actual NFO write must exceed the original one-minute tolerance.');
    await scan('updated');
    await unlink(path.join(media, 'First.mkv')); await unlink(path.join(media, 'First.nfo'));
    await scan('deleted');
    assert.deepEqual(report.errors, []);
  } catch (error) { failure = error; report.failure = errorRecord(error); }
  finally {
    phase = 'cleanup'; const failures = [];
    const close = async (name, action) => { try { await action(); report.cleanup[name] = true; }
      catch (error) { report.cleanup[name] = false; failures.push(error); } };
    await close('runtime', () => runtime?.close());
    await close('source', () => source?.close());
    await close('postgresDropped', () => dropPostgresTestDatabase(database));
    await close('storage', async () => {
      if (!runtime) return;
      report.cleanup.storageAfterClose = runtime.storage.status();
      assert.equal(report.cleanup.storageAfterClose.every(instance => instance.available === false), true);
    });
    await close('frozenInputUnchanged', async () => {
      for (const file of [bound.database, bound.media]) assert.equal(sha(await readFile(file.filename)), file.sha256);
    });
    report.endedAt = new Date().toISOString();
    if (failures.length) { failure ??= new AggregateError(failures, 'Movie candidate owners failed to close.'); report.cleanup.failures = failures.map(errorRecord); }
    await write();
  }
  if (failure) throw failure;
  return report;

  async function externalCleanupSnapshot(item, loaded) {
    const paths = [];
    for (const directory of runtime.externalData.paths(item, loaded)) {
      const absolute = path.resolve(directory), relative = path.relative(root, absolute);
      assert.ok(!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep),
        'External cleanup must remain inside the controlled case root: ' + absolute);
      let info;
      try { info = await lstat(absolute); }
      catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
      assert.notEqual(info?.isSymbolicLink(), true, 'External cleanup cannot traverse a link.');
      const files = [];
      async function visit(current) {
        for (const entry of await readdir(current, { withFileTypes: true })) {
          assert.equal(entry.isSymbolicLink(), false, 'External cleanup cannot traverse a link.');
          const filename = path.join(current, entry.name);
          if (entry.isDirectory()) await visit(filename);
          else { const bytes = await readFile(filename); files.push({ path: path.relative(root, filename).replaceAll('\\', '/'),
            bytes: bytes.length, sha256: sha(bytes) }); }
        }
      }
      if (info?.isDirectory()) await visit(absolute);
      paths.push({ path: absolute, relativePath: relative.replaceAll('\\', '/'),
        kind: info?.isDirectory() ? 'directory' : info ? 'file' : 'absent',
        files: files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) });
    }
    const tables = await runtime.store.run(async db => Object.fromEntries(await Promise.all(
      ['KeyframeData', 'MediaSegments', 'TrickplayInfos', 'Chapters'].map(async table => [table, await db.rows(table)]))));
    return { paths, tables };
  }

  async function snapshot(label) {
    const exported = path.join(output, 'candidate-' + label + '.db');
    const exportReceipt = await exportCurrentSqlite(database, exported);
    const native = new DatabaseSync(exported, { readOnly: true });
    try {
      const actual = native.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
      assert.deepEqual(actual, specification.tables);
      const all = {};
      for (const table of actual) {
        const statement = native.prepare(`SELECT * FROM "${table}" ORDER BY rowid`); statement.setReadBigInts(true);
        all[table] = statement.all().map(row => Object.fromEntries(Object.entries(row)
          .map(([name, value]) => [name, value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value])));
      }
      const sequence = native.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name'); sequence.setReadBigInts(true);
      const mediaFiles = [];
      for (const name of (await readdir(media)).filter(name => name.endsWith('.mkv')).sort()) {
        const bytes = await readFile(path.join(media, name)); mediaFiles.push({ path: 'media/' + name, bytes: bytes.length, sha256: sha(bytes) });
      }
      return { tables: actual, sql: all, sqliteSequence: sequence.all(), files: await files(root), mediaFiles, exportReceipt };
    } finally { native.close(); }
  }
  async function scan(name) {
    phase = name; const startedAt = new Date().toISOString();
    trace('before-global', { queue: queue() });
    let scanFailure;
    try { await runtime.libraryScanner.runCompleteScan({ reportProgress: value => trace('global-progress', { progress: value }) }); }
    catch (error) { scanFailure = error; }
    trace('after-global', { queue: queue() });
    report.observations.push({ phase, boundary: 'global-returned', startedAt, endedAt: new Date().toISOString(),
      status: scanFailure ? 'failed' : 'completed', scanRunning: runtime.libraryScanLifecycle.isScanRunning,
      Exception: scanFailure?.name ?? null, ExceptionMessage: scanFailure?.message ?? null, queue: queue(),
      snapshot: await snapshot(name + '-global-returned') });
    trace('queue-drain-begin', queue()); await runtime.metadata.drain();
    for (const request of requests.filter(value => !value.drained)) {
      assert.equal(request.workerStarted, 1); assert.equal(request.workerCompleted, 1); assert.equal(request.workerFailed, 0);
      request.drained = true;
      trace('queue-request-drained', { requestId: request.id, itemId: request.itemId, Started: request.Started,
        Completed: request.Completed, Failed: request.Failed, queue: queue() });
    }
    trace('queue-drain-completed', queue());
    assert.deepEqual(queue(), { queued: [], processing: false });
    if (phase === 'created' && !scanFailure) {
      assert.equal(specification.explicitMovieSaveUpdateReason, ItemUpdateType.MetadataEdit);
      for (const movieName of specification.movies) {
        const rows = await runtime.store.run(db => db.rows('BaseItems', { where: { Path: path.join(media, movieName + '.mkv') } }));
        assert.equal(rows.length, 1);
        await runtime.metadata.loadContext.withContext(rows[0].Id, {}, async loaded => {
          trace('explicit-movie-save-begin', { item: itemEvent(loaded.item), updateReason: specification.explicitMovieSaveUpdateReason });
          await runtime.metadataUpdates.updateRepository(loaded, { Item: loaded.item, Images: loaded.context.images },
            specification.explicitMovieSaveUpdateReason);
          trace('explicit-movie-save-completed', { item: itemEvent(loaded.item), updateReason: specification.explicitMovieSaveUpdateReason });
        });
      }
    }
    report.observations.push({ phase, boundary: 'metadata-drained', startedAt, endedAt: new Date().toISOString(),
      status: scanFailure ? 'failed' : 'completed', scanRunning: runtime.libraryScanLifecycle.isScanRunning,
      Exception: scanFailure?.name ?? null, ExceptionMessage: scanFailure?.message ?? null, queue: queue(),
      snapshot: await snapshot(name + '-metadata-drained') });
    await write(); if (scanFailure) throw scanFailure;
  }
  function nfo(title, genre, locked) { return `<movie><title>${title}</title><plot>${specification.overview}</plot>${locked ? '<lockdata>true</lockdata>' : ''}<set><name>${specification.collectionName}</name></set><genre>${genre}</genre><studio>${specification.studio}</studio><custom keep="true">retained</custom></movie>`; }
}

function refreshOptions(options = {}) {
  return Object.fromEntries(['MetadataRefreshMode', 'ImageRefreshMode', 'ForceSave', 'ReplaceAllMetadata', 'IsAutomated', 'RemoveOldMetadata', 'RefreshPaths']
    .filter(key => options[key] !== undefined).map(key => [key, options[key]]));
}
async function files(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name); assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) await visit(filename);
      else if (/\.nfo$/iu.test(filename) || entry.name.toLowerCase() === 'collection.xml') {
        const bytes = await readFile(filename); result.push({ path: path.relative(root, filename).replaceAll('\\', '/'), filename,
          bytes: bytes.length, sha256: sha(bytes), text: bytes.toString('utf8'), lastWriteTimeUtc: (await stat(filename)).mtime.toISOString() });
      }
    }
  }
  await visit(root); return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
