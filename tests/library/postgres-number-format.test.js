import test from 'node:test';
import assert from 'node:assert/strict';
import { tableDefinition } from '../../src/database/model.js';
import { queryPostgresItemPage } from '../../src/database/postgres-item-query.js';
import { queryPostgresNextUpPage } from '../../src/library/postgres-next-up-query.js';
import { queryPostgresSeriesEpisodePage } from '../../src/library/postgres-series-episodes-query.js';
import { createPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';

const ids = {
  user: '78000000-0000-0000-0000-000000000001',
  series: '78000000-0000-0000-0000-000000000002',
  season: '78000000-0000-0000-0000-000000000003',
  first: '78000000-0000-0000-0000-000000000004',
  second: '78000000-0000-0000-0000-000000000005',
};

const blank = table => Object.fromEntries(tableDefinition(table).columns
  .filter(column => !column.generated).map(column => {
    const type = column.clrType.replace('?', '');
    return [column.name, type === 'DateTime' ? '2026-10-01 00:00:00'
      : column.nullable ? null : type === 'bool' ? false
        : column.type === 'TEXT' ? '' : type === 'long' || type === 'uint' ? 0n : 0];
  }));

const item = (Id, type, values = {}) => ({
  ...blank('BaseItems'), Id, Type: `MediaBrowser.Controller.Entities.TV.${type}`,
  Name: type, CleanName: type.toLowerCase(), SortName: type.toLowerCase(), Data: '{}',
  IsFolder: type !== 'Episode', MediaType: type === 'Episode' ? 'Video' : 'Unknown',
  PresentationUniqueKey: Id, ...values,
});

test('PostgreSQL Next Up preserves native minimum-width episode user-data keys', {
  skip: !postgresTestConnectionString,
}, async t => {
  const db = await createPostgresTestDatabase(t, 'number_nextup', { max: 2 });
  await db.insert('Users', { ...blank('Users'), Id: ids.user, Username: 'number-format' });
  await db.insert('BaseItems', item(ids.series, 'Series', { PresentationUniqueKey: 'series-key' }));
  await db.insert('BaseItemProviders', { ItemId: ids.series, ProviderId: 'Custom', ProviderValue: 'custom' });
  await db.insert('BaseItems', item(ids.first, 'Episode', {
    SeriesId: ids.series, ParentId: ids.series, SeriesPresentationUniqueKey: 'series-key',
    ParentIndexNumber: 1, IndexNumber: 1,
  }));
  // Episode.GetUserDataKeys uses Int32.ToString("000"): width is a minimum,
  // and Int32.MinValue is a valid value rather than an overflowing abs(int).
  for (const [season, episode, suffix] of [
    [1, 1000, '0011000'], [1000, 1, '1000001'],
    [1, -1000, '001-1000'], [1, -2147483648, '001-2147483648'],
    [-2147483648, 1, '-2147483648001'],
  ]) await t.test(`season ${season}, episode ${episode}`, async () => {
    await db.update('BaseItems', { Id: ids.first }, { ParentIndexNumber: season, IndexNumber: episode });
    await db.deleteWhere('UserData', { ItemId: ids.first });
    await db.insert('UserData', { ...blank('UserData'), ItemId: ids.first, UserId: ids.user,
      CustomDataKey: ids.first, PlaybackPositionTicks: 100n });
    await db.insert('UserData', { ...blank('UserData'), ItemId: ids.first, UserId: ids.user,
      CustomDataKey: `custom${suffix}`, PlaybackPositionTicks: 0n });
    const page = await queryPostgresNextUpPage(db, {
      seriesKeys: ['series-key'], userId: ids.user, enableResumable: false, limit: 1,
    });
    assert.equal(page.total, 1, 'the preferred native key overrides stale fallback progress');
    assert.deepEqual(page.rows.map(row => row.Id), [ids.first]);
  });
});

test('PostgreSQL native SortName ordering retains every signed season and episode digit', {
  skip: !postgresTestConnectionString,
}, async t => {
  const db = await createPostgresTestDatabase(t, 'number_sort', { max: 2 });
  await db.insert('BaseItems', item(ids.series, 'Series', { PresentationUniqueKey: 'series-key' }));
  await db.insert('BaseItems', item(ids.season, 'Season', {
    ParentId: ids.series, SeriesId: ids.series, IndexNumber: 0,
    PresentationUniqueKey: 'season-key', SeriesPresentationUniqueKey: 'series-key',
  }));
  for (const Id of [ids.first, ids.second]) {
    await db.insert('BaseItems', item(Id, 'Episode', {
      SeriesId: ids.series, SeasonId: ids.season, ParentId: ids.season,
      SeriesPresentationUniqueKey: 'series-key', ParentIndexNumber: 0,
    }));
    await db.insert('AncestorIds', { ItemId: Id, ParentItemId: ids.season });
  }
  for (const [firstIndex, secondIndex] of [[10000, 1000], [-10000, -1000], [-2147483648, -2147]]) {
    await t.test(`${firstIndex} versus ${secondIndex}`, async () => {
      await db.update('BaseItems', { Id: ids.first }, { IndexNumber: firstIndex, Name: 'A' });
      await db.update('BaseItems', { Id: ids.second }, { IndexNumber: secondIndex, Name: 'Z' });
      const page = await queryPostgresItemPage(db, {
        ids: [ids.first, ids.second], sortby: ['SortName'], limit: 1,
      }, { resumableMode: 'memory' });
      assert.equal(page.total, 2);
      assert.deepEqual(page.rows.map(row => row.Id), [ids.second]);
      const episodes = await queryPostgresSeriesEpisodePage(db, {
        mode: 'season', seasonId: ids.season, seriesKey: 'series-key',
        includeMissing: true, includeSpecials: false, limit: 1,
      });
      assert.equal(episodes.total, 2);
      assert.deepEqual(episodes.rows.map(row => row.Id), [ids.second]);
    });
  }
});
