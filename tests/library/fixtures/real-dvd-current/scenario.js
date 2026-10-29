import assert from 'node:assert/strict';
import { link, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tableDefinition } from '../../../../src/database/model.js';
import { parseLosslessJson } from '../../../../src/core/json.js';
import { idKey, mapRecord } from '../../../../src/library/records.js';
import { describeFile } from '../../../../tools/validation/inventory.js';

const order = values => values.toSorted((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
export const functionalJson = value => parseLosslessJson(JSON.stringify(value,
  (_key, entry) => typeof entry === 'bigint' ? JSON.rawJSON(entry.toString()) : entry));
const fields = (value, names) => Object.fromEntries(names.map(name => [name, value[name] ?? null]));
export const streamValues = value => ({ ...value, ...Object.fromEntries(['AverageFrameRate', 'RealFrameRate', 'ReferenceFrameRate']
  .filter(name => value[name] != null).map(name => [name, Math.fround(value[name])])) });

export async function materializeOriginalDvd(supply, disc) {
  await mkdir(disc);
  for (const member of supply.manifest) {
    const filename = path.join(disc, ...member.path.split('/'));
    if (member.type === 'directory') await mkdir(filename, { recursive: true });
    else await link(path.join(supply.mediaRoot, ...member.path.split('/')), filename);
  }
  return verifyOriginalDvd(supply, disc);
}

export async function verifyOriginalDvd(supply, disc) {
  const tree = await describeFile(disc), actual = [];
  assert.ok(tree.available && tree.kind === 'directory');
  const walk = (entries, parent = '') => {
    for (const entry of entries) {
      const relative = parent ? parent + '/' + entry.name : entry.name;
      assert.ok(entry.available && ['file', 'directory'].includes(entry.kind));
      actual.push({ path: relative, type: entry.kind, bytes: entry.kind === 'file' ? entry.bytes : 0,
        ...(entry.kind === 'file' ? { sha256: entry.sha256 } : {}) });
      if (entry.kind === 'directory') walk(entry.entries, relative);
    }
  };
  walk(tree.entries);
  assert.deepEqual(order(actual), supply.manifest, 'The actual scanner must retain every complete original VIDEO_TS member and byte.');
  return { entries: actual, sha256: tree.entriesSha256 };
}

export async function configureStorage(root, mediaRoot) {
  const style = process.platform === 'win32' ? 'windows' : 'posix', caseSensitive = style === 'posix';
  const ancestors = path.join(root, 'empty-ancestors'); await mkdir(ancestors);
  const mountContract = { mounts: [{ mountId: 'real-dvd-instance', identityRoot: root, accessRoot: '/dvd-instance',
    pathStyle: style, caseSensitive, returnPolicy: 'required' }] };
  const filename = path.join(root, 'storage.json');
  await writeFile(filename, JSON.stringify({
    instances: [{ id: 'instance', type: 'local', config: { root, writable: true } },
      { id: 'disc', type: 'local', config: { root: mediaRoot, writable: false } },
      { id: 'ancestors', type: 'local', config: { root: ancestors, writable: false } }],
    mounts: [{ path: '/dvd-instance', instanceId: 'instance', capabilities: {
      create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } },
    { path: '/dvd-instance/media', instanceId: 'disc', capabilities: {} },
    { path: '/empty-ancestors', instanceId: 'ancestors', capabilities: {} }],
    prefixes: [{ identityRoot: root, accessRoot: '/dvd-instance', style, caseSensitive,
      returnAccess: 'Actual DVD and isolated instance identities remain fixed throughout the exchange.' }],
    ignorePrefixes: [{ identityRoot: path.parse(root).root, accessRoot: '/empty-ancestors', style, caseSensitive,
      returnAccess: 'Only explicitly empty ancestors belong to this isolated DVD scan.' }],
  }, null, 2) + '\n', { flag: 'wx' });
  return { filename, mountContract };
}

export function libraryOptions(mediaRoot) {
  return { Enabled: true, PathInfos: [{ Path: mediaRoot }], EnableRealtimeMonitor: false,
    EnableInternetProviders: false, SaveLocalMetadata: false, MetadataSavers: [], AutomaticRefreshIntervalDays: 0,
    EnableLUFSScan: false, EnableEmbeddedEpisodeInfos: false, EnableChapterImageExtraction: false,
    ExtractChapterImagesDuringLibraryScan: false, EnableTrickplayImageExtraction: false,
    ExtractTrickplayImagesDuringLibraryScan: false,
    TypeOptions: ['Movie', 'Video', 'Trailer', 'Folder', 'CollectionFolder', 'Person'].map(Type => ({ Type,
      MetadataFetchers: [], MetadataFetcherOrder: [], ImageFetchers: [], ImageFetcherOrder: [],
      ImageOptions: [], SimilarItemProviders: [], SimilarItemProviderOrder: [] })) };
}

export function probeValues(value) {
  const streamFields = tableDefinition('MediaStreamInfos').columns.map(column => column.name)
    .filter(name => !['ItemId', 'StreamIndex', 'StreamType', 'IsAvc'].includes(name));
  return functionalJson({ ...fields(value, ['Container', 'RunTimeTicks', 'Size', 'Bitrate']),
    MediaStreams: value.MediaStreams.map(stream => streamValues({ ...fields(stream, streamFields),
      Index: stream.Index, Type: stream.Type, IsAVC: stream.IsAVC ?? null })),
    Chapters: (value.Chapters ?? []).map(chapter => fields(chapter, ['Name', 'StartPositionTicks'])) });
}

export function technicalDto(value) {
  const result = fields(value, ['Id', 'Name', 'SortName', 'Path', 'Type', 'MediaType', 'IsFolder', 'VideoType',
    'RunTimeTicks', 'Container', 'Width', 'Height', 'Size', 'IsHD', 'HasSubtitles', 'ProductionYear', 'OriginalTitle',
    'Overview', 'Tags', 'ProviderIds', 'Chapters']);
  result.MediaStreams = (value.MediaStreams ?? []).map(streamValues);
  result.MediaSources = (value.MediaSources ?? []).map(source => ({ ...fields(source,
    ['Id', 'Path', 'Protocol', 'Container', 'Size', 'RunTimeTicks', 'VideoType', 'Video3DFormat', 'Bitrate',
      'DefaultAudioStreamIndex', 'DefaultSubtitleStreamIndex']), MediaStreams: (source.MediaStreams ?? []).map(streamValues) }));
  return functionalJson(result);
}

export async function discRows(database, disc) {
  const rows = await database.rows('BaseItems', { where: { Path: disc } });
  assert.equal(rows.length, 1, 'The complete DVD directory must produce one actual scanned Movie.');
  const row = rows[0], item = mapRecord(row);
  assert.equal(item.Type, 'Movie'); assert.equal(item.VideoType === 'Dvd' || item.VideoType === 2, true);
  assert.equal(item.IsFolder, false); assert.ok(item.RunTimeTicks > 0); assert.ok(item.Width > 0 && item.Height > 0);
  const relations = {};
  for (const table of ['MediaStreamInfos', 'AttachmentStreamInfos', 'Chapters']) relations[table] =
    await database.rows(table, { where: { ItemId: row.Id } });
  assert.ok(relations.MediaStreamInfos.some(stream => stream.StreamType === 1), 'The real DVD must persist an actual video stream.');
  const technical = { item: { ...fields(item, ['Name', 'SortName', 'Path', 'MediaType', 'RunTimeTicks', 'Size', 'Width', 'Height',
    'TotalBitrate', 'Container', 'Timestamp', 'Video3DFormat', 'HasSubtitles', 'ProductionYear']), Id: idKey(item.Id), VideoType: 'Dvd' },
    relations: Object.fromEntries(Object.entries(relations).map(([name, values]) => [name, values.map(value =>
      Object.fromEntries(tableDefinition(name).columns.filter(column => !column.generated).map(column =>
        [column.name, column.name === 'ItemId' ? idKey(value[column.name]) : value[column.name]])))])) };
  return { row, relations, technical: functionalJson(technical) };
}
