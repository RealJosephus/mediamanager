import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setupChildrenFixture } from './children-fixture.js';
import { postgresTestRow } from '../database/postgres-fixture.js';
import { dateTicks } from '../../src/library/records.js';

const provenanceUrl = new URL('./fixtures/custom-image-lifecycle/provenance.json', import.meta.url);
const root = new URL('./', provenanceUrl);
const read = async filename => JSON.parse(await readFile(new URL(filename, root), 'utf8'));
const [input, native] = await Promise.all(['input.json', 'native.json'].map(read));
const hash = value => createHash('sha256').update(value).digest('hex');
const id = 'c1700000-0000-0000-0000-000000000001';
const stamp = '2025-01-02T03:04:05.0000000Z';
const identity = filename => 'Z:\\ChildrenMetadata\\CustomImages\\' + filename;
const image = (filename, Type, ready = false) => ({ Path: identity(filename), Type, DateModified: stamp,
  Width: ready ? 8 : 0, Height: ready ? 6 : 0, Blurhash: ready ? Buffer.from('controlled') : null });
const paths = images => images.map(value => path.win32.basename(value.Path));
const comparePath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const liveImages = images => images.map(value => ({ path: path.win32.basename(value.Path), type: value.Type,
  width: value.Width, height: value.Height, blurhash: value.BlurHash ?? (value.Blurhash == null ? null : Buffer.from(value.Blurhash).toString('utf8')) })).sort(comparePath);

test('custom image lifecycle binds actual new native assemblies, production source, SQL/file inputs and raw recording', async () => {
  const provenance = await read('provenance.json');
  for (const entry of provenance.files) assert.equal(hash(await readFile(new URL(entry.filename, root))), entry.sha256, entry.filename);
  for (const entry of provenance.sources) assert.equal(hash(await readFile(entry.filename)), entry.sha256, entry.filename);
  for (const entry of provenance.assemblies) {
    assert.equal(hash(await readFile(entry.filename)), entry.sha256, entry.name);
    assert.equal(native.assemblies.find(assembly => assembly.name === entry.name)?.sha256, entry.sha256);
  }
  const record = JSON.parse(await readFile(provenance.record.filename, 'utf8'));
  assert.equal(hash(await readFile(provenance.record.filename)), provenance.record.sha256);
  assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
  assert.equal(record.jellyfinDll.sha256, '474c7c638fe93cc61f1a588849fb93c81a2927388f6f4cf19953b3a76e9deb26');
  assert.equal(record.sourceFilesSha256, provenance.sourceFilesSha256);
  for (const entry of record.sourceFiles) {
    const name = entry.filename.replaceAll('\\', '/').split('/').at(-1);
    const sealed = provenance.files.find(file => file.filename === (name === 'Directory.Build.props' ? '../../../Directory.Build.props' : name));
    assert.equal(entry.sha256, sealed?.sha256, name);
  }
  assert.equal(record.outputs.find(entry => entry.filename.replaceAll('\\', '/').endsWith('/native.json'))?.sha256,
    provenance.files.find(entry => entry.filename === 'native.json').sha256);
  assert.equal(native.inputSha256, hash(await readFile(new URL('input.json', root))));
  assert.equal(native.imageSha256, hash(await readFile(new URL('../images/fixtures/http/poster.png', import.meta.url))));
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
    let result;
    try {
      const pending = fixture.host.refresh(id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
      if (sample.failure === 'cancel') await assert.rejects(pending, error => error.name === 'AbortError');
      else if (sample.failure === 'images') await assert.rejects(pending, /Controlled image SQL failure/u);
      else result = await pending;
    } finally {
      fixture.host.updates.off('ItemUpdated', updated); fixture.registry.unregister(plugin.id); fixture.host.probe = undefined;
      if (sample.failure === 'images') await fixture.database.client.query(`DROP TRIGGER reject_custom_image ON "${fixture.database.schemaName}"."BaseItemImageInfos";
        DROP FUNCTION "${fixture.database.schemaName}".reject_custom_image()`);
    }
    const expected = native.results.find(value => value.name === sample.name);
    assert.deepEqual(calls, expected.calls); assert.deepEqual(saves, expected.saves);
    const row = (await fixture.database.rows('BaseItems', { where: { Id: id } }))[0];
    const stored = (await fixture.database.rows('BaseItemImageInfos', { where: { ItemId: id } })).map(value => ({
      path: path.win32.basename(value.Path), type: ['Primary', 'Art', 'Backdrop'][value.ImageType], width: value.Width, height: value.Height,
      blurhash: value.Blurhash == null ? null : Buffer.from(value.Blurhash).toString('utf8') })).sort(comparePath);
    assert.deepEqual(stored, [...expected.storedImages].sort(comparePath));
    assert.equal(row.Overview, expected.Overview);
    assert.equal(dateTicks(row.DateLastRefreshed) !== dateTicks(before.DateLastRefreshed), expected.stampChanged);
    if (result) { assert.equal(result.UpdateType, expected.updateType); assert.equal(result.Failures, sample.failure === 'provider' ? 1 : 0); }
    await fixture.loadContext.withContext(id, {}, async loaded => {
      for (const name of ['old.png', 'new.png', 'second.png', 'probe.png']) assert.deepEqual(await loaded.imageAssets.read(identity(name)), bytes);
    });
  });
});
