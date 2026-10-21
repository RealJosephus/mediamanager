import { testFileSystem } from '../storage/plugin-files.js';
import { attachLibraryNavigation, closeLibraryNavigation } from './navigation-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition, quoteIdentifier } from '../../src/database/model.js';
import { loadLibrary, idKey, guid, MIN_DATE, VIDEO_TYPES } from '../../src/library/records.js';
import { nativePersonIdentity } from '../../src/library/identity.js';
import { dtoOptions, projectItem } from '../../src/library/dto.js';
import { LibraryService } from '../../src/library/library-service.js';
import { stringifyNativeJson } from '../../src/core/json.js';
import { clrTrim } from '../../src/metadata/whitespace.js';

const input = JSON.parse(readFileSync(new URL('./fixtures/dto-details/input.json', import.meta.url)));
const native = JSON.parse(readFileSync(new URL('./fixtures/dto-details/native.json', import.meta.url)));
const options = { programDataPath: input.programDataPath, serverId: 'dto-details' };
const empty = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated)
  .map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : ['uint', 'long'].includes(column.clrType) ? 0n : 0]));
const syntheticId = number => `10000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const floatFields = ['CriticRating', 'CommunityRating', 'NormalizationGain', 'AlbumNormalizationGain'];
const nativeType = type => `MediaBrowser.Controller.Entities.${['Audio', 'MusicAlbum', 'MusicArtist', 'MusicGenre'].includes(type) ? 'Audio.' : type === 'Movie' ? 'Movies.' : ''}${type}`;

async function insertItem(db, input, id = syntheticId(1)) {
  const { Image, Canonical, ...item } = input;
  const row = { ...empty('BaseItems'), DateModified: MIN_DATE, Data: '{}', ...item, Id: guid(item.Id ?? id).toUpperCase(),
    Type: nativeType(item.Type), MediaType: VIDEO_TYPES.has(item.Type) ? 'Video' : ['Audio', 'AudioBook'].includes(item.Type) ? 'Audio' : 'Unknown',
    IsFolder: ['Folder', 'MusicAlbum', 'MusicArtist'].includes(item.Type), Path: item.Path ?? null };
  for (const key of ['Genres', 'Studios', 'Tags']) row[key] = (item[key] ?? []).join('|');
  for (const field of ['CriticRating', 'CommunityRating', 'NormalizationGain', 'LUFS']) if (row[field] != null) row[field] = Math.fround(row[field]);
  await db.insert('BaseItems', row);
  if (Image) await db.insert('BaseItemImageInfos', { ...empty('BaseItemImageInfos'), Id: row.Id, ItemId: row.Id, ImageType: 0,
    Path: Image.Path, DateModified: Image.DateModified, Width: Image.Width, Height: Image.Height,
    Blurhash: Image.BlurHash == null ? null : Buffer.from(Image.BlurHash) });
  return row.Id;
}

async function compare(db) {
  for (const entry of input.cases) {
    for (const table of ['BaseItemImageInfos', 'PeopleBaseItemMap', 'Peoples', 'BaseItems']) {
      for (const row of await db.rows(table)) await db.delete(table, Object.fromEntries(tableDefinition(table).primaryKey.map(key => [key, row[key]])));
    }
    const expected = native.results.find(row => row.name === entry.name);
    let itemId, selected, user = null;
    if (entry.kind === 'people') {
      itemId = await insertItem(db, { Type: 'Movie', Name: 'Synthetic' });
      for (const entity of entry.entities) {
        const identity = nativePersonIdentity(entity.Name, options);
        await insertItem(db, { ...entity, Id: entity.Canonical === false ? entity.Id : identity.Id, Path: identity.Path });
      }
      for (const [index, person] of entry.people.entries()) {
        const personId = syntheticId(index + 100);
        await db.insert('Peoples', { ...empty('Peoples'), Id: personId, Name: person.Name, PersonType: person.PersistedPersonType ?? person.Type });
        await db.insert('PeopleBaseItemMap', { ...empty('PeopleBaseItemMap'), ItemId: itemId, PeopleId: personId,
          ListOrder: index, SortOrder: person.SortOrder ?? null, Role: person.Role == null ? '' : clrTrim(person.Role) });
      }
      if (entry.user) user = { Id: syntheticId(99), Policy: entry.user };
      selected = ['People'];
    } else if (entry.kind === 'names') {
      itemId = await insertItem(db, entry.item);
      // Native GetGenreId/GetStudioId must not reuse an arbitrary same-name row.
      for (const [index, type] of ['Genre', 'MusicGenre', 'Studio'].entries())
        await insertItem(db, { Type: type, Name: type === 'Studio' ? 'Studio' : 'Rock' }, syntheticId(index + 10));
      selected = ['Genres', 'Studios'];
    } else {
      for (const item of entry.items) await insertItem(db, item);
      itemId = entry.query;
      selected = [];
    }
    const state = await loadLibrary(db, {}, { baseRows: await db.rows('BaseItems') });
    const item = state.byId.get(idKey(itemId));
    if (entry.kind === 'float') {
      // The DLL fixture constructs float objects directly. Preserve negative zero
      // here because a persisted numeric zero does not retain that sign bit.
      for (const source of entry.items) for (const key of ['CriticRating', 'CommunityRating', 'NormalizationGain', 'LUFS'])
        if (source[key] != null) state.byId.get(idKey(source.Id))[key] = Math.fround(source[key]);
    }
    const dto = JSON.parse(stringifyNativeJson(await projectItem(item, state, user, dtoOptions({ fields: selected, enableuserdata: false }), options)));
    const keys = entry.kind === 'people' ? ['People', 'ImageBlurHashes'] : entry.kind === 'names' ? ['GenreItems', 'Studios'] : [...floatFields, 'AlbumId'];
    const pick = value => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
    assert.deepEqual(pick(dto), pick(entry.kind === 'people' ? { ...expected, People: expected.persistedPeople } : expected), entry.name);
  }

  for (const table of ['BaseItemImageInfos', 'PeopleBaseItemMap', 'Peoples', 'BaseItems']) {
    for (const row of await db.rows(table)) await db.delete(table, Object.fromEntries(tableDefinition(table).primaryKey.map(key => [key, row[key]])));
  }
  const ownerId = await insertItem(db, { Type: 'Movie', Name: 'Typed extra owner' }, syntheticId(200));
  await insertItem(db, { Type: 'Video', Name: 'Featurette', OwnerId: ownerId, ExtraType: 10 }, syntheticId(201));
  await insertItem(db, { Type: 'Video', Name: 'Local trailer', OwnerId: ownerId, ExtraType: 2 }, syntheticId(202));
  const state = await loadLibrary(db, {}, { baseRows: await db.rows('BaseItems') });
  assert.equal(state.byId.get(idKey(syntheticId(201))).ExtraType, 'Featurette');
  const dto = await projectItem(state.byId.get(idKey(ownerId)), state, null,
    dtoOptions({ fields: ['LocalTrailerCount', 'SpecialFeatureCount'], enableuserdata: false }), options);
  assert.deepEqual({ LocalTrailerCount: dto.LocalTrailerCount, SpecialFeatureCount: dto.SpecialFeatureCount },
    { LocalTrailerCount: 1, SpecialFeatureCount: 1 });
}

test('PostgreSQL library state loaders fail closed without an explicit SQL scope', async () => {
  const db = { dialect: 'postgres', rows: async () => { throw new Error('unbounded read'); } };
  await assert.rejects(loadLibrary(db), /requires SQL-scoped baseRows/u);
  const library = new LibraryService({fileSystem: testFileSystem,  store: {}, serverId: 'scope-guard' });
  await assert.rejects(library.load(db, null), /requires SQL-scoped baseRows/u);
});

test(`${input.cases.length} actual DLL detail cases match on real PostgreSQL`, { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async () => {
  const schema = `dto_details_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const db = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  try { await compare(db); }
  finally {
    await db.client.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await db.client.query(`DROP SCHEMA ${quoteIdentifier(schema + '__mm')} CASCADE`);
    await db.close();
  }
});

test('real PostgreSQL People projection hydrates only the path-derived person identity', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async () => {
  const schema = `dto_people_bounds_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const db = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true,
  });
  try {
    const name = 'Bounded Person';
    const movieId = await insertItem(db, { Type: 'Movie', Name: 'Bounded people owner' }, syntheticId(300));
    const identity = nativePersonIdentity(name, options);
    await insertItem(db, { Type: 'Person', Name: name, Id: identity.Id, Path: identity.Path });
    for (let index = 0; index < 128; index++) {
      await insertItem(db, { Type: 'Person', Name: name }, syntheticId(1000 + index));
    }
    const peopleId = syntheticId(400);
    await db.insert('Peoples', { ...empty('Peoples'), Id: peopleId, Name: name, PersonType: 'Actor' });
    await db.insert('PeopleBaseItemMap', { ...empty('PeopleBaseItemMap'),
      ItemId: movieId, PeopleId: peopleId, ListOrder: 0, Role: 'Lead' });

    const movieRows = await db.rows('BaseItems', { where: { Id: movieId } });
    const state = await loadLibrary(db, options, { baseRows: movieRows });
    const hydrated = [];
    const rows = db.rows.bind(db);
    db.rows = (table, queryOptions) => {
      if (table === 'BaseItems') hydrated.push([...(queryOptions?.whereIn?.Id ?? [])]);
      return rows(table, queryOptions);
    };
    const dto = await projectItem(state.byId.get(idKey(movieId)), state, null,
      dtoOptions({ fields: ['People'], enableuserdata: false }), options);
    assert.deepEqual(dto.People.map(person => person.Id), [identity.Id.replaceAll('-', '').toLowerCase()]);
    assert.deepEqual(hydrated, [[identity.Id]]);
  } finally {
    await db.client.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await db.client.query(`DROP SCHEMA ${quoteIdentifier(schema + '__mm')} CASCADE`);
    await db.close();
  }
});

test('real PostgreSQL item DTO pages batch every requested relation independently of page size', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = `dto_page_bounds_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const db = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true,
  });
  let library;
  t.after(async () => {
    db.queryHook = null;
    await closeLibraryNavigation(library);
    await db.client.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await db.client.query(`DROP SCHEMA ${quoteIdentifier(schema + '__mm')} CASCADE`);
    await db.close();
  });

  const personName = 'Page Person';
  const personIdentity = nativePersonIdentity(personName, options);
  await insertItem(db, { Type: 'Person', Name: personName, Path: personIdentity.Path }, personIdentity.Id);
  const creditId = syntheticId(850);
  await db.insert('Peoples', { ...empty('Peoples'), Id: creditId, Name: personName, PersonType: 'Actor' });
  const movieIds = [];
  for (let index = 0; index < 6; index++) {
    const itemId = await insertItem(db, {
      Type: 'Movie', Name: `Batch movie ${index}`, Path: `C:\\media\\batch-${index}.mkv`,
      Image: { Path: `C:\\metadata\\batch-${index}.jpg`, DateModified: '2026-10-01 00:00:00', Width: 1920, Height: 1080 },
    }, syntheticId(900 + index));
    movieIds.push(itemId);
    await db.insert('PeopleBaseItemMap', { ...empty('PeopleBaseItemMap'), ItemId: itemId,
      PeopleId: creditId, Role: 'Lead', ListOrder: 0 });
    await db.insert('MediaStreamInfos', { ...empty('MediaStreamInfos'), ItemId: itemId,
      StreamIndex: 0, StreamType: 1, Width: 1920, Height: 1080 });
    await db.insert('AttachmentStreamInfos', { ...empty('AttachmentStreamInfos'), ItemId: itemId,
      Index: 0, Filename: `attachment-${index}.bin` });
    await db.insert('MediaSegments', { ...empty('MediaSegments'), Id: syntheticId(1000 + index),
      ItemId: itemId });
    await db.insert('TrickplayInfos', { ...empty('TrickplayInfos'), ItemId: itemId, Width: 320 });
    await db.insert('Chapters', { ...empty('Chapters'), ItemId: itemId, ChapterIndex: 0,
      Name: `Chapter ${index}` });
    await db.insert('BaseItemMetadataFields', { ...empty('BaseItemMetadataFields'), ItemId: itemId, Id: 0 });
  }
  const folderIds = [];
  for (let index = 0; index < 3; index++) {
    const folderId = await insertItem(db, {
      Type: 'Folder', Name: `Batch folder ${index}`, Path: `C:\\media\\folder-${index}`,
    }, syntheticId(1200 + index));
    folderIds.push(folderId);
    for (let child = 0; child <= index; child++) {
      await insertItem(db, {
        Type: 'Movie', Name: `Folder ${index} child ${child}`, ParentId: folderId,
        Path: `C:\\media\\folder-${index}\\child-${child}.mkv`,
      }, syntheticId(1300 + index * 10 + child));
    }
  }

  const captured = [];
  const childCountQueries = [];
  db.queryHook = async (...args) => {
    const result = await db.client.query(...args);
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
    if (/"(?:BaseItemImageInfos|PeopleBaseItemMap|Peoples|MediaStreamInfos|AttachmentStreamInfos|MediaSegments|TrickplayInfos|Chapters|BaseItemMetadataFields)"/u.test(text)) {
      captured.push(text);
    }
    if (text.includes('/* dto-child-counts */')) childCountQueries.push(text);
    return result;
  };
  library = new LibraryService({fileSystem: testFileSystem,
    store: new DomainStore(db), serverId: 'dto-page-bounds', programDataPath: options.programDataPath,
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
  });
  await attachLibraryNavigation(library);
  const result = await library.queryItems({
    Ids: movieIds.join(','), Limit: String(movieIds.length), EnableImages: 'true',
    Fields: 'People,MediaSources,MediaStreams,Chapters,Trickplay,Settings,PrimaryImageAspectRatio',
  });

  assert.equal(result.Items.length, movieIds.length);
  assert.equal(captured.filter(text => /FROM "MediaStreamInfos"/u.test(text)).length, 1);
  assert.equal(captured.filter(text => /FROM "AttachmentStreamInfos"/u.test(text)).length, 1);
  assert.equal(captured.filter(text => /FROM "MediaSegments"/u.test(text)).length, 1);
  assert.equal(captured.filter(text => /FROM "TrickplayInfos"/u.test(text)).length, 1);
  assert.equal(captured.filter(text => /FROM "Chapters"/u.test(text)).length, 1);
  assert.equal(captured.filter(text => /FROM "PeopleBaseItemMap"/u.test(text)).length, 1);
  assert.equal(captured.filter(text => /FROM "Peoples"/u.test(text)).length, 1);
  assert.equal(captured.some(text => /"ItemId"\s*=\s*\$\d+/u.test(text)), false,
    'no requested DTO relation may be read once per projected item');

  const user = { Id: syntheticId(2000), Configuration: {},
    Policy: { EnableAllFolders: true, BlockedTags: [], AllowedTags: [], BlockUnratedItems: [] } };
  const folders = await library.queryItems({
    Ids: folderIds.join(','), Limit: String(folderIds.length), EnableImages: 'false',
    EnableUserData: 'false', Fields: 'ChildCount', IncludeItemTypes: 'Folder',
  }, { user });
  db.queryHook = null;
  assert.deepEqual(folders.Items.map(item => item.ChildCount), [1, 2, 3]);
  assert.equal(childCountQueries.length, 1,
    'one grouped PostgreSQL count must serve every folder on the DTO page');
});
