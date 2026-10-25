import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeTextBytes } from '../../src/database/native-text.js';
import { queryPostgresItemPage } from '../../src/database/postgres-item-query.js';
import { postgresParentalRatingContext } from '../../src/library/parental-rating.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { LibraryService } from '../../src/library/library-service.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { setFolderChildren } from '../../src/library/folder-cache.js';
import { rootCollectionType } from '../../src/library/root-collection-type.js';
import { idKey } from '../../src/library/records.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString,
  postgresTestRow } from './postgres-fixture.js';

export const requiredValidationServices = ['postgres'];
const id = value => `46b30000-0000-0000-0000-${String(value).padStart(12, '0')}`;
const type = name => 'MediaBrowser.Controller.Entities.' + name;
const bytes = value => value === null ? null : nativeTextBytes(value);
const row = (value, name, fields = {}) => postgresTestRow('BaseItems', {
  Id: id(value), Type: type(name), Name: name, SortName: String(value), Data: '{}', ...fields,
});

test('postgres: one live root relation supplies country, tags and BoxSet membership before count and paging', {
  skip: !postgresTestConnectionString, timeout: 120000,
}, async t => {
  const database = await createPostgresTestDatabase(null, 'root_folder_plan', { max: 1 });
  t.after(() => dropPostgresTestDatabase(database));
  await database.insertBatch('BaseItems', [
    row(1, 'AggregateFolder', { IsFolder: true, Path: '/root' }),
    row(10, 'CollectionFolder', { IsFolder: true, Path: '/stored/config', Tags: '', PreferredMetadataCountryCode: 'US' }),
    row(11, 'Folder', { ParentId: id(1), IsFolder: true, Path: '/media/A' }),
    row(20, 'Movies.Movie', { ParentId: id(11), Path: '/media/A/feature.mkv', OfficialRating: 'R' }),
    row(30, 'Movies.BoxSet', { IsFolder: true, Path: '/collections/current' }),
  ]);
  await database.insert('LinkedChildren', { ParentId: id(30), SortOrder: 0, ChildId: id(20), ChildType: 0 });
  const table = `"${database.schemaName}".root_folder_control`;
  await database.client.query(`CREATE TABLE ${table}("Scope" text,"Ordinal" bigint,"Id" bytea,"NativeType" bytea,
    "Path" bytea,"PhysicalLocations" bytea[],"PreferredCountry" bytea,"Tags" bytea[])`);
  for (const [ordinal, folderId, country, tags] of [[5, id(10), 'CA', ['FolderBlock']], [10, id(12), 'US', []]]) {
    await database.client.query({ text: `INSERT INTO ${table} VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      values: ['current', ordinal, bytes(folderId), bytes(type('CollectionFolder')), bytes('/live/config'),
        [bytes('/MEDIA/a')], bytes(country), tags.map(bytes)] });
  }
  // BigInt parameters and pre-existing query bindings must survive embedding.
  // The source is a real SQL relation whose later mutations remain visible.
  const foldersPlan = Object.freeze({ text: `SELECT "Ordinal","Id","NativeType","Path","PhysicalLocations","PreferredCountry","Tags"
    FROM ${table} WHERE "Scope"=$1::text AND "Ordinal">=$2::bigint`, values: Object.freeze(['current', 1n]) });
  const context = postgresParentalRatingContext({ configuration: { MetadataCountryCode: 'US' } }, foldersPlan);
  assert.equal(context.foldersPlan, foldersPlan);
  assert.equal(Object.hasOwn(context, 'folders'), false);
  const visible = async (ratingContext = context, extra = {}) => queryPostgresItemPage(database, {
    ids: [id(30)], sortby: ['Name'], startindex: 0, limit: 1,
  }, { resumableMode: 'memory', visibility: {
    maxRating: 17, boxSetChildRatingMode: 'memory', ratingContext, ...extra,
  } });
  assert.equal((await visible()).total, 0, 'The first live folder country overrides the stored US folder.');
  await database.client.query(`UPDATE ${table} SET "PreferredCountry"=NULL WHERE "Ordinal"=5`);
  assert.equal((await visible()).total, 1, 'A later preferred country precedes library-option country.');
  await database.client.query(`UPDATE ${table} SET "PreferredCountry"=NULL`);
  const configured = postgresParentalRatingContext({
    configuration: { MetadataCountryCode: 'US' },
    libraryOptions: new Map([[idKey(id(10)), { MetadataCountryCode: 'CA' }]]),
  }, foldersPlan);
  assert.equal((await visible(configured)).total, 0, 'The first matching live folder selects explicit library options.');
  assert.equal((await visible(context, { maxRating: 100, blockedTags: ['folderblock'] })).total, 0,
    'Blocked tags use the live root relation rather than stored tags.');
  await database.client.query(`UPDATE ${table} SET "Tags"=ARRAY[]::bytea[]`);
  const allowed = await visible(context, { maxRating: 100, blockedTags: ['folderblock'] });
  assert.equal(allowed.total, 1); assert.deepEqual(allowed.rows.map(item => idKey(item.Id)), [idKey(id(30))]);
  const membership = () => queryPostgresItemPage(database, { ids: [id(30)], limit: 1 }, {
    resumableMode: 'memory', visibility: {
      topParentIds: [], boxSetStandalone: true, boxSetUserRootIds: [id(10)], boxSetRootFoldersPlan: foldersPlan,
    },
  });
  assert.equal((await membership()).total, 1);
  await database.client.query({ text: `UPDATE ${table} SET "PhysicalLocations"=$1 WHERE "Ordinal"=5`,
    values: [[bytes('/different')]] });
  assert.equal((await membership()).total, 0, 'An inaccessible remaining match cannot expose the BoxSet.');
  await database.client.query(`UPDATE ${table} SET "PhysicalLocations"=NULL WHERE "Ordinal"=5`);
  await assert.rejects(membership, undefined, 'A mismatched null locations list must retain its failure.');
  await database.client.query({ text: `UPDATE ${table} SET "Path"=$1 WHERE "Ordinal"=5`, values: [bytes('/MEDIA/a')] });
  assert.equal((await membership()).total, 1, 'An exact path match short-circuits the null list.');

  await database.client.query({ text: `UPDATE ${table} SET "PreferredCountry"=$1 WHERE "Ordinal"=5`, values: [bytes('CA')] });
  await database.client.query({ text: `INSERT INTO ${table} VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    values: ['current', 20, bytes(id(13)), bytes(type('CollectionFolder')), bytes('/late/mismatch'), null, null, []] });
  await assert.rejects(visible, undefined,
    'Country selection completes raw membership before reading the first preferred country.');
  await database.update('BaseItems', { Id: id(20) }, { PreferredMetadataCountryCode: 'US' });
  assert.equal((await visible()).total, 1, 'An item country short-circuits the entire folder membership read.');
  await database.update('BaseItems', { Id: id(20) }, { PreferredMetadataCountryCode: null });
  await database.client.query({ text: `UPDATE ${table} SET "PhysicalLocations"=$1,"Tags"=NULL WHERE "Ordinal"=20`,
    values: [[bytes('/media/A')]] });
  assert.equal((await visible()).total, 0, 'Country resolution does not consume matched folder Tags.');
  await database.client.query({ text: `UPDATE ${table} SET "Tags"=$1 WHERE "Ordinal"=5`, values: [[bytes('FolderBlock')]] });
  await assert.rejects(() => visible(context, { maxRating: 100, blockedTags: ['folderblock'] }), undefined,
    'Inherited tags are fully collected before an earlier blocked match can return.');
  await assert.rejects(() => visible(context, { maxRating: 100, blockedTags: ['   '] }), undefined,
    'A nonempty raw preference still reads inherited tags when normalization removes every name.');
});

test('postgres: content-type selection stops at the first current value and keeps ordinal nullable locations', {
  skip: !postgresTestConnectionString, timeout: 120000,
}, async t => {
  const database = await createPostgresTestDatabase(null, 'root_content_type', { max: 1 });
  const linkedChildren = new PostgresLinkedChildrenStore({ database });
  await linkedChildren.initialize();
  const store = new DomainStore(database), library = new LibraryService({ store, linkedChildren, serverId: 'root-content-type',
    userRoot: { Id: id(2), Type: type('UserRootFolder'), Path: '/root/default' } });
  const manager = new ItemCreationService({ store, library, linkedChildren,
    loadContext: async () => { throw new Error('Refresh is outside this root read.'); } });
  library.itemCreation = manager;
  t.after(async () => {
    const failures = [];
    for (const action of [() => manager.close(), () => library.close(),
      () => linkedChildren.flushOwnedReleases(), () => linkedChildren.close(), () => dropPostgresTestDatabase(database)]) {
      try { await action(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Content-type root resources failed to close.');
  });
  await database.insert('BaseItems', row(2, 'UserRootFolder', { IsFolder: true, Path: '/root/default' }));
  const root = await manager.getItemById(id(2));
  const folder = (value, fields) => Object.assign(newNativeItemEntity(type('CollectionFolder')), { Id: id(value), ...fields });
  const first = folder(10, { Path: '/media/A', CollectionType: 'movies', PhysicalLocationsList: [] });
  const later = folder(12, { Path: '/different', CollectionType: 'music', PhysicalLocationsList: null });
  const parent = Object.assign(newNativeItemEntity(type('Folder')), { Id: id(11), Path: '/media/A' });
  const movie = Object.assign(newNativeItemEntity(type('Movies.Movie')), { Id: id(20), ParentId: parent.Id });
  const read = async () => {
    const state = await store.run(async () => ({
      get db() { throw new Error('The original state session must not be reused.'); },
      items: [root, parent, movie], byId: new Map([root, parent, movie].map(item => [idKey(item.Id), item])),
    }));
    return rootCollectionType(library, movie, state);
  };
  setFolderChildren(root, [first, later]);
  assert.equal(await read(), 'movies', 'A later invalid list is not consumed after the first non-null value.');
  first.CollectionType = null;
  await assert.rejects(read, { status: 500 }, 'The next list is consumed after a matching null content type.');
  first.CollectionType = 'movies'; first.Path = '/different'; first.PhysicalLocationsList = ['/MEDIA/a'];
  setFolderChildren(root, [first]);
  assert.equal(await read(), null, 'The physical-location overload uses ordinal string equality.');
  first.PhysicalLocationsList = [null]; parent.Path = '';
  assert.equal(await read(), null, 'A null location is distinct from the empty string.');
  parent.Path = null;
  assert.equal(await read(), 'movies', 'A null location matches a null top-folder path.');
});
