import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getRatingScore } from '../../src/core/localization-data.js';
import { tableDefinition } from '../../src/database/model.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { queryPostgresItemPage } from '../../src/database/postgres-item-query.js';
import { postgresParentalRatingScoreFunctionName } from '../../src/database/postgres-runtime-schema.js';

const blank = table => Object.fromEntries(tableDefinition(table).columns
  .filter(column => !column.generated).map(column => {
    const type = column.clrType.replace('?', '');
    return [column.name, type === 'DateTime' ? '2026-10-01 00:00:00'
      : column.nullable ? null : type === 'bool' ? false
        : column.type === 'TEXT' ? '' : type === 'long' || type === 'uint' ? 0n : 0];
  }));

const item = (Id, Type, values = {}) => ({
  ...blank('BaseItems'), Id, Type: `MediaBrowser.Controller.Entities.${Type}`,
  Name: Type, CleanName: Type.toLowerCase(), SortName: Type.toLowerCase(),
  PresentationUniqueKey: Id, Data: '{}', ...values,
});

const compact = value => value.replaceAll('-', '');
const baseContext = Object.freeze({ defaultCountry: 'US', collectionOptions: [], folders: [] });

async function openDatabase(t, prefix) {
  const schema = `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const database = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
    schema,
    create: true,
  });
  t.after(async () => {
    await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await database.close();
  });
  return database;
}

test('real PostgreSQL parental-rating resolver preserves the frozen LocalizationManager grammar', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const database = await openDatabase(t, 'rating_resolver');
  const cases = [
    ['N/A / PG', 'US', 'US'],
    ['Rated PG', 'US', 'US'],
    ['DE: 12', 'US', 'US'],
    ['German:FSK-18', 'US', 'US'],
    ['R', 'CA', 'US'],
    ['R', 'US', 'US'],
    ['TV-MA', 'US', 'US'],
    ['mystery:R', null, 'CA'],
    ['\ufeffR\ufeff', 'US', 'US'],
    ['\u0085R\u0085', 'US', 'US'],
    ['2147483648', 'US', 'US'],
  ];
  for (const [rating, country, defaultCountry] of cases) {
    const actual = (await database.client.query({
      text: `SELECT "${database.schemaName}"."${postgresParentalRatingScoreFunctionName}"($1, jsonb_build_array($2::text, $3::text)) AS score`,
      values: [rating, country, defaultCountry],
    })).rows[0].score;
    const expected = getRatingScore(rating, country, defaultCountry);
    assert.deepEqual(actual, expected == null ? null : [expected.score, expected.subScore],
      `${defaultCountry}/${country}: ${JSON.stringify(rating)}`);
  }
});

test('real PostgreSQL BoxSet child parental checks inherit ratings/countries and filter before count/order/page', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const database = await openDatabase(t, 'rating_children');
  // The native logical lookup is Guid-based even for relationship columns
  // that a pristine schema happens to constrain as raw text. Drop only this
  // disposable-schema FK so N/D representation parity is exercised directly.
  await database.client.query(`ALTER TABLE "${database.schemaName}"."BaseItems"
    DROP CONSTRAINT "FK_BaseItems_BaseItems_ParentId"`);
  await database.client.query(`ALTER TABLE "${database.schemaName}"."LinkedChildren"
    DROP CONSTRAINT "FK_LinkedChildren_BaseItems_ChildId"`);
  const ids = {
    hiddenBox: '31000000-0000-0000-0000-000000000001',
    hiddenEpisode: '31000000-0000-0000-0000-000000000002',
    hiddenSeason: '31000000-0000-0000-0000-000000000003',
    whitespaceBox: '31000000-0000-0000-0000-000000000004',
    whitespaceEpisode: '31000000-0000-0000-0000-000000000005',
    whitespaceSeason: '31000000-0000-0000-0000-000000000006',
    countryBox: '31000000-0000-0000-0000-000000000007',
    countryChild: '31000000-0000-0000-0000-000000000008',
    countryParent: '31000000-0000-0000-0000-000000000009',
    subBox: '31000000-0000-0000-0000-000000000010',
    subChild: '31000000-0000-0000-0000-000000000011',
    blockedBox: '31000000-0000-0000-0000-000000000012',
    blockedChild: '31000000-0000-0000-0000-000000000013',
    blockedParent: '31000000-0000-0000-0000-000000000014',
    unratedBox: '31000000-0000-0000-0000-000000000015',
    unratedChild: '31000000-0000-0000-0000-000000000016',
    missingBox: '31000000-0000-0000-0000-000000000017',
    missingChild: '31000000-0000-0000-0000-000000000099',
    pageBlockedBox: '31000000-0000-0000-0000-000000000020',
    pageBlockedChild: '31000000-0000-0000-0000-000000000021',
    pageAllowedBox: '31000000-0000-0000-0000-000000000022',
    pageAllowedChild: '31000000-0000-0000-0000-000000000023',
    pageLastBox: '31000000-0000-0000-0000-000000000024',
    pageLastChild: '31000000-0000-0000-0000-000000000025',
    folderBox: '31000000-0000-0000-0000-000000000030',
    folderChild: '31000000-0000-0000-0000-000000000031',
    folderRoot: '31000000-0000-0000-0000-000000000032',
    folderLibrary: '31000000-0000-0000-0000-000000000033',
    optionBox: '31000000-0000-0000-0000-000000000034',
    optionChild: '31000000-0000-0000-0000-000000000035',
    optionRoot: '31000000-0000-0000-0000-000000000036',
    optionLibrary: '31000000-0000-0000-0000-000000000037',
  };
  const box = (id, sortName) => item(id, 'Collections.BoxSet', {
    Name: sortName, SortName: sortName, IsFolder: true,
    InheritedParentalRatingValue: 0, InheritedParentalRatingSubValue: 0,
  });
  await Promise.all([
    database.insert('BaseItems', box(ids.hiddenBox, 'inherit-hidden')),
    database.insert('BaseItems', item(ids.hiddenSeason, 'TV.Season', {
      OfficialRating: 'PG-13', SeriesId: ids.hiddenSeason,
    })),
    database.insert('BaseItems', item(ids.hiddenEpisode, 'TV.Episode', {
      SeasonId: compact(ids.hiddenSeason), OfficialRating: '',
    })),
    database.insert('BaseItems', box(ids.whitespaceBox, 'whitespace-custom')),
    database.insert('BaseItems', item(ids.whitespaceSeason, 'TV.Season', {
      CustomRating: '   ', OfficialRating: 'R', SeriesId: ids.whitespaceSeason,
    })),
    database.insert('BaseItems', item(ids.whitespaceEpisode, 'TV.Episode', {
      SeasonId: compact(ids.whitespaceSeason), OfficialRating: 'R',
    })),
    database.insert('BaseItems', box(ids.countryBox, 'country-parent')),
    database.insert('BaseItems', item(ids.countryParent, 'Folder', {
      PreferredMetadataCountryCode: 'CA', IsFolder: true,
    })),
    database.insert('BaseItems', item(ids.countryChild, 'Movies.Movie', {
      ParentId: compact(ids.countryParent), OfficialRating: 'R',
    })),
    database.insert('BaseItems', box(ids.subBox, 'subscore')),
    database.insert('BaseItems', item(ids.subChild, 'Movies.Movie', { OfficialRating: 'TV-MA' })),
    database.insert('BaseItems', box(ids.blockedBox, 'blocked-tag')),
    database.insert('BaseItems', item(ids.blockedParent, 'Folder', { Tags: 'Blocked', IsFolder: true })),
    database.insert('BaseItems', item(ids.blockedChild, 'Movies.Movie', {
      ParentId: compact(ids.blockedParent), OfficialRating: 'G',
    })),
    database.insert('BaseItems', box(ids.unratedBox, 'unrated')),
    database.insert('BaseItems', item(ids.unratedChild, 'Movies.Movie', { UnratedType: 'Movie' })),
    database.insert('BaseItems', box(ids.missingBox, 'missing-child')),
    database.insert('BaseItems', box(ids.pageBlockedBox, 'a-blocked')),
    database.insert('BaseItems', item(ids.pageBlockedChild, 'Movies.Movie', { OfficialRating: 'R' })),
    database.insert('BaseItems', box(ids.pageAllowedBox, 'b-allowed')),
    database.insert('BaseItems', item(ids.pageAllowedChild, 'Movies.Movie', { OfficialRating: 'PG' })),
    database.insert('BaseItems', box(ids.pageLastBox, 'c-last')),
    database.insert('BaseItems', item(ids.pageLastChild, 'Movies.Movie', { OfficialRating: 'Rated PG' })),
    database.insert('BaseItems', box(ids.folderBox, 'folder-country')),
    database.insert('BaseItems', item(ids.folderRoot, 'Folder', { IsFolder: true, Path: 'Z:\\Preferred' })),
    database.insert('BaseItems', item(ids.folderChild, 'Movies.Movie', {
      ParentId: compact(ids.folderRoot), OfficialRating: 'R',
    })),
    database.insert('BaseItems', box(ids.optionBox, 'library-option-country')),
    database.insert('BaseItems', item(ids.optionRoot, 'Folder', { IsFolder: true, Path: 'Z:\\Option' })),
    database.insert('BaseItems', item(ids.optionChild, 'Movies.Movie', {
      ParentId: compact(ids.optionRoot), OfficialRating: 'R',
    })),
  ]);
  const links = [
    [ids.hiddenBox, compact(ids.hiddenEpisode)],
    [ids.whitespaceBox, ids.whitespaceEpisode],
    [ids.countryBox, ids.countryChild],
    [ids.subBox, ids.subChild],
    [ids.blockedBox, ids.blockedChild],
    [ids.unratedBox, ids.unratedChild],
    [ids.missingBox, ids.missingChild],
    [ids.pageBlockedBox, ids.pageBlockedChild],
    [ids.pageAllowedBox, ids.pageAllowedChild],
    [ids.pageLastBox, ids.pageLastChild],
    [ids.folderBox, ids.folderChild],
    [ids.optionBox, ids.optionChild],
  ];
  for (const [ParentId, ChildId] of links) await database.insert('LinkedChildren', {
    ParentId, ChildId, ChildType: 0, SortOrder: 0,
  });

  const visible = async (id, visibility) => (await queryPostgresItemPage(database,
    { ids: [id], limit: 10 }, {
      resumableMode: 'memory',
      visibility: { maxRating: 17, boxSetChildRatingMode: 'memory', ratingContext: baseContext, ...visibility },
    })).total;

  assert.equal(await visible(ids.hiddenBox, { maxRating: 12 }), 0,
    'Episode rating inherits through an N-format SeasonId before paging');
  assert.equal(await visible(ids.whitespaceBox, { maxRating: 0 }), 1,
    'a whitespace CustomRating is nonempty and masks every OfficialRating in the display-parent chain');
  assert.equal(await visible(ids.countryBox), 0,
    'preferred country follows an N-format ParentId and selects the CA R score');
  assert.equal(await visible(ids.subBox, { maxSubRating: 0 }), 0);
  assert.equal(await visible(ids.subBox, { maxSubRating: 1 }), 1,
    'equal-score child visibility observes the maximum sub-score boundary');
  assert.equal(await visible(ids.blockedBox, { blockedTags: ['Blocked'] }), 0,
    'blocked tags inherit through the child actual-parent chain');
  assert.equal(await visible(ids.unratedBox, { blockUnratedTypes: ['Movie'] }), 0,
    'an unresolved child rating uses the child Movie unrated policy');
  assert.equal(await visible(ids.missingBox), 1,
    'a link whose target is missing does not create a memory child');
  assert.equal(await visible(ids.missingBox, { boxSetChildRatingMode: 'repository' }), 0,
    'the repository ChildType=0 gate keeps its distinct missing-target rejection');

  const folderContext = {
    defaultCountry: 'US', collectionOptions: [],
    folders: [{
      id: ids.folderLibrary, type: 'CollectionFolder', path: 'Z:\\Preferred',
      preferredCountry: 'CA', tags: ['FolderBlock'], physicalLocations: null, libraryCountry: null,
    }],
  };
  assert.equal(await visible(ids.folderBox, { ratingContext: folderContext }), 0,
    'an exact-path collection match short-circuits a null locations list and supplies its preferred country');
  assert.equal(await visible(ids.folderBox, {
    maxRating: 100, blockedTags: ['FolderBlock'], ratingContext: folderContext,
  }), 0, 'blocked tags inherit from the matching collection folder');

  const optionContext = {
    defaultCountry: 'US',
    collectionOptions: [{ id: ids.optionLibrary, country: 'CA' }],
    folders: [{
      id: ids.optionLibrary, type: 'CollectionFolder', path: 'Z:\\Option',
      preferredCountry: '', tags: [], physicalLocations: [], libraryCountry: 'CA',
    }],
  };
  assert.equal(await visible(ids.optionBox, { ratingContext: optionContext }), 0,
    'the first actual collection folder supplies library-option metadata country');

  const sorted = await queryPostgresItemPage(database, {
    ids: [ids.folderChild, ids.optionChild], sortby: ['OfficialRating'], limit: 10,
  }, {
    resumableMode: 'memory', memoryRatingContext: {
      ...folderContext,
      folders: [{ ...folderContext.folders[0], physicalLocations: [] }, ...optionContext.folders],
      collectionOptions: [{ id: ids.optionLibrary, country: 'US' }],
    },
  });
  assert.deepEqual(sorted.rows.map(row => row.Id), [ids.optionChild, ids.folderChild],
    'OfficialRating sorting uses the same per-item collection-country resolver');

  const page = await queryPostgresItemPage(database, {
    ids: [ids.pageBlockedBox, ids.pageAllowedBox, ids.pageLastBox],
    sortby: ['SortName'], startindex: 1, limit: 1,
  }, {
    resumableMode: 'memory',
    visibility: { maxRating: 10, maxSubRating: 0, boxSetChildRatingMode: 'memory', ratingContext: baseContext },
  });
  assert.equal(page.total, 2);
  assert.deepEqual(page.rows.map(row => row.Id), [ids.pageLastBox],
    'child visibility changes the candidate set before total, ordering, and page selection');
});
