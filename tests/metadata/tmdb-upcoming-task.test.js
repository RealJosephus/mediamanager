import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { TmdbUpcomingEpisodesMaintenance } from '../../plugins/tmdb/upcoming-episodes.js';
import { tmdbConfiguration } from '../../plugins/tmdb/configuration.js';
import { idKey } from '../../src/library/records.js';
import { LibraryService } from '../../src/library/library-service.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { defaultTmdbUpcomingEpisodesTaskTriggers, tmdbUpcomingEpisodesTaskDescription,
  tmdbUpcomingEpisodesTaskId, tmdbUpcomingEpisodesTaskKey, tmdbUpcomingEpisodesTaskName } from '../../plugins/tmdb/task.js';
import { scheduledTaskFilename } from '../../src/tasks/scheduled-task-store.js';

const nativeBytes = await readFile(new URL('./fixtures/tmdb-upcoming-task/native.json', import.meta.url));
const native = JSON.parse(nativeBytes);
const provenance = JSON.parse(await readFile(new URL('./fixtures/tmdb-upcoming-task/provenance.json', import.meta.url)));
assert.equal(createHash('sha256').update(nativeBytes).digest('hex'), provenance.nativeSha256);
for (const filename of ['Oracle.cs', 'Oracle.csproj', 'README.md']) {
  assert.equal(createHash('sha256').update(await readFile(new URL(`./fixtures/tmdb-upcoming-task/${filename}`, import.meta.url)))
    .digest('hex'), provenance.oracleFiles[filename]);
}
assert.equal(provenance.jellyfinCommit, '208c278b75abd897aefa1e1175126eac5e4dbfaa');
assert.equal(provenance.jellyfinTaskSourceSha256, '34dfe0041b4be1aa72c112683d54330110c60de82ed9a1fdb59ea2629eef8f00');
assert.equal(provenance.nativeSha256, '5634de6cf37451ae6a8fb05e3a577825cabf6a87cea3bfc9504b998d11b4c2de');
assert.equal(provenance.recordedNativeSha256, 'eb391bca737d03e76c68bf78c78c98d7691bedff2b60cb5692a007f68c1c8141');
assert.equal(provenance.sourceFilesSha256, '83faee8715be57b744b9d3873d71ee77e233da540107fe0ac7e6ac37f785e42f');
assert.equal(provenance.mediaBrowserProvidersAssemblySha256, '1afa73573e3bda071db199cf76b4a3e1ca62381eef3a0d3311bca56cb68f2423');
assert.equal(provenance.oracleAssemblySha256, 'e9f76fb8cfac87fa9414db37e8b1b63b6b02f6f90e1aae25df790ca281c09ede');
assert.equal(provenance.oracleRecord,
  'D:/mediamanager-validation/20261005/results/tmdb-upcoming-task-oracle-20261008-v2/record.json');
assert.equal(native.assembly.sha256, provenance.mediaBrowserProvidersAssemblySha256);
assert.equal(native.phaseAcceptance, false);

const blank = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated)
  .map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false
    : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));

async function libraryFixture(store, database, serverId) {
  const linkedChildren = new PostgresLinkedChildrenStore({ database });
  await linkedChildren.initialize();
  const library = new LibraryService({fileSystem: testFileSystem,  store, linkedChildren, serverId, configuration: {} });
  const loadContext = createMetadataContextLoader({fileSystem: testFileSystem,  store, library, linkedChildren });
  const itemCreation = new ItemCreationService({ store, library, loadContext, linkedChildren });
  library.itemCreation = itemCreation;
  return { library, async close() {
    await itemCreation.close();
    await library.close();
    await linkedChildren.close();
  } };
}

test('TMDB scheduled task identity, text and configured interval match the native task contract', () => {
  assert.equal(tmdbUpcomingEpisodesTaskId, native.id);
  assert.equal(tmdbUpcomingEpisodesTaskKey, native.Key);
  assert.equal(tmdbUpcomingEpisodesTaskName, native.Name);
  assert.equal(tmdbUpcomingEpisodesTaskDescription, native.Description);
  assert.deepEqual(defaultTmdbUpcomingEpisodesTaskTriggers({ MissingEpisodeRefreshIntervalDays: 3 }), [
    { Type: 'IntervalTrigger', IntervalTicks: BigInt(native.intervals.find(value => value.days === 3).IntervalTicks) }
  ]);
  for (const days of [0, -1]) {
    const expected = native.intervals.find(value => value.days === days);
    assert.deepEqual(defaultTmdbUpcomingEpisodesTaskTriggers({ MissingEpisodeRefreshIntervalDays: days }), [
      { Type: 'IntervalTrigger', IntervalTicks: BigInt(expected.IntervalTicks) }
    ]);
  }
  assert.throws(() => defaultTmdbUpcomingEpisodesTaskTriggers({ MissingEpisodeRefreshIntervalDays: 2_147_483_647 }),
    /TimeSpan range/u);
  assert.deepEqual(native.nullConfiguration, { progress: [100], queries: 0 });
  assert.deepEqual(native.disabled.progress, [47.5, 95, 100]);
  assert.deepEqual(native.disabled.deleteOptions, Array(3).fill({ DeleteFileLocation: false, notifyParentItem: false }));
});
test('real PostgreSQL active upkeep selects non-ended plus opted-out TMDB series, isolates failures and uses recursive validation options', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const ids = Object.fromEntries(['aggregate', 'userRoot', 'enabledCollection', 'disabledCollection', 'enabledFolder',
    'disabledFolder', 'continuingEnabled', 'endedEnabled', 'endedDisabled', 'continuingDisabled', 'withoutTmdb',
    'endedDetached']
    .map((name, index) => [name, `A7000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`]));
  const schema = `tmdb_selection_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const database = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true,
  });
  const store = new DomainStore(database);
  const fixture = await libraryFixture(store, database, 'tmdb-selection'), { library } = fixture;
  t.after(async () => {
    await fixture.close();
    await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await store.close();
  });
  const item = (name, Type, values = {}) => ({ ...blank('BaseItems'), Id: ids[name], Name: name,
    SortName: name.toLowerCase(), Type: `MediaBrowser.Controller.Entities${Type === 'Series' ? '.TV' : ''}.${Type}`,
    Data: '{}', ...values });
  const items = [
    item('aggregate', 'AggregateFolder', { IsFolder: true }),
    item('userRoot', 'UserRootFolder', { IsFolder: true }),
    item('enabledCollection', 'CollectionFolder', { IsFolder: true, ParentId: ids.userRoot,
      Data: JSON.stringify({ PhysicalLocationsList: ['Z:\\Enabled'] }) }),
    item('disabledCollection', 'CollectionFolder', { IsFolder: true, ParentId: ids.userRoot,
      Data: JSON.stringify({ PhysicalLocationsList: ['Z:\\Disabled'] }) }),
    item('enabledFolder', 'Folder', { IsFolder: true, ParentId: ids.aggregate, Path: 'Z:\\Enabled' }),
    item('disabledFolder', 'Folder', { IsFolder: true, ParentId: ids.aggregate, Path: 'Z:\\Disabled' }),
    item('continuingEnabled', 'Series', { IsFolder: true, ParentId: ids.enabledFolder,
      TopParentId: ids.enabledFolder, Data: JSON.stringify({ Status: 'Continuing' }) }),
    item('endedEnabled', 'Series', { IsFolder: true, ParentId: ids.enabledFolder,
      TopParentId: ids.enabledFolder, Data: JSON.stringify({ Status: 'Ended' }) }),
    item('endedDisabled', 'Series', { IsFolder: true, ParentId: ids.disabledFolder,
      TopParentId: ids.disabledFolder, Data: JSON.stringify({ Status: 'Ended' }) }),
    item('continuingDisabled', 'Series', { IsFolder: true, ParentId: ids.disabledFolder,
      TopParentId: ids.disabledFolder, Data: JSON.stringify({ Status: 'Continuing' }) }),
    item('withoutTmdb', 'Series', { IsFolder: true, ParentId: ids.disabledFolder,
      TopParentId: ids.disabledFolder, Data: JSON.stringify({ Status: 'Continuing' }) }),
    item('endedDetached', 'Series', { IsFolder: true, Data: JSON.stringify({ Status: 'Ended' }) }),
  ];
  for (const row of items) await database.insert('BaseItems', row);
  for (const [name, ProviderId, ProviderValue] of [
    ['continuingEnabled', 'tmDB', '1'], ['endedEnabled', 'Tmdb', '2'],
    ['endedDisabled', 'TMDB', '3'], ['continuingDisabled', 'TmDb', '4'], ['endedDetached', 'tmdb', '5'],
  ]) await database.insert('BaseItemProviders', { ItemId: ids[name], ProviderId, ProviderValue });
  const calls = [], errors = [], progress = [];
  library.validateChildren = async (series, options) => {
    calls.push([series.Name, options]);
    if (series.Name === 'endedDisabled') throw new Error('isolated series failure');
  };
  const maintenance = new TmdbUpcomingEpisodesMaintenance({
    store,
    library,
    lifecycle: { async remove() {} },
    configuration: tmdbConfiguration({ ImportUnairedEpisodes: true,
      EnabledMissingEpisodeLibraries: [idKey(ids.enabledCollection).toUpperCase()] }),
    onError: (error, series) => errors.push([error.message, series.Name]),
  });
  await maintenance.run({ reportProgress: value => progress.push(value) });
  assert.deepEqual(calls.map(([name]) => name),
    ['continuingEnabled', 'endedDisabled', 'continuingDisabled', 'endedDetached']);
  assert.deepEqual(errors, [['isolated series failure', 'endedDisabled']]);
  assert.deepEqual(progress, [25, 50, 75, 100]);
  for (const [, options] of calls) assert.deepEqual({
    MetadataRefreshMode: options.MetadataRefreshMode,
    ImageRefreshMode: options.ImageRefreshMode,
    IsAutomated: options.IsAutomated,
    recursive: options.recursive,
    hasInnerProgress: typeof options.reportProgress === 'function',
  }, {
    MetadataRefreshMode: 'Default', ImageRefreshMode: 'ValidationOnly', IsAutomated: true,
    recursive: true, hasInnerProgress: true,
  });
});

test('real PostgreSQL active upkeep validates whole Series Data and normalizes Status', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = `tmdb_safe_json_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const database = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true,
  });
  const store = new DomainStore(database);
  const fixture = await libraryFixture(store, database, 'tmdb-safe-json'), { library } = fixture;
  t.after(async () => {
    await fixture.close();
    await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await store.close();
  });

  const collectionId = 'a9000000-0000-0000-0000-000000000099';
  const folderId = 'a9000000-0000-0000-0000-000000000098';
  await database.insert('BaseItems', {
    ...blank('BaseItems'), Id: collectionId,
    Type: 'MediaBrowser.Controller.Entities.CollectionFolder', Name: 'Enabled', SortName: 'enabled',
    IsFolder: true, Data: JSON.stringify({ PhysicalFolderIds: [folderId] }),
  });
  await database.insert('BaseItems', {
    ...blank('BaseItems'), Id: folderId,
    Type: 'MediaBrowser.Controller.Entities.Folder', Name: 'Physical', SortName: 'physical',
    IsFolder: true, Data: '{}',
  });

  const samples = [
    ['bad{', true],
    ['[]', true],
    ['{"Status":{}}', true],
    [`{"Status":${'9'.repeat(10000)}}`, true],
    ['{"Status":"Ended","AirDays":"bad"}', true],
    ['{"Status":"continuing"}', true],
    ['{"Status":"ended"}', false],
    ['{"Status":1}', false],
    ['{"Status":"+1"}', false],
  ];
  const expected = [];
  for (const [index, [Data, selected]] of samples.entries()) {
    const Id = `a9000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`;
    if (selected) expected.push(idKey(Id));
    await database.insert('BaseItems', {
      ...blank('BaseItems'), Id, Type: 'MediaBrowser.Controller.Entities.TV.Series',
      Name: `Safe JSON ${index}`, SortName: `safe-json-${index}`, IsFolder: true,
      ParentId: folderId, TopParentId: folderId, Data,
    });
    await database.insert('BaseItemProviders', { ItemId: Id, ProviderId: 'Tmdb', ProviderValue: String(index + 1) });
  }

  const validated = [];
  library.validateChildren = async series => { validated.push(idKey(series.Id)); };
  const maintenance = new TmdbUpcomingEpisodesMaintenance({
    store, library, lifecycle: { async remove() {} },
    configuration: {
      ImportUnairedEpisodes: true,
      ImportMissingEpisodes: false,
      EnabledMissingEpisodeLibraries: [idKey(collectionId).toUpperCase()],
    },
  });
  await maintenance.run();
  assert.deepEqual(validated.sort(), expected.sort());
});

test('real PostgreSQL empty-season cleanup isolates same-key series and keeps metadata transfer bounded', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = `tmdb_season_batch_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const database = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true,
  });
  const store = new DomainStore(database);
  const fixture = await libraryFixture(store, database, 'tmdb-season-batch'), { library } = fixture;
  t.after(async () => {
    database.queryHook = null;
    await fixture.close();
    await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await store.close();
  });

  const seriesId = 'ab000000-0000-0000-0000-000000000001';
  const secondSeriesId = 'ab000000-0000-0000-0000-000000000002';
  for (const [Id, Name] of [[seriesId, 'Batch series A'], [secondSeriesId, 'Batch series B']]) {
    await database.insert('BaseItems', {
      ...blank('BaseItems'), Id,
      Type: 'MediaBrowser.Controller.Entities.TV.Series', Name,
      SortName: Name.toLowerCase(), PresentationUniqueKey: 'shared-batch-series',
      IsFolder: true, Data: '{}',
    });
  }
  const seasonIds = [];
  for (let index = 0; index < 40; index++) {
    const seasonId = `ab000000-0000-0000-0001-${String(index + 1).padStart(12, '0')}`;
    const parentSeriesId = index < 20 ? seriesId : secondSeriesId;
    const seasonNumber = index % 20 + 1;
    seasonIds.push(seasonId);
    await database.insert('BaseItems', {
      ...blank('BaseItems'), Id: seasonId,
      Type: 'MediaBrowser.Controller.Entities.TV.Season', Name: `Batch season ${index + 1}`,
      SortName: `batch season ${String(index + 1).padStart(2, '0')}`, IsFolder: true,
      IsVirtualItem: true, ParentId: parentSeriesId, SeriesId: parentSeriesId,
      SeriesPresentationUniqueKey: 'shared-batch-series', IndexNumber: seasonNumber, Data: '{}',
    });
    await database.insert('BaseItemProviders', {
      ItemId: seasonId, ProviderId: 'Tmdb', ProviderValue: String(index + 1),
    });
  }
  await database.insert('BaseItems', {
    ...blank('BaseItems'), Id: 'ab000000-0000-0000-0002-000000000001',
    Type: 'MediaBrowser.Controller.Entities.TV.Episode', Name: 'Series B existing episode',
    SortName: 'series b existing episode', ParentId: seasonIds[20], SeasonId: seasonIds[20],
    SeriesId: secondSeriesId, SeriesPresentationUniqueKey: 'shared-batch-series',
    ParentIndexNumber: 1, IndexNumber: 1, IsVirtualItem: false, Data: '{}',
  });

  let maximumRows = 0;
  database.queryHook = async (...args) => {
    const result = await database.client.query(...args);
    maximumRows = Math.max(maximumRows, result.rows.length);
    return result;
  };
  const removed = [];
  const maintenance = new TmdbUpcomingEpisodesMaintenance({
    store,
    library,
    lifecycle: { async remove(item) { removed.push(idKey(item.Id)); } },
    configuration: {
      ImportUnairedEpisodes: false,
      ImportMissingEpisodes: false,
      EnabledMissingEpisodeLibraries: [],
    },
  });
  try { await maintenance.run(); }
  finally { database.queryHook = null; }

  assert.deepEqual(removed, seasonIds.filter(id => id !== seasonIds[20]).map(idKey),
    'same-key series in one batch must not leak episodes across their independent metadata states');
  assert.ok(maximumRows <= 128, `metadata transfer returned ${maximumRows} rows`);
});

async function runtimeFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tmdb-upkeep-runtime-'));
  const programDataPath = path.join(directory, 'data');
  await mkdir(programDataPath, { recursive: true });
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
  const schema = `tmdb_upkeep_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const database = await PostgresDatabase.open({ connectionString, schema, create: true });
  const storage = new StorageRegistry();
  storage.registerType('memory', () => new MemoryStorageAdapter());
  await storage.createInstance('tmdb-upkeep', 'memory', {});
  const vfs = new VirtualFileSystem(storage);
  vfs.mount({ path: '/media', instanceId: 'tmdb-upkeep', capabilities: { create: true, replace: true, delete: true } });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: 'Z:\\TmdbUpkeep', accessRoot: '/media', style: 'windows',
    returnAccess: 'controlled scheduled upkeep fixture' });
  const errors = [];
  const runtime = await createTestRuntime({ database, vfs, identityMap, programDataPath,
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
    serverId: 'tmdb-upkeep-postgres', onError: error => errors.push(error) });
  await runtime.plugins.configure('tmdb',{ImportUnairedEpisodes:false,ImportMissingEpisodes:false,EnabledMissingEpisodeLibraries:[],MissingEpisodeRefreshIntervalDays:3});
  t.after(async () => {
    await runtime.close();
    await storage.close();
    const cleanup = await PostgresDatabase.open({ connectionString, schema });
    try {
      await cleanup.client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await cleanup.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    } finally { await cleanup.close(); }
    await rm(directory, { recursive: true, force: true });
  });
  return { runtime, database, programDataPath, errors };
}

function taskCompletion(t, tasks, taskId, details) {
  const completion = Promise.withResolvers();
  const completed = event => {
    if (event.Task.Id === taskId) completion.resolve(event);
  };
  const timeout = setTimeout(() => {
    void Promise.resolve().then(details).then(value => completion.reject(new Error(
      `Timed out waiting for scheduled task completion: ${JSON.stringify(value)}`
    )), error => completion.reject(error));
  }, 30_000);
  const close = () => {
    clearTimeout(timeout);
    tasks.off('completed', completed);
  };
  tasks.on('completed', completed);
  void completion.promise.finally(close).catch(() => {});
  t.after(close);
  return { promise: completion.promise, close };
}

for (const dialect of ['postgres']) for (const delayed of [false, true]) test(`${dialect}: runtime HTTP executes persisted TMDB upkeep and commits Episode then empty Season deletion${delayed ? ' after a query outlasts the former polling window' : ''}`, async t => {
  const { runtime, database, programDataPath, errors } = await runtimeFixture(t, dialect);
  const ids = {
    series: 'A8000000-0000-0000-0000-000000000001',
    season: 'A8000000-0000-0000-0000-000000000002',
    episode: 'A8000000-0000-0000-0000-000000000003',
    episode2: 'A8000000-0000-0000-0000-000000000004',
  };
  const row = (Id, type, values = {}) => ({ ...blank('BaseItems'), Id,
    Type: `MediaBrowser.Controller.Entities.TV.${type}`, Name: type, SortName: type.toLowerCase(),
    Data: '{}', ...values });
  await database.insert('BaseItems', row(ids.series, 'Series', { IsFolder: true }));
  await database.insert('BaseItems', row(ids.season, 'Season', { IsFolder: true, IsVirtualItem: true,
    ParentId: ids.series, SeriesId: ids.series, IndexNumber: 1 }));
  await database.insert('BaseItems', row(ids.episode, 'Episode', { IsVirtualItem: true,
    ParentId: ids.season, SeasonId: ids.season, SeriesId: ids.series, ParentIndexNumber: 1, IndexNumber: 1 }));
  await database.insert('BaseItems', row(ids.episode2, 'Episode', { IsVirtualItem: true,
    ParentId: ids.season, SeasonId: ids.season, SeriesId: ids.series, ParentIndexNumber: 1, IndexNumber: 2 }));
  for (const [index, [ItemId, ProviderValue]] of
    [[ids.series, '40'], [ids.season, '41'], [ids.episode, '42'], [ids.episode2, '43']].entries()) {
    const ProviderId = ['tMdB', 'TMdb', 'tmDB', 'TmDb'][index];
    await database.insert('BaseItemProviders', { ItemId, ProviderId, ProviderValue });
  }
  const removed = [];
  const progress = [];
  runtime.library.on('ItemRemoved', event => removed.push(event.Item.Id));
  runtime.tasks.on('progress', event => {
    if (event.Task.Id === tmdbUpcomingEpisodesTaskId) progress.push(event.Progress);
  });

  const administrator = await runtime.users.createUser({ Name: 'UpkeepAdmin', Password: 'fixture-password' });
  await runtime.users.updatePolicy(administrator.Id, {
    ...(await runtime.users.getUser(administrator.Id)).Policy,
    IsAdministrator: true,
  });
  const login = await runtime.authentication.login({ Username: 'UpkeepAdmin', Pw: 'fixture-password' }, {
    Client: 'TaskTest', Device: 'Fixture', DeviceId: `upkeep-${dialect}`, Version: '1'
  });
  const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http' && entry.bound).port}`;
  const headers = { Authorization: `MediaBrowser Token="${login.AccessToken}", Client="TaskTest", Device="Fixture", DeviceId="upkeep-${dialect}", Version="1"` };
  const listed = await fetch(`${origin}/ScheduledTasks`, { headers });
  assert.equal(listed.status, 200);
  const tasks = await listed.json();
  const task = tasks.find(value => value.Id === tmdbUpcomingEpisodesTaskId);
  assert.deepEqual(task && {
    Name: task.Name, Key: task.Key, Description: task.Description, Category: task.Category,
    Triggers: task.Triggers,
  }, {
    Name: tmdbUpcomingEpisodesTaskName,
    Key: tmdbUpcomingEpisodesTaskKey,
    Description: tmdbUpcomingEpisodesTaskDescription,
    Category: 'Library',
    Triggers: [{ Type: 'IntervalTrigger', IntervalTicks: 2_592_000_000_000 }],
  });

  const completion = taskCompletion(t, runtime.tasks, tmdbUpcomingEpisodesTaskId, async () => ({
    Task: (await runtime.tasks.get(tmdbUpcomingEpisodesTaskId)), progress,
    errors: errors.map(error => ({ name: error.name, message: error.message }))
  }));
  const queryEntered = Promise.withResolvers(), releaseQuery = Promise.withResolvers();
  const previousQueryHook = database.queryHook;
  const delayFirstQuery = ({ Task }) => {
    if (!delayed || Task.Id !== tmdbUpcomingEpisodesTaskId) return;
    database.queryHook = async (...args) => {
      database.queryHook = previousQueryHook;
      queryEntered.resolve();
      await releaseQuery.promise;
      return previousQueryHook ? previousQueryHook.call(database.client, ...args) : database.client.query(...args);
    };
  };
  const closeObservation = () => {
    releaseQuery.resolve();
    database.queryHook = previousQueryHook;
    runtime.tasks.off('started', delayFirstQuery);
    completion.close();
  };
  runtime.tasks.on('started', delayFirstQuery);
  t.after(closeObservation);
  try {
    const started = await fetch(`${origin}/ScheduledTasks/Running/${tmdbUpcomingEpisodesTaskId.toUpperCase()}`, {
      method: 'POST', headers
    });
    assert.equal(started.status, 204);
    if (delayed) {
      await Promise.race([queryEntered.promise, completion.promise.then(() => {
        throw new Error('The task completed before reaching the controlled query.');
      })]);
      const began = performance.now();
      let attempts = 0, observed;
      for (; attempts < 200; attempts++) {
        observed = (await runtime.tasks.get(tmdbUpcomingEpisodesTaskId));
        if (observed?.State === 'Idle' && observed.LastExecutionResult) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(attempts, 200);
      assert.equal(observed.State, 'Running');
      assert.equal(observed.LastExecutionResult, undefined);
      const remaining = 1_100 - (performance.now() - began);
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
      t.diagnostic(`Controlled PostgreSQL query remained pending for ${Math.round(performance.now() - began)}ms; all 200 former polling attempts observed no terminal result.`);
      releaseQuery.resolve();
    }
    const completed = await completion.promise;
    assert.equal(completed.Task.State, 'Idle');
    assert.equal(completed.Result.Status, 'Completed', JSON.stringify(completed.Result));
  } finally { closeObservation(); }
  const info = (await runtime.tasks.get(tmdbUpcomingEpisodesTaskId));
  assert.equal(info?.LastExecutionResult?.Status, 'Completed', JSON.stringify(info?.LastExecutionResult));
  assert.equal((await database.rows('BaseItems', { where: { Id: ids.episode } })).length, 0);
  assert.equal((await database.rows('BaseItems', { where: { Id: ids.episode2 } })).length, 0);
  assert.equal((await database.rows('BaseItems', { where: { Id: ids.season } })).length, 0);
  assert.equal((await database.rows('BaseItems', { where: { Id: ids.series } })).length, 1);
  assert.deepEqual(removed.map(idKey), [idKey(ids.episode), idKey(ids.episode2), idKey(ids.season)]);
  assert.deepEqual(progress, native.disabled.progress);
  const historyPath = path.join(programDataPath, 'data', 'ScheduledTasks', scheduledTaskFilename(tmdbUpcomingEpisodesTaskId));
  const history = JSON.parse(await readFile(historyPath, 'utf8'));
  assert.equal(history.Id, tmdbUpcomingEpisodesTaskId);
  assert.equal(history.Key, tmdbUpcomingEpisodesTaskKey);
  assert.equal(history.Status, 'Completed');
  assert.throws(() => runtime.tasks.cancel(tmdbUpcomingEpisodesTaskId), error =>
    error.status === 409 && error.code === 'task-not-running'
      && error.message === `The ${tmdbUpcomingEpisodesTaskKey} task is not running.`);
  assert.deepEqual(errors, []);
});
