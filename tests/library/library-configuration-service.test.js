import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { LibraryConfigurationService } from '../../src/library/library-configuration-service.js';
import { LibraryOptionsStore } from '../../src/library/library-options-store.js';
import { LibraryScanLifecycle } from '../../src/library/library-scan-lifecycle.js';
import { scanChildScope } from './scan-child-scope-fixture.js';
import { defaultLibraryOptions, deserializeLibraryOptions } from '../../src/library/options.js';
import { decodeNativeText } from '../../src/core/native-text.js';
import { getNewItemId } from '../../src/core/identity.js';
import { ordinalIgnoreCaseKey } from '../../src/storage/ordinal-comparer.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';

const fixture = new URL('./fixtures/library-configuration/', import.meta.url), type = 'MediaBrowser.Controller.Entities.CollectionFolder';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async name => JSON.parse(await fs.readFile(new URL(name, fixture)));
const normalize = (value, state) => typeof value === 'string' ? (() => {
  const text = value.replaceAll(state, '{state}'); return /^(?:\{state\}|%AppDataPath%|%MetadataPath%)/u.test(text) ? text.replaceAll('\\', '/') : text;
})()
  : Array.isArray(value) ? value.map(entry => normalize(entry, state))
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry, state)])) : value;
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'library-configuration-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('library-configuration-')); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}
async function filesUnder(root) {
  const entries = [];
  for (const name of await fs.readdir(root, { recursive: true, withFileTypes: true })) if (name.isFile()) {
    const filename = path.join(name.parentPath, name.name); entries.push({ path: path.relative(root, filename), bytes: await fs.readFile(filename) });
  }
  return entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}
function consumerFiles(files) {
  return files.map(entry => ({ path: entry.path.replaceAll('\\', '/'), content: entry.path.endsWith('options.xml')
    ? deserializeLibraryOptions(decodeNativeText(entry.bytes)) : decodeNativeText(entry.bytes) }));
}

test('virtual library fixture binds the designated native manager, state files and neutral input', async () => {
  const proof = await read('provenance.json'), native = await read('native.json');
  assert.equal(hash(await fs.readFile(new URL('input.json', fixture))), proof.inputSha256);
  assert.equal(hash(await fs.readFile(new URL('native.json', fixture))), proof.nativeSha256);
  assert.equal(native.actualLibraryManager, true); assert.equal(native.realFiles, true); assert.equal(native.structuralRootsControlled, true);
  for (const entry of proof.oracleSources) assert.equal(hash(await fs.readFile(entry.name === 'Directory.Build.props'
    ? new URL('../Directory.Build.props', import.meta.url) : new URL(entry.name, fixture))), entry.sha256);
});

test('native virtual library creation retains naming, option/shortcut prefixes, finally and background scan order', async t => {
  const input = await read('input.json'), native = await read('native.json'), proof = await read('provenance.json');
  for (const sample of input) await t.test(sample.key, async t => {
    const state = await temporary(t), program = path.join(state, 'program'), data = path.join(program, 'data'),
      metadata = path.join(program, 'metadata'), views = path.join(program, 'root', 'default'), media = path.join(state, 'media');
    const map = value => value.replaceAll('{views}', views).replaceAll('{media}', media).replaceAll('{data}', data).replaceAll('{metadata}', metadata).replaceAll('\\', path.sep);
    await fs.mkdir(views, { recursive: true }); await fs.mkdir(media); await fs.mkdir(data);
    for (const value of sample.directories) await fs.mkdir(map(value), { recursive: true });
    for (const [filename, bytes] of Object.entries(sample.files ?? {})) await fs.writeFile(map(filename), bytes);
    const registry = new StorageRegistry(); registry.registerType('memory', options => new MemoryStorageAdapter(options));
    const adapter = await registry.createInstance('media', 'memory', {});
    t.after(() => registry.close());
    for (const value of sample.directories.filter(value => value.startsWith('{media}'))) {
      const parts = value.slice('{media}'.length).replaceAll('\\', '/').split('/').filter(Boolean); let current = '';
      for (const part of parts) { current += '/' + part; try { await adapter.mkdir(current); } catch (error) { if (error.code !== 'already-exists') throw error; } }
    }
    const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/remote', instanceId: 'media', capabilities: {} });
    const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: media, accessRoot: '/remote', style: process.platform === 'win32' ? 'windows' : 'posix', returnAccess: 'native oracle fixture' });
    const calls = [], trace = (action, value = null) => calls.push({ action, value: structuredClone(value) });
    const configuration = { ContentTypes: sample.contentTypes === null ? null : (sample.contentTypes ?? []).map(entry => entry == null ? null : ({ ...entry, Name: entry.Name == null ? null : map(entry.Name) })) };
    const optionsStore = new LibraryOptionsStore({fileSystem: testFileSystem,  programDataPath: program, dataPath: data, metadataPath: metadata });
    t.after(() => optionsStore.close()); const reverse = optionsStore.reversePath;
    optionsStore.reversePath = value => { trace('reverse-path', value); return reverse(value); };
    optionsStore.on('updated', event => { trace('options-updated', { path: event.LibraryPath, options: event.LibraryOptions });
      if (sample.failure === 'options-updated') throw new Error('Controlled options observer failure.'); });
    const options = { ...defaultLibraryOptions(), ...structuredClone(sample.options ?? {}) };
    if (options.PathInfos != null) for (const info of options.PathInfos) if (info?.Path != null) info.Path = map(info.Path);
    const aggregate = { Name: 'aggregate', Type: 'AggregateFolder', IsFolder: true }, userRoot = { Name: 'user-root', Type: 'UserRootFolder', IsFolder: true };
    let children = [];
    const rebuild = async () => { children = (await fs.readdir(views, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => {
      const location = path.join(views, entry.name); return { Path: location, Name: entry.name, Type: 'CollectionFolder', IsFolder: true,
        Id: getNewItemId(location, type, { programDataPath: program, enableCaseSensitiveItemIds: true }) };
    }); };
    await rebuild();
    const host = { capabilities: {}, getAggregateFolder: () => aggregate, getUserRootFolder: () => userRoot,
      clearIgnoreRuleCache() {}, invalidateChildren() {}, getChildren: () => children,
      withCachedChildren: async (_root, operation) => operation({ firstByPath: async directory =>
        children.find(child => typeof child.Path === 'string' && ordinalIgnoreCaseKey(child.Path) === ordinalIgnoreCaseKey(directory)) ?? null }),
      collectionDirectoryExists: () => true, deleteCollections() {}, updateInheritedValues() {},
      refreshMetadata: async item => { trace('refresh', item.Name); if (sample.failure === 'refresh-aggregate' && item === aggregate) throw new Error('Controlled metadata failure.'); },
      validateChildren: async item => { const action = item === aggregate ? 'validate-aggregate' : 'validate-user-root'; trace(action);
        if (sample.failure === action) throw new Error('Controlled root validation failure.'); if (item === userRoot) await rebuild(); } };
    const monitor = { stop: async () => { trace('monitor-stop'); if (sample.failure === 'monitor-stop') throw new Error('Controlled monitor failure.'); },
      start: async () => { trace('monitor-start'); if (sample.failure === 'monitor-start') throw new Error('Controlled monitor failure.'); } };
    host.withChildren = scanChildScope(host);
    const lifecycle = new LibraryScanLifecycle({ host, monitor }); lifecycle.isScanRunning = sample.scanRunning === true;
    let shortcut = 0;
    const fileSystem = { ...fs, writeFile: async (filename, bytes, options) => {
      if (filename.endsWith('.mblink')) { trace('shortcut', { path: filename, target: bytes }); if (++shortcut === sample.failShortcut) throw new Error('Controlled shortcut failure.'); }
      return fs.writeFile(filename, bytes, options);
    } };
    const service = new LibraryConfigurationService({ programDataPath: program, optionsStore, configuration, host, lifecycle, monitor, fileSystem,
      mediaAssets: new MetadataImageAssets({fileSystem: testFileSystem,  vfs, identityMap, metadataPath: metadata, stateRoots: [data] }),
      invalidateDirectory: filename => trace('invalidate', filename), queueLibraryScan: () => trace('task-QueueScheduledTask'), sleep: async milliseconds => assert.equal(milliseconds, 1000),
      configurationStore: { updateContentTypes: async transform => { configuration.ContentTypes = transform(structuredClone(configuration.ContentTypes));
        trace('configuration-save', configuration.ContentTypes); if (sample.failure === 'configuration-save') throw new Error('Controlled configuration failure.'); } } });
    t.after(() => service.close());
    let failure = false; try { await service.addVirtualFolder(sample.name, sample.collectionType, options, sample.refreshLibrary === true); } catch { failure = true; }
    const folders = await service.getVirtualFolders(true), files = await filesUnder(views);
    const original = native.results.find(row => row.key === sample.key), nativeState = path.join(proof.process.args[2], sample.key);
    const actual = { failure, calls, folders, files: consumerFiles(files), contentTypes: configuration.ContentTypes, options };
    const expected = { failure: original.exception != null, calls: original.calls, folders: original.folders,
      files: consumerFiles(original.files.map(entry => ({ path: entry.path, bytes: Buffer.from(entry.bytes, 'base64') }))), contentTypes: original.contentTypes, options: original.options };
    await rebuild(); await optionsStore.clear(); const reopenedFolders = await service.getVirtualFolders(true);
    const output = path.join(validationOutputRoot(), 'library-configuration-written', sample.key), outputViews = path.join(output, 'program', 'root', 'default'); await fs.mkdir(outputViews, { recursive: true });
    for (const folder of folders) await fs.mkdir(path.join(outputViews, folder.Name), { recursive: true });
    for (const file of files) { const filename = path.join(outputViews, file.path); await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, file.bytes, { flag: 'wx' }); }
    await fs.writeFile(path.join(output, 'observation.json'), JSON.stringify({ nativeCase: sample.key, failure, sourceFixtureSha256: proof.nativeSha256,
      candidateSourceSha256: hash(await fs.readFile(new URL('../../src/library/library-configuration-service.js', import.meta.url))),
      originalState: state, folders, reopenedFolders, calls, nativeCreationMatched: isDeepStrictEqual(normalize(actual, state), normalize(expected, nativeState)),
      files: files.map(entry => ({ path: entry.path, sha256: hash(entry.bytes) })), phaseAcceptance: false }, null, 2) + '\n', { flag: 'wx' });
    if (['trailing-dot-name', 'trailing-space-after-sanitization', 'all-invalid-name'].includes(sample.key)) {
      assert.equal(failure, true); assert.deepEqual(calls, []); assert.deepEqual(folders, []); assert.deepEqual(files, []);
      assert.deepEqual(configuration.ContentTypes, []);
    } else assert.deepEqual(normalize(actual, state), normalize(expected, nativeState));
  });
});

async function stateOnlyService(t) {
  const root = await temporary(t), views = path.join(root, 'root', 'default'), data = path.join(root, 'data');
  await fs.mkdir(views, { recursive: true }); await fs.mkdir(data);
  const optionsStore = new LibraryOptionsStore({fileSystem: testFileSystem,  programDataPath: root }); t.after(() => optionsStore.close());
  const host = { getUserRootFolder: () => ({}), withCachedChildren: async (_root, operation) => operation({ firstByPath: async () => null }) };
  const service = new LibraryConfigurationService({fileSystem: testFileSystem,  programDataPath: root, optionsStore, host,
    mediaAssets: new MetadataImageAssets({fileSystem: testFileSystem,  stateRoots: [data] }),
    lifecycle: { isScanRunning: false, validateTopLibraryFolders: async () => {} }, monitor: { stop: async () => {}, start: async () => {} },
    queueLibraryScan() {}, sleep: async () => {} });
  t.after(() => service.close()); return { root, views, optionsStore, service, host };
}

test('library configuration refuses local media and external junctions before modifying instance files', async t => {
  const { root, views, service } = await stateOnlyService(t), outside = path.join(root, 'host-media'); await fs.mkdir(outside);
  const stats = []; service.fileSystem = { ...fs, stat: async filename => { stats.push(filename); return fs.stat(filename); } };
  await assert.rejects(service.addVirtualFolder('Local', 'movies', { ...defaultLibraryOptions(), PathInfos: [{ Path: outside }] }), { status: 400 });
  assert.ok(!stats.includes(outside)); assert.deepEqual(await fs.readdir(views), []);
  await fs.symlink(outside, path.join(views, 'External'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(service.getVirtualFolders(), { status: 501 }); assert.deepEqual(await fs.readdir(outside), []);
});

test('library configuration lists declared Windows/POSIX root identities and nullable refresh fields without rewriting paths', async t => {
  const { root, views, service, host } = await stateOnlyService(t), folder = path.join(views, 'Library'); await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'windows.mblink'), 'Z:\\'); await fs.writeFile(path.join(folder, 'posix.mblink'), '/');
  const id = getNewItemId(folder, type, { programDataPath: root });
  host.withCachedChildren = async (_root, operation) => operation({ firstByPath: async () => ({ Id: id, Path: folder, ImageInfos: [{ Type: 'Primary' }] }) });
  const listed = (await service.getVirtualFolders())[0]; assert.deepEqual(new Set(listed.Locations), new Set(['Z:\\', '/']));
  assert.equal(listed.ItemId, id); assert.equal(listed.PrimaryImageItemId, id); assert.equal(listed.RefreshStatus, null); assert.equal(listed.RefreshProgress, null);
  service.refreshQueue = () => new Set([id]); assert.equal((await service.getVirtualFolders(true))[0].RefreshStatus, 'Queued');
  service.refreshes = { getRefreshProgress: () => 41.5 }; const active = (await service.getVirtualFolders(true))[0]; assert.equal(active.RefreshStatus, 'Active'); assert.equal(active.RefreshProgress, 41.5);
});
