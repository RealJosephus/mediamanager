import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../../src/runtime.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { tableDefinition } from '../../src/database/model.js';
import { dateText, idKey } from '../../src/library/records.js';
import { nativeGuid } from '../../src/users/native.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const inputFile = new URL('./fixtures/post-scan-composition/input.json', import.meta.url);
const cancellationInputFile = new URL('./fixtures/post-scan-composition/cancellation-input.json', import.meta.url);
const musicInputFile = new URL('./fixtures/post-scan-composition/music-input.json', import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const itemColumns = tableDefinition('BaseItems').columns;
const ordinaryByNameTypes = ['Genre', 'Studio'].map(name => 'MediaBrowser.Controller.Entities.' + name);
const artistType = 'MediaBrowser.Controller.Entities.Audio.MusicArtist';
const musicGenreType = 'MediaBrowser.Controller.Entities.Audio.MusicGenre';
const nativeTasks = ['SplashscreenPostScanTask', 'ArtistsPostScanTask', 'CollectionPosterVerifyPostScanTask',
  'CollectionPostScanTask', 'GenresPostScanTask', 'MusicGenresPostScanTask', 'StudiosPostScanTask', 'CleanDatabaseScheduledTask'];

function rewrite(value, root) {
  if (Array.isArray(value)) return value.map(entry => rewrite(entry, root));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewrite(entry, root)]));
  if (typeof value === 'bigint') { assert.ok(Number.isSafeInteger(Number(value))); return Number(value); }
  if (typeof value !== 'string') return value;
  value = value.replaceAll(root, '$PROGRAM').replaceAll(root.replaceAll('\\', '/'), '$PROGRAM');
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) return idKey(value);
  return value.replaceAll('\\', '/');
}

function rowsForComparison(rows, { root, initialIds, byNameTypes, start, end, expandPath = value => value }) {
  return rows.filter(row => initialIds.has(idKey(row.Id)) || byNameTypes.includes(row.Type)).map(row => {
    const created = !initialIds.has(idKey(row.Id));
    return Object.fromEntries(itemColumns.map(column => {
      let value = row[column.name];
      if (value == null) return [column.name, null];
      if (column.name === 'Data') {
        value = parseLosslessJson(value);
        if (created && value.DateLastSaved != null && row.DateLastSaved != null) {
          assert.equal(dateText(value.DateLastSaved), dateText(row.DateLastSaved));
          value.DateLastSaved = '$SAVE_CLOCK';
        }
      } else if (column.clrType.includes('DateTime')) {
        value = dateText(value);
        if (created && !value.startsWith('0001-01-01')
          && ['DateCreated', 'DateModified', 'DateLastSaved', 'DateLastRefreshed'].includes(column.name)) {
          const instant = Date.parse(value);
          assert.ok(instant >= start - 1000 && instant <= end + 1000, `${column.name} must belong to this actual operation: ${value}`);
          value = '$' + column.name.toUpperCase() + '_CLOCK';
        }
      } else if (column.name === 'Path') value = expandPath(value);
      else if (column.clrType.replace('?', '') === 'bool') value = Boolean(value);
      return [column.name, rewrite(value, root)];
    }));
  }).sort((left, right) => left.Id.localeCompare(right.Id));
}

async function stateFiles(root) {
  const result = [];
  const visit = async directory => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false, 'The isolated fixture must not introduce symbolic links.');
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) {
        const bytes = await readFile(filename);
        result.push({ path: path.relative(root, filename).replaceAll('\\', '/'), bytes: bytes.length, sha256: hash(bytes), content: bytes.toString('base64') });
      }
    }
  };
  await visit(path.join(root, 'metadata')); await visit(path.join(root, 'data'));
  return result.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

async function compareComposition(t, scenarioFile) {
  const inputBytes = await readFile(scenarioFile), scenario = JSON.parse(inputBytes)[0];
  const cancelling = scenario.Cancel?.Channel === 'metadata-before';
  const music = scenario.Seed.Music;
  const artistNames = [...new Set(music?.Tracks.flatMap(track => [...track.Artists, ...track.AlbumArtists]) ?? [])];
  const musicGenreNames = [...new Set(music?.Tracks.flatMap(track => track.Genres) ?? [])];
  const byNameTypes = [...ordinaryByNameTypes, ...(music ? [artistType, musicGenreType] : [])];
  const refreshedTypes = [...(cancelling ? ordinaryByNameTypes.slice(0, 1) : ordinaryByNameTypes),
    ...artistNames.map(() => artistType), ...musicGenreNames.map(() => musicGenreType)];
  assert.ok(process.env.MEDIAMANAGER_JELLYFIN_DLL, 'The actual composition requires the current native Jellyfin assembly directory.');
  await access(process.env.MEDIAMANAGER_JELLYFIN_DLL);
  const output = path.join(validationOutputRoot(), 'post-scan-composition-' + (cancelling ? 'cancel-' : music ? 'music-' : '') + randomUUID());
  const recording = await recordOracle({ project: 'tests/library/fixtures/post-scan-composition/Oracle.csproj', output,
    args: [fileURLToPath(scenarioFile), '{output}/native.json', '{output}/cases'] });
  assert.equal(recording.passed, true);
  const nativeBytes = await readFile(path.join(output, 'native.json'));
  const native = parseLosslessJson(nativeBytes.toString('utf8'));
  assert.equal(native.inputSha256, hash(inputBytes));
  assert.equal(native.results.length, 1);
  const recordedOutput = recording.outputs.find(file => path.basename(file.filename) === 'native.json');
  assert.equal(recordedOutput.sha256, hash(nativeBytes));
  assert.ok(native.assemblies.some(assembly => assembly.name === 'jellyfin' && assembly.sha256 === recording.jellyfinDll.sha256),
    'The helper actually loads the Jellyfin assembly supplied by this CI build.');

  const sample = native.results[0], before = sample.before.sql.result, expected = sample.observation.Sql.result;
  assert.deepEqual(sample.providerControls, { metadataProviders: [], imageProviders: [], metadataSavers: [] });
  assert.deepEqual(sample.discovered, sample.instantiated);
  assert.deepEqual(sample.instantiated.map(name => name.split('.').at(-1)), nativeTasks);
  assert.deepEqual(sample.Cancel, scenario.Cancel ?? null);
  if (cancelling) assert.match(sample.observation.Exception ?? '', /^System\.(?:OperationCanceledException|Threading\.Tasks\.TaskCanceledException)$/u,
    sample.observation.ExceptionMessage ?? 'The actual metadata service must propagate its cancellation.');
  else assert.equal(sample.observation.Exception, null, sample.observation.ExceptionMessage);
  assert.equal(sample.observation.ScanRunning, false);
  assert.deepEqual(sample.release, { completed: true, resources: ['scheduler', 'provider', 'plugins', 'services', 'cache-and-tokens'] });
  const logs = sample.observation.Trace.filter(event => event.action === 'log').map(event => event.detail);
  assert.deepEqual(logs.filter(event => event.level === 'Error' || event.level === 'Critical'), [], 'An internally swallowed native task failure is still a test failure.');
  const expectedCompleted = cancelling ? nativeTasks.slice(0, 6) : nativeTasks;
  assert.deepEqual(logs.map(event => /^Post-scan task (\w+) completed after /u.exec(event.message)?.[1]).filter(Boolean), expectedCompleted);
  assert.deepEqual(sample.observation.Trace.filter(event => event.action === 'metadata-completed' && byNameTypes.includes(event.detail.item.type))
    .map(event => event.detail.item.type).sort(), refreshedTypes.sort(),
  'Only successfully refreshed by-name items complete their real metadata service.');
  assert.ok(sample.before.files.length >= 6, 'Native cleanup starts with real source, internal and extracted marker files.');
  if (cancelling) {
    assert.deepEqual(logs.map(event => /^Running post-scan task \d+\/\d+: (\w+)$/u.exec(event.message)?.[1]).filter(Boolean), nativeTasks.slice(0, 7));
    assert.deepEqual(logs.map(event => /^Post-scan task (\w+) cancelled after /u.exec(event.message)?.[1]).filter(Boolean), ['StudiosPostScanTask']);
    const requests = sample.observation.Trace.filter(event => event.action === 'cancel-request');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].detail.channel, 'metadata-before');
    assert.equal(requests[0].detail.item.type, byNameTypes[1]);
    const cancelled = sample.observation.Trace.filter(event => event.action === 'metadata-cancelled');
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0].detail.cancelled, true);
    assert.equal(cancelled[0].detail.item.type, byNameTypes[1]);
    assert.equal(sample.observation.Trace.some(event => event.action.startsWith('inherited-cleanup-')), false);
    assert.deepEqual(sample.observation.Trace.filter(event => ['monitor-Stop', 'monitor-Start'].includes(event.action))
      .map(event => event.action), ['monitor-Stop', 'monitor-Start']);
    assert.ok(sample.files.length > 0 && sample.files.length < sample.before.files.length,
      'Genre cleanup commits before cancellation leaves the Studio cleanup files intact.');
    assert.ok(sample.files.every(file => sample.before.files.some(before => before.path === file.path && before.sha256 === file.sha256)));
    const studio = expected.BaseItems.find(row => row.Type === byNameTypes[1] && row.Name === sample.seed.Studio);
    assert.ok(studio, 'GetStudio commits the new entity before the refresh sees cancellation.');
    assert.ok(studio.DateLastRefreshed == null || dateText(studio.DateLastRefreshed).startsWith('0001-01-01'));
    const studioCreation = sample.observation.Trace.find(event => event.action === 'save-committed'
      && event.detail.items.some(item => item.type === byNameTypes[1] && item.Name === sample.seed.Studio));
    assert.ok(studioCreation && studioCreation.ordinal < requests[0].ordinal);
    assert.equal(studioCreation.detail.sql.result.ItemValues.some(row => idKey(row.ItemValueId) === idKey(sample.orphanValueId)), false,
      'The earlier Genre deletion has already removed the orphan before the Studio cancellation.');
  } else assert.deepEqual(sample.files, [], 'The native operation deletes every seeded cleanup marker.');
  assert.equal(sample.createdDirectories.length, 2 + artistNames.length + musicGenreNames.length);
  assert.ok(sample.createdDirectories.every(entry => entry.exists));
  assert.ok(before.ItemValues.some(row => idKey(row.ItemValueId) === idKey(sample.orphanValueId)));
  assert.equal(expected.ItemValues.some(row => idKey(row.ItemValueId) === idKey(sample.orphanValueId)), false,
    'ItemPersistenceService.DeleteItem removes globally unmapped values during committed by-name cleanup.');
  assert.deepEqual(expected.BaseItems.filter(row => byNameTypes.includes(row.Type)).map(row => row.Name).sort(),
    [sample.seed.Genre, sample.seed.Studio, ...artistNames, ...musicGenreNames, ...(cancelling ? [sample.seed.DeadStudio] : [])].sort());
  if (music) {
    assert.ok(sample.observation.MetadataServiceTypes.includes('MediaBrowser.Providers.Music.ArtistMetadataService'));
    assert.ok(sample.observation.MetadataServiceTypes.includes('MediaBrowser.Providers.MusicGenres.MusicGenreMetadataService'));
    const initialAudio = before.BaseItems.filter(row => row.Type === 'MediaBrowser.Controller.Entities.Audio.Audio');
    const byName = (left, right) => left.Name < right.Name ? -1 : left.Name > right.Name ? 1 : 0;
    assert.deepEqual(initialAudio.map(row => ({ Name: row.Name, Artists: row.Artists.split('|'), AlbumArtists: row.AlbumArtists.split('|'),
      Genres: row.Genres.split('|'), RunTimeTicks: Number(row.RunTimeTicks) })).sort(byName), [...music.Tracks].sort(byName),
    'Audio children come from actual native persistence, with both artist-name relation kinds.');
    const musicTask = sample.observation.Trace.find(event => event.action === 'log'
      && /^Running post-scan task \d+\/\d+: MusicGenresPostScanTask$/u.test(event.detail.message));
    assert.ok(musicTask);
    for (const name of artistNames) {
      const artist = expected.BaseItems.find(row => row.Type === artistType && row.Name === name);
      const tracks = music.Tracks.filter(track => track.Artists.includes(name) || track.AlbumArtists.includes(name));
      assert.equal(BigInt(artist.RunTimeTicks), tracks.reduce((sum, track) => sum + BigInt(track.RunTimeTicks), 0n));
      assert.deepEqual(artist.Genres.split('|').sort(), [...new Set(tracks.flatMap(track => track.Genres))].sort());
      assert.ok(dateText(artist.DateLastRefreshed) && !dateText(artist.DateLastRefreshed).startsWith('0001-01-01'));
      const refresh = sample.observation.Trace.find(event => event.action === 'metadata-completed'
        && idKey(event.detail.item.id) === idKey(artist.Id));
      assert.ok(refresh && refresh.ordinal < musicTask.ordinal, 'Actual Artist refresh commits before the MusicGenres task starts.');
    }
    assert.deepEqual(expected.BaseItems.filter(row => row.Type === ordinaryByNameTypes[0]).map(row => row.Name), [sample.seed.Genre],
      'Music-only category names must not be turned into ordinary Genre entities.');
    const deadArtist = before.BaseItems.find(row => row.Type === artistType && row.Name === music.DeadArtist);
    assert.ok(deadArtist);
    const artistSourceMarker = path.relative(sample.programRoot, path.join(deadArtist.Path, 'source.txt')).replaceAll('\\', '/');
    assert.ok(sample.before.files.some(file => file.path === artistSourceMarker), 'The dead Artist starts with a real source marker.');
    assert.equal(expected.BaseItems.some(row => idKey(row.Id) === idKey(deadArtist.Id)), false);
    assert.ok(sample.observation.Trace.some(event => event.action === 'removed' && idKey(event.detail.item.id) === idKey(deadArtist.Id)));
  }

  const programRoot = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-post-scan-'));
  let database, runtime;
  t.after(async () => {
    const errors = [], released = [];
    for (const [name, close] of [['runtime', () => runtime?.close()], ['database', () => dropPostgresTestDatabase(database)], ['program-root', async () => {
      assert.equal(path.dirname(path.resolve(programRoot)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(programRoot).startsWith('mediamanager-post-scan-'));
      await rm(programRoot, { recursive: true, force: true });
    }]]) try { await close(); released.push(name); } catch (error) { errors.push(error); }
    await writeFile(path.join(output, 'cleanup.json'), JSON.stringify({ completed: errors.length === 0, released,
      databaseClosed: database?.closed ?? null, errors: errors.map(error => error.stack ?? String(error)) }, null, 2) + '\n', { flag: 'wx' });
    if (errors.length) throw new AggregateError(errors, 'Post-scan composition cleanup failed.');
  });
  database = await createPostgresTestDatabase(null, 'post_scan', { max: 1 });
  const errors = [], events = [], started = [], completed = [], metadata = [], monitor = [], cancelRequests = [];
  const controller = new AbortController();
  runtime = await createRuntime({ database, programDataPath: programRoot,
    configurationDirectoryPath: path.join(programRoot, 'config'), serverId: 'post-scan-composition',
    configuration: { UICulture: 'en-US', MetadataCountryCode: 'US', IsStartupWizardCompleted: true,
      EnableCaseSensitiveItemIds: true, EnableNormalizedItemByNameIds: true, LibraryScanFanoutConcurrency: 1 },
    onError: error => errors.push(String(error?.stack ?? error)) });
  // Match the native host's explicit empty provider/saver lists through the
  // actual plugin lifecycle. Keep storage plugins and their application mounts.
  const storageTypes = runtime.plugins.entries('storage').map(extension => extension.type).sort();
  for (const id of ['nfo', 'tmdb']) await runtime.plugins.setEnabled(id, false);
  const refreshedItemTypes = new Set(['AggregateFolder', 'UserRootFolder', 'CollectionFolder', 'Folder',
    ...byNameTypes.map(type => type.split('.').at(-1))]);
  const providerControls = {
    plugins: runtime.plugins.list().map(({ id, enabled, status, extensions }) => ({ id, enabled, status, extensions })),
    storageTypes: runtime.plugins.entries('storage').map(extension => extension.type).sort(),
    externalMetadataPlugins: runtime.plugins.entries('metadata').map(extension => extension.id),
    relevantProviders: runtime.metadata.registry.plugins().flatMap(extension => extension.providers)
      .filter(provider => ['local', 'remote', 'custom', 'image', 'saver'].includes(provider.kind)
        && provider.itemTypes.some(type => type === '*' || refreshedItemTypes.has(type)))
      .map(({ id, kind, itemTypes }) => ({ id, kind, itemTypes }))
  };
  await writeFile(path.join(output, 'provider-controls.json'), JSON.stringify(providerControls, null, 2) + '\n', { flag: 'wx' });
  assert.ok(providerControls.storageTypes.includes('local'));
  assert.deepEqual(providerControls.storageTypes, storageTypes, 'Disabling metadata plugins preserves actual application storage.');
  assert.deepEqual(providerControls.externalMetadataPlugins, []);
  assert.deepEqual(providerControls.relevantProviders, [], 'The candidate has the same empty external provider/image/saver controls as native.');
  const initialIds = new Set(sample.fixtureIds.map(idKey));
  for (const row of [...before.BaseItems, ...expected.BaseItems]) assert.deepEqual(Object.keys(row).sort(), itemColumns.map(column => column.name).sort());
  const rebase = value => typeof value === 'string' ? value.replaceAll(sample.programRoot, programRoot)
    .replaceAll(JSON.stringify(sample.programRoot).slice(1, -1), JSON.stringify(programRoot).slice(1, -1)) : value;
  await runtime.store.transaction(async db => {
    for (const row of before.BaseItems.filter(row => initialIds.has(idKey(row.Id)))) {
      await db.insert('BaseItems', Object.fromEntries(itemColumns.map(column => {
        let value = rebase(row[column.name]);
        if (value != null && column.clrType.includes('Guid')) value = nativeGuid(value);
        return [column.name, value];
      })));
    }
    for (const name of ['ItemValues', 'ItemValuesMap']) for (const row of before[name]) {
      await db.insert(name, Object.fromEntries(tableDefinition(name).columns.map(column => {
        const value = row[column.name];
        return [column.name, value != null && column.clrType.includes('Guid') ? nativeGuid(value) : value];
      })));
    }
  });
  for (const file of sample.before.files) {
    const filename = path.resolve(programRoot, file.path), relative = path.relative(programRoot, filename);
    assert.ok(relative && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    assert.ok(file.path.startsWith('metadata/') || file.path.startsWith('data/'));
    const bytes = Buffer.from(file.content, 'base64'); assert.equal(hash(bytes), file.sha256);
    await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes, { flag: 'wx' });
  }
  assert.deepEqual(await stateFiles(programRoot), rewrite(sample.before.files, sample.programRoot));
  for (const [name, action] of [['ItemAdded', 'added'], ['ItemRemoved', 'removed']]) runtime.library.on(name, ({ Item }) => {
    if (initialIds.has(idKey(Item.Id)) || byNameTypes.includes(Item.NativeType)) events.push({ action, id: idKey(Item.Id), name: Item.Name });
  });
  const tasks = runtime.libraryScanLifecycle.postScanTasks;
  assert.deepEqual(tasks.map(task => task.constructor.name), nativeTasks.map(name => name === 'CleanDatabaseScheduledTask' ? 'CleanDatabasePostScanTask' : name));
  for (const task of tasks) {
    const run = task.run.bind(task);
    task.run = async options => { started.push(task.constructor.name); const result = await run(options); completed.push(task.constructor.name); return result; };
  }
  for (const method of ['stop', 'start']) {
    const call = runtime.libraryMonitor[method].bind(runtime.libraryMonitor);
    runtime.libraryMonitor[method] = async (...args) => { const result = await call(...args); monitor.push(method); return result; };
  }
  let inheritedCleanup = 0;
  const inherited = runtime.libraryScanHost.updateInheritedValues.bind(runtime.libraryScanHost);
  runtime.libraryScanHost.updateInheritedValues = async (...args) => { inheritedCleanup++; return inherited(...args); };
  const refresh = runtime.metadataScanner.refreshItem.bind(runtime.metadataScanner);
  runtime.metadataScanner.refreshItem = async (reference, options) => {
    const id = idKey(typeof reference === 'string' ? reference : reference.Id);
    if (cancelling && events.some(event => event.action === 'added' && event.id === id && event.name === sample.seed.Studio)) {
      assert.equal(options.signal, controller.signal, 'The actual post-scan task must carry the global scan signal.');
      cancelRequests.push({ id, channel: 'metadata-before' });
      controller.abort();
    }
    // Forward even after abort: the real refresh lifecycle decides the outcome.
    const result = await refresh(reference, options); metadata.push(id); return result;
  };
  const refreshLive = runtime.metadataScanner.refreshLiveItem.bind(runtime.metadataScanner);
  runtime.metadataScanner.refreshLiveItem = async (item, options) => {
    assert.equal(options.signal, controller.signal, 'Artist live refresh carries the global scan signal.');
    const result = await refreshLive(item, options); metadata.push(idKey(item.Id)); return result;
  };
  errors.length = 0;
  const start = Date.now();
  let failure;
  try { await runtime.libraryScanLifecycle.run({ signal: controller.signal }); } catch (error) { failure = error; }
  const end = Date.now();
  const rows = await database.rows('BaseItems'), values = await database.rows('ItemValues'), maps = await database.rows('ItemValuesMap');
  const files = await stateFiles(programRoot);
  const temporaryTables = (await database.client.query(`SELECT relname FROM pg_class WHERE relnamespace = pg_my_temp_schema() ORDER BY relname`)).rows;
  await writeFile(path.join(output, 'candidate.json'), JSON.stringify({ startedAt: new Date(start).toISOString(), completedAt: new Date(end).toISOString(),
    programRoot, providerControls, started, completed, events, metadata, monitor, cancelRequests, inheritedCleanup, temporaryTables,
    errors, failure: failure?.stack ?? null, failureName: failure?.name ?? null, sql: { BaseItems: rows, ItemValues: values, ItemValuesMap: maps },
    files, nativeSha256: hash(nativeBytes), record: path.join(output, 'record.json') },
  (_, value) => typeof value === 'bigint' ? JSON.rawJSON(String(value)) : value, 2) + '\n', { flag: 'wx' });
  if (cancelling) {
    assert.equal(failure?.name, 'AbortError', failure?.stack);
    assert.equal(failure, controller.signal.reason, 'The cancellation reason propagates through refresh, task and scan without substitution.');
    assert.equal(cancelRequests.length, 1);
    assert.deepEqual(started, nativeTasks.slice(0, 7));
    assert.equal(inheritedCleanup, 0);
    assert.deepEqual(temporaryTables, [], 'Cancelled by-name SQL snapshots must be released before the only pooled connection is reused.');
    assert.deepEqual(monitor, ['stop', 'start'], 'Cancellation still completes the scan monitor finally block.');
  } else {
    assert.equal(failure, undefined, failure?.stack);
    assert.equal(inheritedCleanup, 1);
    assert.deepEqual(temporaryTables, [], 'Successful post-scan SQL snapshots must be released before the only pooled connection is reused.');
    assert.deepEqual(monitor, ['stop', 'start']);
  }
  assert.deepEqual(errors, [], 'Internally logged candidate failures must not pass the composition check.');
  assert.deepEqual(completed, expectedCompleted.map(name => name === 'CleanDatabaseScheduledTask' ? 'CleanDatabasePostScanTask' : name));
  assert.equal(runtime.libraryScanLifecycle.isScanRunning, false);
  const actual = rowsForComparison(rows, { root: programRoot, initialIds, byNameTypes, start, end, expandPath: runtime.library.options.expandPath });
  const wanted = rowsForComparison(expected.BaseItems, { root: sample.programRoot, initialIds, byNameTypes,
    start: Date.parse(sample.startedAt), end: Date.parse(sample.completedAt) });
  assert.deepEqual(actual, wanted, 'All persistent columns of the source and by-name entities match the current native operation.');
  const order = rows => rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  for (const name of ['ItemValues', 'ItemValuesMap']) {
    const normalize = rows => order(rows.map(row => Object.fromEntries(tableDefinition(name).columns.map(column =>
      [column.name, rewrite(row[column.name], programRoot)]))));
    assert.deepEqual(normalize(name === 'ItemValues' ? values : maps), normalize(expected[name]), name);
  }
  const nativeEvents = sample.observation.Trace.filter(event => ['added', 'removed'].includes(event.action)
    && (initialIds.has(idKey(event.detail.item.id)) || byNameTypes.includes(event.detail.item.type)))
    .map(event => ({ action: event.action, id: idKey(event.detail.item.id), name: event.detail.item.Name }));
  assert.deepEqual(events, nativeEvents);
  const nativeRefreshed = sample.observation.Trace.filter(event => event.action === 'metadata-completed' && byNameTypes.includes(event.detail.item.type))
    .map(event => idKey(event.detail.item.id)).sort();
  assert.deepEqual(metadata.filter(id => rows.some(row => idKey(row.Id) === id && byNameTypes.includes(row.Type))).sort(), nativeRefreshed,
    'Successful metadata refreshes match the native committed prefix.');
  assert.deepEqual(files, rewrite(sample.files, sample.programRoot));
  for (const entry of sample.createdDirectories) assert.equal((await stat(path.join(programRoot, entry.path))).isDirectory(), entry.exists);
  assert.equal(runtime.libraryScanner.capabilities.completeLibraryScan, false, 'This narrow nonempty scenario does not admit all media families or release capabilities.');
  await writeFile(path.join(output, 'comparison.json'), JSON.stringify({ passed: true, scope: sample.Name,
    cancelled: cancelling, rows: actual, nativeSha256: hash(nativeBytes), candidate: 'candidate.json', cleanup: 'cleanup.json' }, null, 2) + '\n', { flag: 'wx' });
}

const options = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 300000 };
test('postgres: current native eight-task global scan creates and cleans nonempty by-name state', options,
  t => compareComposition(t, inputFile));
test('postgres: cancelling the real Studio refresh preserves the eight-task committed prefix and releases resources', options,
  t => compareComposition(t, cancellationInputFile));
test('postgres: native Artist child aggregation and MusicGenres persist inside the real eight-task scan', options,
  t => compareComposition(t, musicInputFile));
