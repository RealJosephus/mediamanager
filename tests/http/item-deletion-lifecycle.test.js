import { testFileSystem } from '../storage/plugin-files.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { setupChildrenFixture, useIdentityPathReversalControl } from '../metadata/children-fixture.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { ItemDeletionService } from '../../src/library/item-deletion-service.js';
import { ExternalDataManager } from '../../src/library/external-data.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { internalImagePath } from '../../src/metadata/image-paths.js';
import { readCachedFolderChildren, setFolderChildren } from '../../src/library/folder-cache.js';
import { createApplication } from '../../src/http/application.js';
import { guid, sameId } from '../../src/library/records.js';
import { WebDavAdapter } from '../../plugins/webdav/adapter.js';
import { startActualWebDav } from '../storage/helpers/actual-webdav.js';

const id = index => `ad100000-0000-0000-0000-${String(index).padStart(12, '0')}`;
const enabled = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES };
const user = { Id: id(9), Policy: { EnableContentDeletion: true, EnableAllFolders: true, IsAdministrator: false,
  EnableCollectionManagement: false, BlockedTags: [], AllowedTags: [], BlockUnratedItems: [] }, MaxParentalRatingScore: null };
const capabilities = { create: true, replace: true, mkdir: true, delete: true };

// The controller oracle controls DeleteItem. These integration tests instead
// compose that request order with the separately recorded shared item lifecycle:
// real PostgreSQL rows, bounded mapped sources, metadata, cache and events.
async function setup(t, { owned = false } = {}) {
  const fixture = await setupChildrenFixture(t);
  useIdentityPathReversalControl(fixture);
  fixture.vfs.mount({ path: '/item-delete', instanceId: 'fixture', capabilities });
  fixture.identityMap.addPrefix({ identityRoot: 'Z:\\GenericDelete', accessRoot: '/item-delete/media', style: 'windows',
    returnAccess: 'Isolated generic HTTP deletion fixture; no host-media access.' });
  await fixture.adapter.mkdir('/media');
  await fixture.seed({ target: 'first', items: [
    { key: 'parent', type: 'Folder', Id: id(1), Name: 'Parent', Path: 'Z:\\GenericDelete' },
    ...['first', 'second', 'third'].map((key, index) => ({ key, type: 'Audio', Id: id(index + 2), Name: key,
      parent: 'parent', Path: `Z:\\GenericDelete\\${key}.flac`, IsInMixedFolder: false,
      OwnerId: owned && key === 'second' ? id(2) : null })),
    { key: 'denied', type: 'BoxSet', Id: id(5), Name: 'Denied', parent: 'parent', Path: 'Z:\\GenericDelete\\Denied' },
  ] });
  for (const name of ['first', 'second', 'third', 'sibling']) {
    await fixture.adapter.write(`/media/${name === 'sibling' ? 'sibling.keep' : name + '.flac'}`, Buffer.from(name));
  }
  const creator = new ItemCreationService(fixture); t.after(() => creator.close());
  fixture.library.itemCreation = creator;
  const parent = await creator.getItemById(id(1));
  const items = await Promise.all([2, 3, 4].map(index => creator.getItemById(id(index))));
  setFolderChildren(parent, items); parent.UserData = [];
  const loaded = await fixture.loadContext(id(2), { draft: items[0] });
  const assets = new MetadataImageAssets({fileSystem: testFileSystem,  ...fixture, metadataPath: loaded.metadataPath, stateRoots: [loaded.dataPath] });
  const external = new ExternalDataManager({fileSystem: testFileSystem,  ...fixture, dataPath: loaded.dataPath, metadataPath: loaded.metadataPath });
  // An explicit external-provider dependency control, not an extra media file.
  external.paths = item => [path.join(loaded.dataPath, 'fixture-external', guid(item.Id))];
  const markers = items.map(item => ({
    internal: path.join(internalImagePath(item, loaded.metadataPath), 'marker.txt'),
    external: path.join(external.paths(item)[0], 'marker.txt'),
  }));
  for (const marker of markers) for (const filename of Object.values(marker)) await assets.write(filename, Buffer.from('marker'));
  fixture.library.itemDeletion = new ItemDeletionService({ ...fixture, itemCreation: creator, updates: fixture.host.updates,
    externalData: external, linkedChildReferences: { reroute: async () => [] }, now: () => fixture.now });
  const events = [];
  fixture.library.on('ItemRemoved', event => events.push({ id: guid(event.Item.Id), parentId: event.Parent && guid(event.Parent.Id) }));
  const application = await createApplication({ library: fixture.library, users: { getUser: async value => sameId(value, user.Id) ? user : null },
    configuration: { IsStartupWizardCompleted: true }, authentication: {
      authenticate: async () => ({ IsAuthenticated: true, IsApiKey: false, User: user, UserId: user.Id, IsAdministrator: false }),
      authorize: () => {},
    } });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => application.server.close(resolve)));
  const request = async indices => {
    const suffix = Array.isArray(indices) ? '?ids=' + indices.map(id).join(',') : '/' + id(indices);
    const response = await fetch(`http://127.0.0.1:${application.server.address().port}/Items${suffix}`, { method: 'DELETE' });
    return { status: response.status, body: await response.text() };
  };
  const exists = async operation => { try { await operation(); return true; } catch (error) {
    if (['not-found', 'ENOENT'].includes(error.code)) return false; throw error;
  } };
  const accessPaths = ['first', 'second', 'third'].map(name => '/item-delete/media/' + name + '.flac');
  const state = async () => Promise.all(items.map(async (item, index) => ({
    row: (await fixture.database.rows('BaseItems', { where: { Id: item.Id } })).length !== 0,
    source: await exists(() => fixture.vfs.stat(accessPaths[index])),
    internal: await exists(() => assets.stat(markers[index].internal)),
    external: await exists(() => assets.stat(markers[index].external)),
    lookup: await creator.getItemById(item.Id) !== null,
  })));
  return { fixture, creator, items, parent, events, request, state, accessPaths, markers, assets };
}
const untouched = { row: true, source: true, internal: true, external: true, lookup: true };
const removed = { row: false, source: false, internal: false, external: false, lookup: false };

for (const [name, indices, status] of [
  ['sequential success', [2, 3], 204], ['duplicate later ID', [2, 2, 4], 404],
  ['missing later ID', [2, 99, 4], 404], ['denied later item', [2, 5, 4], 401],
]) test(`postgres: generic batch HTTP deletion preserves the real committed prefix for ${name}`, enabled, async t => {
  const value = await setup(t), response = await value.request(indices);
  assert.equal(response.status, status);
  if (status === 401) assert.equal(response.body, '"Unauthorized access"');
  assert.deepEqual(await value.state(), [removed, status === 204 ? removed : untouched, untouched]);
  assert.deepEqual(value.events.map(event => event.id), [guid(id(2)), ...(status === 204 ? [guid(id(3))] : [])]);
  assert.equal(value.events.every(event => event.parentId === guid(id(1))), true);
  assert.equal(readCachedFolderChildren(value.parent, null, () => null), null);
  assert.equal(value.parent.UserData, null);
  assert.equal(value.fixture.database.inTransaction, false);
  assert.equal((await value.fixture.vfs.stat('/item-delete/media/sibling.keep')).kind, 'file');
});

for (const failure of ['readonly', 'source', 'sql']) {
  test(`postgres: generic batch HTTP ${failure} failure keeps earlier commits without compensation`, enabled, async t => {
    const value = await setup(t);
    if (failure === 'readonly') {
      value.fixture.vfs.mount({ path: '/item-delete-readonly', instanceId: 'fixture', capabilities: {} });
      value.fixture.identityMap.bind(id(3), '/item-delete-readonly/media/second.flac');
    } else if (failure === 'source') {
      const remove = value.fixture.adapter.delete.bind(value.fixture.adapter);
      value.fixture.adapter.delete = async (location, options) => {
        if (location === '/media/second.flac') throw Object.assign(new Error('Controlled second source I/O failure.'), { code: 'io' });
        return remove(location, options);
      };
    } else {
      await value.fixture.database.client.query(`CREATE FUNCTION batch_delete_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF OLD."Id" = '${id(3)}' THEN RAISE EXCEPTION 'Controlled second row failure'; END IF; RETURN OLD; END $$`);
      await value.fixture.database.client.query('CREATE TRIGGER batch_delete_failure BEFORE DELETE ON "BaseItems" FOR EACH ROW EXECUTE FUNCTION batch_delete_failure()');
    }
    assert.equal((await value.request([2, 3, 4])).status, 500);
    assert.deepEqual(await value.state(), [removed, { ...untouched,
      internal: failure === 'readonly', external: failure !== 'sql', source: failure !== 'sql' }, untouched]);
    assert.deepEqual(value.events, [{ id: guid(id(2)), parentId: guid(id(1)) }]);
    assert.equal(value.fixture.database.inTransaction, false);
    assert.equal((await value.fixture.database.rows('BaseItems', { where: { Id: id(3) } }))[0].ParentId, id(1));
    assert.equal((await value.fixture.vfs.stat('/item-delete/media/sibling.keep')).kind, 'file');
  });
}
test('postgres: batch lookup after a persistence-only owned Audio closure returns 404 without deleting its source', enabled, async t => {
  const value = await setup(t, { owned: true });
  assert.equal((await value.request([2, 3, 4])).status, 404);
  assert.deepEqual(await value.state(), [removed, { ...untouched, row: false, lookup: false }, untouched]);
  assert.deepEqual(value.events, [{ id: guid(id(2)), parentId: guid(id(1)) }]);
});
test('postgres: single ordinary Audio HTTP deletion uses the same lifecycle', enabled, async t => {
  const value = await setup(t);
  assert.deepEqual(await value.request(2), { status: 204, body: '' });
  assert.deepEqual(await value.state(), [removed, untouched, untouched]);
});
test('postgres: generic batch deletion uses actual WebDAV and preserves the second source-failure prefix', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_WEBDAV_EXECUTABLE,
}, async t => {
  const service = await startActualWebDav({ evidenceDirectory: process.env.MEDIAMANAGER_ITEM_DELETE_WEBDAV_EVIDENCE });
  t.after(() => service.stop());
  const value = await setup(t), requests = [];
  value.fixture.storage.registerType('webdav', config => new WebDavAdapter(config, { resolveCredential: async () => service.authorization,
    fetch: async (url, options) => {
      const pathname = new URL(url).pathname;
      requests.push({ method: options.method, path: pathname });
      if (options.method === 'DELETE' && pathname.endsWith('/second.flac')) return new Response('Controlled second source failure', { status: 503 });
      return fetch(url, options);
    } }));
  await value.fixture.storage.createInstance('http-delete-webdav', 'webdav', { baseUrl: service.baseUrl,
    credentialRef: 'isolated-generic-http-delete', capabilities });
  value.fixture.vfs.mount({ path: '/http-delete-webdav', instanceId: 'http-delete-webdav', capabilities });
  await value.fixture.vfs.mkdir('/http-delete-webdav/media');
  for (const [index, name] of ['first', 'second', 'third'].entries()) {
    const access = '/http-delete-webdav/media/' + name + '.flac';
    await value.fixture.vfs.write(access, Buffer.from(name));
    value.fixture.identityMap.bind(id(index + 2), access); value.accessPaths[index] = access;
  }
  requests.length = 0;
  assert.equal((await value.request([2, 3, 4])).status, 500);
  assert.deepEqual(await value.state(), [removed, { ...untouched, internal: false }, untouched]);
  assert.deepEqual(requests.filter(request => request.method === 'DELETE').map(request => request.path), ['/dav/media/first.flac', '/dav/media/second.flac']);
  assert.deepEqual(value.events, [{ id: guid(id(2)), parentId: guid(id(1)) }]);
  const handle = await value.fixture.vfs.openRead(value.accessPaths[1]);
  try { const chunks = []; for await (const chunk of handle.stream) chunks.push(chunk); assert.equal(Buffer.concat(chunks).toString(), 'second'); }
  finally { await handle.close(); }
  assert.equal(value.fixture.database.inTransaction, false);
});
