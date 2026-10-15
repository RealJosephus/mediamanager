import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MetadataUpdateHost } from '../../src/metadata/update-host.js';
import { MetadataRegistry } from '../../src/metadata/registry.js';
const native = JSON.parse(await readFile(new URL('./fixtures/update-order.json', import.meta.url), 'utf8'));

for (const expected of native) test(`native metadata update ordering: ${expected.reason}/${expected.mode}`, async () => {
  const phases = [], stamps = {}, errors = [];
  let tick = Date.UTC(2026, 8, 27), eventCalls = 0;
  const now = () => new Date(tick++).toISOString(), started = now();
  const item = { Id: 'ABCDEFAB-0000-0000-0000-000000000001', Type: 'Photo', IsFileProtocol: expected.mode !== 'http',
    SourceType: expected.mode === 'channel' ? 'Channel' : 'Library', DateLastSaved: '2000-01-01T00:00:00Z' };
  const registry = new MetadataRegistry();
  registry.register({ id: 'fixture', name: 'Isolated', providers: [{ id: 'fixture', name: 'Fixture', kind: 'saver', itemTypes: ['Photo'],
    isEnabledFor: () => true, validateSave: async () => {}, save: async current => { phases.push('saver'); stamps.saver = current.DateLastSaved; } }] });
  const updates = new MetadataUpdateHost({ registry, now, logger: { error: error => errors.push(error.message) }, images: {
    updateImages: async (_loaded, _images, { forceUpdate }) => { if (forceUpdate) phases.push('images'); },
  } });
  updates.on('ItemUpdated', event => { assert.equal(event.UpdateReason, expected.reason); phases.push('event'); eventCalls++; stamps.event = event.Item.DateLastSaved; if (expected.mode === 'event-throws') throw new Error('Isolated handler failure'); });
  await updates.update({ item, context: {}, libraryOptions: { MetadataSavers: ['Fixture'] } }, { Item: item, Images: [] }, expected.reason,
    { persist: async () => { phases.push('persist'); stamps.persist = item.DateLastSaved; } });
  assert.deepEqual({ reason: expected.reason, mode: expected.mode, phases, error: null, eventCalls, savedAfterStart: item.DateLastSaved >= started,
    saverBeforePersist: !stamps.saver || stamps.persist >= stamps.saver, eventMatchesPersist: !stamps.event || stamps.event === stamps.persist }, expected);
  assert.equal(errors.length, expected.mode === 'event-throws' ? 1 : 0);
});

test('failed metadata persistence publishes no item update', async () => {
  const item = { Type: 'Photo', IsFileProtocol: false }, updates = new MetadataUpdateHost({ images: { updateImages: async () => {} } });
  let notified = false; updates.on('ItemUpdated', () => { notified = true; });
  await assert.rejects(updates.update({ item }, { Item: item, Images: [] }, 4, { persist: async () => { throw new Error('Isolated persistence failure'); } }), /persistence failure/);
  assert.equal(notified, false);
});
