import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalXmlPlugin, localXmlSavePath, serializeLocalXml } from '../../src/metadata/local-xml.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { idKey } from '../../src/library/records.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { setupChildrenFixture } from './children-fixture.js';
import { setNativePlaylistFileState } from '../../src/library/native-path.js';

const emptyLinks = async () => ({ manualCount: 0n, async *pages() {}, async close() {} });
const linkedPaths = (paths, manualCount = paths.length) => async () => ({
  manualCount: BigInt(manualCount), async *pages({ limit }) {
    assert.equal(limit, 128);
    for (let index = 0; index < paths.length; index += limit) yield paths.slice(index, index + limit).map(Path => ({ Path }));
  }, async close() {}
});
async function preparedBytes(item, context = {}) {
  const spoolRoot = await mkdtemp(path.join(os.tmpdir(), 'xml-prepared-test-'));
  let prepared;
  try {
    prepared = await serializeLocalXml(item, {fileSystem: testFileSystem,  spoolRoot, prepareLinkedXmlItems: emptyLinks, ...context });
    const parts = []; for await (const part of prepared.stream()) parts.push(part);
    return Buffer.concat(parts);
  } finally { await prepared?.close(); await rm(spoolRoot, { recursive: true, force: true }); }
}
const ids = {
  owner: '91000000-0000-0000-0000-000000000001',
  editor: '91000000-0000-0000-0000-000000000002',
  viewer: '91000000-0000-0000-0000-000000000003',
  first: '92000000-0000-0000-0000-000000000001',
  missing: '92000000-0000-0000-0000-000000000002',
  box: '93000000-0000-0000-0000-000000000001'
};

const base = values => ({
  Id: ids.box,
  Type: 'BoxSet',
  Path: 'Z:\\Collections\\Escaped',
  IsFolder: true,
  SupportsLocalMetadata: true,
  DateCreated: '2026-10-04 08:09:10.1234567',
  IsLocked: false,
  LockedFields: [],
  ProviderIds: {},
  RemoteTrailers: [],
  ProductionLocations: [],
  Genres: [],
  Studios: [],
  Tags: [],
  LinkedChildren: [],
  ...values
});

const decoded = bytes => {
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const xml = bytes.toString('utf8').slice(1);
  assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8" standalone="yes"\?>\r\n<Item>\r\n/u);
  assert.doesNotMatch(xml, /(?<!\r)\n/u);
  assert.doesNotMatch(xml, /[\r\n]$/u);
  return xml;
};

test('BoxSet XML batches manual link resolution and retains duplicate order, empty plural and escaping', async () => {
  const specialPath = `Z:\\Media\\A & <B> "quote" 'apostrophe'.mkv`;
  let requested;
  const item = base({
    Name: `Set & <name> "quote" 'apostrophe'`,
    Overview: 'Overview & <unsafe>',
    LinkedChildren: [
      { ItemId: ids.first, Type: 0 },
      { ItemId: ids.first, Type: 1 },
      { ItemId: ids.first, Type: 'Manual' },
      { ItemId: ids.missing, Type: 0 }
    ]
  });
  const xml = decoded(await preparedBytes(item, {
    prepareLinkedXmlItems(value) {
      requested = value;
      return linkedPaths([specialPath, specialPath], 3)();
    }
  }));

  assert.equal(requested, item);
  assert.equal((xml.match(/<CollectionItem>/gu) ?? []).length, 2);
  assert.equal((xml.match(/A &amp; &lt;B&gt; "quote" 'apostrophe'\.mkv/gu) ?? []).length, 2);
  assert.match(xml, /<LocalTitle>Set &amp; &lt;name&gt; "quote" 'apostrophe'<\/LocalTitle>/u);
  assert.doesNotMatch(xml, /PlaylistItems|OwnerUserId|Shares|PlaylistMediaType/u);

  const unresolved = decoded(await preparedBytes(base({
    LinkedChildren: [{ ItemId: ids.missing, Type: 0 }, { ItemId: ids.first, Type: 2 }]
  }), { prepareLinkedXmlItems: linkedPaths([], 1) }));
  assert.match(unresolved, /  <CollectionItems \/>/u);
  const absent = decoded(await preparedBytes(base({ LinkedChildren: [{ ItemId: ids.first, Type: 2 }] })));
  assert.doesNotMatch(absent, /CollectionItems/u);
});

test('Playlist XML distinguishes directory and file forms and preserves owner, shares and media type', async () => {
  const directory = base({
    Type: 'Playlist', Path: 'Z:\\Playlists\\Road.Trip', Name: 'Road Trip',
    OwnerUserId: ids.owner, PlaylistMediaType: 'Video',
    Shares: [{ UserId: ids.editor, CanEdit: true }, { UserId: ids.editor, CanEdit: false },
      { UserId: ids.viewer, CanEdit: false }],
    LinkedChildren: [{ ItemId: ids.first, Type: 0 }, { ItemId: ids.first, Type: 0 }]
  });
  // Playlist.IsFolder is true for both forms. Directory.Exists, not that
  // inherited getter, distinguishes an extension-shaped logical directory.
  setNativePlaylistFileState(directory, false);
  const xml = decoded(await preparedBytes(directory, {
    prepareLinkedXmlItems: linkedPaths(['Z:\\Media\\first.mkv', 'Z:\\Media\\first.mkv'])
  }));
  assert.match(xml, /<OwnerUserId>91000000000000000000000000000001<\/OwnerUserId>/u);
  assert.equal((xml.match(/<PlaylistItem>/gu) ?? []).length, 2);
  assert.equal((xml.match(/<UserId>91000000-0000-0000-0000-000000000002<\/UserId>/gu) ?? []).length, 2);
  assert.match(xml, /<PlaylistMediaType>Video<\/PlaylistMediaType>/u);
  assert.ok(xml.indexOf('<OwnerUserId>') < xml.indexOf('<PlaylistItems>'));
  assert.ok(xml.indexOf('<PlaylistItems>') < xml.indexOf('<Shares>'));
  assert.ok(xml.indexOf('<Shares>') < xml.indexOf('<PlaylistMediaType>'));

  const file = { ...directory, Path: 'Z:\\Playlists\\road.m3u', IsFolder: true };
  setNativePlaylistFileState(file, true);
  const fileXml = decoded(await preparedBytes(file, {
    prepareLinkedXmlItems() { throw new Error('playlist-file links must not be resolved'); }
  }));
  assert.doesNotMatch(fileXml, /OwnerUserId|PlaylistItems/u);
  assert.match(fileXml, /<Shares>/u);
  assert.match(fileXml, /<PlaylistMediaType>Video<\/PlaylistMediaType>/u);
  assert.equal(localXmlSavePath(file), 'Z:\\Playlists\\road.xml');
  assert.equal(localXmlSavePath(directory), 'Z:\\Playlists\\Road.Trip\\playlist.xml');
});

test('network XML saver preflight requires create and replace and save performs one direct overwrite', async t => {
  const spoolRoot = await mkdtemp(path.join(os.tmpdir(), 'xml-network-test-'));
  t.after(() => rm(spoolRoot, { recursive: true, force: true }));
  let capabilities = {}, write, size;
  const vfs = {
    capabilities: value => (assert.equal(value, '/network/box/collection.xml'), capabilities),
    async write(...args) { write = args; size = 0n; for await (const part of args[1]) size += BigInt(part.length); }
  };
  const plugin = createLocalXmlPlugin({fileSystem: testFileSystem,  vfs, spoolRoot });
  const saver = plugin.providers.find(provider => provider.itemTypes.includes('BoxSet'));
  const item = base({ Path: 'Z:\\Network\\box' });
  const context = { accessPath: '/network/box', prepareLinkedXmlItems: emptyLinks, signal: AbortSignal.abort() };

  assert.equal(await saver.isEnabledFor(item, ItemUpdateType.ImageUpdate), false);
  assert.equal(await saver.isEnabledFor(item, ItemUpdateType.MetadataDownload), true);
  capabilities = { replace: true };
  await assert.rejects(saver.validateSave(item, context), error => error.code === 'not-supported' && /create/u.test(error.message));
  capabilities = { create: true };
  await assert.rejects(saver.validateSave(item, context), error => error.code === 'not-supported' && /replace/u.test(error.message));
  capabilities = { create: true, replace: true };
  await saver.validateSave(item, context);
  await saver.save(item, context);
  assert.equal(write[0], '/network/box/collection.xml');
  assert.equal(write[2].overwrite, true);
  assert.equal(Object.hasOwn(write[2], 'signal'), false, 'native XML writer ignores the request cancellation token');
  assert.equal(write[2].size, size);
});

test('network XML saver exposes a failed direct overwrite without restoring its partial bytes', async t => {
  const spoolRoot = await mkdtemp(path.join(os.tmpdir(), 'xml-network-failure-'));
  t.after(() => rm(spoolRoot, { recursive: true, force: true }));
  const failure = new Error('controlled partial network write');
  let partial, writes = 0;
  const vfs = {
    capabilities: () => ({ create: true, replace: true }),
    async write(_path, bytes) {
      writes++;
      for await (const part of bytes) { partial = Buffer.from(part).subarray(0, 24); break; }
      throw failure;
    }
  };
  const saver = createLocalXmlPlugin({fileSystem: testFileSystem,  vfs, spoolRoot }).providers.find(provider => provider.itemTypes.includes('BoxSet'));
  await assert.rejects(saver.save(base(), { accessPath: '/network/box', prepareLinkedXmlItems: emptyLinks }), error => error === failure);
  assert.equal(writes, 1);
  assert.deepEqual([...partial.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(partial.length, 24);
});

test('state-local XML saver confines real paths and rejects symbolic item and destination paths', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'local-xml-root-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'local-xml-outside-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const directory = path.join(root, 'collections', 'Set');
  await mkdir(directory, { recursive: true });
  const saver = createLocalXmlPlugin({fileSystem:testFileSystem}).providers.find(provider => provider.itemTypes.includes('BoxSet'));
  const item = base({ Path: directory });
  const context = { localRoot: root, localPath: directory, prepareLinkedXmlItems: emptyLinks };
  await saver.validateSave(item, context);
  await saver.save(item, context);
  assert.deepEqual([...(await readFile(path.join(directory, 'collection.xml'))).subarray(0, 3)], [0xef, 0xbb, 0xbf]);

  await assert.rejects(saver.validateSave(item, { localRoot: root, localPath: outside }),
    error => error.code === 'permission-denied');
  const escapedParent = path.join(root, 'escaped-parent'), escapedItem = path.join(escapedParent, 'Set');
  await mkdir(path.join(outside, 'Set'));
  await symlink(outside, escapedParent, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(saver.validateSave({ ...item, Path: escapedItem }, {
    localRoot: root, localPath: escapedItem
  }), error => error.code === 'permission-denied');
  await rm(path.join(directory, 'collection.xml'));
  await symlink(outside, path.join(directory, 'collection.xml'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(saver.validateSave(item, context), error => error.code === 'permission-denied');
  await rm(path.join(directory, 'collection.xml'), { recursive: true, force: true });

  const linked = path.join(root, 'collections', 'Linked');
  await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(saver.validateSave({ ...item, Path: linked }, { localRoot: root, localPath: linked }),
    error => error.code === 'permission-denied');
});

for (const dialect of ['postgres']) test(`${dialect}: metadata context keeps state-local XML and linked paths in its current library frame`, { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const fixture = await setupChildrenFixture(t, dialect);
  const boxPath = path.join(fixture.stateRoot, 'data', 'collections', 'Current State');
  await mkdir(boxPath, { recursive: true });
  const target = await fixture.seed({ target: 'box', items: [
    { key: 'box', type: 'BoxSet', Id: ids.box, Path: boxPath, links: ['movie', 'movie'] },
    { key: 'movie', type: 'Movie', Id: ids.first, Path: 'Z:\\ChildrenMetadata\\movie.mkv' }
  ] });
  const loaded = await fixture.loadContext(target);
  assert.equal(loaded.context.localPath, boxPath);
  assert.equal(loaded.context.localRoot, path.join(fixture.stateRoot, 'data'));
  assert.equal(loaded.context.accessPath, undefined);
  assert.equal(loaded.saveLocalMetadataEnabled, true);
  const saver = createLocalXmlPlugin({fileSystem: testFileSystem,  linkedChildren: fixture.linkedChildren }).providers.find(value => value.itemTypes.includes('BoxSet'));
  await saver.save(loaded.item, loaded.context);
  const saved = (await readFile(path.join(boxPath, 'collection.xml'))).toString('utf8');
  assert.equal((saved.match(/<CollectionItem>/gu) ?? []).length, 2);
  assert.match(saved, /movie\.mkv/u);
  await loaded.dispose();
  const localOnly = await createMetadataContextLoader({fileSystem: testFileSystem,  store: fixture.store, library: fixture.library, linkedChildren: fixture.linkedChildren })(target);
  assert.equal(localOnly.context.localPath, boxPath);
  assert.equal(localOnly.context.accessPath, undefined);
  await localOnly.dispose();
});
