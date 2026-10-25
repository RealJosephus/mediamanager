import { nativeTextBytes, nativeTextOrdinalIgnoreCaseKey } from '../../src/database/native-text.js';
import { nativeTextSql } from '../../src/database/native-text-sql.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { tableDefinition } from '../../src/database/model.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { fixtureRow } from '../database/fixtures.js';
import {
  loadPostgresItemVersionRelations,
  loadPostgresUserDataKeyItems,
  loadPostgresUserDataRows,
  upsertPostgresUserDataRows,
} from '../../src/sessions/postgres-user-data-mutation.js';
import { itemVersions, postgresUserDataKeyMap } from '../../src/sessions/user-data.js';

const itemId = '8a000000-0000-0000-0000-000000000001';
const alternateId = '8a000000-0000-0000-0000-000000000002';
const userId = '8a000000-0000-0000-0000-000000000003';

function userData(overrides = {}) {
  return {
    ItemId: itemId,
    UserId: userId,
    CustomDataKey: itemId,
    AudioStreamIndex: null,
    IsFavorite: false,
    LastPlayedDate: null,
    Likes: null,
    PlayCount: 0,
    PlaybackPositionTicks: 0n,
    Played: false,
    Rating: null,
    RetentionDate: null,
    SubtitleStreamIndex: null,
    ...overrides,
  };
}

test('PostgreSQL version aggregation is one bounded relational query', async () => {
  const calls = [];
  const database = {
    dialect: 'postgres',
    schemaName: 'version_fixture',
    client: { async query(text, values) { calls.push({ text, values }); return { rows: [] }; } },
  };
  assert.deepEqual(await loadPostgresItemVersionRelations(database, itemId, alternateId,
    ['Movie', 'Episode']), []);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, [[nativeTextBytes(itemId)], [nativeTextBytes(alternateId)], ['Movie', 'Episode']]);
  assert.match(calls[0].text, /primary_item/u);
  assert.match(calls[0].text, /remote_links/u);
  assert.match(calls[0].text, /local_links/u);
  assert.match(calls[0].text, /grouped_ordered/u);
  assert.match(calls[0].text, /"DuplicateOrder" = 1/u);
  assert.match(calls[0].text, /array_agg/u);
  assert.match(calls[0].text, /"ChildType" = 3/u);
  assert.match(calls[0].text, /"ChildType" = 2/u);
  assert.doesNotMatch(calls[0].text, /SELECT \*/u);
});

function rawItem(Id, SortName, kind, versionOrder, overrides = {}) {
  const row = Object.fromEntries(tableDefinition('BaseItems').columns.map(column => {
    const type = column.clrType.replace('?', '');
    return [column.name, column.nullable ? null : type === 'bool' ? false
      : column.type === 'TEXT' ? '' : ['long', 'uint'].includes(type) ? '0' : 0];
  }));
  const value = { ...row, Id, Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Data: '{}',
    Name: SortName, SortName, __RootKey: itemId.replaceAll('-', '').toLowerCase(),
    __Kind: kind, __VersionOrder: String(versionOrder), __ProviderIds: {}, ...overrides };
  for (const column of tableDefinition('BaseItems').columns) if (column.type === 'TEXT' && value[column.name] != null) value[column.name] = nativeTextBytes(value[column.name]);
  value.__ProviderIds = Object.entries(value.__ProviderIds).map(pair => pair.map(nativeTextBytes));
  return value;
}

test('itemVersions consumes PostgreSQL final order without regrouping or locale sorting in Node', async () => {
  const remoteZulu = '8a000000-0000-0000-0000-000000000010';
  const remoteAlpha = '8a000000-0000-0000-0000-000000000011';
  const local = '8a000000-0000-0000-0000-000000000012';
  const root = { Id: itemId, Type: 'Movie', SortName: 'root', PrimaryVersionId: alternateId,
    ProviderIds: {} };
  const database = {
    dialect: 'postgres',
    schemaName: 'version_fixture',
    client: { async query() { return { rows: [
      rawItem(itemId, 'root', 'root', 1),
      rawItem(remoteAlpha, 'alpha', 'remote', 2),
      rawItem(remoteZulu, 'zulu', 'remote', 3),
      rawItem(alternateId, 'primary', 'primary', 4),
      rawItem(local, 'local', 'local', 5),
    ] }; } },
  };
  const versions = await itemVersions(database, root);
  assert.equal(versions[0], root);
  assert.deepEqual(versions.map(version => version.Id), [itemId, remoteAlpha, remoteZulu, alternateId, local]);
});

test('PostgreSQL UserData reads and writes remain one statement for arbitrary item and key counts', async () => {
  const calls = [];
  const database = {
    dialect: 'postgres',
    schemaName: 'userdata_fixture',
    client: {
      async query(text, values) {
        calls.push({ text, values });
        return { rows: [], rowCount: 0 };
      },
    },
  };
  await loadPostgresUserDataRows(database, userId, [itemId, alternateId]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /data\."ItemId"[^\n]+ANY\(\$1::text\[\]\)/u);
  assert.match(calls[0].text, /data\."UserId"[^\n]+ = \$2/u);
  assert.deepEqual(calls[0].values, [[itemId.replaceAll('-', ''), alternateId.replaceAll('-', '')],
    userId.replaceAll('-', '')]);

  await upsertPostgresUserDataRows(database, [
    userData(),
    userData({ ItemId: alternateId, CustomDataKey: 'imdb-key', Played: true,
      PlaybackPositionTicks: 9007199254740993n }),
    userData({ PlayCount: 7, Played: true }),
  ]);
  assert.equal(calls.length, 2);
  const write = calls[1];
  assert.match(write.text, /FROM unnest\(/u);
  assert.match(write.text, /ON CONFLICT \("ItemId", "UserId", "CustomDataKey"\) DO UPDATE/u);
  assert.equal(write.values.length, tableDefinition('UserData').columns.length);
  assert.deepEqual(write.values[0], [nativeTextBytes(itemId), nativeTextBytes(alternateId)]);
  assert.deepEqual(write.values[7], ['7', '0']);
  assert.deepEqual(write.values[8], ['0', '9007199254740993']);
});

test('PostgreSQL UserData batch upsert applies last-row-wins for duplicate native keys', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async () => {
  const schema = `userdata_duplicate_${process.pid}_${Date.now().toString(36)}`;
  const database = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
    schema,
    create: true,
  });
  try {
    const item = fixtureRow(tableDefinition('BaseItems'));
    const user = fixtureRow(tableDefinition('Users'));
    await database.insert('BaseItems', item);
    await database.insert('Users', user);
    const key = 'shared-provider-key';
    await upsertPostgresUserDataRows(database, [
      userData({ ItemId: item.Id, UserId: user.Id, CustomDataKey: key, PlayCount: 1 }),
      userData({ ItemId: item.Id, UserId: user.Id, CustomDataKey: key, PlayCount: 2, Played: true }),
    ]);
    const rows = await database.rows('UserData', {
      where: { ItemId: item.Id, UserId: user.Id, CustomDataKey: key },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].PlayCount, 2);
    assert.equal(rows[0].Played, true);
  } finally {
    try { await database.dropSchemasCreatedByThisOpen(); }
    finally { await database.close(); }
  }
});

test('PostgreSQL user-data key contexts load providers and parent/series closure once', async () => {
  const seriesId = '8a000000-0000-0000-0000-000000000020';
  const episodeId = '8a000000-0000-0000-0000-000000000021';
  const calls = [];
  const database = {
    dialect: 'postgres',
    schemaName: 'userdata_fixture',
    client: { async query(text, values) {
      calls.push({ text, values });
      return { rows: [
        rawItem(seriesId, 'series', null, 0, {
          Type: 'MediaBrowser.Controller.Entities.TV.Series',
          __ProviderIds: { Tvdb: 'series-key' },
        }),
        rawItem(episodeId, 'episode', null, 0, {
          Type: 'MediaBrowser.Controller.Entities.TV.Episode',
          SeriesId: seriesId,
          ParentIndexNumber: 1,
          IndexNumber: 2,
        }),
      ] };
    } },
  };
  const loaded = await loadPostgresUserDataKeyItems(database, [episodeId]);
  assert.equal(loaded.length, 2);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /WITH RECURSIVE[\s\S]*CROSS JOIN LATERAL[\s\S]*array_agg/u);
  assert.deepEqual(calls[0].values, [[episodeId.replaceAll('-', '')]]);

  calls.length = 0;
  const keys = await postgresUserDataKeyMap(database, [{
    Id: episodeId,
    Type: 'Episode',
    SeriesId: seriesId,
    ParentIndexNumber: 1,
    IndexNumber: 2,
  }]);
  assert.deepEqual(keys.get(episodeId.replaceAll('-', '')), [
    'series-key001002', episodeId.toLowerCase(),
  ]);
  assert.equal(calls.length, 1);
});
