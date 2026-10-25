import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { LiveTvService } from '../../src/library/live-tv-service.js';
import { liveTvConfigurationReader } from '../../src/core/live-tv-configuration-store.js';
import { LiveTvRecordingFolders } from '../../src/library/live-tv-recording-folders.js';
import { LibraryConfigurationService } from '../../src/library/library-configuration-service.js';
import { LibraryOptionsStore } from '../../src/library/library-options-store.js';
import { MetadataRefreshHost } from '../../src/metadata/refresh-host.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { testFileSystem } from '../storage/plugin-files.js';

async function fixture(t, { failWrite = false } = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mm-live-tv-close-'));
  const programDataPath = path.join(root, 'program'), dataPath = path.join(programDataPath, 'data');
  const configurationDirectoryPath = path.join(root, 'config'), moviePath = path.join(dataPath, 'movies');
  await fs.mkdir(moviePath, { recursive: true });
  await fs.mkdir(configurationDirectoryPath);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const permits = { acquired: 0, released: 0, runs: 0 }, errors = [], events = [], files = { opened: 0, closed: 0 };
  const writeFailure = Object.assign(new Error('Controlled admitted configuration write failure.'), { code: 'EIO' });
  const metadata = new MetadataRefreshHost({ registry: {}, store: {}, loadContext: async () => {},
    images: {}, updates: {}, externalData: {}, seriesLifecycle: {} });
  const optionsStore = new LibraryOptionsStore({ fileSystem: testFileSystem, programDataPath, dataPath });
  let folderReads = 0, validations = 0, scans = 0;
  const libraryConfiguration = new LibraryConfigurationService({ programDataPath, dataPath, fileSystem: fs, optionsStore,
    host: { getUserRootFolder: async () => { folderReads++; return {}; },
      withCachedChildren: async (_root, operation) => operation({ firstByPath: async () => null }) },
    mediaAssets: new MetadataImageAssets({ fileSystem: testFileSystem, stateRoots: [dataPath] }),
    lifecycle: { isScanRunning: false, validateTopLibraryFolders: async () => { validations++; } },
    monitor: { stop: async () => {}, start: async () => {} },
    queueLibraryScan: () => { scans++; }, sleep: async () => {},
    admitMetadataDrain: () => {
      const admission = metadata.admitShutdownDrain(); permits.acquired++;
      return { run: operation => admission.run(() => { permits.runs++; return operation(); }),
        release() { permits.released++; admission.release(); } };
    }, onError: error => errors.push(error),
  });
  await libraryConfiguration.initialize();
  permits.acquired = 0; permits.released = 0; permits.runs = 0;
  const liveTv = new LiveTvService({ configurationDirectoryPath, onError: error => errors.push(error),
    fileSystem: { ...fs, async open(...args) {
      const handle = await fs.open(...args), first = ++files.opened === 1;
      return { async close() { try { await handle.close(); } finally { files.closed++; } },
        async writeFile(bytes) {
          if (first) {
            entered.resolve(); await release.promise;
            if (failWrite) { await handle.writeFile(bytes.subarray(0, 40)); throw writeFailure; }
          }
          await handle.writeFile(bytes);
        } };
    } },
  });
  liveTv.on('updating', () => events.push('updating'));
  liveTv.on('updated', () => events.push('updated'));
  const recordingFolders = new LiveTvRecordingFolders({ liveTv, libraryConfiguration,
    mediaAssets: libraryConfiguration.mediaAssets, dataPath,
    queueLibraryScan: () => { scans++; }, onError: error => errors.push(error) });
  recordingFolders.start();
  t.after(async () => {
    release.resolve();
    await Promise.all([liveTv.close(), recordingFolders.close(), libraryConfiguration.close(), metadata.close()]);
    await optionsStore.close();
    assert.equal(files.closed, files.opened);
    assert.equal(permits.released, permits.acquired);
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('mm-live-tv-close-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { liveTv, metadata, libraryConfiguration, recordingFolders, optionsStore, entered, release,
    configuration: { ...liveTvConfigurationReader.defaultConfiguration('livetv'), GuideDays: 6, MovieRecordingPath: moviePath },
    filename: path.join(configurationDirectoryPath, 'livetv.xml'), root: libraryConfiguration.root,
    moviePath, permits, errors, events, files, writeFailure,
    observations: () => ({ folderReads, validations, scans }) };
}

for (const failWrite of [false, true]) test(`an admitted Live TV ${failWrite ? 'failed' : 'successful'} save drains its reserved library work during close`, {
  timeout: 15000,
}, async t => {
  const state = await fixture(t, { failWrite });
  const { liveTv, recordingFolders, libraryConfiguration, metadata } = state;
  const saved = liveTv.saveConfiguration(state.configuration);
  const saveOutcome = Promise.allSettled([saved]);
  assert.equal(state.permits.acquired, 1, 'Saving must reserve the real library/metadata permit before returning.');
  await state.entered.promise;
  assert.deepEqual(state.observations(), { folderReads: 0, validations: 0, scans: 0 });
  const closing = liveTv.close(), repeatedClosing = liveTv.close();
  metadata.cancel();
  const recordingClose = recordingFolders.close(), libraryClose = libraryConfiguration.close(), metadataClose = metadata.close();
  const finished = { liveTv: false, repeatedLiveTv: false, recording: false, library: false, metadata: false };
  closing.then(() => { finished.liveTv = true; });
  repeatedClosing.then(() => { finished.repeatedLiveTv = true; });
  recordingClose.then(() => { finished.recording = true; });
  libraryClose.then(() => { finished.library = true; });
  metadataClose.then(() => { finished.metadata = true; });
  try {
    await assert.rejects(liveTv.saveConfiguration(state.configuration), { status: 503 });
    await assert.rejects(liveTv.getConfiguration(), { status: 503 });
    await assert.rejects(libraryConfiguration.getVirtualFolders(), { status: 503 });
    assert.throws(() => metadata.admitShutdownDrain(), { name: 'AbortError' });
    await recordingFolders.reconcile();
    assert.deepEqual(finished, { liveTv: false, repeatedLiveTv: false, recording: false, library: false, metadata: false });
    assert.equal(state.permits.released, 0);
  } finally { state.release.resolve(); }
  const [outcome] = await saveOutcome;
  await Promise.all([closing, repeatedClosing, recordingClose, libraryClose, metadataClose]);
  assert.deepEqual(finished, { liveTv: true, repeatedLiveTv: true, recording: true, library: true, metadata: true });
  assert.deepEqual(state.errors, []);
  assert.equal(state.permits.acquired, 1, 'Recursive observer saves must reuse the existing library/metadata admission.');
  assert.equal(state.permits.released, 1);
  assert.equal(state.files.closed, state.files.opened);
  if (failWrite) {
    assert.equal(outcome.status, 'rejected');
    assert.equal(outcome.reason.code, state.writeFailure.code); assert.equal(outcome.reason.message, state.writeFailure.message);
    assert.deepEqual(state.events, ['updating']);
    assert.equal(state.files.opened, 1);
    assert.equal(state.permits.runs, 0);
    assert.equal((await fs.readFile(state.filename)).length, 40);
    assert.deepEqual(await fs.readdir(state.root), []);
    assert.deepEqual(state.observations(), { folderReads: 0, validations: 0, scans: 0 });
  } else {
    assert.equal(outcome.status, 'fulfilled');
    assert.deepEqual(state.events, ['updating', 'updated', 'updating', 'updated']);
    assert.equal(state.files.opened, 2);
    assert.ok(state.permits.runs >= 2, 'Closed library management must execute the previously admitted operations.');
    const stored = liveTvConfigurationReader.parseConfigurationXml(await fs.readFile(state.filename), 'livetv');
    assert.deepEqual(stored.MediaLocationsCreated, [state.moviePath]);
    const directory = path.join(state.root, 'Recorded Movies');
    assert.equal(await fs.readFile(path.join(directory, 'movies.collection'), 'utf8'), '');
    assert.deepEqual((await state.optionsStore.get(directory)).PathInfos, [{ Path: state.moviePath }]);
    const shortcuts = (await fs.readdir(directory)).filter(name => name.endsWith('.mblink'));
    assert.equal(shortcuts.length, 1);
    assert.equal(state.optionsStore.expandPath(await fs.readFile(path.join(directory, shortcuts[0]), 'utf8')), state.moviePath);
    assert.equal(state.observations().validations, 1);
    assert.equal(state.observations().scans, 1);
    assert.ok(state.observations().folderReads >= 2);
  }
});
