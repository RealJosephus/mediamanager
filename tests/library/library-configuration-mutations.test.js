import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LibraryConfigurationService } from '../../src/library/library-configuration-service.js';
import { LibraryOptionsStore } from '../../src/library/library-options-store.js';
import { defaultLibraryOptions } from '../../src/library/options.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';

const mediaRoot = process.platform === 'win32' ? 'Z:\\Media' : '/media',
  mediaA = path.join(mediaRoot, 'A'), mediaB = path.join(mediaRoot, 'B');
async function setup(t, { infos = [], files = {}, configuration = { ContentTypes: [] } } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'library-mutations-')), views = path.join(root, 'root', 'default'),
    directory = path.join(views, 'Library'), data = path.join(root, 'data');
  const calls = [], errors = [], registry = new StorageRegistry(), optionsById = new Map(); let service, optionsStore;
  t.after(async () => {
    const failures = [];
    for (const close of [() => service?.close(), () => optionsStore?.close(), () => registry.close(), async () => {
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('library-mutations-')); await fs.rm(root, { recursive: true, force: true });
    }]) try { await close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Library mutation cleanup failed.');
  });
  await fs.mkdir(directory, { recursive: true }); await fs.mkdir(data);
  registry.registerType('memory', options => new MemoryStorageAdapter(options)); const adapter = await registry.createInstance('media', 'memory', {});
  for (const name of ['A', 'B', 'C']) await adapter.mkdir('/' + name);
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/remote', instanceId: 'media', capabilities: {} });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: mediaRoot, accessRoot: '/remote', style: process.platform === 'win32' ? 'windows' : 'posix', returnAccess: 'mutation test' });
  optionsStore = new LibraryOptionsStore({fileSystem: testFileSystem,  programDataPath: root, dataPath: data, optionsById });
  const options = { ...defaultLibraryOptions(), PathInfos: structuredClone(infos) };
  await optionsStore.save(directory, options);
  for (const [name, bytes] of Object.entries(files)) {
    const filename = path.join(directory, name); await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, bytes);
  }
  const trace = (action, value = null) => calls.push({ action, value });
  optionsStore.on('updated', event => trace('options-updated', event));
  const clear = optionsStore.clear.bind(optionsStore); optionsStore.clear = async () => { trace('options-clear'); await clear(); };
  const host = { getUserRootFolder: () => ({}), withCachedChildren: async (_root, operation) => operation({ firstByPath: async () => null }) };
  const lifecycle = { isScanRunning: false, validateTopLibraryFolders: async value => trace('validate', value) };
  const monitor = { stop: async () => trace('monitor-stop'), start: async () => trace('monitor-start') };
  service = new LibraryConfigurationService({fileSystem: testFileSystem,  programDataPath: root, optionsStore, host, lifecycle, monitor, configuration,
    mediaAssets: new MetadataImageAssets({fileSystem: testFileSystem,  vfs, identityMap, stateRoots: [data] }),
    sleep: async value => trace('delay', value), invalidateDirectory: filename => trace('invalidate', filename),
    queueLibraryScan: () => trace('queue-scan'), onError: error => errors.push(error),
    configurationStore: { updateContentTypes: async transform => { configuration.ContentTypes = transform(configuration.ContentTypes); trace('configuration-save'); } } });
  return { root, views, directory, data, calls, errors, optionsById, optionsStore, options, service, lifecycle, monitor, configuration };
}
const actions = state => state.calls.map(call => call.action);

test('media-path addition writes colliding shortcuts before appending options and preserves duplicate paths', async t => {
  const state = await setup(t, { infos: [{ Path: mediaA }], files: { 'A.mblink': mediaA },
    configuration: { ContentTypes: [{ Name: mediaA, Value: 'movies' }, { Name: path.join(mediaA, 'Child'), Value: 'books' }, { Name: mediaRoot, Value: 'music' }] } });
  const info = { Path: mediaA }; await state.service.addMediaPath('Library', info);
  assert.equal(await fs.readFile(path.join(state.directory, 'A1.mblink'), 'utf8'), mediaA);
  assert.deepEqual(state.options.PathInfos, [{ Path: mediaA }, info]); assert.equal(state.options.PathInfos[1], info);
  assert.deepEqual(state.configuration.ContentTypes, [{ Name: mediaRoot, Value: 'music' }]);
  assert.deepEqual(actions(state), ['invalidate', 'configuration-save', 'options-updated']);
  await state.optionsStore.clear(); assert.deepEqual((await state.optionsStore.get(state.directory)).PathInfos, [{ Path: mediaA }, { Path: mediaA }]);
});

test('media-path addition appends missing exact shortcut locations only when their count differs', async t => {
  const state = await setup(t, { infos: [{ Path: mediaA }], files: { 'A.mblink': mediaA, 'C.mblink': path.join(mediaRoot, 'C') } });
  await state.service.addMediaPath('Library', { Path: mediaB });
  assert.deepEqual(state.options.PathInfos, [{ Path: mediaA }, { Path: mediaB }, { Path: path.join(mediaRoot, 'C') }]);
  assert.deepEqual(actions(state), ['invalidate', 'options-updated']);
});

test('media-path update ignores its non-null input and equal-count stale options', async t => {
  const state = await setup(t, { infos: [{ Path: 'stale' }], files: { 'B.mblink': mediaB } });
  state.service.mediaAssets.stat = () => assert.fail('Updating options must not validate the ignored media path.');
  await state.service.updateMediaPath('Library', { Path: 'missing' });
  assert.deepEqual(state.options.PathInfos, [{ Path: 'stale' }]); assert.deepEqual(actions(state), ['options-updated']);
  state.options.PathInfos = []; await state.service.updateMediaPath('Library', { Path: null });
  assert.deepEqual(state.options.PathInfos, [{ Path: mediaB }]);
  await assert.rejects(state.service.updateMediaPath('Library', null), { status: 400 });
});

test('media-path update retains stale entries and adds each missing exact location once', async t => {
  const state = await setup(t, { infos: [{ Path: mediaA.toLowerCase() }], files: { 'a.mblink': mediaA, 'b.mblink': mediaB, 'c.mblink': mediaA } });
  await state.service.updateMediaPath('Library', {});
  assert.deepEqual(state.options.PathInfos, [{ Path: mediaA.toLowerCase() }, { Path: mediaA }, { Path: mediaB }]);
  await fs.unlink(path.join(state.directory, 'a.mblink')); await fs.unlink(path.join(state.directory, 'b.mblink')); await fs.unlink(path.join(state.directory, 'c.mblink'));
  await state.service.updateMediaPath('Library', {});
  assert.deepEqual(state.options.PathInfos, [{ Path: mediaA.toLowerCase() }, { Path: mediaA }, { Path: mediaB }]);
});

test('media-path removal matches one shortcut ignoring case and filters all options by exact path', async t => {
  const state = await setup(t, { infos: [{ Path: mediaA }, { Path: mediaA }, { Path: mediaA.toLowerCase() }, { Path: mediaB }],
    files: { 'A.MBLINK': mediaA + '\\', 'nested/duplicate.mblink': mediaA } });
  await state.service.removeMediaPath('Library', mediaA);
  await assert.rejects(fs.stat(path.join(state.directory, 'A.MBLINK')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(state.directory, 'nested/duplicate.mblink'), 'utf8'), mediaA);
  assert.deepEqual(state.options.PathInfos, [{ Path: mediaA.toLowerCase() }, { Path: mediaB }]);
  assert.deepEqual(actions(state), ['invalidate', 'options-updated']);
  await state.service.removeMediaPath('Library', mediaA.toUpperCase());
  await assert.rejects(fs.stat(path.join(state.directory, 'nested/duplicate.mblink')), { code: 'ENOENT' });
  assert.deepEqual(state.options.PathInfos, [{ Path: mediaA.toLowerCase() }, { Path: mediaB }]);
});

test('removing an absent or whitespace media path still saves options and does not synchronize stale paths', async t => {
  const state = await setup(t, { infos: [{ Path: mediaA }], files: { 'B.mblink': mediaB } });
  await state.service.removeMediaPath('Library', 'absent'); await state.service.removeMediaPath('Library', ' ');
  assert.deepEqual(state.options.PathInfos, [{ Path: mediaA }]); assert.deepEqual(actions(state), ['options-updated', 'options-updated']);
  for (const value of [null, '']) await assert.rejects(state.service.removeMediaPath('Library', value), { status: 400 });
});

test('failed path-option saving preserves the preceding shortcut, configuration and live option changes', async t => {
  const state = await setup(t, { configuration: { ContentTypes: [{ Name: mediaA, Value: 'movies' }] } });
  state.options.AllowEmbeddedSubtitles = 100;
  await assert.rejects(state.service.addMediaPath('Library', { Path: mediaA }), { code: 'invalid-library-option-enum' });
  assert.equal(await fs.readFile(path.join(state.directory, 'A.mblink'), 'utf8'), mediaA);
  assert.deepEqual(state.configuration.ContentTypes, []); assert.deepEqual(state.options.PathInfos, [{ Path: mediaA }]);
  assert.deepEqual(actions(state), ['invalidate', 'configuration-save']);
});

test('null PathInfos failures retain each operation\'s completed file prefix', async t => {
  const state = await setup(t, { files: { 'A.mblink': mediaA } }); state.options.PathInfos = null;
  await assert.rejects(state.service.addMediaPath('Library', { Path: mediaA }), TypeError);
  assert.equal(await fs.readFile(path.join(state.directory, 'A1.mblink'), 'utf8'), mediaA);
  await assert.rejects(state.service.updateMediaPath('Library', {}), TypeError);
  await assert.rejects(state.service.removeMediaPath('Library', mediaA), TypeError);
  await assert.rejects(fs.stat(path.join(state.directory, 'A.mblink')), { code: 'ENOENT' });
  assert.deepEqual(actions(state), ['invalidate', 'invalidate']);
});

test('shortcut read failure is logged during synchronization and propagates during removal', async t => {
  const state = await setup(t, { files: { 'A.mblink': mediaA } });
  const failure = Object.assign(new Error('Controlled shortcut read failure.'), { code: 'EIO' });
  state.service.fileSystem = { ...fs, readFile: filename => filename.endsWith('.mblink') ? Promise.reject(failure) : fs.readFile(filename) };
  await state.service.updateMediaPath('Library', {});
  assert.deepEqual(state.errors, [failure]); assert.deepEqual(actions(state), ['options-updated']);
  await assert.rejects(state.service.removeMediaPath('Library', mediaA), error => error === failure);
  assert.deepEqual(actions(state), ['options-updated']); assert.equal(await fs.readFile(path.join(state.directory, 'A.mblink'), 'utf8'), mediaA);
});

test('recursive path removal skips inaccessible directories and still removes a later sibling shortcut', async t => {
  const state = await setup(t, { infos: [{ Path: mediaA }], files: { 'denied/first.mblink': mediaA, 'later/target.mblink': mediaA } });
  const denied = path.join(state.directory, 'denied');
  state.service.fileSystem = { ...fs, readdir: async (directory, options) => {
    if (directory === denied) throw Object.assign(new Error('Controlled inaccessible directory.'), { code: 'EACCES' });
    return fs.readdir(directory, options);
  } };
  await state.service.removeMediaPath('Library', mediaA);
  assert.equal(await fs.readFile(path.join(denied, 'first.mblink'), 'utf8'), mediaA);
  await assert.rejects(fs.stat(path.join(state.directory, 'later/target.mblink')), { code: 'ENOENT' });
  assert.deepEqual(state.options.PathInfos, []); assert.deepEqual(actions(state), ['invalidate', 'options-updated']);
});

test('shortcut synchronization skips an inaccessible directory without adding locations', async t => {
  const state = await setup(t, { infos: [{ Path: 'stale' }], files: { 'A.mblink': mediaA } });
  state.service.fileSystem = { ...fs, readdir: async (directory, options) => {
    if (directory === state.directory) throw Object.assign(new Error('Controlled inaccessible directory.'), { code: 'EPERM' });
    return fs.readdir(directory, options);
  } };
  await state.service.updateMediaPath('Library', {});
  assert.deepEqual(state.options.PathInfos, [{ Path: 'stale' }]); assert.deepEqual(actions(state), ['options-updated']);
});

test('recursive path removal skips a denied directory realpath without hiding other traversal errors', async t => {
  const state = await setup(t, { infos: [{ Path: mediaA }], files: { 'denied/first.mblink': mediaA, 'later/target.mblink': mediaA } });
  const denied = path.join(state.directory, 'denied');
  state.service.fileSystem = { ...fs, realpath: async directory => {
    if (directory === denied) throw Object.assign(new Error('Controlled inaccessible directory.'), { code: 'EACCES' });
    return fs.realpath(directory);
  } };
  await state.service.removeMediaPath('Library', mediaA);
  assert.equal(await fs.readFile(path.join(denied, 'first.mblink'), 'utf8'), mediaA);
  await assert.rejects(fs.stat(path.join(state.directory, 'later/target.mblink')), { code: 'ENOENT' });
  state.service.fileSystem = { ...fs, readdir: async () => { throw Object.assign(new Error('Controlled enumeration failure.'), { code: 'EIO' }); } };
  await assert.rejects(state.service.removeMediaPath('Library', mediaA), { code: 'EIO' });
  assert.deepEqual(actions(state), ['invalidate', 'options-updated']);
});

test('path mutations reject host media and escaped library names before changing files', async t => {
  const state = await setup(t), localMedia = path.join(state.root, 'host-media'); await fs.mkdir(localMedia);
  await assert.rejects(state.service.addMediaPath('Library', { Path: localMedia }), { status: 404 });
  for (const name of ['../Library', '..\\Library', '.', '..', '', ' ', 'Library.', 'Library ', 'Z:Library', 'bad\0name']) {
    await assert.rejects(state.service.addMediaPath(name, { Path: mediaA }), { status: 404 });
    await assert.rejects(state.service.updateMediaPath(name, {}), { status: 404 });
    await assert.rejects(state.service.removeMediaPath(name, mediaA), { status: 404 });
  }
  assert.deepEqual(actions(state), []); assert.deepEqual(await fs.readdir(localMedia), []);
});

test('media-path operations reject escaped directory and shortcut junctions', async t => {
  const state = await setup(t), outside = path.join(state.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'A.mblink'), mediaA);
  await fs.symlink(outside, path.join(state.views, 'External'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(state.service.addMediaPath('External', { Path: mediaA }), { status: 501 });
  await assert.rejects(state.service.updateMediaPath('External', {}), { status: 501 });
  await assert.rejects(state.service.removeVirtualFolder('External'), { status: 501 });
  await fs.symlink(outside, path.join(state.directory, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(state.service.removeMediaPath('Library', mediaA), { status: 501 });
  assert.equal(await fs.readFile(path.join(outside, 'A.mblink'), 'utf8'), mediaA); assert.deepEqual(actions(state), []);
});

test('media-path addition rejects a dangling shortcut link without creating its outside target', async t => {
  const state = await setup(t), outside = path.join(state.root, 'outside'), target = path.join(outside, 'created.mblink');
  await fs.mkdir(outside);
  await fs.symlink(target, path.join(state.directory, 'A.mblink'), process.platform === 'win32' ? 'junction' : 'file');
  await assert.rejects(state.service.addMediaPath('Library', { Path: mediaA }), { status: 501 });
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  assert.deepEqual(state.options.PathInfos, []); assert.deepEqual(actions(state), []);
});

test('shortcut creation cannot follow a link introduced after path validation', async t => {
  const state = await setup(t); let attempted = false;
  state.service.fileSystem = { ...fs, writeFile: async (filename, bytes, options) => {
    if (filename.endsWith('A.mblink')) {
      attempted = true; assert.deepEqual(options, { flag: 'wx' });
      throw Object.assign(new Error('Controlled post-validation collision.'), { code: 'EEXIST' });
    }
    return fs.writeFile(filename, bytes, options);
  } };
  await assert.rejects(state.service.addMediaPath('Library', { Path: mediaA }), { code: 'EEXIST' });
  assert.equal(attempted, true);
  assert.deepEqual(state.options.PathInfos, []); assert.deepEqual(actions(state), []);
});

test('virtual-folder removal without refresh clears cached options without coordinating persisted roots', async t => {
  const state = await setup(t); await state.optionsStore.bind('library-id', state.directory);
  await state.service.removeVirtualFolder('Library');
  await assert.rejects(fs.stat(state.directory), { code: 'ENOENT' });
  assert.deepEqual(actions(state), ['monitor-stop', 'invalidate', 'options-clear', 'delay', 'monitor-start']);
  assert.equal(state.calls.find(call => call.action === 'delay').value, 1000);
  const published = state.optionsById.get('libraryid');
  assert.notEqual(published, state.options); assert.deepEqual(published, defaultLibraryOptions());
  assert.equal(await state.optionsStore.get(state.directory), published);
});

test('recursive shortcut traversal rejects an internal directory cycle before saving options', async t => {
  const state = await setup(t, { infos: [{ Path: mediaA }] });
  const before = await fs.readFile(path.join(state.directory, 'options.xml'));
  await fs.symlink(state.directory, path.join(state.directory, 'loop'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(state.service.removeMediaPath('Library', mediaA), { status: 501 });
  assert.deepEqual(actions(state), []); assert.equal(await state.optionsStore.get(state.directory), state.options);
  assert.deepEqual(state.options.PathInfos, [{ Path: mediaA }]);
  assert.deepEqual(await fs.readFile(path.join(state.directory, 'options.xml')), before);
});

test('virtual-folder removal with refresh permits root removal and queues only without an active scan', async t => {
  const state = await setup(t); await state.service.removeVirtualFolder('Library', true); await state.service.close();
  assert.deepEqual(actions(state), ['monitor-stop', 'invalidate', 'options-clear', 'validate', 'queue-scan']);
  assert.deepEqual(state.calls.find(call => call.action === 'validate').value, { removeRoot: true });
  const active = await setup(t); active.lifecycle.isScanRunning = true; await active.service.removeVirtualFolder('Library', true);
  assert.deepEqual(actions(active), ['monitor-stop', 'invalidate', 'options-clear', 'validate']);
});

test('virtual-folder deletion failure still clears options and restarts the monitor', async t => {
  const state = await setup(t), failure = new Error('Controlled recursive deletion failure.');
  await state.optionsStore.bind('library-id', state.directory);
  state.service.fileSystem = { ...fs, rm: async () => { throw failure; } };
  await assert.rejects(state.service.removeVirtualFolder('Library'), error => error === failure);
  assert.equal((await fs.stat(state.directory)).isDirectory(), true);
  assert.deepEqual(actions(state), ['monitor-stop', 'options-clear', 'delay', 'monitor-start']);
  const published = state.optionsById.get('libraryid');
  assert.notEqual(published, state.options); assert.deepEqual(published, state.options);
});

test('virtual-folder invalidation failure preserves deletion and still clears options and restarts the monitor', async t => {
  const state = await setup(t), failure = new Error('Controlled directory invalidation failure.');
  state.service.invalidateDirectory = async () => { state.calls.push({ action: 'invalidate' }); throw failure; };
  await assert.rejects(state.service.removeVirtualFolder('Library'), error => error === failure);
  await assert.rejects(fs.stat(state.directory), { code: 'ENOENT' });
  assert.deepEqual(actions(state), ['monitor-stop', 'invalidate', 'options-clear', 'delay', 'monitor-start']);
});

test('virtual-folder stop failure skips finally and validation failure replaces an earlier deletion error', async t => {
  const state = await setup(t), stopFailure = new Error('Controlled monitor failure.');
  state.monitor.stop = async () => { state.calls.push({ action: 'monitor-stop' }); throw stopFailure; };
  await assert.rejects(state.service.removeVirtualFolder('Library'), error => error === stopFailure);
  assert.deepEqual(actions(state), ['monitor-stop']);
  const second = await setup(t), validationFailure = new Error('Controlled root-validation failure.');
  second.service.fileSystem = { ...fs, rm: async () => { throw new Error('Controlled deletion failure.'); } };
  second.lifecycle.validateTopLibraryFolders = async () => { second.calls.push({ action: 'validate' }); throw validationFailure; };
  await assert.rejects(second.service.removeVirtualFolder('Library', true), error => error === validationFailure);
  assert.deepEqual(actions(second), ['monitor-stop', 'options-clear', 'validate']);
});

test('virtual-folder removal rejects missing and unsafe names without stopping the monitor', async t => {
  const state = await setup(t);
  for (const name of [null, '', ' ']) await assert.rejects(state.service.removeVirtualFolder(name), { status: 400 });
  for (const name of ['Missing', '../Library', '..\\Library', '.', '..', 'Library.', 'Library ', 'bad\0name']) await assert.rejects(state.service.removeVirtualFolder(name), { status: 404 });
  assert.deepEqual(actions(state), []); assert.equal((await fs.stat(state.directory)).isDirectory(), true);
});

test('library mutation owner serializes admitted work and close waits for started and queued operations', async t => {
  const state = await setup(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  state.service.fileSystem = { ...fs, writeFile: async (...args) => { if (args[0].endsWith('.mblink')) { entered.resolve(); await release.promise; } return fs.writeFile(...args); } };
  const first = state.service.addMediaPath('Library', { Path: mediaA }); await entered.promise;
  const second = state.service.removeVirtualFolder('Library'); let closed = false;
  const closing = state.service.close().then(() => { closed = true; });
  await assert.rejects(state.service.updateMediaPath('Library', {}), { status: 503 }); assert.equal(closed, false);
  release.resolve(); await Promise.all([first, second, closing]);
  assert.deepEqual(actions(state), ['invalidate', 'options-updated', 'monitor-stop', 'invalidate', 'options-clear', 'delay', 'monitor-start']);
  await assert.rejects(fs.stat(state.directory), { code: 'ENOENT' }); assert.equal(closed, true);
});
