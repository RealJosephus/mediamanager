import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ItemUpdateType, isSaverEnabled, saveMetadata } from '../../src/metadata/save-manager.js';
import { createLocalXmlProviders } from '../../src/metadata/local-xml-provider.js';
import { dateTicks } from '../../src/library/records.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';

const saver = { id: 'fixture', name: 'Nfo', getSavePath: () => '/fixture.nfo', isEnabledFor: () => true, save: async () => ({ changed: false }) };

test('manual edits preserve existing NFO despite save-local disabled while download does not', async () => {
  const item = { SaveLocalMetadata: false };
  const options = { exists: async () => true };
  assert.equal(await isSaverEnabled(saver, item, ItemUpdateType.MetadataEdit, options), true);
  assert.equal(await isSaverEnabled(saver, item, ItemUpdateType.MetadataDownload, options), false);
  assert.equal(await isSaverEnabled(saver, item, ItemUpdateType.MetadataEdit, { exists: async () => false }), false);
  assert.equal(await isSaverEnabled(saver, item, ItemUpdateType.MetadataDownload, { libraryOptions: { MetadataSavers: ['nfo'] } }), true);
});

test('save manager catches saver failure, completes monitor, continues and updates DateLastSaved only after success', async () => {
  const events = []; const item = { DateLastSaved: 'old' }; const error = new Error('network failure');
  const failing = { ...saver, id: 'failing', save: async () => { throw error; } };
  const options = { includeDisabled: true, now: () => 'new', monitor: { reportFileSystemChangeBeginning: (path) => events.push(['begin', path]), reportFileSystemChangeComplete: (path, reset) => events.push(['complete', path, reset]) } };
  const failed = await saveMetadata(item, ItemUpdateType.MetadataDownload, [failing], options);
  assert.equal(failed[0].error, error); assert.equal(item.DateLastSaved, 'old');
  await saveMetadata(item, ItemUpdateType.MetadataDownload, [failing, saver], options);
  assert.equal(item.DateLastSaved, 'new'); assert.equal(events.filter((event) => event[0] === 'complete').length, 3);
});

test('save manager preserves baseline uncancelled save entry point', async () => {
  const controller = new AbortController(); controller.abort(); let received;
  await saveMetadata({}, ItemUpdateType.MetadataEdit, [{ ...saver, save: async (_, context) => { received = context.signal; } }], { includeDisabled: true, context: { signal: controller.signal } });
  assert.equal(received, undefined);
});

test('savers keep their access path for availability and report a distinct identity path to monitoring', async () => {
  const events = [], identity = 'Z:\\Media\\movie.nfo';
  const mapped = { ...saver, getSavePath: () => '/access/movie.nfo', getMonitorPath: () => identity,
    save: async () => events.push(['save']) };
  const outcomes = await saveMetadata({ SaveLocalMetadata: false }, ItemUpdateType.MetadataEdit, [mapped], {
    exists: async filename => { assert.equal(filename, '/access/movie.nfo'); return true; },
    monitor: { reportFileSystemChangeBeginning: filename => events.push(['begin', filename]),
      reportFileSystemChangeComplete: (filename, refresh) => events.push(['complete', filename, refresh]) }
  });
  assert.equal(outcomes.length, 1); assert.equal(outcomes[0].error, undefined);
  assert.deepEqual(events, [['begin', identity], ['save'], ['complete', identity, false]]);
});

test('a completed local metadata write does not invalidate its own default saved clock', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-save-clock-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('metadata-save-clock-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const filename = path.join(directory, 'collection.xml');
  const item = { Type: 'BoxSet', Path: directory, SaveLocalMetadata: true, DateLastSaved: '0001-01-01T00:00:00Z' };
  const provider = createLocalXmlProviders({ fileSystem: fs,
    savePath: () => filename }).find(value => value.id === 'BoxSetXmlProvider');
  const context = { localRoot: directory, localPath: directory };
  const observations = [], report = { observations, complete: false, nativeExecutedByThisTest: false,
    scope: 'Actual saveMetadata default clock, real private file writes and real BoxSetXmlProvider.HasChanged; no mocked clock, timestamp rounding or metadata parser replacement.' };
  const output = path.join(validationOutputRoot(), 'metadata-save-clock-' + randomUUID() + '.json');
  assertValidationOutputChild(output);
  try {
    for (let index = 0; index < 32; index++) {
      const bytes = Buffer.from('<Item><LocalTitle>Clock ' + index + '</LocalTitle></Item>');
      const outcomes = await saveMetadata(item, ItemUpdateType.MetadataEdit, [{
        id: 'controlled-real-file-write', name: 'Emby Xml', isEnabledFor: () => true,
        getSavePath: () => filename, save: async () => { await fs.writeFile(filename, bytes); return { changed: true }; },
      }], { includeDisabled: true });
      assert.equal(outcomes.length, 1); assert.equal(outcomes[0].error, undefined);
      const info = await fs.stat(filename, { bigint: true });
      const changed = await provider.hasChanged(item, context);
      const observation = { index, saved: item.DateLastSaved, modifiedUnixNanoseconds: info.mtimeNs.toString(), changed };
      observations.push(observation);
      assert.equal(changed, false, JSON.stringify(observation));
      assert.ok(dateTicks(item.DateLastSaved) >= info.mtimeNs / 100n + 621355968000000000n);
      assert.deepEqual(await fs.readFile(filename), bytes);
    }
    const externalTime = new Date(Number((dateTicks(item.DateLastSaved) - 621355968000000000n) / 10000n) + 1000);
    await fs.utimes(filename, externalTime, externalTime);
    report.externalChangeDetected = await provider.hasChanged(item, context);
    assert.equal(report.externalChangeDetected, true, 'An actual later sidecar change must remain visible.');
    report.complete = true;
  } finally { await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); }
});
