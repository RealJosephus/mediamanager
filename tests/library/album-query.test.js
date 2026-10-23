import { testFileSystem } from '../storage/plugin-files.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { createStateRelations, closeStateDeletion } from './deletion-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { LibraryService } from '../../src/library/index.js';
import { hasFilters, parseQuery } from '../../src/library/query.js';
import { cleanValue, dateText, EMPTY_ID, idKey } from '../../src/library/records.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';

const id = number => `76000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

const ids = {
  userRoot: id(1), aggregate: id(2), collection: id(3), otherCollection: id(4), physical: id(5), otherPhysical: id(6),
  playlists: '1071671E-7BFF-A053-2E93-0DEBEE501D2E', memoryMediaFolder: id(8),
  targetAlbum: id(10), otherAlbum: id(11), duplicateSlow: id(12), duplicateFast: id(13),
  ownerHidden: id(14), ownerVisible: id(15), alternatePrimary: id(16), alternateHidden: id(17),
  crossTopAlternate: id(18), ownedExtra: id(19), parentlessAlbum: id(20), globalFirst: id(21), bomAlbum: id(22),
  fakeParent: id(30), targetTrack: id(101), otherTrack: id(102), duplicateSlowTrack: id(103),
  duplicateFastTrack: id(104), ownerHiddenTrack: id(105), ownerVisibleTrack: id(106),
  alternatePrimaryTrack: id(107), alternateHiddenTrack: id(108), crossTopTrack: id(109),
  ownedExtraTrack: id(110), parentlessTrack: id(111), globalFirstTrack: id(112), bomTrack: id(113),
  grandchild: id(114), fakeParentChild: id(115), emptyParentChild: id(116), orphan: id(117),
  memoryGroupA: id(118), memoryGroupB: id(119), memoryMediaPrimary: id(120), memoryMediaAlternate: id(121),
  memoryMediaOwned: id(122), memoryMediaExtra: id(123),
  playlistDirect: id(130), playlistContainer: id(131), playlistNested: id(132),
};

const user = {
  Id: id(900), Username: 'Album reader', MaxParentalRatingScore: null, MaxParentalRatingSubScore: null,
  Policy: { EnableAllFolders: true, EnabledFolders: [], BlockedMediaFolders: [], BlockedTags: [], AllowedTags: [],
    BlockUnratedItems: [], EnableMediaPlayback: true, EnableContentDownloading: true, EnablePlaybackRemuxing: true },
  Configuration: {},
};

function emptyRow(table) {
  return Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => [column.name,
    column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? ''
      : column.clrType === 'uint' || column.clrType === 'long' ? 0n : 0]));
}

const nativeTypes = {
  AggregateFolder: 'MediaBrowser.Controller.Entities.AggregateFolder',
  UserRootFolder: 'MediaBrowser.Controller.Entities.UserRootFolder',
  CollectionFolder: 'MediaBrowser.Controller.Entities.CollectionFolder',
  Folder: 'MediaBrowser.Controller.Entities.Folder',
  MusicAlbum: 'MediaBrowser.Controller.Entities.Audio.MusicAlbum',
  Audio: 'MediaBrowser.Controller.Entities.Audio.Audio',
  Movie: 'MediaBrowser.Controller.Entities.Movies.Movie',
  Playlist: 'MediaBrowser.Controller.Playlists.Playlist',
  PlaylistsFolder: 'Emby.Server.Implementations.Playlists.PlaylistsFolder',
};

function row(Id, Type, Name, extra = {}) {
  const IsFolder = ['AggregateFolder', 'UserRootFolder', 'CollectionFolder', 'Folder', 'MusicAlbum', 'Playlist', 'PlaylistsFolder'].includes(Type);
  return {
    ...emptyRow('BaseItems'), Id, Type: nativeTypes[Type], Name, CleanName: cleanValue(Name), SortName: cleanValue(Name),
    PresentationUniqueKey: `album-query-${idKey(Id)}`, IsFolder, MediaType: Type === 'Audio' ? 'Audio' : 'Unknown',
    UnratedType: ['MusicAlbum', 'Audio'].includes(Type) ? 'Music' : 'Other', Data: '{}',
    Tags: '', Genres: '', Studios: '', ProductionLocations: '', ...extra,
  };
}

async function seed(database) {
  const records = [
    row(ids.userRoot, 'UserRootFolder', 'User root'),
    row(ids.aggregate, 'AggregateFolder', 'Aggregate root'),
    row(EMPTY_ID, 'Folder', 'Persisted empty-guid decoy'),
    row(ids.collection, 'CollectionFolder', 'Zeta Library', {
      ParentId: ids.userRoot, Data: JSON.stringify({ CollectionType: 'music', PhysicalFolderIds: [ids.physical] }),
    }),
    row(ids.otherCollection, 'CollectionFolder', 'Alpha Library', {
      ParentId: ids.userRoot, Data: JSON.stringify({ CollectionType: 'music', PhysicalFolderIds: [ids.otherPhysical] }),
    }),
    row(ids.playlists, 'PlaylistsFolder', 'Playlists', {
      ParentId: ids.aggregate, TopParentId: ids.playlists, Path: '%AppDataPath%' + path.sep + 'playlists', Data: JSON.stringify({ CollectionType: 'playlists' }),
    }),
    row(ids.physical, 'Folder', 'Physical music', { ParentId: ids.aggregate, TopParentId: ids.physical }),
    row(ids.otherPhysical, 'Folder', 'Other physical music', { ParentId: ids.aggregate, TopParentId: ids.otherPhysical }),
    row(ids.memoryMediaFolder, 'Folder', 'Memory media parent', { ParentId: ids.physical, TopParentId: ids.physical }),

    row(ids.targetAlbum, 'MusicAlbum', 'Stored target display', {
      ParentId: ids.physical, TopParentId: ids.physical, CleanName: 'target album', SortName: 'z-target',
    }),
    row(ids.otherAlbum, 'MusicAlbum', 'Other album', {
      ParentId: ids.physical, TopParentId: ids.physical, SortName: 'y-other',
    }),
    row(ids.duplicateSlow, 'MusicAlbum', 'Duplicate slow', {
      ParentId: ids.physical, TopParentId: ids.physical, CleanName: 'duplicate', SortName: 'z-duplicate',
    }),
    row(ids.duplicateFast, 'MusicAlbum', 'Unrelated persisted display', {
      ParentId: ids.physical, TopParentId: ids.physical, CleanName: 'duplicate', SortName: 'a-duplicate',
    }),
    row(ids.ownerHidden, 'MusicAlbum', 'Owner competition', {
      ParentId: ids.physical, TopParentId: ids.physical, OwnerId: ids.otherAlbum, SortName: 'a-owner-hidden',
    }),
    row(ids.ownerVisible, 'MusicAlbum', 'Owner competition', {
      ParentId: ids.physical, TopParentId: ids.physical, SortName: 'z-owner-visible',
    }),
    row(ids.alternatePrimary, 'MusicAlbum', 'Alternate competition', {
      ParentId: ids.physical, TopParentId: ids.physical, SortName: 'z-alternate-primary',
    }),
    row(ids.alternateHidden, 'MusicAlbum', 'Alternate competition', {
      ParentId: ids.physical, TopParentId: ids.physical, PrimaryVersionId: ids.alternatePrimary, SortName: 'a-alternate-hidden',
    }),
    row(ids.crossTopAlternate, 'MusicAlbum', 'Cross top', {
      ParentId: ids.otherPhysical, TopParentId: ids.otherPhysical, PrimaryVersionId: ids.alternatePrimary, SortName: 'b-cross-top',
    }),
    row(ids.ownedExtra, 'MusicAlbum', 'Owned extra', {
      ParentId: ids.physical, TopParentId: ids.physical, OwnerId: ids.otherAlbum, ExtraType: 2, SortName: 'c-owned-extra',
    }),
    row(ids.parentlessAlbum, 'MusicAlbum', 'Parentless', {
      ParentId: null, TopParentId: null, SortName: 'd-parentless',
    }),
    row(ids.globalFirst, 'MusicAlbum', 'Global first', {
      ParentId: ids.physical, TopParentId: ids.physical, SortName: '0000-global-first',
    }),
    row(ids.bomAlbum, 'MusicAlbum', 'BOM clean selector', {
      ParentId: ids.physical, TopParentId: ids.physical, CleanName: '', SortName: 'e-bom',
    }),
    row(ids.fakeParent, 'Movie', 'Not an album', { ParentId: ids.physical, TopParentId: ids.physical }),

    row(ids.targetTrack, 'Audio', 'Target track', { ParentId: ids.targetAlbum, TopParentId: ids.physical }),
    row(ids.otherTrack, 'Audio', 'Other track', { ParentId: ids.otherAlbum, TopParentId: ids.physical }),
    row(ids.duplicateSlowTrack, 'Audio', 'Duplicate slow track', { ParentId: ids.duplicateSlow, TopParentId: ids.physical }),
    row(ids.duplicateFastTrack, 'Audio', 'Duplicate fast track', { ParentId: ids.duplicateFast, TopParentId: ids.physical }),
    row(ids.ownerHiddenTrack, 'Audio', 'Owner hidden track', { ParentId: ids.ownerHidden, TopParentId: ids.physical }),
    row(ids.ownerVisibleTrack, 'Audio', 'Owner visible track', { ParentId: ids.ownerVisible, TopParentId: ids.physical }),
    row(ids.alternatePrimaryTrack, 'Audio', 'Alternate primary track', { ParentId: ids.alternatePrimary, TopParentId: ids.physical }),
    row(ids.alternateHiddenTrack, 'Audio', 'Alternate hidden track', { ParentId: ids.alternateHidden, TopParentId: ids.physical }),
    row(ids.crossTopTrack, 'Audio', 'Cross-top track', { ParentId: ids.crossTopAlternate, TopParentId: ids.otherPhysical }),
    row(ids.ownedExtraTrack, 'Audio', 'Owned-extra track', { ParentId: ids.ownedExtra, TopParentId: ids.physical }),
    row(ids.parentlessTrack, 'Audio', 'Parentless-selector track', { ParentId: ids.parentlessAlbum, TopParentId: null }),
    row(ids.globalFirstTrack, 'Audio', 'Global-first track', { ParentId: ids.globalFirst, TopParentId: ids.physical }),
    row(ids.bomTrack, 'Audio', 'BOM track', { ParentId: ids.bomAlbum, TopParentId: ids.physical }),
    row(ids.grandchild, 'Audio', 'Grandchild', { ParentId: ids.targetTrack, TopParentId: ids.physical }),
    row(ids.fakeParentChild, 'Audio', 'Fake-parent child', { ParentId: ids.fakeParent, TopParentId: ids.physical }),
    row(ids.orphan, 'Audio', 'Orphan', { ParentId: null, TopParentId: null }),
    row(ids.memoryGroupA, 'Movie', 'Memory group A', {
      ParentId: ids.physical, TopParentId: ids.physical, PresentationUniqueKey: 'memory-group',
    }),
    row(ids.memoryGroupB, 'Movie', 'Memory group B', {
      ParentId: ids.physical, TopParentId: ids.physical, PresentationUniqueKey: 'memory-group',
    }),
    row(ids.memoryMediaPrimary, 'Movie', 'Memory media Z primary', {
      ParentId: ids.memoryMediaFolder, TopParentId: ids.physical, Width: 1920, Height: 1080,
      SortName: 'a-persisted-primary',
    }),
    row(ids.memoryMediaAlternate, 'Movie', 'Memory media alternate', {
      ParentId: ids.memoryMediaFolder, TopParentId: ids.physical, PrimaryVersionId: ids.memoryMediaPrimary,
      Width: 1920, Height: 1080,
    }),
    row(ids.memoryMediaOwned, 'Movie', 'Memory media owned', {
      ParentId: ids.memoryMediaFolder, TopParentId: ids.physical, OwnerId: ids.otherAlbum, Width: 1920, Height: 1080,
    }),
    row(ids.memoryMediaExtra, 'Movie', 'Memory media A extra', {
      ParentId: ids.memoryMediaFolder, TopParentId: ids.physical, OwnerId: ids.otherAlbum, ExtraType: 2,
      Width: 1920, Height: 1080, SortName: 'z-persisted-extra',
    }),
    row(ids.playlistDirect, 'Playlist', 'Direct playlist', {
      ParentId: ids.playlists, TopParentId: ids.playlists,
    }),
    row(ids.playlistContainer, 'Folder', 'Playlist container', {
      ParentId: ids.playlists, TopParentId: ids.playlists,
    }),
    row(ids.playlistNested, 'Playlist', 'Nested playlist', {
      ParentId: ids.playlistContainer, TopParentId: ids.playlists,
    }),
  ];
  for (const record of records) await database.insert('BaseItems', record);
  // Recursive repository queries read persisted ancestor rows independently
  // of the direct-parent graph used by the in-memory controls below.
  for (const [ItemId, ParentItemId] of [
    [ids.targetTrack, ids.physical],
    [ids.playlistDirect, ids.playlists],
    [ids.playlistNested, ids.playlists],
  ]) await database.insert('AncestorIds', { ItemId, ParentItemId });
}

const serviceOwners = new WeakMap();
async function service(database, programDataPath) {
  const ownsProgramDataPath = programDataPath == null;
  programDataPath ??= await mkdtemp(path.join(tmpdir(), 'mm-album-query-unit-'));
  const spoolRoot = path.join(programDataPath, 'metadata-spool');
  const store = new DomainStore(database);
  let library, itemCreation, linkedChildren;
  try {
    linkedChildren = await createStateRelations(database, spoolRoot);
    library = new LibraryService({fileSystem: testFileSystem,  store, linkedChildren, spoolRoot, serverId: 'album-query-test',
      userRoot: { Id: ids.userRoot }, programDataPath });
    const loadContext = createMetadataContextLoader({fileSystem: testFileSystem,  store, library, linkedChildren, spoolRoot });
    itemCreation = new ItemCreationService({ store, library, linkedChildren, loadContext });
    library.itemCreation = itemCreation;
    serviceOwners.set(library, { itemCreation, linkedChildren, ownsProgramDataPath, programDataPath });
    return library;
  } catch (error) {
    try { await closeStateDeletion({ itemCreation, library, linkedChildren }); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Album query fixture failed to initialize and close.', { cause: error }); }
    finally { if (ownsProgramDataPath) await removeOwnedProgramDataPath(programDataPath); }
    throw error;
  }
}

async function removeOwnedProgramDataPath(programDataPath) {
  const target = path.resolve(programDataPath);
  if (!target.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(target).startsWith('mm-album-query-unit-')) {
    throw new Error('The owned album query directory escaped the test temporary root.');
  }
  await rm(target, { recursive: true, force: true });
}

async function closeService(library) {
  if (!library) return;
  const owner = serviceOwners.get(library);
  try { await closeStateDeletion({ library, itemCreation: owner.itemCreation, linkedChildren: owner.linkedChildren }); }
  finally {
    serviceOwners.delete(library);
    if (owner.ownsProgramDataPath) await removeOwnedProgramDataPath(owner.programDataPath);
  }
}

const names = page => page.Items.map(item => item.Name);

test('album binding preserves native pipe/comma occurrence, CLR whitespace, and GUID conversion rules', () => {
  assert.deepEqual(parseQuery({ Albums: ' Target Album | Other Album ' }), { albums: ['Target Album', 'Other Album'] });
  assert.deepEqual(parseQuery({ Albums: ' \u0085 ' }), { albums: [''] });
  assert.deepEqual(parseQuery({ Albums: '\ufeff' }), { albums: ['\ufeff'] }, 'BOM is not CLR whitespace');
  assert.deepEqual(parseQuery({ Albums: '' }), {});
  assert.deepEqual(parseQuery({ Albums: '||' }), {}, 'empty segments from one pipe-delimited occurrence are discarded');

  const repeatedNames = new URLSearchParams();
  repeatedNames.append('Albums', 'Target Album|Other Album');
  repeatedNames.append('albums', 'Duplicate');
  assert.deepEqual(parseQuery(repeatedNames), { albums: ['Target Album|Other Album', 'Duplicate'] });
  const repeatedEmptyNames = new URLSearchParams();
  repeatedEmptyNames.append('Albums', '');
  repeatedEmptyNames.append('Albums', '');
  assert.deepEqual(parseQuery(repeatedEmptyNames), { albums: ['', ''] },
    'repeated collection occurrences are converted independently, including empty values');

  assert.deepEqual(parseQuery({ AlbumIds: `${ids.targetAlbum},invalid,${ids.otherAlbum}` }), {
    albumids: [ids.targetAlbum, ids.otherAlbum],
  });
  assert.deepEqual(parseQuery({ AlbumIds: ids.targetAlbum.replaceAll('-', '') }), { albumids: [ids.targetAlbum] });
  assert.deepEqual(parseQuery({ AlbumIds: `{${ids.targetAlbum}}` }), { albumids: [ids.targetAlbum] });
  assert.deepEqual(parseQuery({ AlbumIds: `(${ids.targetAlbum})` }), { albumids: [ids.targetAlbum] });
  assert.deepEqual(parseQuery({ AlbumIds: EMPTY_ID }), { albumids: [EMPTY_ID] });
  assert.deepEqual(parseQuery({ AlbumIds: `\ufeff${ids.targetAlbum}\ufeff` }), {});

  const repeatedComma = new URLSearchParams();
  repeatedComma.append('AlbumIds', `${ids.targetAlbum},${ids.otherAlbum}`);
  repeatedComma.append('AlbumIds', ids.otherAlbum);
  assert.deepEqual(parseQuery(repeatedComma), { albumids: [ids.otherAlbum] },
    'a comma inside one of several occurrences is not split and that occurrence fails conversion');

  const x = '{0x76000000,0x0000,0x0000,{0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x10}}';
  assert.deepEqual(parseQuery({ AlbumIds: x }), {}, 'one X-format occurrence is split by the comma binder');
  const repeatedX = new URLSearchParams();
  repeatedX.append('AlbumIds', x.replaceAll(',', '\u0085,\u0085'));
  repeatedX.append('AlbumIds', 'invalid');
  assert.deepEqual(parseQuery(repeatedX), { albumids: [ids.targetAlbum] });
  const bomX = new URLSearchParams();
  bomX.append('AlbumIds', x.replaceAll(',', '\ufeff,\ufeff'));
  bomX.append('AlbumIds', ids.otherAlbum);
  assert.deepEqual(parseQuery(bomX), { albumids: [ids.otherAlbum] });

  assert.equal(hasFilters({ albumids: [] }), false, 'empty resolved AlbumIds has native length semantics');
  assert.equal(hasFilters({ albumids: [EMPTY_ID] }), true, 'Guid.Empty is still a supplied album id');
});

test('Albums resolves globally by persisted CleanName, default SortName, and native selector eligibility',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const database = await createPostgresTestDatabase(t, 'album_query_names');
  let library;
  try {
    await seed(database);
    library = await service(database);
    const pick = async (Albums, candidates) => names(await library.queryItems({ Ids: candidates.join(','), Albums }));

    assert.deepEqual(await pick('Target Album', [ids.targetTrack, ids.otherTrack]), ['Target track'],
      'resolution uses persisted CleanName rather than the display Name');
    assert.deepEqual(await pick('Duplicate', [ids.duplicateSlowTrack, ids.duplicateFastTrack]), ['Duplicate fast track'],
      'Limit=1 follows default SortName order');
    assert.deepEqual(await pick('Owner Competition', [ids.ownerHiddenTrack, ids.ownerVisibleTrack]), ['Owner visible track']);
    assert.deepEqual(await pick('Alternate Competition', [ids.alternatePrimaryTrack, ids.alternateHiddenTrack]), ['Alternate primary track']);
    assert.deepEqual(await pick('Cross Top', [ids.crossTopTrack, ids.alternatePrimaryTrack]), ['Cross-top track'],
      'an alternate with a different top parent remains selector-eligible');
    assert.deepEqual(await pick('Owned Extra', [ids.ownedExtraTrack, ids.otherTrack]), ['Owned-extra track']);
    assert.deepEqual(await pick('Parentless', [ids.parentlessTrack, ids.otherTrack]), ['Parentless-selector track']);
    assert.deepEqual(await pick('   ', [ids.globalFirstTrack, ids.targetTrack]), ['Global-first track'],
      'CLR-whitespace suppresses the Name predicate and picks the global default-order first album');
    assert.deepEqual(await pick('\ufeff', [ids.bomTrack, ids.globalFirstTrack]), ['BOM track'],
      'BOM survives CLR trim and cleans to the persisted empty CleanName');

    const union = await pick('Target Album|Other Album|Target Album', [ids.targetTrack, ids.otherTrack]);
    assert.deepEqual(new Set(union), new Set(['Target track', 'Other track']), 'repeated resolved ids are harmless Contains inputs');
    assert.deepEqual(await pick('Missing|Target Album|Also Missing', [ids.targetTrack, ids.otherTrack]), ['Target track'],
      'unknown tokens contribute no id without discarding known resolutions');
  } finally { await closeService(library); }
});

test('Albums overrides direct AlbumIds only when its bound collection is nonempty',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const database = await createPostgresTestDatabase(t, 'album_query_override');
  let library;
  try {
    await seed(database);
    library = await service(database);
    const candidates = `${ids.targetTrack},${ids.otherTrack}`;
    assert.deepEqual(names(await library.queryItems({ Ids: candidates, AlbumIds: ids.otherAlbum, Albums: 'Target Album' })),
      ['Target track']);
    assert.deepEqual(names(await library.queryItems({ Ids: candidates, AlbumIds: ids.otherAlbum, Albums: '' })),
      ['Other track']);
    assert.deepEqual(names(await library.queryItems({ Ids: candidates, AlbumIds: ids.otherAlbum, Albums: '||' })),
      ['Other track']);
    assert.deepEqual(new Set(names(await library.queryItems({ Ids: candidates, AlbumIds: ids.otherAlbum, Albums: 'Missing' }))),
      new Set(['Target track', 'Other track']), 'an unresolved nonempty Albums collection replaces AlbumIds with an empty no-filter result');

    const repeatedEmpty = new URLSearchParams({ Ids: `${ids.globalFirstTrack},${ids.otherTrack}`, AlbumIds: ids.otherAlbum });
    repeatedEmpty.append('Albums', '');
    repeatedEmpty.append('Albums', '');
    assert.deepEqual(names(await library.queryItems(repeatedEmpty)), ['Global-first track'],
      'a repeated empty Albums occurrence is a nonempty bound collection and overrides direct AlbumIds');

    const albumsFirst = new URLSearchParams();
    albumsFirst.append('Albums', 'Target Album');
    albumsFirst.append('AlbumIds', ids.otherAlbum);
    albumsFirst.append('Ids', candidates);
    const idsFirst = new URLSearchParams();
    idsFirst.append('Ids', candidates);
    idsFirst.append('AlbumIds', ids.otherAlbum);
    idsFirst.append('Albums', 'Target Album');
    assert.deepEqual(names(await library.queryItems(albumsFirst)), ['Target track']);
    assert.deepEqual(names(await library.queryItems(idsFirst)), ['Target track'], 'override is independent of URL parameter order');
  } finally { await closeService(library); }
});

test('AlbumIds applies only on repository dispatch and preserves user-root versus aggregate-root behavior',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const database = await createPostgresTestDatabase(t, 'album_query_dispatch');
  const programDataPath = await mkdtemp(path.join(tmpdir(), 'mm-album-query-'));
  let library;
  try {
    await seed(database);
    library = await service(database, programDataPath);

    assert.deepEqual(names(await library.queryItems({ Albums: 'Target Album', IncludeItemTypes: 'Audio' }, { user })),
      ['Target track'], 'a filtered user root becomes a recursive repository query');
    await library.userViews.drain();
    const [createdView] = (await database.rows('BaseItems'))
      .filter(item => item.Type === 'MediaBrowser.Controller.Entities.UserView');
    assert.ok(createdView, 'the root query materializes the native Playlists UserView');
    assert.equal(JSON.parse(createdView.Data).DisplayParentId, idKey(ids.playlists));
    assert.ok(createdView.DateLastRefreshed && createdView.DateLastSaved, 'the actual queued refresh completed');
    assert.equal(dateText(JSON.parse(createdView.Data).DateLastSaved), dateText(createdView.DateLastSaved));
    assert.equal((await stat(path.join(programDataPath, 'metadata', 'views', idKey(createdView.Id)))).isDirectory(), true);
    await library.queryItems({ Albums: 'Target Album', IncludeItemTypes: 'Audio' }, { user });
    assert.deepEqual((await database.rows('BaseItems')).filter(item => item.Type === 'MediaBrowser.Controller.Entities.UserView'),
      [createdView], 'the repeated root query preserves the view row');
    assert.deepEqual(new Set(names(await library.queryItems({ Albums: 'Target Album' }))),
      new Set(['Physical music', 'Other physical music', 'Playlists']),
      'an API-key request without UserId stays on the nonrecursive Aggregate path and ignores AlbumIds');

    const memoryFolder = await library.queryItems({ ParentId: ids.physical, Recursive: false,
      Albums: 'Target Album', IncludeItemTypes: 'MusicAlbum' }, { user });
    assert.equal(names(memoryFolder).includes('Other album'), true, 'a nonrecursive ordinary Folder ignores AlbumIds');

    const memoryPage = await library.queryItems({ ParentId: ids.physical, Recursive: false,
      Albums: 'Target Album', IncludeItemTypes: 'MusicAlbum', SortBy: 'SortName', StartIndex: 1,
      Limit: 0, EnableTotalRecordCount: false }, { user });
    assert.equal(memoryPage.Items.length > 0, true, 'Limit=0 is unbounded on the in-memory folder path');
    assert.equal(memoryPage.StartIndex, 1);
    assert.equal(memoryPage.TotalRecordCount, memoryFolder.TotalRecordCount,
      'the in-memory folder path reports its pre-page total even when total counting is disabled');

    const memoryGroups = await library.queryItems({ ParentId: ids.physical, Recursive: false,
      NameStartsWith: 'Memory group' }, { user });
    assert.deepEqual(names(memoryGroups), ['Memory group A', 'Memory group B'],
      'the in-memory folder path does not presentation-group sibling rows');

    const memoryMedia = await library.queryItems({ ParentId: ids.memoryMediaFolder, Recursive: false,
      SortBy: 'SortName', IsHD: true }, { user });
    assert.deepEqual(names(memoryMedia), ['Memory media A extra', 'Memory media Z primary'],
      'the memory path cannot resurrect excluded rows and sorts a materialized item by its Name-derived SortName');

    assert.deepEqual(names(await library.queryItems({ ParentId: ids.physical, Recursive: true,
      Albums: 'Target Album', IncludeItemTypes: 'Audio' }, { user })), ['Target track']);
    assert.deepEqual(names(await library.queryItems({ ParentId: ids.physical, Recursive: false,
      Ids: `${ids.targetTrack},${ids.otherTrack}`, AlbumIds: ids.targetAlbum }, { user })), ['Target track'],
    'Ids forces the repository path even when Recursive=false');

    assert.deepEqual(names(await library.queryItems({
      Ids: `${ids.duplicateSlowTrack},${ids.targetTrack}`,
      AlbumIds: `${ids.targetAlbum},${ids.duplicateSlow}`,
    }, { user })), ['Duplicate slow track', 'Target track'],
    'without an explicit sort, the returned repository page follows the requested Ids order');

    const plainRoot = await library.queryItems({ Albums: 'Missing', SortBy: 'Name', Limit: 0 }, { user });
    assert.deepEqual(names(plainRoot), ['Alpha Library', 'Zeta Library', 'Playlists'],
      'an unresolved Albums-only user-root request preserves cached library order and bypasses request sorting/paging');

    const broad = names(await library.queryItems({ Albums: 'Missing', IncludeItemTypes: 'Audio' }, { user }));
    assert.equal(broad.includes('Target track'), true, 'another real filter keeps the user-root query recursive');
    assert.equal(broad.includes('Other track'), true);
    const explicitlyRecursive = names(await library.queryItems({ Albums: 'Missing', Recursive: true }, { user }));
    assert.equal(explicitlyRecursive.includes('Target track'), true,
      'Recursive=true remains a broad repository query after an unresolved Albums override');
  } finally {
    await closeService(library);
    const target = path.resolve(programDataPath);
    if (!target.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(target).startsWith('mm-album-query-')) {
      throw new Error('The album query test directory escaped the system temporary directory.');
    }
    await rm(target, { recursive: true, force: false });
  }
});

test('an explicit ParentId never falls back to an implicit root',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const database = await createPostgresTestDatabase(t, 'album_query_parent');
  let library;
  try {
    await seed(database);
    library = await service(database);
    const unknown = id(999);
    assert.deepEqual(parseQuery({ ParentId: EMPTY_ID }), { parentid: EMPTY_ID },
      'Guid.Empty remains distinguishable from an omitted ParentId after binding');

    for (const ParentId of [EMPTY_ID, unknown]) {
      await assert.rejects(library.queryItems({ ParentId }, { user }), error =>
        error.status === 400 && error.message === 'Error processing request.');
      assert.deepEqual(await library.queryResumeItems({ ParentId }, { user }),
        { Items: [], TotalRecordCount: 0, StartIndex: 0 });
    }

    const omitted = await library.queryItems({}, { user });
    assert.deepEqual(names(omitted), ['Alpha Library', 'Zeta Library', 'Playlists'],
      'only a genuinely omitted ParentId selects the user root');
  } finally { await closeService(library); }
});

test('PlaylistsFolder replaces item types and chooses recursion from user context',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const database = await createPostgresTestDatabase(t, 'album_query_playlists');
  let library;
  try {
    await seed(database);
    library = await service(database);

    const authenticated = await library.queryItems({
      ParentId: ids.playlists,
      Recursive: false,
      IncludeItemTypes: 'Movie',
      SortBy: 'Name',
    }, { user });
    assert.deepEqual(names(authenticated), ['Direct playlist', 'Nested playlist'],
      'a user request is forced recursive and IncludeItemTypes is replaced with Playlist');

    const userless = await library.queryItems({
      ParentId: ids.playlists,
      Recursive: true,
      IncludeItemTypes: 'Movie',
      SortBy: 'Name',
    });
    assert.deepEqual(names(userless), ['Direct playlist'],
      'an API-key request is forced nonrecursive and remains on the in-memory children path');
  } finally { await closeService(library); }
});
