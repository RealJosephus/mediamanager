import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setupChildrenFixture } from './children-fixture.js';
import { postgresTestRow } from '../database/postgres-fixture.js';
import { dateTicks } from '../../src/library/records.js';

import { currentPhotoNative, recordPhotoCandidate } from './fixtures/photo-current/capture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const { input, native, report } = await currentPhotoNative('custom-lifecycle');
const id = 'c1700000-0000-0000-0000-000000000001';
const stamp = '2025-01-02T03:04:05.0000000Z';
const identity = filename => 'Z:\\ChildrenMetadata\\CustomImages\\' + filename;
const image = (filename, Type, ready = false) => ({ Path: identity(filename), Type, DateModified: stamp,
  Width: ready ? 8 : 0, Height: ready ? 6 : 0, Blurhash: ready ? Buffer.from('controlled') : null });
const paths = images => images.map(value => path.win32.basename(value.Path));
const comparePath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const liveImages = images => images.map(value => ({ path: path.win32.basename(value.Path), type: value.Type,
  width: value.Width, height: value.Height, blurhash: value.BlurHash ?? (value.Blurhash == null ? null : Buffer.from(value.Blurhash).toString('utf8')) })).sort(comparePath);

test('custom image lifecycle binds current Native assemblies, real SQLite, image inputs and both recordings', () => {
  assert.equal(report.nativeExecutionRecorded, true); assert.equal(report.independentNativeCapturesAgree, true);
  assert.equal(report.historicalRecordingReused, false);
  assert.equal(native.sqlite.resolverObserved, true);
  assert.equal(native.results.length, input.length);
});

test('PostgreSQL custom providers share image mutations through processing, probe reload and native save prefixes', async t => {
  const fixture = await setupChildrenFixture(t);
  fixture.host.images.processor = { getImageSize: async () => ({ Width: 8, Height: 6 }), getImageBlurHash: async () => 'controlled' };
  await fixture.adapter.mkdir('/aggregate'); await fixture.adapter.mkdir('/aggregate/CustomImages');
  const bytes = await readFile(new URL('../images/fixtures/http/poster.png', import.meta.url));
  for (const name of ['old.png', 'new.png', 'second.png', 'probe.png']) await fixture.adapter.write('/aggregate/CustomImages/' + name, bytes,
    { modified: '2025-01-02T03:04:05Z' });
  for (const sample of input) await t.test(sample.name, async () => {
    await fixture.seed({ target: 'target', items: [{ key: 'target', Id: id, type: 'Book', Name: 'Stored book',
      DateLastRefreshed: sample.first ? '0001-01-01 00:00:00' : '2026-10-01 00:00:00' }] });
    await fixture.database.insert('BaseItemImageInfos', postgresTestRow('BaseItemImageInfos', { Id: randomUUID(), ItemId: id,
      ImageType: 0, Path: identity('old.png'), DateModified: stamp, Width: 8, Height: 6, Blurhash: Buffer.from('controlled') }));
    const before = (await fixture.database.rows('BaseItems', { where: { Id: id } }))[0];
    const calls = [], saves = [];
    const plugin = fixture.registry.register({ id: 'custom-images', name: 'Custom image controls', providers: [{
      id: 'first', name: 'Controlled custom image 0', kind: 'custom', itemTypes: ['Book'], order: 0, hasChanged: async () => true,
      fetch: async (item, { images }) => {
        calls.push({ provider: 'first', images: paths(images) });
        if (sample.operation === 'replace') images[0] = image('new.png', 'Primary');
        else if (sample.operation === 'remove') images.splice(0);
        else images.push(image('new.png', 'Backdrop'));
        item.Overview = 'Custom overview';
        if (sample.failure === 'provider') throw new Error('Controlled custom image failure.');
        if (sample.failure === 'cancel') throw new DOMException('Controlled custom image cancellation.', 'AbortError');
        return 6;
      }
    }, {
      id: 'second', name: 'Controlled custom image 1', kind: 'custom', itemTypes: ['Book'], order: 1, hasChanged: async () => true,
      fetch: async (item, { images }) => {
        calls.push({ provider: 'second', images: paths(images) });
        if (sample.operation === 'sequential') images[images.findIndex(value => value.Type === 'Primary')] = image('second.png', 'Primary');
        return 1;
      }
    }] });
    if (sample.probe) fixture.host.probe = {
      supportsMetadata: item => item.Type === 'Book', hasChanged: async () => true,
      refreshMetadata: async loaded => {
        calls.push({ provider: 'probe', images: paths(loaded.context.images) });
        loaded.context.images[0] = image('probe.png', 'Primary');
        await fixture.host.updates.update(loaded, { Item: loaded.item, Images: loaded.context.images }, 4);
        return { changed: true, UpdateType: 4 };
      }
    };
    if (sample.failure === 'images') await fixture.database.client.query(`CREATE FUNCTION "${fixture.database.schemaName}".reject_custom_image() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW."Path" LIKE '%new.png' THEN RAISE EXCEPTION 'Controlled image SQL failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_custom_image BEFORE INSERT ON "${fixture.database.schemaName}"."BaseItemImageInfos" FOR EACH ROW EXECUTE FUNCTION "${fixture.database.schemaName}".reject_custom_image()`);
    const updated = ({ Item, UpdateReason }) => saves.push({ reason: UpdateReason, Overview: Item.Overview,
      images: liveImages(Item.ImageInfos) });
    fixture.host.updates.on('ItemUpdated', updated);
    let result, operationFailed = false;
    try {
      const pending = fixture.host.refresh(id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
      if (sample.failure === 'cancel') { await assert.rejects(pending, error => error.name === 'AbortError'); operationFailed = true; }
      else if (sample.failure === 'images') { await assert.rejects(pending, /Controlled image SQL failure/u); operationFailed = true; }
      else result = await pending;
    } finally {
      fixture.host.updates.off('ItemUpdated', updated); fixture.registry.unregister(plugin.id); fixture.host.probe = undefined;
      if (sample.failure === 'images') await fixture.database.client.query(`DROP TRIGGER reject_custom_image ON "${fixture.database.schemaName}"."BaseItemImageInfos";
        DROP FUNCTION "${fixture.database.schemaName}".reject_custom_image()`);
    }
    const expected = native.results.find(value => value.name === sample.name);
    assert.equal(operationFailed, expected.errorOccurred);
    assert.deepEqual(calls, expected.calls); assert.deepEqual(saves, expected.saves);
    const row = (await fixture.database.rows('BaseItems', { where: { Id: id } }))[0];
    const stored = (await fixture.database.rows('BaseItemImageInfos', { where: { ItemId: id } })).map(value => ({
      path: path.win32.basename(value.Path), type: ['Primary', 'Art', 'Backdrop'][value.ImageType], width: value.Width, height: value.Height,
      blurhash: value.Blurhash == null ? null : Buffer.from(value.Blurhash).toString('utf8') })).sort(comparePath);
    await recordPhotoCandidate('custom-lifecycle', sample.name, { calls, saves, failed: operationFailed, row,
      storedImages: stored, updateType: result?.UpdateType ?? null, failures: result?.Failures ?? null,
      stampChanged: dateTicks(row.DateLastRefreshed) !== dateTicks(before.DateLastRefreshed) });
    assert.deepEqual(stored, [...expected.storedImages].sort(comparePath));
    assert.equal(row.Overview, expected.Overview);
    assert.equal(dateTicks(row.DateLastRefreshed) !== dateTicks(before.DateLastRefreshed), expected.stampChanged);
    if (result) { assert.equal(result.UpdateType, expected.updateType); assert.equal(result.Failures, sample.failure === 'provider' ? 1 : 0); }
    await fixture.loadContext.withContext(id, {}, async loaded => {
      for (const name of ['old.png', 'new.png', 'second.png', 'probe.png']) assert.deepEqual(await loaded.imageAssets.read(identity(name)), bytes);
    });
  });
});
