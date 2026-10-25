import { testFileSystem } from '../storage/plugin-files.js';
import { createStateRelations } from '../library/deletion-fixture.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import test from 'node:test';
import { createTestMediaEncoder } from '../helpers/media-encoder.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile, chmod, stat, symlink, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { ExternalDataManager } from '../../src/library/external-data.js';
import { LibraryService } from '../../src/library/library-service.js';
import { ProbeService } from '../../src/library/probe-service.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { MetadataRefreshHost } from '../../src/metadata/refresh-host.js';
import { MetadataRegistry } from '../../src/metadata/registry.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { observeComparison } from '../comparison-observations.js';

const fixtureRoot = new URL('./fixtures/external-data/', import.meta.url);
const input = JSON.parse(await readFile(new URL('input.json', fixtureRoot), 'utf8'));
const native = JSON.parse(await readFile(new URL('native.json', fixtureRoot), 'utf8'));
const itemId = 'DA111111-1111-1111-1111-111111111111', otherId = 'DA222222-2222-2222-2222-222222222222';
const oldDate = '2026-10-04T00:00:00.0000000Z', newDate = '2026-10-04T00:00:02.0000000Z';
const tables = ['KeyframeData', 'MediaSegments', 'TrickplayInfos', 'Chapters'];
const ioError = message => Object.assign(new Error(message), { code: 'io' });
const errorDetails = error => error == null ? null : { name: error.name, message: error.message, stack: error.stack, ...error };
const functionalOutcome = ({ exception, calls, ...value }) => ({ ...value, failed: exception != null,
  calls: calls.filter(call => call.phase !== 'log') });
const row = (table, values) => ({ ...Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated)
  .map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0])), ...values });

async function mkdirVfs(vfs, directory) {
  for (let current = '', parts = directory.split('/').filter(Boolean); parts.length;) {
    current += '/' + parts.shift();
    try { await vfs.stat(current); } catch (error) { if (error.code !== 'not-found') throw error; await vfs.mkdir(current); }
  }
}

async function setup(t) {
  const schema = 'external_data_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const output = path.resolve('.test-output', 'external-data-tests'), owners = [];
  let database, store, storage, root, linkedChildren;
  t.after(async () => {
    const errors = [];
    for (const close of [...owners].reverse().concat([
      () => linkedChildren?.flushReleases(), () => linkedChildren?.close(), () => storage?.close(),
      () => database?.client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`),
      () => database?.client.query(`DROP SCHEMA IF EXISTS "${schema}__mm" CASCADE`), () => store?.close(),
      async () => { if (!root) return; assert.equal(path.dirname(root), output); assert.ok(path.basename(root).startsWith('run-'));
        await rm(root, { recursive: true, force: true }); },
    ])) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'External data fixture cleanup failed.');
  });
  database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  store = new DomainStore(database); storage = new StorageRegistry();
  storage.registerType('memory', () => new MemoryStorageAdapter());
  const adapter = await storage.createInstance('external-data', 'memory', {});
  const vfs = new VirtualFileSystem(storage); vfs.mount({ path: '/fixture', instanceId: 'external-data', capabilities: { create: true, replace: true, mkdir: true, delete: true } });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: 'Z:\\ExternalData', accessRoot: '/fixture', style: 'windows', returnAccess: 'Isolated extracted-data controls.' });
  await mkdir(output, { recursive: true }); root = await mkdtemp(path.join(output, 'run-'));
  const spoolRoot = path.join(root, 'metadata-spool');
  linkedChildren = await createStateRelations(database, spoolRoot);
  return { database, store, adapter, vfs, identityMap, root, linkedChildren, spoolRoot, owners };
}

function ownLibrary(fixture, library, loadContext) {
  const itemCreation = new ItemCreationService({ ...fixture, library, loadContext });
  library.itemCreation = itemCreation;
  fixture.owners.push(() => library.close(), () => itemCreation.close());
}

async function seed(fixture, name, scenario = {}) {
  const { database, vfs } = fixture;
  for (const table of [...tables, 'BaseItems']) for (const record of await database.rows(table)) {
    await database.delete(table, Object.fromEntries(tableDefinition(table).primaryKey.map(key => [key, record[key]])));
  }
  const identityRoot = path.win32.join('Z:\\ExternalData', name), root = path.join(fixture.root, name);
  const item = { Id: itemId, Type: scenario.type ?? 'Movie', Name: 'External data control', IsFolder: false,
    Path: Object.hasOwn(scenario, 'path') ? scenario.path : path.win32.join(identityRoot, 'media', scenario.filename ?? 'Film.mkv'),
    VideoType: scenario.videoType ?? 'VideoFile', AdditionalParts: scenario.additionalParts ? [path.win32.join(identityRoot, 'media', 'Part Two.mkv')] : [],
    SourceType: scenario.channel ? 'Channel' : 'Library', ChannelId: scenario.channel ? otherId : null, DateModified: oldDate };
  for (const Id of [itemId, otherId]) {
    const type = item.Type === 'Audio' ? 'Audio.Audio' : 'Movies.Movie';
    await database.insert('BaseItems', row('BaseItems', { Id, Name: 'Preserved item', Path: Id === itemId ? item.Path : null,
      Type: 'MediaBrowser.Controller.Entities.' + type, MediaType: item.Type === 'Audio' ? 'Audio' : 'Video',
      DateModified: oldDate, DateLastRefreshed: oldDate, PresentationUniqueKey: Id.replaceAll('-', ''),
      Data: JSON.stringify({ VideoType: item.VideoType, AdditionalParts: item.AdditionalParts }), ChannelId: item.ChannelId }));
    await database.insert('KeyframeData', row('KeyframeData', { ItemId: Id, TotalDuration: 200000000n, KeyframeTicks: '[0,100000000]' }));
    await database.insert('MediaSegments', row('MediaSegments', { Id, ItemId: Id, SegmentProviderId: 'Control', StartTicks: 0n, EndTicks: 100000000n }));
    await database.insert('TrickplayInfos', row('TrickplayInfos', { ItemId: Id, Width: 100, Height: 50, TileWidth: 1, TileHeight: 1, ThumbnailCount: 2, Interval: 10000, Bandwidth: 100 }));
    await database.insert('Chapters', row('Chapters', { ItemId: Id, ChapterIndex: 0, StartPositionTicks: 0n, Name: 'Preserved chapter' }));
  }
  if (item.Path) {
    const source = fixture.identityMap.resolve({ identityPath: item.Path, style: 'windows' });
    await mkdirVfs(vfs, path.posix.dirname(source));
    if (['Dvd', 'BluRay'].includes(item.VideoType)) { await mkdirVfs(vfs, source); await vfs.write(source + '/source.marker', Buffer.from('Preserved source file')); }
    else await vfs.write(source, Buffer.from('Preserved source file'), { modified: newDate });
  }
  return { item, root, identityRoot };
}

async function createAssets(manager, fixture, item, scenario = {}) {
  const assets = new MetadataImageAssets({fileSystem: testFileSystem,  vfs: fixture.vfs, identityMap: fixture.identityMap,
    metadataPath: manager.metadataPath, stateRoots: [manager.dataPath] });
  for (const [index, directory] of manager.paths(item).entries()) {
    const cache = scenario.assetFile && index === 0 ? directory : directory + (directory.includes('\\') ? '\\nested\\cache.bin' : '/nested/cache.bin');
    const location = await assets.resolve(cache);
    if (location.localPath) await mkdir(path.dirname(location.localPath), { recursive: true });
    else await mkdirVfs(fixture.vfs, path.posix.dirname(location.accessPath));
    if (scenario.assetFile && index === 0) { await assets.write(cache, Buffer.from('Cache leaf is a file')); continue; }
    await assets.write(cache, Buffer.from('Extracted data'));
    if (scenario.readOnly && index === 0) {
      await chmod(location.localPath, 0o444);
    }
  }
  return assets;
}

async function projection(fixture, manager, item, assets, { root, identityRoot }) {
  const remaining = [];
  for (const Id of [itemId, otherId]) remaining.push({ target: Id === itemId,
    keyframes: (await fixture.database.rows('KeyframeData', { where: { ItemId: Id } })).length,
    segments: (await fixture.database.rows('MediaSegments', { where: { ItemId: Id } })).length,
    trickplay: (await fixture.database.rows('TrickplayInfos', { where: { ItemId: Id } })).length,
    chapters: (await fixture.database.rows('Chapters', { where: { ItemId: Id } })).length,
    baseItems: (await fixture.database.rows('BaseItems', { where: { Id } })).length });
  const paths = manager.paths(item), assetStates = [];
  for (const asset of paths) {
    let info; try { info = await assets.stat(asset); } catch (error) { if (error.code !== 'not-found') throw error; }
    assetStates.push({ directory: info?.kind === 'directory', file: info?.kind === 'file' });
  }
  let sourceExists = true;
  if (item.Path) {
    const source = fixture.identityMap.resolve({ identityPath: item.Path, style: 'windows' });
    const sourceInfo = await fixture.vfs.stat(source); sourceExists = Boolean(sourceInfo);
    const handle = await fixture.vfs.openRead(sourceInfo.kind === 'directory' ? source + '/source.marker' : source);
    try { const chunks = []; for await (const bytes of handle.stream) chunks.push(bytes); assert.equal(Buffer.concat(chunks).toString(), 'Preserved source file'); }
    finally { await handle.close(); }
  }
  return { paths: paths.map(asset => asset.startsWith(identityRoot) ? path.win32.relative(identityRoot, asset) : path.relative(root, asset).replaceAll('/', '\\')),
    remaining, assets: assetStates, sourceExists };
}

test('external-data recording seals actual native files and four independent SQLite managers', async () => {
  const provenance = JSON.parse(await readFile(new URL('provenance.json', fixtureRoot), 'utf8'));
  for (const [key, filename] of Object.entries({ input: 'input.json', native: 'native.json', oracle: 'Program.cs', project: 'Oracle.csproj' })) {
    assert.equal(createHash('sha256').update(await readFile(new URL(filename, fixtureRoot))).digest('hex'), provenance.files[key].sha256);
  }
  assert.equal(createHash('sha256').update(await readFile(new URL('../Directory.Build.props', import.meta.url))).digest('hex'), provenance.files.buildProperties.sha256);
  assert.equal(native.inputSha256, provenance.files.input.sha256); assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
  assert.equal(input.length, 16); assert.equal(native.results.length, input.length);
  assert.match(native.sqliteLibrarySha256, /^[a-f0-9]{64}$/);
});

for (const dialect of ['postgres']) {
  const options = {};
  test(`${dialect}: external-data files, independent deletion order and failure retention match native`, options, async t => {
    const fixture = await setup(t, dialect), deleteRow = fixture.database.deleteWhere.bind(fixture.database);
    for (const scenario of input) await t.test(scenario.name, async () => {
      const state = await seed(fixture, scenario.name, scenario), calls = [], diagnostics = [];
      let deniedDirectory;
      const fileSystem = scenario.readOnly ? new Proxy(testFileSystem, { get(target, name) {
        if (name === 'rm') return async (filename, options) => {
          if (path.resolve(filename) === deniedDirectory) throw Object.assign(new Error('Controlled read-only directory failure.'), { code: 'EACCES' });
          return target.rm(filename, options);
        };
        const value = Reflect.get(target, name, target); return typeof value === 'function' ? value.bind(target) : value;
      } }) : testFileSystem;
      const manager = new ExternalDataManager({fileSystem, ...fixture, dataPath: path.join(state.root, 'data'), metadataPath: path.join(state.root, 'metadata'),
        logger: { warn(error, message) { diagnostics.push({ level: 'Warning', error: errorDetails(error), message }); },
          error(error, message) { diagnostics.push({ level: 'Error', error: errorDetails(error), message }); } },
        segmentProviders: scenario.pluginError ? [{ name: 'Controlled cleanup failure', async cleanupExtractedData(Id, { signal }) {
          assert.equal(Id, itemId); calls.push({ phase: 'plugin', cancellable: Boolean(signal) }); throw ioError('Injected segment provider failure');
        } }] : [] });
      if (scenario.readOnly) deniedDirectory = path.resolve(manager.paths(state.item)[0]);
      const assets = await createAssets(manager, fixture, state.item, scenario), before = await fixture.database.rows('BaseItems');
      fixture.database.deleteWhere = async (table, where) => {
        calls.push({ phase: 'delete', table, cancellable: false });
        if (scenario.failTable === table) throw ioError('Injected native delete failure');
        return deleteRow(table, where);
      };
      let exception = null;
      try { if (scenario.filesOnly) await manager.deleteItemFiles(state.item); else await manager.deleteItemData(state.item); }
      catch (error) { exception = errorDetails(error); }
      finally { fixture.database.deleteWhere = deleteRow; }
      const expected = native.results.find(result => result.name === scenario.name);
      const actual = { name: scenario.name, exception, calls, ...await projection(fixture, manager, state.item, assets, state) };
      observeComparison(t, scenario.name, { ...actual, diagnostics }, expected);
      if (exception) {
        assert.ok(scenario.failTable, 'Only the selected database deletion may reject this scenario.');
        assert.equal(exception.code, 'io'); assert.equal(exception.message, 'Injected native delete failure');
      }
      for (const diagnostic of diagnostics) {
        if (diagnostic.level === 'Warning' && scenario.readOnly) {
          assert.equal(diagnostic.error?.code, 'permission-denied');
          assert.equal(diagnostic.error?.message, 'Controlled read-only directory failure.');
        } else {
          assert.ok(diagnostic.level === 'Error' && scenario.pluginError, 'Unexpected external-data cleanup diagnostic.');
          assert.equal(diagnostic.error?.code, 'io');
          assert.equal(diagnostic.error?.message, 'Injected segment provider failure');
        }
      }
      assert.deepEqual(functionalOutcome(actual), functionalOutcome(expected));
      assert.deepEqual(await fixture.database.rows('BaseItems'), before);
      if (scenario.readOnly) {
        const retained = path.join(manager.paths(state.item)[0], 'nested', 'cache.bin');
        assert.deepEqual(await readFile(retained), Buffer.from('Extracted data'));
        await chmod(retained, 0o666);
      }
    });
  });

  for (const failTable of [null, 'MediaSegments']) test(`${dialect}: None refresh preserves native external cleanup ${failTable ? 'partial failure' : 'and saves Import'}`, options, async t => {
    const fixture = await setup(t, dialect), scenario = failTable ? input.find(entry => entry.failTable === failTable) : input[0];
    const state = await seed(fixture, 'none-' + (failTable ?? 'success'));
    const dataPath = path.join(state.root, 'data'), metadataPath = path.join(state.root, 'metadata');
    const manager = new ExternalDataManager({fileSystem: testFileSystem,  ...fixture, dataPath, metadataPath });
    const assets = await createAssets(manager, fixture, state.item), before = await fixture.database.rows('BaseItems');
    const library = new LibraryService({fileSystem: testFileSystem,  store: fixture.store, linkedChildren: fixture.linkedChildren, spoolRoot: fixture.spoolRoot, serverId: 'external-data', dataPath, metadataPath });
    const loadContext = createMetadataContextLoader({fileSystem: testFileSystem,  ...fixture, library });
    const host = new MetadataRefreshHost({ ...fixture, registry: new MetadataRegistry(), loadContext, externalData: manager });
    ownLibrary(fixture, library, loadContext);
    fixture.owners.push(() => host.close());
    const deleteRow = fixture.database.deleteWhere.bind(fixture.database), calls = [];
    fixture.database.deleteWhere = async (table, where) => {
      if (tables.includes(table)) calls.push(table);
      if (table === failTable) throw ioError('Injected native delete failure');
      return deleteRow(table, where);
    };
    if (failTable) {
      await assert.rejects(host.refresh(itemId, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None' }), error => {
        observeComparison(t, 'None refresh cleanup failure', errorDetails(error), { failed: true });
        assert.equal(error.code, 'io'); assert.equal(error.message, 'Injected native delete failure'); return true;
      });
      assert.deepEqual(await fixture.database.rows('BaseItems'), before);
    } else {
      const result = await host.refresh(itemId, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None' });
      assert.equal(result.changed, true); assert.equal(result.UpdateType, 3);
      assert.equal((await fixture.database.rows('BaseItems', { where: { Id: itemId } }))[0].DateModified, '2026-10-04 00:00:02');
    }
    assert.deepEqual(calls, native.results.find(result => result.name === scenario.name).calls.filter(call => call.phase === 'delete').map(call => call.table));
    const actual = await projection(fixture, manager, state.item, assets, state), expected = native.results.find(result => result.name === scenario.name);
    assert.deepEqual(actual.remaining, expected.remaining); assert.deepEqual(actual.assets, expected.assets); assert.equal(actual.sourceExists, true);
  });

  test(`${dialect}: provider probe uses the shared prune once and preserves it after probe failure`, options, async t => {
    const fixture = await setup(t, dialect), state = await seed(fixture, 'probe-failure');
    const dataPath = path.join(state.root, 'data'), metadataPath = path.join(state.root, 'metadata');
    const manager = new ExternalDataManager({fileSystem: testFileSystem,  ...fixture, dataPath, metadataPath });
    const assets = await createAssets(manager, fixture, state.item), library = new LibraryService({fileSystem: testFileSystem,  store: fixture.store, linkedChildren: fixture.linkedChildren, spoolRoot: fixture.spoolRoot, serverId: 'external-data', dataPath, metadataPath });
    const loadContext = createMetadataContextLoader({fileSystem: testFileSystem,  ...fixture, library });
    const deleteRow = fixture.database.deleteWhere.bind(fixture.database), calls = [];
    fixture.database.deleteWhere = async (table, where) => { if (tables.includes(table)) calls.push(table); return deleteRow(table, where); };
    const probe = new ProbeService({ ...fixture, library, loadContext, mediaEncoder: await createTestMediaEncoder(t), externalData: manager, probe: async () => {
      assert.deepEqual(calls, tables); throw ioError('Injected probe failure');
    } });
    const host = new MetadataRefreshHost({ ...fixture, registry: new MetadataRegistry(), loadContext, probe });
    ownLibrary(fixture, library, loadContext);
    fixture.owners.push(() => probe.close(), () => host.close());
    assert.equal(host.externalData, probe.externalData);
    const result = await host.refresh(itemId, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
    assert.equal(result.Failures, 1); assert.equal(result.UpdateType & 2, 2); assert.deepEqual(calls, tables);
    const actual = await projection(fixture, manager, state.item, assets, state), expected = native.results[0];
    assert.deepEqual(actual.remaining, expected.remaining); assert.deepEqual(actual.assets, expected.assets);
  });

  test(`${dialect}: stale invalidation refuses file and database side effects`, options, async t => {
    const fixture = await setup(t, dialect), state = await seed(fixture, 'stale-invalidation');
    const manager = new ExternalDataManager({fileSystem: testFileSystem,  ...fixture, dataPath: path.join(state.root, 'data'), metadataPath: path.join(state.root, 'metadata') });
    const assets = await createAssets(manager, fixture, state.item), expectedSnapshot = (await fixture.database.rows('BaseItems', { where: { Id: itemId } }))[0];
    await fixture.database.update('BaseItems', { Id: itemId }, { Name: 'Concurrent edit' });
    const before = await projection(fixture, manager, state.item, assets, state);
    await assert.rejects(manager.invalidateChangedVideo(state.item, newDate, { expectedSnapshot }), { code: 'version-changed' });
    assert.deepEqual(await projection(fixture, manager, state.item, assets, state), before);
  });

  test(`${dialect}: pruning removes every target row and rejects unconstrained or invalid bulk deletes`, options, async t => {
    const fixture = await setup(t, dialect), state = await seed(fixture, 'multiple-rows');
    for (let index = 1; index <= 3; index++) {
      await fixture.database.insert('MediaSegments', row('MediaSegments', { Id: randomUUID(), ItemId: itemId, SegmentProviderId: 'Control', StartTicks: BigInt(index), EndTicks: 100000000n }));
      await fixture.database.insert('TrickplayInfos', row('TrickplayInfos', { ItemId: itemId, Width: 100 + index, Height: 50, TileWidth: 1, TileHeight: 1, ThumbnailCount: 2, Interval: 10000, Bandwidth: 100 }));
      await fixture.database.insert('Chapters', row('Chapters', { ItemId: itemId, ChapterIndex: index, StartPositionTicks: BigInt(index), Name: 'Preserved chapter' }));
    }
    const before = [];
    for (const table of tables) before.push(await fixture.database.rows(table));
    await assert.rejects(Promise.resolve().then(() => fixture.database.deleteWhere('MediaSegments', {})), /nonempty predicate/);
    await assert.rejects(Promise.resolve().then(() => fixture.database.deleteWhere('MediaSegments', { Unknown: itemId })));
    await assert.rejects(Promise.resolve().then(() => fixture.database.delete('MediaSegments', { ItemId: itemId })), /complete primary key/);
    const unchanged = [];
    for (const table of tables) unchanged.push(await fixture.database.rows(table));
    assert.deepEqual(unchanged, before);
    await new ExternalDataManager({fileSystem:testFileSystem,...fixture}).deleteItemData(state.item);
    for (const table of tables) {
      assert.deepEqual(await fixture.database.rows(table, { where: { ItemId: itemId } }), []);
      assert.equal((await fixture.database.rows(table, { where: { ItemId: otherId } })).length, 1);
    }
    await fixture.database.insert('Chapters', row('Chapters', { ItemId: otherId, ChapterIndex: 1, StartPositionTicks: 10n }));
    assert.equal(BigInt(await fixture.database.deleteWhere('Chapters', { ItemId: otherId, Name: null })), 1n);
    assert.equal((await fixture.database.rows('Chapters', { where: { ItemId: otherId } })).length, 1);
  });

  test(`${dialect}: cancellation after the first prune cannot interrupt BeforeSave's remaining deletions`, options, async t => {
    const fixture = await setup(t, dialect), state = await seed(fixture, 'cancellation');
    const dataPath = path.join(state.root, 'data'), metadataPath = path.join(state.root, 'metadata');
    const manager = new ExternalDataManager({fileSystem: testFileSystem,  ...fixture, dataPath, metadataPath }), assets = await createAssets(manager, fixture, state.item);
    const library = new LibraryService({fileSystem: testFileSystem,  store: fixture.store, linkedChildren: fixture.linkedChildren, spoolRoot: fixture.spoolRoot, serverId: 'external-data', dataPath, metadataPath });
    const loadContext = createMetadataContextLoader({fileSystem: testFileSystem,  ...fixture, library }), host = new MetadataRefreshHost({ ...fixture, loadContext, registry: new MetadataRegistry(), externalData: manager });
    ownLibrary(fixture, library, loadContext);
    fixture.owners.push(() => host.close());
    const controller = new AbortController(), deleteRows = fixture.database.deleteWhere.bind(fixture.database), calls = [], before = await fixture.database.rows('BaseItems');
    fixture.database.deleteWhere = async (table, where) => {
      calls.push(table); const result = await deleteRows(table, where);
      if (table === 'KeyframeData') controller.abort();
      return result;
    };
    await assert.rejects(host.refresh(itemId, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None', signal: controller.signal }), { name: 'AbortError' });
    assert.deepEqual(calls, tables); assert.deepEqual(await fixture.database.rows('BaseItems'), before);
    const actual = await projection(fixture, manager, state.item, assets, state), expected = native.results[0];
    assert.deepEqual(actual.remaining, expected.remaining); assert.deepEqual(actual.assets, expected.assets);
  });
}

test('recursive state pruning checks its root and preserves files behind nested junctions', async t => {
  const fixture = await setup(t), root = path.join(fixture.root, 'link-control'), cache = path.join(root, 'cache'), outside = path.join(fixture.root, 'outside');
  await mkdir(cache, { recursive: true }); await mkdir(outside); await writeFile(path.join(outside, 'preserved.txt'), 'Preserved outside state');
  const assets = new MetadataImageAssets({fileSystem: testFileSystem,  metadataPath: root });
  const leaf = path.join(root, 'cache-leaf.bin'); await writeFile(leaf, 'Preserved cache leaf');
  await assert.rejects(assets.deleteDirectory(leaf), { code: 'ENOTDIR' });
  assert.equal(await readFile(leaf, 'utf8'), 'Preserved cache leaf');
  const link = path.join(cache, 'linked'); await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(assets.deleteDirectory(link), { code: 'permission-denied' });
  const rootIdentities = process.platform === 'win32' ? [root, root.toUpperCase()] : [root];
  for (const rootAssets of [assets, new MetadataImageAssets({fileSystem: testFileSystem,  stateRoots: [root] })]) {
    for (const identity of rootIdentities) await assert.rejects(rootAssets.deleteDirectory(identity), { code: 'permission-denied' });
  }
  await assets.deleteDirectory(cache);
  await assert.rejects(stat(cache), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(outside, 'preserved.txt'), 'utf8'), 'Preserved outside state');
  // Remove only this isolated, already verified junction target after assertions.
  assert.ok(path.resolve(outside).startsWith(path.resolve(fixture.root) + path.sep));
  await rm(outside, { recursive: true });
});
