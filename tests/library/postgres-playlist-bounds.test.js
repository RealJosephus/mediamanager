import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import { quoteIdentifier } from '../../src/database/model.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { LibraryService } from '../../src/library/library-service.js';
import { PlaylistService } from '../../src/library/playlist-service.js';
import { queryPostgresDeletedUserPlaylistBatch,
  queryPostgresPlaylistPage } from '../../src/library/postgres-playlist-query.js';
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

function planNodes(node, collected = []) {
  if (!node || typeof node !== 'object') return collected;
  if (typeof node['Node Type'] === 'string') collected.push(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const entry of value) planNodes(entry, collected);
    else if (value && typeof value === 'object') planNodes(value, collected);
  }
  return collected;
}

test('playlist folder queries apply private access before counting and paging', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const database = await createPostgresTestDatabase(t, 'playlist_gate');
  const directory = await mkdtemp(path.join(tmpdir(), 'mm-playlist-query-access-'));
  const programDataPath = path.join(directory, 'program'), spoolRoot = path.join(directory, 'metadata-spool');
  const linkedChildren = await createStateRelations(database, spoolRoot);
  let library;
  t.after(async () => {
    try { await closeStateDeletion({ library, linkedChildren }); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  library = new LibraryService({fileSystem: testFileSystem,  store: new DomainStore(database), linkedChildren, spoolRoot, serverId: 'playlist-gate', programDataPath });
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
  await database.update('BaseItems', { Id: privateId }, { Path: '%appdatapath%\\playlists\\A private' });
  const virtualPathPage = await library.queryItems(query, { user: reader });
  assert.deepEqual(virtualPathPage.Items.map(item => item.Id), [idKey(publicId)]);
  assert.equal(virtualPathPage.TotalRecordCount, 1);
});

test('postgres playlist operations never use unbounded BaseItems or LinkedChildren adapter reads', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async () => {
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
  try {
    await initializeLibraryRoot({fileSystem: testFileSystem,  store, programDataPath, dataPath, configuration: {} });
    await database.insert('BaseItems', mediaRow(id(1), 'First', path.join(directory, 'first.mkv')));
    await database.insert('BaseItems', { ...mediaRow(id(2), 'Second', path.join(directory, 'second.mkv')), Tags: 'hidden' });

    const originalRows = database.rows.bind(database);
    let guardedReads = 0;
    let largestBaseItemBatch = 0;
    const largeMemberIds = new Set();
    const hydratedLargeMemberIds = new Set();
    database.rows = async (table, options) => {
      if (['BaseItems', 'LinkedChildren'].includes(table)) {
        guardedReads++;
        const bounded = options && (options.where || options.whereIn);
        if (!bounded) throw new Error(`unbounded ${table} read`);
      }
      if (table === 'BaseItems' && options?.whereIn?.Id) {
        largestBaseItemBatch = Math.max(largestBaseItemBatch, options.whereIn.Id.length);
        for (const value of options.whereIn.Id) if (largeMemberIds.has(idKey(value))) {
          hydratedLargeMemberIds.add(idKey(value));
        }
      }
      return originalRows(table, options);
    };

    const owner = account(90);
    const editor = account(91);
    let creationLinkInserts = 0;
    let creationAncestorInserts = 0;
    database.queryHook = async (...args) => {
      const result = await database.client.query(...args);
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
      if (/INSERT INTO [^\n]+\."LinkedChildren"/u.test(text)) creationLinkInserts++;
      if (/INSERT INTO [^\n]+\."AncestorIds"/u.test(text)) creationAncestorInserts++;
      return result;
    };
    const created = await playlists.create({ name: 'Bounded', user: owner, ids: [id(1), id(2)], isPublic: false,
      users: [{ UserId: editor.Id, CanEdit: true }] });
    database.queryHook = null;
    assert.equal(creationLinkInserts, 1, 'playlist creation must insert every member in one statement');
    assert.equal(creationAncestorInserts, 1, 'playlist creation must insert every ancestor in one statement');
    assert.equal((await playlists.get(created.Id, { user: owner })).ItemIds.length, 2);
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
    let accessBatchQueries = 0;
    database.queryHook = async (...args) => {
      const result = await database.client.query(...args);
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
      if (text.includes('WITH RECURSIVE requested("PlaylistKey")')) accessBatchQueries++;
      return result;
    };
    const searchResult = await library.queryItems({
      SearchTerm: 'Search batch', IncludeItemTypes: 'Playlist', Limit: '10',
      EnableImages: 'false', EnableUserData: 'false',
    }, { user: { ...owner, MaxParentalRatingScore: 5, Configuration: {} } });
    database.queryHook = null;
    assert.deepEqual(searchResult.Items.map(item => item.Name),
      ['Search batch alpha', 'Search batch beta', 'Search batch gamma']);
    assert.equal(accessBatchQueries, 1,
      'one PostgreSQL access query must serve every playlist on the search page');
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
    const countedCleanup = async () => {
      let queryCount = 0;
      let accessBatchQueries = 0;
      const withConnection = database.withConnection;
      database.withConnection = function countQueries(operation, options) {
        return withConnection.call(this, async session => {
          const query = session.client.query;
          session.client.query = async function countedQuery(...args) {
            queryCount += 1;
            const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
            if (text.includes('WITH RECURSIVE requested("PlaylistKey")')) accessBatchQueries += 1;
            return query.apply(this, args);
          };
          try { return await operation(session); }
          finally { session.client.query = query; }
        }, options);
      };
      try {
        await playlists.removeForDeletedUser(cleanupUser);
        return { queryCount, accessBatchQueries };
      } finally { database.withConnection = withConnection; }
    };
    const singleCleanup = await countedCleanup();
    for (let index = 1; index < cleanupIds.length; index++) {
      await database.update('BaseItems', { Id: cleanupIds[index] }, { Data: cleanupData(true) });
    }
    const batchCleanup = await countedCleanup();
    assert.equal(singleCleanup.accessBatchQueries, 1);
    assert.equal(batchCleanup.accessBatchQueries, 1,
      'one PostgreSQL access query must serve the whole deleted-user playlist batch');
    assert.equal(batchCleanup.queryCount, singleCleanup.queryCount,
      'deleted-user playlist visibility must use a batch-bounded SQL statement count');

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

    let capturedPlaylistQuery;
    const originalQuery = database.client.query;
    database.client.query = async query => {
      const text = typeof query === 'string' ? query : query?.text;
      if (text?.includes('WITH RECURSIVE selected AS')) {
        capturedPlaylistQuery = { text, values: query.values };
      }
      return originalQuery(query);
    };
    try {
      await queryPostgresPlaylistPage(database, deep.Id, {
        visibility: {
          userId: owner.Id,
          allTopParentIds: [],
          allowedTopParentIds: [],
          collectionBlockedTopParentIds: [],
          collectionAllowedTopParentIds: [],
          blockedTags: ['deep hidden'],
          allowedTags: [],
          maxRating: null,
          maxSubRating: null,
          blockUnratedTypes: [],
        },
        limit: 1,
      });
    } finally {
      database.client.query = originalQuery;
    }
    assert.ok(capturedPlaylistQuery, 'playlist page query was captured');
    assert.doesNotMatch(capturedPlaylistQuery.text, /__Depth|<\s*63/);
    assert.match(capturedPlaylistQuery.text,
      /FROM ancestry\s+JOIN [^\n]+"BaseItems" parent ON [^\n]+mm_native_guid_lower[^\n]+parent\."Id"[^\n]+mm_native_guid_lower[^\n]+ancestry\."ParentId"/);
    const explanation = await database.withConnection(async session => {
      await session.client.query('SET enable_seqscan TO off');
      try {
        return session.client.query({
          text: `EXPLAIN (FORMAT JSON) ${capturedPlaylistQuery.text}`,
          values: capturedPlaylistQuery.values,
        });
      } finally {
        await session.client.query('RESET enable_seqscan');
      }
    });
    const nodes = planNodes(explanation.rows[0]['QUERY PLAN'][0].Plan);
    const indexNames = new Set(nodes.map(node => node['Index Name']).filter(Boolean));
    assert.ok(indexNames.has('mm_runtime_linked_children_parent_child_lower_idx'),
      `playlist seed did not use its parent index: ${[...indexNames].join(', ')}`);
    assert.ok(indexNames.has('mm_runtime_baseitems_id_lower_idx'),
      `ancestor lookup did not use its id index: ${[...indexNames].join(', ')}`);
    assert.equal(nodes.some(node => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'BaseItems'), false,
      'playlist ancestry must not scan the BaseItems catalogue');
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
      for (let index = 100; index < 228; index++) {
        const childId = id(index);
        largeMemberIds.add(idKey(childId));
        await db.insert('BaseItems', mediaRow(childId, `Large ${index}`, path.join(directory, `large-${index}.mkv`)));
        await db.insert('LinkedChildren', { ParentId: largeId, SortOrder: index - 100, ChildId: childId, ChildType: 0 });
      }
    });
    largestBaseItemBatch = 0;
    hydratedLargeMemberIds.clear();
    const largePage = await playlists.getItems(large.Id, { user: owner, startIndex: 60, limit: 3,
      dtoOptions: { EnableImages: false, EnableUserData: false } });
    assert.equal(largePage.TotalRecordCount, 128);
    assert.equal(largePage.Items.length, 3);
    assert.ok(largestBaseItemBatch <= 24, `largest BaseItems hydration batch was ${largestBaseItemBatch}`);
    assert.equal(hydratedLargeMemberIds.size, 3);
    largestBaseItemBatch = 0;
    hydratedLargeMemberIds.clear();
    const genericPage = await library.queryItems({ ParentId: large.Id, StartIndex: 60, Limit: 3,
      EnableImages: false, EnableUserData: false }, { user: owner });
    assert.equal(genericPage.TotalRecordCount, 128);
    assert.equal(genericPage.Items.length, 3);
    assert.ok(largestBaseItemBatch <= 24, `generic playlist page hydrated a batch of ${largestBaseItemBatch}`);
    assert.equal(hydratedLargeMemberIds.size, 3);
    await playlists.add(created.Id, [id(1)], { user: editor, position: 1 });
    await playlists.move(created.Id, id(2).replaceAll('-', '').toLowerCase(), 0, { user: editor });
    await playlists.remove(created.Id, [id(1).replaceAll('-', '').toLowerCase()], { user: editor });
    await playlists.update(created.Id, { user: owner, ids: [id(2), id(1)] });
    await playlists.updateUser(created.Id, editor.Id, { user: owner, canEdit: false });
    await playlists.removeUser(created.Id, editor.Id, { user: owner });
    await playlists.update(created.Id, { user: owner, isPublic: true });
    await playlists.delete(unicodeTags.Id, { user: owner });
    await playlists.create({ name: 'Deleted owner', user: owner, isPublic: false });
    await playlists.removeForDeletedUser(owner);
    let largeDeleteLinkStatements = 0;
    database.queryHook = async (...args) => {
      const result = await database.client.query(...args);
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
      if (/DELETE FROM [^\n]+\."LinkedChildren"/u.test(text)) largeDeleteLinkStatements++;
      return result;
    };
    await playlists.delete(large.Id, { user: owner });
    database.queryHook = null;
    assert.equal(largeDeleteLinkStatements, 1,
      'playlist deletion must remove every incoming and outgoing link in one statement');
    await playlists.delete(created.Id, { user: owner });
    assert.ok(guardedReads > 0);
  } finally {
    try { await closeStateDeletion({ playlists, itemCreation, library, linkedChildren }); }
    finally {
      try { await store.close(); }
      finally {
        const client = new pg.Client({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES });
        try {
          await client.connect();
          for (const name of [database.schemaName, database.controlSchema]) {
            await client.query(`DROP SCHEMA ${quoteIdentifier(name)} CASCADE`);
          }
        } finally {
          try { await client.end(); }
          finally { await rm(directory, { recursive: true, force: true }); }
        }
      }
    }
  }
});
