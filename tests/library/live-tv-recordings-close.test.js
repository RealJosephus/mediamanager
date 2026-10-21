import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { LiveTvService } from '../../src/library/live-tv-service.js';
import { liveTvConfigurationReader } from '../../src/core/live-tv-configuration-store.js';
import { LiveTvRecordingsService } from '../../src/library/live-tv-recordings-service.js';

test('an admitted recording-directory reader drains close and sees later named configuration reads', { timeout: 15000 }, async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mm-recording-reader-'));
  const configurationDirectoryPath = path.join(root, 'config'), dataPath = path.join(root, 'data');
  await fs.mkdir(configurationDirectoryPath); await fs.mkdir(dataPath);
  const configuration = { ...liveTvConfigurationReader.defaultConfiguration('livetv'),
    RecordingPath: path.join(dataPath, 'initial'), MovieRecordingPath: path.join(dataPath, 'old-movies') };
  const replacement = { ...configuration, RecordingPath: path.join(dataPath, 'replacement'),
    MovieRecordingPath: path.join(dataPath, 'new-movies'), SeriesRecordingPath: path.join(dataPath, 'new-series') };
  const liveTv = new LiveTvService({ configurationDirectoryPath });
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), observed = [];
  let held = true, closingDone = false, resolvedPaths;
  const service = new LiveTvRecordingsService({ liveTv, dataPath,
    mediaAssets: { async stat(identity) {
      observed.push(identity);
      if (held) { held = false; entered.resolve(); await release.promise; }
      return { kind: 'directory' };
    } },
    library: {
      async resolveLiveTvRecordingFolders(paths) { resolvedPaths = paths; return { folderIds: [], Items: [] }; },
    },
  });
  t.after(async () => {
    release.resolve(); await liveTv.close();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('mm-recording-reader-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  await liveTv.saveConfiguration(configuration);
  const reading = service.getRecordings({}, { user: { Id: 'reader' } });
  await entered.promise;
  await liveTv.saveConfiguration(replacement);
  const readScope = liveTv.admitRead();
  const closing = liveTv.close().then(() => { closingDone = true; });
  await assert.rejects(liveTv.getConfiguration(), { status: 503 });
  await assert.rejects(service.getRecordings({}, { user: { Id: 'reader' } }), { status: 503 });
  assert.throws(() => liveTv.admitRead(), { status: 503 });
  assert.equal(await readScope.getConfiguration(), replacement);
  readScope.release(); readScope.release();
  await assert.rejects(readScope.getConfiguration(), { status: 503 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closingDone, false, 'Close must retain the reader waiting on mapped directory I/O.');
  release.resolve();
  assert.deepEqual(await reading, { Items: [], TotalRecordCount: 0, StartIndex: 0 });
  await closing;
  assert.deepEqual(observed, [configuration.RecordingPath, replacement.MovieRecordingPath, replacement.SeriesRecordingPath]);
  assert.deepEqual(resolvedPaths, [replacement.RecordingPath, replacement.MovieRecordingPath, replacement.SeriesRecordingPath]);
  assert.equal(closingDone, true);
});
