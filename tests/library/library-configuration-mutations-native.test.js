import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { LibraryConfigurationService } from '../../src/library/library-configuration-service.js';
import { LibraryOptionsStore } from '../../src/library/library-options-store.js';
import { LibraryScanLifecycle } from '../../src/library/library-scan-lifecycle.js';
import { scanChildScope } from './scan-child-scope-fixture.js';
import { defaultLibraryOptions } from '../../src/library/options.js';
import { getNewItemId } from '../../src/core/identity.js';
import { ordinalIgnoreCaseKey } from '../../src/storage/ordinal-comparer.js';
import { assertValidationOutputChild } from '../../tools/validation/paths.js';
import { currentLibraryMutations } from './fixtures/library-config-current/capture.js';
import { holdMutationFile } from './fixtures/library-config-current/held-file.js';
import { mutationObservation, mutationAccessExpectation, normalizeMutation, mutationFiles } from './fixtures/library-config-current/observations.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const type = 'MediaBrowser.Controller.Entities.CollectionFolder';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function temporary(key) {
  const current = await currentLibraryMutations();
  const root = assertValidationOutputChild(path.join(current.output, 'candidate', key));
  await fs.mkdir(root, { recursive: true });
  return root;
}
async function filesUnder(root) {
  const entries = [];
  for (const name of await fs.readdir(root, { recursive: true, withFileTypes: true })) if (name.isFile()) {
    const filename = path.join(name.parentPath, name.name); entries.push({ path: path.relative(root, filename), bytes: await fs.readFile(filename) });
  }
  return entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}
test('current virtual library mutation sources retain the complete neutral matrix and independently repeated Native consumers', async () => {
  const current = await currentLibraryMutations();
  assert.equal(current.original.length, 59); assert.equal(current.input.length, 61);
  assert.equal(current.native.actualLibraryManager, true);
  assert.equal(current.native.realFiles, true); assert.equal(current.native.structuralRootsControlled, true);
});

test('native virtual library mutations preserve path synchronization, ordinal removal, cache and finally order', async t => {
  const current = await currentLibraryMutations(), input = current.input, native = current.native;
  const observations = new Map(), states = new Map();
  for (const sample of input) await t.test(sample.key, async t => {
    const state = await temporary(sample.key), program = path.join(state, 'program'), data = path.join(program, 'data'),
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
    const beforeOptions = structuredClone(before), beforeFiles = await filesUnder(views);
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
    const enumerationInputs = Object.keys(sample.files ?? {}).map(filename => path.resolve(map(filename))), enumerationReads = [];
    const ranks = new Map(enumerationInputs.map((filename, index) => [filename, index]));
    const fileSystem = { ...fs, readdir: async (directory, options) => {
      const raw = await fs.readdir(directory, options);
      const filename = entry => path.join(directory, typeof entry === 'string' ? entry : entry.name);
      const ordered = [...raw].sort((left, right) => (ranks.get(filename(left)) ?? Number.MAX_SAFE_INTEGER)
        - (ranks.get(filename(right)) ?? Number.MAX_SAFE_INTEGER));
      enumerationReads.push({ directory, raw: raw.map(filename), ordered: ordered.map(filename) });
      return ordered;
    }, writeFile: async (filename, bytes, options) => {
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
    const heldFile = sample.lockOptions || sample.lockDelete ? {} : null;
    const holder = heldFile ? await holdMutationFile({ record: current.record, receipt: heldFile,
      filename: path.join(target, sample.lockOptions ? 'options.xml' : 'locked.bin'),
      mode: sample.lockOptions ? 'write' : 'delete' }) : null;
    let failure = false, operationError = null;
    try {
      if (sample.operation === 'add') await service.addMediaPath(sample.name, mediaPath);
      else if (sample.operation === 'update') await service.updateMediaPath(sample.name, mediaPath);
      else if (sample.operation === 'removePath') await service.removeMediaPath(sample.name, sample.path == null ? null : map(sample.path));
      else if (sample.operation === 'removeLibrary') await service.removeVirtualFolder(sample.name, sample.refreshLibrary === true);
      else assert.fail('Unknown mutation operation.');
    } catch (error) { failure = true; operationError = { code: error.code, status: error.status, message: error.message, stack: error.stack }; }
    finally { try { await holder?.inspect(); } finally { await holder?.release(); } }
    resolveFailureActive = false;
    const folders = await service.getVirtualFolders(true), files = await filesUnder(views);
    const original = native.results.find(row => row.key === sample.key);
    assert.deepEqual(normalizeMutation(enumerationInputs, state), normalizeMutation(original.enumerationInputs, original.state),
      sample.key + ': both consumers receive the same declared file enumeration input');
    const after = await targetExists() ? await optionsStore.get(target) : null;
    const cache = { wasPrimed: before != null, sameAfterOperation: before != null && before === after };
    const directories = (await fs.readdir(views, { recursive: true, withFileTypes: true })).filter(entry => entry.isDirectory())
      .map(entry => path.relative(views, path.join(entry.parentPath, entry.name))).sort();
    const actual = structuredClone({ state, views, key: sample.key, operationFailed: failure, calls, folders,
      files, directories, beforeFiles, contentTypes: configuration.ContentTypes, options: after, cache, beforeOptions });
    actual.files = files; actual.beforeFiles = beforeFiles;
    await rebuild(); await optionsStore.clear();
    actual.reopenedFolders = await service.getVirtualFolders(true);
    actual.coldOptions = await targetExists() ? structuredClone(await optionsStore.get(target)) : null;
    const control = heldFile ? native.results.find(row => row.key === sample.key + '-accessible-control') : null;
    const expected = heldFile ? mutationAccessExpectation(control, sample, heldFile.admission, native.defaultLibraryOptions)
      : mutationObservation(original);
    observations.set(sample.key, actual); states.set(sample.key, state);
    await fs.writeFile(path.join(state, 'observation.json'), JSON.stringify({
      nativeCase: sample.key, identity: 'same-workflow-current-native-library-mutations',
      nativeInputSha256: native.inputSha256,
      candidateSourceSha256: hash(await fs.readFile(new URL('../../src/library/library-configuration-service.js', import.meta.url))),
      actual: { ...actual, files: files.map(entry => ({ path: entry.path, bytes: entry.bytes.toString('base64') })),
        beforeFiles: beforeFiles.map(entry => ({ path: entry.path, bytes: entry.bytes.toString('base64') })) },
      heldFile, operationError, enumerationInputs, enumerationReads, comparison: mutationObservation(actual), expected,
      nativeMutationMatched: isDeepStrictEqual(mutationObservation(actual), expected),
      historicalRecordingReused: false, phaseAcceptance: false, releaseAcceptance: false,
    }, null, 2) + '\n', { flag: 'wx' });
    assert.deepEqual(mutationObservation(actual), expected);
    if (heldFile?.admission.read.succeeded) assert.equal(hash(Buffer.from(heldFile.admission.read.bytes, 'base64')), heldFile.beforeSha256);
    if (heldFile && !heldFile.admission.operation.succeeded)
      assert.equal(heldFile.afterFile.sha256, heldFile.beforeSha256, sample.key + ': refused operation retains the exact original bytes');

    // Node cold-reads each independent Native file through its actual store.
    for (const source of [original, current.repeat.results.find(row => row.key === sample.key)]) {
      const sourceProgram = path.join(source.state, 'program');
      const reader = new LibraryOptionsStore({ fileSystem: testFileSystem, programDataPath: sourceProgram,
        dataPath: path.join(sourceProgram, 'data'), metadataPath: path.join(sourceProgram, 'metadata') });
      try {
        const sourceTarget = sample.name == null ? null : path.join(source.views, sample.name);
        const exists = sourceTarget != null && await fs.stat(sourceTarget).then(info => info.isDirectory()).catch(error => {
          if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error;
        });
        const cold = exists ? await reader.get(sourceTarget) : null;
        assert.deepEqual(cold, source.coldOptions, sample.key + ': Node reads Native-written options');
        for (const file of source.files) assert.deepEqual(await fs.readFile(path.join(source.views, file.path)), Buffer.from(file.bytes, 'base64'));
      } finally { await reader.close(); }
    }
  });
  assert.equal(states.size, input.length);
  const consumed = await current.consume(states);
  for (const row of consumed.results) {
    const candidate = observations.get(row.key), state = states.get(row.key);
    assert.deepEqual(normalizeMutation(row.reopenedFolders, row.state), normalizeMutation(candidate.reopenedFolders, state), row.key + ': Native reads Node-written folders');
    assert.deepEqual(row.coldOptions, candidate.coldOptions, row.key + ': Native reads Node-written options');
    assert.deepEqual(mutationFiles(row.files), mutationFiles(candidate.files), row.key + ': Native consumer preserves every file');
    assert.deepEqual(await filesUnder(path.join(state, 'program', 'root', 'default')), candidate.files, row.key + ': cold consumption is read-only');
  }
});
