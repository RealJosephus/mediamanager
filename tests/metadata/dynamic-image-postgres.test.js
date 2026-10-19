import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { setupChildrenFixture } from './children-fixture.js';
import { internalImagePath } from '../../src/metadata/image-paths.js';
import { MIN_DATE, dateTicks } from '../../src/library/records.js';
import { postgresTestRow } from '../database/postgres-fixture.js';

const enabled = Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES);
const id = 'db120000-0000-0000-0000-000000000001';
const imageId = 'db120000-0000-0000-0000-000000000002';
const png = await readFile(new URL('../images/fixtures/http/poster.png', import.meta.url));

async function fixture(t, { first = false, extra = false, locked = false, existing = false } = {}) {
  const f = await setupChildrenFixture(t);
  await f.seed({ target: 'book', items: [{ key: 'book', type: 'Book', Id: id, Name: 'Stored book', Path: 'Z:\\ChildrenMetadata\\book.cbz',
    IsLocked: locked, ExtraType: extra ? 2 : null, DateLastRefreshed: first ? MIN_DATE : '2026-01-01 00:00:00', DateLastSaved: MIN_DATE }] });
  await f.adapter.mkdir('/aggregate'); await f.adapter.write('/aggregate/book.cbz', Buffer.from('controlled archive source'));
  const loaded = await f.loadContext(id);
  try {
    f.imagePath = path.join(internalImagePath(loaded.item, loaded.metadataPath), 'poster.png');
    f.imageAssets = loaded.imageAssets;
    if (existing) {
      const old = path.join(internalImagePath(loaded.item, loaded.metadataPath), 'old.jpg');
      await loaded.imageAssets.write(old, png);
      await f.database.insert('BaseItemImageInfos', postgresTestRow('BaseItemImageInfos', { Id: imageId, ItemId: id, ImageType: 0, Path: old,
        Width: 1, Height: 1, DateModified: '2026-01-01 00:00:00', Blurhash: Buffer.from('old-hash') }));
      f.oldPath = old;
    }
  } finally { await loaded.dispose(); }
  f.calls = [];
  f.register = (name, fetch) => f.registry.register({ id: name, name, providers: [{ id: name, name, kind: 'image', imageSource: 'dynamic',
    itemTypes: ['Book'], imageTypes: ['Primary'], async getImage(item, options) {
      assert.equal(options.type, 'Primary'); assert.equal(item.Path, 'Z:\\ChildrenMetadata\\book.cbz'); f.calls.push(name);
      return fetch ? fetch(item, options) : { bytes: png, mimeType: 'image/png' };
    } }] });
  return f;
}

test('postgres: real metadata host consumes one dynamic cover and persists canonical rows with original bytes', { skip: !enabled }, async t => {
  const f = await fixture(t, { first: true }); f.register('A'); f.register('B');
  const result = await f.host.refresh(id, { MetadataRefreshMode: 'None', ImageRefreshMode: 'FullRefresh' });
  assert.deepEqual(f.calls, ['A']); assert.equal(result.Failures, 0);
  const rows = await f.database.rows('BaseItemImageInfos', { where: { ItemId: id } });
  assert.equal(rows.length, 1); assert.deepEqual([rows[0].Width, rows[0].Height], [8, 6]);
  assert.deepEqual(await f.imageAssets.read(f.imagePath), png);
  const stored = (await f.database.rows('BaseItems', { where: { Id: id } }))[0];
  assert.equal(stored.Name, 'Stored book'); assert.ok(dateTicks(stored.DateLastSaved) > dateTicks(MIN_DATE));
});

test('postgres: native existing default/locked/extra image eligibility survives the complete host', { skip: !enabled }, async t => {
  for (const [name, values, mode, expectedCalls] of [
    ['existing-default', {}, 'Default', []], ['locked-default', { first: true, locked: true }, 'Default', []],
    ['locked-full', { locked: true }, 'FullRefresh', ['A']], ['extra-dynamic', { extra: true }, 'FullRefresh', ['A']],
  ]) await t.test(name, async t => {
    const f = await fixture(t, values); f.register('A');
    const result = await f.host.refresh(id, { MetadataRefreshMode: 'None', ImageRefreshMode: mode });
    assert.equal(result.Failures, 0); assert.deepEqual(f.calls, expectedCalls);
    assert.equal((await f.database.rows('BaseItemImageInfos', { where: { ItemId: id } })).length, expectedCalls.length);
  });
});

test('postgres: ordinary dynamic provider failure allows the next cover to persist', { skip: !enabled }, async t => {
  const f = await fixture(t); f.register('A', () => { throw new Error('Controlled provider failure'); }); f.register('B');
  const result = await f.host.refresh(id, { MetadataRefreshMode: 'None', ImageRefreshMode: 'FullRefresh' });
  assert.deepEqual(f.calls, ['A', 'B']); assert.equal(result.Failures, 1);
  assert.deepEqual(await f.imageAssets.read(f.imagePath), png);
  assert.equal((await f.database.rows('BaseItemImageInfos', { where: { ItemId: id } })).length, 1);
});

test('postgres: dynamic cancellation retains the committed first save and zero-byte destination prefix', { skip: !enabled }, async t => {
  const f = await fixture(t, { first: true }), controller = new AbortController();
  f.register('A', () => { controller.abort(); return { bytes: png, mimeType: 'image/png' }; });
  await assert.rejects(f.host.refresh(id, { MetadataRefreshMode: 'None', ImageRefreshMode: 'FullRefresh', signal: controller.signal }), { name: 'AbortError' });
  const stored = (await f.database.rows('BaseItems', { where: { Id: id } }))[0];
  assert.ok(dateTicks(stored.DateLastSaved) > dateTicks(MIN_DATE));
  assert.equal(dateTicks(stored.DateLastRefreshed), dateTicks(MIN_DATE));
  assert.deepEqual(await f.imageAssets.read(f.imagePath), Buffer.alloc(0));
  assert.deepEqual(await f.database.rows('BaseItemImageInfos', { where: { ItemId: id } }), []);
});

test('postgres: image SQL failure preserves the earlier deletion and saved dynamic cover bytes', { skip: !enabled }, async t => {
  const f = await fixture(t, { existing: true }); f.register('A');
  await f.database.client.query("CREATE FUNCTION dynamic_image_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'dynamic image insert failed' USING ERRCODE='23514'; END $$");
  await f.database.client.query('CREATE TRIGGER dynamic_image_failure BEFORE INSERT ON "BaseItemImageInfos" FOR EACH ROW EXECUTE FUNCTION dynamic_image_failure()');
  await assert.rejects(f.host.refresh(id, { MetadataRefreshMode: 'None', ImageRefreshMode: 'FullRefresh', ReplaceAllImages: true }), { code: '23514' });
  assert.deepEqual(await f.database.rows('BaseItemImageInfos', { where: { ItemId: id } }), []);
  assert.deepEqual(await f.imageAssets.read(f.imagePath), png);
  await assert.rejects(f.imageAssets.stat(f.oldPath), { code: 'not-found' });
});
