import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition, quoteIdentifier as q } from '../../src/database/model.js';
import { createRuntime } from '../../src/runtime.js';
import { defaultLibraryOptions } from '../../src/library/options.js';
import { readXml, child } from '../../src/core/xml.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { knownAncestorIgnoreIdentityMap } from '../library/ignore-namespace-fixture.js';
import { validationExecutable, validationOutputRoot } from '../../tools/validation/paths.js';
import { makeUdfImage } from '../storage/fixtures/udf-disc-type.js';
import { makeBlurayFiles } from '../storage/fixtures/bluray-disc-info/fixture.js';
import blurayFixture from '../storage/fixtures/bluray-disc-info/input.json' with { type: 'json' };

const ids = { folder: '85000000-0000-0000-0000-000000000001', collection: '85000000-0000-0000-0000-000000000002',
  userRoot: '85000000-0000-0000-0000-000000000003' };
const identityRoot = 'Z:\\MetadataScan';
const blank = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => [column.name,
  column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));
const row = (Id, type, values = {}) => ({ ...blank('BaseItems'), Id, Type: `MediaBrowser.Controller.Entities.${type}`,
  Name: type, CleanName: type.toLowerCase(), SortName: type.toLowerCase(), IsFolder: true, Data: '{}', ...values });
const nfo = (kind, title, locked = false, extra = '') => Buffer.from(`<${kind}><title>${title}</title><plot>Stored sidecar overview</plot>${locked ? '<lockdata>true</lockdata>' : ''}${extra}<custom keep="true">retained</custom></${kind}>`);
const read = async (vfs, pathname) => {
  const handle = await vfs.openRead(pathname);
  try { const chunks = []; for await (const bytes of handle.stream) chunks.push(bytes); return Buffer.concat(chunks); }
  finally { await handle.close(); }
};

async function setup(t, collectionType, { writable = true, global = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'metadata-scan-'));
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES, schema = `scan_metadata_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const storage = new StorageRegistry();
  let database, runtime;
  t.after(async () => {
    const cleanupErrors = [];
    const attempt = async operation => { try { await operation(); } catch (error) { cleanupErrors.push(error); } };
    await attempt(() => runtime?.close()); await attempt(() => database?.close()); await attempt(() => storage.close());
    // Teardown owns these two isolated schemas. Use an administrative connection
    // solely for deletion; opening a production database is not a cleanup step.
    const cleanup = new pg.Client({ connectionString });
    await attempt(async () => {
      assert.match(schema, /^scan_metadata_[a-f0-9]{16}$/u);
      await cleanup.connect();
      await cleanup.query(`DROP SCHEMA IF EXISTS ${q(schema)}, ${q(schema + '__mm')} CASCADE`);
    });
    await attempt(() => cleanup.end());
    await attempt(async () => {
      assert.equal(path.dirname(directory), os.tmpdir());
      assert.ok(path.basename(directory).startsWith('metadata-scan-'));
      await rm(directory, { recursive: true, force: true });
    });
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Folder metadata scan cleanup failed.');
  });
  database = await PostgresDatabase.open({ connectionString, schema, create: true });
  storage.registerType('fixture', () => new MemoryStorageAdapter());
  const adapter = await storage.createInstance('fixture', 'fixture', {});
  const vfs = new VirtualFileSystem(storage); vfs.mount({ path: '/media', instanceId: 'fixture',
    capabilities: writable ? { create: true, replace: true, delete: true, conditionalWrite: true } : {} });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot, accessRoot: '/media', style: 'windows', returnAccess: 'isolated scan and probe fixture' });
  const programDataPath = path.join(directory, 'data'); await mkdir(path.join(programDataPath, 'data'), { recursive: true });
  await writeFile(path.join(programDataPath, 'data', 'device.txt'), 'b'.repeat(32));
  if (global) {
    // Supplying a media VFS bypasses the runtime's configured application
    // mounts. Automatic collections still need their real state directories
    // reachable through that same VFS for queued folder validation.
    storage.registerType('state-local', configuration => LocalAdapter.open(configuration));
    await storage.createInstance('state-local', 'state-local', { root: programDataPath, writable: true });
    vfs.mount({ path: '/state', instanceId: 'state-local', capabilities: {
      create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true
    } });
    identityMap.addPrefix({ identityRoot: programDataPath, accessRoot: '/state',
      style: process.platform === 'win32' ? 'windows' : 'posix', returnAccess: 'Actual isolated application state.' });
  }
  const errors = [], libraryOptions = {
    SaveLocalMetadata: true, MetadataSavers: ['Nfo'], EnableInternetProviders: false,
    TypeOptions: ['Movie', 'Series', 'Season', 'Episode', 'MusicAlbum', 'MusicArtist'].map(Type => ({ Type, MetadataFetchers: [], ImageFetchers: [] }))
  };
  runtime = await createRuntime({ database, vfs, identityMap, programDataPath,
    ignoreIdentityMap: await knownAncestorIgnoreIdentityMap({ registry: storage, vfs, identityMap,
      identityRoots: global ? [identityRoot, programDataPath] : [identityRoot], adapterType: 'fixture' }),
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true, LibraryScanFanoutConcurrency: 1 },
    serverId: 'metadata-scan-test', libraryOptions: new Map(global ? [] : [[ids.collection.replaceAll('-', ''), libraryOptions]]),
    probeOptions: { ffprobePath: validationExecutable('ffprobe') }, onError: error => errors.push(error) });
  if (global) {
    // Keep the real NFO reader/saver and every production post-scan task. This
    // input has no online metadata or images and does not exercise watching.
    await runtime.plugins.setEnabled('tmdb', false);
    await runtime.libraryConfiguration.addVirtualFolder('Movies', collectionType, {
      ...defaultLibraryOptions(), ...libraryOptions, AutomaticallyAddToCollection: true,
      PathInfos: [{ Path: identityRoot }]
    }, false);
  } else {
    const root = (await database.rows('BaseItems')).find(item => item.Type === 'MediaBrowser.Controller.Entities.AggregateFolder');
    await database.insert('BaseItems', row(ids.userRoot, 'UserRootFolder'));
    await database.insert('BaseItems', row(ids.folder, 'Folder', { Path: identityRoot, ParentId: root.Id, TopParentId: ids.folder }));
    await database.insert('BaseItems', row(ids.collection, 'CollectionFolder', { ParentId: ids.userRoot,
      Data: JSON.stringify({ CollectionType: collectionType, PhysicalLocationsList: [identityRoot], PhysicalFolderIds: [ids.folder] }) }));
  }
  const created = await runtime.users.createUser({ Name: 'ScanAdmin', Password: 'scan-password' });
  await runtime.users.updatePolicy(created.Id, { ...(await runtime.users.getUser(created.Id)).Policy, IsAdministrator: true });
  const login = await runtime.authentication.login({ Username: 'ScanAdmin', Pw: 'scan-password' }, { Client: 'ScanTest', Device: 'Fixture', DeviceId: 'scan-test', Version: '1' });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const post = (query = '', pathname = `/Items/${ids.folder}/Refresh`) => fetch(`http://127.0.0.1:${runtime.server.address().port}${pathname}?${query}`, {
    method: 'POST', headers: { Authorization: `MediaBrowser Token="${login.AccessToken}", Client="ScanTest", Device="Fixture", DeviceId="scan-test", Version="1"` }
  });
  const generate = async (audio, { dvd = false, bluray = false } = {}) => {
    if (bluray) {
      const filename = path.join(directory, 'movie.m2ts');
      const result = spawnSync(validationExecutable('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=size=720x480:rate=30000/1001:duration=2',
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '2',
        '-c:v', 'mpeg2video', '-b:v', '2000k', '-c:a', 'ac3', '-b:a', '192k',
        '-streamid', '0:4113', '-streamid', '1:4352', '-mpegts_m2ts_mode', '1', '-f', 'mpegts', filename],
      { windowsHide: true });
      assert.equal(result.status, 0, result.stderr?.toString()); return readFile(filename);
    }
    const filename = path.join(directory, audio ? 'track.wav' : dvd ? 'movie.vob' : 'movie.mkv');
    const result = spawnSync(validationExecutable('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
      audio ? 'anullsrc=r=8000:cl=mono' : dvd ? 'color=size=720x480:rate=30000/1001:duration=0.2' : 'color=size=32x32:rate=10:duration=0.2', '-t', '0.2',
      ...(audio ? ['-c:a', 'pcm_s16le'] : dvd ? ['-c:v', 'mpeg2video', '-f', 'vob'] : ['-c:v', 'ffv1']), filename], { windowsHide: true });
    assert.equal(result.status, 0, result.stderr?.toString()); return readFile(filename);
  };
  return { runtime, database, adapter, vfs, post, errors, generate, programDataPath,
    user: await runtime.users.getUser(created.Id) };
}

{
  const dialect = 'postgres';
  const options = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES };
  test(`${dialect}: queued None refresh rebuilds Movie and Folder identities when directory contents change`, options, async t => {
    const { runtime, database, adapter, vfs, post, errors, generate } = await setup(t, 'movies');
    const bytes = await generate(false);
    const directoryPath = identityRoot + '\\Dynamic';
    const moviePath = directoryPath + '\\Story (2024).mkv';
    await adapter.mkdir('/Dynamic');
    await adapter.write('/Dynamic/Story (2024).mkv', bytes);
    const events = [];
    for (const kind of ['ItemAdded', 'ItemRemoved']) runtime.library.on(kind, event => {
      events.push({ kind, id: event.Item.Id });
    });
    const refresh = async () => {
      assert.equal((await post('metadataRefreshMode=None&imageRefreshMode=None')).status, 204);
      await runtime.metadata.drain();
      assert.deepEqual(errors, []);
      assert.deepEqual(await read(vfs, '/media/Dynamic/Story (2024).mkv'), bytes);
      return database.rows('BaseItems');
    };
    const curate = async (id, label) => {
      // These values exist only in the database. No NFO carries them into a
      // newly resolved item when native validation deletes the old identity.
      await database.update('BaseItems', { Id: id }, { Name: label, Overview: label });
      runtime.library.itemCreation.unregisterItem(id);
      const cold = await runtime.library.getItemRecord(id);
      assert.equal(cold.Name, label); assert.equal(cold.Overview, label);
    };
    const assertRecreated = (id, label) => {
      const removed = events.findIndex(event => event.kind === 'ItemRemoved' && event.id === id);
      const added = events.findIndex(event => event.kind === 'ItemAdded' && event.id === id);
      assert.ok(removed >= 0, label + ': old item was removed');
      assert.ok(added > removed, label + ': the same deterministic identity was recreated');
    };
    const firstRows = await refresh();
    const first = firstRows.find(item => item.Path === moviePath);
    assert.ok(first); assert.equal(first.Type, 'MediaBrowser.Controller.Entities.Movies.Movie');
    assert.equal(first.ParentId, ids.folder); assert.equal(first.IsInMixedFolder, false);
    assert.equal(firstRows.some(item => item.Path === directoryPath), false);
    await curate(first.Id, 'Curated before expansion');

    events.length = 0;
    await adapter.write('/Dynamic/Other (2023).mkv', bytes);
    const expandedRows = await refresh();
    const folder = expandedRows.find(item => item.Path === directoryPath);
    const expanded = expandedRows.find(item => item.Path === moviePath);
    const second = expandedRows.find(item => item.Path === directoryPath + '\\Other (2023).mkv');
    assert.ok(folder); assert.equal(folder.Type, 'MediaBrowser.Controller.Entities.Folder');
    assert.equal(folder.ParentId, ids.folder);
    assert.ok(expanded); assert.ok(second);
    assert.equal(expanded.Id, first.Id); assert.equal(expanded.ParentId, folder.Id);
    assert.equal(second.ParentId, folder.Id); assert.equal(expanded.IsInMixedFolder, true);
    assert.notEqual(expanded.Name, 'Curated before expansion'); assert.equal(expanded.Overview, null);
    assertRecreated(first.Id, 'expansion');
    assert.ok(events.some(event => event.kind === 'ItemAdded' && event.id === folder.Id));
    assert.deepEqual(await read(vfs, '/media/Dynamic/Other (2023).mkv'), bytes);
    await curate(first.Id, 'Curated before collapse');

    events.length = 0;
    await adapter.delete('/Dynamic/Other (2023).mkv');
    const collapsedRows = await refresh();
    const collapsed = collapsedRows.find(item => item.Path === moviePath);
    assert.ok(collapsed); assert.equal(collapsed.Id, first.Id);
    assert.equal(collapsed.ParentId, ids.folder); assert.equal(collapsed.IsInMixedFolder, false);
    assert.notEqual(collapsed.Name, 'Curated before collapse'); assert.equal(collapsed.Overview, null);
    assert.equal(collapsedRows.some(item => item.Id === folder.Id || item.Id === second.Id), false);
    assertRecreated(first.Id, 'collapse');
    assert.ok(events.some(event => event.kind === 'ItemRemoved' && event.id === folder.Id));
    assert.ok(events.some(event => event.kind === 'ItemRemoved' && event.id === second.Id));
    runtime.library.itemCreation.unregisterItem(first.Id);
    const cold = await runtime.library.getItemRecord(first.Id);
    assert.equal(cold.ParentId, ids.folder); assert.equal(cold.Overview, null);
    assert.notEqual(cold.Name, 'Curated before collapse');
  });

  for (const collectionType of ['movies', 'tvshows']) test(`${dialect}: ${collectionType} disc placeholders refresh NFO without probing media`, options, async t => {
    const { runtime, database, adapter, errors, user } = await setup(t, collectionType);
    const tv = collectionType === 'tvshows', directory = tv ? '/Stub Show/Season 01' : '';
    if (tv) { await adapter.mkdir('/Stub Show'); await adapter.mkdir(directory); }
    const files = [['disc', 'VideoFile'], ['dvd.disc', 'Dvd'], ['bluray.disc', 'BluRay']]
      .map(([suffix, videoType], index) => ({
        path: tv ? `${directory}/Stub.Show.S01E0${index + 1}.${suffix}`
          : `/Placeholder ${index + 1}/Placeholder ${index + 1}.${suffix}`,
        title: `Stored placeholder ${index + 1}`, videoType
      }));
    for (const entry of files) {
      if (!tv) await adapter.mkdir(path.posix.dirname(entry.path));
      await adapter.write(entry.path, Buffer.from('A placeholder is not playable media.'));
      await adapter.write(entry.path.replace(/\.disc$/u, '.nfo'), nfo(tv ? 'episodedetails' : 'movie', entry.title));
    }
    runtime.probe.probe = runtime.probe.probeRemote = async () => { throw new Error('A placeholder must not reach a media prober.'); };
    for (const mode of ['Default', 'FullRefresh']) {
      await runtime.metadata.queue(ids.folder, { MetadataRefreshMode: mode, ImageRefreshMode: 'None' });
      assert.deepEqual(errors, []);
      for (const entry of files) {
        const identityPath = identityRoot + entry.path.replaceAll('/', '\\');
        const [row] = await database.rows('BaseItems', { where: { Path: identityPath } });
        assert.ok(row, identityPath); assert.equal(row.Type, `MediaBrowser.Controller.Entities.${tv ? 'TV.Episode' : 'Movies.Movie'}`);
        assert.equal(row.Name, entry.title); assert.equal(row.RunTimeTicks, null);
        assert.equal(JSON.parse(row.Data).IsPlaceHolder, true); assert.equal(JSON.parse(row.Data).VideoType, entry.videoType);
        assert.deepEqual(await database.rows('MediaStreamInfos', { where: { ItemId: row.Id } }), []);
        runtime.library.itemCreation.unregisterItem(row.Id);
        await runtime.library.itemCreation.withItem(row.Id, item => {
          assert.equal(item.IsPlaceHolder, true); assert.equal(item.VideoType, entry.videoType); assert.equal(item.Name, entry.title);
        });
        const [source] = await runtime.library.getMediaSources(row.Id, { user });
        assert.equal(source.Protocol, 'File'); assert.equal(source.Path, identityPath);
        if (entry.id) assert.equal(row.Id, entry.id);
        entry.id = row.Id;
      }
    }
    for (const entry of files) await adapter.delete(entry.path);
    await runtime.metadata.queue(ids.folder, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' });
    for (const entry of files) assert.deepEqual(await database.rows('BaseItems', { where: { Id: entry.id } }), []);
    assert.deepEqual(errors, []);
  });

  for (const collectionType of ['movies', 'tvshows']) test(`${dialect}: ISO files retain classification through scanning, probe and cold refresh`, options, async t => {
    const { runtime, database, adapter, vfs, errors, generate, user } = await setup(t, collectionType);
    const tv = collectionType === 'tvshows', directory = tv ? '/Disc Show/Season 1' : '';
    if (tv) { await adapter.mkdir('/Disc Show'); await adapter.mkdir(directory); }
    const bytes = await generate(false);
    const files = [['dvd.iso', 'Dvd'], ['bluray.img', 'BluRay'], ['iso', 'BluRay']].map(([suffix, isoType], index) => ({
      path: tv ? `${directory}/Disc.Show.S01E0${index + 1}.${suffix}` : `/Image ${index + 1}.${suffix}`,
      isoType, title: `Stored image ${index + 1}`, udf: index === 2
    }));
    if (tv) files.push({ path: `${directory}/bonus.trailer.iso`, isoType: 'BluRay', udf: true, extra: true });
    for (const entry of files) {
      // Named sources exercise the fork's raw-byte ffprobe transport using a
      // known demuxable clip; the unnamed source exercises actual UDF lookup.
      await adapter.write(entry.path, entry.udf ? makeUdfImage({ discType: 'BluRay', metadata: true, extended: true }) : bytes);
      if (!entry.extra) await adapter.write(entry.path.replace(/\.(iso|img)$/u, '.nfo'), nfo(tv ? 'episodedetails' : 'movie', entry.title));
    }
    const realProbe = runtime.probe.probe.bind(runtime.probe), probedPaths = [];
    runtime.probe.probe = async (bridge, source, options) => {
      probedPaths.push(source);
      if (files.some(entry => entry.udf && source === '/media' + entry.path)) return { raw: {
        format: { duration: '0.2', size: String((await vfs.stat(source)).size), format_name: 'mpegts' },
        streams: [{ index: 0, codec_type: 'video', codec_name: 'mpeg2video', width: 720, height: 480,
          r_frame_rate: '25/1', avg_frame_rate: '25/1' }]
      } };
      return realProbe(bridge, source, options);
    };
    for (const mode of ['Default', 'FullRefresh']) {
      await runtime.metadata.queue(ids.folder, { MetadataRefreshMode: mode, ImageRefreshMode: 'None' });
      assert.deepEqual(errors, []);
      for (const entry of files) {
        const identityPath = identityRoot + entry.path.replaceAll('/', '\\');
        const [row] = await database.rows('BaseItems', { where: { Path: identityPath } });
        assert.ok(row, identityPath);
        if (!entry.extra) assert.equal(row.Name, entry.title);
        assert.equal(row.Type, `MediaBrowser.Controller.Entities.${entry.extra ? 'Trailer' : tv ? 'TV.Episode' : 'Movies.Movie'}`);
        if (entry.extra) {
          const [season] = await database.rows('BaseItems', { where: { Path: identityRoot + directory.replaceAll('/', '\\') } });
          assert.equal(row.OwnerId, season.Id); assert.equal(row.ParentId, null);
        }
        const data = JSON.parse(row.Data);
        assert.equal(data.VideoType, 'Iso'); assert.equal(data.IsoType, entry.isoType);
        assert.equal(data.Timestamp ?? null, null); assert.ok(row.RunTimeTicks > 0n);
        const [source] = await runtime.library.getMediaSources(row.Id, { user });
        assert.equal(source.VideoType, 'Iso'); assert.equal(source.IsoType, entry.isoType);
        assert.equal(source.Path, identityPath); assert.equal(source.Protocol, 'File');
        assert.ok(source.MediaStreams.some(stream => stream.Type === 'Video' && stream.Codec === (entry.udf ? 'mpeg2video' : 'ffv1')));
        runtime.library.itemCreation.unregisterItem(row.Id);
        await runtime.library.itemCreation.withItem(row.Id, item => {
          assert.equal(item.VideoType, 'Iso'); assert.equal(item.IsoType, entry.isoType);
        });
        if (entry.id) assert.equal(row.Id, entry.id);
        entry.id = row.Id;
      }
    }
    assert.ok(files.every(entry => probedPaths.includes('/media' + entry.path)));
    for (const entry of files) await adapter.delete(entry.path);
    await runtime.metadata.queue(ids.folder, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' });
    for (const entry of files) {
      assert.deepEqual(await database.rows('BaseItems', { where: { Id: entry.id } }), []);
      assert.deepEqual(await database.rows('MediaStreamInfos', { where: { ItemId: entry.id } }), []);
    }
    assert.deepEqual(errors, []);
  });

  for (const deletion of ['missing-source', 'delete-source']) test(`${dialect}: DVD directory metadata retains owned extras through cold refresh and ${deletion}`, options, async t => {
    const { runtime, database, adapter, vfs, errors, generate, user } = await setup(t, 'movies');
    await adapter.write('/outside.keep', Buffer.from('Unrelated source'));
    await adapter.mkdir('/DVD Movie'); await adapter.mkdir('/DVD Movie/VIDEO_TS'); await adapter.mkdir('/DVD Movie/extras');
    const bytes = await generate(false, { dvd: true }), extraBytes = await generate(false);
    const selected = ['/media/DVD Movie/VIDEO_TS/VTS_01_1.VOB', '/media/DVD Movie/VIDEO_TS/VTS_02_1.VOB'];
    for (const name of ['VTS_01_1.VOB', 'VTS_02_1.VOB']) await adapter.write(`/DVD Movie/VIDEO_TS/${name}`, bytes);
    // The reference selects the final underscore component of the first small
    // VOB. Menus and other components must never reach ffprobe.
    for (const name of ['VIDEO_TS.VOB', 'VTS_01_0.VOB', 'VTS_01_2.VOB']) {
      await adapter.write(`/DVD Movie/VIDEO_TS/${name}`, Buffer.from('Not playable media.'));
    }
    await adapter.write('/DVD Movie/movie.nfo', nfo('movie', 'Stored DVD movie'));
    await adapter.write('/DVD Movie/extras/Bonus.mkv', extraBytes);
    const actualProbe = runtime.probe.probe.bind(runtime.probe), probes = [];
    runtime.probe.probe = async (bridge, source, options) => {
      const result = await actualProbe(bridge, source, options);
      probes.push({ source, raw: result.raw });
      return result;
    };
    let movieId, extraId;
    for (const mode of ['Default', 'FullRefresh']) {
      probes.length = 0;
      await runtime.metadata.queue(ids.folder, { MetadataRefreshMode: mode, ImageRefreshMode: 'None' });
      assert.deepEqual(errors, []);
      const [movie] = await database.rows('BaseItems', { where: { Path: identityRoot + '\\DVD Movie' } });
      assert.ok(movie); assert.equal(movie.Type, 'MediaBrowser.Controller.Entities.Movies.Movie');
      assert.equal(movie.Name, 'Stored DVD movie'); assert.equal(JSON.parse(movie.Data).VideoType, 'Dvd');
      const vobs = probes.filter(entry => entry.source.endsWith('.VOB'));
      assert.deepEqual(vobs.map(entry => entry.source), selected);
      const expectedRuntime = vobs.reduce((ticks, entry) => ticks + BigInt(Math.trunc(Number(entry.raw.format.duration) * 10_000_000)), 0n);
      assert.ok(expectedRuntime > 0n); assert.equal(movie.RunTimeTicks, expectedRuntime);
      assert.equal(movie.Size, BigInt(vobs[0].raw.format.size));
      const [source] = await runtime.library.getMediaSources(movie.Id, { user });
      assert.equal(source.Protocol, 'File'); assert.equal(source.Path, movie.Path); assert.equal(source.VideoType, 'Dvd');
      assert.ok(source.MediaStreams.some(stream => stream.Type === 'Video' && stream.Codec === 'mpeg2video'));
      const [extra] = await database.rows('BaseItems', { where: { Path: identityRoot + '\\DVD Movie\\extras\\Bonus.mkv' } });
      assert.ok(extra); assert.equal(extra.OwnerId, movie.Id); assert.equal(extra.ParentId, null);
      assert.ok(extra.RunTimeTicks > 0n);
      runtime.library.itemCreation.unregisterItem(movie.Id);
      await runtime.library.itemCreation.withItem(movie.Id, item => {
        assert.equal(item.VideoType, 'Dvd'); assert.equal(item.RunTimeTicks, expectedRuntime); assert.equal(item.Size, movie.Size);
      });
      if (movieId) { assert.equal(movie.Id, movieId); assert.equal(extra.Id, extraId); }
      movieId = movie.Id; extraId = extra.Id;
      assert.equal(child(readXml((await read(vfs, '/media/DVD Movie/movie.nfo')).toString()), 'title').text, 'Stored DVD movie');
    }
    if (deletion === 'delete-source') {
      const removedIds = [];
      runtime.library.on('ItemRemoved', event => removedIds.push(event.Item.Id));
      await runtime.library.itemCreation.withItem(movieId,
        item => runtime.library.deleteItem(item, { DeleteFileLocation: true }));
      assert.deepEqual(removedIds, [movieId], 'Owned extras are persistence children, not logical Folder children.');
    } else await adapter.delete('/DVD Movie', { recursive: true });
    await assert.rejects(vfs.stat('/media/DVD Movie'), { code: 'not-found' });
    await runtime.metadata.queue(ids.folder, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' });
    for (const Id of [movieId, extraId]) {
      assert.deepEqual(await database.rows('BaseItems', { where: { Id } }), []);
      assert.deepEqual(await database.rows('MediaStreamInfos', { where: { ItemId: Id } }), []);
    }
    assert.equal((await read(vfs, '/media/outside.keep')).toString(), 'Unrelated source');
    assert.deepEqual(errors, []);
  });

  test(`${dialect}: a DVD Episode uses its directory identity with real NFO, probe and parent relationships`, options, async t => {
    const { runtime, database, adapter, errors, generate, user } = await setup(t, 'tvshows');
    const directory = '/DVD Show/Season 1/DVD Show S01E03';
    for (const pathname of ['/DVD Show', '/DVD Show/Season 1', directory, directory + '/VIDEO_TS']) await adapter.mkdir(pathname);
    await adapter.write(directory + '/VIDEO_TS/VTS_01_1.VOB', await generate(false, { dvd: true }));
    await adapter.write(directory + '.nfo', nfo('episodedetails', 'Stored DVD episode'));
    const identityPath = identityRoot + directory.replaceAll('/', '\\');
    let episodeId;
    for (const mode of ['Default', 'FullRefresh']) {
      await runtime.metadata.queue(ids.folder, { MetadataRefreshMode: mode, ImageRefreshMode: 'None' });
      assert.deepEqual(errors, []);
      const [episode] = await database.rows('BaseItems', { where: { Path: identityPath } });
      const [season] = await database.rows('BaseItems', { where: { Path: identityRoot + '\\DVD Show\\Season 1' } });
      const [series] = await database.rows('BaseItems', { where: { Path: identityRoot + '\\DVD Show' } });
      assert.ok(episode); assert.ok(season); assert.ok(series);
      assert.equal(episode.Type, 'MediaBrowser.Controller.Entities.TV.Episode'); assert.equal(episode.IsFolder, false);
      assert.equal(episode.Name, 'Stored DVD episode'); assert.equal(episode.ParentId, season.Id);
      assert.equal(episode.SeasonId, season.Id); assert.equal(episode.SeriesId, series.Id);
      assert.equal(episode.IndexNumber, 3); assert.equal(episode.ParentIndexNumber, 1);
      assert.ok(episode.RunTimeTicks > 0n); assert.equal(JSON.parse(episode.Data).VideoType, 'Dvd');
      const [source] = await runtime.library.getMediaSources(episode.Id, { user });
      assert.equal(source.Path, identityPath); assert.equal(source.VideoType, 'Dvd'); assert.equal(source.Protocol, 'File');
      assert.ok(source.MediaStreams.some(stream => stream.Type === 'Video' && stream.Codec === 'mpeg2video'));
      runtime.library.itemCreation.unregisterItem(episode.Id);
      await runtime.library.itemCreation.withItem(episode.Id, item => {
        assert.equal(item.VideoType, 'Dvd'); assert.equal(item.Path, identityPath); assert.equal(item.ParentId, season.Id);
      });
      if (episodeId) assert.equal(episode.Id, episodeId);
      episodeId = episode.Id;
    }
    await adapter.delete(directory);
    await runtime.metadata.queue(ids.folder, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' });
    assert.deepEqual(await database.rows('BaseItems', { where: { Id: episodeId } }), []);
    assert.deepEqual(await database.rows('MediaStreamInfos', { where: { ItemId: episodeId } }), []);
    assert.deepEqual(errors, []);
  });

  for (const collectionType of ['movies', 'tvshows']) test(`${dialect}: ${collectionType} Blu-ray directories refresh real playlist media and retain their physical identity`, options, async t => {
    const { runtime, database, adapter, vfs, errors, generate, user } = await setup(t, collectionType);
    const tv = collectionType === 'tvshows';
    const directory = tv ? '/BluRay Show/Season 1/BluRay Show S01E03' : '/BluRay Movie';
    await adapter.write('/outside.keep', Buffer.from('Unrelated source'));
    let parent = '';
    for (const segment of directory.slice(1).split('/')) { parent += '/' + segment; await adapter.mkdir(parent); }
    const bytes = await generate(false, { bluray: true });
    for (const name of ['BDMV', 'BDMV/CLIPINF', 'BDMV/STREAM', 'BDMV/PLAYLIST']) await adapter.mkdir(`${directory}/${name}`);
    for (const [filename, contents] of makeBlurayFiles(blurayFixture, bytes)) await adapter.write(`${directory}/${filename}`, contents);
    const title = tv ? 'Stored Blu-ray episode' : 'Stored Blu-ray movie';
    await adapter.write(tv ? directory + '.nfo' : directory + '/movie.nfo', nfo(tv ? 'episodedetails' : 'movie', title));
    if (!tv) {
      await adapter.mkdir(directory + '/extras');
      await adapter.write(directory + '/extras/Bonus.mkv', await generate(false));
    }
    const identityPath = identityRoot + directory.replaceAll('/', '\\');
    const actualProbe = runtime.probe.probe.bind(runtime.probe), probes = [];
    runtime.probe.probe = async (bridge, source, options) => {
      const result = await actualProbe(bridge, source, options); probes.push(source); return result;
    };
    let mediaId, extraId;
    for (const mode of ['Default', 'FullRefresh']) {
      probes.length = 0;
      await runtime.metadata.queue(ids.folder, { MetadataRefreshMode: mode, ImageRefreshMode: 'None' });
      assert.deepEqual(errors, []);
      const [media] = await database.rows('BaseItems', { where: { Path: identityPath } });
      assert.ok(media); assert.equal(media.IsFolder, false); assert.equal(media.Name, title);
      assert.equal(media.Type, tv ? 'MediaBrowser.Controller.Entities.TV.Episode' : 'MediaBrowser.Controller.Entities.Movies.Movie');
      assert.equal(media.RunTimeTicks, 35000000n); assert.equal(media.Size, BigInt(bytes.length));
      assert.equal(JSON.parse(media.Data).VideoType, 'BluRay');
      assert.deepEqual(probes.filter(value => value.endsWith('.m2ts')),
        ['00002', '00001'].map(name => `/media${directory}/BDMV/STREAM/${name}.m2ts`));
      const [source] = await runtime.library.getMediaSources(media.Id, { user });
      assert.equal(source.Path, identityPath); assert.equal(source.VideoType, 'BluRay'); assert.equal(source.Protocol, 'File');
      assert.deepEqual(source.MediaStreams.map(stream => stream.Type), ['Video', 'Video', 'Audio', 'Subtitle', 'Subtitle']);
      assert.equal(source.MediaStreams[0].Codec, 'mpeg2video'); assert.equal(source.MediaStreams[0].Width, 720);
      assert.equal(source.MediaStreams[2].Channels, 2); assert.equal(source.MediaStreams[2].Language, 'eng');
      assert.deepEqual((await database.rows('Chapters', { where: { ItemId: media.Id }, orderBy: [{ column: 'ChapterIndex', direction: 'ASC' }] }))
        .map(chapter => chapter.StartPositionTicks), [0n, 15000000n]);
      if (tv) {
        const [season] = await database.rows('BaseItems', { where: { Path: identityRoot + '\\BluRay Show\\Season 1' } });
        const [series] = await database.rows('BaseItems', { where: { Path: identityRoot + '\\BluRay Show' } });
        assert.equal(media.ParentId, season.Id); assert.equal(media.SeasonId, season.Id); assert.equal(media.SeriesId, series.Id);
        assert.equal(media.IndexNumber, 3); assert.equal(media.ParentIndexNumber, 1);
      } else {
        const [extra] = await database.rows('BaseItems', { where: { Path: identityPath + '\\extras\\Bonus.mkv' } });
        assert.ok(extra); assert.equal(extra.OwnerId, media.Id); assert.equal(extra.ParentId, null); assert.ok(extra.RunTimeTicks > 0n);
        if (extraId) assert.equal(extra.Id, extraId); extraId = extra.Id;
      }
      runtime.library.itemCreation.unregisterItem(media.Id);
      await runtime.library.itemCreation.withItem(media.Id, item => {
        assert.equal(item.VideoType, 'BluRay'); assert.equal(item.RunTimeTicks, 35000000n); assert.equal(item.Path, identityPath);
      });
      if (mediaId) assert.equal(media.Id, mediaId); mediaId = media.Id;
    }
    if (tv) await adapter.delete(directory, { recursive: true });
    else await runtime.library.itemCreation.withItem(mediaId, item => runtime.library.deleteItem(item, { DeleteFileLocation: true }));
    await assert.rejects(vfs.stat('/media' + directory), { code: 'not-found' });
    await runtime.metadata.queue(ids.folder, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' });
    for (const Id of [mediaId, extraId].filter(Boolean)) {
      assert.deepEqual(await database.rows('BaseItems', { where: { Id } }), []);
      assert.deepEqual(await database.rows('MediaStreamInfos', { where: { ItemId: Id } }), []);
    }
    assert.equal((await read(vfs, '/media/outside.keep')).toString(), 'Unrelated source');
    assert.deepEqual(errors, []);
  });

  test(`${dialect}: Video STRM scan and playback use the stored remote target with real ffprobe`, options, async t => {
    const { runtime, database, adapter, errors, generate, user } = await setup(t, 'movies');
    const bytes = await generate(false);
    let requests = 0, remoteProbes = 0;
    const upstream = createServer((request, response) => {
      requests++;
      const range = /^bytes=(\d+)-(\d*)$/u.exec(request.headers.range ?? '');
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
      if (start > end) { response.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` }); response.end(); return; }
      const body = bytes.subarray(start, end + 1);
      response.writeHead(range ? 206 : 200, { 'Content-Type': 'video/x-matroska', 'Accept-Ranges': 'bytes', 'Content-Length': String(body.length),
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) });
      response.end(request.method === 'HEAD' ? undefined : body);
    });
    t.after(async () => {
      upstream.closeAllConnections();
      await new Promise((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const target = `http://127.0.0.1:${upstream.address().port}/remote.mkv`;
    await adapter.write('/Remote (2024).strm', Buffer.from(`\uFEFF# video\r\n ${target}\r\n`));
    await adapter.write('/Remote (2024).nfo', nfo('movie', 'Remote movie'));
    const probeRemote = runtime.probe.probeRemote.bind(runtime.probe);
    runtime.probe.probeRemote = async (...args) => { remoteProbes++; return probeRemote(...args); };
    await runtime.metadata.queue(ids.folder, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' });
    assert.deepEqual(errors, []); assert.equal(requests, 0); assert.equal(remoteProbes, 0);
    const [movie] = await database.rows('BaseItems', { where: { Path: identityRoot + '\\Remote (2024).strm' } });
    assert.equal(movie.Type, 'MediaBrowser.Controller.Entities.Movies.Movie'); assert.equal(movie.Name, 'Remote movie');
    assert.equal(movie.RunTimeTicks, null);
    assert.equal(JSON.parse(movie.Data).IsShortcut, true); assert.equal(JSON.parse(movie.Data).ShortcutPath, target);
    assert.deepEqual(await database.rows('MediaStreamInfos', { where: { ItemId: movie.Id } }), []);
    const sources = await runtime.playback.sources(await runtime.library.getItemRecord(movie.Id), user);
    assert.equal(sources[0].Protocol, 'Http'); assert.equal(sources[0].Path, target); assert.equal(sources[0].IsRemote, true);
    assert.ok(sources[0].MediaStreams.some(stream => stream.Type === 'Video' && stream.Codec === 'ffv1' && stream.Width === 32));
    assert.ok(requests > 0); assert.equal(remoteProbes, 1);
    const [probed] = await database.rows('BaseItems', { where: { Id: movie.Id } });
    assert.ok(probed.RunTimeTicks > 0n); assert.equal(probed.Width, 32); assert.equal(probed.Height, 32);
    await runtime.playback.sources(await runtime.library.getItemRecord(movie.Id), user);
    assert.equal(remoteProbes, 2, 'an existing video stream does not suppress shortcut playback probing');
    const count = requests;
    await runtime.metadata.queue(ids.folder, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
    assert.equal(requests, count); assert.equal(remoteProbes, 2);
    assert.ok((await database.rows('MediaStreamInfos', { where: { ItemId: movie.Id } })).some(stream => stream.Codec === 'ffv1'));
    assert.equal((await runtime.library.getItemRecord(movie.Id)).ShortcutPath, target);
    await adapter.delete('/Remote (2024).strm');
    await runtime.metadata.queue(ids.folder, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' });
    assert.deepEqual(await database.rows('BaseItems', { where: { Id: movie.Id } }), []);
    assert.deepEqual(await database.rows('MediaStreamInfos', { where: { ItemId: movie.Id } }), []);
    assert.equal(requests, count); assert.deepEqual(errors, []);
  });

  for (const collectionType of ['movies', 'tvshows', 'music']) test(`${dialect}: ${collectionType} folder scan performs real probe, NFO import and queued full refresh`, options, async t => {
    const { runtime, database, adapter, vfs, post, errors, generate } = await setup(t, collectionType);
    const mediaPath = collectionType === 'movies' ? '/Feature (2024).mkv'
      : collectionType === 'tvshows' ? '/Show/Season 1/Show.S01E01.mkv' : '/Artist/Album/01 - Track.wav';
    const sidecar = collectionType === 'movies' ? '/Feature (2024).nfo'
      : collectionType === 'tvshows' ? '/Show/Season 1/Show.S01E01.nfo' : '/Artist/Album/album.nfo';
    const kind = collectionType === 'music' ? 'album' : collectionType === 'tvshows' ? 'episodedetails' : 'movie';
    let directory = '';
    for (const part of mediaPath.split('/').slice(1, -1)) { directory += '/' + part; await adapter.mkdir(directory); }
    await adapter.write(mediaPath, await generate(collectionType === 'music'));
    await adapter.write(sidecar, nfo(kind, 'Sidecar title'));
    const shortcutPath = '/Artist/Album/Remote.strm';
    const shortcutTarget = 'https://media.invalid/remote-audio.wav';
    if (collectionType === 'music') {
      await adapter.write(shortcutPath, Buffer.from(`# remote track\n${shortcutTarget}\n`));
      runtime.probe.probeRemote = async () => { throw new Error('An ordinary music scan must not probe a remote shortcut.'); };
    }
    const calls = []; const refresh = runtime.metadata.refresh.bind(runtime.metadata);
    runtime.metadata.refresh = async (reference, options) => {
      calls.push({ Id: typeof reference === 'string' ? reference : reference.Id, options });
      return refresh(reference, options);
    };
    await runtime.metadata.queue(ids.folder, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' });
    assert.deepEqual(errors, []);
    const media = (await database.rows('BaseItems')).find(item => item.Path === identityRoot + mediaPath.replaceAll('/', '\\'));
    assert.ok(media); assert.ok(media.RunTimeTicks > 0n);
    const streams = await database.rows('MediaStreamInfos', { where: { ItemId: media.Id } });
    assert.ok(streams.length > 0);
    let shortcut;
    if (collectionType === 'music') {
      shortcut = (await database.rows('BaseItems')).find(item => item.Path === identityRoot + shortcutPath.replaceAll('/', '\\'));
      assert.ok(shortcut); assert.equal(shortcut.Type, 'MediaBrowser.Controller.Entities.Audio.Audio');
      assert.equal(shortcut.ParentId, media.ParentId);
      assert.equal(JSON.parse(shortcut.Data).IsShortcut, true);
      assert.equal(JSON.parse(shortcut.Data).ShortcutPath, shortcutTarget);
      assert.equal(shortcut.RunTimeTicks, null);
      assert.deepEqual(await database.rows('MediaStreamInfos', { where: { ItemId: shortcut.Id } }), []);
    }
    if (collectionType !== 'music') assert.equal(media.Overview, 'Stored sidecar overview');
    assert.ok(calls.some(call => call.Id === media.Id));
    const targets = (await database.rows('BaseItems')).filter(item => item.Path?.startsWith(identityRoot));
    if (collectionType === 'tvshows') {
      const series = targets.find(item => item.Type.endsWith('.Series'));
      const season = targets.find(item => item.Type.endsWith('.Season'));
      assert.equal(calls.filter(call => call.Id === series.Id).length, 2);
      assert.ok(calls.findIndex(call => call.Id === season.Id) < calls.findIndex(call => call.Id === media.Id));
    }
    const firstCallCount = calls.length;
    await adapter.write(sidecar, nfo(kind, 'Queued full title', true));
    assert.equal((await post('metadataRefreshMode=FullRefresh')).status, 204);
    await runtime.metadata.drain();
    assert.deepEqual(errors, []);
    const updated = (await database.rows('BaseItems')).find(item => item.Path === (collectionType === 'music' ? identityRoot + '\\Artist\\Album' : media.Path));
    assert.equal(updated.Name, 'Queued full title');
    const xml = (await read(vfs, '/media' + sidecar)).toString();
    assert.match(xml, /Queued full title/u); assert.match(xml, /<custom keep="true">retained<\/custom>/u);
    assert.ok(calls.slice(firstCallCount).filter(call => call.options.MetadataRefreshMode === 'FullRefresh')
      .every(call => call.options.ForceSave === true && call.options.IsAutomated === false));
    if (shortcut) {
      const savedShortcut = await runtime.library.getItemRecord(shortcut.Id);
      assert.equal(savedShortcut.ShortcutPath, shortcutTarget);
      assert.equal(savedShortcut.ParentId, media.ParentId);
      await adapter.delete(shortcutPath);
      await runtime.metadata.queue(ids.folder, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' });
      assert.deepEqual(errors, []);
      assert.deepEqual(await database.rows('BaseItems', { where: { Id: shortcut.Id } }), []);
      assert.deepEqual(await database.rows('AncestorIds', { where: { ItemId: shortcut.Id } }), []);
    }
    assert.equal(runtime.libraryScanner.capabilities.completeLibraryScan, true);
  });

  test(`${dialect}: global Movie scan connects NFO, probe, collections and missing-media cleanup`, options, async t => {
    const { runtime, database, adapter, vfs, post, errors, generate, programDataPath, user } = await setup(t, 'movies', { global: true });
    const output = validationOutputRoot(); await mkdir(output, { recursive: true });
    const evidence = await mkdtemp(path.join(output, 'movie-global-'));
    const json = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n';
    let scanPhase = 'inputs';
    const metadataConflicts = [];
    const updateRepository = runtime.metadataUpdates.updateRepository.bind(runtime.metadataUpdates);
    runtime.metadataUpdates.updateRepository = async (loaded, result, reason, options) => {
      const identity = { Id: loaded.item.Id, Type: loaded.item.Type, Path: loaded.item.Path };
      const phase = scanPhase, caller = new Error('Metadata repository caller').stack;
      try { return await updateRepository(loaded, result, reason, options); }
      catch (error) {
        if (error.code === 'metadata-conflict') {
          const observation = { phase, identity, reason, caller, error: { name: error.name, message: error.message } };
          try {
            const baseline = structuredClone(loaded.snapshot);
            const current = await runtime.store.run(async db => (await db.rows('BaseItems', { where: { Id: identity.Id } }))[0]);
            const fields = [...new Set([...Object.keys(baseline ?? {}), ...Object.keys(current ?? {})])];
            Object.assign(observation, { baseline, current,
              changedFields: fields.filter(field => !isDeepStrictEqual(baseline?.[field], current?.[field])) });
          } catch (diagnosticError) {
            observation.diagnosticError = { name: diagnosticError.name, message: diagnosticError.message };
          }
          metadataConflicts.push(observation);
        }
        throw error;
      }
    };
    const key = value => String(value).replaceAll('-', '').toLowerCase();
    const firstPath = identityRoot + '\\First.mkv', secondPath = identityRoot + '\\Second.mkv';
    const collectionName = 'Scan Fixture Collection', originalGenre = 'Scan Original Genre', changedGenre = 'Scan Changed Genre';
    const studio = 'Scan Fixture Studio';
    const details = genre => `<set><name>${collectionName}</name></set><genre>${genre}</genre><studio>${studio}</studio>`;
    const bytes = await generate(false);
    const firstNfo = nfo('movie', 'First', false, details(originalGenre));
    const secondNfo = nfo('movie', 'Second', false, details(originalGenre));
    for (const name of ['First', 'Second']) await adapter.write(`/${name}.mkv`, bytes);
    await adapter.write('/First.nfo', firstNfo); await adapter.write('/Second.nfo', secondNfo);
    await writeFile(path.join(evidence, 'inputs.json'), json({ mediaSha256: createHash('sha256').update(bytes).digest('hex'),
      firstNfo: firstNfo.toString(), secondNfo: secondNfo.toString(), identityRoot,
      storage: 'Existing strong-snapshot memory VFS with real media/NFO bytes; application state and collection XML are actual files.' }));

    const tables = ['BaseItems', 'AncestorIds', 'MediaStreamInfos', 'ItemValues', 'ItemValuesMap', 'LinkedChildren'];
    const scan = async phase => {
      scanPhase = phase;
      let failure;
      try {
        const completion = once(runtime.tasks, 'completed', { signal: AbortSignal.timeout(60_000) });
        assert.equal((await post('', '/Library/Refresh')).status, 204);
        const [{ Result }] = await completion;
        assert.equal(Result.Status, 'Completed', Result.ErrorMessage);
        // Collection membership queues its actual metadata/XML save. Await the
        // owning queue before observing the persisted output, without replacing it.
        await runtime.metadata.drain();
      } catch (error) { failure = error; }
      const rows = Object.fromEntries(await Promise.all(tables.map(async table => [table, await database.rows(table)])));
      const observation = { rows, metadataConflicts,
        errors: errors.map(error => ({ name: error.name, code: error.code, message: error.message })),
        failure: failure && { name: failure.name, code: failure.code, message: failure.message } };
      await writeFile(path.join(evidence, phase + '-raw.json'), json(observation));
      const collections = rows.BaseItems.filter(item => item.Type.endsWith('.BoxSet') && item.Name === collectionName);
      const xml = [];
      for (const collection of collections) {
        const expandedPath = runtime.library.options.expandPath(collection.Path);
        assert.ok(path.isAbsolute(expandedPath));
        const filename = path.join(expandedPath, 'collection.xml');
        const relative = path.relative(programDataPath, filename);
        assert.ok(relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
        try { xml.push({ persistedPath: collection.Path, filename, text: await readFile(filename, 'utf8') }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; xml.push({ persistedPath: collection.Path, filename, text: null }); }
      }
      await writeFile(path.join(evidence, phase + '.json'), json({ ...observation, xml }));
      if (failure) throw failure;
      assert.deepEqual(errors, []);
      return { rows, collections, xml };
    };
    const itemValues = (state, item) => {
      const ids = new Set(state.rows.ItemValuesMap.filter(row => key(row.ItemId) === key(item.Id)).map(row => key(row.ItemValueId)));
      return state.rows.ItemValues.filter(row => ids.has(key(row.ItemValueId)) && [2, 3].includes(row.Type))
        .map(row => ({ type: row.Type, value: row.Value })).sort((a, b) => a.type - b.type || a.value.localeCompare(b.value));
    };
    const assertMovie = (state, mediaPath, title, genre) => {
      const movie = state.rows.BaseItems.find(item => item.Path === mediaPath);
      assert.ok(movie, mediaPath); assert.equal(movie.Type, 'MediaBrowser.Controller.Entities.Movies.Movie');
      assert.equal(movie.Name, title); assert.equal(movie.Overview, 'Stored sidecar overview');
      assert.equal(JSON.parse(movie.Data).TmdbCollectionName, collectionName);
      assert.ok(movie.RunTimeTicks > 0n);
      const parent = state.rows.BaseItems.find(item => key(item.Id) === key(movie.ParentId));
      assert.equal(parent?.Path, identityRoot);
      assert.ok(state.rows.AncestorIds.some(row => key(row.ItemId) === key(movie.Id) && key(row.ParentItemId) === key(parent.Id)));
      assert.ok(state.rows.MediaStreamInfos.some(row => key(row.ItemId) === key(movie.Id)
        && row.StreamType === 1 && row.Codec === 'ffv1' && row.Width === 32 && row.Height === 32));
      assert.deepEqual(itemValues(state, movie), [{ type: 2, value: genre }, { type: 3, value: studio }]);
      return movie;
    };
    const assertCollection = async (state, paths) => {
      assert.equal(state.collections.length, 1);
      const collection = state.collections[0];
      const items = await runtime.library.getItemList({ ParentId: collection.Id, IncludeItemTypes: 'Movie', Fields: 'Path' }, { user });
      assert.deepEqual(items.map(item => item.Path).sort(), [...paths].sort());
      const members = state.rows.LinkedChildren.filter(row => key(row.ParentId) === key(collection.Id));
      assert.deepEqual(members.map(link => state.rows.BaseItems.find(item => key(item.Id) === key(link.ChildId))?.Path).sort(), [...paths].sort());
      return collection;
    };
    const assertCollectionXml = (state, paths) => {
      assert.equal(typeof state.xml[0].text, 'string', 'The actual Collection membership saver must create collection.xml.');
      const document = readXml(state.xml[0].text), links = child(document, 'CollectionItems');
      const xmlPaths = (links?.children ?? []).filter(node => node.name === 'CollectionItem').map(node => child(node, 'Path')?.text);
      assert.deepEqual(xmlPaths.sort(), [...paths].sort());
    };

    const created = await scan('created');
    const first = assertMovie(created, firstPath, 'First', originalGenre);
    const second = assertMovie(created, secondPath, 'Second', originalGenre);
    const collection = await assertCollection(created, [firstPath, secondPath]);
    assertCollectionXml(created, [firstPath, secondPath]);
    assert.ok(created.rows.BaseItems.some(item => item.Type.endsWith('.Genre') && item.Name === originalGenre));
    assert.ok(created.rows.BaseItems.some(item => item.Type.endsWith('.Studio') && item.Name === studio));

    // BaseNfoProvider ignores writes within one minute of DateLastSaved to
    // avoid detecting its own saves. Only this update stage waits for that
    // real interval; the local lock then asks the reader to replace the title.
    const saved = new Date(first.DateLastSaved.replace(' ', 'T').replace(/Z?$/, 'Z')).getTime();
    assert.ok(Number.isFinite(saved));
    while (Date.now() - saved <= 60_000) {
      await new Promise(resolve => setTimeout(resolve, Math.max(2, saved + 60_001 - Date.now())));
    }
    const modified = new Date().toISOString();
    const updatedNfo = nfo('movie', 'Updated First', true, details(changedGenre));
    await adapter.write('/First.nfo', updatedNfo, { modified });
    const written = await vfs.stat('/media/First.nfo');
    const elapsedSinceSave = new Date(written.modified).getTime() - saved;
    await writeFile(path.join(evidence, 'update-input.json'), json({ saved: first.DateLastSaved,
      modified, observedModified: written.modified, elapsedSinceSave, nfo: updatedNfo.toString() }));
    assert.equal(written.modified, modified);
    assert.ok(elapsedSinceSave > 60_000, 'The actual NFO write must exceed the native one-minute change tolerance.');
    const updated = await scan('updated');
    assert.equal(assertMovie(updated, firstPath, 'Updated First', changedGenre).Id, first.Id);
    assert.equal(assertMovie(updated, secondPath, 'Second', originalGenre).Id, second.Id);
    assert.equal((await assertCollection(updated, [firstPath, secondPath])).Id, collection.Id);
    assertCollectionXml(updated, [firstPath, secondPath]);
    assert.ok(updated.rows.BaseItems.some(item => item.Type.endsWith('.Genre') && item.Name === changedGenre));
    assert.match((await read(vfs, '/media/First.nfo')).toString(), /Updated First/u);

    await adapter.delete('/First.mkv'); await adapter.delete('/First.nfo');
    const deleted = await scan('deleted');
    assert.equal(deleted.rows.BaseItems.some(item => key(item.Id) === key(first.Id) || item.Path === firstPath), false);
    for (const table of ['AncestorIds', 'MediaStreamInfos', 'ItemValuesMap']) {
      assert.equal(deleted.rows[table].some(row => key(row.ItemId) === key(first.Id)), false, table);
    }
    assert.equal(deleted.rows.LinkedChildren.some(row => key(row.ChildId) === key(first.Id) || key(row.ParentId) === key(first.Id)), false);
    assert.equal(assertMovie(deleted, secondPath, 'Second', originalGenre).Id, second.Id);
    // Automatic collection maintenance adds members. It does not promise an
    // XML rewrite when a source disappears; resolved/persisted members must
    // still stop exposing the removed movie and retain the surviving one.
    assert.equal((await assertCollection(deleted, [secondPath])).Id, collection.Id);
    assert.deepEqual(await read(vfs, '/media/Second.mkv'), bytes);
    assert.equal(runtime.libraryScanner.capabilities.completeLibraryScan, true);
  });

  test(`${dialect}: read-only scan writers reject before probe or first metadata commit and retain structural state`, options, async t => {
    const { runtime, database, adapter, errors, generate } = await setup(t, 'movies', { writable: false });
    await adapter.write('/Feature.mkv', await generate(false));
    let probes = 0; const refresh = runtime.probe.refreshMetadata.bind(runtime.probe);
    runtime.probe.refreshMetadata = (...args) => { probes++; return refresh(...args); };
    await runtime.metadata.queue(ids.folder, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None', ForceSave: true });
    assert.equal(probes, 0); assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'not-supported');
    const media = (await database.rows('BaseItems')).find(item => item.Path === identityRoot + '\\Feature.mkv');
    assert.ok(media); assert.equal(media.RunTimeTicks, null); assert.equal(media.DateLastRefreshed, null);
    assert.equal((await database.rows('MediaStreamInfos', { where: { ItemId: media.Id } })).length, 0);
  });

  test(`${dialect}: refresh persistence failure retains the earlier native sidecar save and independent scan commit`, options, async t => {
    const { runtime, database, adapter, vfs, errors, generate } = await setup(t, 'movies');
    await adapter.write('/Feature.mkv', await generate(false));
    await adapter.write('/Feature.nfo', nfo('movie', 'Original title'));
    await runtime.metadata.queue(ids.folder, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' });
    const media = (await database.rows('BaseItems')).find(item => item.Path === identityRoot + '\\Feature.mkv');
    const before = nfo('movie', 'Rejected title', true); await adapter.write('/Feature.nfo', before);
    const update = database.update.bind(database);
    database.update = (...args) => {
      if (args[0] === 'BaseItems' && args[1].Id === media.Id && args[2].Name === 'Rejected title') throw new Error('Injected final metadata persistence failure');
      return update(...args);
    };
    await runtime.metadata.queue(ids.folder, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None', ForceSave: true });
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /Injected final metadata persistence failure/u);
    const savedXml = (await read(vfs, '/media/Feature.nfo')).toString();
    assert.match(savedXml, /<title>Rejected title<\/title>/u);
    assert.match(savedXml, /<streamdetails>/u);
    assert.notEqual(savedXml, before.toString());
    const saved = (await database.rows('BaseItems', { where: { Id: media.Id } }))[0];
    assert.equal(saved.Name, 'Original title'); assert.equal(saved.IsLocked, false); assert.ok(saved.RunTimeTicks > 0n);
    assert.equal(errors.length, 1);
  });

  test(`${dialect}: failure after metadata commit retains the matching NFO and reports the failed child`, options, async t => {
    const { runtime, database, adapter, vfs, errors, generate } = await setup(t, 'movies');
    await adapter.write('/Feature.mkv', await generate(false));
    await adapter.write('/Feature.nfo', nfo('movie', 'Committed title'));
    const reattach = runtime.metadataUpdates.reattach.bind(runtime.metadataUpdates);
    runtime.metadataUpdates.reattach = async (store, item, options) => {
      if (item.Type === 'Movie') throw new Error('Injected post-commit user data failure');
      return reattach(store, item, options);
    };
    await runtime.metadata.queue(ids.folder, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None', ForceSave: true });
    const media = (await database.rows('BaseItems')).find(item => item.Path === identityRoot + '\\Feature.mkv');
    // FullRefresh without replacement fills missing data but retains the resolved name.
    assert.equal(media.Name, 'Feature'); assert.equal(media.Overview, 'Stored sidecar overview'); assert.ok(media.RunTimeTicks > 0n);
    const xml = (await read(vfs, '/media/Feature.nfo')).toString();
    assert.match(xml, /<title>Feature<\/title>/u); assert.match(xml, /<streamdetails>/u);
    assert.equal(errors.length, 1); assert.match(errors[0].message, /Injected post-commit user data failure/u);
  });
}
