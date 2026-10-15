import { testFileSystem } from './plugin-files.js';
import { openMetadataRelations, trackMetadataContexts, attachMetadataItemCreation, closeMetadataFixture, removeMetadataTestRoot } from '../metadata/relations-fixture.js';
import { validationExecutable } from '../../tools/validation/paths.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import samples from './fixtures/probe-lifecycle/native.json' with { type: 'json' };
import selection from './fixtures/probe-lifecycle/selection.json' with { type: 'json' };
import { ProbeService } from '../../src/library/probe-service.js';
import { missingProbeInfo, probeFetchDecision, probeFileProtocol, probeFileChanged } from '../../src/storage/probe-lifecycle.js';
import { externalCandidates } from '../../src/storage/external-streams.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { LibraryService } from '../../src/library/library-service.js';
import { dateTicks, MIN_DATE } from '../../src/library/records.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { MetadataRefreshHost } from '../../src/metadata/refresh-host.js';
import { MetadataRegistry } from '../../src/metadata/registry.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { exportCurrentSqlite, transferDatabase } from '../../src/migration/database-transfer.js';
import { probeRaw } from '../../src/storage/ffprobe.js';
import { createApplication } from '../../src/http/application.js';

const id = '71717171-7171-7171-7171-717171717171';
const identity = 'Z:\\media\\sample.wav';
const date = '2026-09-26T00:00:00.0000000Z';
function wave(samples = 800) {
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}

test('RFC3339 AList timestamps preserve native 100 ns change threshold across offsets', () => {
  const item = { DateModified: date };
  assert.equal(probeFileChanged(item, '2026-09-26T08:00:01.000000099+08:00'), false);
  assert.equal(probeFileChanged(item, '2026-09-26T08:00:01.000000100+08:00'), true);
  assert.equal(probeFileChanged(item, '2026-09-25T23:00:00.999999900-01:00'), false);
});

test('probe change detection, early fetch gates and lyric discovery match actual native methods', async t => {
  for (const { input, expected } of samples) await t.test(input.name, async () => {
    const item = { ...input.item, Id: id, IsFileProtocol: probeFileProtocol(input.item), SupportsLocalMetadata: probeFileProtocol(input.item) && input.item.SourceType !== 'Channel' };
    const vfs = {
      async stat() { if (input.modified == null) throw Object.assign(new Error('Missing fixture file'), { code: 'not-found' }); return { kind: 'file', modified: input.modified }; },
      async list(directory) { return { entries: (directory === '/metadata' ? input.internalFiles ?? [] : input.files ?? []).map(file => ({ name: path.win32.basename(file), kind: 'file' })) }; },
    };
    const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: 'Z:\\media', accessRoot: '/media', style: 'windows', returnAccess: 'Synthetic fixture mapped only during isolated tests' });
    const service = new ProbeService({ store: {}, vfs, identityMap, bridge: {} });
    const loaded = { item, context: { accessPath: '/media/' + path.win32.basename(item.Path), externalStreamDirectories: input.internalFiles ? [{ identityPath: 'Z:\\metadata', virtualPath: '/metadata' }] : [] } };
    assert.equal(await service.hasChanged(loaded), expected.changed);
    assert.equal(missingProbeInfo(item), expected.missing);
    assert.equal(probeFetchDecision(item, { EnableRemoteContentProbe: input.remote }) == null ? 'ProberBoundary' : 'None', expected.gate);
    if (expected.lyricStreams != null) {
      const candidates = await externalCandidates(vfs, loaded.context.accessPath, item.Path, { types: ['Lyric'], additionalDirectories: loaded.context.externalStreamDirectories });
      assert.deepEqual(candidates.map((entry, index) => ({ Type: 'Lyric', Path: entry.identityPath, Language: entry.parsed.Language, Index: index + 3, IsExternal: false })), expected.lyricStreams);
    }
    await service.close();
  });
});

async function fixture(t, backend = 'postgres', probe) {
  const schema = `probe_lifecycle_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  let database, source, store, adapters, library, linkedChildren, itemCreation, service, host, directory;
  const contextLoaders = [];
  t.after(async () => {
    await closeMetadataFixture({ library, itemCreation, linkedChildren, contexts: contextLoaders,
      before: [() => host?.close(), () => service?.close?.()],
      after: [() => adapters?.close(),
        () => database?.client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`),
        () => database?.client.query(`DROP SCHEMA IF EXISTS "${schema}__mm" CASCADE`),
        () => store ? store.close() : database?.close(),
        () => directory && removeMetadataTestRoot(directory, 'probe-lifecycle-state-')] });
  });
  source = new SqliteDatabase(':memory:', { create: true });
  const record = Object.fromEntries(tableDefinition('BaseItems').columns.map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false : '']));
  await source.insert('BaseItems', { ...record, Id: id, Name: 'Locked fixture title', Path: identity, MediaType: 'Audio', Type: 'MediaBrowser.Controller.Entities.Audio.Audio',
    DateModified: date, DateLastRefreshed: date, Data: '{"UnknownExtension":{"precise":9007199254740993}}' });
  database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  try {
    await transferDatabase(source, database, { instanceBinding: { serverId: id.replaceAll('-', ''),
      originIdentityDigest: createHash('sha256').update('Isolated synthetic probe lifecycle source').digest('hex') } });
  } finally { source.close(); }
  adapters = new StorageRegistry(); adapters.registerType('fixture', () => new MemoryStorageAdapter());
  await adapters.createInstance('fixture', 'fixture', {});
  const vfs = new VirtualFileSystem(adapters); vfs.mount({ path: '/media', instanceId: 'fixture', root: '/', capabilities: { create: true, replace: true, delete: true } });
  const adapter = { write: (name, bytes) => vfs.write('/media' + name, bytes), delete: name => vfs.delete('/media' + name) };
  await adapter.write('/sample.wav', wave());
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: 'Z:\\media', accessRoot: '/media', style: 'windows', returnAccess: 'Synthetic fixture mapped only during isolated tests' });
  directory = await mkdtemp(path.join(os.tmpdir(), 'probe-lifecycle-state-'));
  const spoolRoot = path.join(directory, 'metadata-spool');
  linkedChildren = await openMetadataRelations(database, spoolRoot);
  store = new DomainStore(database);
  library = new LibraryService({fileSystem: testFileSystem,  store, linkedChildren, serverId: 'fixture', programDataPath: directory });
  const loadContext = trackMetadataContexts(createMetadataContextLoader({fileSystem: testFileSystem,  store, library, linkedChildren, spoolRoot, vfs, identityMap }), contextLoaders);
  itemCreation = attachMetadataItemCreation({ store, library, linkedChildren, loadContext });
  service = probe ?? new ProbeService({ store, vfs, identityMap, loadContext, library });
  const registry = new MetadataRegistry();
  host = new MetadataRefreshHost({ registry, store, linkedChildren, vfs, loadContext, probe: service, now: () => date });
  host.updates.library = library;

  return { database, store, adapter, service, registry, host, loadContext, library };
}

test('refresh host provider selection follows 90 actual MetadataService.GetProviders results', async t => {
  let current, checks = [], fetched = [];
  const monitor = name => { checks.push(name); if (current.change === 'failure') throw new Error('Isolated change-monitor failure'); return current.change.split(',').includes(name); };
  const probe = { supportsMetadata: () => true, hasChanged: async () => monitor('probe'), refreshMetadata: async () => { fetched.push('probe'); return { UpdateType: 1, changed: false }; } };
  const state = await fixture(t, 'postgres', probe);
  await state.database.update('BaseItems', { Id: id }, { MediaType: 'Video', Type: 'MediaBrowser.Controller.Entities.Movies.Movie', RunTimeTicks: 1n });
  for (const kind of ['local', 'remote']) state.registry.register({ id: kind, name: kind, providers: [{ id: kind, name: kind, kind, itemTypes: ['Movie'], hasChanged: () => monitor(kind),
    async getMetadata() { fetched.push(kind); return { HasMetadata: false }; } }] });
  const load = state.host.loadContext;
  const controlledLoad = Object.assign(async (...args) => { const loaded = await load(...args); loaded.libraryOptions.AutomaticRefreshIntervalDays = current.flag === 'requires' ? 1 : 0; return loaded; }, load);
  controlledLoad.withContext = async (reference, options, operation) => {
    const loaded = await controlledLoad(reference, options);
    try { return await operation(loaded); } finally { await loaded.dispose(); }
  };
  state.host.loadContext = controlledLoad;
  state.host.now = () => '2026-09-28T00:00:00Z';
  for (const sample of selection) await t.test(`${sample.mode}/${sample.flag}/${sample.change}`, async () => {
    current = sample; checks = []; fetched = [];
    // The native selection oracle creates a fresh Movie for each row. Previous
    // saves retain a live cache entry, so reload the actual repository fixture.
    state.library.itemCreation.unregisterItem(id);
    await state.library.options.linkedChildren.flushReleases();
    const expectedLastRefresh = sample.flag === 'first' ? MIN_DATE : date;
    await state.database.update('BaseItems', { Id: id }, { DateLastRefreshed: expectedLastRefresh });
    await state.library.itemCreation.withItem(id, item => {
      assert.equal(dateTicks(item.DateLastRefreshed), dateTicks(expectedLastRefresh));
    });
    await state.host.refresh(id, { MetadataRefreshMode: sample.mode, ImageRefreshMode: 'None', ReplaceAllMetadata: sample.flag === 'replace', ForceSave: sample.flag === 'force' });
    assert.deepEqual(checks.toSorted(), sample.checks.toSorted());
    const expected = sample.selected.filter(name => name !== 'remote' || sample.mode !== 'ValidationOnly' || sample.flag === 'replace').sort((a, b) => Number(b === 'probe') - Number(a === 'probe'));
    assert.deepEqual(fetched, expected);
  });
});

test('real ffprobe refresh lifecycle, lyrics, locks and native SQLite return on PostgreSQL', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || spawnSync(validationExecutable('ffprobe'), ['-version'], { windowsHide: true }).status !== 0,
}, async t => {
  const backend = 'postgres';
  const state = await fixture(t, backend);
  let probes = 0; state.service.probe = async (...args) => { probes++; return probeRaw(...args); };
  await state.adapter.write('/sample.en.lrc', Buffer.from('[00:00.00]Isolated lyric'));
  await state.host.refresh(id, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None', ForceSave: true });
  assert.equal(probes, 0); assert.equal((await state.database.rows('MediaStreamInfos')).length, 0);
  assert.equal(await state.loadContext.withContext(id, {}, loaded => state.service.hasChanged(loaded)), true);
  const firstRefresh = await state.host.refresh(id, { MetadataRefreshMode: 'ValidationOnly', ImageRefreshMode: 'None' });
  assert.equal(firstRefresh.Failures, 0, firstRefresh.ErrorMessage);
  assert.equal(probes, 1);
  let row = (await state.database.rows('BaseItems'))[0];
  assert.equal(row.RunTimeTicks, 1000000n); assert.deepEqual(JSON.parse(row.Data).LyricFiles, ['Z:\\media\\sample.en.lrc']); assert.equal(JSON.parse(row.Data).HasLyrics, true);
  let streams = await state.database.rows('MediaStreamInfos');
  assert.deepEqual(streams.filter(stream => stream.StreamType === 5).map(stream => [stream.StreamIndex, stream.Path, stream.Language, stream.IsExternal]), [[1, 'Z:\\media\\sample.en.lrc', 'eng', false]]);
  await state.host.refresh(id, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' }); assert.equal(probes, 1);
  await state.adapter.write('/sample.en.lrc', Buffer.from('[00:00.00]Changed lyric bytes, same discovered path'));
  await state.host.refresh(id, { MetadataRefreshMode: 'ValidationOnly', ImageRefreshMode: 'None' }); assert.equal(probes, 1);
  await state.adapter.write('/sample.txt', Buffer.from('Second external lyric'));
  await state.host.refresh(id, { MetadataRefreshMode: 'ValidationOnly', ImageRefreshMode: 'None' }); assert.equal(probes, 2);
  assert.equal((await state.database.rows('MediaStreamInfos')).filter(stream => stream.StreamType === 5).length, 1);
  assert.equal(JSON.parse((await state.database.rows('BaseItems'))[0].Data).LyricFiles.length, 2);
  await state.database.update('BaseItems', { Id: id }, { IsLocked: true }); await state.adapter.write('/sample.wav', wave(1600));
  await state.host.refresh(id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None', ReplaceAllMetadata: true }); assert.equal(probes, 3);
  row = (await state.database.rows('BaseItems'))[0]; streams = await state.database.rows('MediaStreamInfos');
  assert.equal(row.RunTimeTicks, 2000000n); assert.equal(row.Name, 'Locked fixture title');
  assert.equal(Object.hasOwn(JSON.parse(row.Data), 'UnknownExtension'), false, 'typed native JSON drops undeclared extension data');
  if (process.env.MEDIAMANAGER_PROBE_LIFECYCLE_EVIDENCE) {
    const directory = path.resolve(process.env.MEDIAMANAGER_PROBE_LIFECYCLE_EVIDENCE, backend); await mkdir(directory, { recursive: true });
    await exportCurrentSqlite(state.database, path.join(directory, 'with-lyrics.db'), { testOnlyAllowSyntheticEnvelope: true });
    await writeFile(path.join(directory, 'expected.json'), JSON.stringify({ item: { Name: row.Name, Path: row.Path, IsLocked: row.IsLocked, RunTimeTicks: row.RunTimeTicks.toString(),
      Container: JSON.parse(row.Data).Container, LyricFiles: JSON.parse(row.Data).LyricFiles, HasLyrics: JSON.parse(row.Data).HasLyrics }, streams: streams.map(stream => ({ Index: stream.StreamIndex,
      Type: ['Audio', 'Video', 'Subtitle', 'EmbeddedImage', 'Data', 'Lyric'][stream.StreamType], Codec: stream.Codec, Path: stream.Path, Language: stream.Language, IsExternal: stream.IsExternal })) }, null, 2));
  }
  await state.adapter.delete('/sample.en.lrc'); await state.adapter.delete('/sample.txt');
  await state.host.refresh(id, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' }); assert.equal(probes, 4);
  assert.deepEqual(JSON.parse((await state.database.rows('BaseItems'))[0].Data).LyricFiles, []);
  assert.equal((await state.database.rows('MediaStreamInfos')).some(stream => stream.StreamType === 5), false);
  const temporary = !process.env.MEDIAMANAGER_PROBE_LIFECYCLE_EVIDENCE;
  const directory = temporary ? await mkdtemp(path.join(os.tmpdir(), 'probe-lifecycle-return-')) : path.resolve(process.env.MEDIAMANAGER_PROBE_LIFECYCLE_EVIDENCE, backend);
  await mkdir(directory, { recursive: true });
  try {
    await exportCurrentSqlite(state.database, path.join(directory, 'current.db'), { testOnlyAllowSyntheticEnvelope: true });
    const returned = new SqliteDatabase(path.join(directory, 'current.db'), { readOnly: true });
    try { assert.deepEqual(returned.rows('BaseItems'), await state.database.rows('BaseItems')); assert.deepEqual(returned.rows('MediaStreamInfos'), await state.database.rows('MediaStreamInfos')); }
    finally { await returned.close(); }
  } finally { if (temporary) await rm(directory, { recursive: true }); }
});

test('probe failure retains the native file-date save, later cancellation rolls back and refresh remains usable', async t => {
  const state = await fixture(t);
  // The correct native key isolates key changes. File-date metadata imports
  // remain independent of the probe transaction and survive probe failure.
  await state.database.update('BaseItems', { Id: id }, { PresentationUniqueKey: id.replaceAll('-', '').toLowerCase() });
  state.service.probe = async () => { throw new Error('Isolated probe failure'); };
  const failed = await state.host.refresh(id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
  assert.equal(failed.Failures, 1); assert.equal(failed.ErrorMessage, 'Isolated probe failure');
  assert.equal(failed.UpdateType, ItemUpdateType.None | ItemUpdateType.MetadataImport);
  const before = await state.database.rows('BaseItems');
  // The fixture file has no timestamp. Native FileSystemMetadata exposes
  // MinValue, so Audio BeforeSave independently imports the changed date.
  assert.equal(before[0].DateModified, null); assert.equal(before[0].DateLastSaved, '2026-09-26 00:00:00');
  assert.equal((await state.database.rows('BaseItems'))[0].RunTimeTicks, null); assert.deepEqual(await state.database.rows('MediaStreamInfos'), []);
  let started;
  const running = new Promise(resolve => { started = resolve; });
  state.service.probe = async (_bridge, _path, { signal }) => { started(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); };
  const controller = new AbortController();
  const refresh = state.host.refresh(id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None', signal: controller.signal });
  await running; controller.abort(); await assert.rejects(refresh, { name: 'AbortError' });
  assert.deepEqual(await state.database.rows('BaseItems'), before); assert.deepEqual(await state.database.rows('MediaStreamInfos'), []);
  state.service.probe = probeRaw;
  await state.host.refresh(id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
  assert.equal((await state.database.rows('BaseItems'))[0].RunTimeTicks, 1000000n);
});

test('metadata refresh reports one committed probe update on success and after a later cancellation', async t => {
  const state = await fixture(t);
  const events = [];
  state.library.on('ItemUpdated', event => events.push(event));
  state.service.probe = async () => ({ raw: {
    format: { duration: '1', size: '1644', format_name: 'wav' },
    streams: [{ index: 0, codec_type: 'audio', codec_name: 'pcm_s16le', channels: 1, sample_rate: '8000', bits_per_sample: 16 }]
  } });

  await state.host.refresh(id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
  assert.equal(events.length, 1, 'the final metadata update owns the successful notification');
  assert.equal(events[0].Item.Id, id);
  assert.equal((await state.database.rows('BaseItems', { where: { Id: id } }))[0].RunTimeTicks, 10000000n);

  events.length = 0;
  await state.adapter.write('/sample.wav', wave(1600));
  state.service.probe = async () => ({ raw: {
    format: { duration: '2', size: '3244', format_name: 'wav' },
    streams: [{ index: 0, codec_type: 'audio', codec_name: 'pcm_s16le', channels: 1, sample_rate: '8000', bits_per_sample: 16 }]
  } });
  const controller = new AbortController();
  const refreshMetadata = state.service.refreshMetadata.bind(state.service);
  state.service.refreshMetadata = async (...args) => {
    const result = await refreshMetadata(...args);
    controller.abort();
    return result;
  };
  await assert.rejects(state.host.refresh(id, {
    MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None', signal: controller.signal
  }), error => error.name === 'AbortError' || error.code === 'cancelled');
  assert.equal((await state.database.rows('BaseItems', { where: { Id: id } }))[0].RunTimeTicks, 20000000n,
    'the probe transaction committed before the later cancellation');
  assert.equal(events.length, 1, 'the committed probe falls back to its own update notification');
  assert.equal(events[0].Item.Id, id);
});

test('a failing probe fallback reporter cannot replace the final persistence error', async t => {
  const state = await fixture(t);
  const conflict = Object.assign(new Error('Injected final persistence conflict'), { status: 409 });
  const reportingFailure = new Error('Injected fallback reporting failure');
  const logged = [];
  let fallbackCalls = 0;
  state.host.logger = {
    error(error, message) {
      logged.push([error, message]);
      throw new Error('Injected logger failure');
    }
  };
  state.host.probe = {
    supportsMetadata: () => true,
    async refreshMetadata(_loaded, _options, { onCommitted }) {
      onCommitted(() => { fallbackCalls++; throw reportingFailure; });
      return { changed: true, UpdateType: 2 };
    }
  };
  state.host.updates.update = async () => { throw conflict; };

  await assert.rejects(state.host.refresh(id, {
    MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None'
  }), error => error === conflict);
  assert.equal(fallbackCalls, 1);
  assert.deepEqual(logged, [[reportingFailure, 'Error reporting committed probe update']]);
});

test('cancelling a queued probe waiter is prompt and does not cancel the shared owner or later waiter', async t => {
  const state = await fixture(t);
  let started, release;
  const ownerStarted = new Promise(resolve => { started = resolve; });
  const ownerRelease = new Promise(resolve => { release = resolve; });
  let probes = 0;
  state.service.probe = async () => {
    probes++;
    started();
    await ownerRelease;
    return { raw: { format: { duration: '1', size: '1644', format_name: 'wav' }, streams: [{ index: 0, codec_type: 'audio', codec_name: 'pcm_s16le', channels: 1, sample_rate: '8000', bits_per_sample: 16 }] } };
  };
  const owner = state.service.refresh(id, { force: true });
  await ownerStarted;
  const controller = new AbortController();
  const cancelled = state.service.refresh(id, { force: true, signal: controller.signal });
  const later = state.service.refresh(id);
  controller.abort();
  let timeout;
  const outcome = await Promise.race([
    cancelled.then(() => 'resolved', error => error.code),
    new Promise(resolve => { timeout = setTimeout(resolve, 500, 'timeout'); timeout.unref(); }),
  ]);
  clearTimeout(timeout);
  release();
  const [ownerResult, laterResult] = await Promise.all([owner, later]);
  assert.equal(outcome, 'cancelled');
  assert.equal(ownerResult.changed, true);
  assert.equal(laterResult.reason, 'unchanged-version');
  assert.equal(probes, 1);
});

test('probe shutdown cancels active and queued refreshes before persistence', async t => {
  const state = await fixture(t);
  const before = await state.database.rows('BaseItems');
  let started; const running = new Promise(resolve => { started = resolve; });
  state.service.probe = async (_bridge, _path, { signal }) => { started(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); };
  const first = state.service.refresh(id), second = state.service.refresh(id);
  const settled = Promise.allSettled([first, second]);
  await running; await state.service.close();
  for (const result of await settled) { assert.equal(result.status, 'rejected'); assert.match(result.reason.name, /Abort|Storage/u); }
  assert.deepEqual(await state.database.rows('BaseItems'), before); assert.deepEqual(await state.database.rows('MediaStreamInfos'), []);
  await assert.rejects(state.service.refresh(id), { name: 'AbortError' });
});

test('queued Refresh HTTP drives real VFS probe lifecycle on PostgreSQL', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || spawnSync(validationExecutable('ffprobe'), ['-version'], { windowsHide: true }).status !== 0,
}, async t => {
  const state = await fixture(t), errors = [];
  let probes = 0; state.service.probe = async (...args) => { probes++; return probeRaw(...args); };
  const application = await createApplication({ configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, library: state.library, metadata: state.host,
    authentication: { authenticate: async () => ({ IsAuthenticated: true, IsAdministrator: true }), authorize(_auth, { policy }) { assert.equal(policy, 'RequiresElevation'); } }, onError: error => errors.push(error) });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${application.server.address().port}`;
  try {
    for (const [mode, expectedProbes] of [['None', 0], ['FullRefresh', 1], ['Default', 1], ['ValidationOnly', 2]]) {
      if (mode === 'ValidationOnly') await state.adapter.write('/sample.en.lrc', Buffer.from('[00:00.00]HTTP fixture lyric'));
      const response = await fetch(`${origin}/Items/${id.replaceAll('-', '')}/Refresh?metadataRefreshMode=${mode}`, { method: 'POST' });
      assert.equal(response.status, 204, await response.text()); await state.host.drain(); assert.equal(probes, expectedProbes, mode);
    }
    const streams = await state.database.rows('MediaStreamInfos'); assert.equal(streams.length, 2); assert.equal(streams.find(row => row.StreamType === 5).Language, 'eng');
    assert.deepEqual(errors, []);
  } finally { await new Promise(resolve => application.server.close(resolve)); }
});

async function observeProbeContextRelease(state, { cleanupFailure = false } = {}) {
  const load = state.service.loadContext;
  const releases = [];
  state.service.loadContext = Object.assign(async (...args) => {
    const loaded = await load(...args), dispose = loaded.dispose.bind(loaded);
    loaded.dispose = async () => {
      await dispose(); releases.push(loaded.item.Id);
      if (cleanupFailure) await state.database.client.query('SELECT 1/0');
    };
    return loaded;
  }, load);
  const sets = () => state.library.options.linkedChildren.relationDatabase.withConnection(async database =>
    BigInt((await database.client.query('SELECT count(*)::text AS count FROM ' + state.library.options.linkedChildren.sets)).rows[0].count));
  return { releases, sets };
}

const releasedProbeInfo = () => ({ raw: {
  format: { duration: '1', size: '1644', format_name: 'wav' },
  streams: [{ index: 0, codec_type: 'audio', codec_name: 'pcm_s16le', channels: 1, sample_rate: '8000', bits_per_sample: 16 }]
} });

test('direct probe closes an actual Folder context before its not-probeable early return', async t => {
  const state = await fixture(t), ownership = await observeProbeContextRelease(state);
  await state.database.update('BaseItems', { Id: id }, { Type: 'MediaBrowser.Controller.Entities.Folder', IsFolder: true });
  const before = await ownership.sets();
  assert.deepEqual(await state.service.refresh(id, { force: true }), { changed: false, reason: 'not-probeable' });
  assert.deepEqual(ownership.releases, [id]);
  assert.equal(await ownership.sets(), before);
});

test('direct probe closes its native-fields-present context without invoking the prober', async t => {
  const state = await fixture(t), ownership = await observeProbeContextRelease(state);
  await state.database.update('BaseItems', { Id: id }, { RunTimeTicks: 1n, TotalBitrate: 1 });
  state.service.probe = async () => { throw new Error('Native fields should skip probing.'); };
  assert.deepEqual(await state.service.refresh(id), { changed: false, reason: 'native-fields-present' });
  assert.deepEqual(ownership.releases, [id]);
});

test('direct probe success and its cached early return each release their operation context', async t => {
  const state = await fixture(t), ownership = await observeProbeContextRelease(state), before = await ownership.sets();
  let probes = 0;
  state.service.probe = async () => { probes++; return releasedProbeInfo(); };
  assert.equal((await state.service.refresh(id, { force: true })).changed, true);
  assert.equal((await state.service.refresh(id)).reason, 'unchanged-version');
  assert.equal(probes, 1);
  assert.deepEqual(ownership.releases, [id, id]);
  assert.equal(await ownership.sets(), before);
  assert.equal((await state.database.rows('BaseItems', { where: { Id: id } }))[0].RunTimeTicks, 10000000n);
});

test('direct probe preserves a failure identity while releasing its operation context', async t => {
  const state = await fixture(t), ownership = await observeProbeContextRelease(state), before = await ownership.sets();
  const failure = new Error('Exact direct probe failure.');
  state.service.probe = async () => { throw failure; };
  await assert.rejects(state.service.refresh(id, { force: true }), error => error === failure);
  assert.deepEqual(ownership.releases, [id]);
  assert.equal(await ownership.sets(), before);
});

test('direct probe retains its primary failure and the actual SQL cleanup failure', async t => {
  const state = await fixture(t), ownership = await observeProbeContextRelease(state, { cleanupFailure: true }), before = await ownership.sets();
  const failure = new Error('Primary direct probe failure.');
  state.service.probe = async () => { throw failure; };
  await assert.rejects(state.service.refresh(id, { force: true }), error => error instanceof AggregateError &&
    error.cause === failure && error.errors.length === 2 && error.errors[0] === failure && error.errors[1].code === '22012');
  assert.deepEqual(ownership.releases, [id]);
  assert.equal(await ownership.sets(), before);
});

test('direct probe propagates a cleanup failure after retaining its committed success', async t => {
  const state = await fixture(t), ownership = await observeProbeContextRelease(state, { cleanupFailure: true }), before = await ownership.sets();
  state.service.probe = async () => releasedProbeInfo();
  await assert.rejects(state.service.refresh(id, { force: true }), { code: '22012' });
  assert.deepEqual(ownership.releases, [id]);
  assert.equal(await ownership.sets(), before);
  assert.equal((await state.database.rows('BaseItems', { where: { Id: id } }))[0].RunTimeTicks, 10000000n);
});
