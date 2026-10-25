import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTestApplication } from '../helpers/application.js';
import { AuthenticationService } from '../../src/users/authentication-service.js';
import { LiveTvRecordingsService } from '../../src/library/live-tv-recordings-service.js';
import { LiveTvService } from '../../src/library/live-tv-service.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { ItemDeletionService } from '../../src/library/item-deletion-service.js';
import { ExternalDataManager } from '../../src/library/external-data.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { internalImagePath } from '../../src/metadata/image-paths.js';
import { idKey } from '../../src/library/records.js';
import { setFolderChildren } from '../../src/library/folder-cache.js';
import { setupChildrenFixture, useIdentityPathReversalControl } from '../metadata/children-fixture.js';
import { testFileSystem } from '../storage/plugin-files.js';

const id = index => `a9400000-0000-0000-0000-${String(index).padStart(12, '0')}`;
const userFor = (access, management) => ({ Id: idKey(id(9)), Policy: { EnableLiveTvAccess: access,
  EnableLiveTvManagement: management, EnableRemoteAccess: true, EnableAllFolders: true,
  EnableContentDeletion: false, EnableContentDeletionFromFolders: [], BlockedTags: [], AllowedTags: [], BlockUnratedItems: [] } });

async function application(t, services) {
  const subjects = { access: userFor(true, false), management: userFor(false, true), denied: userFor(false, false) };
  const users = { getUser: async value => idKey(value) === idKey(id(9)) ? subjects.management : null };
  const authentication = new AuthenticationService({ store: {}, users, serverId: 'recording-route-tests' });
  const app = await createTestApplication({ ...services, users, configuration: { IsStartupWizardCompleted: true },
    authentication: { authorize: authentication.authorize.bind(authentication), authenticate: async request => {
      const role = request.headers['x-fixture-subject'];
      if (role === 'apiKey') return { IsAuthenticated: true, IsApiKey: true, IsAdministrator: true, UserId: '0'.repeat(32) };
      const user = subjects[role];
      return { IsAuthenticated: Boolean(user), IsApiKey: false, IsAdministrator: false, UserId: user?.Id, User: user };
    } } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  return async (route, { method = 'GET', role = 'access' } = {}) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${route}`, { method, headers: { 'X-Fixture-Subject': role } });
    const text = await response.text();
    return { status: response.status, contentType: response.headers.get('content-type'), text,
      ...(/json/u.test(response.headers.get('content-type') ?? '') && text && { body: JSON.parse(text) }) };
  };
}

test('recording routes bind retained actions and distinguish access from management', async t => {
  const calls = [];
  const request = await application(t, { liveTvRecordings: {
    getRecordings: async (input, options) => { calls.push({ input, options }); return { Items: [], TotalRecordCount: 0, StartIndex: input.startindex ?? 0 }; },
    getFolders: async () => ({ Items: [], TotalRecordCount: 0, StartIndex: 0 }),
    getRecording: async () => { throw Object.assign(new Error('Controlled missing item.'), { status: 404 }); },
    deleteRecording: async () => true,
  } });
  assert.equal((await request('/LiveTv/Recordings', { role: 'absent' })).status, 401);
  assert.equal((await request('/LiveTv/Recordings', { role: 'management' })).status, 403);
  assert.equal((await request('/LiveTv/Recordings/' + id(2), { method: 'DELETE', role: 'access' })).status, 403);
  assert.equal((await request('/LiveTv/Recordings/' + id(2), { method: 'DELETE', role: 'management' })).status, 204);
  assert.equal((await request('/LiveTv/Recordings/' + id(2), { method: 'DELETE', role: 'apiKey' })).status, 204);
  const selected = await request('/LiveTv/Recordings?startIndex=-3&limit=4&status=unknown&isMovie=true&isNews=false&fields=Tags,Unknown&enableImageTypes=Primary,Unknown');
  assert.equal(selected.status, 200);
  assert.equal(calls[0].input.startindex, -3); assert.equal(calls[0].input.limit, 4);
  assert.equal(calls[0].input.status, undefined); assert.equal(calls[0].input.ismovie, true); assert.equal(calls[0].input.isnews, false);
  assert.deepEqual(calls[0].input.fields, ['Tags']); assert.deepEqual(calls[0].input.enableimagetypes, ['Primary']);
  for (const route of ['/LiveTv/Recordings?limit=x', '/LiveTv/Recordings/Series?isInProgress=1',
    '/LiveTv/Recordings/Groups?userId=invalid', '/LiveTv/Recordings/invalid']) {
    const result = await request(route); assert.equal(result.status, 400); assert.ok(result.body.errors);
  }
  assert.equal((await request('/LiveTv/Recordings?userId=' + id(8))).status, 403);
  assert.equal((await request('/LiveTv/Recordings/Series?userId=' + id(8) + '&startIndex=9')).body.StartIndex, 0);
  assert.equal((await request('/LiveTv/Recordings/Groups?userId=' + id(8))).body.TotalRecordCount, 0);
  const missing = await request('/LiveTv/Recordings/' + id(99));
  assert.equal(missing.status, 404); assert.match(missing.contentType, /application\/json/u);
  assert.equal(missing.body.title, 'Not Found'); assert.equal(missing.body.status, 404);
});

test('LiveTvManagement deletes an existing ordinary item through the real library lifecycle while retaining source media', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000,
}, async t => {
  const fixture = await setupChildrenFixture(t);
  useIdentityPathReversalControl(fixture);
  fixture.vfs.mount({ path: '/recording-delete', instanceId: 'fixture', capabilities: { create: true, replace: true, mkdir: true, delete: true } });
  fixture.identityMap.addPrefix({ identityRoot: 'Z:\\ExistingRecordings', accessRoot: '/recording-delete/media', style: 'windows',
    returnAccess: 'Existing recording DB-only deletion control.' });
  await fixture.adapter.mkdir('/media');
  await fixture.adapter.write('/media/source.flac', Buffer.from('retained ordinary audio'));
  await fixture.seed({ target: 'target', items: [
    { key: 'parent', type: 'Folder', Id: id(1), Name: 'Existing recordings', Path: 'Z:\\ExistingRecordings' },
    { key: 'target', type: 'Audio', Id: id(2), Name: 'Retained source', parent: 'parent', Path: 'Z:\\ExistingRecordings\\source.flac', IsInMixedFolder: false },
  ] });
  const creator = new ItemCreationService(fixture); fixture.library.itemCreation = creator;
  t.after(() => creator.close());
  const parent = await creator.getItemById(id(1)), item = await creator.getItemById(id(2));
  setFolderChildren(parent, [item]); parent.UserData = [];
  const loaded = await fixture.loadContext(item.Id, { draft: item });
  const assets = new MetadataImageAssets({ fileSystem: testFileSystem, ...fixture, metadataPath: loaded.metadataPath, stateRoots: [loaded.dataPath] });
  const external = new ExternalDataManager({ fileSystem: testFileSystem, ...fixture, dataPath: loaded.dataPath, metadataPath: loaded.metadataPath });
  const markers = [path.join(internalImagePath(item, loaded.metadataPath), 'marker.txt'), path.join(external.paths(item, loaded)[0], 'marker.txt')];
  for (const marker of markers) await assets.write(marker, Buffer.from('owned metadata'));
  await loaded.dispose();
  fixture.library.itemDeletion = new ItemDeletionService({ ...fixture, itemCreation: creator, updates: fixture.host.updates,
    externalData: external, linkedChildReferences: { reroute: async () => [] }, now: () => fixture.now });
  const events = []; fixture.library.on('ItemRemoved', event => events.push(idKey(event.Item.Id)));
  const user = userFor(false, true);
  assert.equal((await fixture.library.getDeletionItem(item.Id, { user })).canDelete, false);
  const liveTv = new LiveTvService(); t.after(() => liveTv.close());
  const liveTvRecordings = new LiveTvRecordingsService({ liveTv, library: fixture.library, mediaAssets: assets, dataPath: loaded.dataPath });
  const request = await application(t, { liveTvRecordings });
  assert.equal((await request('/LiveTv/Recordings/' + item.Id, { method: 'DELETE', role: 'management' })).status, 204);
  assert.deepEqual(await fixture.database.rows('BaseItems', { where: { Id: item.Id } }), []);
  assert.equal(await creator.getItemById(item.Id), null);
  assert.equal((await fixture.vfs.stat('/recording-delete/media/source.flac')).kind, 'file');
  for (const marker of markers) await assert.rejects(assets.stat(marker), error => ['not-found', 'ENOENT'].includes(error.code));
  assert.deepEqual(events, [idKey(item.Id)]);
  assert.equal((await request('/LiveTv/Recordings/' + item.Id, { method: 'DELETE', role: 'management' })).status, 404);
  assert.equal((await request('/LiveTv/Recordings/' + '0'.repeat(32), { method: 'DELETE', role: 'management' })).status, 400);
});
