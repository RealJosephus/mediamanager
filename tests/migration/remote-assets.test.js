import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { tableDefinition } from '../../src/database/model.js';
import { createStatePackage, verifyStatePackage, restoreStatePackage, restoreRemoteStatePackage } from '../../src/migration/state-package.js';
import { StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { createInstanceFixture } from './instance-fixture.js';

const itemId = '71717171-7171-7171-7171-717171717171';
const nfoBytes = Buffer.from('<movie><title>Current 中文</title></movie>');
const sha = value => createHash('sha256').update(value).digest('hex');
const emptyRow = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated)
  .map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : 0]));

async function fixture(t, { linkedNfo = false, weakVersion = false } = {}) {
  const instance = await createInstanceFixture(t, { prefix: 'remote-state-' });
  const { directory, database } = instance;
  const registry = new StorageRegistry(); registry.registerType('fixture', () => new MemoryStorageAdapter());
  const source = await registry.createInstance('source', 'fixture', {});
  const target = await registry.createInstance('target', 'fixture', {});
  if (weakVersion) source.capabilities = Object.freeze({ ...source.capabilities, reliableVersion: false });
  await source.write('/movie.nfo', nfoBytes);
  await source.write('/movie.srt', Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nUpdated captions\n'));
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/source', instanceId: 'source', capabilities: {} });
  vfs.mount({ path: '/target', instanceId: 'target', capabilities: {
    create: true, replace: true, conditionalWrite: true, atomicReplace: true
  } });
  const destination = path.join(directory, 'package');
  const mediaAccess = { scope: 'explicit-items', items: [] };
  if (linkedNfo) {
    database.insert('BaseItems', { ...emptyRow('BaseItems'), Id: itemId, Path: 'Z:\\Media\\feature.mkv', Type: 'MediaBrowser.Controller.Entities.Movies.Movie',
      MediaType: 'Video', IsInMixedFolder: false, Data: '{"VideoType":"VideoFile"}' });
    mediaAccess.items.push({ itemId, identityRoot: 'Z:\\Media', identityPath: 'Z:\\Media\\feature.mkv', enumeration: { kind: 'native-filesystem', root: 'Z:\\Media' },
      read: { kind: 'native-local-media-proxy' }, expected: { bytes: '10', sha256: sha(Buffer.alloc(10)), range: { start: '0', end: '0', sha256: sha(Buffer.alloc(1)) } },
      sidecars: [{ kind: 'nfo', identityPath: 'Z:\\Media\\movie.nfo', read: { kind: 'native-filesystem-sidecar' }, stateAssetId: 'movie-nfo',
        expected: { bytes: String(nfoBytes.length), sha256: sha(nfoBytes) } }] });
  }
  const options = { destination, mediaAccess, remoteState: { vfs, assets: [
    { assetId: 'movie-nfo', virtualPath: '/source/movie.nfo', restorePath: 'movie.nfo', kind: 'nfo' },
    { assetId: 'movie-subtitle', virtualPath: '/source/movie.srt', restorePath: 'movie.srt', kind: 'subtitle' },
  ] } };
  t.after(async () => { await registry.close(); });
  const create = async () => createStatePackage(await instance.packageOptions(options));
  return { directory, source, target, vfs, database, destination, options, create };
}

async function resignManifest(directory, manifest) {
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(directory, 'manifest.json'), text);
  await writeFile(path.join(directory, 'COMMITTED'), `${JSON.stringify({ generation: manifest.generation,
    manifestSha256: createHash('sha256').update(text).digest('hex') }, null, 2)}\n`);
}
async function content(adapter, name) {
  const handle = await adapter.openRead(name);
  try { const chunks = []; for await (const chunk of handle.stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }
  finally { await handle.close(); }
}
const targets = { 'movie-nfo': '/target/movie.nfo', 'movie-subtitle': '/target/movie.srt' };
const captureStagingPath = destination => path.join(path.dirname(destination), `.${path.basename(destination)}.mediamanager-package-staging`);

test('current remote NFO and subtitles join the database generation and restore to a separate backend', async t => {
  const { source, target, vfs, create, destination } = await fixture(t, { linkedNfo: true });
  const manifest = await create();
  assert.equal(manifest.remoteAssets.length, 2);
  assert.deepEqual(await verifyStatePackage(destination), manifest);
  const local = await restoreStatePackage(destination, path.join(path.dirname(destination), 'restored-instance'));
  await assert.rejects(access(path.join(local.destination, 'remote-assets')), { code: 'ENOENT' });
  await assert.rejects(restoreRemoteStatePackage(destination, { vfs, targets: { ...targets, 'movie-nfo': undefined, 'MOVIE-NFO': '/target/movie.nfo' } }), /canonical manifest asset IDs/u);
  const restored = await restoreRemoteStatePackage(destination, { vfs, targets });
  assert.equal(restored.complete, true);
  assert.deepEqual(await content(target, '/movie.nfo'), await content(source, '/movie.nfo'));
  assert.deepEqual(await content(target, '/movie.srt'), await content(source, '/movie.srt'));
  const retry = await restoreRemoteStatePackage(destination, { vfs, targets });
  assert.equal(retry.completed.every(item => item.reused), true);
  await target.write('/movie.nfo', Buffer.from('newer independent edit'));
  await assert.rejects(restoreRemoteStatePackage(destination, { vfs, targets }), /overwrite|bound generation/u);
  assert.equal((await content(target, '/movie.nfo')).toString(), 'newer independent edit');
  const invalidVersion = structuredClone(manifest); invalidVersion.remoteAssets[0].remote.version = null;
  await resignManifest(destination, invalidVersion);
  await assert.rejects(verifyStatePackage(destination), /Invalid remote state asset declaration/u);
  manifest.mediaAccess.items[0].sidecars[0].stateAssetId = 'missing-nfo'; await resignManifest(destination, manifest);
  await assert.rejects(verifyStatePackage(destination), /state asset is missing/u);
});

test('linked NFO state assets reject missing, wrong-kind and mismatched captures before commit', async t => {
  for (const [name, change, pattern] of [
    ['missing association', options => { options.mediaAccess.items[0].sidecars[0].stateAssetId = 'missing-nfo'; }, /state asset is missing/u],
    ['wrong association', options => { options.mediaAccess.items[0].sidecars[0].stateAssetId = 'movie-subtitle'; }, /wrong kind/u],
    ['wrong digest', options => { options.mediaAccess.items[0].sidecars[0].expected.sha256 = sha(Buffer.alloc(nfoBytes.length)); }, /content differs/u],
  ]) await t.test(name, async t => {
    const { options, create, destination } = await fixture(t, { linkedNfo: true }); change(options);
    await assert.rejects(create(), pattern);
    await assert.rejects(access(path.join(destination, 'COMMITTED')));
  });
});

test('remote capture rejects duplicate canonical virtual paths and asset IDs', async t => {
  for (const [name, duplicate, pattern] of [
    ['virtual path', { assetId: 'duplicate-source', virtualPath: '/source//movie.nfo', restorePath: 'copy.nfo', kind: 'nfo' }, /virtual path/u],
    ['asset ID', { assetId: 'movie-nfo', virtualPath: '/source/other.nfo', restorePath: 'copy.nfo', kind: 'nfo' }, /asset ID/u],
    ['non-canonical asset ID', { assetId: 'MOVIE-NFO', virtualPath: '/source/other.nfo', restorePath: 'copy.nfo', kind: 'nfo' }, /canonical asset ID/u],
    ['unknown declaration field', { assetId: 'copy-nfo', virtualPath: '/source/other.nfo', restorePath: 'copy.nfo', kind: 'nfo', note: 'unexpected' }, /only a canonical asset ID/u],
  ]) await t.test(name, async t => {
    const { options, create, destination } = await fixture(t);
    options.remoteState.assets.push(duplicate);
    await assert.rejects(create(), pattern);
    await assert.rejects(access(path.join(destination, 'COMMITTED')));
  });
});

test('one remote asset cannot be linked to multiple media access NFO sidecars', async t => {
  const { options, create, database, destination } = await fixture(t, { linkedNfo: true });
  const secondId = '72727272-7272-7272-7272-727272727272';
  database.insert('BaseItems', { ...emptyRow('BaseItems'), Id: secondId, Path: 'Z:\\Media\\feature2.mkv', Type: 'MediaBrowser.Controller.Entities.Movies.Movie',
    MediaType: 'Video', IsInMixedFolder: false, Data: '{"VideoType":"VideoFile"}' });
  const second = structuredClone(options.mediaAccess.items[0]); second.itemId = secondId; second.identityPath = 'Z:\\Media\\feature2.mkv';
  options.mediaAccess.items.push(second);
  await assert.rejects(create(), /linked by more than one media access sidecar/u);
  await assert.rejects(access(path.join(destination, 'COMMITTED')));
});

test('a remote sidecar change during database export prevents generation commit', async t => {
  const { source, database, destination, create } = await fixture(t);
  const originalRows = database.rows.bind(database);
  let changed = false;
  database.rows = async (...args) => {
    if (!changed) { changed = true; await source.write('/movie.nfo', Buffer.from('concurrent remote edit')); }
    return originalRows(...args);
  };
  await assert.rejects(create(), /Remote state changed/);
  await assert.rejects(access(path.join(destination, 'COMMITTED')));
  const progress = JSON.parse(await readFile(path.join(captureStagingPath(destination), 'progress.json'), 'utf8'));
  assert.equal(progress.stage, 'preflight');
  assert.match(progress.lastError, /Remote state changed/u);
});

test('remote capture refuses weak versions and media inventories before declaring a snapshot', async t => {
  const { create } = await fixture(t, { weakVersion: true });
  await assert.rejects(create(), /reliable conditional object versions/);
});

test('remote restore reports partial writes and resumes only matching completed assets', async t => {
  const { target, vfs, destination, create } = await fixture(t);
  await create();
  const write = target.write.bind(target);
  target.write = async (name, ...args) => { if (name === '/movie.srt') throw new Error('injected remote failure'); return write(name, ...args); };
  await assert.rejects(restoreRemoteStatePackage(destination, { vfs, targets }), error => {
    assert.equal(error.remoteRestoreProgress.complete, false);
    assert.equal(error.remoteRestoreProgress.completed.length, 1);
    return /injected/.test(error.message);
  });
  target.write = write;
  const result = await restoreRemoteStatePackage(destination, { vfs, targets });
  assert.deepEqual(result.completed.map(item => item.reused), [true, false]);
});

test('remote restore rejects target aliases after VFS normalization without rejecting remote names', async t => {
  const { target, vfs, destination, create } = await fixture(t);
  await create();
  await assert.rejects(restoreRemoteStatePackage(destination, { vfs, targets: {
    'movie-nfo': '/target//shared.nfo',
    'movie-subtitle': '/target/shared.nfo/',
  } }), /Duplicate remote restore target/u);
  await assert.rejects(target.stat('/shared.nfo'), { code: 'not-found' });

  const restored = await restoreRemoteStatePackage(destination, { vfs, targets: {
    'movie-nfo': '/target/CON.txt',
    'movie-subtitle': '/target/caption.srt.',
  } });
  assert.equal(restored.complete, true);
  assert.deepEqual(await content(target, '/CON.txt'), nfoBytes);
  assert.match((await content(target, '/caption.srt.')).toString(), /Updated captions/u);
});

test('state-package restore paths preserve literal trailing dots and device-like names', async t => {
  const { vfs, destination, options, create } = await fixture(t);
  options.remoteState.assets[0].restorePath = 'COM¹.nfo';
  options.remoteState.assets[1].restorePath = 'LPT³.srt.';
  const manifest = await create();
  assert.deepEqual(manifest.remoteAssets.map(file => file.path), [
    'remote-assets/COM¹.nfo',
    'remote-assets/LPT³.srt.',
  ]);
  await verifyStatePackage(destination);
  const restored = await restoreRemoteStatePackage(destination, { vfs, targets });
  assert.equal(restored.complete, true);
});
