import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { testFileSystem } from '../storage/plugin-files.js';
import { newNativeItemEntity, releaseNativeItemLinks } from '../../src/library/native-item-entity.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { nativeContainingFolderPath, setNativePlaylistFileState } from '../../src/library/native-path.js';
import { mergeMetadata } from '../../src/metadata/merge.js';
import { createPlaylistItemsPlugin } from '../../src/metadata/playlist-items.js';
import { mapNativeItemRow } from '../../src/metadata/persistence.js';
import { tableDefinition } from '../../src/database/model.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { dateText, guid } from '../../src/library/records.js';
import { currentPlaylistItems } from './playlist-items-current.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_DOTNET
  && process.env.MEDIAMANAGER_JELLYFIN_DLL);
const emptyId = '00000000-0000-0000-0000-000000000000';
const fixtureId = value => `16000000-0000-0000-0000-${String(value).padStart(12, '0')}`;

function tokenize(value, stateRoot) {
  if (value == null) return null;
  const rendered = value.toLowerCase().startsWith(stateRoot.toLowerCase()) ? `$STATE${value.slice(stateRoot.length)}` : value;
  return rendered.replaceAll('\\', '/');
}

function mapperResult(item, stateRoot) {
  const row = mapNativeItemRow(item);
  const dataText = row.Data?.replaceAll(stateRoot.replaceAll('\\', '\\\\'), '$STATE').replaceAll(stateRoot, '$STATE');
  const columns = Object.fromEntries(tableDefinition('BaseItems').columns.map(column => {
    let value = row[column.name];
    if (column.name === 'Data') value = dataText == null ? null : parseLosslessJson(dataText);
    else if (value != null && column.clrType.replace('?', '') === 'Guid') value = guid(value);
    else if (value != null && column.clrType.replace('?', '') === 'DateTime') {
      const [whole, fraction = ''] = dateText(value).split('.');
      value = whole.replace(' ', 'T') + '.' + fraction.padEnd(7, '0') + 'Z';
    } else if (typeof value === 'string') value = tokenize(value, stateRoot);
    return [column.name, value];
  }));
  return { columnCount: tableDefinition('BaseItems').columns.length, columns, dataText,
    data: dataText == null ? null : parseLosslessJson(dataText) };
}

const storedValues = ({ columnCount, columns, data }) => ({ columnCount, columns, data });
const providerValues = result => ({ HasMetadata: result.HasMetadata, item: result.item, stored: storedValues(result.stored) });

async function projectPlaylist(item, stateRoot, linkedChildren) {
  const links = [];
  for await (const page of linkedChildren.pages(item.LinkedChildren)) for (const link of page) links.push({
    id: link.ItemId ?? null, path: link.Path ?? null, type: link.Type === 0 ? 'Manual' : link.Type,
  });
  return { Name: item.Name ?? null, path: tokenize(item.Path, stateRoot), IsFolder: item.IsFolder,
    mediaType: item.MediaType, owner: item.OwnerUserId ?? emptyId, OpenAccess: item.OpenAccess, links,
    shares: (item.Shares ?? []).map(share => ({ user: share.UserId, edit: share.CanEdit })) };
}

function providerContext(input, sample, stateRoot) {
  const mediaRoot = path.join(stateRoot, 'media');
  const itemPath = sample.path == null ? null : path.join(mediaRoot, ...sample.path.split('/'));
  const missing = new Set(sample.missingFromDatabase ?? []);
  const items = new Map(input.files.flatMap((name, index) => missing.has(name) ? []
    : [[path.join(mediaRoot, ...name.split('/')), { Id: fixtureId(index + 1) }]]));
  const ignored = new Set([null, 'livetv', 'boxsets', 'playlists']);
  const roots = [...new Set((sample.collections ?? [{ type: 'music', roots: ['Library'] }])
    .filter(collection => !ignored.has(collection.type))
    .flatMap(collection => collection.roots.map(root => path.join(mediaRoot, ...root.split('/')))))];
  const calls = [];
  return { itemPath, calls, context: { localRoot: stateRoot, localPath: itemPath,
    async playlistLibraryRoots() { calls.push({ method: 'GetUserRootFolder' }); return roots; },
    async playlistFileExists(filename) {
      if (filename == null) return false;
      try { return (await stat(filename)).isFile(); }
      catch (error) { if (['ENOENT', 'ENOTDIR', 'EINVAL'].includes(error.code)) return false; throw error; }
    },
    async findMetadataItemByPath(filename, isFolder) {
      calls.push({ method: 'FindByPath', path: tokenize(filename, stateRoot), isFolder });
      return items.get(filename) ?? null;
    },
  } };
}

async function observeProvider(input, sample, stateRoot, relation) {
  const { linkedChildren, spoolRoot } = relation;
  const harness = providerContext(input, sample, stateRoot);
  const provider = createPlaylistItemsPlugin({ fileSystem: testFileSystem, linkedChildren, spoolRoot }).providers[0];
  let result;
  try {
    result = await provider.getMetadata({ Path: harness.itemPath }, harness.context);
    return { failed: false, result: { HasMetadata: result.HasMetadata,
      item: await projectPlaylist(result.Item, stateRoot, linkedChildren), stored: mapperResult(result.Item, stateRoot) },
    calls: harness.calls };
  } catch (error) {
    return { failed: true, result: null, error: { name: error.name, message: error.message, code: error.code }, calls: harness.calls };
  } finally { if (result) releaseNativeItemLinks(result.Item); await linkedChildren.flushReleases(); }
}

function assertProvider(actual, expected, label) {
  assert.equal(actual.failed, Boolean(expected.error), label + ' success or failure');
  if (expected.error) assert.equal(actual.result, null);
  else assert.deepEqual(providerValues(actual.result), providerValues(expected.result),
    label + ' metadata, member order and persisted values');
}

test('playlist containing-folder state distinguishes a file from an extension-shaped directory', () => {
  const item = newNativeItemEntity('MediaBrowser.Controller.Playlists.Playlist');
  item.Path = 'Z:\\Library\\lists\\logical.m3u';
  assert.equal(nativeContainingFolderPath(item), 'Z:\\Library\\lists');
  setNativePlaylistFileState(item, false); assert.equal(nativeContainingFolderPath(item), item.Path);
  setNativePlaylistFileState(item, true); assert.equal(nativeContainingFolderPath(item), 'Z:\\Library\\lists');
});

test('current Native playlist readers match all original, layout and current absolute-path inputs', { skip: !enabled }, async t => {
  const current = await currentPlaylistItems(), relation = await relationFixture(t);
  for (const [index, sample] of current.input.providerCases.entries()) await t.test(sample.name, async () => {
    const expected = current.native.results[index];
    const actual = await observeProvider(current.input, sample, expected.root, relation);
    await current.recordComparison({ phase: 'provider', name: sample.name, actual, expected });
    assertProvider(actual, expected, sample.name);
    if (sample.name === 'm3u-current-absolute-and-missing-db') {
      assert.deepEqual(actual.result.item.links, [{ id: fixtureId(1), path: null, type: 'Manual' }]);
    }
  });
});

async function inflatePlaylist(value, stateRoot, linkedChildren) {
  const item = newNativeItemEntity('MediaBrowser.Controller.Playlists.Playlist');
  item.Path = value.path == null ? null : value.path.replace('$STATE', stateRoot).replaceAll('/', path.sep);
  if (value.mediaType != null) item.PlaylistMediaType = value.mediaType;
  if (value.owner != null) item.OwnerUserId = fixtureId(value.owner);
  if (value.open != null) item.OpenAccess = value.open;
  item.LinkedChildren = await linkedChildren.withSession(async session => {
    const writer = await linkedChildren.createWriter({ session, parentId: item.Id });
    try {
      for (const link of value.links ?? []) await writer.append({
        ItemId: Object.hasOwn(link, 'id') ? link.id === 0 ? emptyId : fixtureId(link.id) : null,
        Path: link.path ?? null, Type: 'Manual',
      });
      return await writer.finish();
    } catch (error) { await writer.abort(); throw error; }
  });
  item.Shares = (value.shares ?? []).map(share => ({ UserId: fixtureId(share.user), CanEdit: share.edit }));
  return item;
}

test('current Native playlist metadata merge preserves ordered members, shares and persisted metadata', { skip: !enabled }, async t => {
  const current = await currentPlaylistItems(), { linkedChildren } = await relationFixture(t);
  for (const [index, sample] of current.input.mergeCases.entries()) await t.test(sample.name, async () => {
    const expected = current.native.merges[index];
    const stateRoot = path.join(current.output, 'native/state', sample.name);
    const source = await inflatePlaylist(sample.source, stateRoot, linkedChildren);
    const target = await inflatePlaylist(sample.target, stateRoot, linkedChildren);
    target.Id = `17000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`;
    try {
      assert.deepEqual(await projectPlaylist(source, stateRoot, linkedChildren), expected.source);
      assert.deepEqual(await projectPlaylist(target, stateRoot, linkedChildren), expected.before);
      await mergeMetadata({ Item: source }, { Item: target }, {
        replaceData: sample.replaceData ?? false, mergeMetadataSettings: sample.mergeMetadataSettings ?? true,
        dataPath: path.join(stateRoot, 'data'), linkedChildren,
      });
      const actual = { after: await projectPlaylist(target, stateRoot, linkedChildren), stored: mapperResult(target, stateRoot) };
      await current.recordComparison({ phase: 'merge', name: sample.name, actual, expected });
      assert.deepEqual({ after: actual.after, stored: storedValues(actual.stored) },
        { after: expected.after, stored: storedValues(expected.stored) });
    } finally { releaseNativeItemLinks(source); releaseNativeItemLinks(target); await linkedChildren.flushReleases(); }
  });
});

test('actual Node playlist files survive Native reader and writer followed by Node reread', { skip: !enabled }, async t => {
  const current = await currentPlaylistItems(), relation = await relationFixture(t);
  const expectedLinks = current.input.writerLinks.map(index => ({ id: fixtureId(index + 1), path: null, type: 'Manual' }));
  for (const [index, sample] of current.candidateWriters.entries()) await t.test(sample.name, async () => {
    const expected = current.native.results[current.input.providerCases.length + index], writer = current.native.writers[index];
    const before = await observeProvider(current.input, sample, sample.candidateRoot, relation);
    const after = await observeProvider(current.input, sample, writer.root, relation);
    await current.recordComparison({ phase: 'writer-reader', name: sample.name, before, after, writer });
    assertProvider(before, expected, sample.name + ' Node output read by both providers');
    assertProvider(after, { result: writer.reread, error: null }, sample.name + ' Native output read by Node');
    assert.deepEqual(before.result.item.links, expectedLinks);
    assert.deepEqual(after.result.item.links, expectedLinks);
    assert.deepEqual(writer.beforeEntries, writer.afterEntries,
      'The real Native file reader must observe identical order, paths, durations, titles, artists and albums from both writers.');
    assert.deepEqual(providerValues(after.result), providerValues(before.result));
  });
});

async function relationFixture(t) {
  const database = await createPostgresTestDatabase(null, 'playlist_current');
  const linkedChildren = new PostgresLinkedChildrenStore({ database }); await linkedChildren.initialize();
  const spoolRoot = await mkdtemp(path.join(os.tmpdir(), 'playlist-current-spool-'));
  t.after(async () => {
    try { await linkedChildren.flushReleases(); await linkedChildren.close(); }
    finally { await dropPostgresTestDatabase(database); await rm(spoolRoot, { recursive: true, force: true }); }
  });
  return { linkedChildren, spoolRoot };
}
