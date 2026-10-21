import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveTvService } from '../../src/library/live-tv-service.js';
import { liveTvConfigurationReader } from '../../src/core/live-tv-configuration-store.js';
import { LiveTvSourcesService } from '../../src/library/live-tv-sources-service.js';
import { LiveTvRecordingFolders } from '../../src/library/live-tv-recording-folders.js';
import { PluginHost } from '../../src/plugins/host.js';

for (const observer of [false, true]) for (const validationFails of [false, true]) {
  test(`admitted source validation ${validationFails ? 'failure' : 'success'} drains close ${observer ? 'with' : 'without'} a recording-folder observer`, {
    timeout: 15000,
  }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-source-close-'));
    const configurationDirectoryPath = path.join(root, 'config'), cachePath = path.join(root, 'cache'), dataPath = path.join(root, 'data');
    await fs.mkdir(configurationDirectoryPath); await fs.mkdir(cachePath); await fs.mkdir(dataPath);
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const validationFailure = new Error('Controlled provider validation failure.');
    let liveTv, plugins, sources, recordingFolders, admissionClosed = false, opens = 0, closes = 0, pending;
    const events = [], counts = { reserved: 0, released: 0, reconciles: 0, refreshes: 0 };
    t.after(async () => {
      release.resolve(); await Promise.allSettled([pending]);
      await sources?.close(); await liveTv?.close(); await recordingFolders?.close(); await plugins?.close();
      assert.equal(opens, closes);
      assert.equal(counts.reserved, counts.released);
      assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('mm-source-close-'));
      await fs.rm(root, { recursive: true, force: true });
    });
    liveTv = new LiveTvService({ configurationDirectoryPath, fileSystem: { ...fs, async open(...args) {
      const file = await fs.open(...args); opens++;
      return { writeFile: (...values) => file.writeFile(...values), async close() { try { await file.close(); } finally { closes++; } } };
    } } });
    const initial = liveTvConfigurationReader.defaultConfiguration('livetv'); await liveTv.saveConfiguration(initial);
    const filename = path.join(configurationDirectoryPath, 'livetv.xml'), before = await fs.readFile(filename);
    if (observer) {
      const libraryConfiguration = { admitOperation() {
        if (admissionClosed) throw new Error('Library admission is closed.');
        counts.reserved++;
        return { async getVirtualFolders() { counts.reconciles++; return []; }, release() { counts.released++; } };
      } };
      recordingFolders = new LiveTvRecordingFolders({ liveTv, libraryConfiguration, dataPath,
        mediaAssets: { stat: async () => { throw Object.assign(new Error('Controlled absent recording directory.'), { code: 'ENOENT' }); } },
        queueLibraryScan: async () => {} });
      recordingFolders.start();
    }
    const capability = liveTv.admitMutation(); capability.release(); capability.release();
    await assert.rejects(capability.getConfiguration(), { status: 503 });
    await assert.rejects(capability.saveConfiguration(initial), { status: 503 });
    const baseline = { ...counts };
    liveTv.on('updating', () => events.push('updating')); liveTv.on('updated', () => events.push('updated'));
    plugins = await PluginHost.open({ directory: path.join(root, 'plugins'), preinstalled: false,
      options: { 'source-controls': { tuners: [{ type: 'controlled', name: 'Controlled tuner' }], listings: [],
        async invoke(_kind, method, _definition, args) {
          assert.ok(args.at(-1).signal instanceof AbortSignal);
          if (method === 'validate') { entered.resolve(); await release.promise; if (validationFails) throw validationFailure; }
          else return [];
        } } } });
    await plugins.install(fileURLToPath(new URL('./fixtures/live-tv-sources/plugin/', import.meta.url)));
    sources = new LiveTvSourcesService({ liveTv, plugins, fileSystem: fs, cachePath,
      refreshGuide: () => { counts.refreshes++; } });
    pending = sources.saveTunerHost({ Type: 'controlled', FriendlyName: 'Admitted tuner' });
    const outcome = Promise.allSettled([pending]);
    assert.equal(counts.reserved - baseline.reserved, observer ? 1 : 0, 'The root observer reservation precedes the provider await.');
    await entered.promise;
    let sourcesClosed = false, configurationClosed = false;
    const closingSources = sources.close().then(() => { sourcesClosed = true; });
    const closingConfiguration = liveTv.close().then(() => { configurationClosed = true; });
    admissionClosed = true;
    const closingFolders = recordingFolders?.close();
    await assert.rejects(sources.saveTunerHost({ Type: 'controlled' }), { status: 503 });
    assert.throws(() => liveTv.admitMutation(), { status: 503 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sourcesClosed, false); assert.equal(configurationClosed, false);
    release.resolve();
    const [result] = await outcome;
    if (validationFails) { assert.equal(result.status, 'rejected'); assert.equal(result.reason, validationFailure); }
    else { assert.equal(result.status, 'fulfilled'); assert.match(result.value.Id, /^[a-f\d]{32}$/u); }
    await Promise.all([closingSources, closingConfiguration, closingFolders]);
    assert.equal(sourcesClosed, true); assert.equal(configurationClosed, true);
    assert.deepEqual(events, validationFails ? [] : ['updating', 'updated']);
    assert.equal(counts.reconciles, validationFails || !observer ? 0 : 1);
    assert.equal(counts.refreshes, validationFails ? 0 : 1);
    assert.equal(counts.reserved - baseline.reserved, observer ? 1 : 0, 'A child save must share the pre-admitted dependency group.');
    assert.equal(counts.released, counts.reserved);
    if (validationFails) assert.deepEqual(await fs.readFile(filename), before);
    else assert.notDeepEqual(await fs.readFile(filename), before);
  });
}
