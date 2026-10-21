import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import path from 'node:path';
import { defaultLibraryOptions, deserializeLibraryOptions, createVirtualPathExpander } from '../../src/library/options.js';
import { LibraryOptionsStore } from '../../src/library/library-options-store.js';
import { decodeNativeText } from '../../src/core/native-text.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';

const fixture = new URL('./fixtures/library-options/', import.meta.url);
const [inputBytes, nativeBytes, proofBytes] = await Promise.all(['input.json', 'native.json', 'provenance.json'].map(name => readFile(new URL(name, fixture))));
const input = JSON.parse(inputBytes), native = JSON.parse(nativeBytes), proof = JSON.parse(proofBytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const normalize = (value, root) => typeof value === 'string' ? (() => {
  const text = value.replaceAll(root + '\\data', '{state}/data').replaceAll(root + '\\metadata', '{state}/metadata')
    .replaceAll(root, '{state}');
  return /^(?:\{state\}|%AppDataPath%|%MetadataPath%)/u.test(text) ? text.replaceAll('\\', '/') : text;
})()
  : Array.isArray(value) ? value.map(entry => normalize(entry, root))
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry, root)])) : value;
function requestOptions(options, mapPath) {
  const result = { ...defaultLibraryOptions(), ...structuredClone(options) };
  if (result.PathInfos) result.PathInfos = result.PathInfos.map(info => info && { Path: '', ...info, ...(info.Path != null && { Path: mapPath(info.Path) }) });
  if (result.TypeOptions) result.TypeOptions = result.TypeOptions.map(type => type && {
    Type: null, MetadataFetchers: [], MetadataFetcherOrder: [], ImageFetchers: [], ImageFetcherOrder: [],
    ImageOptions: [], SimilarItemProviders: [], SimilarItemProviderOrder: [], ...type,
    ...(type.ImageOptions && { ImageOptions: type.ImageOptions.map(image => image && { Type: 'Primary', Limit: 1, MinWidth: 0, ...image }) })
  });
  return result;
}
async function temporary(t) {
  const parent = validationOutputRoot(); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'library-options-store-'));
  t.after(async () => { assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('library-options-store-')); await rm(root, { recursive: true, force: true }); });
  return root;
}

test('library option recordings bind CollectionFolder, native XML, real files and JSON clone defaults', async () => {
  assert.equal(hash(inputBytes), proof.inputSha256); assert.equal(hash(nativeBytes), proof.nativeSha256);
  assert.equal(native.inputSha256, proof.inputSha256);
  for (const key of ['actualCollectionFolder', 'actualXmlSerializer', 'realFiles', 'applicationHostControlled']) assert.equal(native[key], true);
  assert.equal(proof.build.status, 0); assert.equal(proof.process.status, 0);
  assert.deepEqual(native.observations.map(row => row.name), input.map(row => row.name));
  for (const entry of proof.oracleSources) assert.equal(hash(await readFile(entry.name === 'Directory.Build.props'
    ? new URL('../Directory.Build.props', import.meta.url) : new URL(entry.name, fixture))), entry.sha256);
});

test('library option cache, XML, failures and reopen match the actual native store', async t => {
  const root = await temporary(t);
  for (const sample of input) await t.test(sample.name, async () => {
    const state = path.join(root, sample.name), directory = path.join(state, 'root', 'default', 'Library'), filename = path.join(directory, 'options.xml');
    await mkdir(directory, { recursive: true });
    const mapPath = value => value.replaceAll('{data}', path.join(state, 'data')).replaceAll('{metadata}', path.join(state, 'metadata'));
    if (sample.xml) await writeFile(filename, mapPath(sample.xml));
    if (sample.directoryFile) await mkdir(filename);
    if (sample.parentFile) { assert.equal(path.dirname(directory), path.join(state, 'root', 'default')); await rm(directory, { recursive: true }); await writeFile(directory, 'Retained parent file.'); }
    const errors = [], events = [], reverseCalls = [], store = new LibraryOptionsStore({fileSystem: testFileSystem,  programDataPath: state, onError: error => errors.push(error) });
    const before = await store.get(directory), sameCachedBefore = before === await store.get(directory);
    const requested = sample.options ? requestOptions(sample.options, mapPath) : null;
    const reverse = store.reversePath;
    store.reversePath = value => { reverseCalls.push(value); if (sample.reverseFailure) throw new Error('Controlled reverse path failure.'); return reverse(value); };
    store.on('updated', value => {
      events.push({ path: value.LibraryPath, options: structuredClone(value.LibraryOptions), sameRequested: value.LibraryOptions === requested });
      if (sample.eventFailure) throw new Error('Controlled event failure.');
    });
    try {
      if (sample.missingDirectory) { assert.equal(path.dirname(directory), path.join(state, 'root', 'default')); await rm(directory, { recursive: true }); }
      if (sample.readOnly) await chmod(filename, 0o444);
      let failure = null;
      if (requested) try { await store.save(directory, requested); } catch (error) { failure = error; }
      const cached = await store.get(directory), bytes = await readFile(filename).catch(error => { if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes(error.code)) return null; throw error; });
      let disk = null, diskFailure = false;
      if (bytes) try { disk = deserializeLibraryOptions(decodeNativeText(bytes)); } catch { diskFailure = true; }
      await store.clear(); const reopened = await store.get(directory);
      const actual = { before, sameCachedBefore, requested, cached, sameRequested: requested === cached, failure: failure != null,
        reverseCalls, events, disk, diskFailure, reopened };
      const row = native.observations.find(row => row.name === sample.name), nativeRoot = path.win32.join(proof.process.args[2], sample.name);
      const expected = { ...row, failure: row.failure != null, diskFailure: row.diskFailure != null }; delete expected.name; delete expected.xml;
      assert.deepEqual(normalize(actual, state), normalize(expected, nativeRoot));
      if (sample.options) {
        const evidence = path.join(validationOutputRoot(), 'library-options-written', sample.name);
        await mkdir(evidence, { recursive: true });
        if (bytes) await writeFile(path.join(evidence, 'options.xml'), bytes, { flag: 'wx' });
        await writeFile(path.join(evidence, 'observation.json'), JSON.stringify({ nativeCase: sample.name, failed: failure != null,
          fileSha256: bytes && hash(bytes), candidateSourceSha256: hash(await readFile(new URL('../../src/library/library-options-store.js', import.meta.url))),
          sourceFixtureSha256: proof.nativeSha256, phaseAcceptance: false }, null, 2) + '\n', { flag: 'wx' });
      }
    } finally { await store.close(); if (sample.readOnly) await chmod(filename, 0o666); }
  });
});

test('registered library options retain live edits on write failure and reject new work after close', async t => {
  const state = await temporary(t), directory = path.join(state, 'root', 'default', 'Library'); await mkdir(directory, { recursive: true });
  const store = new LibraryOptionsStore({fileSystem: testFileSystem,  programDataPath: state }), id = '967b0000-0000-0000-0000-000000000001';
  t.after(() => store.close()); await store.bind(id, directory);
  const options = { ...defaultLibraryOptions(), AutomaticallyAddToCollection: true };
  await mkdir(path.join(directory, 'options.xml'));
  await assert.rejects(store.save(directory, options));
  assert.equal(store.optionsById.get(id.replaceAll('-', '')), options);
  assert.equal(await store.get(directory), options);
  await store.clear(); assert.equal((await store.get(directory)).AutomaticallyAddToCollection, false);
  await store.close(); await assert.rejects(store.save(directory, options), { status: 503 }); await assert.rejects(store.get(directory), { status: 503 });
});

test('clearing registered options reloads unique directories and defaults unreadable files', async t => {
  const state = await temporary(t), libraryRoot = path.join(state, 'root', 'default');
  const first = path.join(libraryRoot, 'First'), missing = path.join(libraryRoot, 'Missing'),
    invalid = path.join(libraryRoot, 'Invalid'), unsafe = path.join(libraryRoot, 'Unsafe'), external = path.join(state, 'external'),
    danglingTarget = path.join(external, 'missing-target');
  await Promise.all([first, missing, invalid, unsafe, external].map(directory => mkdir(directory, { recursive: true })));
  const initial = name => `<LibraryOptions><SeasonZeroDisplayName>${name}</SeasonZeroDisplayName></LibraryOptions>`;
  await Promise.all([
    writeFile(path.join(first, 'options.xml'), initial('First before clear')),
    writeFile(path.join(missing, 'options.xml'), initial('Missing before clear')),
    writeFile(path.join(invalid, 'options.xml'), initial('Invalid before clear')),
    writeFile(path.join(unsafe, 'options.xml'), initial('Unsafe before clear')),
  ]);
  const errors = [], reportingFailure = new Error('Controlled option error reporter failure.'), optionsById = new Map();
  const store = new LibraryOptionsStore({fileSystem: testFileSystem,  programDataPath: state, optionsById, onError: error => { errors.push(error); throw reportingFailure; } });
  t.after(() => store.close());
  const ids = {
    first: '967b0000-0000-0000-0000-000000000011', alias: '967b0000-0000-0000-0000-000000000012',
    missing: '967b0000-0000-0000-0000-000000000013', invalid: '967b0000-0000-0000-0000-000000000014',
    unsafe: '967b0000-0000-0000-0000-000000000015',
  };
  for (const [id, directory] of [[ids.first, first], [ids.alias, first], [ids.missing, missing], [ids.invalid, invalid], [ids.unsafe, unsafe]]) {
    await store.bind(id, directory);
  }
  const before = Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, optionsById.get(id.replaceAll('-', ''))]));
  await writeFile(path.join(first, 'options.xml'), initial('First after clear'));
  await rm(missing, { recursive: true });
  await writeFile(path.join(invalid, 'options.xml'), '<LibraryOptions><Enabled>invalid</Enabled></LibraryOptions>');
  const unsafeFilename = path.join(unsafe, 'options.xml');
  await rm(unsafeFilename);
  await symlink(danglingTarget, unsafeFilename, process.platform === 'win32' ? 'junction' : 'file');

  await store.clear();

  const firstReloaded = optionsById.get(ids.first.replaceAll('-', ''));
  assert.notEqual(firstReloaded, before.first); assert.equal(firstReloaded.SeasonZeroDisplayName, 'First after clear');
  assert.equal(optionsById.get(ids.alias.replaceAll('-', '')), firstReloaded);
  for (const name of ['missing', 'invalid', 'unsafe']) {
    const current = optionsById.get(ids[name].replaceAll('-', ''));
    assert.notEqual(current, before[name]); assert.equal(current.Enabled, true); assert.equal(current.SeasonZeroDisplayName, 'Specials');
  }
  assert.equal(errors.length, 1);
  assert.equal(errors.some(error => /Boolean/u.test(error.message)), true);
  assert.equal((await store.get(unsafe)).Enabled, true);
  await assert.rejects(readFile(danglingTarget), { code: 'ENOENT' });
});

test('library options read explicitly mapped external paths while storage refuses junction access', async t => {
  const state = await temporary(t), directory = path.join(state, 'root', 'default', 'Library'), external = path.join(state, 'external');
  await mkdir(path.dirname(directory), { recursive: true }); await mkdir(external);
  const bytes = Buffer.from('<LibraryOptions><Enabled>false</Enabled></LibraryOptions>'); await writeFile(path.join(external, 'options.xml'), bytes);
  const store = new LibraryOptionsStore({fileSystem: testFileSystem,  programDataPath: state }); t.after(() => store.close());
  assert.equal((await store.get(external)).Enabled, false);
  await symlink(external, directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await store.get(directory)).Enabled, true);
  await assert.rejects(store.save(directory, defaultLibraryOptions()), error => ['EACCES', 'EPERM'].includes(error.code));
  assert.deepEqual(await readFile(path.join(external, 'options.xml')), bytes);
});

test('foreign library identities require storage mappings and honor read-only mounts', async t => {
  const state = await temporary(t), backend = path.join(state, 'mapped-backend'); await mkdir(backend);
  const registry = new StorageRegistry(), vfs = new VirtualFileSystem(registry), identityMap = new IdentityAccessMap();
  t.after(() => registry.close());
  registry.registerType('mapped-options', configuration => LocalAdapter.open(configuration));
  await registry.createInstance('options', 'mapped-options', { root: backend, writable: true });
  const capabilities = { create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true };
  vfs.mount({ path: '/windows', instanceId: 'options', root: '/', capabilities });
  vfs.mount({ path: '/posix', instanceId: 'options', root: '/', capabilities });
  vfs.mount({ path: '/readonly', instanceId: 'options', root: '/', capabilities: {} });
  const windows = 'R:\\ForeignLibraries\\Movies', posix = '/foreign-libraries/Movies', readonly = 'S:\\ReadonlyLibrary';
  for (const [identityRoot, accessRoot, style] of [[windows, '/windows', 'windows'], [posix, '/posix', 'posix'], [readonly, '/readonly', 'windows']]) {
    identityMap.addPrefix({ identityRoot, accessRoot, style, caseSensitive: style === 'posix', returnAccess: 'Isolated library options mount.' });
  }
  const fileSystem = new StorageFileSystem({ vfs, identityMap });
  const store = new LibraryOptionsStore({ fileSystem, programDataPath: state }); t.after(() => store.close());
  await writeFile(path.join(backend, 'options.xml'), '<LibraryOptions><Enabled>false</Enabled></LibraryOptions>');
  assert.equal((await store.get(windows)).Enabled, false); assert.equal((await store.get(posix)).Enabled, false);
  await assert.rejects(store.get('T:\\UnmappedLibrary'), { code: 'unmapped-path' });
  const changed = { ...defaultLibraryOptions(), SeasonZeroDisplayName: 'Mapped specials' };
  await store.save(windows, changed); await store.clear();
  assert.equal((await store.get(posix)).SeasonZeroDisplayName, changed.SeasonZeroDisplayName);
  assert.equal((await store.get(readonly)).SeasonZeroDisplayName, changed.SeasonZeroDisplayName);
  const before = await readFile(path.join(backend, 'options.xml'));
  await assert.rejects(store.save(readonly, defaultLibraryOptions()), { code: 'ENOTSUP' });
  assert.deepEqual(await readFile(path.join(backend, 'options.xml')), before);
});

test('native library options decode UTF-16 and UTF-8 configuration bytes before typed XML parsing', async t => {
  const state = await temporary(t), directory = path.join(state, 'root', 'default', 'Library'); await mkdir(directory, { recursive: true });
  const store = new LibraryOptionsStore({fileSystem: testFileSystem,  programDataPath: state }); t.after(() => store.close());
  const text = '<LibraryOptions><SeasonZeroDisplayName>中文 café</SeasonZeroDisplayName><PathInfos><MediaPathInfo><Path>%AppDataPath%\\collections</Path></MediaPathInfo></PathInfos></LibraryOptions>';
  for (const bytes of [Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]), Buffer.from(text)]) {
    await writeFile(path.join(directory, 'options.xml'), bytes); await store.clear();
    const actual = await store.get(directory);
    assert.equal(actual.SeasonZeroDisplayName, '中文 café');
    assert.deepEqual(actual.PathInfos, [{ Path: createVirtualPathExpander({ programDataPath: state })('%AppDataPath%\\collections') }]);
  }
});

test('library options finish admitted writes during shutdown and accept a real long namespace directory', async t => {
  const root = await temporary(t), state = path.toNamespacedPath(path.join(root, ...Array.from({ length: 3 }, (_, index) => `state-${index}-` + 'x'.repeat(75))));
  const directory = path.join(state, 'root', 'default', 'Library'); await mkdir(directory, { recursive: true });
  assert.ok(directory.length > 260);
  const store = new LibraryOptionsStore({fileSystem: testFileSystem,  programDataPath: state });
  const writes = [1, 2, 3].map(value => store.save(directory, { ...defaultLibraryOptions(), AutomaticRefreshIntervalDays: value }));
  const closing = store.close(); await assert.rejects(store.save(directory, defaultLibraryOptions()), { status: 503 });
  await Promise.all(writes); await closing;
  const disk = deserializeLibraryOptions(decodeNativeText(await readFile(path.join(directory, 'options.xml'))));
  assert.equal(disk.AutomaticRefreshIntervalDays, 3);
});
