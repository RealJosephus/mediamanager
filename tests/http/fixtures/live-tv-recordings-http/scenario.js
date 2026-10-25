import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SqliteDatabase } from '../../../../src/database/sqlite.js';
import { postgresTestRow } from '../../../database/postgres-fixture.js';
import { nativeGuid } from '../../../../src/users/native.js';

export const sha = value => createHash('sha256').update(value).digest('hex');
export const idKey = value => String(value).replaceAll('-', '').toLowerCase();
export const guid = value => nativeGuid(value);
export const tables = ['BaseItems', 'AncestorIds', 'UserData', 'Permissions', 'Preferences', 'BaseItemImageInfos', 'BaseItemProviders',
  'BaseItemMetadataFields', 'ItemValues', 'ItemValuesMap', 'LinkedChildren', 'MediaStreamInfos'];
const stable = rows => rows.map(row => JSON.stringify(row, (_key, value) => typeof value === 'bigint' ? String(value) : value)).sort();
export const databaseFilename = root => path.join(root, 'data/data/jellyfin.db');
export const snapshot = async database => Object.fromEntries(await Promise.all(tables.map(async table => [table, stable(await database.rows(table))])));
export async function sqliteSnapshot(root) {
  const source = new SqliteDatabase(databaseFilename(root), { readOnly: true, requireMigrationHistory: true });
  try { return await snapshot(source); } finally { source.close(); }
}
export async function stateFiles(root, graph) {
  const files = ['config/livetv.xml', 'data/data/livetv/timers.json', 'data/data/livetv/seriestimers.json'];
  const taskFiles = (await readdir(path.join(root, 'config/ScheduledTasks'))).filter(name => name.endsWith('.js')).sort();
  files.push(...taskFiles.map(name => 'config/ScheduledTasks/' + name));
  const entries = files.map(name => [name, path.join(root, name)]);
  for (const [name, filename] of Object.entries(graph.savedMediaSourceCaches ?? {})) entries.push(['channel-cache/' + name, filename]);
  for (const name of ['main', 'movies']) entries.push(['library/' + name + '/options.xml', path.join(graph.folders[name].collectionPath, 'options.xml')]);
  return Object.fromEntries(await Promise.all(entries.map(async ([name, filename]) => {
    const bytes = await readFile(filename);
    return [name, { bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString('base64') }];
  })));
}
export async function mediaFiles(graph) {
  return Object.fromEntries(await Promise.all(Object.entries(graph.files).map(async ([key, filename]) => {
    const bytes = await readFile(filename);
    return [key, { path: filename, bytes: bytes.length, sha256: sha(bytes) }];
  })));
}

/** Seed only a stopped private reference, after its real virtual-folder registration. */
export async function seedRecordings(root, mediaRoot, input, userRootId, folderDtos, originalSeed, directoryPreparation) {
  assert.equal(originalSeed?.beforeFirstNativeStartup, true, 'The original media paths must be prepared before native registration starts.');
  assert.equal(directoryPreparation?.beforeFirstNativeStartup, true, 'Recording roots must be nonempty before native registration starts.');
  const source = new SqliteDatabase(databaseFilename(root), { requireMigrationHistory: true });
  const graph = { ids: {}, files: { ...originalSeed.files, ...Object.fromEntries(Object.entries(directoryPreparation.files)
    .map(([name, entry]) => ['registration-' + name, entry.path])) }, folders: {}, userRootId: idKey(userRootId) };
  let serial = 1;
  const identity = () => guid('bc410000000000000000' + String(serial++).padStart(12, '0'));
  try {
    graph.seedRelocations = originalSeed.relocation.map(entry => ({ ...entry,
      afterNativeRegistration: source.rows('BaseItems', { where: { Path: entry.replacement } }),
      originalIdentityAfterRegistration: source.rows('BaseItems', { where: { Id: entry.Id } }) }));
    // Root validation may legitimately remove an unregistered synthetic child,
    // even with an existing path. Retain that observation rather than restoring
    // rows after native startup or pretending the original identity survived.
    const retainedBytes = await readFile(originalSeed.files.retainedSeed);
    assert.equal(retainedBytes.length, originalSeed.file.bytes);
    assert.equal(sha(retainedBytes), originalSeed.file.sha256);
    for (const entry of Object.values(directoryPreparation.files)) {
      const bytes = await readFile(entry.path); assert.equal(bytes.length, entry.bytes); assert.equal(sha(bytes), entry.sha256);
    }
    const rows = source.rows('BaseItems');
    const aggregate = rows.find(row => row.Type === 'MediaBrowser.Controller.Entities.AggregateFolder');
    assert.ok(aggregate, 'The actual native aggregate root must exist.');
    graph.aggregateId = aggregate.Id;
    for (const name of ['main', 'movies']) {
      const location = path.join(mediaRoot, name);
      const physical = rows.find(row => row.Path === location && row.IsFolder && row.Type === 'MediaBrowser.Controller.Entities.Folder');
      const collection = rows.find(row => row.Type === 'MediaBrowser.Controller.Entities.CollectionFolder'
        && JSON.parse(row.Data).PhysicalLocationsList?.includes(location));
      assert.ok(physical, 'Actual registration must persist the physical folder: ' + name);
      assert.ok(collection, 'Actual registration must persist the collection folder: ' + name);
      const dto = folderDtos.find(dto => idKey(dto.Id) === idKey(collection.Id));
      assert.equal(typeof dto?.Path, 'string', 'The actual folder DTO must expose its expanded state path.');
      graph.folders[name] = { path: location, physical: physical.Id, collection: collection.Id, collectionPath: dto.Path };
    }
    const outsidePath = path.join(mediaRoot, 'outside');
    await mkdir(outsidePath, { recursive: true });
    graph.folders.outside = { path: outsidePath, physical: identity() };
    const base = values => postgresTestRow('BaseItems', { Data: '{}', IsFolder: false, MediaType: 'Video',
      ChannelId: guid('00000000000000000000000000000000'), DateCreated: '2026-10-01 01:02:03.1234567',
      DateModified: '2026-10-01 01:02:04.1234567', DateLastSaved: '2026-10-01 01:02:05.1234567',
      RunTimeTicks: 54000000000n, ...values });
    const created = [base({ Id: graph.folders.outside.physical, Type: 'MediaBrowser.Controller.Entities.Folder',
      Name: 'Outside recordings', Path: outsidePath, ParentId: aggregate.Id, IsFolder: true, MediaType: 'Unknown',
      TopParentId: graph.folders.outside.physical })];
    graph.ids.series = identity(); graph.ids.season = identity(); graph.ids.channel = identity();
    for (const [key, type, name, parent] of [['series', 'TV.Series', 'Recorded series', graph.folders.main.physical],
      ['season', 'TV.Season', 'Season 1', graph.ids.series]]) {
      const location = path.join(mediaRoot, 'main', key);
      await mkdir(location, { recursive: true });
      created.push(base({ Id: graph.ids[key], Type: 'MediaBrowser.Controller.Entities.' + type, Name: name,
        CleanName: name.toLowerCase(), SortName: name.toLowerCase(), Path: location, ParentId: parent,
        TopParentId: graph.folders.main.physical, IsFolder: true, MediaType: 'Video', UnratedType: type.split('.')[1],
        PresentationUniqueKey: idKey(graph.ids[key]), ...(key === 'season' && { SeriesId: graph.ids.series, SeriesName: 'Recorded series', IndexNumber: 1 }) }));
    }
    created.push(base({ Id: graph.ids.channel, Type: 'MediaBrowser.Controller.Channels.Channel', Name: 'External source',
      MediaType: 'Unknown', IsFolder: true, ParentId: aggregate.Id, Data: '{"OriginalChannelName":"External source"}' }));
    for (const entry of input.items) {
      const Id = graph.ids[entry.key] = identity(), folder = graph.folders[entry.folder];
      const filename = path.join(folder.path, entry.key + '.mkv');
      const bytes = Buffer.from('Private retained recording fixture: ' + entry.key + '\n');
      await writeFile(filename, bytes, { flag: 'wx' }); graph.files[entry.key] = filename;
      created.push(base({ Id, Type: 'MediaBrowser.Controller.Entities.' + entry.type, Name: entry.name,
        CleanName: entry.name.toLowerCase(), SortName: entry.name.toLowerCase(), Path: filename,
        ParentId: entry.type === 'TV.Episode' ? graph.ids.season : folder.physical, TopParentId: folder.physical,
        PresentationUniqueKey: idKey(Id), IsVirtualItem: entry.virtual === true,
        IsMovie: entry.type === 'Movies.Movie', IsSeries: entry.type === 'TV.Episode',
        Genres: entry.genres ?? '', Tags: entry.tags ?? '', Size: BigInt(bytes.length),
        UnratedType: entry.type === 'TV.Episode' ? 'Series' : entry.type === 'Movies.Movie' ? 'Movie' : 'Other',
        DateCreated: '2026-10-' + String(entry.day).padStart(2, '0') + ' 01:02:03.1234567',
        ...(entry.channel && { ChannelId: graph.ids.channel }),
        ...(entry.type === 'TV.Episode' && { SeriesId: graph.ids.series, SeriesName: 'Recorded series',
          SeriesPresentationUniqueKey: idKey(graph.ids.series), SeasonId: graph.ids.season, SeasonName: 'Season 1',
          IndexNumber: 1, ParentIndexNumber: 1 }) }));
    }
    source.transaction(() => {
      for (const row of created) source.insert('BaseItems', row);
      for (const entry of input.items) {
        const folder = graph.folders[entry.folder], ancestors = [folder.physical];
        if (folder.collection) ancestors.push(folder.collection);
        if (entry.type === 'TV.Episode') ancestors.push(graph.ids.series, graph.ids.season);
        for (const ParentItemId of ancestors) source.insert('AncestorIds', { ItemId: graph.ids[entry.key], ParentItemId });
      }
      for (const ItemId of [graph.ids.series, graph.ids.season]) for (const ParentItemId of [graph.folders.main.physical, graph.folders.main.collection]) {
        source.insert('AncestorIds', { ItemId, ParentItemId });
      }
    });
    graph.created = created;
  } finally { source.close(); }
  graph.savedMediaSourceCaches = {};
  for (const key of ['live', 'completeChannel']) {
    const itemId = idKey(graph.ids[key]), channelId = idKey(graph.ids.channel);
    const directory = path.join(root, 'data/metadata/channels', channelId, itemId);
    const filename = path.join(directory, 'channelmediasourceinfos.json');
    const sources = key === 'live' ? [
      { Id: 'saved-opaque', Protocol: 'Http', Path: 'http://saved.invalid/original.WeBm', Container: 'mkv,WEBM',
        MediaStreams: [{ Type: 'Audio', Index: 2, Codec: 'aac', Channels: 2, Language: 'eng', IsDefault: true }] },
      { Id: itemId, Protocol: 'Http', Path: 'http://saved.invalid/second.mkv', Container: 'mkv',
        MediaStreams: [{ Type: 'Audio', Index: 6, Codec: 'ac3', Channels: 6, Language: 'zho' }] },
    ] : [{ Id: itemId, Protocol: 'File', Path: graph.files[key], Container: 'mkv',
      MediaStreams: [{ Type: 'Video', Index: 0, Codec: 'h264', Width: 1920, Height: 1080 },
        { Type: 'Audio', Index: 1, Codec: 'aac', Channels: 2, Language: 'eng', IsDefault: true }] }];
    await mkdir(directory, { recursive: true }); await writeFile(filename, JSON.stringify(sources) + '\n', { flag: 'wx' });
    graph.savedMediaSourceCaches[key] = filename;
  }
  return graph;
}

export function storageDocument(mediaRoot) {
  const style = process.platform === 'win32' ? 'windows' : 'posix', caseSensitive = process.platform !== 'win32';
  return { instances: [{ id: 'recording-media', type: 'local', config: { root: mediaRoot, writable: true } }],
    mounts: [{ path: '/recording-media', instanceId: 'recording-media', root: '/', capabilities: {
      create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } }],
    prefixes: [{ identityRoot: mediaRoot, accessRoot: '/recording-media', style, caseSensitive,
      returnAccess: 'Private recorded media stays available for native return.', purpose: 'library' }] };
}
export const portableMountContract = mediaRoot => ({ mounts: [{ mountId: 'recording-media', identityRoot: mediaRoot,
  accessRoot: '/recording-media', pathStyle: process.platform === 'win32' ? 'windows' : 'posix',
  caseSensitive: process.platform !== 'win32', returnPolicy: 'required' }] });
