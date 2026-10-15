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
  const events = []; const item = { DateLastSaved: 'old' }; const error = new Error('network failure');
  const failing = { ...saver, id: 'failing', save: async () => { throw error; } };
  const options = { includeDisabled: true, now: () => 'new', monitor: { begin: (path) => events.push(['begin', path]), complete: (path, reset) => events.push(['complete', path, reset]) } };
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
