import test from 'node:test';
import assert from 'node:assert/strict';
import { tableDefinition } from '../../src/database/model.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';

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
      for (let index = 0; index < 8; index++) {
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
      const countedUpdate = async candidates => {
        let queryCount = 0;
        const withConnection = database.withConnection;
        database.withConnection = function countQueries(operation, options) {
          return withConnection.call(this, async session => {
            const query = session.client.query;
            session.client.query = async function countedQuery(...args) {
              queryCount += 1;
              return query.apply(this, args);
            };
            try { return await operation(session); }
            finally { session.client.query = query; }
          }, options);
        };
        try {
          const result = await library.getLibraryUpdateInfo({ itemsAdded: candidates }, { user: restrictedUser });
          return { queryCount, result };
        } finally { database.withConnection = withConnection; }
      };
      const singleAccess = await countedUpdate(accessItems.slice(0, 2));
      const batchAccess = await countedUpdate(accessItems);
      assert.equal(batchAccess.result.ItemsAdded.length, accessItems.length);
      assert.ok(singleAccess.queryCount > 0, 'the batch bound must observe actual PostgreSQL statements');
      assert.equal(batchAccess.queryCount, singleAccess.queryCount,
        'LibraryChanged Playlist/BoxSet visibility must use a batch-bounded SQL statement count');
    }
  });
