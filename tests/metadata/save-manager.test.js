import test from 'node:test';
import assert from 'node:assert/strict';
import { ItemUpdateType, isSaverEnabled, saveMetadata } from '../../src/metadata/save-manager.js';

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
  const events = []; const item = { DateLastSaved: '2099-09-25T00:00:00Z' }; const error = new Error('network failure');
  const failing = { ...saver, id: 'failing', save: async () => { throw error; } };
  const options = { includeDisabled: true, now: () => '2026-09-26T00:00:00Z', monitor: { reportFileSystemChangeBeginning: (path) => events.push(['begin', path]), reportFileSystemChangeComplete: (path, reset) => events.push(['complete', path, reset]) } };
  const failed = await saveMetadata(item, ItemUpdateType.MetadataDownload, [failing], options);
  assert.equal(failed[0].error, error); assert.equal(item.DateLastSaved, '2099-09-25T00:00:00Z');
  await saveMetadata(item, ItemUpdateType.MetadataDownload, [failing, saver], options);
  assert.equal(item.DateLastSaved, '2026-09-26T00:00:00Z'); assert.equal(events.filter((event) => event[0] === 'complete').length, 3);
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
