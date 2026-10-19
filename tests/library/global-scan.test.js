import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRuntime } from '../../src/runtime.js';
import { tableDefinition } from '../../src/database/model.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { StorageError } from '../../src/storage/errors.js';
import { knownAncestorIgnoreIdentityMap } from './ignore-namespace-fixture.js';
import { idKey, dateText } from '../../src/library/records.js';
import { getNewItemId } from '../../src/core/identity.js';
import { deserializeNativeItemData } from '../../src/library/native-item-data.js';
import { createVirtualPathReverser } from '../../src/library/options.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { createSqliteExportPathProjector } from '../../src/migration/sqlite-export-paths.js';
import { nativeDateFromUnixNanoseconds } from '../../src/users/native.js';

const proofUrl = new URL('./fixtures/global-scan/provenance.json', import.meta.url);
const fixtureRoot = new URL('./', proofUrl);
const [native, provenance, reader, nativeClock] = await Promise.all(['native.json', 'provenance.json', 'reader-native.json', 'native-clock.json'].map(async name =>
  JSON.parse(await readFile(new URL(name, fixtureRoot), 'utf8'))));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const nativeType = name => 'MediaBrowser.Controller.Entities.' + name;
const pg = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES };

test('global scan binds the actual new runtime, raw18 capture, exact helper and source/build copies', async () => {
  assert.equal(native.cases.length, 18);
  assert.equal(native.rawSha256, provenance.rawSha256);
  assert.equal(provenance.recordedRuntimeSha256, '474c7c638fe93cc61f1a588849fb93c81a2927388f6f4cf19953b3a76e9deb26');
  for (const file of provenance.files) {
    const bytes = await readFile(new URL(file.path, fixtureRoot));
    assert.equal(bytes.length, file.bytes, file.path); assert.equal(hash(bytes), file.sha256, file.path);
  }
  for (const file of provenance.requiredInputs) {
    const bytes = await readFile(file.filename);
    assert.equal(bytes.length, file.bytes, file.filename); assert.equal(hash(bytes), file.sha256, file.filename);
  }
  for (const assembly of native.assemblies) {
    const bound = provenance.requiredInputs.find(file => file.filename === assembly.path.replaceAll('\\', '/'));
    assert.equal(bound?.sha256, assembly.sha256, `Actual loaded assembly ${assembly.name}`);
  }
  assert.ok(native.cases.every(sample => sample.columns.every(row => Object.keys(row).length === 72)));
  assert.ok(native.cases.filter(sample => sample.input.Fault).every(sample => sample.trace.filter(e => e.action === 'injected-fault').length === 1));
  assert.equal(reader.actualBaseItemRepositoryReader, true);
  assert.equal(reader.actualSqliteSource, true);
  const readerRecord = JSON.parse(await readFile(provenance.readerRecord.filename));
  assert.equal(provenance.readerOracleAssembly.sha256, readerRecord.oracleAssembly.sha256);
  assert.deepEqual(reader.results.map(value => [value.Name, value.virtualChildren]), [
    ['actual-persisted-aggregate', 0], ['folder-IsRoot-extra', 0], ['readonly-container-invalid-token', 0]]);
  for (const observed of reader.results) assert.deepEqual(JSON.parse(observed.serializedData).VirtualChildren, []);
  const recording = JSON.parse(await readFile(provenance.requiredInputs.find(file => file.filename.endsWith('/global-scan-native-4/record.json')).filename));
  const pinnedInputs = provenance.requiredInputs.find(file => file.filename.endsWith('/global-scan-native-4-inputs/before-pins.json'));
  assert.equal(nativeClock.recordedAt, recording.recordedAt);
  assert.equal(nativeClock.inputsPinnedAt, (await stat(pinnedInputs.filename)).mtime.toISOString());
});

function rewrite(value, context) {
  if (Array.isArray(value)) return value.map(entry => rewrite(entry, context));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewrite(entry, context)]));
  if (typeof value !== 'string') return typeof value === 'bigint' ? Number(value) : value;
  for (const [from, to] of [[context.programRoot, '$PROGRAM'], [context.mediaRoot, '$MEDIA']]) {
    value = value.replaceAll(from, to).replaceAll(from.replaceAll('\\', '/'), to);
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) return idKey(value);
  return value.replaceAll('\\', '/');
}

function columns(rows, context, { window } = {}) {
  return rows.filter(row => row.Type !== 'PLACEHOLDER').map(row => Object.fromEntries(tableDefinition('BaseItems').columns.map(column => {
    let value = row[column.name];
    if (value == null) return [column.name, null];
    if (column.name === 'Data') {
      const data = JSON.parse(value);
      if (data.DateLastSaved != null) {
        if (row.DateLastSaved == null) {
          assert.equal(dateText(data.DateLastSaved), '0001-01-01T00:00:00.0000000Z', 'An unsaved entity preserves its actual minimum Data clock.');
        } else {
          assert.equal(dateText(data.DateLastSaved), dateText(row.DateLastSaved), 'Data and SQL save clocks agree.');
          data.DateLastSaved = '$SAVE_CLOCK';
        }
      }
      if (row.Type === nativeType('AggregateFolder') && Object.hasOwn(data, 'VirtualChildren')) {
        assert.equal(deserializeNativeItemData(row.Type, value).VirtualChildren.length, 0,
          'The actual cold reader ignores the readonly serialized container, as the native reader probe proves.');
        for (const child of Array.isArray(data.VirtualChildren) ? data.VirtualChildren : []) if (child.DateLastSaved) {
          assert.ok(Number.isFinite(Date.parse(child.DateLastSaved)));
          if (window) assert.ok(Date.parse(child.DateLastSaved) >= window.start - 1000 && Date.parse(child.DateLastSaved) <= window.end + 1000,
            'Nested runtime save timestamp belongs to the candidate operation.');
        }
        data.VirtualChildren = [];
      }
      return [column.name, rewrite(data, context)];
    }
    if (column.clrType.includes('DateTime')) {
      const date = dateText(value);
      if (['DateCreated', 'DateLastSaved', 'DateLastRefreshed', 'DateModified'].includes(column.name)) {
        assert.ok(Number.isFinite(Date.parse(date)), column.name);
        if (window) assert.ok(Date.parse(date) >= window.start - 1000 && Date.parse(date) <= window.end + 1000,
          `${column.name} belongs to the actual candidate operation window: ${date}`);
        return [column.name, '$' + column.name.toUpperCase() + '_CLOCK'];
      }
      return [column.name, date];
    }
    if (column.name === 'Path' && context.expandPath) {
      const expanded = context.expandPath(value);
      assert.equal(context.reversePath(expanded), value, 'Persistent path is exactly the real reverse-path mapping of its expanded read.');
      value = expanded;
    }
    if (column.clrType.replace('?', '') === 'bool') value = Boolean(value);
    return [column.name, rewrite(value, context)];
  }))).sort((a, b) => a.Id.localeCompare(b.Id));
}

async function setup(t, sample) {
  const programRoot = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-global-scan-'));
  let database = await createPostgresTestDatabase(null, 'global_scan', { max: 1 });
  const storage = new StorageRegistry();
  let runtime;
  t.after(async () => {
    const errors = [];
    for (const close of [() => runtime?.close(), () => storage.close(), () => dropPostgresTestDatabase(database), async () => {
      assert.equal(path.dirname(path.resolve(programRoot)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(programRoot).startsWith('mediamanager-global-scan-'));
      await rm(programRoot, { recursive: true, force: true });
    }]) try { await close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Global fixture cleanup failed.');
  });
  const toIdentity = relative => path.win32.join(sample.nativeMediaRoot, relative);
  const relativeIdentity = filename => filename == null ? null : filename.startsWith(sample.nativeMediaRoot)
    ? 'media/' + path.win32.relative(sample.nativeMediaRoot, filename).replaceAll('\\', '/')
    : filename.startsWith(programRoot) ? 'program/' + path.relative(programRoot, filename).replaceAll('\\', '/') : filename;
  storage.registerType('memory', options => new MemoryStorageAdapter(options));
  const adapter = await storage.createInstance('global-media', 'memory', { pageSize: 32 });
  const vfs = new VirtualFileSystem(storage);
  vfs.mount({ path: '/global-media', instanceId: 'global-media', capabilities: {} });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: sample.nativeMediaRoot, accessRoot: '/global-media', style: 'windows', returnAccess: 'Actual global scan differential fixture' });
  const createDirectory = async relative => {
    let current = '';
    for (const part of relative.replaceAll('\\', '/').split('/').filter(Boolean)) {
      current += '/' + part;
      try { await adapter.mkdir(current); } catch (error) { if (error.code !== 'already-exists') throw error; }
    }
  };
  for (const directory of sample.input.Warmup ? sample.input.InitialDirectories : sample.input.Directories) await createDirectory(directory);
  for (const library of sample.input.Libraries) {
    const libraryPath = path.join(programRoot, 'root', 'default', library.Name);
    await mkdir(libraryPath, { recursive: true });
    for (const [index, relative] of library.Locations.entries()) {
      await createDirectory(relative);
      await writeFile(path.join(libraryPath, `location-${String(index).padStart(2, '0')}.mblink`), toIdentity(relative));
    }
    if (library.CollectionType) await writeFile(path.join(libraryPath, library.CollectionType + '.collection'), '');
    await writeFile(path.join(libraryPath, 'options.xml'), '<LibraryOptions><SaveLocalMetadata>false</SaveLocalMetadata><EnablePhotos>true</EnablePhotos></LibraryOptions>');
  }
  const ignoreIdentityMap = await knownAncestorIgnoreIdentityMap({ registry: storage, vfs, identityMap, identityRoots: [sample.nativeMediaRoot] });
  const errors = [], trace = [], controller = new AbortController();
  let observing = false, faults = 0;
  const add = (action, detail) => { if (observing) trace.push({ action, detail }); };
  const runtimeOptions = { vfs, identityMap, ignoreIdentityMap, programDataPath: programRoot,
    configuration: { UICulture: 'en-US', MetadataCountryCode: 'US', IsStartupWizardCompleted: true, EnableCaseSensitiveItemIds: true, LibraryScanFanoutConcurrency: 1 },
    serverId: 'global-scan-oracle', onError: error => errors.push(error) };
  runtime = await createRuntime({ ...runtimeOptions, database });
  const fault = (kind, filename) => {
    const requested = sample.input.Fault;
    if (!observing || requested?.Kind !== kind || filename !== toIdentity(requested.Path)) return;
    if (++faults !== (requested.AtOccurrence ?? 1)) return;
    add('injected-fault', { kind, path: relativeIdentity(filename) });
    throw Object.assign(new StorageError('io', 'Controlled ' + kind + ' failure'), { nativeException: 'IOException' });
  };
  const listPage = adapter.listPage.bind(adapter);
  adapter.listPage = async (relative, options) => {
    fault('enumeration', toIdentity(relative.replace(/^\//u, '')));
    return listPage(relative, options);
  };
  const saveItems = runtime.itemCreation.saveItems.bind(runtime.itemCreation);
  runtime.itemCreation.saveItems = async (items, options) => {
    for (const item of items) fault('save-before', item.Path);
    const result = await saveItems(items, options);
    add('save-committed', { items: items.map(item => ({ path: relativeIdentity(item.Path), type: item.NativeType })) });
    return result;
  };
  const refresh = runtime.metadata.refresh.bind(runtime.metadata);
  runtime.metadata.refresh = async (reference, options) => {
    const id = typeof reference === 'string' ? reference : reference.Id;
    const targetPath = sample.input.Fault?.Kind === 'metadata-after' ? toIdentity(sample.input.Fault.Path) : null;
    const targetId = targetPath && getNewItemId(targetPath, nativeType('Folder'), { programDataPath: programRoot, enableCaseSensitiveItemIds: true });
    add('metadata-begin', { id });
    const result = await refresh(reference, options);
    add('metadata-completed', { id });
    if (targetId && idKey(targetId) === idKey(id)) fault('metadata-after', targetPath); return result;
  };
  runtime.libraryMonitor.stop = async () => add('monitor-Stop');
  runtime.libraryMonitor.start = async () => add('monitor-Start');
  runtime.libraryScanLifecycle.postScanTasks.splice(0, runtime.libraryScanLifecycle.postScanTasks.length,
    ...['A', 'B'].map(name => ({ name, async run({ signal, reportProgress }) {
      add('post-task-begin', { name }); signal?.throwIfAborted(); reportProgress(25); reportProgress(100); add('post-task-end', { name });
    } })));
  const inherited = runtime.libraryScanHost.updateInheritedValues.bind(runtime.libraryScanHost);
  runtime.libraryScanHost.updateInheritedValues = async () => {
    add('inherited-cleanup-begin'); await inherited(); add('inherited-cleanup-committed');
  };
  runtime.refreshes.on('RefreshProgress', ({ Item, Progress }) => {
    add('provider-OnRefreshProgress', { path: relativeIdentity(Item.Path), progress: Progress });
    const cancel = sample.input.Cancel;
    if (observing && cancel?.Channel === 'provider' && cancel.Progress === Progress
      && (cancel.Path === '@aggregate' ? Item.NativeType === nativeType('AggregateFolder') : Item.Path === toIdentity(cancel.Path))) controller.abort();
  });
  const run = async active => {
    observing = active;
    if (active && sample.input.Cancel?.Channel === 'initial') controller.abort();
    let exception = null;
    try { await runtime.libraryScanLifecycle.run({ signal: active ? controller.signal : undefined,
      reportProgress: value => {
        add('global-progress', { progress: value });
        if (active && sample.input.Cancel?.Channel === 'global' && value === sample.input.Cancel.Progress) controller.abort();
      } }); } catch (error) { exception = error; }
    observing = false; return exception;
  };
  if (sample.input.Warmup) {
    const failure = await run(false); assert.equal(failure, null, 'The real baseline scan must succeed.');
    for (const directory of sample.input.Directories) await createDirectory(directory);
  }
  return { runtime, database, run: () => run(true), trace, errors, faults: () => faults, programRoot,
    async restart() {
      const schema = database.schemaName;
      await runtime.close();
      database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, max: 1 });
      runtime = await createRuntime({ ...runtimeOptions, database });
      return { runtime, database };
    },
    context: { programRoot, mediaRoot: sample.nativeMediaRoot, expandPath: runtime.library.options.expandPath,
      reversePath: createVirtualPathReverser(runtime.library.options) } };
}

for (const sample of native.cases) test(`postgres: actual global scan ${sample.name}`, pg, async t => {
  const start = Date.now();
  const f = await setup(t, sample);
  const exception = await f.run();
  const end = Date.now();
  assert.equal(exception == null ? null : ['AbortError', 'cancelled'].includes(exception.name) || exception.code === 'cancelled' ? 'cancelled' : exception.code ?? exception.name,
    sample.exception == null ? null : sample.exception.includes('OperationCanceledException') ? 'cancelled' : sample.exception, exception?.stack);
  assert.equal(f.runtime.libraryScanLifecycle.isScanRunning, sample.scanRunning);
  assert.deepEqual(f.trace.filter(e => ['monitor-Stop', 'monitor-Start', 'post-task-begin', 'post-task-end', 'inherited-cleanup-begin', 'inherited-cleanup-committed'].includes(e.action))
    .map(e => [e.action, e.detail?.name ?? null]), sample.trace.filter(e => ['monitor-Stop', 'monitor-Start', 'post-task-begin', 'post-task-end', 'inherited-cleanup-begin', 'inherited-cleanup-committed'].includes(e.action))
    .map(e => [e.action, e.detail?.name ?? null]));
  assert.equal(f.trace.filter(event => event.action === 'injected-fault').length, sample.input.Fault ? 1 : 0, 'Named fault actually executes once.');
  const rows = await f.database.rows('BaseItems');
  const playlist = rows.find(row => row.Type.endsWith('.PlaylistsFolder'));
  const sourceDirectory = await stat(path.join(f.programRoot, 'data', 'playlists'), { bigint: true });
  assert.equal(dateText(playlist.DateCreated), dateText(nativeDateFromUnixNanoseconds(sourceDirectory.birthtimeNs)));
  assert.equal(dateText(playlist.DateModified), dateText(nativeDateFromUnixNanoseconds(sourceDirectory.mtimeNs)));
  assert.deepEqual(columns(rows, f.context, { window: { start, end } }), columns(sample.columns,
    { programRoot: sample.nativeProgramDataPath, mediaRoot: sample.nativeMediaRoot },
    { window: { start: Date.parse(nativeClock.inputsPinnedAt), end: Date.parse(nativeClock.recordedAt) } }));
  for (const [table, expected] of Object.entries(sample.relations)) {
    const actual = await f.database.rows(table);
    const key = row => JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)));
    const canonical = entries => entries.map(row => rewrite(row, f.context)).sort((a, b) => key(a).localeCompare(key(b)));
    assert.deepEqual(canonical(actual), canonical(expected), table);
  }
  const aggregate = sample.trace.filter(e => e.action === 'provider-OnRefreshProgress' && e.detail.item.path === 'program/root').map(e => e.detail.progress);
  const actualAggregate = f.trace.filter(e => e.action === 'provider-OnRefreshProgress' && e.detail.path === 'program/root').map(e => e.detail.progress);
  assert.deepEqual(actualAggregate.filter(value => value <= 10), aggregate.filter(value => value <= 10), 'Raw native early provider phases stay distinct from global observer progress.');
  assert.equal(f.runtime.libraryScanner.capabilities.completeLibraryScan, true, 'The configured runtime admits the production library scan.');
});

for (const name of ['one-ordinary-directory-tree', 'deep-enumeration-after-baseline']) test(
  'postgres: actual cold root reload and export retarget ' + name, pg, async t => {
  const sample = native.cases.find(value => value.name === name);
  const f = await setup(t, sample);
  assert.equal(await f.run(), null);
  const before = await f.database.rows('BaseItems');
  const aggregate = before.find(row => row.Type === nativeType('AggregateFolder'));
  const playlist = before.find(row => row.Type.endsWith('.PlaylistsFolder'));
  const storedVirtual = JSON.parse(aggregate.Data).VirtualChildren;
  assert.equal(storedVirtual.length, 1);
  assert.equal(playlist.Path, createVirtualPathReverser(f.runtime.library.options)(path.join(f.programRoot, 'data', 'playlists')));
  const next = await f.restart();
  const cold = await next.runtime.itemCreation.getItemById(aggregate.Id);
  assert.equal(cold.VirtualChildren.length, reader.results[0].virtualChildren);
  const live = await next.runtime.libraryScanHost.getAggregateFolder();
  assert.equal(live.VirtualChildren.length, 1);
  assert.equal(live.VirtualChildren[0], await next.runtime.itemCreation.getItemById(playlist.Id));
  assert.equal(live.VirtualChildren[0].Path, path.join(f.programRoot, 'data', 'playlists'));
  assert.equal(live.VirtualChildren[0].NativeType, playlist.Type);
  const after = await next.database.rows('BaseItems');
  assert.deepEqual(after, before, 'Cold initialization and canonical reattachment do not rewrite persisted rows.');
  const sourceContract = { mounts: [{ mountId: 'global-media', identityRoot: sample.nativeMediaRoot,
    accessRoot: '/global-media', pathStyle: 'windows', caseSensitive: true, returnPolicy: 'required' }] };
  const targetContract = { mounts: [{ ...sourceContract.mounts[0], identityRoot: '/srv/global-scan-media', pathStyle: 'posix' }] };
  const projector = createSqliteExportPathProjector({ sourceContract, targetContract,
    instanceStatePaths: { programData: path.join(f.programRoot, 'data'), metadata: path.join(f.programRoot, 'metadata') } });
  const selfOwners = new Set(); let mediaLocations = 0;
  for (const row of await next.database.rows('BaseItems', { consumer: 'exchange' })) {
    const projected = projector.projectRow('BaseItems', row);
    const originalPath = row.Path?.string();
    if (originalPath?.startsWith(sample.nativeMediaRoot + '\\')) {
      assert.equal(projected.Path.string(), '/srv/global-scan-media/' + path.win32.relative(sample.nativeMediaRoot, originalPath).replaceAll('\\', '/'));
    } else if (idKey(row.Id) === idKey(playlist.Id)) {
      assert.equal(projected.Path.string(), playlist.Path, 'Real export retains the exact runtime instance-state placeholder.');
    }
    const type = row.Type?.string();
    const locations = row.Data == null ? [] : JSON.parse(row.Data.string()).PhysicalLocationsList ?? [];
    const projectedLocations = projected.Data == null ? [] : JSON.parse(projected.Data.string()).PhysicalLocationsList ?? [];
    for (const [index, location] of locations.entries()) {
      if ([nativeType('AggregateFolder'), nativeType('CollectionFolder')].includes(type) && location === originalPath) {
        assert.equal(projectedLocations[index], location, 'A native self-location remains an instance-state path.');
        selfOwners.add(type);
      } else if (location.startsWith(sample.nativeMediaRoot + '\\')) {
        assert.equal(projectedLocations[index], '/srv/global-scan-media/' + path.win32.relative(sample.nativeMediaRoot, location).replaceAll('\\', '/'));
        mediaLocations++;
      }
    }
  }
  assert.ok(selfOwners.has(nativeType('CollectionFolder')));
  assert.equal(selfOwners.has(nativeType('AggregateFolder')), Boolean(sample.input.Warmup), 'The actual warmup root carries its native self-location.');
  assert.ok(mediaLocations > 0, 'The source Data media locations actually exercise explicit retargeting.');
  assert.deepEqual(await next.database.rows('BaseItems'), after, 'The export projection does not mutate the actual PostgreSQL source.');
});
