import test from 'node:test';
import { createTestMediaEncoder } from '../helpers/media-encoder.js';
import { prepareFrozenVideo } from '../helpers/frozen-av.js';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProbeService } from '../../src/library/probe-service.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { AListAdapter } from '../../plugins/alist/adapter.js';
import { WebDavAdapter } from '../../plugins/webdav/adapter.js';
import { beforeMetadataRefresh } from '../../src/metadata/before-refresh.js';
import { beforeEpisodeMetadataRefresh } from '../../src/metadata/episode-before-refresh.js';
import { setupChildrenFixture } from './children-fixture.js';
import { startActualAList } from '../storage/helpers/actual-alist.js';
import { startActualWebDav } from '../storage/helpers/actual-webdav.js';

const native = JSON.parse(await readFile(new URL('./fixtures/episode-before-refresh/native.json', import.meta.url), 'utf8'));
const input = JSON.parse(await readFile(new URL('./fixtures/episode-before-refresh/input.json', import.meta.url), 'utf8'));
const scenario = input.find(entry => entry.name === 'embedded Library force=false');
const expected = native.results.find(entry => entry.name === scenario.name).result;
const identityRoot = 'Z:\\ChildrenMetadata', filename = '中文 %2F # Show S01E02.mp4';
const accessPath = '/network/' + filename, identityPath = identityRoot + '\\' + filename;

for (const dialect of ['postgres']) for (const protocol of ['alist', 'webdav']) test(`${dialect}/${protocol}: real ffprobe reads embedded MP4 episode tags through network storage without early persistence`, {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_ALIST_EXECUTABLE || !process.env.MEDIAMANAGER_WEBDAV_EXECUTABLE
    ? 'Isolated PostgreSQL and actual AList/WebDAV executables are required.' : false,
}, async t => {
  const fixture = await setupChildrenFixture(t, dialect);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'episode-embedded-'));
  t.after(async () => {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('episode-embedded-')) throw new Error('Unexpected embedded probe fixture root.');
    await rm(directory, { recursive: true, force: true });
  });
  const prepared = await prepareFrozenVideo(directory, { container: 'mp4', name: 'fixture',
    metadata: { season_number: '4', episode_sort: '5', show_name: 'Embedded series' }, signal: t.signal });
  const bytes = prepared.bytes;
  const service = protocol === 'alist' ? await startActualAList({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES }) : await startActualWebDav();
  t.after(() => service.stop());
  const registry = new StorageRegistry(); t.after(() => registry.close());
  const requests = [];
  const dependencies = { resolveCredential: async () => protocol === 'alist' ? service.token : service.authorization,
    fetch: async (url, settings) => {
      const response = await fetch(url, settings);
      requests.push({ method: settings.method ?? 'GET', path: new URL(url).pathname, status: response.status });
      return response;
    } };
  registry.registerType(protocol, configuration => protocol === 'alist' ? new AListAdapter(configuration, dependencies) : new WebDavAdapter(configuration, dependencies));
  await registry.createInstance('actual', protocol, { baseUrl: service.baseUrl, credentialRef: 'isolated', capabilities: { create: true, replace: true } });
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/network', instanceId: 'actual', root: protocol === 'alist' ? '/Synthetic' : '/', capabilities: { create: true, replace: true } });
  await vfs.write(accessPath, bytes, { overwrite: false, size: BigInt(bytes.length) });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot, accessRoot: '/network', style: 'windows', returnAccess: 'Isolated MP4 embedded episode fixture.' });
  const probe = new ProbeService({ store: fixture.store, vfs, identityMap, mediaEncoder: await createTestMediaEncoder(t) });
  t.after(() => probe.close());
  const Id = await fixture.seed({ target: scenario.target, items: scenario.items.map(entry => ({ ...entry, key: entry.Id,
    ...entry.Id === scenario.target ? { Path: identityPath, Container: 'mp4', MediaType: 'Video' } : {} })) });
  const loaded = await fixture.loadContext(Id); loaded.context.accessPath = accessPath; loaded.libraryOptions.EnableEmbeddedEpisodeInfos = true;
  const before = await fixture.database.rows('BaseItems');
  const media = await probe.readMediaInfo(loaded);
  assert.equal(media.ParentIndexNumber, 4); assert.equal(media.IndexNumber, 5); assert.equal(media.ShowName, 'Embedded series');
  assert.ok(media.MediaStreams.length > 0); assert.ok(media.RunTimeTicks > 0n);
  assert.deepEqual(await fixture.database.rows('BaseItems'), before); assert.deepEqual(await fixture.database.rows('MediaStreamInfos'), []);
  beforeMetadataRefresh(loaded.item, loaded);
  assert.equal(await beforeEpisodeMetadataRefresh(loaded.item, loaded, { probe }), expected.changed);
  for (const field of ['SeriesName', 'IndexNumber', 'IndexNumberEnd', 'ParentIndexNumber', 'SortName']) assert.equal(loaded.item[field] ?? null, expected.item[field]);
  assert.deepEqual(await fixture.database.rows('BaseItems'), before);
  assert.ok(requests.some(request => request.method === 'GET' && [200, 206].includes(request.status)));
  await fixture.host.updates.update(loaded, { Item: loaded.item }, 2);
  const saved = await fixture.loadContext(Id);
  assert.equal(saved.item.SeriesName, expected.item.SeriesName); assert.equal(saved.item.IndexNumber, 5); assert.equal(saved.item.ParentIndexNumber, 4);
  assert.equal(saved.snapshot.Path, identityPath); assert.equal(saved.snapshot.RunTimeTicks, null);
  assert.deepEqual(await fixture.database.rows('MediaStreamInfos'), []);
  const handle = await vfs.openRead(accessPath);
  try { const received = []; for await (const chunk of handle.stream) received.push(Buffer.from(chunk)); assert.deepEqual(Buffer.concat(received), bytes); }
  finally { await handle.close(); }
});
