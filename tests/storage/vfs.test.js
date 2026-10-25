import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap, normalizePath } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';

const allWrites = Object.freeze({ create: true, replace: true, mkdir: true, delete: true, rename: true,
  conditionalWrite: true, atomicReplace: true });

async function fixture() {
  const registry = new StorageRegistry();
  registry.registerType('fixture', (config) => new MemoryStorageAdapter(config));
  const first = await registry.createInstance('first', 'fixture', { pageSize: 1 });
  const second = await registry.createInstance('second', 'fixture');
  const vfs = new VirtualFileSystem(registry);
  return { registry, first, second, vfs };
}

async function readText(handle) {
  try {
    const parts = [];
    for await (const chunk of handle.stream) parts.push(chunk);
    return Buffer.concat(parts).toString('utf8');
  } finally { await handle.close(); }
}

test('paths preserve literal encoded names, Chinese, spaces and hashes', () => {
  assert.equal(normalizePath('/电影/%2e%2e/%2F/a b#c//'), '/电影/%2e%2e/%2F/a b#c');
  for (const path of ['relative', '/a/../b', '/./a', '/a\\b', '/a\0b']) {
    assert.throws(() => normalizePath(path), { code: 'invalid-path' });
  }
});

test('registry rejects duplicate and malformed adapters and closes initialized instances', async () => {
  const { registry } = await fixture();
  assert.throws(() => registry.registerType('fixture', () => null), { code: 'already-exists' });
  await assert.rejects(registry.createInstance('first', 'fixture', {}), { code: 'already-exists' });
  let closed = false;
  registry.registerType('invalid', () => ({ close() { closed = true; } }));
  await assert.rejects(registry.createInstance('invalid', 'invalid', {}), TypeError);
  assert.equal(closed, true);
  await registry.close();
  assert.throws(() => registry.getInstance('first'), { code: 'closed' });
});

test('registry reserves instance IDs while asynchronous factories initialize', async () => {
  const registry = new StorageRegistry();
  let ready;
  registry.registerType('slow', async () => { await new Promise((resolve) => { ready = resolve; }); return new MemoryStorageAdapter(); });
  const initializing = registry.createInstance('one', 'slow', {});
  await assert.rejects(registry.createInstance('one', 'slow', {}), { code: 'already-exists' });
  const closing = registry.close();
  ready();
  await assert.rejects(initializing, { code: 'closed' });
  await closing;
});

test('registry rejects mutable, legacy and method-inconsistent capability contracts', async () => {
  const registry = new StorageRegistry();
  const mutable = new MemoryStorageAdapter();
  mutable.capabilities = { ...mutable.capabilities };
  registry.registerType('mutable', () => mutable);
  await assert.rejects(registry.createInstance('mutable', 'mutable', {}), /complete frozen capability contract/u);

  const legacy = new MemoryStorageAdapter();
  legacy.capabilities = Object.freeze({ ...legacy.capabilities, write: true });
  registry.registerType('legacy', () => legacy);
  await assert.rejects(registry.createInstance('legacy', 'legacy', {}), /complete frozen capability contract/u);

  const missingWrite = new MemoryStorageAdapter();
  missingWrite.write = undefined;
  registry.registerType('missing-write', () => missingWrite);
  await assert.rejects(registry.createInstance('missing-write', 'missing-write', {}), /requires write/u);
  await registry.close();
});

test('mounts explicitly and independently downscope instance write capabilities', async t => {
  const registry = new StorageRegistry();
  registry.registerType('fixture', config => new MemoryStorageAdapter(config));
  const shared = await registry.createInstance('shared', 'fixture', {});
  await registry.createInstance('readonly', 'fixture', { capabilities: {} });
  const conditionalDelete = await registry.createInstance('conditional-delete', 'fixture', { capabilities: {
    create: true, delete: true, conditionalWrite: true
  } });
  const vfs = new VirtualFileSystem(registry);
  t.after(() => registry.close());

  vfs.mount({ path: '/create', instanceId: 'shared', capabilities: { create: true } });
  vfs.mount({ path: '/readonly', instanceId: 'shared', capabilities: {} });
  vfs.mount({ path: '/mutate', instanceId: 'shared', capabilities: { delete: true, rename: true } });
  vfs.mount({ path: '/conditional-delete', instanceId: 'conditional-delete', capabilities: { delete: true, conditionalWrite: true } });
  assert.equal(vfs.capabilities('/create/file').create, true);
  assert.equal(vfs.capabilities('/create/file').replace, false);
  assert.equal(vfs.capabilities('/readonly/file').create, false);
  assert.equal(vfs.capabilities('/create/file').reliableVersion, vfs.capabilities('/readonly/file').reliableVersion);

  await vfs.write('/create/file', Buffer.from('created'), { overwrite: false });
  await assert.rejects(vfs.write('/create/file', Buffer.from('replacement')), { code: 'not-supported' });
  assert.equal(await readText(await vfs.openRead('/readonly/file')), 'created');
  await assert.rejects(vfs.write('/readonly/other', Buffer.from('denied'), { overwrite: false }), { code: 'not-supported' });
  await shared.write('/conditional-delete', Buffer.from('delete'));
  const deleteVersion = (await shared.stat('/conditional-delete')).version;
  await assert.rejects(vfs.delete('/mutate/conditional-delete', { ifMatch: deleteVersion }), { code: 'not-supported' });
  assert.equal((await shared.stat('/conditional-delete')).kind, 'file');
  await shared.write('/conditional-rename', Buffer.from('rename'));
  const renameVersion = (await shared.stat('/conditional-rename')).version;
  await assert.rejects(vfs.rename('/mutate/conditional-rename', '/mutate/renamed', { ifMatch: renameVersion }), { code: 'not-supported' });
  assert.equal((await shared.stat('/conditional-rename')).kind, 'file');
  await assert.rejects(vfs.rename('/mutate/conditional-rename', '/mutate/renamed', { overwrite: true }), { code: 'not-supported' });
  assert.equal((await shared.stat('/conditional-rename')).kind, 'file');
  await conditionalDelete.write('/item', Buffer.from('conditional'), { overwrite: false });
  const conditionalDeleteVersion = (await conditionalDelete.stat('/item')).version;
  await vfs.delete('/conditional-delete/item', { ifMatch: conditionalDeleteVersion });
  await assert.rejects(conditionalDelete.stat('/item'), { code: 'not-found' });
  assert.throws(() => vfs.mount({ path: '/forged-read', instanceId: 'shared', capabilities: { reliableVersion: false } }), TypeError);
  assert.throws(() => vfs.mount({ path: '/elevated', instanceId: 'readonly', capabilities: { create: true } }), /cannot exceed/u);
  assert.throws(() => vfs.mount({ path: '/implicit', instanceId: 'shared' }), /capabilities object/u);
});

test('longest segment mount matching, synthetic parents and overlays agree', async (t) => {
  const { registry, first, second, vfs } = await fixture();
  t.after(() => registry.close());
  await first.mkdir('/films');
  await first.mkdir('/films/classics');
  await first.write('/films/classics/hidden.mkv', Buffer.from('hidden'));
  await first.write('/films/special', Buffer.from('a file hidden by a synthetic directory'));
  await first.write('/films/中国 %2F #.mkv', Buffer.from('original'));
  await second.write('/visible.mkv', Buffer.from('nested'));
  vfs.mount({ path: '/media/films', instanceId: 'first', root: '/films', capabilities: allWrites });
  vfs.mount({ path: '/media/films/classics', instanceId: 'second', capabilities: allWrites });
  vfs.mount({ path: '/media/films/special/deep', instanceId: 'second', capabilities: allWrites });
  assert.throws(() => vfs.mount({ path: '/media/films/', instanceId: 'first', capabilities: allWrites }), { code: 'already-exists' });
  assert.equal((await vfs.stat('/media')).kind, 'directory');
  assert.deepEqual((await vfs.list('/')).entries.map((item) => item.name), ['media']);
  assert.deepEqual((await vfs.list('/media')).entries.map((item) => item.name), ['films']);
  const entries = (await vfs.list('/media/films')).entries;
  assert.equal(entries.filter((entry) => entry.name === 'classics').length, 1);
  assert.equal(entries.find((entry) => entry.name === 'special').kind, 'directory');
  assert.equal((await vfs.stat('/media/films/special')).kind, 'directory');
  assert.deepEqual((await vfs.list('/media/films/special')).entries.map((item) => item.name), ['deep']);
  assert.deepEqual((await vfs.list('/media/films/classics')).entries.map((item) => item.name), ['visible.mkv']);
  assert.equal(await readText(await vfs.openRead('/media/films/classics/visible.mkv')), 'nested');
  assert.equal(await readText(await vfs.openRead('/media/films/中国 %2F #.mkv')), 'original');
  await assert.rejects(vfs.openRead('/media/films/special'), { code: 'is-directory' });
  await assert.rejects(vfs.stat('/media/films-old'), { code: 'not-found' });
  await assert.rejects(vfs.stat('/Media/films'), { code: 'not-found' });
  await assert.rejects(vfs.delete('/media/films'), { code: 'permission-denied' });
  await assert.rejects(vfs.rename('/media/films/中国 %2F #.mkv', '/media/films/classics/moved'), { code: 'not-supported' });
});

test('storage operations work through a non-HTTP adapter', async (t) => {
  const { registry, vfs } = await fixture();
  t.after(() => registry.close());
  vfs.mount({ path: '/network', instanceId: 'first', capabilities: allWrites });
  await vfs.mkdir('/network/library');
  await vfs.write('/network/library/movie.nfo', Buffer.from('<movie>中文</movie>'));
  assert.equal(await readText(await vfs.openRead('/network/library/movie.nfo')), '<movie>中文</movie>');
  await vfs.rename('/network/library/movie.nfo', '/network/library/renamed.nfo');
  await assert.rejects(vfs.stat('/network/library/movie.nfo'), { code: 'not-found' });
  assert.equal((await vfs.list('/network/library')).deletionSafe, true);
  await vfs.delete('/network/library/renamed.nfo');
  assert.deepEqual((await vfs.list('/network/library')).entries, []);
});

test('complete listing never returns a partial page after failure, repetition or snapshot change', async (t) => {
  const { registry, first, vfs } = await fixture();
  t.after(() => registry.close());
  await first.write('/one', Buffer.from('1'));
  await first.write('/two', Buffer.from('2'));
  vfs.mount({ path: '/root', instanceId: 'first', capabilities: {} });
  const listPage = first.listPage.bind(first);
  first.listPage = async (path, options) => {
    if (options.cursor) throw Object.assign(new Error('Injected network failure'), { code: 'unavailable' });
    return listPage(path, options);
  };
  await assert.rejects(vfs.list('/root'), { code: 'unavailable' });
  first.listPage = async (path, options) => {
    const page = await listPage(path, { ...options, cursor: null });
    return page;
  };
  await assert.rejects(vfs.list('/root'), { code: 'incomplete-listing' });
  first.listPage = async (path, options) => {
    if (options.cursor) await first.write('/three', Buffer.from('3'));
    return listPage(path, options);
  };
  await assert.rejects(vfs.list('/root'), { code: 'version-changed' });
  assert.equal((await first.stat('/one')).kind, 'file');
  assert.equal((await first.stat('/two')).kind, 'file');
});

test('deletion safety requires adapter capability, a stable snapshot, every page declaration and no overlays', async t => {
  const { registry, first, second, vfs } = await fixture();
  t.after(() => registry.close());
  await first.write('/one', Buffer.from('1'));
  await first.write('/two', Buffer.from('2'));
  vfs.mount({ path: '/root', instanceId: 'first', capabilities: {} });
  const listPage = first.listPage.bind(first);

  first.listPage = async (...args) => ({ ...await listPage(...args), deletionSafe: false });
  assert.equal((await vfs.list('/root')).deletionSafe, false);
  first.listPage = async (...args) => {
    const { deletionSafe: _, ...page } = await listPage(...args);
    return page;
  };
  await assert.rejects(vfs.list('/root'), { code: 'invalid-response' });
  first.listPage = listPage;

  await second.write('/nested', Buffer.from('nested'));
  vfs.mount({ path: '/root/nested', instanceId: 'second', root: '/', capabilities: {} });
  assert.equal((await vfs.list('/root')).deletionSafe, false);

  const weakRegistry = new StorageRegistry();
  t.after(() => weakRegistry.close());
  weakRegistry.registerType('weak-snapshot', config => {
    const adapter = new MemoryStorageAdapter(config);
    adapter.capabilities = Object.freeze({ ...adapter.capabilities, directorySnapshot: false });
    return adapter;
  });
  const weak = await weakRegistry.createInstance('weak', 'weak-snapshot', {});
  await weak.write('/item', Buffer.from('item'));
  const weakVfs = new VirtualFileSystem(weakRegistry);
  weakVfs.mount({ path: '/weak', instanceId: 'weak', capabilities: {} });
  const listing = await weakVfs.list('/weak');
  assert.equal(listing.consistency, 'snapshot');
  assert.equal(listing.deletionSafe, false);
});

test('readonly capabilities and cancelled writes report real failures', async (t) => {
  const { registry, vfs } = await fixture();
  t.after(() => registry.close());
  await registry.createInstance('readonly', 'fixture', { capabilities: {} });
  vfs.mount({ path: '/readonly', instanceId: 'readonly', capabilities: {} });
  await assert.rejects(vfs.write('/readonly/one', Buffer.from('1')), { code: 'not-supported' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(vfs.stat('/readonly', { signal: controller.signal }), { code: 'cancelled' });
});

test('memory range reads and strong version preconditions are exact', async (t) => {
  const adapter = new MemoryStorageAdapter();
  t.after(() => adapter.close());
  await adapter.write('/bytes', Buffer.from('0123456789'));
  const version = (await adapter.stat('/bytes')).version;
  for (const [range, expected] of [[{ start: 2, end: 4 }, '234'], [{ start: 7 }, '789'], [{ suffix: 3 }, '789'], [{ suffix: 30 }, '0123456789']]) {
    const handle = await adapter.openRead('/bytes', { range, ifMatch: version });
    assert.equal(handle.rangeHonored, true);
    assert.equal(await readText(handle), expected);
  }
  await assert.rejects(adapter.openRead('/bytes', { range: { start: 10 } }), { code: 'range-not-satisfiable' });
  const full = await adapter.openRead('/bytes', { range: { start: 2 }, ifRange: 'old' });
  assert.equal(full.rangeHonored, false);
  assert.equal(await readText(full), '0123456789');
  await adapter.write('/bytes', Buffer.from('changed'));
  await assert.rejects(adapter.openRead('/bytes', { ifMatch: version }), { code: 'version-changed' });
});

test('identity mapping preserves stored paths, ID overrides and reverse return-access records', () => {
  const mapping = new IdentityAccessMap();
  mapping.addPrefix({ identityRoot: 'D:\\Movies', accessRoot: '/network/movies', style: 'windows', returnAccess: 'Verified test bridge plan' });
  mapping.addPrefix({ identityRoot: '/music', accessRoot: '/network/music', returnAccess: 'Verified test namespace' });
  assert.equal(mapping.resolve({ identityPath: 'D:\\Movies\\中文 %2F #.mkv', style: 'windows' }), '/network/movies/中文 %2F #.mkv');
  assert.equal(mapping.identityFor('/network/movies/new/file.mkv').identityPath, 'D:\\Movies\\new\\file.mkv');
  assert.equal(mapping.identityFor('/network/music/album/song.flac').identityPath, '/music/album/song.flac');
  mapping.bind('original-id', '/different/source');
  mapping.bind('01234567-89AB-CDEF-0123-456789ABCDEF', '/explicit/guid');
  assert.equal(mapping.resolve({ itemId: '0123456789abcdef0123456789abcdef' }), '/explicit/guid');
  assert.equal(mapping.resolve({ itemId: 'original-id', identityPath: 'D:\\Movies\\old.mkv', style: 'windows' }), '/different/source');
  assert.throws(() => mapping.resolve({ identityPath: 'D:\\Movies-old\\x', style: 'windows' }), { code: 'not-found' });
  mapping.addPrefix({ identityRoot: 'E:\\Movies', accessRoot: '/case-folded', style: 'windows', caseSensitive: false, returnAccess: 'isolated bridge' });
  assert.equal(mapping.resolve({ identityPath: 'e:\\movies\\Title.mkv', style: 'windows' }), '/case-folded/Title.mkv');
  assert.throws(() => mapping.addPrefix({ identityRoot: 'e:\\MOVIES', accessRoot: '/duplicate', style: 'windows', returnAccess: 'isolated bridge' }), { code: 'already-exists' });
  assert.equal(mapping.exportState().prefixes[0].identityRoot, 'D:\\Movies');
});
