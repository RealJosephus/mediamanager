import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { quoteIdentifier } from '../../src/database/model.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { LibraryService } from '../../src/library/library-service.js';
import { PlaylistService } from '../../src/library/playlist-service.js';
import { initializeLibraryRoot } from '../../src/library/root-initialization.js';
import { idKey, cleanValue } from '../../src/library/records.js';
import { nativeGuid } from '../../src/users/native.js';
import { attachStateDeletion, createStateRelations, closeStateDeletion } from './deletion-fixture.js';

const native = JSON.parse(await readFile(new URL('./fixtures/playlist-expansion/native.json', import.meta.url), 'utf8'));
for (const [filename, hash] of Object.entries(native.source.oracleFiles)) assert.equal(createHash('sha256')
  .update(await readFile(new URL('./fixtures/playlist-expansion/' + filename, import.meta.url))).digest('hex'), hash);
assert.equal(native.candidateVerified, false);
const id = index => nativeGuid(`79000000000000000000${String(index).padStart(12, '0')}`);
const normalizedShares = shares => shares.map(share => ({ ...share, UserId: idKey(share.UserId) }));
const withFixtureState = async (library, database, operation) => {
  const state = await library.load(database, null, { baseRows: await database.rows('BaseItems') });
  try { return await operation(state); } finally { await state.dispose({ session: database }); }
};
const owner = { Id: id(90), Policy: { IsAdministrator: false, EnableAllFolders: true, EnabledFolders: [],
  BlockedMediaFolders: [], BlockedTags: [], AllowedTags: [], BlockUnratedItems: [] }, MaxParentalRatingScore: null };
const row = (index, type, values = {}) => ({ Id: id(index), Type: `MediaBrowser.Controller.Entities.${type}`,
  Name: `Item ${index}`, CleanName: `item ${index}`, SortName: `item ${index}`, PresentationUniqueKey: idKey(id(index)), Path: `Z:\\Music\\Item ${index}`,
  MediaType: type === 'Audio.Audio' ? 'Audio' : type === 'Movies.Movie' ? 'Video' : 'Unknown',
  IsFolder: type === 'Folder', IsInMixedFolder: false, IsLocked: false, IsMovie: type === 'Movies.Movie',
  IsRepeat: false, IsSeries: false, IsVirtualItem: false, UnratedType: 'Other', Data: '{}',
  Genres: '', Studios: '', Tags: '', ProductionLocations: '', ...values });

async function fixture(dialect, run) {
  const schema = `pl_expand_${process.pid}_${randomBytes(4).toString('hex')}`;
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const store = new DomainStore(database), directory = await mkdtemp(path.join(tmpdir(), 'mm-pl-expansion-'));
  const programDataPath = path.join(directory, 'program'), dataPath = path.join(directory, 'data');
  const spoolRoot = path.join(directory, 'metadata-spool');
  const linkedChildren = await createStateRelations(database, spoolRoot);
  const library = new LibraryService({fileSystem: testFileSystem,  store, linkedChildren, spoolRoot, serverId: 'playlist-expansion', programDataPath, dataPath, configuration: {} });
  const itemCreation = attachStateDeletion({ store, library, linkedChildren, spoolRoot });
  const playlists = new PlaylistService({fileSystem: testFileSystem,  store, library, linkedChildren, spoolRoot, programDataPath, dataPath });
  try {
    await initializeLibraryRoot({fileSystem: testFileSystem,  store, programDataPath, dataPath, configuration: {} });
    await run({ database, store, library, playlists, directory });
  } finally {
    try { await closeStateDeletion({ playlists, itemCreation, library, linkedChildren }); }
    finally {
      try { await store.close(); }
      finally {
        try {
          if (dialect === 'postgres') {
            const client = new pg.Client({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES });
            try {
              await client.connect();
              for (const name of [database.schemaName, database.controlSchema]) await client.query(`DROP SCHEMA ${quoteIdentifier(name)} CASCADE`);
            } finally { await client.end(); }
          }
        } finally { await rm(directory, { recursive: true, force: true }); }
      }
    }
  }
}

for (const dialect of ['postgres']) {
  const options = { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES };
  test(`${dialect}: playlist expansion matches native query arguments and duplicate order`, options, async () => fixture(dialect, async ({ database, library, playlists }) => {
    for (const [index, type] of [[1, 'Audio.Audio'], [2, 'Movies.Movie'], [3, 'Photo'], [4, 'Folder'], [5, 'Audio.MusicArtist'], [6, 'Audio.MusicGenre']]) {
      await database.insert('BaseItems', row(index, type));
    }
    const queries = [];
    library.getItemList = async query => {
      queries.push({ ParentId: query.ParentId ? idKey(query.ParentId) : '0'.repeat(32), Recursive: query.Recursive,
        IsFolder: query.IsFolder ?? null, EnableTotalRecordCount: query.EnableTotalRecordCount ?? true,
        IncludeItemTypes: query.IncludeItemTypes ?? [], MediaTypes: query.MediaTypes ?? [],
        ArtistIds: (query.ArtistIds ?? []).map(idKey), GenreIds: (query.GenreIds ?? []).map(idKey),
        OrderBy: (query.SortBy ?? []).map((Key, index) => ({ Key, Direction: query.SortOrder[index] })) });
      return withFixtureState(library, database, state => state.items.filter(item => [idKey(id(2)), idKey(id(1)), idKey(id(3))].includes(idKey(item.Id)))
        .sort((left, right) => [2, 1, 3].indexOf(Number(left.Id.slice(-12))) - [2, 1, 3].indexOf(Number(right.Id.slice(-12)))));
    };
    const created = await playlists.create({ name: 'Native expansion', user: owner, ids: [1, 3, 4, 5, 6, 1].map(id) });
    assert.deepEqual((await playlists.get(created.Id, { user: owner })).ItemIds, native.results);
    assert.deepEqual(queries, native.queries);
    queries.length = 0;
    await playlists.update(created.Id, { user: owner, ids: [4, 5, 6].map(id) });
    assert.deepEqual(queries, native.queries);
    assert.deepEqual((await playlists.get(created.Id, { user: owner })).ItemIds, native.results.slice(1, -1));
  }));

  test(`${dialect}: recursive playlists use persisted ancestors, artist roles, genre links and visible leaves`, options, async () => fixture(dialect, async ({ database, library, playlists }) => {
    const roots = await database.rows('BaseItems');
    const aggregate = roots.find(item => item.Type.endsWith('.AggregateFolder'));
    const userRoot = await withFixtureState(library, database, state => {
      const item = state.items.find(item => item.Type === 'UserRootFolder');
      return { Id: item.Id, Path: item.Path };
    });
    await database.insert('BaseItems', { ...row(91, 'UserRootFolder', { IsFolder: true, Path: userRoot.Path }), Id: userRoot.Id });
    await database.insert('BaseItems', row(4, 'Folder', { ParentId: aggregate.Id, TopParentId: id(4), Path: 'Z:\\Music' }));
    await database.insert('BaseItems', row(7, 'CollectionFolder', { ParentId: userRoot.Id, IsFolder: true,
      Path: path.join(library.options.programDataPath, 'root', 'default', 'Music'),
      Data: JSON.stringify({ CollectionType: 'music', PhysicalFolderIds: [id(4)], PhysicalLocationsList: ['Z:\\Music'] }) }));
    for (const [index, type, values] of [
      [1, 'Audio.Audio', { Album: 'Beta', Artists: 'Artist', AlbumArtists: 'Artist', SortName: 'b' }],
      [2, 'Audio.Audio', { Album: 'Alpha', Artists: 'Artist', AlbumArtists: 'Artist', SortName: 'a' }],
      [3, 'Photo', { MediaType: 'Photo' }], [8, 'Audio.Audio', { Tags: 'blocked' }],
      [9, 'Audio.Audio', { OwnerId: id(1) }], [10, 'Audio.Audio', { PrimaryVersionId: id(1) }]
    ]) {
      await database.insert('BaseItems', row(index, type, { ...values, ParentId: id(4), TopParentId: id(4) }));
      await database.insert('AncestorIds', { ItemId: id(index), ParentItemId: id(4) });
    }
    await database.insert('BaseItems', row(5, 'Audio.MusicArtist', { Name: 'Artist', CleanName: 'artist' }));
    await database.insert('BaseItems', row(6, 'Audio.MusicGenre', { Name: 'Jazz', CleanName: 'jazz' }));
    for (const [index, Type, Value] of [[101, 0, 'Artist'], [102, 1, 'Artist'], [103, 2, 'Jazz']]) {
      await database.insert('ItemValues', { ItemValueId: id(index), Type, Value, CleanValue: cleanValue(Value) });
      for (const track of [1, 2]) await database.insert('ItemValuesMap', { ItemId: id(track), ItemValueId: id(index) });
    }
    await database.insert('ItemValues', { ItemValueId: id(104), Type: 4, Value: 'blocked', CleanValue: 'blocked' });
    await database.insert('ItemValuesMap', { ItemId: id(8), ItemValueId: id(104) });
    const account = { ...owner, Policy: { ...owner.Policy, BlockedTags: ['blocked'] } };
    const created = await playlists.create({ name: 'Folder', user: account, ids: [id(4), id(4)] });
    assert.deepEqual((await playlists.get(created.Id, { user: account })).ItemIds, [id(2), id(1), id(2), id(1)].map(idKey));
    await playlists.update(created.Id, { user: account, ids: [id(5), id(6)] });
    assert.deepEqual((await playlists.get(created.Id, { user: account })).ItemIds, [id(2), id(1), id(2), id(1)].map(idKey));
    const nested = await playlists.create({ name: 'Nested', user: account, ids: [created.Id] });
    assert.deepEqual((await playlists.get(nested.Id, { user: account })).ItemIds, [id(2), id(1)].map(idKey),
      'A recursive linked descendant query deduplicates the source playlist before the destination appends it.');
    assert.equal((await database.rows('BaseItems', { where: { Id: nativeGuid(created.Id) } }))[0].MediaType, 'Audio');
    const snapshot = await database.rows('LinkedChildren', { where: { ParentId: nativeGuid(created.Id) } });
    const original = library.getItemList.bind(library);
    library.getItemList = async query => { if (query.GenreIds) throw new Error('injected expansion failure'); return original(query); };
    await assert.rejects(playlists.update(created.Id, { user: account, ids: [id(5), id(6)] }), /injected expansion failure/);
    assert.deepEqual(await database.rows('LinkedChildren', { where: { ParentId: nativeGuid(created.Id) } }), snapshot);
  }));

  test(`${dialect}: user deletion ranks shares stably, preserves private sources and keeps public unshared playlists`, options, async () => fixture(dialect, async ({ database, playlists }) => {
    await database.insert('BaseItems', row(1, 'Audio.Audio'));
    const other = { ...owner, Id: id(91) };
    const shared = await playlists.create({ name: 'Shared', user: owner, isPublic: false, ids: [id(1)], users: [
      { UserId: id(92), CanEdit: false }, { UserId: id(93), CanEdit: true }, { UserId: id(94), CanEdit: true }
    ] });
    const privateItem = await playlists.create({ name: 'Private', user: owner, isPublic: false });
    const publicItem = await playlists.create({ name: 'Public', user: owner, isPublic: true });
    const foreign = await playlists.create({ name: 'Foreign', user: other, isPublic: false,
      users: [{ UserId: owner.Id, CanEdit: true }, { UserId: id(95), CanEdit: false }] });
    const hidden = await playlists.create({ name: 'Hidden', user: other, isPublic: false });
    const privatePath = (await database.rows('BaseItems', { where: { Id: nativeGuid(privateItem.Id) } }))[0].Path;
    await playlists.removeForDeletedUser(owner);
    const transferred = (await database.rows('BaseItems', { where: { Id: nativeGuid(shared.Id) } }))[0];
    assert.deepEqual(normalizedShares(JSON.parse(transferred.Data).Shares), [
      { UserId: idKey(id(94)), CanEdit: true }, { UserId: idKey(id(92)), CanEdit: false }
    ]);
    assert.equal(idKey(JSON.parse(transferred.Data).OwnerUserId), idKey(id(93)));
    assert.match(await readFile(path.join(transferred.Path, 'playlist.xml'), 'utf8'), new RegExp(`<OwnerUserId>${idKey(id(93))}</OwnerUserId>`, 'u'));
    assert.equal((await database.rows('BaseItems', { where: { Id: nativeGuid(privateItem.Id) } })).length, 0);
    assert.match(await readFile(path.join(privatePath, 'playlist.xml'), 'utf8'), /<Item>/u,
      'Native user cleanup passes DeleteFileLocation=false and preserves the source XML.');
    assert.equal(idKey(JSON.parse((await database.rows('BaseItems', { where: { Id: nativeGuid(publicItem.Id) } }))[0].Data).OwnerUserId), idKey(owner.Id));
    assert.equal(idKey(JSON.parse((await database.rows('BaseItems', { where: { Id: nativeGuid(foreign.Id) } }))[0].Data).OwnerUserId), idKey(owner.Id),
      'The native visible set includes a shared playlist owned by another user.');
    assert.equal(idKey(JSON.parse((await database.rows('BaseItems', { where: { Id: nativeGuid(hidden.Id) } }))[0].Data).OwnerUserId), idKey(other.Id));
    assert.equal((await database.rows('BaseItems', { where: { Id: id(1) } })).length, 1);
  }));

  test(`${dialect}: user-deletion owner transfer compensates XML when the database commit fails`, options, async () => fixture(dialect, async ({ database, playlists }) => {
    const created = await playlists.create({ name: 'Transfer rollback', user: owner, isPublic: false,
      users: [{ UserId: id(93), CanEdit: true }] });
    // A synchronous update drains creation's asynchronous ForceSave.
    await playlists.update(created.Id, { user: owner });
    const snapshot = (await database.rows('BaseItems', { where: { Id: nativeGuid(created.Id) } }))[0];
    const xmlPath = path.join(snapshot.Path, 'playlist.xml'), originalXml = await readFile(xmlPath);
    const originalTransaction = playlists.store.transaction.bind(playlists.store);
    playlists.store.transaction = (operation, options) => originalTransaction(async db => {
      await operation(db); throw new Error('injected transfer commit failure');
    }, options);
    try { await assert.rejects(playlists.removeForDeletedUser(owner), /injected transfer commit failure/); }
    finally { playlists.store.transaction = originalTransaction; }
    assert.deepEqual((await database.rows('BaseItems', { where: { Id: nativeGuid(created.Id) } }))[0], snapshot);
    assert.deepEqual(await readFile(xmlPath), originalXml);
  }));
}
