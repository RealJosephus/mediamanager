import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { DomainStore } from '../../src/database/domain-store.js';
import { md5Guid } from '../../src/core/identity.js';
import { initializeLiveTvState } from '../../src/database/live-tv-state-import.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { createApplication } from '../../src/http/application.js';
import { LiveTvDvr } from '../../src/library/live-tv-dvr.js';
import { liveTvStateKey } from '../../src/library/live-tv-state.js';
import { LiveTvTimersService } from '../../src/library/live-tv-timers-service.js';
import { planSeriesEpisodes } from '../../src/library/live-tv-series-schedule.js';
import { LibraryService } from '../../src/library/library-service.js';
import { guideChannelId } from '../../src/library/live-tv-guide-channel.js';
import { guideProgramId } from '../../src/library/live-tv-guide-program.js';
import { cleanValue } from '../../src/library/records.js';
import { attachLibraryNavigation } from './navigation-fixture.js';
import { testFileSystem } from '../storage/plugin-files.js';
import { openStorageFixture } from '../storage/configured-fixture.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase,
  postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';

export const requiredValidationServices = ['postgres'];

const hash = value => createHash('sha256').update(value).digest('hex');

async function bounded(promise, timeoutMs = 10_000) {
  const controller = new AbortController();
  try {
    return await Promise.race([
      promise,
      setTimeout(timeoutMs, undefined, { signal: controller.signal }).then(() => {
        throw new Error(`Operation exceeded ${timeoutMs}ms`);
      }),
    ]);
  } finally { controller.abort(); }
}

function timerService(store, dataPath) {
  return new LiveTvTimersService({
    store,
    dataPath,
    serverId: 'live-tv-timer-postgres',
    loadProgramDtos: async () => new Map(),
  });
}

async function timerFixture(t, prefix, { timers, seriesTimers = '[]' }) {
  const dataPath = await mkdtemp(path.join(tmpdir(), 'mm-live-tv-timer-postgres-'));
  const stateDirectory = path.join(dataPath, 'livetv');
  const timerFile = path.join(stateDirectory, 'timers.json');
  const seriesFile = path.join(stateDirectory, 'seriestimers.json');
  let primaryDatabase, secondaryDatabase, primaryStore, secondaryStore, primaryService, secondaryService;
  t.after(async () => {
    const errors = [];
    for (const service of [primaryService, secondaryService]) if (service) {
      try { await service.close(); } catch (error) { errors.push(error); }
    }
    for (const store of [primaryStore, secondaryStore]) if (store) {
      try { await store.close(); } catch (error) { errors.push(error); }
    }
    try { await dropPostgresTestDatabase(primaryDatabase); } catch (error) { errors.push(error); }
    try {
      assert.equal(path.dirname(path.resolve(dataPath)), path.resolve(tmpdir()));
      assert.ok(path.basename(dataPath).startsWith('mm-live-tv-timer-postgres-'));
      await rm(dataPath, { recursive: true });
    } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Live TV timer PostgreSQL fixture cleanup failed.');
  });
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(timerFile, typeof timers === 'function' ? timers(dataPath) : timers, { flag: 'wx' });
  await writeFile(seriesFile, seriesTimers, { flag: 'wx' });
  primaryDatabase = await createPostgresTestDatabase(null, prefix, { max: 3 });
  primaryStore = new DomainStore(primaryDatabase);
  assert.equal(await primaryStore.transaction(database => initializeLiveTvState(database, { dataPath })), true);
  secondaryDatabase = await PostgresDatabase.open({
    connectionString: postgresTestConnectionString,
    schema: primaryDatabase.schemaName,
    max: 3,
  });
  secondaryStore = new DomainStore(secondaryDatabase);
  primaryService = timerService(primaryStore, dataPath);
  secondaryService = timerService(secondaryStore, dataPath);
  return { dataPath, stateDirectory, timerFile, seriesFile, primaryDatabase, secondaryDatabase,
    primaryStore, secondaryStore, primaryService, secondaryService };
}

async function savedState(database) {
  const raw = await database.getState(liveTvStateKey);
  assert.equal(typeof raw, 'string');
  return { raw, value: JSON.parse(raw) };
}

async function assertSourceMatchesFile(database, kind, filename) {
  const { value } = await savedState(database), bytes = await readFile(filename);
  assert.equal(value[kind].sourceHex, bytes.toString('hex'));
  assert.equal(value[kind].sourceSha256, hash(bytes));
  return { state: value[kind], bytes };
}

test('a recording keeps its original Local backend through HTTP remap and publishes after it is reachable again', {
  skip: !postgresTestConnectionString, timeout: 60000,
}, async t => {
  const original = { Id: 'recording', Name: 'Pinned recording', ChannelId: 'test', Status: 'New',
    StartDate: new Date().toISOString(), EndDate: new Date(Date.now() + 60000).toISOString(),
    PrePaddingSeconds: 0, PostPaddingSeconds: 0, RetryCount: 0 };
  const { dataPath, timerFile, primaryDatabase, primaryService, primaryStore, secondaryService, secondaryStore } =
    await timerFixture(t, 'dvr_remap', { timers: JSON.stringify([original]) });
  const recordingRoot = path.join(dataPath, 'recordings'), spool = path.join(dataPath, 'spool');
  const a = path.join(dataPath, 'backend-a'), b = path.join(dataPath, 'backend-b');
  await Promise.all([mkdir(a), mkdir(b)]);
  const capabilities = { create: true, replace: true, mkdir: true, delete: true, rename: true };
  const style = process.platform === 'win32' ? 'windows' : 'posix';
  const configuration = backend => ({
    instances: [['app', dataPath], ['media', backend]].map(([id, root]) => ({ id, type: 'local', config: { root, writable: true } })),
    mounts: ['app', 'media'].map(id => ({ path: '/' + id, instanceId: id, capabilities })),
    prefixes: [[dataPath, '/app'], [recordingRoot, '/media']].map(([identityRoot, accessRoot]) => ({
      identityRoot, accessRoot, style, caseSensitive: style !== 'windows', returnAccess: 'Isolated DVR storage',
    })),
  });
  const configFile = path.join(dataPath, 'storage.json');
  await writeFile(configFile, JSON.stringify(configuration(a)));
  const storage = await openStorageFixture(t, configFile);
  storage.fileSystem.spoolRoot = spool;
  const instances = [], scans = [], errors = [];
  const firstWrite = Promise.withResolvers(), keepWriting = Promise.withResolvers();
  const firstBytes = Buffer.alloc(3760, 0x47), moreBytes = Buffer.alloc(188, 0x42);
  const source = { Container: 'ts', Protocol: 'Http', RequiresOpening: true };
  let tunes = 0, server;
  function createDvr(timers, store) {
    const attempt = Promise.withResolvers();
    const dvr = new LiveTvDvr({ dataPath, timers, fileSystem: storage.fileSystem, mediaFileSystem: storage.mediaFileSystem,
      retainStorage: storage.retainGeneration, configuration: { getConfiguration: async () => ({ RecordingPath: recordingRoot }), release() {} },
      library: { itemCreation: { getItemById: async () => ({ Type: 'LiveTvChannel' }) } },
      mediaSources: { getMediaSources: async () => { tunes++; return [source]; } },
      liveStreams: { openOwned: async () => ({ MediaSource: source, release() {}, async openRead({ signal }) {
        return { close() {}, stream: (async function* () {
          yield firstBytes;
          firstWrite.resolve();
          await keepWriting.promise;
          yield moreBytes;
          if (!signal.aborted) await once(signal, 'abort');
        })() };
      } }) },
      runBackground: operation => store.runDetached(operation).finally(attempt.resolve),
      queueLibraryScan: () => scans.push('scan'), onError: error => errors.push(error.code),
    });
    timers.dvr = dvr;
    instances.push(dvr);
    return { dvr, attempted: attempt.promise };
  }
  const publicationRoot = path.join(spool, 'dvr-publications');
  const journal = async () => {
    const entries = await readdir(publicationRoot);
    assert.equal(entries.length, 1);
    return JSON.parse(await readFile(path.join(publicationRoot, entries[0], 'publication.json'), 'utf8'));
  };
  try {
    const application = await createApplication({ storage, plugins: { async bind() {} }, storageReadiness: { ready: true },
      configuration: { IsStartupWizardCompleted: true }, authentication: { read: () => ({}),
        authenticate: async () => ({ IsAuthenticated: true, IsApiKey: true, IsAdministrator: true }),
        authorize: (_auth, request) => assert.equal(request.policy, 'RequiresElevation') } });
    server = createServer(application.handler).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const switchTo = async backend => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/Storage/Configuration`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(configuration(backend)), signal: t.signal,
      });
      assert.equal(response.status, 200, await response.text());
    };
    assert.equal(await primaryService.updateRecordingTimer(original, { EndDate: new Date(Date.now() + 10000).toISOString() }), true);
    const first = createDvr(primaryService, primaryStore);
    await first.dvr.start();
    await Promise.race([firstWrite.promise, first.attempted.then(() => { throw new Error('Recording stopped before writing.'); })]);
    const started = await journal();
    const mediaPath = path.join(a, path.relative(recordingRoot, started.path));
    assert.deepEqual(await readFile(mediaPath), firstBytes);
    await switchTo(b);
    assert.equal(first.dvr.isActive(original.Id), true);
    assert.equal((await secondaryService.readRecordingTimers())[0].Status, 'InProgress');
    keepWriting.resolve();
    await first.attempted;
    await first.dvr.close();
    assert.deepEqual(await readFile(mediaPath), Buffer.concat([firstBytes, moreBytes]));
    assert.deepEqual(await readdir(b), []);
    const { bytes } = await assertSourceMatchesFile(primaryDatabase, 'timers', timerFile);
    const [saved] = JSON.parse(bytes);
    assert.equal(saved.RecordingPath, started.path);
    assert.equal(saved.Status, 'Completed');
    const pending = await journal();
    assert.equal(pending.fileIdentity, started.fileIdentity);
    assert.equal(pending.phase, 'post-processing');

    const hidden = createDvr(secondaryService, secondaryStore);
    await hidden.dvr.start(); await hidden.attempted; await hidden.dvr.close();
    assert.deepEqual(await journal(), pending);
    assert.deepEqual(scans, []);
    assert.deepEqual((await primaryService.readRecordingTimers()).map(timer => timer.Status), ['Completed']);

    await switchTo(a);
    const restored = createDvr(secondaryService, secondaryStore);
    await restored.dvr.start(); await restored.attempted; await restored.dvr.close();
    assert.deepEqual(scans, ['scan']);
    assert.deepEqual(await readdir(publicationRoot), []);
    assert.deepEqual(await readdir(b), []);
    assert.equal(tunes, 1);
    assert.ok(errors.every(code => code === 'recording-unavailable'));
  } finally {
    keepWriting.resolve();
    for (const dvr of instances) await dvr.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await storage.close();
  }
});

test('DVR retention pages remain ordered across deletes and preserve active files and Native state', {
  skip: !postgresTestConnectionString, timeout: 120000,
}, async t => {
  const seriesId = 'BatchRetain', title = 'Batch DVR';
  const opaque = '{ "Id":"unrelated", "SeriesTimerId":"Unrelated", "Status":"Completed", "Opaque":9223372036854775807 }';
  const future = '2050-01-01T00:00:00Z';
  const newTimer = number => ({ Id: `live-${number}`, Name: title, ChannelId: 'dvr', Status: 'New', StartDate: future, EndDate: future,
    IsProgramSeries: true, SeasonNumber: 1, EpisodeNumber: number, SeriesTimerId: seriesId, RetryCount: 0 });
  const active = newTimer(90), later = newTimer(91);
  const archived = (root, id, end) => ({ Id: id, Status: 'Completed', EndDate: end,
    RecordingPath: path.join(root, 'timer-files', `${id}.ts`), SeriesTimerId: seriesId.toLowerCase() });
  let history;
  const fixture = await timerFixture(t, 'dvr_retention_pages', {
    seriesTimers: JSON.stringify([{ Id: seriesId.toUpperCase(), KeepUpTo: 3 }, { Id: seriesId, KeepUpTo: 1 }, { Id: 'Unrelated', KeepUpTo: 1 }]),
    timers(root) {
      history = [archived(root, 'z-first-tie', '2024-01-01T00:00:00.0000001Z'),
        archived(root, 'a-second-tie', '2024-01-01T00:00:00.0000001Z'),
        archived(root, 'most-recent', '2024-01-01T00:00:00.0000002Z'),
        archived(root, 'missing', '2025-01-01T00:00:00Z'),
        ...Array.from({ length: 130 }, (_, n) => archived(root, `old-${n}`, '2020-01-01T00:00:00Z'))];
      const unrelated = Array.from({ length: 260 }, (_, n) => ({ ...archived(root, `other-${n}`, future), SeriesTimerId: 'Unrelated' }));
      return `[${[opaque, ...[...history, ...unrelated, active, later].map(row => JSON.stringify(row))].join(',')}]`;
    },
  });
  const { dataPath, primaryDatabase: database, primaryStore: store, primaryService: timers, timerFile } = fixture;
  const originalSource = await readFile(timerFile);
  // An installation upgraded from the pre-projection state must use its
  // existing Native document and rebuild the SQL projection at startup.
  const legacy = JSON.parse(await database.getState(liveTvStateKey));
  delete legacy.recordingRetentionVersion;
  for (const kind of ['timers', 'seriesTimers']) for (const row of legacy[kind].rows) {
    delete row.retentionKey; delete row.recordingPath; delete row.recordingEndTicks;
  }
  await store.transaction(async session => {
    await session.setState(liveTvStateKey, JSON.stringify(legacy));
    await session.client.query(`DELETE FROM ${q(session.controlSchema)}.state WHERE key LIKE 'liveTvRecordingRetention:%'`);
    assert.equal(await initializeLiveTvState(session, { dataPath }), false);
  });
  assert.deepEqual(await readFile(timerFile), originalSource);

  const root = path.join(dataPath, 'recordings'), series = path.join(root, title), season = path.join(series, 'Season 1');
  const activeFile = path.join(season, `${title} S01E90.ts`), retry = history.find(timer => timer.Id === 'old-129');
  const episodes = Array.from({ length: 130 }, (_, n) => ({ id: md5Guid(`retention episode ${n}`),
    filename: path.join(season, `library-${n}.ts`), date: new Date(Date.UTC(2020, 0, 1, 0, n)).toISOString() }));
  const virtual = { id: md5Guid('retention virtual'), filename: path.join(season, 'virtual.ts'), date: future, virtual: true };
  await Promise.all([mkdir(path.join(dataPath, 'timer-files')), mkdir(season, { recursive: true })]);
  const footage = Buffer.alloc(3760, 0x47);
  await Promise.all([...history.filter(timer => timer.Id !== 'missing').map(timer => timer.RecordingPath),
    ...episodes.map(episode => episode.filename), virtual.filename].map(filename => writeFile(filename, footage)));
  const seriesKey = md5Guid('retention library series'), seasonKey = md5Guid('retention library season');
  const channel = guideChannelId('Emby', 'dvr');
  await store.transaction(async db => {
    const insert = data => db.insert('BaseItems', postgresTestRow('BaseItems', { Name: title, Data: '{}', ...data }));
    await insert({ Id: channel, Type: 'MediaBrowser.Controller.LiveTv.LiveTvChannel' });
    await insert({ Id: seriesKey, Type: 'MediaBrowser.Controller.Entities.TV.Series', Path: series, IsFolder: true });
    await insert({ Id: seasonKey, Type: 'MediaBrowser.Controller.Entities.TV.Season', ParentId: seriesKey, Path: season, IsFolder: true });
    for (const row of [...episodes, virtual, { id: md5Guid('retention active episode'), filename: activeFile, date: '2019-01-01T00:00:00Z' }]) {
      await insert({ Id: row.id, Type: 'MediaBrowser.Controller.Entities.TV.Episode', ParentId: seasonKey,
        Path: row.filename, DateCreated: row.date, IsVirtualItem: row.virtual ?? false });
      for (const ParentItemId of [seasonKey, seriesKey]) await db.insert('AncestorIds', { ItemId: row.id, ParentItemId });
    }
  });
  const issue = new Error('Controlled retention unlink failure.'), errors = [], attempts = [], deletedEpisodes = [];
  const files = new Proxy(testFileSystem, { get(target, property) {
    if (property === 'unlink') return filename => {
      attempts.push(filename);
      if (filename === retry.RecordingPath && attempts.filter(value => value === filename).length === 1) throw issue;
      return target.unlink(filename);
    };
    const value = target[property];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const library = new LibraryService({ store, serverId: 'dvr-retention-pages', fileSystem: files });
  const navigation = await attachLibraryNavigation(library);
  const release = Promise.withResolvers(), firstSweep = Promise.withResolvers();
  const attemptsFinished = [Promise.withResolvers(), Promise.withResolvers()];
  const source = { Container: 'ts', Protocol: 'Http', RequiresOpening: true };
  let tunes = 0, jobs = 0;
  const dvr = new LiveTvDvr({ timers, library, fileSystem: files, dataPath,
    configuration: { getConfiguration: async () => ({ RecordingPath: root }), release() {} },
    mediaSources: { getMediaSources: async () => { tunes++; return [source]; } },
    liveStreams: { openOwned: async () => ({ MediaSource: source, release() {}, async openRead({ signal }) {
      return { close() {}, stream: (async function* () {
        yield footage;
        if (tunes === 1 && !signal.aborted) await Promise.race([release.promise, once(signal, 'abort')]);
      })() };
    } }) },
    runBackground: operation => store.runDetached(operation).finally(attemptsFinished[jobs++].resolve),
    onError: error => errors.push(error),
  });
  timers.dvr = dvr;
  const visitRetention = timers.withRecordingRetention.bind(timers);
  timers.withRecordingRetention = async (...args) => {
    let failure;
    try { return await visitRetention(...args); }
    catch (error) { failure = error; throw error; }
    finally { firstSweep.resolve({ active: dvr.isActive(active.Id), failure }); }
  };
  library.deleteItem = async (item, options) => {
    assert.equal(options.DeleteFileLocation, true);
    await files.unlink(item.Path);
    await store.transaction(db => db.delete('BaseItems', { Id: item.Id }));
    deletedEpisodes.push(item.Path);
  };
  const published = async () => JSON.parse((await assertSourceMatchesFile(database, 'timers', timerFile)).bytes);
  const arm = timer => timers.updateRecordingTimer(timer, { StartDate: new Date().toISOString(), EndDate: new Date(Date.now() + 45000).toISOString() });
  const cursors = new Map(), pages = { timers: [], episodes: [] }, originalQuery = database.client.query;
  database.client.query = async (query, ...values) => {
    const text = typeof query === 'string' ? query : query.text;
    const declaration = /^DECLARE ("mm_item_page_[a-f0-9]+")/u.exec(text);
    if (declaration) cursors.set(declaration[1], text.includes('live-tv-recording-retention-order') ? 'timers' : 'episodes');
    const result = await originalQuery.call(database.client, query, ...values);
    const fetch = /^FETCH FORWARD (\d+) FROM ("mm_item_page_[a-f0-9]+")/u.exec(text);
    if (fetch && cursors.has(fetch[2])) {
      assert.equal(Number(fetch[1]), 128);
      assert.ok(result.rows.length <= 128);
      pages[cursors.get(fetch[2])].push(result.rows.length);
    }
    return result;
  };
  try {
    assert.equal(await arm(active), true);
    await dvr.start();
    const sweep = await Promise.race([firstSweep.promise, attemptsFinished[0].promise.then(() => null)]);
    assert.ok(sweep, 'The active recording did not reach retention.');
    assert.ifError(sweep.failure);
    assert.equal(sweep.active, true);
    assert.equal(deletedEpisodes.length, episodes.length - 2);
    assert.deepEqual(deletedEpisodes, episodes.slice(0, -2).toReversed().map(episode => episode.filename));
    assert.deepEqual(pages.timers.slice(0, 2), [128, history.length - 128]);
    assert.deepEqual(pages.episodes.slice(0, 2), [128, episodes.length + 1 - 128]);
    for (const filename of [activeFile, virtual.filename, retry.RecordingPath, ...episodes.slice(-2).map(row => row.filename)]) {
      assert.deepEqual(await readFile(filename), footage);
    }
    release.resolve(); await attemptsFinished[0].promise;
    const selected = rows => rows.filter(row => row.SeriesTimerId?.toLowerCase() === seriesId.toLowerCase()).map(row => row.Id);
    assert.deepEqual(selected(await published()), ['z-first-tie', 'most-recent', 'missing', retry.Id, active.Id, later.Id]);
    assert.ok(errors.includes(issue));

    assert.equal(await arm(later), true);
    await attemptsFinished[1].promise;
    assert.equal(attempts.filter(value => value === retry.RecordingPath).length, 2);
    await assert.rejects(readFile(retry.RecordingPath), { code: 'ENOENT' });
    const final = await published();
    assert.deepEqual(final.filter(row => row.SeriesTimerId === 'Unrelated').map(row => row.Id),
      ['unrelated', ...Array.from({ length: 260 }, (_, n) => `other-${n}`)]);
    assert.ok((await readFile(timerFile, 'utf8')).includes(opaque));
    const reimport = await createPostgresTestDatabase(t, 'retention_reimport');
    assert.equal(await reimport.transaction(db => initializeLiveTvState(db, { dataPath })), true);
    await assertSourceMatchesFile(reimport, 'timers', timerFile);
    await assertSourceMatchesFile(reimport, 'seriesTimers', fixture.seriesFile);
    t.diagnostic(JSON.stringify({ pages, deletedEpisodes: deletedEpisodes.length, retainedUnrelatedTimers: 261 }));
  } catch (error) {
    t.diagnostic(JSON.stringify({ pages, deletedEpisodes: deletedEpisodes.length, unlinks: attempts.length,
      tunes, errors: errors.map(cause => ({ message: cause.message, code: cause.code, stack: cause.stack })) }));
    throw error;
  } finally {
    release.resolve(); await dvr.close();
    database.client.query = originalQuery;
    await navigation.close();
  }
});

test('series planning consumes each guide page immediately and indexes existing timer IDs', async () => {
  const series = { Id: 'indexed-rule', RecordAnyTime: true, RecordAnyChannel: true };
  for (const count of [128, 512]) {
    let idReads = 0;
    const entries = Array.from({ length: count }, (_, index) => {
      const ProgramId = `program-${index}`, id = md5Guid(series.Id + ProgramId).toUpperCase();
      return { get Id() { idReads++; return id; }, ProgramId, Status: 'New' };
    });
    const plan = await planSeriesEpisodes(series, entries, async visit => {
      for (let offset = 0; offset < count; offset += 128) {
        for (let index = offset; index < offset + 128; index++) {
          visit({ program: { ProgramId: `program-${index}`, Name: `Episode ${index}` } });
        }
        assert.equal(entries[offset].Name, `Episode ${offset}`, 'A completed page must already be planned.');
      }
    }, { isActive: () => false });
    assert.deepEqual(plan.append, []);
    assert.deepEqual(plan.events, []);
    assert.deepEqual([...plan.changes.keys()], entries.map((_, index) => index));
    assert.ok(idReads <= count * 3, `${idReads} ID reads for ${count} guide occurrences`);
  }
});

test('series planning updates the first saved program alias after an exact ID match reassigns one', async () => {
  const series = { Id: 'aliases', RecordAnyTime: true, RecordAnyChannel: true, RecordNewOnly: true };
  const entries = [
    { Id: md5Guid(series.Id + 'updated'), ProgramId: 'old', IsManual: true, Status: 'InProgress' },
    { Id: 'first-manual', ProgramId: 'OLD', IsManual: true, Status: 'New' },
    { Id: 'second-manual', ProgramId: 'old', IsManual: true, Status: 'Cancelled' },
  ];
  const plan = await planSeriesEpisodes(series, entries, async visit => {
    visit({ program: { ProgramId: 'updated', IsRepeat: true, Name: 'Updated' } });
    visit({ program: { ProgramId: 'Old', IsRepeat: true, Name: 'Manual episode' } });
  }, { isActive: () => false });
  assert.deepEqual(plan.append, []);
  assert.deepEqual([...plan.changes].map(([index, change]) => [index, change.ProgramId, change.Status]), [
    [0, 'updated', 'InProgress'], [1, 'Old', 'New'],
  ]);
  assert.deepEqual(entries.slice(1).map(timer => [timer.Id, timer.Status]), [['first-manual', 'New'], ['second-manual', 'Cancelled']]);
});

test('series refresh batches PostgreSQL work while retaining the saved order and episode choices', {
  skip: !postgresTestConnectionString, timeout: 30000,
}, async t => {
  const name = 'Batch series: Édition', channel = 'owned-sd', seriesId = 'owned-guide-series', ruleId = 'owned-rule';
  const guideId = index => `owned-${String(index).padStart(3, '0')}`;
  const startDate = index => new Date(Date.UTC(2050, 0, 1, 0, index === 130 ? 1 : index + 15)).toISOString().replace('.000Z', '.0000001Z');
  const fixture = await timerFixture(t, 'live_tv_series_batch', {
    timers: JSON.stringify([
      { Id: 'manual-id', ProgramId: guideId(0), Status: 'InProgress', IsManual: true, Opaque: 'preserve' },
      { Id: 'missing-from-guide', SeriesTimerId: ruleId, Status: 'New', StartDate: startDate(0) },
    ]),
    seriesTimers: JSON.stringify([{ Id: ruleId, Name: name, ChannelId: channel, SeriesId: seriesId,
      RecordAnyChannel: false, RecordAnyTime: true, RecordNewOnly: false, SkipEpisodesInLibrary: true }]),
  });
  const db = fixture.primaryDatabase, service = fixture.primaryService;
  const library = new LibraryService({ store: fixture.primaryStore, serverId: 'series-query', fileSystem: testFileSystem });
  const navigation = await attachLibraryNavigation(library);
  service.dvr = { isActive: () => false, syncTimers() {} };
  service.visitRecordingSeriesPrograms = library.visitRecordingSeriesPrograms.bind(library);
  const insert = values => db.insert('BaseItems', postgresTestRow('BaseItems', values));
  const program = (index, overrides = {}) => ({ Id: guideProgramId(guideId(index)), Type: 'MediaBrowser.Controller.LiveTv.LiveTvProgram',
    ExternalId: guideId(index), Name: name, CleanName: cleanValue(name), SortName: guideId(index), ExternalSeriesId: seriesId,
    ChannelId: guideChannelId('Emby', channel), IsSeries: true, Data: '{}',
    StartDate: startDate(index), EndDate: '2050-01-01T04:00:00.0000002Z', ParentIndexNumber: 1, IndexNumber: index + 1,
    ShowId: [6, 130].includes(index) ? 'same-airing' : `show-${index}`, ...overrides });
  const seedPrograms = async (start, end) => {
    for (let index = end - 1; index >= start; index--) await insert(program(index));
  };

  async function refresh() {
    const statements = [];
    const original = db.withConnection;
    db.withConnection = function countQueries(operation, options) {
      return original.call(this, async session => {
        const query = session.client.query;
        session.client.query = function countedQuery(input, ...args) {
          statements.push(typeof input === 'string' ? { text: input } : input);
          return query.call(this, input, ...args);
        };
        try { return await operation(session); }
        finally { session.client.query = query; }
      }, options);
    };
    try { assert.equal(await service.refreshSeriesTimers(), true); }
    finally { db.withConnection = original; }
    assert.match(statements[0].text, /pg_try_advisory_lock/u);
    assert.match(statements.at(-1).text, /pg_advisory_unlock/u);
    return statements;
  }

  try {
    const otherChannel = guideChannelId('Emby', 'other-hd'), matchedSeries = md5Guid('owned library series');
    const unrelatedSeries = md5Guid('unrelated library series'), primary = md5Guid('unrelated primary item');
    for (const [externalId, id, height] of [[channel, guideChannelId('Emby', channel), 480], ['other-hd', otherChannel, 1080]]) {
      await insert({ Id: id, Type: 'MediaBrowser.Controller.LiveTv.LiveTvChannel', Name: externalId, ExternalId: externalId, Height: height, Data: '{}' });
    }
    for (const [id, title] of [[matchedSeries, 'batch series - edition'], [unrelatedSeries, 'Unrelated']]) {
      await insert({ Id: id, Type: 'MediaBrowser.Controller.Entities.TV.Series', Name: title, CleanName: cleanValue(title), Data: '{}' });
    }
    await insert({ Id: primary, Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Name: 'Primary', Data: '{}' });
    for (const [index, ancestor, overrides] of [[1, matchedSeries, {}], [2, matchedSeries, { IsVirtualItem: true }],
      [3, unrelatedSeries, {}], [4, matchedSeries, { PrimaryVersionId: primary }]]) {
      const id = md5Guid(`library episode ${index}`);
      await insert({ Id: id, Type: 'MediaBrowser.Controller.Entities.TV.Episode', ParentIndexNumber: 1, IndexNumber: index + 1,
        IsVirtualItem: false, Data: '{}', ...overrides });
      await db.insert('AncestorIds', { ItemId: id, ParentItemId: ancestor });
    }
    await insert(program(140, { ChannelId: otherChannel }));
    await insert(program(141, { ExternalSeriesId: 'unrelated-guide-series' }));

    await seedPrograms(0, 1);
    await db.insert('BaseItemProviders', { ItemId: guideProgramId(guideId(0)), ProviderId: 'SeriesTvdb', ProviderValue: '1234' });
    const single = await refresh();
    await seedPrograms(1, 24);
    const withinPage = await refresh();
    await seedPrograms(24, 131);
    const multiplePages = await refresh();
    const version = (await db.client.query('SHOW server_version')).rows[0].server_version;
    t.diagnostic(`PostgreSQL ${version}, SQL calls under the writer lock for 1 / 24 / 131 programs: ${single.length} / ${withinPage.length} / ${multiplePages.length}`);
    assert.ok(withinPage.length <= single.length + 2, 'Adding programs within a page must not add per-program queries.');
    assert.ok(multiplePages.length <= withinPage.length + 10, 'Crossing one page adds only a bounded set of queries.');
    const batches = statements => statements.filter(statement => statement.text.startsWith('SELECT request.ordinal')).map(statement => statement.values[0].length);
    assert.deepEqual(batches(single), [1]);
    assert.deepEqual(batches(withinPage), [24]);
    assert.deepEqual(batches(multiplePages), [128, 3]);

    const { bytes } = await assertSourceMatchesFile(db, 'timers', fixture.timerFile);
    const [manual, removed, ...scheduled] = JSON.parse(bytes);
    assert.equal(manual.Id, 'manual-id');
    assert.equal(manual.Status, 'InProgress');
    assert.equal(manual.IsManual, true);
    assert.equal(manual.Opaque, 'preserve');
    assert.equal(manual.StartDate, startDate(0));
    assert.equal(manual.ChannelId, channel);
    assert.deepEqual(manual.SeriesProviderIds, { Tvdb: '1234' });
    assert.equal(removed.Id, 'missing-from-guide');
    assert.equal(removed.Status, 'Cancelled');
    assert.deepEqual(scheduled.map(timer => [timer.Id, timer.ProgramId, timer.Status, timer.SeriesTimerId]),
      Array.from({ length: 130 }, (_, i) => {
        const index = i + 1, programId = guideId(index);
        return [md5Guid(ruleId + programId), programId, [1, 6].includes(index) ? 'Cancelled' : 'New', ruleId];
      }));
  } finally { await navigation.close(); }
});

test('independent PostgreSQL stores serialize timer cancellations and publish the complete winning source', {
  skip: !postgresTestConnectionString,
}, async t => {
  const source = '[{"Id":"first","SeriesTimerId":"series-a","Status":"New","IsManual":false},'
    + '{"Id":"second","SeriesTimerId":"series-b","Status":"New","IsManual":false},'
    + '{"Id":"untouched","SeriesTimerId":"series-c","Status":"New","Opaque":{"value":1}}]';
  const fixture = await timerFixture(t, 'live_tv_timer_serial', {
    timers: source,
  });
  const initial = await savedState(fixture.primaryDatabase);
  const firstId = initial.value.timers.rows[0].internalId;
  const secondId = initial.value.timers.rows[1].internalId;
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const blocker = fixture.primaryStore.serializeWrites(async () => {
    entered.resolve();
    await release.promise;
  });
  let first, second;
  let firstSettled = false, secondSettled = false;
  try {
    await bounded(entered.promise);
    first = fixture.primaryService.cancelTimer(firstId);
    second = fixture.secondaryService.cancelTimer(secondId);
    void first.then(() => { firstSettled = true; }, () => { firstSettled = true; });
    void second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
    await setImmediate();
    assert.equal(firstSettled, false);
    assert.equal(secondSettled, false, 'the second store cannot publish while the first writer boundary is held');
    assert.equal((await readFile(fixture.timerFile)).toString(), source);
  } finally { release.resolve(); }
  await bounded(blocker);
  assert.deepEqual(await bounded(Promise.all([first, second])), [true, true]);

  const { state, bytes } = await assertSourceMatchesFile(fixture.primaryDatabase, 'timers', fixture.timerFile);
  const documents = JSON.parse(bytes);
  assert.deepEqual(documents.map(timer => ({ Id: timer.Id, Status: timer.Status, IsManual: timer.IsManual })), [
    { Id: 'first', Status: 'Cancelled', IsManual: true },
    { Id: 'second', Status: 'Cancelled', IsManual: true },
    { Id: 'untouched', Status: 'New', IsManual: undefined },
  ]);
  assert.equal(documents[2].Opaque.value, 1);
  assert.equal(state.rows.length, 3);
  await assertSourceMatchesFile(fixture.secondaryDatabase, 'seriesTimers', fixture.seriesFile);
  assert.deepEqual((await readdir(fixture.stateDirectory)).sort(), ['seriestimers.json', 'timers.json']);
});

test('a deferred PostgreSQL failure rolls back after file publication and restores the authoritative bytes', {
  skip: !postgresTestConnectionString,
}, async t => {
  const fixture = await timerFixture(t, 'live_tv_timer_rollback', {
    timers: '[{"Id":"rollback","SeriesTimerId":"series","Status":"New","IsManual":false}]',
  });
  const before = await savedState(fixture.primaryDatabase);
  const timerBefore = await readFile(fixture.timerFile), seriesBefore = await readFile(fixture.seriesFile);
  const control = q(fixture.primaryDatabase.controlSchema);
  let functionCreated = false, triggerCreated = false;
  try {
    await fixture.primaryDatabase.client.query(`CREATE FUNCTION ${control}.fail_live_tv_timer_commit()
      RETURNS trigger LANGUAGE plpgsql AS $live_tv_timer_test$
      BEGIN
        IF NEW.key = 'liveTvNativeState' THEN
          RAISE EXCEPTION 'Controlled Live TV deferred rollback.';
        END IF;
        RETURN NEW;
      END;
      $live_tv_timer_test$`);
    functionCreated = true;
    await fixture.primaryDatabase.client.query(`CREATE CONSTRAINT TRIGGER fail_live_tv_timer_commit
      AFTER UPDATE ON ${control}.state DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION ${control}.fail_live_tv_timer_commit()`);
    triggerCreated = true;

    await assert.rejects(fixture.primaryService.cancelTimer(before.value.timers.rows[0].internalId),
      /Controlled Live TV deferred rollback/u);
    assert.equal((await savedState(fixture.primaryDatabase)).raw, before.raw);
    assert.deepEqual(await readFile(fixture.timerFile), timerBefore);
    assert.deepEqual(await readFile(fixture.seriesFile), seriesBefore);
    await assertSourceMatchesFile(fixture.primaryDatabase, 'timers', fixture.timerFile);
    await assertSourceMatchesFile(fixture.primaryDatabase, 'seriesTimers', fixture.seriesFile);
    assert.deepEqual((await readdir(fixture.stateDirectory)).sort(), ['seriestimers.json', 'timers.json']);
  } finally {
    const cleanupErrors = [];
    if (triggerCreated) try {
      await fixture.primaryDatabase.client.query(`DROP TRIGGER fail_live_tv_timer_commit ON ${control}.state`);
    } catch (error) { cleanupErrors.push(error); }
    if (functionCreated) try {
      await fixture.primaryDatabase.client.query(`DROP FUNCTION ${control}.fail_live_tv_timer_commit()`);
    } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Deferred Live TV rollback fixture cleanup failed.');
  }
});

test('close drains an admitted cancellation waiting on another PostgreSQL writer and rejects later admission', {
  skip: !postgresTestConnectionString,
}, async t => {
  const fixture = await timerFixture(t, 'live_tv_timer_close', {
    timers: '[{"Id":"closing","SeriesTimerId":"series","Status":"New"}]',
  });
  const before = await savedState(fixture.primaryDatabase);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const blocker = fixture.primaryStore.serializeWrites(async () => {
    entered.resolve();
    await release.promise;
  });
  let cancellation, closing;
  let cancellationSettled = false, closeSettled = false;
  try {
    await bounded(entered.promise);
    cancellation = fixture.secondaryService.cancelTimer(before.value.timers.rows[0].internalId);
    closing = fixture.secondaryService.close();
    void cancellation.then(() => { cancellationSettled = true; }, () => { cancellationSettled = true; });
    void closing.then(() => { closeSettled = true; }, () => { closeSettled = true; });
    await setImmediate();
    assert.equal(cancellationSettled, false);
    assert.equal(closeSettled, false, 'close must retain the admitted operation until its writer boundary completes');
    await assert.rejects(fixture.secondaryService.cancelTimer(before.value.timers.rows[0].internalId), { status: 503 });
  } finally { release.resolve(); }
  await bounded(blocker);
  assert.equal(await bounded(cancellation), true);
  await bounded(closing);
  const { bytes } = await assertSourceMatchesFile(fixture.primaryDatabase, 'timers', fixture.timerFile);
  assert.deepEqual(JSON.parse(bytes), [
    { Id: 'closing', SeriesTimerId: 'series', Status: 'Cancelled', IsManual: true },
  ]);
});

test('idempotent cancellation preserves staging failures, closes the actual file and recovers on the next operation', {
  skip: !postgresTestConnectionString,
}, async t => {
  const fixture = await timerFixture(t, 'live_tv_timer_noop_failure', {
    timers: '[{"Id":"cancelled","SeriesTimerId":"series","Status":"Cancelled","IsManual":true}]',
  });
  const before = await savedState(fixture.primaryDatabase), timerBefore = await readFile(fixture.timerFile);
  const requested = before.value.timers.rows[0].internalId;
  for (const [name, reason] of [['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined],
    ['errno', Object.assign(new Error('Controlled timer staging write failure.'), { code: 'ENOSPC', statusCode: 507 })]]) {
    await t.test(name, async () => {
      const handles = [], removed = [];
      fixture.primaryService.stateFileSystem = { ...fs,
        async open(filename, flags) {
          const handle = await fs.open(filename, flags); handles.push(handle);
          return { async writeFile(bytes) {
            await handle.writeFile(bytes.subarray(0, 7));
            throw reason;
          }, close: () => handle.close() };
        },
        async rm(filename, options) { await fs.rm(filename, options); removed.push(filename); },
      };
      try {
        await assert.rejects(fixture.primaryService.cancelTimer(requested), error => Object.is(error, reason));
        assert.equal(handles.length, 1); assert.equal(removed.length, 1);
        await assert.rejects(handles[0].stat(), { code: 'EBADF' });
        assert.deepEqual((await savedState(fixture.primaryDatabase)).value, before.value);
        assert.deepEqual(await readFile(fixture.timerFile), timerBefore);
        assert.deepEqual((await readdir(fixture.stateDirectory)).sort(), ['seriestimers.json', 'timers.json']);
      } finally { fixture.primaryService.stateFileSystem = fs; }
      assert.equal(await fixture.primaryService.cancelTimer(requested), true);
      await assertSourceMatchesFile(fixture.primaryDatabase, 'timers', fixture.timerFile);
      assert.deepEqual(await readFile(fixture.timerFile), timerBefore);
    });
  }
});

test('timer staging reports write, close and removal failures in order after actual cleanup without poisoning PostgreSQL', {
  skip: !postgresTestConnectionString,
}, async t => {
  const fixture = await timerFixture(t, 'live_tv_timer_cleanup_failure', {
    timers: '[{"Id":"cleanup","SeriesTimerId":"series","Status":"New"}]',
  });
  const before = await savedState(fixture.primaryDatabase), timerBefore = await readFile(fixture.timerFile);
  const primary = Object.assign(new Error('Controlled timer partial write failure.'), { code: 'ENOSPC', status: 507 });
  const closeFailure = { operation: 'close' }, removeFailure = 0, handles = [], order = [];
  fixture.primaryService.stateFileSystem = { ...fs,
    async open(filename, flags) {
      const handle = await fs.open(filename, flags); handles.push(handle);
      return { async writeFile(bytes) { await handle.writeFile(bytes.subarray(0, 11)); order.push('write'); throw primary; },
        async close() { await handle.close(); order.push('close'); throw closeFailure; } };
    },
    async rm(filename, options) { await fs.rm(filename, options); order.push('remove'); throw removeFailure; },
  };
  try {
    await assert.rejects(fixture.primaryService.cancelTimer(before.value.timers.rows[0].internalId), failure => {
      assert.ok(failure instanceof AggregateError); assert.equal(failure.cause, primary);
      assert.deepEqual(failure.errors, [primary, closeFailure, removeFailure]);
      assert.equal(failure.code, 'ENOSPC'); assert.equal(failure.status, 507); return true;
    });
    assert.deepEqual(order, ['write', 'close', 'remove']);
    assert.equal(handles.length, 1); await assert.rejects(handles[0].stat(), { code: 'EBADF' });
    assert.deepEqual((await savedState(fixture.primaryDatabase)).value, before.value);
    assert.deepEqual(await readFile(fixture.timerFile), timerBefore);
    assert.deepEqual((await readdir(fixture.stateDirectory)).sort(), ['seriestimers.json', 'timers.json']);
  } finally { fixture.primaryService.stateFileSystem = fs; }
  assert.equal(await fixture.primaryService.cancelTimer(before.value.timers.rows[0].internalId), true);
  await assertSourceMatchesFile(fixture.primaryDatabase, 'timers', fixture.timerFile);
});
