import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { LibraryConfigurationService } from '../../src/library/library-configuration-service.js';
import { LibraryOptionsStore } from '../../src/library/library-options-store.js';
import { LibraryScanLifecycle } from '../../src/library/library-scan-lifecycle.js';
import { scanChildScope } from './scan-child-scope-fixture.js';
import { defaultLibraryOptions, deserializeLibraryOptions } from '../../src/library/options.js';
import { decodeNativeText } from '../../src/core/native-text.js';
import { getNewItemId } from '../../src/core/identity.js';
import { ordinalIgnoreCaseKey } from '../../src/storage/ordinal-comparer.js';
import { validationExecutable, validationOutputRoot } from '../../tools/validation/paths.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';

const fixture = new URL('./fixtures/library-configuration-mutations/', import.meta.url), type = 'MediaBrowser.Controller.Entities.CollectionFolder';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async name => JSON.parse(await fs.readFile(new URL(name, fixture)));
const normalize = (value, state) => typeof value === 'string' ? (() => {
  const text = value.replaceAll(state, '{state}'); return /^(?:\{state\}|%AppDataPath%|%MetadataPath%)/u.test(text) ? text.replaceAll('\\', '/') : text;
})()
  : Array.isArray(value) ? value.map(entry => normalize(entry, state))
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry, state)])) : value;
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'library-configuration-mutations-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('library-configuration-mutations-')); await fs.rm(root, { recursive: true, force: true }); });
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

async function holdFile(filename, mode, proof) {
  assert.equal(hash(await fs.readFile(proof.oracleAssembly.filename)), proof.oracleAssembly.sha256);
  const dotnet = validationExecutable('dotnet');
  assert.equal(hash(await fs.readFile(dotnet)), proof.dotnet.sha256);
  for (const entry of proof.helperInputs) assert.equal(hash(await fs.readFile(entry.filename)), entry.sha256);
  const child = spawn(validationExecutable('dotnet'), [proof.oracleAssembly.filename, 'hold-file', filename, mode], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  const completed = once(child, 'close');
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  try {
    await Promise.race([
      (async () => { while (!stdout.includes('READY\n') && !stdout.includes('READY\r\n')) await once(child.stdout, 'data'); })(),
      completed.then(([code]) => { throw new Error(`Held-file helper ended before READY: ${code}; ${stderr}`); }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Held-file helper readiness timed out.')), 10000); timer.unref(); }),
    ]);
  } catch (error) { child.stdin.end('\n'); child.kill(); await completed; throw error; }
  return async () => {
    child.stdin.end('\n'); const [exitCode, signal] = await completed;
    assert.equal(exitCode, 0, stderr); assert.equal(signal, null);
    const loadedAssemblies = JSON.parse(stderr.trim());
    for (const entry of loadedAssemblies) {
      const pinned = proof.helperInputs.find(input => input.filename.toLowerCase() === entry.filename.toLowerCase());
      assert.ok(pinned, `Unbound held-file helper assembly: ${entry.filename}`); assert.equal(entry.sha256, pinned.sha256);
    }
    for (const entry of proof.helperInputs) assert.equal(hash(await fs.readFile(entry.filename)), entry.sha256);
    return { pid: child.pid, filename, mode, stdout, stderr, exitCode, signal,
      loadedAssemblies, executableSha256: proof.dotnet.sha256, assemblySha256: proof.oracleAssembly.sha256 };
  };
}

test('virtual library mutation fixture binds the designated native manager, state files and neutral input', async () => {
  const proof = await read('provenance.json'), native = await read('native.json');
  assert.equal(hash(await fs.readFile(new URL('input.json', fixture))), proof.inputSha256);
  assert.equal(hash(await fs.readFile(new URL('native.json', fixture))), proof.nativeSha256);
  assert.equal(native.actualLibraryManager, true); assert.equal(native.realFiles, true); assert.equal(native.structuralRootsControlled, true);
  for (const entry of proof.oracleSources) assert.equal(hash(await fs.readFile(entry.name === 'Directory.Build.props'
    ? new URL('../Directory.Build.props', import.meta.url) : new URL(entry.name, fixture))), entry.sha256);
});

test('native virtual library mutations preserve path synchronization, ordinal removal, cache and finally order', async t => {
  const input = await read('input.json'), native = await read('native.json'), proof = await read('provenance.json');
  for (const sample of input) await t.test(sample.key, async t => {
    const state = await temporary(t), program = path.join(state, 'program'), data = path.join(program, 'data'),
      metadata = path.join(program, 'metadata'), views = path.join(program, 'root', 'default'), media = path.join(state, 'media');
    const map = value => value.replaceAll('{views}', views).replaceAll('{media}', media).replaceAll('{data}', data).replaceAll('{metadata}', metadata).replaceAll('\\', path.sep);
    await fs.mkdir(views, { recursive: true }); await fs.mkdir(media); await fs.mkdir(data);
    for (const value of sample.directories) await fs.mkdir(map(value), { recursive: true });
    for (const [filename, bytes] of Object.entries(sample.files ?? {})) await fs.writeFile(map(filename), map(bytes));
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
    const options = { ...defaultLibraryOptions(), ...structuredClone(sample.options ?? {}) };
    if (options.PathInfos != null) for (const info of options.PathInfos) if (info?.Path != null) info.Path = map(info.Path);
    const target = sample.name == null ? null : path.join(views, sample.name);
    const targetExists = async () => target != null && await fs.stat(target).then(value => value.isDirectory()).catch(error => {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error;
    });
    if (await targetExists()) {
      await optionsStore.save(target, options);
      if (Object.hasOwn(sample, 'livePathInfos')) options.PathInfos = structuredClone(sample.livePathInfos);
      if (options.PathInfos != null) for (const info of options.PathInfos) if (info?.Path != null) info.Path = map(info.Path);
      if (sample.optionsDirectory) { await fs.unlink(path.join(target, 'options.xml')); await fs.mkdir(path.join(target, 'options.xml')); }
      if (sample.deleteOnlyLocked) for (const filename of await fs.readdir(target)) if (filename !== 'locked.bin') await fs.unlink(path.join(target, filename));
    }
    const before = await targetExists() ? await optionsStore.get(target) : null;
    calls.length = 0;
    optionsStore.on('updated', event => { trace('options-updated', { path: event.LibraryPath, options: event.LibraryOptions });
      if (sample.failure === 'options-updated') throw new Error('Controlled options observer failure.'); });
    const aggregate = { Name: 'aggregate', Type: 'AggregateFolder', IsFolder: true }, userRoot = { Name: 'user-root', Type: 'UserRootFolder', IsFolder: true };
    let children = [];
    const rebuild = async () => { children = (await fs.readdir(views, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => {
      const location = path.join(views, entry.name); return { Path: location, Name: entry.name, Type: 'CollectionFolder', IsFolder: true,
        Id: getNewItemId(location, type, { programDataPath: program, enableCaseSensitiveItemIds: true }) };
    }); };
    await rebuild();
    const host = { capabilities: {}, getAggregateFolder: () => aggregate, getUserRootFolder: () => userRoot,
      clearIgnoreRuleCache() {}, invalidateChildren() {}, getChildren: () => children,
      async withCachedChildren(_root, operation) {
        const captured = [...children];
        return operation({ firstByPath: async directory => captured.find(child => typeof child.Path === 'string'
          && ordinalIgnoreCaseKey(child.Path) === ordinalIgnoreCaseKey(directory)) ?? null });
      },
      collectionDirectoryExists: () => true, deleteCollections() {}, updateInheritedValues() {},
      refreshMetadata: async item => { trace('refresh', item.Name); if (sample.failure === 'refresh-aggregate' && item === aggregate) throw new Error('Controlled metadata failure.'); },
      validateChildren: async item => { const action = item === aggregate ? 'validate-aggregate' : 'validate-user-root'; trace(action);
        if (sample.failure === action) throw new Error('Controlled root validation failure.'); if (item === userRoot) await rebuild(); } };
    const monitor = { stop: async () => { trace('monitor-stop'); if (sample.failure === 'monitor-stop') throw new Error('Controlled monitor failure.'); },
      start: async () => { trace('monitor-start'); if (sample.failure === 'monitor-start') throw new Error('Controlled monitor failure.'); } };
    host.withChildren = scanChildScope(host);
    const lifecycle = new LibraryScanLifecycle({ host, monitor }); lifecycle.isScanRunning = sample.scanRunning === true;
    let shortcut = 0, resolveFailureActive = sample.failure === 'resolve-shortcut';
    const fileSystem = { ...fs, writeFile: async (filename, bytes, options) => {
      if (filename.endsWith('.mblink')) { trace('shortcut', { path: filename, target: bytes }); if (++shortcut === sample.failShortcut) throw new Error('Controlled shortcut failure.'); }
      return fs.writeFile(filename, bytes, options);
    }, readFile: async (...args) => {
      if (resolveFailureActive && args[0].endsWith('.mblink')) throw new Error('Controlled shortcut read failure.');
      return fs.readFile(...args);
    } };
    const service = new LibraryConfigurationService({ programDataPath: program, optionsStore, configuration, host, lifecycle, monitor, fileSystem,
      mediaAssets: new MetadataImageAssets({fileSystem: testFileSystem,  vfs, identityMap, metadataPath: metadata, stateRoots: [data] }),
      invalidateDirectory: filename => { trace('invalidate', filename);
        if (sample.failure === 'invalidate' || sample.failInvalidate) throw new Error('Controlled invalidation failure.'); },
      queueLibraryScan: () => trace('task-QueueScheduledTask'), sleep: async milliseconds => assert.equal(milliseconds, 1000),
      configurationStore: { updateContentTypes: async transform => { configuration.ContentTypes = transform(structuredClone(configuration.ContentTypes));
        trace('configuration-save', configuration.ContentTypes); if (sample.failure === 'configuration-save') throw new Error('Controlled configuration failure.'); } } });
    t.after(() => service.close());
    const mediaPath = sample.mediaPath == null ? null : structuredClone(sample.mediaPath);
    if (mediaPath?.Path != null) mediaPath.Path = map(mediaPath.Path);
    const release = sample.lockOptions ? await holdFile(path.join(target, 'options.xml'), 'write', proof)
      : sample.lockDelete ? await holdFile(path.join(target, 'locked.bin'), 'delete', proof) : null;
    let heldFile;
    let failure = false;
    try {
      if (sample.operation === 'add') await service.addMediaPath(sample.name, mediaPath);
      else if (sample.operation === 'update') await service.updateMediaPath(sample.name, mediaPath);
      else if (sample.operation === 'removePath') await service.removeMediaPath(sample.name, sample.path == null ? null : map(sample.path));
      else if (sample.operation === 'removeLibrary') await service.removeVirtualFolder(sample.name, sample.refreshLibrary === true);
      else assert.fail('Unknown mutation operation.');
    } catch { failure = true; }
    finally { if (release) heldFile = await release(); }
    resolveFailureActive = false;
    const folders = await service.getVirtualFolders(true), files = await filesUnder(views);
    const original = native.results.find(row => row.key === sample.key), nativeState = path.join(proof.process.args[2], sample.key);
    const after = await targetExists() ? await optionsStore.get(target) : null;
    const cache = { wasPrimed: before != null, sameAfterOperation: before != null && before === after };
    const actual = structuredClone({ failure, calls, folders, files: consumerFiles(files), contentTypes: configuration.ContentTypes, options: after, cache });
    const expected = { failure: original.exception != null, calls: original.calls, folders: original.folders,
      files: consumerFiles(original.files.map(entry => ({ path: entry.path, bytes: Buffer.from(entry.bytes, 'base64') }))), contentTypes: original.contentTypes, options: original.options, cache: original.cache };
    await rebuild(); await optionsStore.clear(); const reopenedFolders = await service.getVirtualFolders(true);
    const output = path.join(validationOutputRoot(), 'library-configuration-mutations-written', sample.key), outputViews = path.join(output, 'program', 'root', 'default'); await fs.mkdir(outputViews, { recursive: true });
    const directories = (await fs.readdir(views, { recursive: true, withFileTypes: true })).filter(entry => entry.isDirectory())
      .map(entry => path.relative(views, path.join(entry.parentPath, entry.name)));
    for (const directory of directories) await fs.mkdir(path.join(outputViews, directory), { recursive: true });
    for (const file of files) { const filename = path.join(outputViews, file.path); await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, file.bytes, { flag: 'wx' }); }
    await fs.writeFile(path.join(output, 'observation.json'), JSON.stringify({ nativeCase: sample.key, failure, sourceFixtureSha256: proof.nativeSha256,
      candidateSourceSha256: hash(await fs.readFile(new URL('../../src/library/library-configuration-service.js', import.meta.url))),
      originalState: state, folders, reopenedFolders, calls, cache, heldFile,
      nativeMutationMatched: isDeepStrictEqual(normalize(actual, state), normalize(expected, nativeState)),
      files: files.map(entry => ({ path: entry.path, sha256: hash(entry.bytes) })), phaseAcceptance: false }, null, 2) + '\n', { flag: 'wx' });
    assert.deepEqual(normalize(actual, state), normalize(expected, nativeState));
    assert.deepEqual(normalize(reopenedFolders, state), normalize(original.reopenedFolders, nativeState));
  });
});
