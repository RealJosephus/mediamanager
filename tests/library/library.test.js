import { testFileSystem } from '../storage/plugin-files.js';
import { attachLibraryNavigation, closeLibraryNavigation } from './navigation-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { LibraryService } from '../../src/library/index.js';
import { parseQuery } from '../../src/library/query.js';
import { dateText, dateTicks, cleanValue } from '../../src/library/records.js';
import { stringifyNativeJson } from '../../src/core/json.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';

const ids = Object.fromEntries(['root', 'collection', 'physical', 'movie', 'other', 'restricted', 'hidden', 'alternate', 'user'].map((name, index) => [name, `A1111111-1111-1111-1111-${String(index + 1).padStart(12, '0')}`]));
const user = { Id: ids.user, Username: 'Reader', MaxParentalRatingScore: null, MaxParentalRatingSubScore: null, Policy: { EnableAllFolders: true, EnabledFolders: [], BlockedMediaFolders: [], BlockedTags: [], AllowedTags: [], BlockUnratedItems: [], EnableMediaPlayback: true, EnableContentDownloading: true, EnablePlaybackRemuxing: false }, Configuration: {} };

function emptyRow(table) {
  return Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'uint' || column.clrType === 'long' ? 0n : 0]));
}
function item(id, type, Name, extra = {}) {
  return { ...emptyRow('BaseItems'), Id: id, PresentationUniqueKey: id, Type: `MediaBrowser.Controller.Entities.${type === 'Movie' ? 'Movies.Movie' : type}`, Name, CleanName: cleanValue(Name), SortName: cleanValue(Name), IsFolder: type !== 'Movie', MediaType: type === 'Movie' ? 'Video' : 'Unknown', Data: '{}', Tags: '', Genres: '', Studios: '', ProductionLocations: '', ...extra };
}
async function seed(db) {
  await db.insert('Users', { ...emptyRow('Users'), Id: ids.user, Username: 'Reader', NormalizedUsername: 'READER', InternalId: 1 });
  await db.insert('BaseItems', item(ids.root, 'UserRootFolder', 'Media Folders'));
  await db.insert('BaseItems', item(ids.collection, 'CollectionFolder', 'Movies', { ParentId: ids.root, Data: JSON.stringify({ CollectionType: 'movies', PhysicalFolderIds: [ids.physical], PhysicalLocationsList: ['Z:\\Movies'] }) }));
  await db.insert('BaseItems', item(ids.physical, 'Folder', 'Physical', { Path: 'Z:\\Movies', TopParentId: ids.physical }));
  for (const [name, title, year, rating, tags] of [['movie', 'Alpha 中文', 2020, 10, 'Family'], ['other', 'Beta Film', 2024, 13, 'Family'], ['restricted', 'Restricted', 2022, 18, 'Adults'], ['hidden', 'Hidden Film', 2026, null, 'blocked-tag']]) {
    await db.insert('BaseItems', item(ids[name], 'Movie', title, { ParentId: ids.physical, TopParentId: ids.physical, Path: `Z:\\Movies\\${title}.mkv`, ProductionYear: year, RunTimeTicks: 9007199254740993n, InheritedParentalRatingValue: rating, UnratedType: 'Movie', Tags: tags, Overview: `${title} overview`, Data: '{"VideoType":"VideoFile"}', DateCreated: '2026-09-20 12:00:00.1234567' }));
    await db.insert('AncestorIds', { ItemId: ids[name], ParentItemId: ids.physical });
    const existingValue = (await db.rows('ItemValues', { where: { Type: 4, Value: tags } }))[0];
    const valueId = existingValue?.ItemValueId ?? `B1111111-1111-1111-1111-${ids[name].slice(-12)}`;
    if (!existingValue) await db.insert('ItemValues', { ItemValueId: valueId, Type: 4, Value: tags, CleanValue: cleanValue(tags) });
    await db.insert('ItemValuesMap', { ItemValueId: valueId, ItemId: ids[name] });
  }
  await db.insert('BaseItems', item(ids.alternate, 'Movie', 'Alpha 4k', { ParentId: ids.physical, TopParentId: ids.physical, PrimaryVersionId: ids.movie, Path: 'Z:\\Movies\\Alpha 4k.mkv' }));
  await db.insert('UserData', { ...emptyRow('UserData'), UserId: ids.user, ItemId: ids.movie, CustomDataKey: ids.movie.toLowerCase(), PlaybackPositionTicks: 9007199254740991n, IsFavorite: true, PlayCount: 2 });
  await db.insert('UserData', { ...emptyRow('UserData'), UserId: ids.user, ItemId: ids.other, CustomDataKey: ids.other.toLowerCase(), Played: true, PlayCount: 1 });
}
async function service(db) {
  const library = new LibraryService({fileSystem: testFileSystem, store: new DomainStore(db), serverId: 'library-test', programDataPath: 'D:\\native-state',
    userRoot: item(ids.root, 'UserRootFolder', 'Media Folders') });
  await attachLibraryNavigation(library); return library;
}

async function assertions(library) {
  const page = await library.queryItems({ IncludeItemTypes: 'Movie', SortBy: 'ProductionYear', SortOrder: 'Descending', StartIndex: '1', Limit: '2' }, { user });
  assert.equal(page.TotalRecordCount, 4);
  assert.deepEqual(page.Items.map(item => item.Name), ['Beta Film', 'Restricted']);
  const record = await library.getItemRecord(ids.movie.replaceAll('-', '').toLowerCase(), { user });
  assert.equal(record.Id, ids.movie);
  assert.equal(record.RunTimeTicks, 9007199254740993n);
  const favorites = await library.queryItems({ IsFavorite: 'true' }, { user });
  assert.deepEqual(favorites.Items.map(item => item.Name), ['Alpha 中文']);
  assert.equal(favorites.Items[0].UserData.PlaybackPositionTicks, 9007199254740991n);
  const unplayed = await library.queryItems({ IncludeItemTypes: 'Movie', Filters: 'IsUnplayed', SortBy: 'SortName' }, { user });
  assert.equal(unplayed.Items.some(item => item.Name === 'Beta Film'), false);
  const disabled = await library.queryItems({ IncludeItemTypes: 'Movie', EnableUserData: false, EnableImages: false, EnableTotalRecordCount: false }, { user });
  assert.equal(disabled.TotalRecordCount, 4);
  assert.equal('UserData' in disabled.Items[0], false);
  assert.equal('ImageTags' in disabled.Items[0], false);
  const search = await library.queryItems({ SearchTerm: 'Alpha', Fields: 'DateCreated,Path,Overview' }, { user });
  assert.equal(search.Items.length, 1);
  assert.equal(search.Items[0].DateCreated, '2026-09-20T12:00:00.1234567Z');
  const noAccess = { ...user, Policy: { ...user.Policy, EnableAllFolders: false } };
  assert.equal((await library.queryItems({ Recursive: true }, { user: noAccess })).Items.length, 0);
  await assert.rejects(library.getItemRecord(ids.movie, { user: noAccess }), error => error.status === 404);
  const limited = { ...user, MaxParentalRatingScore: 13, Policy: { ...user.Policy, BlockedTags: ['blocked tag'], AllowedTags: ['family'], BlockUnratedItems: ['Movie'] } };
  assert.deepEqual((await library.queryItems({ IncludeItemTypes: 'Movie' }, { user: limited })).Items.map(item => item.Name), ['Alpha 中文', 'Beta Film']);
  await assert.rejects(library.getItemRecord(ids.restricted, { user: limited }), error => error.status === 404);
  assert.equal((await library.queryItems({}, { user })).Items[0].Type, 'CollectionFolder');
  assert.equal((await library.queryItems({ ParentId: ids.collection, IncludeItemTypes: 'Movie' }, { user })).TotalRecordCount, 4);
  assert.equal((await library.queryItems({ ParentId: ids.physical, Recursive: false, IncludeItemTypes: 'Movie' }, { user })).TotalRecordCount, 4);
  const unmatchedPerson = await library.queryItems({ Person: 'A Person' }, { user });
  assert.equal(unmatchedPerson.TotalRecordCount, 0);
  assert.deepEqual(unmatchedPerson.Items, []);
  return JSON.parse(stringifyNativeJson(page));
}

test('library queries enforce visibility before counting and preserve native precision',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const db = await createPostgresTestDatabase(t, 'library_queries');
  const library = await service(db);
  try { await seed(db); await assertions(library); }
  finally { await closeLibraryNavigation(library); }
});

test('item request rejects missing entities and projects real populated media streams',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const db = await createPostgresTestDatabase(t, 'library_item');
  let library;
  try {
    await seed(db); library = await service(db);
    await assert.rejects(library.getItemRecord('00000000000000000000000000000099', { user }), error => error.status === 404);
    assert.equal((await library.getItem(ids.movie, { user })).MediaSources.length, 1);
    await db.insert('MediaStreamInfos', { ...emptyRow('MediaStreamInfos'), ItemId: ids.other, StreamIndex: 0, StreamType: 1 });
    const dto = await library.getItem(ids.other, { user });
    assert.equal(dto.MediaStreams[0].Type, 'Video');
    assert.equal(dto.MediaStreams[0].VideoRange, 'SDR');
    assert.deepEqual(dto.MediaStreams, dto.MediaSources[0].MediaStreams);
  } finally { await closeLibraryNavigation(library); }
});

test('direct visibility recomputes inherited country ratings while repository queries use persisted scores',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const db = await createPostgresTestDatabase(t, 'library_ratings');
  let library;
  try {
    await seed(db);
    library = await service(db);
    const limited = { ...user, MaxParentalRatingScore: 13, MaxParentalRatingSubScore: 0,
      Policy: { ...user.Policy, BlockUnratedItems: ['Movie'] } };
    await db.update('BaseItems', { Id: ids.physical }, { CustomRating: 'TV-MA' });
    assert.equal((await library.queryItems({ IncludeItemTypes: 'Movie' }, { user: limited })).Items.some(entry => entry.Name === 'Alpha 中文'), true,
      'repository filtering keeps using the persisted inherited score');
    await assert.rejects(library.getItemRecord(ids.movie, { user: limited }), error => error.status === 404,
      'direct access inherits the display parent rating text');

    await db.update('BaseItems', { Id: ids.movie }, { CustomRating: 'PG', OfficialRating: 'NC-17' });
    await assert.rejects(library.getItemRecord(ids.movie, { user: limited }), error => error.status === 404,
      'a lower child custom rating cannot bypass the standalone parent visibility check');
    await db.update('BaseItems', { Id: ids.physical }, { CustomRating: null });
    assert.equal((await library.getItemRecord(ids.movie, { user: limited })).Name, 'Alpha 中文', 'custom rating wins over official rating');
    await db.update('BaseItems', { Id: ids.movie }, { CustomRating: 'CA-R', PreferredMetadataCountryCode: 'CA' });
    const subLimited = { ...limited, MaxParentalRatingScore: 18, MaxParentalRatingSubScore: 0 };
    await assert.rejects(library.getItemRecord(ids.movie, { user: subLimited }), error => error.status === 404, 'country subscore is enforced');
    const noSubLimit = { ...subLimited, MaxParentalRatingSubScore: null };
    assert.equal((await library.getItemRecord(ids.movie, { user: noSubLimit })).Name, 'Alpha 中文');

    await db.update('BaseItems', { Id: ids.restricted }, { CustomRating: 'PG', OfficialRating: 'NC-17' });
    assert.equal((await library.queryItems({ IncludeItemTypes: 'Movie' }, { user: limited })).Items.some(entry => entry.Name === 'Restricted'), false);
    assert.equal((await library.getItemRecord(ids.restricted, { user: limited })).Name, 'Restricted',
      'direct access does not trust a stale inherited score');
  } finally { await closeLibraryNavigation(library); }
});

test('query parsing is explicit about unsupported filters and validates values', () => {
  assert.deepEqual(parseQuery({ IsHD: true, Is4K: false, MinWidth: '1200', MinHeight: '720', MaxWidth: '3840', MaxHeight: '2160' }),
    { ishd: true, is4k: false, minwidth: 1200, minheight: 720, maxwidth: 3840, maxheight: 2160 });
  assert.equal(parseQuery({ MinWidth: '-2147483648', MaxHeight: '2147483647' }).minwidth, -2147483648);
  for (const value of ['-2147483649', '2147483648', '1.5']) {
    assert.throws(() => parseQuery({ MinWidth: value }), error => error.status === 400);
  }
  assert.throws(() => parseQuery({ Recursive: 'yes' }), error => error.status === 400);
  assert.throws(() => parseQuery({ ParentId: 'not-an-id' }), error => error.status === 400);
  assert.throws(() => parseQuery({ Limit: '-1' }), error => error.status === 400);
  assert.deepEqual(parseQuery({ SortBy: 'Random' }).sortby, ['Random']);
  assert.equal(dateText('2026-09-26 12:34:56.1234567'), '2026-09-26T12:34:56.1234567Z');
  assert.equal(dateTicks('0001-01-01 00:00:00.0000001'), 1n);
});

test('native presentation grouping includes null keys and runs before pagination',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const db = await createPostgresTestDatabase(t, 'library_grouping');
  let library;
  try {
    await seed(db);
    await db.update('BaseItems', { Id: ids.movie }, { PresentationUniqueKey: null });
    await db.update('BaseItems', { Id: ids.other }, { PresentationUniqueKey: null });
    library = await service(db);
    const grouped = await library.queryItems({ IncludeItemTypes: 'Movie', SortBy: 'ProductionYear', SortOrder: 'Descending', Limit: 1 }, { user });
    assert.equal(grouped.TotalRecordCount, 3);
    const noUser = await library.queryItems({ ParentId: ids.physical, Recursive: true, IncludeItemTypes: 'Movie' });
    assert.equal(noUser.TotalRecordCount, 4);
    const limitedCount = await library.queryItems({ IncludeItemTypes: 'Movie', EnableTotalRecordCount: false, Limit: 1 }, { user });
    assert.equal(limitedCount.TotalRecordCount, 1);
  } finally { await closeLibraryNavigation(library); }
});
