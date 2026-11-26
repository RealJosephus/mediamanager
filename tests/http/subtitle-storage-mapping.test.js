import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { md5Guid, lowerInvariant } from '../../src/core/identity.js';
import { registerSubtitleManagementRoutes } from '../../src/http/subtitle-management-routes.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { IdentityAccessMap, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';

test('subtitle upload, provider download and deletion use the appropriate storage mapping', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mm-subtitle-mapping-'));
  const registry = new StorageRegistry(), vfs = new VirtualFileSystem(registry);
  t.after(async () => { try { await registry.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  registry.registerType('local', config => new LocalAdapter(config));
  const identity = path.join(root, 'identity');
  async function mapping(name) {
    const mount = '/' + name, backing = path.join(root, name);
    await mkdir(backing);
    await registry.createInstance(name, 'local', { root: backing, writable: true });
    vfs.mount({ path: mount, instanceId: name, capabilities: { create: true, replace: true, mkdir: true, rename: true, delete: true } });
    const map = new IdentityAccessMap();
    map.addPrefix({ identityRoot: identity, accessRoot: mount, style: process.platform === 'win32' ? 'windows' : 'posix',
      returnAccess: 'Owned subtitle fixture' });
    return map;
  }
  const mediaMap = await mapping('media'), metadataMap = await mapping('metadata');
  const fileSystem = new StorageFileSystem({ vfs, identityMap: metadataMap });
  const item = { Id: '59000000-0000-0000-0000-000000000001', Type: 'Movie', Path: path.join(identity, 'film.mkv') };
  const folder = { Id: '59000000-0000-0000-0000-000000000002', Type: 'CollectionFolder' };
  const options = { SaveSubtitlesWithMedia: false };
  const library = { options: { metadataPath: identity, libraryOptions: new Map([[folder.Id, options]]) },
    getCollectionFolders: async () => [folder], withItemRecord: async (_id, _user, read) => read(item) };
  const provider = { name: 'Fixture provider', async getSubtitles(id) {
    assert.equal(id, 'remote');
    return { bytes: Buffer.from('downloaded subtitle'), format: 'SRT', language: 'fr' };
  } };
  let streamPath;
  const errors = [], routes = new Map();
  registerSubtitleManagementRoutes((method, uri, handle) => routes.set(method + ' ' + uri, handle), {
    library, playback: { vfs, identityMap: mediaMap }, storage: { fileSystem },
    metadata: { queue: async () => {}, refreshLiveItem: async () => {} },
    store: { run: operation => operation({ rows: async () => [{ Path: streamPath }] }) },
    plugins: { entries: () => [provider] }, onError: error => errors.push(error),
  });
  const upload = routes.get('POST /Videos/{itemId}/Subtitles');
  const download = routes.get('POST /Items/{itemId}/RemoteSearch/Subtitles/{subtitleId}');
  const remove = routes.get('DELETE /Videos/{itemId}/Subtitles/{index}');
  const subtitle = { Format: 'srt', Language: 'en', Data: Buffer.from('uploaded subtitle').toString('base64') };
  const compact = item.Id.replaceAll('-', ''), directory = path.join('library', compact.slice(0, 2), compact);
  const english = path.join(directory, 'film.en.srt'), french = path.join(directory, 'film.fr.srt');
  const read = (mount, file) => readFile(path.join(root, mount, file), 'utf8');
  assert.equal((await upload({ queryInput: item.Id, auth: {}, body: subtitle })).status, 204);
  assert.equal((await download({ queryInput: { itemId: item.Id, subtitleId: md5Guid(lowerInvariant(provider.name)) + '_remote' }, auth: {} })).status, 204);
  assert.deepEqual(errors, []);
  assert.equal(await read('metadata', english), 'uploaded subtitle');
  assert.equal(await read('metadata', french), 'downloaded subtitle');
  await assert.rejects(read('media', english), { code: 'ENOENT' });
  await assert.rejects(read('media', french), { code: 'ENOENT' });

  // A setting change only affects new saves. Deletion follows the stored path.
  options.SaveSubtitlesWithMedia = true;
  await mkdir(path.join(root, 'media', directory), { recursive: true });
  await writeFile(path.join(root, 'media', french), 'independent media mount content');
  streamPath = path.join(identity, french);
  const deletion = { auth: {}, queryInput: { itemId: item.Id, index: 0 } };
  assert.equal((await remove(deletion)).status, 204);
  await assert.rejects(read('metadata', french), { code: 'ENOENT' });
  assert.equal(await read('media', french), 'independent media mount content');
  assert.equal((await upload({ queryInput: item.Id, auth: {}, body: subtitle })).status, 204);
  const sidecar = 'film.en.srt';
  assert.equal(await read('media', sidecar), 'uploaded subtitle');
  await assert.rejects(read('metadata', sidecar), { code: 'ENOENT' });
  options.SaveSubtitlesWithMedia = false;
  streamPath = path.join(identity, sidecar);
  assert.equal((await remove(deletion)).status, 204);
  await assert.rejects(read('media', sidecar), { code: 'ENOENT' });
  assert.equal(await read('metadata', english), 'uploaded subtitle');
});
