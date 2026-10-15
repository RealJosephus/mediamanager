import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { newNativeItemEntity, releaseNativeItemLinks } from '../../src/library/native-item-entity.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import { nativeContainingFolderPath, setNativePlaylistFileState } from '../../src/library/native-path.js';
import { mergeMetadata } from '../../src/metadata/merge.js';
import { createPlaylistItemsPlugin } from '../../src/metadata/playlist-items.js';
import { consumerFixture } from '../consumer-contracts/fixture.js';
import { observeComparison } from '../comparison-observations.js';
import { mapNativeItemRow } from '../../src/metadata/persistence.js';
import { tableDefinition } from '../../src/database/model.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { dateText, guid } from '../../src/library/records.js';

const fixtureRoot = new URL('./fixtures/playlist-items/', import.meta.url);
const readFixture = name => readFile(new URL(name, fixtureRoot));
const [inputBytes, nativeBytes, provenanceBytes] = await Promise.all([
  readFixture('input.json'), readFixture('native.json'), readFixture('provenance.json')
]);
const input = JSON.parse(inputBytes);
const native = JSON.parse(nativeBytes);
const provenance = JSON.parse(provenanceBytes);
const layouts = await consumerFixture('playlist-layouts');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const emptyId = '00000000-0000-0000-0000-000000000000';
const fixtureId = value => `16000000-0000-0000-0000-${String(value).padStart(12, '0')}`;
const providerResult = result => result == null ? null : ({ HasMetadata: result.HasMetadata, item: result.item,
  providerName: result.providerName ?? result.Name, order: result.order ?? result.Order,
  completedWithCancelledToken: result.completedWithCancelledToken });
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
    }
    else if (typeof value === 'string') value = tokenize(value, stateRoot);
    return [column.name, value];
  }));
  return { columnCount: tableDefinition('BaseItems').columns.length, columns, dataText, data: dataText == null ? null : parseLosslessJson(dataText) };
}

test('playlist containing-folder state distinguishes a file from an extension-shaped directory', () => {
  const item = newNativeItemEntity('MediaBrowser.Controller.Playlists.Playlist');
  item.Path = 'Z:\\Library\\lists\\logical.m3u';
  assert.equal(nativeContainingFolderPath(item), 'Z:\\Library\\lists');
  setNativePlaylistFileState(item, false);
  assert.equal(nativeContainingFolderPath(item), item.Path);
  setNativePlaylistFileState(item, true);
  assert.equal(nativeContainingFolderPath(item), 'Z:\\Library\\lists');
});

test('playlist oracle retains actual-process identity and repeatability seals', async () => {
  assert.equal(digest(provenanceBytes), 'f76d0011fb13c64d2f565d501877887c532547badbdb561716798700398adb23');
  assert.equal(provenance.candidateVerified, false);
  assert.equal(provenance.jellyfin.commit, '208c278b75abd897aefa1e1175126eac5e4dbfaa');
  assert.equal(provenance.playlistsNet.commit, '10a2a55eea67b6cca866022107686bdac9b19fba');
  assert.equal(provenance.playlistsNet.version, '1.4.1');
  assert.equal(provenance.files.rawRecording.sha256,
    'ef7ec4572db21fda8afb3b5f03251aed47bdfd7500f2b8f518393b8af074b9d7');
  assert.deepEqual(provenance.counts, { providerCases: 36, mergeCases: 15 });
  assert.equal(provenance.repeat.projectionEqual, true);
  assert.equal(native.candidateVerified, false);
  assert.equal(native.inputSha256, digest(inputBytes));
  assert.equal(native.results.length, provenance.counts.providerCases);
  assert.equal(native.merges.length, provenance.counts.mergeCases);
  assert.ok(native.assemblies.some(value => value.name === 'MediaBrowser.Providers'));
  assert.ok(native.assemblies.some(value => value.name === 'PlaylistsNET'));
  for (const descriptor of [provenance.files.input, provenance.files.native,
    provenance.files.oracle, provenance.files.project]) {
    assert.equal(digest(await readFixture(descriptor.filename)), descriptor.sha256, descriptor.filename);
  }
});

function tokenize(value, stateRoot) {
  if (value == null) return null;
  const prefix = stateRoot.toLowerCase();
  const rendered = value.toLowerCase().startsWith(prefix) ? `$STATE${value.slice(stateRoot.length)}` : value;
  return rendered.replaceAll('\\', '/');
}

async function projectPlaylist(item, stateRoot, linkedChildren) {
  const links=[];for await(const page of linkedChildren.pages(item.LinkedChildren))for(const link of page)links.push({id:link.ItemId??null,path:link.Path??null,type:link.Type===0?'Manual':link.Type});
  return {
    Name: item.Name ?? null,
    path: tokenize(item.Path, stateRoot),
    IsFolder: item.IsFolder,
    mediaType: item.MediaType,
    owner: item.OwnerUserId ?? emptyId,
    OpenAccess: item.OpenAccess,
    links,
    shares: (item.Shares ?? []).map(share => ({ user: share.UserId, edit: share.CanEdit }))
  };
}

function providerHarness(sample) {
  const stateRoot = path.win32.join('Z:\\playlist-oracle', sample.name);
  const mediaRoot = path.win32.join(stateRoot, 'media');
  const itemPath = sample.path == null ? null : path.win32.join(mediaRoot, ...sample.path.split('/'));
  const files = new Map(input.files.map((name, index) => [
    path.win32.join(mediaRoot, ...name.split('/')),
    { Id: fixtureId(index + 1) }
  ]));
  const kind = sample.kind ?? 'file';
  const bytes = sample.bytes == null ? null : Buffer.from(sample.bytes, 'base64');
  const vfs = {
    async stat(candidate) {
      if (candidate !== itemPath || kind === 'absent') {
        throw Object.assign(new Error(`Path not found: ${candidate}`), { code: 'not-found' });
      }
      return { kind: kind === 'directory' ? 'directory' : 'file', modified: '2026-10-10T00:00:00.000Z' };
    },
    async openRead(candidate) {
      if (candidate !== itemPath || bytes == null || kind === 'absent') {
        throw Object.assign(new Error(`Path not found: ${candidate}`), { code: 'not-found' });
      }
      return {
        stream: (async function* stream() { yield bytes; })(),
        async close() {}
      };
    }
  };
  const calls = [];
  const collections = sample.collections ?? [{ type: 'music', roots: ['Library'] }];
  const ignored = new Set([null, 'livetv', 'boxsets', 'playlists']);
  const roots = [];
  for (const collection of collections) {
    if (ignored.has(collection.type)) continue;
    for (const root of collection.roots) {
      const candidate = path.win32.join(mediaRoot, ...root.split('/'));
      if (!roots.some(value => value.toLowerCase() === candidate.toLowerCase())) roots.push(candidate);
    }
  }
  const context = {
    accessPath: itemPath,
    async playlistLibraryRoots() {
      calls.push({ method: 'GetUserRootFolder' });
      return roots;
    },
    async playlistFileExists(candidate) { return files.has(candidate); },
    async findMetadataItemByPath(candidate, isFolder) {
      calls.push({ method: 'FindByPath', path: tokenize(candidate, stateRoot), isFolder });
      return files.get(candidate) ?? null;
    }
  };
  return { stateRoot, itemPath, vfs, context, calls };
}

test('playlist item provider matches native fields and paths for originals and 24 layout/writer inputs', {skip:!process.env.MEDIAMANAGER_TEST_POSTGRES}, async t => {
  const {linkedChildren,spoolRoot}=await relationFixture(t);
  const cases = [...input.providerCases, ...layouts.input.providerCases];
  const results = [...native.results, ...layouts.native.results];
  for (let index = 0; index < cases.length; index++) {
    const sample = cases[index];
    const expected = results[index];
    await t.test(sample.name, async () => {
      assert.equal(expected.name, sample.name);
      const harness = providerHarness(sample);
      const plugin = createPlaylistItemsPlugin({fileSystem: testFileSystem,  vfs: harness.vfs, linkedChildren, spoolRoot });
      const provider = plugin.providers[0];
      assert.deepEqual({ name: provider.name, order: provider.order, forced: provider.forced },
        { name: 'Playlist Item Provider', order: 100, forced: true });
      let actual = null;
      let error = null;
      let result;
      try {
        result = await provider.getMetadata({ Path: harness.itemPath }, harness.context);
        if (expected.result?.stored) assert.deepEqual(mapperResult(result.Item, harness.stateRoot), expected.result.stored,
          sample.name + ' actual 72-column mapper and Data TEXT');
        actual = {
          HasMetadata: result.HasMetadata,
          item: await projectPlaylist(result.Item, harness.stateRoot, linkedChildren),
          providerName: provider.name,
          order: provider.order,
          completedWithCancelledToken: true
        };
      } catch (caught) {
        error = {
          type: caught.nativeException ?? (caught.code === 'not-found' ? 'DirectoryNotFoundException' : caught.name)
        };
      } finally {if(result)releaseNativeItemLinks(result.Item);await linkedChildren.flushReleases();}
      assert.deepEqual(error, expected.error == null ? null : { type: expected.error.type });
      assert.deepEqual(actual, providerResult(expected.result));
      assert.deepEqual(harness.calls, expected.calls);
      if (index >= input.providerCases.length) {
        const baseName = sample.name.replace(/--(?:crlf|lf|bom-lf)$/u, '');
        const original = native.results.find(result => result.name === baseName);
        if (original) {
          observeComparison(t, sample.name + ' reader layout', expected, original);
          assert.deepEqual(providerResult(expected.result), providerResult(original.result));
          assert.deepEqual(expected.calls, original.calls);
          assert.deepEqual(expected.error && { type: expected.error.type }, original.error && { type: original.error.type });
        }
      }
    });
  }
});

function inflatePath(value, stateRoot) {
  return value == null ? null : value.replace('$STATE', stateRoot).replaceAll('/', '\\');
}

function inflateLink(value) {
  return {
    ItemId: Object.hasOwn(value, 'id') ? value.id === 0 ? emptyId : fixtureId(value.id) : null,
    Path: value.path ?? null,
    Type: 'Manual'
  };
}

function inflateShare(value) {
  return { UserId: fixtureId(value.user), CanEdit: value.edit };
}

async function inflatePlaylist(value, stateRoot, linkedChildren) {
  const item = newNativeItemEntity('MediaBrowser.Controller.Playlists.Playlist');
  item.Path = inflatePath(value.path, stateRoot);
  if (value.mediaType != null) item.PlaylistMediaType = value.mediaType;
  if (value.owner != null) item.OwnerUserId = fixtureId(value.owner);
  if (value.open != null) item.OpenAccess = value.open;
  item.LinkedChildren = await linkedChildren.withSession(async session=>{const writer=await linkedChildren.createWriter({session,parentId:item.Id});try{for(const link of value.links??[])await writer.append(inflateLink(link));return await writer.finish();}catch(error){await writer.abort();throw error;}});
  item.Shares = (value.shares ?? []).map(inflateShare);
  return item;
}

test('playlist metadata merge matches the pinned native oracle', {skip:!process.env.MEDIAMANAGER_TEST_POSTGRES}, async t => {
  const {linkedChildren}=await relationFixture(t);
  const stateRoot = 'Z:\\playlist-merge';
  for (let index = 0; index < input.mergeCases.length; index++) {
    const sample = input.mergeCases[index];
    const expected = native.merges[index];
    await t.test(sample.name, async () => {
      assert.equal(expected.name, sample.name);
      const source = await inflatePlaylist(sample.source, stateRoot, linkedChildren);
      const target = await inflatePlaylist(sample.target, stateRoot, linkedChildren);
      try {
      assert.deepEqual(await projectPlaylist(source, stateRoot, linkedChildren), expected.source);
      assert.deepEqual(await projectPlaylist(target, stateRoot, linkedChildren), expected.before);
      await mergeMetadata({ Item: source }, { Item: target }, {
        replaceData: sample.replaceData ?? false,
        mergeMetadataSettings: sample.mergeMetadataSettings ?? true,
        dataPath: path.win32.join(stateRoot, 'data'), linkedChildren
      });
      assert.deepEqual(await projectPlaylist(target, stateRoot, linkedChildren), expected.after);
      }finally{releaseNativeItemLinks(source);releaseNativeItemLinks(target);await linkedChildren.flushReleases();}
    });
  }
});

async function relationFixture(t){
  const database=await createPostgresTestDatabase(t,'playlist_provider'),linkedChildren=new PostgresLinkedChildrenStore({database});await linkedChildren.initialize();
  const spoolRoot=await mkdtemp(path.join(os.tmpdir(),'playlist-provider-spool-'));
  t.after(async()=>{await linkedChildren.flushReleases();await linkedChildren.close();await rm(spoolRoot,{recursive:true,force:true});});
  return{linkedChildren,spoolRoot};
}
