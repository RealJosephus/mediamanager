import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { tableDefinition } from '../../src/database/model.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { IdentityAccessMap, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { validationExecutable } from '../../tools/validation/paths.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';

test('PlaybackInfo imports a changed local movie NFO when the primary video stream is missing', async t => {
  const empty = Object.fromEntries(tableDefinition('BaseItems').columns.filter(c => !c.generated)
    .map(c => [c.name, c.nullable ? null : c.clrType === 'bool' ? false : c.type === 'TEXT' ? '' : 0]));
  const [root, userRoot, folder, collection, movie] = ['1','2','3','4','5'].map(n => 'C1111111-1111-1111-1111-11111111111' + n);
  const identity = 'Z:\\Fixture';
  const program = await mkdtemp(path.join(os.tmpdir(), 'review-media-'));
  const db = await createPostgresTestDatabase(null, 'review_media');
  const registry = new StorageRegistry();
  let runtime;
  t.after(async () => { try { await runtime?.close(); } finally { try { await registry.close(); } finally {
    try { await dropPostgresTestDatabase(db); } finally { await rm(program, { recursive: true, force: true }); } } } });
  async function put(Id, suffix, fields) { await db.insert('BaseItems', { ...empty, Id, Name: suffix, IsFolder: true, Data: '{}',
    Type: 'MediaBrowser.Controller.Entities.' + suffix, ...fields }); }
  await put(root, 'AggregateFolder'); await put(userRoot, 'UserRootFolder');
  await put(folder, 'Folder', { Path: identity, ParentId: root });
  await put(collection, 'CollectionFolder', { ParentId: userRoot,
    Data: JSON.stringify({ CollectionType: 'movies', PhysicalFolderIds: [folder], PhysicalLocationsList: [identity] }) });
  await put(movie, 'Movies.Movie', { Path: identity + '\\movie.mkv', Name: 'Previous title', ParentId: folder,
    TopParentId: folder, IsFolder: false, MediaType: 'Video', IsInMixedFolder: true,
    DateLastRefreshed: '2021-02-03 12:12:12', DateLastSaved: '2021-02-03 12:12:12' });
  registry.registerType('memory', () => new MemoryStorageAdapter()); await registry.createInstance('fixture', 'memory', {});
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/fixture', instanceId: 'fixture', capabilities: { create: true, replace: true, delete: true } });
  const map = new IdentityAccessMap();
  map.addPrefix({ identityRoot: identity, accessRoot: '/fixture', style: 'windows', returnAccess: 'Isolated test media' });
  await vfs.write('/fixture/movie.mkv', await readFile(new URL('../playback/fixtures/vobsub-delivery/source.mkv', import.meta.url)));
  await vfs.write('/fixture/movie.nfo', Buffer.from('<movie><title>Sidecar title</title><plot>Sidecar plot</plot></movie>'));
  runtime = await createTestRuntime({ database: db, serverId: '682195b836dd48e78b8c2154aa232c11', programDataPath: program, vfs, identityMap: map,
    mediaEncoderOptions: { startupFFmpegPath: validationExecutable('ffmpeg') },
    configuration: { ...defaultConfiguration('server'), IsStartupWizardCompleted: true },
    libraryOptions: new Map([[collection.replaceAll('-', '').toLowerCase(), {
      TypeOptions: [{ Type: 'Movie', MetadataFetchers: [], ImageFetchers: [] }], MetadataSavers: [] }]]) });
  await runtime.plugins.setEnabled('tmdb', false);
  const { AccessToken } = await runtime.apiKeys.create('Review fixture');
  const port = runtime.networkHost.listeners.find(x => x.bound && x.scheme === 'http').port;
  const request = await fetch('http://127.0.0.1:' + port + '/Items/' + movie + '/PlaybackInfo', {
    headers: { Authorization: 'MediaBrowser Token="' + AccessToken + '"' } });
  const body = await request.text();
  assert.equal(request.status, 200, body);
  assert.ok(JSON.parse(body).MediaSources[0].MediaStreams.some(s => s.Type === 'Video'), 'A real ffprobe populated video tracks');
  const stored = async () => { const [row] = await db.rows('BaseItems', { where: { Id: movie } }); return { Name: row.Name, Overview: row.Overview }; };
  const afterPlayback = await stored();
  await runtime.metadata.refresh(movie, { MetadataRefreshMode: 'FullRefresh', EnableRemoteContentProbe: true, ImageRefreshMode: 'None' });
  const control = await stored();
  t.diagnostic(JSON.stringify({ afterPlayback, afterExplicitRefresh: control }));
  assert.equal(control.Overview, 'Sidecar plot', 'Full metadata refresh imports the ordinary NFO');
  assert.deepEqual(afterPlayback, control);
});
