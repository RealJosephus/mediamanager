import { testFileSystem } from '../storage/plugin-files.js';
import { attachLibraryNavigation, closeLibraryNavigation } from './navigation-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { LibraryService } from '../../src/library/index.js';
import { hasFilters, parseQuery } from '../../src/library/query.js';
import { cleanValue, EMPTY_ID, idKey, mapRecord } from '../../src/library/records.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';

const id = number => `76000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

function emptyRow(table) {
  return Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => [column.name,
    column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? ''
      : column.clrType === 'uint' || column.clrType === 'long' ? 0n : 0]));
}

const nativeTypes = {
  UserRootFolder: 'MediaBrowser.Controller.Entities.UserRootFolder',
  CollectionFolder: 'MediaBrowser.Controller.Entities.CollectionFolder',
  Folder: 'MediaBrowser.Controller.Entities.Folder',
  Audio: 'MediaBrowser.Controller.Entities.Audio.Audio',
  Genre: 'MediaBrowser.Controller.Entities.Genre',
  Movie: 'MediaBrowser.Controller.Entities.Movies.Movie',
};

function databaseItem(Id, Type, Name, extra = {}) {
  const IsFolder = ['UserRootFolder', 'CollectionFolder', 'Folder'].includes(Type);
  return {
    ...emptyRow('BaseItems'), Id, Type: nativeTypes[Type], Name, CleanName: cleanValue(Name), SortName: cleanValue(Name),
    PresentationUniqueKey: `genre-service-${idKey(Id)}`, IsFolder, MediaType: Type === 'Audio' ? 'Audio' : 'Unknown',
    UnratedType: Type === 'Audio' ? 'Music' : 'Other', Data: '{}', Tags: '', Genres: '', Studios: '',
    ProductionLocations: '', ...extra,
  };
}

const user = {
  Id: id(900), Username: 'Genre reader', MaxParentalRatingScore: null, MaxParentalRatingSubScore: null,
  Policy: { EnableAllFolders: true, EnabledFolders: [], BlockedMediaFolders: [], BlockedTags: [], AllowedTags: [],
    BlockUnratedItems: [], EnableMediaPlayback: true, EnableContentDownloading: true, EnablePlaybackRemuxing: true },
  Configuration: {},
};

async function seedService(database) {
  const root = id(1), collection = id(2), physical = id(3);
  const records = [
    databaseItem(root, 'UserRootFolder', 'User root'),
    databaseItem(EMPTY_ID, 'Movie', 'Empty selector', { CleanName: 'drama' }),
    databaseItem(collection, 'CollectionFolder', 'Music', {
      ParentId: root, Data: JSON.stringify({ CollectionType: 'music', PhysicalFolderIds: [physical] }),
    }),
    databaseItem(physical, 'Folder', 'Physical folder'),
    databaseItem(id(20), 'Audio', 'Repository sci-fi', { ParentId: physical, TopParentId: physical, Genres: 'raw mismatch' }),
    databaseItem(id(21), 'Audio', 'Memory drama', { ParentId: physical, TopParentId: physical, Genres: 'Drama' }),
    databaseItem(id(22), 'Audio', 'Both', { ParentId: physical, TopParentId: physical, Genres: 'SCI FI|DRAMA' }),
    databaseItem(id(201), 'Genre', 'Science Fiction', { CleanName: 'sci fi' }),
    databaseItem(id(202), 'Movie', 'Drama', { CleanName: 'repository miss' }),
  ];
  for (const record of records) await database.insert('BaseItems', record);
  for (const value of [
    { ItemValueId: id(101), Type: 2, Value: 'Sci Fi', CleanValue: 'sci fi' },
    { ItemValueId: id(102), Type: 2, Value: 'Drama', CleanValue: 'drama' },
  ]) await database.insert('ItemValues', { ...emptyRow('ItemValues'), ...value });
  for (const [ItemValueId, ItemId] of [[id(101), id(20)], [id(101), id(22)], [id(102), id(21)], [id(102), id(22)]]) {
    await database.insert('ItemValuesMap', { ...emptyRow('ItemValuesMap'), ItemValueId, ItemId });
  }
  return { physical };
}

test('genre binding preserves native pipe/comma occurrence rules and drops invalid GUID values', () => {
  assert.deepEqual(parseQuery({ Genres: ' Sci Fi | Drama ' }), { genres: ['Sci Fi', 'Drama'] });
  assert.deepEqual(parseQuery({ Genres: ' \u0085 ' }), { genres: [''] },
    'the pipe binder trims CLR NEL whitespace');

  const repeatedNames = new URLSearchParams();
  repeatedNames.append('Genres', 'Sci Fi|Drama');
  repeatedNames.append('genres', 'Comedy');
  assert.deepEqual(parseQuery(repeatedNames), { genres: ['Sci Fi|Drama', 'Comedy'] },
    'a delimiter in a repeated occurrence remains literal');

  assert.deepEqual(parseQuery({ GenreIds: `${id(101)},invalid,${id(102)}` }), {
    genreids: [id(101), id(102)],
  });
  assert.deepEqual(parseQuery({ GenreIds: id(101).replaceAll('-', '') }), { genreids: [id(101)] });
  assert.deepEqual(parseQuery({ GenreIds: `{${id(101)}}` }), { genreids: [id(101)] });
  assert.deepEqual(parseQuery({ GenreIds: EMPTY_ID }), { genreids: [EMPTY_ID] });
  assert.deepEqual(parseQuery({ GenreIds: 'invalid' }), {});
  assert.deepEqual(parseQuery({ GenreIds: `\ufeff${id(101)}\ufeff` }), {},
    'BOM is not CLR whitespace for Guid parsing');

  const x = '{0x76000000,0x0000,0x0000,{0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x01}}';
  assert.deepEqual(parseQuery({ GenreIds: x }), {}, 'a single X-format occurrence is split at commas');
  const repeatedIds = new URLSearchParams();
  repeatedIds.append('GenreIds', `${id(102)},invalid`);
  repeatedIds.append('GenreIds', x);
  assert.deepEqual(parseQuery(repeatedIds), { genreids: [id(101)] },
    'repeated occurrences are converted independently rather than comma-split');
  assert.equal(hasFilters(parseQuery({ GenreIds: id(101) })), true);
});

test('mapRecord preserves native Genres, Tags and Studios empty segments while other columns drop them', () => {
  const mapped = (Genres, Type = 'MediaBrowser.Controller.Entities.Movies.Movie') => mapRecord({ Id: id(500), Type,
    Name: 'Mapped', Data: '{}', Genres, Tags: 'one||two|', Studios: 'a||b|',
    ProductionLocations: 'north||south|', Artists: 'artist-a||artist-b|', AlbumArtists: 'album-a||album-b|' });
  assert.deepEqual(mapped(null).Genres, []);
  assert.deepEqual(mapped('').Genres, []);
  assert.deepEqual(mapped(' \t\u0085 ').Genres, []);
  assert.deepEqual(mapped('Drama||Sci Fi|').Genres, ['Drama', '', 'Sci Fi', '']);
  assert.deepEqual(mapped('Drama||Sci Fi|').Tags, ['one', '', 'two', '']);
  assert.deepEqual(mapped('Drama||Sci Fi|').Studios, ['a', '', 'b', '']);
  assert.deepEqual(mapped('Drama||Sci Fi|').ProductionLocations, ['north', 'south']);
  assert.equal(mapped('Drama||Sci Fi|').Artists, undefined);
  assert.equal(mapped('Drama||Sci Fi|').AlbumArtists, undefined);
  const audio = mapped('Drama||Sci Fi|', 'MediaBrowser.Controller.Entities.Audio.Audio');
  assert.deepEqual(audio.Artists, ['artist-a', 'artist-b']);
  assert.deepEqual(audio.AlbumArtists, ['album-a', 'album-b']);
});

test('LibraryService dispatches root genre filters to repository and nonrecursive folder filters to memory',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const database = await createPostgresTestDatabase(t, 'genre_query');
  let library;
  try {
    const { physical } = await seedService(database);
    library = new LibraryService({fileSystem: testFileSystem,  store: new DomainStore(database), serverId: 'genre-query-test' });
    await attachLibraryNavigation(library);
    const names = page => page.Items.map(value => value.Name);

    assert.deepEqual(names(await library.queryItems({ Genres: 'Sci-Fi', IncludeItemTypes: 'Audio' }, { user })),
      ['Both', 'Repository sci-fi']);
    assert.deepEqual(names(await library.queryItems({ GenreIds: id(201), IncludeItemTypes: 'Audio' }, { user })),
      ['Both', 'Repository sci-fi']);
    assert.deepEqual(names(await library.queryItems({ GenreIds: EMPTY_ID, IncludeItemTypes: 'Audio' }, { user })),
      ['Both', 'Memory drama']);
    assert.deepEqual(names(await library.queryItems({ ParentId: physical, Recursive: false,
      Genres: 'sci fi', IncludeItemTypes: 'Audio' }, { user })), ['Both']);
    assert.deepEqual(names(await library.queryItems({ ParentId: physical, Recursive: false,
      GenreIds: id(202), IncludeItemTypes: 'Audio' }, { user })), ['Both', 'Memory drama']);
    await assert.rejects(library.queryItems({ ParentId: physical, Recursive: false,
      GenreIds: EMPTY_ID }, { user }), error => error.status === 400 && error.message === 'Error processing request.');
  } finally { await closeLibraryNavigation(library); }
});
