import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setupChildrenFixture } from './children-fixture.js';
import { metadataLookup } from '../../src/library/metadata-context.js';
import { mergeMetadata } from '../../src/metadata/merge.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { searchesContainingFolderForExtras } from '../../src/library/owned-items.js';
import { collectOwnedExtras } from '../../src/library/video-file-resolver.js';
import { dateTicks } from '../../src/library/records.js';

const provenanceUrl = new URL('./fixtures/book-lifecycle/provenance.json', import.meta.url);
const root = new URL('.', provenanceUrl);
const read = async name => JSON.parse(await readFile(new URL(name, root), 'utf8'));
const [input, native, ownedInput, ownedNative] = await Promise.all(['input.json', 'native.json', 'owned/input.json', 'owned/native.json'].map(read));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const nativeBook = 'MediaBrowser.Controller.Entities.Book';
const Id = number => `cb700000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const itemProjection = item => ({ Name: item.Name ?? null, SeriesName: item.SeriesName ?? null, Overview: item.Overview ?? null });

test('Book metadata and owner recordings seal real native service, SQL/file observations and source inputs', async () => {
  const provenance = await read('provenance.json');
  for (const entry of provenance.files) assert.equal(hash(await readFile(new URL(entry.filename, root))), entry.sha256, entry.filename);
  for (const source of provenance.sources) {
    assert.equal(hash(await readFile(source.filename)), source.sha256, source.relativePath);
  }
  for (const recording of provenance.recordings) {
    const bytes = await readFile(recording.record.filename);
    assert.equal(hash(bytes), recording.record.sha256);
    const record = JSON.parse(bytes);
    assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
    assert.equal(record.jellyfinDll.sha256, 'a43fa24c44677e579fcec79d637789b9f36633d02e5434e76a0e03fa13027767');
    assert.equal(record.sourceFilesSha256, recording.sourceFilesSha256);
  }
  assert.equal(native.inputSha256, hash(await readFile(new URL('input.json', root))));
  assert.equal(ownedNative.inputSha256, hash(await readFile(new URL('owned/input.json', root))));
  assert.equal(native.results.length, input.lookups.length + input.merges.length + input.refresh.length);
  assert.equal(ownedNative.results.length, ownedInput.length);
});

test('Book lookup and merge match real service behavior for empty values, physical parents and Name locks', async t => {
  for (const sample of input.lookups) await t.test(sample.name, () => {
    const item = Object.assign(newNativeItemEntity(nativeBook), { Name: 'Stored title', ProductionYear: 2025,
      SeriesName: sample.seriesName, MetadataLanguage: 'en', MetadataCountryCode: 'US' });
    const lookup = metadataLookup(item, sample.parents.map(Name => ({ Name })));
    assert.deepEqual({ Name: lookup.Name, Year: lookup.Year, SeriesName: lookup.SeriesName,
      MetadataLanguage: lookup.MetadataLanguage, MetadataCountryCode: lookup.MetadataCountryCode },
    native.results.find(entry => entry.name === sample.name).lookup);
  });
  for (const sample of input.merges) await t.test(sample.name, async () => {
    const source = { Item: Object.assign(newNativeItemEntity(nativeBook), { Name: 'Incoming title', SeriesName: sample.source }) };
    const target = { Item: Object.assign(newNativeItemEntity(nativeBook), { Name: 'Stored title', SeriesName: sample.target }) };
    await mergeMetadata(source, target, { replaceData: sample.replace, lockedFields: sample.nameLocked ? ['Name'] : [], mergeMetadataSettings: false });
    assert.deepEqual({ Name: target.Item.Name, SeriesName: target.Item.SeriesName }, native.results.find(entry => entry.name === sample.name).item);
  });
});

test('owner-path extra discovery matches native non-video files, video/stub paths and directory owners', async t => {
  for (const sample of ownedInput) await t.test(sample.name, async () => {
    const folder = ['Folder', 'PhotoAlbum'].includes(sample.expectedType);
    const identityPath = path.win32.join('Z:\\BookMetadata\\media', sample.ownerPath);
    const owner = { Id: Id(1), ParentId: Id(2), Type: sample.expectedType, Path: identityPath, IsFolder: folder, IsInMixedFolder: false };
    const candidate = { identityPath, entry: { kind: folder ? 'directory' : 'file', name: path.win32.basename(identityPath) }, itemId: owner.Id };
    const siblings = sample.files.map(filename => { const identityPath = path.win32.join('Z:\\BookMetadata\\media', filename);
      return { identityPath, entry: { kind: 'file', name: path.win32.basename(identityPath) } }; });
    const extras = searchesContainingFolderForExtras(owner) ? (await collectOwnedExtras(candidate, [candidate], siblings)).extras : [];
    const expected = ownedNative.results.find(entry => entry.name === sample.name).calls.filter(call => call.action === 'refresh' && call.item.extraType != null);
    assert.deepEqual(extras.map(extra => [extra.nativeType, extraTypes[extra.extraType]]), expected.map(call => [call.item.type, call.item.extraType]));
  });
});

const extraTypes = ['Unknown', 'Clip', 'Trailer', 'BehindTheScenes', 'DeletedScene', 'Interview', 'Scene', 'Sample', 'ThemeSong', 'ThemeVideo', 'Featurette', 'Short'];

test('PostgreSQL Book lookups use the first real Parent and preserve null, empty and curated series values', async t => {
  const fixture = await setupChildrenFixture(t);
  fixture.configuration.PreferredMetadataLanguage = 'en';
  for (const sample of input.lookups) await t.test(sample.name, async () => {
    const parents = sample.parents.map((Name, index) => ({ key: `parent-${index}`, Id: Id(index + 2), type: 'Folder', Name,
      ParentId: index + 1 < sample.parents.length ? Id(index + 3) : null }));
    const owner = sample.ownerOnly ? [{ key: 'owner', Id: Id(99), type: 'Folder', Name: 'Owner name' }] : [];
    await fixture.seed({ target: 'target', items: [...parents.toReversed(), ...owner,
      { key: 'target', Id: Id(1), type: 'Book', Name: 'Stored title', ProductionYear: 2025, SeriesName: sample.seriesName,
        ParentId: parents[0]?.Id ?? null, OwnerId: sample.ownerOnly ? Id(99) : null }] });
    await fixture.loadContext.withContext(Id(1), {}, loaded => {
      for (const lookup of [loaded.lookup, loaded.lookupFor(loaded.item)]) assert.deepEqual({ Name: lookup.Name, Year: lookup.Year,
        SeriesName: lookup.SeriesName, MetadataLanguage: lookup.MetadataLanguage, MetadataCountryCode: lookup.MetadataCountryCode },
      native.results.find(entry => entry.name === sample.name).lookup);
    });
  });
});

test('PostgreSQL Book providers, repository failures and cancellation preserve native save prefixes', async t => {
  const fixture = await setupChildrenFixture(t);
  assert.equal(fixture.host.supports('Book'), true);
  assert.equal(fixture.host.supports('Photo'), false); assert.equal(fixture.host.supports('PhotoAlbum'), false);
  for (const sample of input.refresh) await t.test(sample.name, async () => {
    const target = { key: 'target', Id: Id(1), type: 'Book', Name: 'Stored title', ProductionYear: 2025, SeriesName: sample.seriesName,
      DateLastRefreshed: sample.first ? '0001-01-01 00:00:00' : '2026-10-01 00:00:00', IsLocked: sample.locked ?? false,
      LockedFields: sample.nameLocked ? ['Name'] : [], ...sample.provider === 'local' ? { Path: 'Z:\\ChildrenMetadata\\book.epub' } : {} };
    await fixture.seed({ target: 'target', items: [target] });
    const before = (await fixture.database.rows('BaseItems', { where: { Id: Id(1) } }))[0];
    const saves = [], lookups = [];
    let providerCalls = 0;
    const plugin = fixture.registry.register({ id: 'book-test', name: 'Book test', providers: [{
      id: 'book-provider', name: 'Controlled Book provider', kind: sample.provider ?? 'remote', itemTypes: ['Book'], hasChanged: async () => true,
      getMetadata: async info => {
        providerCalls++;
        if (sample.provider !== 'local') lookups.push({ Name: info.Name, Year: info.Year, SeriesName: info.SeriesName, IsAutomated: info.IsAutomated });
        if (sample.failure === 'provider') throw new Error('Controlled provider failure.');
        if (sample.failure === 'cancel') throw new DOMException('Controlled provider cancellation.', 'AbortError');
        return { HasMetadata: true, Item: Object.assign(newNativeItemEntity(nativeBook), {
          Name: 'Provider title', SeriesName: sample.sourceSeries, Overview: 'Provider overview' }) };
      }
    }] });
    if (sample.failure === 'repository') await fixture.database.client.query(`CREATE FUNCTION "${fixture.database.schemaName}".reject_book_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW."Overview" IS NOT NULL THEN RAISE EXCEPTION 'Controlled repository failure.'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_book_update BEFORE UPDATE ON "${fixture.database.schemaName}"."BaseItems" FOR EACH ROW EXECUTE FUNCTION "${fixture.database.schemaName}".reject_book_update()`);
    const report = ({ Item, UpdateReason }) => saves.push({ reason: UpdateReason, ...itemProjection(Item) });
    fixture.host.updates.on('ItemUpdated', report);
    let result;
    try {
      const promise = fixture.host.refresh(Id(1), { MetadataRefreshMode: sample.mode, ImageRefreshMode: 'None',
        ReplaceAllMetadata: sample.replace ?? false, RemoveOldMetadata: sample.removeOld ?? false, ForceSave: sample.force ?? false, IsAutomated: true });
      if (sample.failure === 'cancel') await assert.rejects(promise, error => error.name === 'AbortError');
      else if (sample.failure === 'repository') await assert.rejects(promise, /Controlled repository failure/u);
      else result = await promise;
    } finally {
      fixture.host.updates.off('ItemUpdated', report); fixture.registry.unregister(plugin.id);
      if (sample.failure === 'repository') await fixture.database.client.query(`DROP TRIGGER reject_book_update ON "${fixture.database.schemaName}"."BaseItems";
        DROP FUNCTION "${fixture.database.schemaName}".reject_book_update()`);
    }
    const expected = native.results.find(entry => entry.name === sample.name);
    assert.equal(providerCalls, expected.providerCalls); assert.deepEqual(lookups, expected.lookups); assert.deepEqual(saves, expected.saves);
    const saved = (await fixture.database.rows('BaseItems', { where: { Id: Id(1) } }))[0];
    assert.deepEqual(itemProjection(saved), expected.saves.length ? itemProjection(expected.saves.at(-1)) : itemProjection(before));
    assert.equal(saved.Data, null, 'Book remains a source-only native entity.');
    if (result) {
      assert.equal(result.UpdateType, expected.updateType); assert.equal(result.Failures, sample.failure === 'provider' ? 1 : 0);
      assert.deepEqual(itemProjection(result.Item), expected.item);
      assert.equal(dateTicks(saved.DateLastRefreshed) !== dateTicks(before.DateLastRefreshed), expected.stampChanged);
    } else assert.equal(dateTicks(saved.DateLastRefreshed), dateTicks(before.DateLastRefreshed));
  });
});

test('PostgreSQL Book owner discovery applies the native path gate without creating unrelated extras', async t => {
  const fixture = await setupChildrenFixture(t);
  await fixture.adapter.mkdir('/aggregate');
  await fixture.adapter.mkdir('/aggregate/Owned');
  for (const sample of ownedInput.filter(entry => entry.expectedType === 'Book')) await t.test(sample.name, async () => {
    const base = 'Z:\\ChildrenMetadata\\Owned';
    const ownerPath = path.win32.join(base, sample.ownerPath);
    await fixture.seed({ target: 'target', items: [{ key: 'parent', Id: Id(2), type: 'Folder', Path: base },
      { key: 'target', Id: Id(1), type: 'Book', Name: 'Stored owner', Path: ownerPath, parent: 'parent' }] });
    await fixture.adapter.write('/aggregate/Owned/' + sample.ownerPath, Buffer.from('owner'));
    await fixture.adapter.write('/aggregate/Owned/primary-trailer.mkv', Buffer.from('extra'));
    await fixture.loadContext.withContext(Id(1), {}, async loaded => {
      const state = await loaded.loadLibraryState();
      let found;
      try {
        found = await loaded.findOwnedExtras(state);
        const expected = ownedNative.results.find(entry => entry.name === sample.name).calls.filter(call => call.action === 'refresh' && call.item.extraType != null);
        assert.deepEqual(found.extras.map(extra => [extra.item.NativeType, extra.item.ExtraType, extra.item.Name]),
          expected.map(call => [call.item.type, call.item.extraType, call.item.name]));
      } finally { for (const extra of found?.extras ?? []) await extra.context.dispose(); await state.dispose(); }
    });
    assert.equal((await fixture.database.rows('BaseItems')).length, 2);
  });
});

test('PostgreSQL Book full refresh keeps a sibling trailer outside the non-video owner lifecycle', async t => {
  const fixture = await setupChildrenFixture(t);
  await fixture.adapter.mkdir('/aggregate'); await fixture.adapter.mkdir('/aggregate/Owned');
  await fixture.adapter.write('/aggregate/Owned/primary.epub', Buffer.from('book source'));
  await fixture.adapter.write('/aggregate/Owned/primary-trailer.mkv', Buffer.from('unrelated video source'));
  await fixture.seed({ target: 'target', items: [{ key: 'parent', Id: Id(2), type: 'Folder', Path: 'Z:\\ChildrenMetadata\\Owned' },
    { key: 'target', Id: Id(1), type: 'Book', Name: 'Stored owner', SeriesName: 'Stored series',
      Path: 'Z:\\ChildrenMetadata\\Owned\\primary.epub', parent: 'parent' }] });
  const result = await fixture.host.refresh(Id(1), { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
  assert.equal(result.Failures, 0);
  assert.deepEqual((await fixture.database.rows('BaseItems')).map(item => item.Type).sort(),
    [nativeBook, 'MediaBrowser.Controller.Entities.Folder'].sort());
  assert.equal((await fixture.vfs.stat('/fixture/aggregate/Owned/primary.epub')).size, 11n);
  assert.equal((await fixture.vfs.stat('/fixture/aggregate/Owned/primary-trailer.mkv')).size, 22n);
});
