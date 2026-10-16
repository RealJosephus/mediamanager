import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../../src/runtime.js';
import { tableDefinition } from '../../src/database/model.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { dateText, EMPTY_ID, idKey } from '../../src/library/records.js';
import { nativeGuid } from '../../src/users/native.js';
import { createMetadataChildren } from '../../src/library/metadata-children.js';
import { cachedFolderChildrenSnapshot, setFolderChildren } from '../../src/library/folder-cache.js';
import { fixturePathStyle } from '../library/fixture-state-path.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const inputFile = new URL('../library/fixtures/post-scan-composition/series-cleanup-input.json', import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const columns = tableDefinition('BaseItems').columns;
const relationNames = ['AncestorIds', 'LinkedChildren', 'ItemValues', 'ItemValuesMap',
  'MediaStreamInfos', 'AttachmentStreamInfos', 'MediaSegments'];
const id = number => 'ba400000-0000-0000-0000-' + String(number).padStart(12, '0');
const json = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? JSON.rawJSON(String(entry)) : entry, 2) + '\n';

function project(value, root) {
  if (Array.isArray(value)) return value.map(entry => project(entry, root));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, project(entry, root)]));
  if (typeof value === 'bigint') { assert.ok(Number.isSafeInteger(Number(value))); return Number(value); }
  if (typeof value !== 'string') return value;
  if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/iu.test(value)) return idKey(value);
  if (value === root || value.startsWith(root + path.sep)) return '$PROGRAM' + value.slice(root.length).replaceAll('\\', '/');
  return value;
}

function projectRows(rows, initial, root, start, end, expandPath = value => value) {
  const initialById = new Map(initial.map(row => [idKey(row.Id), row]));
  return rows.filter(row => initialById.has(idKey(row.Id))).map(row => {
    const before = initialById.get(idKey(row.Id));
    const saveChanged = dateText(row.DateLastSaved) !== dateText(before.DateLastSaved);
    return Object.fromEntries(columns.map(column => {
      let value = row[column.name];
      if (value == null) return [column.name, null];
      if (column.name === 'Data') {
        value = parseLosslessJson(value);
        if (saveChanged && value.DateLastSaved != null) {
          assert.equal(dateText(value.DateLastSaved), dateText(row.DateLastSaved));
          value.DateLastSaved = '$DateLastSaved';
        }
      } else if (column.clrType.includes('DateTime')) {
        value = dateText(value);
        if (value !== dateText(before[column.name])) {
          assert.ok(['DateLastSaved', 'DateLastRefreshed'].includes(column.name), `Unexpected changed clock: ${column.name}`);
          const instant = Date.parse(value);
          assert.ok(instant >= start - 1000 && instant <= end + 1000, `The changed ${column.name} belongs to the actual operation.`);
          value = '$' + column.name;
        }
      } else if (column.name === 'Path') value = expandPath(value);
      else if (column.clrType.replace('?', '') === 'bool') value = Boolean(value);
      return [column.name, project(value, root)];
    }));
  }).sort((left, right) => left.Id.localeCompare(right.Id));
}

async function files(root) {
  const result = [];
  const visit = async directory => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      assert.equal(entry.isSymbolicLink(), false);
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) {
        const bytes = await readFile(filename);
        result.push({ path: path.relative(root, filename).replaceAll('\\', '/'), bytes: bytes.length,
          sha256: hash(bytes), content: bytes.toString('base64') });
      }
    }
  };
  await visit(path.join(root, 'metadata')); await visit(path.join(root, 'data'));
  return result.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

test('postgres: actual Series cleanup promotes a linked episode and reroutes its Playlist through ordinary deletion', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 180000
}, async t => {
  const inputBytes = await readFile(inputFile), scenario = JSON.parse(inputBytes)[0];
  const output = path.join(validationOutputRoot(), 'series-cleanup-runtime-' + randomUUID());
  const receipt = await recordOracle({ project: 'tests/library/fixtures/post-scan-composition/Oracle.csproj', output,
    args: [fileURLToPath(inputFile), '{output}/native.json', '{output}/cases'] });
  const nativeBytes = await readFile(path.join(output, 'native.json')), native = parseLosslessJson(nativeBytes.toString('utf8'));
  assert.equal(receipt.passed, true); assert.equal(native.inputSha256, hash(inputBytes));
  assert.equal(receipt.outputs.find(file => path.basename(file.filename) === 'native.json').sha256, hash(nativeBytes));
  assert.ok(native.assemblies.some(assembly => assembly.name === 'jellyfin' && assembly.sha256 === receipt.jellyfinDll.sha256));
  assert.equal(native.results.length, 1);
  const { observation: expected, release } = native.results[0];
  assert.equal(expected.Name, scenario.Name); assert.deepEqual(expected.SeriesCleanup, scenario.SeriesCleanup);
  assert.equal(expected.after.exception, null, expected.after.exception);
  assert.deepEqual(release, { completed: true, resources: ['scheduler', 'provider', 'recordings', 'media-sources', 'plugins', 'services', 'cache-and-tokens'] });
  assert.deepEqual(expected.providerControls, { metadataProviders: [], imageProviders: [], metadataSavers: [] });
  assert.equal(expected.recordingControls.managerType, 'Jellyfin.LiveTv.Recordings.RecordingsManager');
  assert.deepEqual(expected.recordingControls.episodes.map(episode => ({ ...episode, id: idKey(episode.id) })),
    [3, 4].map(number => ({ id: idKey(id(number)), activeRecording: false, sourceType: 'Library' })));
  assert.deepEqual(expected.mediaServices, {
    sources: 'Emby.Server.Implementations.Library.MediaSourceManager',
    segments: 'Jellyfin.Server.Implementations.MediaSegments.MediaSegmentManager'
  });
  const before = expected.before.sql.result, after = expected.after.sql.result;
  for (const table of ['MediaStreamInfos', 'AttachmentStreamInfos', 'MediaSegments']) assert.deepEqual(before[table], [],
    'The metadata-only fixture has no probed media or extracted segment state.');
  const initialIds = new Set(expected.fixtureIds.map(idKey));
  assert.equal(initialIds.size, 5);
  const nativeEpisode = before.BaseItems.find(row => idKey(row.Id) === idKey(id(3)));
  assert.equal(nativeEpisode.IndexNumber, null); assert.equal(Boolean(nativeEpisode.IsVirtualItem), true);
  assert.ok(before.LinkedChildren.some(row => idKey(row.ParentId) === idKey(id(3)) && idKey(row.ChildId) === idKey(id(4)) && row.ChildType === 3));
  assert.ok(before.LinkedChildren.some(row => idKey(row.ParentId) === idKey(id(5)) && idKey(row.ChildId) === idKey(id(3)) && row.ChildType === 0));
  assert.equal(after.BaseItems.some(row => idKey(row.Id) === idKey(id(3))), false);
  const promoted = after.BaseItems.find(row => idKey(row.Id) === idKey(id(4)));
  assert.ok(promoted); assert.ok(promoted.PrimaryVersionId == null || idKey(promoted.PrimaryVersionId) === idKey(EMPTY_ID));
  assert.equal(expected.after.removedLookupAbsent, true);
  assert.deepEqual(expected.after.playlistLinks.map(idKey), [idKey(id(4))]);
  assert.equal(expected.before.parentUserDataPresent, true);
  assert.deepEqual(expected.after.removal.map(({ id: removedId, parentId, parentChildrenCleared, parentUserDataCleared }) =>
    ({ id: idKey(removedId), parentId: idKey(parentId), parentChildrenCleared, parentUserDataCleared })),
  [{ id: idKey(id(3)), parentId: idKey(id(2)), parentChildrenCleared: true, parentUserDataCleared: true }]);
  const nativeErrors = expected.after.trace.filter(event => event.action === 'log' && ['Error', 'Critical'].includes(event.detail.level));
  assert.deepEqual(nativeErrors, [], 'An internally logged native failure is not a passing cleanup.');
  const nativeDeletion = expected.after.trace.find(event => event.action === 'delete-begin');
  assert.ok(nativeDeletion);
  assert.ok(nativeDeletion.detail.sql.result.LinkedChildren.some(row => idKey(row.ParentId) === idKey(id(5))
    && idKey(row.ChildId) === idKey(id(4))), 'Playlist rerouting precedes native SQL deletion.');

  const programRoot = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-series-cleanup-'));
  let database, runtime;
  const owners = [];
  t.after(async () => {
    const errors = [], released = [];
    for (const [name, close] of [['owners', () => { for (const owner of owners) owner.release(); }],
      ['runtime', () => runtime?.close()], ['database', () => dropPostgresTestDatabase(database)], ['program-root', async () => {
        assert.equal(path.dirname(path.resolve(programRoot)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(programRoot).startsWith('mediamanager-series-cleanup-'));
        await rm(programRoot, { recursive: true, force: true });
      }]]) try { await close(); released.push(name); } catch (error) { errors.push(error); }
    await writeFile(path.join(output, 'cleanup.json'), json({ completed: errors.length === 0, released,
      databaseClosed: database?.closed ?? null, errors: errors.map(error => error.stack ?? String(error)) }), { flag: 'wx' });
    if (errors.length) throw new AggregateError(errors, 'Series cleanup fixture failed to release resources.');
  });
  const mediaRoot = path.join(programRoot, 'data', 'series-cleanup-media');
  await mkdir(mediaRoot, { recursive: true });
  const storageConfiguration = path.join(programRoot, 'storage.json');
  await writeFile(storageConfiguration, json({
    instances: [{ id: 'series-media', type: 'local', config: { root: mediaRoot, writable: true } }],
    mounts: [{ path: '/series-media', instanceId: 'series-media', capabilities: {} }],
    prefixes: [{ identityRoot: mediaRoot, accessRoot: '/series-media', style: fixturePathStyle,
      returnAccess: 'Actual isolated source bytes retained by metadata-only deletion.', purpose: 'library' }]
  }));
  database = await createPostgresTestDatabase(null, 'series_cleanup', { max: 1 });
  const errors = [];
  runtime = await createRuntime({ database, programDataPath: programRoot,
    configurationDirectoryPath: path.join(programRoot, 'config'), storageConfiguration, serverId: 'series-cleanup',
    configuration: { UICulture: 'en-US', MetadataCountryCode: 'US', IsStartupWizardCompleted: true,
      EnableCaseSensitiveItemIds: true, EnableNormalizedItemByNameIds: true, LibraryScanFanoutConcurrency: 1 },
    onError: error => errors.push(error?.stack ?? String(error)) });
  for (const plugin of ['nfo', 'tmdb']) await runtime.plugins.setEnabled(plugin, false);
  const providers = runtime.metadata.registry.plugins().flatMap(extension => extension.providers);
  const providerControls = { storageTypes: runtime.plugins.entries('storage').map(extension => extension.type).sort(),
    externalMetadataPlugins: runtime.plugins.entries('metadata').map(extension => extension.id),
    relevantProviders: providers.filter(provider => ['local', 'remote', 'custom', 'image'].includes(provider.kind)
      && provider.itemTypes.some(type => type === '*' || type === 'Series') || provider.kind === 'saver'
      && provider.itemTypes.some(type => ['*', 'Series', 'Season', 'Episode', 'Playlist'].includes(type)))
      .map(({ id, kind, itemTypes }) => ({ id, kind, itemTypes })) };
  await writeFile(path.join(output, 'provider-controls.json'), json(providerControls), { flag: 'wx' });
  assert.ok(providerControls.storageTypes.includes('local'));
  assert.deepEqual(providerControls.externalMetadataPlugins, []); assert.deepEqual(providerControls.relevantProviders, []);
  const rebase = value => typeof value === 'string' ? value.replaceAll(expected.programRoot, programRoot)
    .replaceAll(JSON.stringify(expected.programRoot).slice(1, -1), JSON.stringify(programRoot).slice(1, -1)) : value;
  const relevant = (table, rows) => table === 'AncestorIds' ? rows.filter(row => initialIds.has(idKey(row.ItemId)))
    : table === 'LinkedChildren' ? rows.filter(row => initialIds.has(idKey(row.ParentId)) || initialIds.has(idKey(row.ChildId))) : rows;
  await runtime.store.transaction(async db => {
    for (const row of before.BaseItems.filter(row => initialIds.has(idKey(row.Id)))) {
      assert.deepEqual(Object.keys(row).sort(), columns.map(column => column.name).sort());
      await db.insert('BaseItems', Object.fromEntries(columns.map(column => {
        let value = rebase(row[column.name]);
        if (value != null && column.clrType.includes('Guid')) value = nativeGuid(value);
        return [column.name, value];
      })));
    }
    for (const table of relationNames) for (const row of relevant(table, before[table])) await db.insert(table,
      Object.fromEntries(tableDefinition(table).columns.map(column => {
        const value = rebase(row[column.name]);
        return [column.name, value != null && column.clrType.includes('Guid') ? nativeGuid(value) : value];
      })));
  });
  for (const file of expected.before.files) {
    assert.ok(file.path.startsWith('metadata/') || file.path.startsWith('data/'));
    const filename = path.resolve(programRoot, file.path), relative = path.relative(programRoot, filename);
    assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    const bytes = Buffer.from(file.content, 'base64'); assert.equal(hash(bytes), file.sha256);
    await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes, { flag: 'wx' });
  }
  assert.deepEqual(await files(programRoot), expected.before.files);
  const creator = runtime.itemCreation;
  const season = await creator.getItemById(id(2)), playlist = await creator.getItemById(id(5));
  for (const item of [season, playlist]) owners.push(creator.retainItem(item));
  const childFactory = createMetadataChildren({ store: runtime.store, library: runtime.library, linkedChildren: runtime.linkedChildren });
  const childSequence = await childFactory.physical(season), children = [];
  try { for await (const page of childSequence.pages()) for (const child of page) { children.push(child); owners.push(creator.retainItem(child)); } }
  finally { await childSequence.close(); }
  setFolderChildren(season, children); season.UserData = [];
  assert.deepEqual(children.map(item => idKey(item.Id)), expected.before.parentChildren.map(idKey));
  const episodeSources = children.map(item => ({ id: idKey(item.Id), sourceType: item.SourceType }))
    .sort((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(episodeSources, expected.recordingControls.episodes.map(({ id, sourceType }) => ({ id: idKey(id), sourceType })));
  const removal = [], events = [];
  for (const [event, action] of [['ItemAdded', 'added'], ['ItemUpdated', 'updated'], ['ItemRemoved', 'removed']]) runtime.library.on(event, ({ Item, Parent }) => {
    if (initialIds.has(idKey(Item.Id))) events.push({ action, id: idKey(Item.Id), parentId: Parent ? idKey(Parent.Id) : null });
    if (event === 'ItemRemoved' && idKey(Item.Id) === idKey(id(3))) removal.push({ id: idKey(Item.Id), parentId: idKey(Parent.Id),
      parentChildrenCleared: cachedFolderChildrenSnapshot(season) == null, parentUserDataCleared: season.UserData == null });
  });
  const initialRows = await database.rows('BaseItems');
  const startedAt = Date.now(); let failure, result;
  try { result = await runtime.metadata.refresh(id(1), { MetadataRefreshMode: 'None', ImageRefreshMode: 'None' }); }
  catch (error) { failure = error; }
  const completedAt = Date.now(), rows = await database.rows('BaseItems'), relations = {};
  for (const table of relationNames) relations[table] = await database.rows(table);
  const playlistLinks = [];
  for await (const page of runtime.linkedChildren.pages(playlist.LinkedChildren)) for (const link of page) playlistLinks.push(idKey(link.ItemId));
  const temporaryTables = (await database.client.query('SELECT relname FROM pg_class WHERE relnamespace = pg_my_temp_schema() ORDER BY relname')).rows;
  const candidateFiles = await files(programRoot);
  const removedLookupAbsent = await creator.getItemById(id(3)) == null;
  await writeFile(path.join(output, 'candidate.json'), json({ programRoot, startedAt, completedAt, providerControls, episodeSources,
    failure: failure?.stack ?? null, updateType: result?.UpdateType ?? null, errors, events, removal, removedLookupAbsent,
    playlistLinks, temporaryTables, sql: { BaseItems: rows, ...relations }, files: candidateFiles, nativeSha256: hash(nativeBytes) }), { flag: 'wx' });
  assert.equal(failure, undefined, failure?.stack); assert.deepEqual(errors, []);
  assert.equal(result.UpdateType, expected.after.updateType);
  assert.deepEqual(projectRows(rows, initialRows.filter(row => initialIds.has(idKey(row.Id))), programRoot, startedAt, completedAt, runtime.library.options.expandPath),
    projectRows(after.BaseItems, before.BaseItems.filter(row => initialIds.has(idKey(row.Id))), expected.programRoot,
      Date.parse(expected.startedAt), Date.parse(expected.completedAt)));
  for (const table of relationNames) {
    const normalize = (rows, root) => relevant(table, rows).map(row => Object.fromEntries(tableDefinition(table).columns
      .map(column => [column.name, project(row[column.name], root)]))).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    assert.deepEqual(normalize(relations[table], programRoot), normalize(after[table], expected.programRoot), table);
  }
  assert.deepEqual(events, expected.after.trace.filter(event => ['added', 'updated', 'removed'].includes(event.action)
    && initialIds.has(idKey(event.detail.item.id))).map(event => ({ action: event.action, id: idKey(event.detail.item.id),
    parentId: event.detail.parent == null ? null : idKey(event.detail.parent) })));
  assert.deepEqual(removal, expected.after.removal.map(({ id, parentId, parentChildrenCleared, parentUserDataCleared }) =>
    ({ id: idKey(id), parentId: idKey(parentId), parentChildrenCleared, parentUserDataCleared })));
  assert.equal(removedLookupAbsent, true); assert.deepEqual(playlistLinks, expected.after.playlistLinks.map(idKey));
  assert.deepEqual(candidateFiles, expected.after.files); assert.deepEqual(temporaryTables, []);
  const source = 'data/series-cleanup-media/Episode.mkv';
  assert.deepEqual(candidateFiles.find(file => file.path === source), expected.before.files.find(file => file.path === source));
  await writeFile(path.join(output, 'comparison.json'), json({ passed: true, name: scenario.Name,
    columns: columns.length, relations: relationNames, nativeSha256: hash(nativeBytes) }), { flag: 'wx' });
});
