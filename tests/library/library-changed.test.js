import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tableDefinition } from '../../src/database/model.js';
import { mapRecord } from '../../src/library/records.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const ids = Object.fromEntries([
  'root', 'firstCollection', 'firstFolder', 'secondCollection', 'secondFolder', 'hiddenCollection', 'hiddenFolder',
  'rootChild', 'visibleAdded', 'hiddenAdded', 'visibleUpdated', 'hiddenUpdated', 'hiddenRemoved', 'aggregate', 'user'
].map((name, index) => [name, `C2222222-2222-2222-2222-${String(index + 1).padStart(12, '0')}`]));

const dtoId = value => value.replaceAll('-', '').toLowerCase();

function emptyRow(table) {
  return Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => {
    const type = column.clrType.replace('?', '');
    const value = type === 'DateTime' ? '2026-09-27 00:00:00'
      : column.nullable ? null
        : type === 'bool' ? false
          : column.type === 'TEXT' ? ''
            : type === 'long' || type === 'uint' ? 0n : 0;
    return [column.name, value];
  }));
}

function item(Id, Type, values = {}) {
  const folder = ['AggregateFolder', 'BoxSet', 'CollectionFolder', 'Folder', 'Playlist', 'UserRootFolder'].includes(Type);
  const nativeType = Type === 'Movie' ? 'MediaBrowser.Controller.Entities.Movies.Movie'
    : Type === 'BoxSet' ? 'MediaBrowser.Controller.Entities.Movies.BoxSet'
      : Type === 'Playlist' ? 'MediaBrowser.Controller.Playlists.Playlist'
        : `MediaBrowser.Controller.Entities.${Type}`;
  return {
    ...emptyRow('BaseItems'),
    Id,
    Type: nativeType,
    Name: Type,
    CleanName: Type.toLowerCase(),
    SortName: Type.toLowerCase(),
    PresentationUniqueKey: Id,
    IsFolder: folder,
    MediaType: Type === 'Movie' ? 'Video' : 'Unknown',
    Data: '{}',
    ...values
  };
}

async function seed(database) {
  await database.insert('Users', {
    ...emptyRow('Users'), Id: ids.user, Username: 'Restricted', NormalizedUsername: 'RESTRICTED', InternalId: 1
  });
  await database.insert('BaseItems', item(ids.root, 'UserRootFolder'));
  await database.insert('BaseItems', item(ids.firstCollection, 'CollectionFolder', {
    ParentId: ids.root, Data: JSON.stringify({ PhysicalFolderIds: [ids.firstFolder], PhysicalLocationsList: ['Z:\\First'] })
  }));
  await database.insert('BaseItems', item(ids.firstFolder, 'Folder', {
    Path: 'Z:\\First', TopParentId: ids.firstFolder
  }));
  await database.insert('BaseItems', item(ids.secondCollection, 'CollectionFolder', {
    ParentId: ids.root, Data: JSON.stringify({ PhysicalFolderIds: [ids.secondFolder], PhysicalLocationsList: ['Z:\\Second'] })
  }));
  await database.insert('BaseItems', item(ids.secondFolder, 'Folder', {
    Path: 'Z:\\Second', TopParentId: ids.secondFolder
  }));
  await database.insert('BaseItems', item(ids.hiddenCollection, 'CollectionFolder', {
    ParentId: ids.root, Data: JSON.stringify({ PhysicalFolderIds: [ids.hiddenFolder], PhysicalLocationsList: ['Z:\\Hidden'] })
  }));
  await database.insert('BaseItems', item(ids.hiddenFolder, 'Folder', {
    Path: 'Z:\\Hidden', TopParentId: ids.hiddenFolder
  }));
  await database.insert('BaseItems', item(ids.rootChild, 'Folder', { ParentId: ids.root }));
  for (const [name, parent, path] of [
    ['visibleAdded', ids.firstFolder, 'Z:\\First\\added.mkv'],
    ['hiddenAdded', ids.hiddenFolder, 'Z:\\Hidden\\added.mkv'],
    ['visibleUpdated', ids.firstFolder, 'Z:\\First\\updated.mkv'],
    ['hiddenUpdated', ids.hiddenFolder, 'Z:\\Hidden\\updated.mkv'],
    ['hiddenRemoved', ids.hiddenFolder, 'Z:\\Hidden\\removed.mkv']
  ]) {
    await database.insert('BaseItems', item(ids[name], 'Movie', { ParentId: parent, TopParentId: parent, Path: path }));
  }
  await database.insert('BaseItems', item(ids.aggregate, 'AggregateFolder'));
  await database.insert('UserData', {
    ...emptyRow('UserData'), UserId: ids.user, ItemId: ids.visibleAdded,
    CustomDataKey: dtoId(ids.visibleAdded), IsFavorite: true
  });
}

const restrictedUser = {
  Id: ids.user,
  Username: 'Restricted',
  MaxParentalRatingScore: null,
  MaxParentalRatingSubScore: null,
  Policy: {
    EnableAllFolders: false,
    EnabledFolders: [ids.firstCollection, ids.secondCollection],
    BlockedMediaFolders: [],
    BlockedTags: [],
    AllowedTags: [],
    BlockUnratedItems: []
  },
  Configuration: {}
};

const sortedInfo = info => Object.fromEntries(Object.entries(info).map(([name, values]) => [name, values.toSorted()]));

for (const dialect of ['postgres']) test(`${dialect}: library update projection batches visibility, removals, parents and root folders with bounded SQL`,
  { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const { database, library } = await setupChildrenFixture(t);
    await seed(database);
    library.options.userRoot = (await database.rows('BaseItems', { where: { Id: ids.root }, limit: 1 }))[0];
    const snapshots = {};
    for (const name of ['firstFolder', 'hiddenFolder', 'visibleAdded', 'hiddenAdded', 'visibleUpdated', 'hiddenUpdated', 'hiddenRemoved', 'aggregate']) {
      snapshots[name] = await library.getItemRecord(ids[name]);
    }
    await database.delete('BaseItems', { Id: ids.hiddenRemoved });

    const info = await library.getLibraryUpdateInfo({
      itemsAdded: [snapshots.visibleAdded, snapshots.hiddenAdded, snapshots.visibleAdded],
      itemsUpdated: [snapshots.visibleUpdated, snapshots.hiddenUpdated],
      itemsRemoved: [snapshots.hiddenRemoved],
      foldersAddedTo: [snapshots.firstFolder, snapshots.hiddenFolder],
      foldersRemovedFrom: [snapshots.firstFolder, snapshots.hiddenFolder]
    }, { user: restrictedUser });

    assert.deepEqual(Object.keys(info).toSorted(), [
      'CollectionFolders', 'FoldersAddedTo', 'FoldersRemovedFrom', 'ItemsAdded', 'ItemsRemoved', 'ItemsUpdated'
    ]);
    assert.deepEqual(sortedInfo(info), sortedInfo({
      FoldersAddedTo: [dtoId(ids.firstFolder)],
      FoldersRemovedFrom: [dtoId(ids.firstFolder)],
      ItemsAdded: [dtoId(ids.visibleAdded)],
      ItemsRemoved: [dtoId(ids.hiddenRemoved)],
      ItemsUpdated: [dtoId(ids.visibleUpdated)],
      CollectionFolders: [ids.firstCollection, ids.secondCollection, ids.rootChild].map(dtoId)
    }));

    const hiddenOnly = await library.getLibraryUpdateInfo({
      itemsAdded: [snapshots.hiddenAdded],
      foldersAddedTo: [snapshots.hiddenFolder],
      foldersRemovedFrom: [snapshots.hiddenFolder]
    }, { user: restrictedUser });
    assert.deepEqual(hiddenOnly, {
      FoldersAddedTo: [],
      FoldersRemovedFrom: [],
      ItemsAdded: [],
      ItemsRemoved: [],
      ItemsUpdated: [],
      CollectionFolders: [ids.firstCollection, ids.secondCollection, ids.rootChild].map(dtoId)
    }, 'a hidden parent still invalidates every visible root collection');

    const aggregate = await library.getLibraryUpdateInfo({
      itemsAdded: [snapshots.aggregate],
      itemsUpdated: [snapshots.aggregate],
      itemsRemoved: [snapshots.aggregate],
      foldersAddedTo: [snapshots.aggregate],
      foldersRemovedFrom: [snapshots.aggregate]
    }, { user: restrictedUser });
    const rootId = dtoId(ids.root);
    assert.deepEqual(aggregate, {
      FoldersAddedTo: [rootId],
      FoldersRemovedFrom: [rootId],
      ItemsAdded: [rootId],
      ItemsRemoved: [rootId],
      ItemsUpdated: [rootId],
      CollectionFolders: []
    });

    if (dialect === 'postgres') {
      const accessItems = [];
      for (let index = 0; index < 64; index++) {
        const playlistId = `C3333333-3333-3333-3333-${String(index * 2 + 1).padStart(12, '0')}`;
        const boxSetId = `C3333333-3333-3333-3333-${String(index * 2 + 2).padStart(12, '0')}`;
        await database.insert('BaseItems', item(playlistId, 'Playlist', {
          ParentId: ids.firstFolder, TopParentId: ids.firstFolder,
        }));
        await database.insert('BaseItems', item(boxSetId, 'BoxSet', {
          ParentId: ids.firstFolder, TopParentId: ids.firstFolder,
        }));
        accessItems.push(await library.getItemRecord(playlistId), await library.getItemRecord(boxSetId));
      }
      const countedUpdate = async (candidates, user = restrictedUser) => {
        const statements = [];
        const withConnection = database.withConnection;
        database.withConnection = function countQueries(operation, options) {
          return withConnection.call(this, async session => {
            const query = session.client.query;
            session.client.query = async function countedQuery(...args) {
              const queryInput = args[0];
              statements.push(typeof queryInput === 'string' ? queryInput : queryInput.text);
              return query.apply(this, args);
            };
            try { return await operation(session); }
            finally { session.client.query = query; }
          }, options);
        };
        try {
          const result = await library.getLibraryUpdateInfo({ itemsAdded: candidates }, { user });
          return { queryCount: statements.length, statements, result };
        } finally { database.withConnection = withConnection; }
      };
      const singleAccess = await countedUpdate(accessItems.slice(0, 2));
      const batchAccess = await countedUpdate(accessItems.slice(0, 16));
      const fullPageAccess = await countedUpdate(accessItems);
      const reversedItems = accessItems.toReversed();
      const reversedSingleAccess = await countedUpdate(reversedItems.slice(0, 2));
      const reversedAccess = await countedUpdate(reversedItems);
      const ratingLimited = { ...restrictedUser, MaxParentalRatingScore: 10, MaxParentalRatingSubScore: 0 };
      const ratedSingleAccess = await countedUpdate(accessItems.slice(0, 2), ratingLimited);
      const ratedFourAccess = await countedUpdate(accessItems.slice(0, 4), ratingLimited);
      const ratedEightAccess = await countedUpdate(accessItems.slice(0, 8), ratingLimited);
      const ratedBatchAccess = await countedUpdate(accessItems.slice(0, 16), ratingLimited);
      const ratedFullPageAccess = await countedUpdate(accessItems, ratingLimited);
      const evidence = path.join(validationOutputRoot(), 'library-changed-statements-' + randomUUID());
      await mkdir(evidence);
      await writeFile(path.join(evidence, 'queries.json'), JSON.stringify({ singleAccess, batchAccess, fullPageAccess,
        reversedSingleAccess, reversedAccess, ratedSingleAccess, ratedFourAccess, ratedEightAccess, ratedBatchAccess, ratedFullPageAccess }, null, 2) + '\n');
      t.diagnostic(JSON.stringify({ scope: 'one visibility page with alternating Playlist and BoxSet',
        single: { items: 2, statements: singleAccess.queryCount },
        batch: { items: 16, statements: batchAccess.queryCount },
        fullPage: { items: accessItems.length, statements: fullPageAccess.queryCount },
        reversedSingle: { items: 2, statements: reversedSingleAccess.queryCount },
        reversed: { items: reversedItems.length, statements: reversedAccess.queryCount },
        ratedSingle: { items: 2, statements: ratedSingleAccess.queryCount },
        ratedFour: { items: 4, statements: ratedFourAccess.queryCount },
        ratedEight: { items: 8, statements: ratedEightAccess.queryCount },
        ratedBatch: { items: 16, statements: ratedBatchAccess.queryCount },
        ratedFullPage: { items: accessItems.length, statements: ratedFullPageAccess.queryCount } }));
      assert.deepEqual(singleAccess.result.ItemsAdded, accessItems.slice(0, 2).map(item => dtoId(item.Id)));
      assert.deepEqual(batchAccess.result.ItemsAdded, accessItems.slice(0, 16).map(item => dtoId(item.Id)),
        'batching visibility retains the complete notification identity sequence');
      assert.deepEqual(fullPageAccess.result.ItemsAdded, accessItems.map(item => dtoId(item.Id)));
      assert.deepEqual(reversedSingleAccess.result.ItemsAdded, reversedItems.slice(0, 2).map(item => dtoId(item.Id)));
      assert.deepEqual(reversedAccess.result.ItemsAdded, reversedItems.map(item => dtoId(item.Id)),
        'BoxSet-first and Playlist-first pages retain their original notification order');
      assert.deepEqual(ratedSingleAccess.result.ItemsAdded, accessItems.slice(0, 2).map(item => dtoId(item.Id)));
      assert.deepEqual(ratedFourAccess.result.ItemsAdded, accessItems.slice(0, 4).map(item => dtoId(item.Id)));
      assert.deepEqual(ratedEightAccess.result.ItemsAdded, accessItems.slice(0, 8).map(item => dtoId(item.Id)));
      assert.deepEqual(ratedBatchAccess.result.ItemsAdded, accessItems.slice(0, 16).map(item => dtoId(item.Id)),
        'the empty-playlist parental gate must preserve every eligible notification');
      assert.deepEqual(ratedFullPageAccess.result.ItemsAdded, accessItems.map(item => dtoId(item.Id)));
      assert.ok(singleAccess.queryCount > 0, 'the batch bound must observe actual PostgreSQL statements');
      // Deferred SQL ownership cleanup can finish during a later observation.
      // A 64-fold input increase must stay below twice the small-page SQL cost,
      // including that cleanup, so one extra query per item cannot pass.
      assert.ok(fullPageAccess.queryCount < singleAccess.queryCount * 2,
        'LibraryChanged visibility must remain bounded across a complete 128-item page');
      assert.ok(reversedAccess.queryCount < reversedSingleAccess.queryCount * 2,
        'changing the type interleave must not turn a full visibility page into per-item SQL');
      assert.ok(ratedFullPageAccess.queryCount < ratedSingleAccess.queryCount * 2,
        'Playlist parental member visibility must remain bounded across a complete page');

      const channelUser = { ...restrictedUser, Policy: { ...restrictedUser.Policy, EnableAllChannels: true } };
      const invalidChannel = mapRecord({ ...item('C4444444-4444-4444-4444-000000000001', 'Folder'),
        Type: 'MediaBrowser.Controller.Channels.Channel' });
      const missingSourcePlaylist = mapRecord(item('C4444444-4444-4444-4444-000000000002', 'Playlist', {
        ChannelId: 'C4444444-4444-4444-4444-000000000099',
      }));
      const invalidSharesPlaylist = mapRecord(item('C4444444-4444-4444-4444-000000000003', 'Playlist', {
        Path: path.join(library.options.programDataPath, 'data', 'playlists', 'invalid-shares'),
        Data: JSON.stringify({ OpenAccess: true, Shares: null }),
      }));
      const failureFor = async candidates => {
        try { await library.getLibraryUpdateInfo({ itemsAdded: candidates }, { user: channelUser }); }
        catch (error) { return { status: error.statusCode ?? error.status ?? 500, message: error.message }; }
        assert.fail('invalid visibility input must fail');
      };
      const channelFailure = await failureFor([invalidChannel]);
      assert.equal(channelFailure.status, 400);
      for (const later of [missingSourcePlaylist, invalidSharesPlaylist]) {
        const laterFailure = await failureFor([later]);
        assert.equal(laterFailure.status, 500);
        assert.deepEqual(await failureFor([accessItems[0], invalidChannel, later]), channelFailure,
          'prefetching a later Playlist cannot replace the earlier public failure');
        assert.deepEqual(await failureFor([accessItems[0], later, invalidChannel]), laterFailure,
          'consuming a deferred Playlist failure retains its original input position');
      }
    }
  });
