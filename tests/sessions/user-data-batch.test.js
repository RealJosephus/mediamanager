import { testFileSystem } from '../storage/plugin-files.js';
import { attachLibraryNavigation, closeLibraryNavigation } from '../library/navigation-fixture.js';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decodeNativeTextBytes } from '../../src/database/native-text.js';
import { openMetadataRelations, closeMetadataFixture, removeMetadataTestRoot } from '../metadata/relations-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition, quoteIdentifier } from '../../src/database/model.js';
import { LibraryService } from '../../src/library/library-service.js';
import { UserDataService, guidN } from '../../src/sessions/user-data.js';
import { fixtureRow } from '../database/fixtures.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import { releaseNativeItemLinks } from '../../src/library/native-item-entity.js';

const USER = '51000000-0000-0000-0000-000000000001';
const itemId = index => `52000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`;
const PARENT = '53000000-0000-0000-0000-000000000001';
const CHILD = '53000000-0000-0000-0000-000000000002';
const LATE_OWNER = '53000000-0000-0000-0000-000000000003';
const LINK_TARGET = '53000000-0000-0000-0000-000000000004';
const LINK_SIBLING = '53000000-0000-0000-0000-000000000005';
const LINK_TARGET_CHILD = '53000000-0000-0000-0000-000000000006';
const LINK_SIBLING_CHILD = '53000000-0000-0000-0000-000000000007';

function movie(Id, index) {
  return {
    ...fixtureRow(tableDefinition('BaseItems')),
    Id,
    Type: 'MediaBrowser.Controller.Entities.Movies.Movie',
    Name: `Movie ${index}`,
    CleanName: `movie ${index}`,
    SortName: `movie ${index}`,
    ForcedSortName: null,
    Data: '{}',
    MediaType: 'Video',
    Path: `Z:\\Batch\\movie-${index}.mkv`,
    ParentId: null,
    OwnerId: null,
    ChannelId: null,
    ExternalId: null,
    TopParentId: null,
    PrimaryVersionId: null,
    ExtraType: null,
    IsFolder: false,
    RunTimeTicks: 100000000000n,
  };
}

function folder(Id, Name) {
  return { ...movie(Id, Name), Type: 'MediaBrowser.Controller.Entities.Folder', Name, CleanName: Name.toLowerCase(),
    SortName: Name.toLowerCase(), MediaType: 'Unknown', Path: `Z:\\Batch\\${Name}`, IsFolder: true, RunTimeTicks: 0n };
}

test('getMany projects large user-data batches with fixed-size relationship reads', async t => {
  const database = await createPostgresTestDatabase(t, 'user_data_batch');
  const store = new DomainStore(database);
  const itemCount = 120;
  const userRow = {
    ...fixtureRow(tableDefinition('Users')),
    Id: USER,
    InternalId: 1n,
    Username: 'BatchUser',
    NormalizedUsername: 'BATCHUSER',
  };
  const user = {
    ...userRow,
    Policy: {},
    Configuration: {},
  };
  let userLookups = 0;
  const users = { async getUser(id) { userLookups++; return guidN(id) === guidN(USER) ? user : null; } };

  let library, linkedChildren, spoolRoot;
  try {
    spoolRoot = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-user-data-batch-'));
    linkedChildren = await openMetadataRelations(database, spoolRoot);
    await database.insert('Users', userRow);
    for (let index = 0; index < itemCount; index++) await database.insert('BaseItems', movie(itemId(index), index));
    await database.insert('BaseItems', folder(PARENT, 'Parent'));
    await database.insert('BaseItems', { ...movie(CHILD, 'Child'), ParentId: PARENT, OwnerId: null });
    for (const index of [0, itemCount - 1]) await database.insert('UserData', {
      ...fixtureRow(tableDefinition('UserData')),
      ItemId: itemId(index),
      UserId: USER,
      CustomDataKey: itemId(index).toLowerCase(),
      AudioStreamIndex: null,
      SubtitleStreamIndex: null,
      IsFavorite: index === 0,
      LastPlayedDate: null,
      Likes: null,
      PlaybackPositionTicks: BigInt(index),
      PlayCount: index,
      Played: false,
      Rating: null,
      RetentionDate: null,
    });

    const reads = [], relationReads = [], hydratedBatches = [];
    const baseItemsTableId = Number((await database.client.query({
      text: 'SELECT $1::regclass::oid AS "oid"',
      values: [`${quoteIdentifier(database.schemaName)}."BaseItems"`],
    })).rows[0].oid);
    const rows = database.rows.bind(database);
    database.rows = (name, options) => {
      if (name !== 'BaseItems') reads.push(name);
      return rows(name, options);
    };
    const query = database.client.query.bind(database.client);
    database.client.query = async (...args) => {
      const statement = typeof args[0] === 'string' ? args[0] : args[0].text;
      const relation = /\bFROM\s+(?:"[^"]+"\.)?"(BaseItemImageInfos|BaseItemTrailerTypes)"/u.exec(statement)?.[1];
      if (relation) {
        reads.push(relation);
        relationReads.push({ name: relation, values: (typeof args[0] === 'string' ? args[1] : args[0].values).map(value => value.map(bytes => decodeNativeTextBytes(bytes))) });
      }
      const result = await query(...args);
      const fields = result.command === 'SELECT'
        ? result.fields.filter(field => field.tableID === baseItemsTableId) : [];
      const idField = fields.find(field => field.name === 'Id');
      if (idField && fields.some(field => field.name === 'Data')) {
        hydratedBatches.push(result.rows.map(row => decodeNativeTextBytes(row[idField.name])));
      }
      return result;
    };
    library = new LibraryService({fileSystem: testFileSystem,  store, linkedChildren, serverId: 'user-data-batch-test' });
    await attachLibraryNavigation(library);
    const userData = new UserDataService({ store, library, users });
    const itemIds = Array.from({ length: itemCount }, (_, index) => itemId(index));
    const result = await userData.getMany(USER, itemIds.map(id => ({ id })));

    assert.equal(userLookups, 1, 'the user is resolved once for the complete notification batch');
    assert.equal(result.length, itemCount);
    assert.equal(result[0].ItemId, guidN(itemId(0)));
    assert.equal(result[0].IsFavorite, true);
    assert.equal(result.at(-1).ItemId, guidN(itemId(itemCount - 1)));
    assert.equal(result.at(-1).PlayCount, itemCount - 1);
    assert.deepEqual(result.map(item => item.ItemId), itemIds.map(guidN));
    assert.ok(hydratedBatches.length > 0, 'The requested items cross the actual PostgreSQL full-row boundary.');
    for (const batch of hydratedBatches) assert.deepEqual(batch.toSorted(), itemIds.toSorted(),
      'every discovery and hydration read contains only the complete requested batch');
    assert.deepEqual(relationReads.map(read => read.name).toSorted(), ['BaseItemImageInfos', 'BaseItemTrailerTypes']);
    for (const read of relationReads) {
      assert.deepEqual(read.values, [itemIds], 'each ordered relation uses one query scoped to the complete requested batch');
    }
    assert.deepEqual(reads.toSorted(), [
      'AncestorIds',
      'BaseItemImageInfos',
      'BaseItemMetadataFields',
      'BaseItemProviders',
      'BaseItemTrailerTypes',
      'ItemValuesMap',
      'LinkedChildren',
      'LinkedChildren',
      'PeopleBaseItemMap',
      'UserData',
    ]);
    assert.equal(reads.filter(name => name === 'UserData').length, 1,
      'projecting each item must reuse the user-data rows loaded for the batch');

    const fullBatchHydrations = hydratedBatches.splice(0);
    const pairIds = [itemId(0), itemId(itemCount - 1)];
    const pairData = await userData.getMany(USER, pairIds.map(id => ({ id })));
    assert.deepEqual(pairData, [result[0], result.at(-1)]);
    assert.equal(hydratedBatches.length, fullBatchHydrations.length,
      'sixty times as many notification items must not add per-item full-row reads');
    for (const batch of hydratedBatches) assert.deepEqual(batch.toSorted(), pairIds.toSorted(),
      'the small notification batch excludes unrelated full rows');

    reads.length = 0;
    const parentRecord = await library.getItemRecord(PARENT);
    try {
      assert.equal(reads.filter(name => name === 'UserData').length, 1,
        'ordinary userless library loads reuse one complete relationship snapshot');
    } finally { releaseNativeItemLinks(parentRecord); }
    const beforeRejected = { items: await rows('BaseItems'), userData: await rows('UserData') };
    reads.length = 0;
    await assert.rejects(library.queryItems({ ParentId: PARENT, Recursive: false, SortBy: ['DatePlayed'] }), {
      status: 400,
      message: "Sort key 'DatePlayed' requires a user, but none was provided.",
    });
    assert.deepEqual({ items: await rows('BaseItems'), userData: await rows('UserData') }, beforeRejected,
      'a rejected userless DatePlayed query preserves the complete persisted state');
    reads.length = 0;
    const pair = await library.queryItems({ Ids: [itemId(0), itemId(itemCount - 1)], SortBy: ['DatePlayed'] });
    assert.deepEqual(pair.Items.map(item => guidN(item.Id)).sort(), [guidN(itemId(0)), guidN(itemId(itemCount - 1))].sort());
    const pairReads = reads.filter(name => name === 'UserData').length;
    reads.length = 0;
    const batch = await library.queryItems({ Ids: itemIds, SortBy: ['DatePlayed'] });
    assert.deepEqual(batch.Items.map(item => guidN(item.Id)).sort(), itemIds.map(guidN).sort());
    assert.ok(pairReads > 0);
    assert.equal(reads.filter(name => name === 'UserData').length, pairReads,
      'sixty times as many DatePlayed items must not add per-item user-data reads');

    let firstEvent;
    userData.once('UserDataSaved', event => { firstEvent = event; });
    await userData.setFavorite(USER, CHILD, true);
    assert.deepEqual(firstEvent.ChangeReferences.map(reference => guidN(reference.id)), [guidN(CHILD), guidN(PARENT)],
      'the parent is selected when the event is raised without an owner');
    await database.insert('BaseItems', folder(LATE_OWNER, 'Late owner'));
    await database.update('BaseItems', { Id: CHILD }, { OwnerId: LATE_OWNER });
    assert.deepEqual(firstEvent.ChangeReferences.map(reference => guidN(reference.id)), [guidN(CHILD), guidN(PARENT)],
      'a later owner cannot replace the captured event-time parent');
    assert.deepEqual((await userData.getMany(USER, firstEvent.ChangeReferences)).map(dto => dto.ItemId), [guidN(CHILD), guidN(PARENT)]);

    let secondEvent;
    userData.once('UserDataSaved', event => { secondEvent = event; });
    await userData.setFavorite(USER, CHILD, false);
    assert.deepEqual(secondEvent.ChangeReferences.map(reference => guidN(reference.id)), [guidN(CHILD), guidN(LATE_OWNER)]);
    await database.update('BaseItems', { Id: CHILD }, { OwnerId: null });
    await database.delete('BaseItems', { Id: LATE_OWNER });
    await database.delete('BaseItems', { Id: CHILD });
    assert.deepEqual((await userData.getMany(USER, secondEvent.ChangeReferences)).map(dto => dto.ItemId), [guidN(CHILD), guidN(LATE_OWNER)],
      'deleted items still project from the objects captured when the event was raised');

    await database.insert('BaseItems', { ...folder(LINK_TARGET, 'Linked target'), PresentationUniqueKey: 'shared-linked-folder' });
    await database.insert('BaseItems', { ...folder(LINK_SIBLING, 'Linked sibling'), PresentationUniqueKey: 'shared-linked-folder' });
    await database.insert('BaseItems', { ...movie(LINK_TARGET_CHILD, 'Linked target child'), ParentId: LINK_TARGET, TopParentId: LINK_TARGET, IsVirtualItem: false });
    await database.insert('BaseItems', { ...movie(LINK_SIBLING_CHILD, 'Linked sibling child'), ParentId: LINK_SIBLING, TopParentId: LINK_SIBLING, IsVirtualItem: false });
    await database.insert('LinkedChildren', { ...fixtureRow(tableDefinition('LinkedChildren')),
      ParentId: LINK_TARGET, ChildId: LINK_TARGET_CHILD, ChildType: 0, SortOrder: 0 });
    await database.insert('UserData', { ...fixtureRow(tableDefinition('UserData')),
      ItemId: LINK_TARGET_CHILD, UserId: USER, CustomDataKey: LINK_TARGET_CHILD.toLowerCase(),
      AudioStreamIndex: null, SubtitleStreamIndex: null, IsFavorite: false, LastPlayedDate: null,
      Likes: null, PlaybackPositionTicks: 0n, PlayCount: 1, Played: true, Rating: null, RetentionDate: null });
    const [linkedFolder] = await userData.getMany(USER, [{ id: LINK_TARGET }]);
    assert.equal(linkedFolder.Played, true);
    assert.equal(linkedFolder.UnplayedItemCount, 0);
    assert.equal(linkedFolder.PlayedPercentage, 100,
      'a linked folder does not merge user data from presentation-key siblings');
  } finally {
    await closeMetadataFixture({ before: [() => closeLibraryNavigation(library)], library, linkedChildren, after: [() => store.close(),
      () => spoolRoot && removeMetadataTestRoot(spoolRoot, 'mediamanager-user-data-batch-')] });
  }
});
