import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveTvRecordingFolders } from '../../src/library/live-tv-recording-folders.js';
import { liveTvConfigurationReader } from '../../src/core/live-tv-configuration-store.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];

const inputFile = new URL('./fixtures/live-tv-recording-folders/input.json', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const configurationDefaults = () => liveTvConfigurationReader.defaultConfiguration('livetv');
const folderDefaults = () => ({ Name: null, Locations: [], CollectionType: null, LibraryOptions: null, ItemId: null,
  PrimaryImageItemId: null, RefreshProgress: null, RefreshStatus: null });
const normalize = (value, root) => Array.isArray(value) ? value.map(entry => normalize(entry, root))
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry, root)]))
    : typeof value === 'string' ? value.replaceAll(root, '$ROOT') : value;

function controls({ sample, dataPath, configuration, folders, calls, errors, hold = async () => {} }) {
  const trace = (action, value = null) => calls.push({ action, value: structuredClone(value) });
  const binding = { registrations: 0, closed: false };
  const liveTv = {
    getConfiguration: async () => configuration,
    saveConfiguration: async (value, key) => {
      trace('save', { key, configuration: value });
      if (sample.failure === 'save') throw new Error('Controlled save failure.');
    },
    bindSaveObserver(reserve) {
      binding.registrations++;
      return {
        enqueue() {
          if (binding.closed) return Promise.reject(new Error('Controlled observer is closed.'));
          const reservation = reserve();
          reservation.commit(liveTv);
          return reservation.completion;
        },
        close() { binding.closed = true; },
      };
    },
  };
  const libraryConfiguration = {
    admitOperation() { return { ...libraryConfiguration, release() {} }; },
    getVirtualFolders: async () => {
      trace('get-folders');
      if (sample.failure === 'get-folders') throw new Error('Controlled listing failure.');
      return [...folders];
    },
    addVirtualFolder: async (name, type, options, refresh) => {
      trace('add', { name, type, options, refresh });
      await hold();
      if (sample.failure === 'add') throw new Error('Controlled add failure.');
      folders.push({ ...folderDefaults(), Name: name, CollectionType: type, Locations: options.PathInfos.map(info => info.Path) });
    },
    removeVirtualFolder: async (name, refresh) => {
      trace('remove-folder', { name, refresh });
      if (sample.failure === 'remove-folder') throw new Error('Controlled removal failure.');
      for (let index = folders.length - 1; index >= 0; index--) if (folders[index].Name === name) folders.splice(index, 1);
    },
    removeMediaPath: async (name, location) => {
      trace('remove-path', { name, path: location });
      if (sample.failure === 'remove-path') throw new Error('Controlled path removal failure.');
      const folder = folders.find(value => value.Name === name);
      folder.Locations = folder.Locations.filter(value => value !== location);
    },
  };
  const service = new LiveTvRecordingFolders({ liveTv, libraryConfiguration, dataPath,
    mediaAssets: { stat: async identity => ({ kind: (await stat(identity)).isDirectory() ? 'directory' : 'file' }) },
    queueLibraryScan: () => trace('scan'), onError: error => errors.push(error) });
  return { service, liveTv, libraryConfiguration, binding };
}

test('existing recording folder registration matches the actual native manager and failure prefixes', {
  skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 120000,
}, async () => {
  const inputBytes = await readFile(inputFile), samples = JSON.parse(inputBytes);
  const output = path.join(validationOutputRoot(), 'live-tv-recording-folders-' + randomUUID());
  const receipt = await recordOracle({ project: 'tests/library/fixtures/live-tv-recording-folders/Oracle.csproj', output,
    args: [fileURLToPath(inputFile), '{output}/native-cases', '{output}/native.json'] });
  const nativeBytes = await readFile(path.join(output, 'native.json')), native = JSON.parse(nativeBytes);
  assert.equal(receipt.passed, true);
  assert.equal(native.inputSha256, hash(inputBytes));
  assert.equal(receipt.outputs.find(entry => path.basename(entry.filename) === 'native.json').sha256, hash(nativeBytes));
  assert.equal(native.actualRecordingsManager, true);
  assert.equal(native.realDirectoryExistence, true);
  assert.equal(native.controlledConfigurationAndLibraryManager, true);
  assert.equal(native.results.length, samples.length);
  for (const assembly of native.assemblies) assert.match(assembly.sha256, /^[0-9a-f]{64}$/u);
  const comparisons = [];
  for (const sample of samples) {
    const root = path.join(output, 'node-cases', sample.name), dataPath = path.join(root, 'data');
    const map = value => value.replaceAll('{data}', dataPath).replaceAll('/', path.sep);
    await mkdir(dataPath, { recursive: true });
    for (const directory of sample.directories) await mkdir(map(directory), { recursive: true });
    const configuration = { ...configurationDefaults(), ...structuredClone(sample.configuration) };
    for (const field of ['RecordingPath', 'MovieRecordingPath', 'SeriesRecordingPath']) if (configuration[field] != null) configuration[field] = map(configuration[field]);
    if (configuration.MediaLocationsCreated != null) configuration.MediaLocationsCreated = configuration.MediaLocationsCreated.map(value => value == null ? null : map(value));
    const folders = sample.folders.map(folder => ({ ...folderDefaults(), ...structuredClone(folder), Locations: folder.Locations.map(map) }));
    const calls = [], errors = [];
    const { service } = controls({ sample, dataPath, configuration, folders, calls, errors });
    try { await service.reconcile(); } finally { await service.close(); }
    const existing = (await readdir(dataPath, { recursive: true, withFileTypes: true })).filter(entry => entry.isDirectory())
      .map(entry => path.relative(dataPath, path.join(entry.parentPath, entry.name))).sort();
    const expected = native.results.find(value => value.name === sample.name);
    const actual = { calls, configuration, folders, errors: errors.length, existing };
    const target = { calls: expected.calls, configuration: expected.configuration, folders: expected.folders,
      errors: expected.errors, existing: expected.existing };
    comparisons.push({ name: sample.name, root, actual, target });
    assert.deepEqual(normalize(actual, root), normalize(target, expected.root), sample.name);
  }
  await writeFile(path.join(output, 'comparison.json'), JSON.stringify({ passed: true, phaseAcceptance: false,
    nativeSha256: hash(nativeBytes), comparisons }, null, 2) + '\n', { flag: 'wx' });
});

test('recording folder observer drains admitted work and rejects new reconciliation after close', async () => {
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const dataPath = path.resolve('isolated-recording-folder-data');
  const calls = [], errors = [], configuration = { ...configurationDefaults(), MovieRecordingPath: path.join(dataPath, 'movies') };
  const { service, libraryConfiguration, binding } = controls({ sample: {}, dataPath, configuration, folders: [], calls, errors,
    hold: async () => { started.resolve(); await release.promise; } });
  let admitted = 0, released = 0;
  service.admitOperation = () => {
    admitted++;
    return { ...libraryConfiguration.admitOperation(), release() { released++; } };
  };
  // This lifecycle case controls directory access; the native component case
  // above independently compares actual filesystem observations.
  service.mediaAssets = { stat: async identity => ({ kind: identity === configuration.MovieRecordingPath ? 'directory' : 'file' }) };
  service.start(); service.start();
  try {
    assert.equal(binding.registrations, 1);
    await Promise.resolve(); assert.deepEqual(calls, []);
    const pending = service.reconcile();
    assert.equal(admitted, 1, 'The observer captures its library admission before returning to its caller.');
    await started.promise;
    let closed = false;
    const close = service.close().then(() => { closed = true; });
    assert.equal(binding.closed, true);
    await Promise.resolve(); assert.equal(closed, false);
    await service.reconcile();
    release.resolve(); await Promise.all([pending, close]);
    assert.deepEqual(calls.map(value => value.action), ['get-folders', 'add', 'save']);
    assert.deepEqual(configuration.MediaLocationsCreated, [configuration.MovieRecordingPath]);
    assert.deepEqual(errors, []);
    assert.equal(released, 1);
    await service.reconcile(); assert.equal(calls.length, 3);
    assert.equal(admitted, 1);
  } finally { release.resolve(); await service.close(); }
});
