import { testFileSystem } from '../storage/plugin-files.js';
import { nativeTextBytes, nativeTextProjection } from '../../src/database/native-text.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { LibraryService } from '../../src/library/library-service.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { nativeGenreIdentity } from '../../src/library/identity.js';
import { clrWhitespaceCharacters } from '../../src/metadata/whitespace.js';
import { ordinalIgnoreCaseKey } from '../../src/storage/ordinal-comparer.js';
import { removeDiacritics } from '../../src/sessions/user-data.js';
import {
  buildPostgresUserViewGenrePageQuery,
  matchesPostgresUserViewGenre,
  queryPostgresUserViewGenrePage,
} from '../../src/library/postgres-user-view-genre-query.js';

const ids = Object.freeze({
  top: '17000000-0000-0000-0000-000000000001',
  first: '17000000-0000-0000-0000-000000000002',
  second: '17000000-0000-0000-0000-000000000003',
  view: '17000000-0000-0000-0000-000000000004',
  user: '17000000-0000-0000-0000-000000000005',
  image: '17000000-0000-0000-0000-000000000006',
});

const blank = table => Object.fromEntries(tableDefinition(table).columns
  .filter(column => !column.generated).map(column => {
    const type = column.clrType.replace('?', '');
    return [column.name, type === 'DateTime' ? '2026-10-01 00:00:00'
      : column.nullable ? null : type === 'bool' ? false
        : column.type === 'TEXT' ? '' : type === 'long' || type === 'uint' ? 0n : 0];
  }));

const item = (Id, Type, values = {}) => ({
  ...blank('BaseItems'),
  Id,
  Type: `MediaBrowser.Controller.Entities.${Type}`,
  Name: Id,
  CleanName: Id,
  SortName: Id,
  Data: '{}',
  Genres: '',
  Studios: '',
  Tags: '',
  ProductionLocations: '',
  UnratedType: Type === 'Movies.Movie' ? 'Movie' : 'Other',
  ...values,
});

test('PostgreSQL genre-menu plan groups native collation keys and owns count, adjacency and paging', () => {
  const page = buildPostgresUserViewGenrePageQuery({ dialect: 'postgres', schemaName: 'genre_shape' }, {
    adjacentto: ids.view, startindex: 3, limit: 1,
  }, {
    itemType: 'Movie', scope: { topParentIds: [ids.top] }, itemId: ids.view,
  });
  assert.match(page.text, /genre_occurrences AS/u);
  assert.match(page.text, /exact_first AS/u);
  assert.match(page.text, /mm_remove_diacritics/u);
  assert.match(page.text, /mm_ordinal_ignore_case_key/u);
  assert.match(page.text, /normalized_first AS/u);
  assert.match(page.text, /row_number\(\) OVER \(ORDER BY __source_ordinal, __genre_ordinal\) AS __ordinal/u);
  assert.match(page.text, /SELECT count\(\*\)::bigint FROM ordered/u);
  assert.match(page.text, /SELECT count\(\*\)::bigint FROM adjacent/u);
  assert.match(page.text, /SELECT "Name" FROM ordered ORDER BY __ordinal LIMIT 1/u);
  assert.match(page.text, /SELECT \* FROM adjacent ORDER BY __ordinal LIMIT \$\d+ OFFSET \$\d+/u);
  assert.doesNotMatch(page.text, /generate_series/u);
  assert.ok(page.values.includes(clrWhitespaceCharacters));
  assert.equal(page.values.includes(1), true);
  assert.equal(page.values.includes(3), true);
});

test('PostgreSQL genre-menu unrated visibility is NULL-safe', () => {
  const page = buildPostgresUserViewGenrePageQuery({ dialect: 'postgres', schemaName: 'genre_shape' }, {}, {
    itemType: 'Movie',
    scope: { topParentIds: [ids.top] },
    itemId: ids.view,
    visibility: { blockUnratedTypes: ['Movie'] },
  });
  assert.match(page.text, /i\."UnratedType" = ANY\([^)]*\)\) IS NOT TRUE/u);
});

test('real PostgreSQL genre menu groups source names, then filters, counts and pages one shared view in SQL', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = `genre_menu_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
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

  const firstGenres = ['Drama', 'drama', 'DRÁMA', 'æon', 'AEON', '', '\ufeff', '\0', '\u0001', '\u00010', '\u00011', '\\u0000', '🎬\0Genre',
    ...Array.from({ length: 35 }, (_, index) => `First ${index}`)];
  const secondGenres = [...Array.from({ length: 35 }, (_, index) => `Second ${index}`), 'Drama', 'ÆON'];
  await database.insert('BaseItems', item(ids.first, 'Movies.Movie', {
    Name: 'First', CleanName: 'first', SortName: 'a', TopParentId: ids.top,
    MediaType: 'Video', Genres: firstGenres.join('|'),
  }));
  await database.insert('BaseItems', item(ids.second, 'Movies.Movie', {
    Name: 'Second', CleanName: 'second', SortName: 'b', TopParentId: ids.top,
    MediaType: 'Video', Genres: secondGenres.join('|'),
  }));
  for (const [index, Genres] of ['\t', '\u0085', '\u00a0'].entries()) {
    await database.insert('BaseItems', item(`17000000-0000-0000-0001-${String(index + 1).padStart(12, '0')}`,
      'Movies.Movie', {
        Name: `Whitespace ${index}`, CleanName: `whitespace ${index}`, SortName: `c-${index}`,
        TopParentId: ids.top, MediaType: 'Video', Genres,
      }));
  }

  const raw = [...firstGenres, ...secondGenres];
  const seen = new Set();
  const expected = raw.filter(name => {
    const key = ordinalIgnoreCaseKey(removeDiacritics(name));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const queries = [];
  const originalQuery = database.client.query.bind(database.client);
  database.client.query = async (...args) => {
    const [input] = args;
    const result = await originalQuery(...args);
    if (typeof input === 'object' && /"SourceRecordCount"/u.test(input.text)) {
      queries.push(input);
    }
    return result;
  };
  const distinct = await queryPostgresUserViewGenrePage(database, {}, {
    itemType: 'Movie', scope: { topParentIds: [ids.top] }, itemId: ids.view,
  });
  assert.deepEqual(distinct.rows.map(row => row.name), expected);
  assert.equal(distinct.total, expected.length);
  assert.equal(queries.length, 1);

  const storedViewId = ids.view.replaceAll('-', '');
  await database.insert('BaseItems', item(storedViewId, 'UserView', {
    Name: 'Parent identity', CleanName: 'parent identity', ForcedSortName: 'Drama', SortName: 'drama',
    IsFolder: true, MediaType: 'Unknown',
    Data: JSON.stringify({ ViewType: 'moviegenre', DisplayParentId: ids.top.replaceAll('-', '') }),
  }));
  await database.insert('BaseItemImageInfos', {
    ...blank('BaseItemImageInfos'), Id: ids.image, ItemId: storedViewId, ImageType: 0,
    Path: 'Z:\\metadata\\genre.jpg', Width: 1, Height: 1,
  });

  const matchingPage = await queryPostgresUserViewGenrePage(database, {
    ids: [ids.view], includeitemtypes: ['UserView'], namestartswith: 'd',
    imagetypes: ['Primary'], searchterm: 'ignored by the native memory builder',
    startindex: 1, limit: 3,
  }, {
    itemType: 'Movie', scope: { topParentIds: [ids.top] }, itemId: storedViewId,
  });
  assert.equal(matchingPage.seedName, expected[0]);
  assert.equal(matchingPage.sourceTotal, expected.length);
  assert.equal(matchingPage.total, expected.length);
  assert.deepEqual(matchingPage.rows.map(row => row.name), expected.slice(1, 4));
  assert.equal(await matchesPostgresUserViewGenre(database, {
    ids: [ids.view], includeitemtypes: ['UserView'], namestartswith: 'd',
    imagetypes: ['Primary'], searchterm: 'ignored by the native memory builder',
  }, {
    itemId: storedViewId, userId: ids.user, memorySortConfiguration: {},
  }), true);

  assert.equal(await matchesPostgresUserViewGenre(database, {
    includeitemtypes: ['Movie'],
  }, {
    itemId: storedViewId, userId: ids.user, memorySortConfiguration: {},
  }), false);

  const adjacent = await queryPostgresUserViewGenrePage(database, {
    adjacentto: ids.view, startindex: 0, limit: 10,
  }, {
    itemType: 'Movie', scope: { topParentIds: [ids.top] }, itemId: storedViewId,
  });
  assert.equal(adjacent.total, 2);
  assert.deepEqual(adjacent.rows.map(row => row.name), expected.slice(0, 2));

  const nonAdjacent = await queryPostgresUserViewGenrePage(database, {
    adjacentto: ids.image, startindex: 0, limit: 10,
  }, {
    itemType: 'Movie', scope: { topParentIds: [ids.top] }, itemId: storedViewId,
  });
  assert.equal(nonAdjacent.sourceTotal, expected.length);
  assert.equal(nonAdjacent.total, 0);
  assert.deepEqual(nonAdjacent.rows, []);

  const nullUnratedId = '17000000-0000-0000-0000-000000000007';
  await database.insert('BaseItems', item(nullUnratedId, 'Movies.Movie', {
    Name: 'Nullable unrated', CleanName: 'nullable unrated', SortName: 'nullable unrated',
    TopParentId: ids.top, MediaType: 'Video', Genres: 'Nullable visibility',
    InheritedParentalRatingValue: null, UnratedType: null,
  }));
  const nullSafe = await queryPostgresUserViewGenrePage(database, {}, {
    itemType: 'Movie',
    scope: { topParentIds: [ids.top] },
    itemId: ids.view,
    visibility: { blockUnratedTypes: ['Movie'] },
  });
  assert.deepEqual(nullSafe.rows.map(row => row.name), ['Nullable visibility'],
    'a null UnratedType is not a member of the blocked type set');
});

test('real PostgreSQL Limit=1 genre menu hydrates only its SQL page and required shared-view seed', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = `genre_bounds_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const directory = await mkdtemp(path.join(tmpdir(), 'mm-genre-bounds-'));
  const database = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
    schema,
    create: true,
  });
  const store = new DomainStore(database);
  const linkedChildren = new PostgresLinkedChildrenStore({ database });
  await linkedChildren.initialize();
  const library = new LibraryService({fileSystem: testFileSystem,
    store, linkedChildren,
    serverId: 'genre-bounds',
    programDataPath: directory,
    configuration: {},
  });
  // The test owns request-time persistence only; background metadata refresh
  // is unrelated and would obscure the page hydration measurement.
  library.userViews.queueRefresh = () => {};
  const creator = new ItemCreationService({ store, library, linkedChildren,
    loadContext: createMetadataContextLoader({fileSystem: testFileSystem,  store, library, linkedChildren, configuration: library.options.configuration }) });
  library.itemCreation = creator;
  t.after(async () => {
    await creator.close();
    try { await library.close(); } catch { /* Schema cleanup remains authoritative. */ }
    await linkedChildren.close();
    try {
      await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  const rootId = '18000000-0000-0000-0000-000000000001';
  const physicalId = '18000000-0000-0000-0000-000000000002';
  const menuId = '18000000-0000-0000-0000-000000000003';
  await database.insert('BaseItems', item(rootId, 'UserRootFolder', {
    Name: 'Root', CleanName: 'root', SortName: 'root', IsFolder: true,
  }));
  await database.insert('BaseItems', item(physicalId, 'Folder', {
    Name: 'Physical', CleanName: 'physical', SortName: 'physical', IsFolder: true,
    TopParentId: physicalId,
  }));
  await database.insert('BaseItems', item(menuId, 'UserView', {
    Name: 'Genres', CleanName: 'genres', SortName: 'genres', IsFolder: true,
    Data: JSON.stringify({ ViewType: 'moviegenres', DisplayParentId: physicalId.replaceAll('-', '') }),
  }));

  const names = [];
  for (let index = 0; index < 256; index++) {
    const name = `Bounded Genre ${String(index).padStart(3, '0')}`;
    const movieId = `18000000-0000-0000-0001-${String(index).padStart(12, '0')}`;
    names.push(name);
    await database.insert('BaseItems', item(movieId, 'Movies.Movie', {
      Name: `Movie ${String(index).padStart(3, '0')}`,
      CleanName: `movie ${String(index).padStart(3, '0')}`,
      SortName: `movie ${String(index).padStart(3, '0')}`,
      MediaType: 'Video', Genres: name,
    }));
    await database.insert('AncestorIds', { ItemId: movieId, ParentItemId: physicalId });
  }

  const generatedIds = new Set(names.map(name => nativeGenreIdentity(name, library.options).Id.replaceAll('-', '').toLowerCase()));
  const query = database.client.query.bind(database.client);
  const sourcePageSizes = [];
  let largestGeneratedIdLookup = 0;
  database.client.query = async (...args) => {
    const plan = args[0];
    const result = await query(...args);
    if (typeof plan === 'object' && /"SourceRecordCount"/u.test(plan.text)) sourcePageSizes.push(result.rows
      .filter(row => row.__ordinal != null).length);
    const lookup = typeof plan === 'object' && Array.isArray(plan.values?.[0]) ? plan.values[0] : [];
    largestGeneratedIdLookup = Math.max(largestGeneratedIdLookup,
      lookup.filter(value => generatedIds.has(String(value).replaceAll('-', '').toLowerCase())).length);
    return result;
  };

  const result = await library.queryItems({
    ParentId: menuId,
    StartIndex: 180,
    Limit: 1,
    EnableImages: false,
    EnableUserData: false,
  });
  assert.equal(result.TotalRecordCount, 256);
  assert.equal(result.StartIndex, 180);
  assert.equal(result.Items.length, 1);
  assert.deepEqual(sourcePageSizes, [1]);
  assert.ok(largestGeneratedIdLookup <= 2, `generated-id lookup contained ${largestGeneratedIdLookup} genre ids`);
  const genres = (await database.rows('BaseItems')).filter(row => row.Type.endsWith('.Genre'));
  assert.equal(genres.length, 2, 'only the first shared-view seed and requested offset row are hydrated');
  assert.deepEqual(new Set(genres.map(row => row.Name)), new Set([names[0], names[180]]));
});
