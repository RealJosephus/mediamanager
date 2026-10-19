import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { persistItemRelations, itemHasArtist, itemHasAlbumArtist, itemSupportsAncestors } from '../../src/library/item-relations.js';
import { persistMetadata } from '../../src/metadata/persistence.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';
import { applyNativeItemValues, newNativeItemEntity } from '../../src/library/native-item-entity.js';

const root = new URL('./fixtures/item-save-relations/', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json'].map(async name => JSON.parse(await readFile(new URL(name, root), 'utf8'))));
const hash = value => createHash('sha256').update(value).digest('hex');
const compare = (actual, expected) => assert.deepEqual(actual, expected);
const relationProjection = ({ columns, ...value }) => value;
const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const blank = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => [column.name,
  column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));
const nativeType = type => type === 'PlaylistsFolder' ? 'Emby.Server.Implementations.Playlists.PlaylistsFolder'
  : type === 'Playlist' ? 'MediaBrowser.Controller.Playlists.Playlist'
  : ['Movie', 'BoxSet'].includes(type) ? `MediaBrowser.Controller.Entities.Movies.${type}`
  : ['Episode', 'Series', 'Season'].includes(type) ? `MediaBrowser.Controller.Entities.TV.${type}`
  : ['Audio', 'MusicAlbum', 'MusicArtist', 'MusicGenre'].includes(type) ? `MediaBrowser.Controller.Entities.Audio.${type}`
  : `MediaBrowser.Controller.Entities.${type}`;

test('native save relations bind actual SaveItems, all raw controls and the frozen assemblies', async () => {
  for (const file of Object.values(provenance.files)) assert.equal(hash(await readFile(new URL('../../' + file.path, import.meta.url))), file.sha256, file.path);
  assert.equal(native.inputSha256, provenance.files.input.sha256);
  assert.equal(native.sourceFilesSha256, provenance.sourceFilesSha256);
  assert.equal(provenance.runtime.jellyfinDll.sha256, '29c34541350089dc0522c4309ecd617e78fd402774681f32491d089803939c03');
  assert.equal(native.actualFrozenSaveItems, true); assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
  assert.equal(input.length, 38); assert.equal(native.results.length, input.length);
  assert.deepEqual(native.results.map(value => value.name), input.map(value => value.name));
  assert.equal(new Set(input.filter(sample => sample.name.startsWith('type-')).map(sample => sample.item.type)).size, 26);
  assert.deepEqual(native.results.map(sample => sample.exception), input.map(sample => sample.expectException ?? null));
  assert.equal(native.assemblies.length, 5);
});

test('comparison rejects dropped ancestors, stale maps and display-column mutations', () => {
  const reference = native.results.find(sample => sample.name === 'type-Audio');
  for (const mutate of [value => value.ancestors.pop(), value => value.maps.pop(), value => { value.values[0].cleanValue += '-changed'; }, value => { value.columns.AlbumArtists = null; }]) {
    const changed = structuredClone(reference); mutate(changed);
    assert.throws(() => compare(changed, reference), assert.AssertionError);
  }
});

async function fixtureFor(t, dialect, sample) {
  const schema = 'save_relations_' + randomUUID().replaceAll('-', '').slice(0, 18);
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const store = new DomainStore(database);
  t.after(async () => {
    if (dialect === 'postgres') {
      await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    }
    await store.close();
  });
  for (const item of sample.persistedItems) await database.insert('BaseItems', { ...blank('BaseItems'), Id: item.id, Type: 'MediaBrowser.Controller.Entities.Folder', Name: 'Seed' });
  for (const value of sample.values) {
    await database.insert('ItemValues', { ItemValueId: value.id, Type: value.type, Value: value.value, CleanValue: value.cleanValue });
    for (const ItemId of value.items) await database.insert('ItemValuesMap', { ItemId, ItemValueId: value.id });
  }
  for (const ParentItemId of sample.ancestors) await database.insert('AncestorIds', { ItemId: sample.item.id, ParentItemId });
  if (sample.failure) {
    const event = sample.failure === 'values' ? 'INSERT ON ItemValuesMap' : 'DELETE ON AncestorIds';
    await database.client.query(`CREATE FUNCTION "${schema}".fail_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Controlled save failure'; END $$`);
    const table = sample.failure === 'values' ? 'ItemValuesMap' : 'AncestorIds';
    await database.client.query(`CREATE TRIGGER fail_save AFTER ${sample.failure === 'values' ? 'INSERT' : 'DELETE'} ON "${schema}"."${table}" FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_save()`);
  }
  return { database, store };
}

const nativeItem = (definition, values = {}) => {
  const { id, type, ...fields } = definition;
  return applyNativeItemValues(newNativeItemEntity(nativeType(type)), fields, { Id: id }, values);
};
const itemFor = sample => nativeItem(sample.item, { Name: sample.item.type, ProviderIds: {}, LockedFields: [] });
const relatedItems = values => values.map(value => nativeItem(value));

async function capture(database, sample, exception) {
  const item = itemFor(sample), values = await database.rows('ItemValues');
  const seeded = new Set(sample.values.map(value => value.id));
  const valueId = id => {
    const value = values.find(value => value.ItemValueId.toLowerCase() === id.toLowerCase());
    assert.ok(value);
    return seeded.has(id.toLowerCase()) ? id.toLowerCase() : '$NEW/' + value.Type + '/' + value.Value;
  };
  return { name: sample.name, exception, supportsAncestors: itemSupportsAncestors(item), hasArtist: itemHasArtist(item), hasAlbumArtist: itemHasAlbumArtist(item),
    values: values.map(value => ({ id: valueId(value.ItemValueId), type: value.Type, value: value.Value, cleanValue: value.CleanValue })).sort((a, b) => ordinal(a.id, b.id)),
    maps: (await database.rows('ItemValuesMap')).map(row => ({ itemId: row.ItemId.toLowerCase(), valueId: valueId(row.ItemValueId) })).sort((a, b) => ordinal(a.itemId, b.itemId) || ordinal(a.valueId, b.valueId)),
    ancestors: (await database.rows('AncestorIds')).map(row => ({ itemId: row.ItemId.toLowerCase(), parentId: row.ParentItemId.toLowerCase() })).sort((a, b) => ordinal(a.itemId, b.itemId) || ordinal(a.parentId, b.parentId)) };
}

for (const dialect of ['postgres']) for (const sample of input) for (const mode of ['relations', 'metadata']) {
  if (mode === 'metadata' && sample.name === 'new-item') continue;
  test(`${dialect}: native ${mode} save ${sample.name}`, { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const { database, store } = await fixtureFor(t, dialect, sample), item = itemFor(sample);
    const parents = relatedItems(sample.parents), collectionFolders = relatedItems(sample.collections);
    const snapshot = (await database.rows('BaseItems', { where: { Id: item.Id } }))[0];
    const relationships = {};
    for (const table of ['BaseItemProviders', 'BaseItemMetadataFields', 'ItemValuesMap', 'AncestorIds']) relationships[table] = await database.rows(table, { where: { ItemId: item.Id } });
    const loaded = { item, snapshot, relationships, parents, collectionFolders, sortName: () => 'controlled-sort-name' };
    const cancellation = new AbortController();
    if (sample.cancelled) cancellation.abort(Object.assign(new Error('Controlled cancellation'), { nativeException: 'OperationCanceledException' }));
    let exception = null;
    try {
      for (let iteration = 0; iteration < (sample.repeat ?? 1); iteration++) {
        if (mode === 'metadata') await persistMetadata(store, loaded, { Item: item }, { signal: cancellation.signal });
        else await store.transaction(async db => {
          cancellation.signal.throwIfAborted();
          if (!snapshot && !iteration) await db.insert('BaseItems', { ...blank('BaseItems'), Id: item.Id, Type: item.NativeType, Name: item.Name });
          await persistItemRelations(db, item, { parents, collectionFolders });
        }, { signal: cancellation.signal });
      }
    } catch (error) {
      if (sample.failure) {
        assert.equal(error.code, 'P0001');
        exception = 'DbUpdateException';
      } else { assert.equal(sample.cancelled, true); exception = error.nativeException; }
    }
    const actual = await capture(database, sample, exception), expected = native.results.find(value => value.name === sample.name);
    compare(actual, relationProjection(expected));
    if (mode === 'metadata') {
      const row = (await database.rows('BaseItems', { where: { Id: item.Id } }))[0];
      compare(Object.fromEntries(['Artists', 'AlbumArtists', 'Genres', 'Studios', 'Tags'].map(key => [key, row[key]])), expected.columns);
    }
  });
}

for (const dialect of ['postgres']) test(`${dialect}: Movie metadata reload protects the actual ancestor snapshot`,
  { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const fixture = await setupChildrenFixture(t, dialect), sample = input[0];
    await fixture.seed({ target: 'movie', items: [{ key: 'root', type: 'Folder', Id: sample.parents[0].id },
      { key: 'other', type: 'Folder', Id: sample.collections[0].id }, { key: 'movie', type: 'Movie', Id: sample.item.id, parent: 'root', ancestors: ['root'] }] });
    const loaded = await fixture.loadContext(sample.item.id);
    assert.equal(loaded.relationships.AncestorIds.length, 1);
    await fixture.database.insert('AncestorIds', { ItemId: sample.item.id, ParentItemId: sample.collections[0].id });
    const before = await fixture.database.rows('BaseItems');
    loaded.item.Name = 'Changed after external ancestor edit';
    await assert.rejects(persistMetadata(fixture.store, loaded, { Item: loaded.item }), { code: 'metadata-conflict', status: 409 });
    assert.deepEqual(await fixture.database.rows('BaseItems'), before);
    assert.equal((await fixture.database.rows('AncestorIds')).length, 2);
  });
