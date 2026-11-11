import { testFileSystem } from '../storage/plugin-files.js';
import { attachLibraryNavigation, closeLibraryNavigation } from './navigation-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import pg from 'pg';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { decodeNativeTextBytes } from '../../src/database/native-text.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import { quoteIdentifier } from '../../src/database/model.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { LibraryService } from '../../src/library/library-service.js';
import { PlaylistService } from '../../src/library/playlist-service.js';
import { queryPostgresDeletedUserPlaylistBatch } from '../../src/library/postgres-playlist-query.js';
import { initializeLibraryRoot } from '../../src/library/root-initialization.js';
import { nativeGuid } from '../../src/users/native.js';
import { attachStateDeletion, createStateRelations, closeStateDeletion } from './deletion-fixture.js';

const id = value => nativeGuid(`7a000000000000000000${String(value).padStart(12, '0')}`);
const idKey = value => String(value).replaceAll('-', '').toLowerCase();
const guidFormats = value => {
  const key = idKey(value);
  const dashed = key.replace(/^(........)(....)(....)(....)(............)$/u, '$1-$2-$3-$4-$5');
  return [dashed, key.toUpperCase(), `{${dashed}}`, `(${dashed})`,
    `{0x${key.slice(0, 8)},0x${key.slice(8, 12)},0x${key.slice(12, 16)},{`
      + Array.from({ length: 8 }, (_, index) => `0x${key.slice(16 + index * 2, 18 + index * 2)}`).join(',') + '}}'];
};
const account = value => ({
  Id: id(value),
  MaxParentalRatingScore: null,
  MaxParentalRatingSubScore: null,
  Policy: {
    IsAdministrator: false,
    EnableAllFolders: true,
    EnabledFolders: [],
    BlockedMediaFolders: [],
    BlockedTags: [],
    AllowedTags: [],
    BlockUnratedItems: [],
  },
});
const mediaRow = (Id, name, filename) => ({
  Id,
  Type: 'MediaBrowser.Controller.Entities.Movies.Movie',
  Name: name,
  CleanName: name.toLowerCase(),
  SortName: name.toLowerCase(),
  Path: filename,
  IsFolder: false,
  IsInMixedFolder: false,
  IsLocked: false,
  IsMovie: true,
  IsRepeat: false,
  IsSeries: false,
  IsVirtualItem: false,
  MediaType: 'Video',
  UnratedType: 'Movie',
  Genres: '',
  Studios: '',
  Tags: '',
  ProductionLocations: '',
  Data: '{}',
});

test('playlist folder queries apply private access before counting and paging', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const database = await createPostgresTestDatabase(t, 'playlist_gate');
  const directory = await mkdtemp(path.join(tmpdir(), 'mm-playlist-query-access-'));
  const programDataPath = path.join(directory, 'program'), spoolRoot = path.join(directory, 'metadata-spool');
  const linkedChildren = await createStateRelations(database, spoolRoot);
  let library;
  t.after(async () => {
    try {
      const errors = [];
      for (const close of [() => closeLibraryNavigation(library), () => closeStateDeletion({ library, linkedChildren })]) {
        try { await close(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Playlist navigation owners failed to close.');
    }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  library = new LibraryService({fileSystem: testFileSystem,  store: new DomainStore(database), linkedChildren, spoolRoot, serverId: 'playlist-gate', programDataPath });
  await attachLibraryNavigation(library);
  const folderId = id(500), privateId = id(501), publicId = id(502), sharedId = id(503);
  const owner = account(590), reader = account(591), sharedReader = account(592);
  await database.insert('BaseItems', {
    ...mediaRow(folderId, 'Playlists', path.join(programDataPath, 'data', 'playlists')),
    Type: 'Emby.Server.Implementations.Playlists.PlaylistsFolder', IsFolder: true,
    Data: '{"CollectionType":"playlists"}',
  });
  for (const [Id, name, OpenAccess] of [[privateId, 'A private', false], [publicId, 'B public', true],
    [sharedId, 'C shared', false]]) {
    await database.insert('BaseItems', {
      ...mediaRow(Id, name, path.join(programDataPath, 'data', 'playlists', name)),
      Type: 'MediaBrowser.Controller.Playlists.Playlist', IsFolder: true, ParentId: folderId,
      Data: JSON.stringify({ OwnerUserId: owner.Id, OpenAccess,
        Shares: Id === sharedId ? [{ UserId: idKey(sharedReader.Id), CanEdit: false }] : [], PlaylistMediaType: 'Video' }),
    });
    await database.insert('AncestorIds', { ItemId: Id, ParentItemId: folderId });
  }
  await assert.rejects(library.getItem(privateId, { user: reader }), error => error.status === 404);
  const query = { ParentId: folderId, IncludeItemTypes: 'Movie', Recursive: false,
    SortBy: 'SortName', Limit: 1, EnableImages: false, EnableUserData: false };
  const page = await library.queryItems(query, { user: reader });
  assert.deepEqual(page.Items.map(item => item.Id), [idKey(publicId)]);
  assert.equal(page.TotalRecordCount, 1);
  for (const [user, StartIndex, expected, total] of [
    [owner, 0, privateId, 3], [owner, 2, sharedId, 3],
    [sharedReader, 1, sharedId, 2], [reader, 1, null, 1],
  ]) {
    const result = await library.queryItems({ ...query, StartIndex }, { user });
    assert.deepEqual(result.Items.map(item => item.Id), expected ? [idKey(expected)] : []);
    assert.equal(result.TotalRecordCount, total);
  }
  await database.update('BaseItems', { Id: privateId }, { Path: path.join('%appdatapath%', 'playlists', 'A private') });
  const virtualPathPage = await library.queryItems(query, { user: reader });
  assert.deepEqual(virtualPathPage.Items.map(item => item.Id), [idKey(publicId)]);
  assert.equal(virtualPathPage.TotalRecordCount, 1);
});

test('postgres playlist pages hydrate bounded members and lifecycle changes persist', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = `playlist_bounds_${process.pid}_${randomBytes(4).toString('hex')}`;
  const database = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
    schema,
    create: true,
  });
  const store = new DomainStore(database);
  const directory = await mkdtemp(path.join(tmpdir(), 'mm-playlist-bounds-'));
  const programDataPath = path.join(directory, 'program');
  const dataPath = path.join(directory, 'data');
  const spoolRoot = path.join(directory, 'metadata-spool');
  const linkedChildren = await createStateRelations(database, spoolRoot);
  const library = new LibraryService({fileSystem: testFileSystem,  store, linkedChildren, spoolRoot, serverId: 'playlist-bounds', programDataPath, dataPath, configuration: {} });
  const itemCreation = attachStateDeletion({ store, library, linkedChildren, spoolRoot });
  const playlists = new PlaylistService({fileSystem: testFileSystem,  store, library, linkedChildren, spoolRoot, programDataPath, dataPath, configuration: {} });
  const failureSnapshot = error => inspect(error, { depth: null, showHidden: true, maxArrayLength: null, maxStringLength: null })
    .replaceAll(process.env.MEDIAMANAGER_TEST_POSTGRES, '[fixture-secret]');
  const observeFailure = (phase, error) => t.diagnostic(JSON.stringify({
    name: 'playlist-bounds-failure', phase, error: failureSnapshot(error),
  }));
  let failed = false, primary;
  try {
    await initializeLibraryRoot({fileSystem: testFileSystem,  store, programDataPath, dataPath, configuration: {} });
    await database.insert('BaseItems', mediaRow(id(1), 'First', path.join(directory, 'first.mkv')));
    await database.insert('BaseItems', { ...mediaRow(id(2), 'Second', path.join(directory, 'second.mkv')), Tags: 'hidden' });

    let largestBaseItemBatch = 0;
    const largeMemberIds = new Set();
    const hydratedLargeMemberIds = new Set();
    const baseItemsTableId = Number((await database.client.query({
      text: 'SELECT $1::regclass::oid AS "oid"',
      values: [`${quoteIdentifier(schema)}."BaseItems"`],
    })).rows[0].oid);
    const observeHydration = async operation => {
      const hook = database.queryHook;
      database.queryHook = async (...args) => {
        const result = await (hook ? hook.call(database.client, ...args) : database.client.query(...args));
        const fields = result.command === 'SELECT'
          ? result.fields.filter(field => field.tableID === baseItemsTableId) : [];
        const idField = fields.find(field => field.name === 'Id');
        if (idField && fields.some(field => field.name === 'Data')) {
          largestBaseItemBatch = Math.max(largestBaseItemBatch, result.rows.length);
          for (const row of result.rows) {
            const key = idKey(decodeNativeTextBytes(row[idField.name]));
            if (largeMemberIds.has(key)) hydratedLargeMemberIds.add(key);
          }
        }
        return result;
      };
      try { return await operation(); }
      finally { database.queryHook = hook; }
    };
    const owner = account(90);
    const editor = account(91);
    const created = await playlists.create({ name: 'Bounded', user: owner, ids: [id(1), id(2)], isPublic: false,
      users: [{ UserId: editor.Id, CanEdit: true }] });
    assert.deepEqual((await playlists.get(created.Id, { user: owner })).ItemIds.map(idKey), [idKey(id(1)), idKey(id(2))]);
    const createdLinks = await database.rows('LinkedChildren', { where: { ParentId: nativeGuid(created.Id) },
      orderBy: [{ column: 'SortOrder' }] });
    assert.deepEqual(createdLinks.map(row => idKey(row.ChildId)), [idKey(id(1)), idKey(id(2))]);
    assert.deepEqual((await playlists.getItems(created.Id, { user: owner, startIndex: 1, limit: 1,
      dtoOptions: { EnableImages: false, EnableUserData: false } })).Items.map(item => item.Name), ['Second']);
    const restricted = { ...owner, Policy: { ...owner.Policy, BlockedTags: ['hidden'] } };
    const filtered = await playlists.getItems(created.Id, { user: restricted,
      dtoOptions: { EnableImages: false, EnableUserData: false } });
    assert.equal(filtered.TotalRecordCount, 1);
    assert.deepEqual(filtered.Items.map(item => item.Name), ['First']);

    const searchBatch = [
      await playlists.create({ name: 'Search batch alpha', user: owner, isPublic: true }),
      await playlists.create({ name: 'Search batch beta', user: owner, isPublic: true }),
      await playlists.create({ name: 'Search batch gamma', user: owner, isPublic: true }),
    ];
    const searchResult = await library.queryItems({
      SearchTerm: 'Search batch', IncludeItemTypes: 'Playlist', Limit: '10',
      EnableImages: 'false', EnableUserData: 'false',
    }, { user: { ...owner, MaxParentalRatingScore: 5, Configuration: {} } });
    assert.deepEqual(searchResult.Items.map(item => item.Name),
      ['Search batch alpha', 'Search batch beta', 'Search batch gamma']);
    for (const playlist of searchBatch) await playlists.delete(playlist.Id, { user: owner });

    const createdRow = (await database.rows('BaseItems', { where: { Id: nativeGuid(created.Id) } }))[0];
    const originalData = createdRow.Data;
    for (const data of ['bad{', '[]']) {
      await database.update('BaseItems', { Id: createdRow.Id }, { Data: data });
      const malformed = await queryPostgresDeletedUserPlaylistBatch(database, {
        userId: owner.Id, playlistFolderId: createdRow.ParentId,
      });
      assert.deepEqual(malformed, [], `invalid playlist Data falls back without aborting: ${data}`);
    }
    await database.update('BaseItems', { Id: createdRow.Id }, { Data: JSON.stringify({
      OwnerUserId: owner.Id, OpenAccess: { invalid: true }, Shares: [],
    }) });
    const wrongBoolean = await queryPostgresDeletedUserPlaylistBatch(database, {
      userId: owner.Id, playlistFolderId: createdRow.ParentId,
    });
    assert.deepEqual(wrongBoolean, [],
      'a wrong-typed known field falls back the entire native Data object without aborting');
    await database.update('BaseItems', { Id: createdRow.Id }, { Data: JSON.stringify({
      OwnerUserId: owner.Id, OpenAccess: false, Shares: [], PlaylistMediaType: 'bogus',
    }) });
    assert.deepEqual(await queryPostgresDeletedUserPlaylistBatch(database, {
      userId: owner.Id, playlistFolderId: createdRow.ParentId,
    }), [], 'an invalid enum sibling also falls back the entire native Data object');
    for (const ownerId of guidFormats(owner.Id)) {
      await database.update('BaseItems', { Id: createdRow.Id }, { Data: JSON.stringify({
        OwnerUserId: ownerId, OpenAccess: false, Shares: [], PlaylistMediaType: 'Video',
      }) });
      assert.deepEqual((await queryPostgresDeletedUserPlaylistBatch(database, {
        userId: owner.Id, playlistFolderId: createdRow.ParentId,
      })).map(row => idKey(row.Id)), [idKey(createdRow.Id)],
      `OwnerUserId matches the native GUID format ${ownerId}`);
    }
    for (const sharedUserId of guidFormats(owner.Id)) {
      await database.update('BaseItems', { Id: createdRow.Id }, { Data: JSON.stringify({
        OwnerUserId: editor.Id, OpenAccess: false,
        Shares: [{ UserId: sharedUserId, CanEdit: false }], PlaylistMediaType: 'Video',
      }) });
      assert.deepEqual((await queryPostgresDeletedUserPlaylistBatch(database, {
        userId: owner.Id, playlistFolderId: createdRow.ParentId,
      })).map(row => idKey(row.Id)), [idKey(createdRow.Id)],
      `Shares.UserId matches the native GUID format ${sharedUserId}`);
    }
    await database.update('BaseItems', { Id: createdRow.Id }, { Data: originalData });

    const cleanupUser = { ...account(92), MaxParentalRatingScore: 5 };
    const cleanupOwner = account(93);
    const cleanupIds = Array.from({ length: 32 }, (_, index) => id(800 + index));
    const cleanupData = OpenAccess => JSON.stringify({
      OwnerUserId: cleanupOwner.Id,
      OpenAccess,
      Shares: [],
      PlaylistMediaType: 'Video',
    });
    for (let index = 0; index < cleanupIds.length; index++) {
      await database.insert('BaseItems', {
        ...mediaRow(cleanupIds[index], `Cleanup batch ${index + 1}`,
          path.join(directory, `cleanup-${index + 1}.m3u`)),
        ParentId: createdRow.ParentId,
        Type: 'MediaBrowser.Controller.Playlists.Playlist',
        IsMovie: false,
        MediaType: 'Unknown',
        Data: cleanupData(index === 0),
      });
    }
    const cleanupRows = () => database.rows('BaseItems', { whereIn: { Id: cleanupIds } });
    const mixedAccessRows = await cleanupRows();
    await playlists.removeForDeletedUser(cleanupUser);
    assert.deepEqual(await cleanupRows(), mixedAccessRows);
    for (let index = 1; index < cleanupIds.length; index++) {
      await database.update('BaseItems', { Id: cleanupIds[index] }, { Data: cleanupData(true) });
    }
    const publicRows = await cleanupRows();
    await playlists.removeForDeletedUser(cleanupUser);
    assert.deepEqual(await cleanupRows(), publicRows);

    await database.insert('BaseItems', {
      ...mediaRow(id(3), 'Unicode tag', path.join(directory, 'unicode-tag.mkv')),
      Tags: 'RÖCK',
    });
    const unicodeTags = await playlists.create({ name: 'Unicode tags', user: owner, ids: [id(3)], isPublic: false });
    const unicodeBlocked = { ...owner, Policy: { ...owner.Policy, BlockedTags: ['Rock'] } };
    const blockedUnicodePage = await playlists.getItems(unicodeTags.Id, { user: unicodeBlocked,
      dtoOptions: { EnableImages: false, EnableUserData: false } });
    assert.equal(blockedUnicodePage.TotalRecordCount, 0,
      'direct tags use the same diacritic-insensitive CleanValue rule as policy tags');
    const unicodeAllowed = { ...owner, Policy: { ...owner.Policy, AllowedTags: ['Rock'] } };
    const allowedUnicodePage = await playlists.getItems(unicodeTags.Id, { user: unicodeAllowed,
      dtoOptions: { EnableImages: false, EnableUserData: false } });
    assert.deepEqual(allowedUnicodePage.Items.map(item => item.Name), ['Unicode tag']);

    const deepChildId = id(300);
    const deepParentIds = Array.from({ length: 70 }, (_, index) => id(301 + index));
    await store.transaction(async db => {
      await db.insert('BaseItems', mediaRow(deepChildId, 'Deep child', path.join(directory, 'deep-child.mkv')));
      for (let index = 0; index < deepParentIds.length; index++) {
        const isRoot = index === deepParentIds.length - 1;
        await db.insert('BaseItems', {
          ...mediaRow(deepParentIds[index], `Deep parent ${index + 1}`, path.join(directory, `deep-parent-${index + 1}`)),
          Type: isRoot
            ? 'MediaBrowser.Controller.Entities.CollectionFolder'
            : 'MediaBrowser.Controller.Entities.Folder',
          IsFolder: true,
          IsMovie: false,
          MediaType: 'Unknown',
          Tags: isRoot ? 'deep-hidden|deep-allow' : '',
          InheritedParentalRatingValue: isRoot ? 10 : null,
        });
      }
      await db.update('BaseItems', { Id: deepChildId }, { ParentId: deepParentIds[0] });
      for (let index = 0; index < deepParentIds.length; index++) {
        const parentId = index === deepParentIds.length - 1 ? deepParentIds[34] : deepParentIds[index + 1];
        await db.update('BaseItems', { Id: deepParentIds[index] }, { ParentId: parentId });
      }
    });
    const deep = await playlists.create({ name: 'Deep ancestry', user: owner, ids: [deepChildId], isPublic: false });
    const deepBlocked = { ...owner, Policy: { ...owner.Policy, BlockedTags: ['deep hidden'] } };
    assert.equal((await playlists.getItems(deep.Id, { user: deepBlocked,
      dtoOptions: { EnableImages: false, EnableUserData: false } })).TotalRecordCount, 0,
    'a blocked tag above the former depth limit cannot be bypassed');
    const deepAllowed = { ...owner, Policy: { ...owner.Policy, AllowedTags: ['deep allow'] } };
    assert.deepEqual((await playlists.getItems(deep.Id, { user: deepAllowed,
      dtoOptions: { EnableImages: false, EnableUserData: false } })).Items.map(item => item.Name), ['Deep child'],
    'an allowed tag above the former depth limit remains effective');
    const deepRatingBlocked = { ...owner, MaxParentalRatingScore: 5 };
    await assert.rejects(playlists.getItems(deep.Id, { user: deepRatingBlocked,
      dtoOptions: { EnableImages: false, EnableUserData: false } }),
    error => error?.statusCode === 404,
    'parental visibility above the former depth limit keeps the playlist inaccessible');
    const deepLibraryBlocked = {
      ...owner,
      Policy: { ...owner.Policy, EnableAllFolders: false, EnabledFolders: [] },
    };
    assert.equal((await playlists.getItems(deep.Id, { user: deepLibraryBlocked,
      dtoOptions: { EnableImages: false, EnableUserData: false } })).TotalRecordCount, 0,
    'a deeply nested collection policy cannot be bypassed');

    await playlists.delete(deep.Id, { user: owner });
    await store.transaction(async db => {
      await db.update('BaseItems', { Id: deepChildId }, { ParentId: null });
      await db.update('BaseItems', { Id: deepParentIds.at(-1) }, { ParentId: null });
      await db.delete('BaseItems', { Id: deepChildId });
      for (const parentId of deepParentIds) await db.delete('BaseItems', { Id: parentId });
    });

    const large = await playlists.create({ name: 'Large bounded page', user: owner, isPublic: true });
    const largeId = nativeGuid(large.Id);
    await store.transaction(async db => {
      for (let index = 100; index < 240; index++) {
        const childId = id(index);
        largeMemberIds.add(idKey(childId));
        await db.insert('BaseItems', mediaRow(childId, `Large ${index}`, path.join(directory, `large-${index}.mkv`)));
        await db.insert('LinkedChildren', { ParentId: largeId, SortOrder: index - 100, ChildId: childId, ChildType: 0 });
      }
    });
    largestBaseItemBatch = 0;
    hydratedLargeMemberIds.clear();
    const largePage = await observeHydration(() => playlists.getItems(large.Id, { user: owner, startIndex: 60, limit: 3,
      dtoOptions: { EnableImages: false, EnableUserData: false } }));
    assert.equal(largePage.TotalRecordCount, largeMemberIds.size);
    assert.deepEqual(largePage.Items.map(item => item.Id), [160, 161, 162].map(value => idKey(id(value))));
    assert.ok(largestBaseItemBatch <= 128, `largest complete BaseItems result batch was ${largestBaseItemBatch}`);
    assert.ok(hydratedLargeMemberIds.size <= 128, `hydrated ${hydratedLargeMemberIds.size} playlist members`);
    largestBaseItemBatch = 0;
    hydratedLargeMemberIds.clear();
    const genericPage = await observeHydration(() => library.queryItems({ ParentId: large.Id, StartIndex: 60, Limit: 3,
      EnableImages: false, EnableUserData: false }, { user: owner }));
    assert.equal(genericPage.TotalRecordCount, largeMemberIds.size);
    assert.deepEqual(genericPage.Items.map(item => item.Id), largePage.Items.map(item => item.Id));
    assert.ok(largestBaseItemBatch <= 128, `generic playlist page returned a complete BaseItems batch of ${largestBaseItemBatch}`);
    assert.ok(hydratedLargeMemberIds.size <= 128, `generic page hydrated ${hydratedLargeMemberIds.size} playlist members`);
    await playlists.add(created.Id, [id(1)], { user: editor, position: 1 });
    await playlists.move(created.Id, id(2).replaceAll('-', '').toLowerCase(), 0, { user: editor });
    await playlists.remove(created.Id, [id(1).replaceAll('-', '').toLowerCase()], { user: editor });
    await playlists.update(created.Id, { user: owner, ids: [id(2), id(1)] });
    await playlists.updateUser(created.Id, editor.Id, { user: owner, canEdit: false });
    await playlists.removeUser(created.Id, editor.Id, { user: owner });
    await playlists.update(created.Id, { user: owner, isPublic: true });
    await playlists.delete(unicodeTags.Id, { user: owner });
    const orphan = await playlists.create({ name: 'Deleted owner', user: owner, isPublic: false });
    await playlists.removeForDeletedUser(owner);
    assert.deepEqual(await database.rows('BaseItems', { where: { Id: nativeGuid(orphan.Id) } }), []);
    await database.insert('LinkedChildren', { ParentId: nativeGuid(created.Id), SortOrder: 2, ChildId: largeId, ChildType: 0 });
    await playlists.delete(large.Id, { user: owner });
    assert.deepEqual(await database.rows('LinkedChildren', { whereAny: { ParentId: [largeId], ChildId: [largeId] } }), []);
    await playlists.delete(created.Id, { user: owner });
  } catch (error) {
    failed = true; primary = error;
    await observeFailure('operation', error);
  } finally {
    const cleanupErrors = [];
    const attempt = async (phase, operation) => {
      try { await operation(); return true; }
      catch (error) { cleanupErrors.push(error); await observeFailure(phase, error); return false; }
    };
    for (const [phase, close] of [
      ['playlists.close', () => playlists.close()], ['library.close', () => library.close()],
      ['itemCreation.close', () => itemCreation.close()], ['linkedChildren.flushReleases', () => linkedChildren.flushReleases()],
      ['linkedChildren.close', () => linkedChildren.close()], ['store.close', () => store.close()],
    ]) await attempt(phase, close);
    const client = new pg.Client({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES });
    if (await attempt('cleanup.connect', () => client.connect())) {
      for (const name of [database.schemaName, database.controlSchema]) {
        await attempt(`cleanup.drop.${name}`, () => client.query(`DROP SCHEMA ${quoteIdentifier(name)} CASCADE`));
      }
    }
    await attempt('cleanup.end', () => client.end());
    await attempt('cleanup.directory', () => rm(directory, { recursive: true, force: true }));
    if (cleanupErrors.length) {
      const errors = failed ? [primary, ...cleanupErrors] : cleanupErrors;
      throw new AggregateError(errors, errors[0]?.message ?? 'Playlist bounds cleanup failed.', { cause: errors[0] });
    }
    if (failed) throw primary;
  }
});
