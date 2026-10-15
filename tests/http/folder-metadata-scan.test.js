import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import pg from 'pg';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition, quoteIdentifier as q } from '../../src/database/model.js';
import { createRuntime } from '../../src/runtime.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { knownAncestorIgnoreIdentityMap } from '../library/ignore-namespace-fixture.js';
import { validationExecutable } from '../../tools/validation/paths.js';

const ids = { folder: '85000000-0000-0000-0000-000000000001', collection: '85000000-0000-0000-0000-000000000002',
  userRoot: '85000000-0000-0000-0000-000000000003' };
const identityRoot = 'Z:\\MetadataScan';
const blank = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => [column.name,
  column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));
const row = (Id, type, values = {}) => ({ ...blank('BaseItems'), Id, Type: `MediaBrowser.Controller.Entities.${type}`,
  Name: type, CleanName: type.toLowerCase(), SortName: type.toLowerCase(), IsFolder: true, Data: '{}', ...values });
const nfo = (kind, title, locked = false) => Buffer.from(`<${kind}><title>${title}</title><plot>Stored sidecar overview</plot>${locked ? '<lockdata>true</lockdata>' : ''}<custom keep="true">retained</custom></${kind}>`);
const read = async (vfs, pathname) => {
  const handle = await vfs.openRead(pathname);
  try { const chunks = []; for await (const bytes of handle.stream) chunks.push(bytes); return Buffer.concat(chunks); }
  finally { await handle.close(); }
};

async function setup(t, collectionType, { writable = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'metadata-scan-'));
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES, schema = `scan_metadata_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const database = await PostgresDatabase.open({ connectionString, schema, create: true });
  const storage = new StorageRegistry(); storage.registerType('fixture', () => new MemoryStorageAdapter());
  const adapter = await storage.createInstance('fixture', 'fixture', {});
  const vfs = new VirtualFileSystem(storage); vfs.mount({ path: '/media', instanceId: 'fixture',
    capabilities: writable ? { create: true, replace: true, delete: true, conditionalWrite: true } : {} });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot, accessRoot: '/media', style: 'windows', returnAccess: 'isolated scan and probe fixture' });
  const programDataPath = path.join(directory, 'data'); await mkdir(path.join(programDataPath, 'data'), { recursive: true });
  await writeFile(path.join(programDataPath, 'data', 'device.txt'), 'b'.repeat(32));
  const errors = [];
  const runtime = await createRuntime({ database, vfs, identityMap, programDataPath,
    ignoreIdentityMap: await knownAncestorIgnoreIdentityMap({ registry: storage, vfs, identityMap, identityRoots: [identityRoot], adapterType: 'fixture' }),
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true, LibraryScanFanoutConcurrency: 1 },
    serverId: 'metadata-scan-test', libraryOptions: new Map([[ids.collection.replaceAll('-', ''), {
      SaveLocalMetadata: true, MetadataSavers: ['Nfo'], EnableInternetProviders: false,
      TypeOptions: ['Movie', 'Series', 'Season', 'Episode', 'MusicAlbum', 'MusicArtist'].map(Type => ({ Type, MetadataFetchers: [], ImageFetchers: [] }))
    }]]), probeOptions: { ffprobePath: validationExecutable('ffprobe') }, onError: error => errors.push(error) });
  t.after(async () => {
    const cleanupErrors = [];
    const attempt = async operation => { try { await operation(); } catch (error) { cleanupErrors.push(error); } };
    await attempt(() => runtime.close()); await attempt(() => storage.close());
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
  const root = (await database.rows('BaseItems')).find(item => item.Type === 'MediaBrowser.Controller.Entities.AggregateFolder');
  await database.insert('BaseItems', row(ids.userRoot, 'UserRootFolder'));
  await database.insert('BaseItems', row(ids.folder, 'Folder', { Path: identityRoot, ParentId: root.Id, TopParentId: ids.folder }));
  await database.insert('BaseItems', row(ids.collection, 'CollectionFolder', { ParentId: ids.userRoot,
    Data: JSON.stringify({ CollectionType: collectionType, PhysicalLocationsList: [identityRoot], PhysicalFolderIds: [ids.folder] }) }));
  const created = await runtime.users.createUser({ Name: 'ScanAdmin', Password: 'scan-password' });
  await runtime.users.updatePolicy(created.Id, { ...(await runtime.users.getUser(created.Id)).Policy, IsAdministrator: true });
  const login = await runtime.authentication.login({ Username: 'ScanAdmin', Pw: 'scan-password' }, { Client: 'ScanTest', Device: 'Fixture', DeviceId: 'scan-test', Version: '1' });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const post = query => fetch(`http://127.0.0.1:${runtime.server.address().port}/Items/${ids.folder}/Refresh?${query}`, {
    method: 'POST', headers: { Authorization: `MediaBrowser Token="${login.AccessToken}", Client="ScanTest", Device="Fixture", DeviceId="scan-test", Version="1"` }
  });
  const generate = async audio => {
    const filename = path.join(directory, audio ? 'track.wav' : 'movie.mkv');
    const result = spawnSync(validationExecutable('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
      audio ? 'anullsrc=r=8000:cl=mono' : 'color=size=32x32:rate=10:duration=0.2', '-t', '0.2',
      ...(audio ? ['-c:a', 'pcm_s16le'] : ['-c:v', 'ffv1']), filename], { windowsHide: true });
    assert.equal(result.status, 0, result.stderr?.toString()); return readFile(filename);
  };
  return { runtime, database, adapter, vfs, post, errors, generate };
}

{
  const dialect = 'postgres';
  const options = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES };
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
    const calls = []; const refresh = runtime.metadata.refresh.bind(runtime.metadata);
    runtime.metadata.refresh = async (Id, options) => { calls.push({ Id, options }); return refresh(Id, options); };
    const receipt = await runtime.folderScanner.scan(ids.folder, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' });
    assert.equal(receipt.structurallyComplete, true); assert.equal(receipt.metadataComplete, true, JSON.stringify(receipt.metadata));
    assert.deepEqual(errors, []);
    const media = (await database.rows('BaseItems')).find(item => item.Path === identityRoot + mediaPath.replaceAll('/', '\\'));
    assert.ok(media); assert.ok(media.RunTimeTicks > 0n);
    const streams = await database.rows('MediaStreamInfos', { where: { ItemId: media.Id } });
    assert.ok(streams.length > 0);
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
    await runtime.folderScanner.whenIdle();
    assert.deepEqual(errors, []);
    const updated = (await database.rows('BaseItems')).find(item => item.Path === (collectionType === 'music' ? identityRoot + '\\Artist\\Album' : media.Path));
    assert.equal(updated.Name, 'Queued full title');
    const xml = (await read(vfs, '/media' + sidecar)).toString();
    assert.match(xml, /Queued full title/u); assert.match(xml, /<custom keep="true">retained<\/custom>/u);
    assert.ok(calls.slice(firstCallCount).filter(call => call.options.MetadataRefreshMode === 'FullRefresh')
      .every(call => call.options.ForceSave === true && call.options.IsAutomated === false));
    assert.equal(runtime.libraryScanner.capabilities.completeLibraryScan, false);
  });

  test(`${dialect}: read-only scan writers reject before probe or first metadata commit and retain structural state`, options, async t => {
    const { runtime, database, adapter, errors, generate } = await setup(t, 'movies', { writable: false });
    await adapter.write('/Feature.mkv', await generate(false));
    let probes = 0; const refresh = runtime.probe.refreshMetadata.bind(runtime.probe);
    runtime.probe.refreshMetadata = (...args) => { probes++; return refresh(...args); };
    const receipt = await runtime.folderScanner.scan(ids.folder, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None', ForceSave: true });
    assert.equal(receipt.structurallyComplete, true); assert.equal(receipt.metadataComplete, false); assert.equal(probes, 0);
    assert.equal(receipt.metadata.children.errors.length, 1); assert.equal(errors.length, 1);
    assert.equal(receipt.metadata.children.errors[0].code, 'not-supported');
    const media = (await database.rows('BaseItems')).find(item => item.Path === identityRoot + '\\Feature.mkv');
    assert.ok(media); assert.equal(media.RunTimeTicks, null); assert.equal(media.DateLastRefreshed, null);
    assert.equal((await database.rows('MediaStreamInfos', { where: { ItemId: media.Id } })).length, 0);
  });

  test(`${dialect}: refresh persistence failure retains the earlier native sidecar save and independent scan commit`, options, async t => {
    const { runtime, database, adapter, vfs, errors, generate } = await setup(t, 'movies');
    await adapter.write('/Feature.mkv', await generate(false));
    await adapter.write('/Feature.nfo', nfo('movie', 'Original title'));
    await runtime.folderScanner.scan(ids.folder, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' });
    const media = (await database.rows('BaseItems')).find(item => item.Path === identityRoot + '\\Feature.mkv');
    const before = nfo('movie', 'Rejected title', true); await adapter.write('/Feature.nfo', before);
    const update = database.update.bind(database);
    database.update = (...args) => {
      if (args[0] === 'BaseItems' && args[1].Id === media.Id && args[2].Name === 'Rejected title') throw new Error('Injected final metadata persistence failure');
      return update(...args);
    };
    const receipt = await runtime.folderScanner.scan(ids.folder, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None', ForceSave: true });
    assert.equal(receipt.structurallyComplete, true); assert.equal(receipt.metadataComplete, false);
    assert.match(receipt.metadata.children.errors[0].message, /Injected final metadata persistence failure/u);
    const savedXml = (await read(vfs, '/media/Feature.nfo')).toString();
    assert.match(savedXml, /<title>Rejected title<\/title>/u);
    assert.match(savedXml, /<streamdetails>/u);
    assert.notEqual(savedXml, before.toString());
    const saved = (await database.rows('BaseItems', { where: { Id: media.Id } }))[0];
    assert.equal(saved.Name, 'Original title'); assert.equal(saved.IsLocked, false); assert.ok(saved.RunTimeTicks > 0n);
    assert.equal(errors.length, 1);
  });

  test(`${dialect}: failure after metadata commit retains the matching NFO and reports incomplete traversal`, options, async t => {
    const { runtime, database, adapter, vfs, errors, generate } = await setup(t, 'movies');
    await adapter.write('/Feature.mkv', await generate(false));
    await adapter.write('/Feature.nfo', nfo('movie', 'Committed title'));
    const reattach = runtime.metadataUpdates.reattach.bind(runtime.metadataUpdates);
    runtime.metadataUpdates.reattach = async (store, item, options) => {
      if (item.Type === 'Movie') throw new Error('Injected post-commit user data failure');
      return reattach(store, item, options);
    };
    const receipt = await runtime.folderScanner.scan(ids.folder, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None', ForceSave: true });
    assert.equal(receipt.metadataComplete, false);
    const media = (await database.rows('BaseItems')).find(item => item.Path === identityRoot + '\\Feature.mkv');
    // FullRefresh without replacement fills missing data but retains the resolved name.
    assert.equal(media.Name, 'Feature'); assert.equal(media.Overview, 'Stored sidecar overview'); assert.ok(media.RunTimeTicks > 0n);
    const xml = (await read(vfs, '/media/Feature.nfo')).toString();
    assert.match(xml, /<title>Feature<\/title>/u); assert.match(xml, /<streamdetails>/u);
    assert.equal(errors.length, 1); assert.match(receipt.metadata.children.errors[0].message, /Injected post-commit user data failure/u);
  });
}
