import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { newNativeItemEntity, releaseNativeItemLinks } from '../../src/library/native-item-entity.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tableDefinition } from '../../src/database/model.js';
import { persistFolderLinks, persistImageMetadata } from '../../src/metadata/persistence.js';
import { assertMetadataBaseline, readMetadataRelationships } from '../../src/metadata/metadata-baseline.js';
import { nativePersonIdentity } from '../../src/library/metadata-context.js';
import { setupChildrenFixture } from './children-fixture.js';

test('PostgreSQL image replacement uses one set delete and one complete batch insert', async () => {
  const calls = [];
  let inserted = [];
  const database = {
    dialect: 'postgres',
    async deleteWhere(name, where) { calls.push(['deleteWhere', name, where]); },
    async insertBatch(name, rows) {
      calls.push(['insertBatch', name, rows]);
      inserted = rows;
      return BigInt(rows.length);
    },
    async insert() { throw new Error('PostgreSQL image persistence must not insert one row at a time.'); },
    async rows(name) {
      if (name === 'BaseItems') return [{ Id: '92000000-0000-0000-0000-000000000001' }];
      if (name === 'BaseItemImageInfos') return inserted;
      throw new Error(`unexpected rows(${name})`);
    },
  };
  const store = {
    database,
    serializeWrites: operation => operation(),
    run: operation => operation(database),
    transaction: operation => operation(database),
  };
  const loaded = { item: { Id: '92000000-0000-0000-0000-000000000001' }, relationships: {} };
  await persistImageMetadata(store, loaded, [
    { Type: 'Primary', Path: '/first.jpg', Width: 100, Height: 200 },
    { Type: 'Backdrop', Path: '/second.jpg', Width: 300, Height: 400 },
  ]);

  assert.deepEqual(calls.map(call => call[0]), ['deleteWhere', 'insertBatch']);
  assert.deepEqual(calls[0].slice(1), ['BaseItemImageInfos', { ItemId: loaded.item.Id }]);
  assert.equal(calls[1][1], 'BaseItemImageInfos');
  assert.equal(calls[1][2].length, 2);
  const columns = tableDefinition('BaseItemImageInfos').columns.map(column => column.name).sort();
  assert.ok(calls[1][2].every(row => assert.deepEqual(Object.keys(row).sort(), columns) === undefined));
  assert.deepEqual(loaded.relationships.BaseItemImageInfos, inserted);
});

test('a new metadata draft detects a relation inserted before its item under deferred constraints', async t => {
  const database = await createPostgresTestDatabase(t, 'metadata_draft');
  const Id = '92000000-0000-0000-0000-000000000002';
  const tables = ['BaseItemProviders', 'BaseItemMetadataFields'];
  const provider = { ItemId: Id, ProviderId: 'Tmdb', ProviderValue: '42' };
  await assert.rejects(database.transaction(async db => {
    await db.client.query('SET CONSTRAINTS ALL DEFERRED');
    const relationships = await readMetadataRelationships(db, Id, tables, { checkEmpty: true });
    assert.deepEqual(relationships, { BaseItemProviders: [], BaseItemMetadataFields: [] });
    const loaded = { item: { Id }, relationships };
    await assertMetadataBaseline(db, loaded);
    await db.insert('BaseItemProviders', provider);
    assert.deepEqual(await readMetadataRelationships(db, Id, tables, { checkEmpty: true }),
      { BaseItemProviders: [provider], BaseItemMetadataFields: [] });
    await assertMetadataBaseline(db, loaded);
  }), { code: 'metadata-conflict', status: 409 });
  assert.deepEqual(await database.rows('BaseItemProviders', { where: { ItemId: Id } }), []);
});

test('metadata contexts retain ordered item images and credits with a complete conflict baseline', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000,
}, async t => {
  const fixture = await setupChildrenFixture(t), { database } = fixture;
  const ownerId = '92000000-0000-0000-0000-000000000003';
  const person = nativePersonIdentity('Context actor', fixture.library.options);
  await fixture.seed({ target: 'owner', items: [
    { key: 'owner', type: 'Movie', Id: ownerId, Path: 'Z:\\ChildrenMetadata\\context.mkv' },
    { key: 'person', type: 'Person', Id: person.Id, Path: person.Path, Name: 'Context actor',
      ProviderIds: { Custom: 'actor-id' } },
  ] });
  const peopleId = '92000000-0000-0000-0000-000000000004';
  await database.insert('Peoples', { Id: peopleId, Name: 'Context actor', PersonType: 'Actor' });
  for (const [Role, ListOrder] of [['Alpha role', 9], ['Zulu role', 0]]) {
    await database.insert('PeopleBaseItemMap', { ItemId: ownerId, PeopleId: peopleId, Role, ListOrder, SortOrder: null });
  }
  const images = [];
  for (const [index, [ItemId, Id, ImageType]] of [
    [person.Id, '92000000-0000-0000-0000-000000000005', 0],
    [ownerId, '92000000-0000-0000-0000-000000000009', 2],
    [ownerId, '92000000-0000-0000-0000-000000000006', 2],
  ].entries()) {
    images.push(await database.insert('BaseItemImageInfos', postgresTestRow('BaseItemImageInfos', {
      Id, ItemId, ImageType, Path: path.join(fixture.stateRoot, 'metadata', `context-${index}.jpg`),
      DateModified: '2024-01-02T03:04:05.1234567Z', Width: 200 + index, Height: 100 + index,
      Blurhash: Buffer.from('image-' + index),
    })));
  }
  const loaded = await fixture.loadContext(ownerId);
  assert.deepEqual(loaded.context.images, images.slice(1).map(image => ({ ...image, Type: 'Backdrop' })));
  assert.deepEqual(loaded.context.people, ['Zulu role', 'Alpha role'].map(Role => ({
    Name: 'Context actor', Type: 'Actor', Role, SortOrder: null,
    ProviderIds: { Custom: 'actor-id' }, ImagePath: images[0].Path,
  })));
  for (const table of ['PeopleBaseItemMap', 'BaseItemImageInfos']) {
    assert.deepEqual(loaded.relationships[table], await database.rows(table, { where: { ItemId: ownerId } }));
  }
  await fixture.store.run(db => assertMetadataBaseline(db, loaded));
  await assert.rejects(database.transaction(async db => {
    await db.insert('BaseItemProviders', { ItemId: ownerId, ProviderId: 'Changed', ProviderValue: 'later' });
    await assertMetadataBaseline(db, loaded);
  }), { code: 'metadata-conflict', status: 409 });
  assert.deepEqual(await database.rows('BaseItemProviders', { where: { ItemId: ownerId } }), []);
  await loaded.dispose();
});

test('folder link path fallback uses the primary-key ordered SQL union of bounded candidates', async t => {
  const parentId = '92000000-0000-0000-0000-000000000010';
  const lowerId = '92000000-0000-0000-0000-000000000011';
  const explicitId = '92000000-0000-0000-0000-000000000012';
  const sharedPath = 'Z:\\library\\shared.mkv';
  const database = await createPostgresTestDatabase(null, 'link_shape');
  const linkedChildren = new PostgresLinkedChildrenStore({ database });
  const item = newNativeItemEntity('MediaBrowser.Controller.Entities.Folder'); item.Id = parentId;
  t.after(async () => {
    const errors = []; releaseNativeItemLinks(item);
    for (const close of [() => linkedChildren.flushReleases(), () => linkedChildren.close(), () => dropPostgresTestDatabase(database)]) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Folder link shaping resources failed to close.');
  });
  await linkedChildren.initialize();
  await database.insert('BaseItems', postgresTestRow('BaseItems', {
    Id: item.Id, Type: item.NativeType, Name: 'Parent folder', IsFolder: true, Data: null
  }));
  for (const Id of [lowerId, explicitId]) await database.insert('BaseItems', postgresTestRow('BaseItems', {
    Id, Path: sharedPath, Type: 'MediaBrowser.Controller.Entities.Movies.Movie', IsFolder: false, Data: '{}'
  }));
  await database.withConnection(async session => {
    const writer = await linkedChildren.createWriter({ session, parentId });
    try {
      await writer.append({ ItemId: explicitId, Path: sharedPath, Type: 0 });
      await writer.append({ Path: sharedPath, Type: 0 });
      item.LinkedChildren = await writer.finish();
    } catch (error) { await writer.abort(); throw error; }
  });
  await database.transaction(session => persistFolderLinks(session, item, { linkedChildren }));
  const inserted = await database.rows('LinkedChildren', { where: { ParentId: parentId }, orderBy: [{ column: 'SortOrder', direction: 'ASC' }] });
  assert.deepEqual(inserted.map(row => row.ChildId), [explicitId, lowerId]);
});
