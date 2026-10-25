import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { cleanValue } from '../../src/library/records.js';

const ids = Object.fromEntries(['root', 'movies', 'movieFolder', 'excluded', 'excludedFolder', 'primary', 'alternate',
  'second', 'owned', 'audio', 'virtual', 'excludedMovie'].map((name, index) =>
  [name, `C1111111-1111-1111-1111-${String(index + 1).padStart(12, '0')}`]));

function emptyRow(table) {
  return Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => [column.name,
    column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'uint' || column.clrType === 'long' ? 0n : 0]));
}

function item(id, type, name, extra = {}) {
  const video = ['Movie', 'Video', 'Episode'].includes(type);
  const nativeType = {
    Movie: 'MediaBrowser.Controller.Entities.Movies.Movie',
    Audio: 'MediaBrowser.Controller.Entities.Audio.Audio',
    Series: 'MediaBrowser.Controller.Entities.TV.Series',
    Season: 'MediaBrowser.Controller.Entities.TV.Season',
    Episode: 'MediaBrowser.Controller.Entities.TV.Episode'
  }[type] ?? `MediaBrowser.Controller.Entities.${type}`;
  return { ...emptyRow('BaseItems'), Id: id, PresentationUniqueKey: id,
    Type: nativeType,
    Name: name, CleanName: cleanValue(name), SortName: cleanValue(name), IsFolder: !video && type !== 'Audio',
    MediaType: video ? 'Video' : type === 'Audio' ? 'Audio' : 'Unknown', Data: '{}', Tags: '', Genres: '', Studios: '',
    ProductionLocations: '', ...extra };
}

function fixtureId(group, index) {
  return `${group}2222222-2222-2222-2222-${String(index).padStart(12, '0')}`;
}

async function addFixtureItem(database, { id, type, name, parentId, extra = {} }) {
  const leaf = ['Movie', 'Video', 'Episode', 'Audio'].includes(type);
  await database.insert('BaseItems', item(id, type, name, {
    ParentId: parentId,
    TopParentId: ids.movieFolder,
    ...(leaf ? { Path: `Z:\\Resume\\${name}.mkv`, RunTimeTicks: 10000n } : {}),
    ...extra,
  }));
  // Persist the ancestor chain used by native recursive repository queries.
  const rows = await database.rows('BaseItems');
  const byId = new Map(rows.map(row => [row.Id.toLowerCase(), row]));
  const seen = new Set([id.toLowerCase()]);
  let ancestor = byId.get(parentId?.toLowerCase());
  while (ancestor && !seen.has(ancestor.Id.toLowerCase())) {
    seen.add(ancestor.Id.toLowerCase());
    await database.insert('AncestorIds', { ...emptyRow('AncestorIds'), ItemId: id, ParentItemId: ancestor.Id });
    ancestor = byId.get(ancestor.ParentId?.toLowerCase());
  }
}

async function addUserData(database, userId, itemId, {
  key = itemId.toLowerCase(), position = 0n, played = false, lastPlayedDate = null,
} = {}) {
  await database.insert('UserData', { ...emptyRow('UserData'), UserId: userId, ItemId: itemId,
    CustomDataKey: key, PlaybackPositionTicks: position, Played: played, LastPlayedDate: lastPlayedDate });
}

async function seed(database, userId) {
  await database.insert('BaseItems', item(ids.root, 'UserRootFolder', 'Media Folders'));
  await database.insert('BaseItems', item(ids.movies, 'CollectionFolder', 'Movies', { ParentId: ids.root,
    Data: JSON.stringify({ CollectionType: 'movies', PhysicalFolderIds: [ids.movieFolder] }) }));
  await database.insert('BaseItems', item(ids.movieFolder, 'Folder', 'Movie files', { TopParentId: ids.movieFolder }));
  await database.insert('BaseItems', item(ids.excluded, 'CollectionFolder', 'Excluded', { ParentId: ids.root,
    Data: JSON.stringify({ CollectionType: 'movies', PhysicalFolderIds: [ids.excludedFolder] }) }));
  await database.insert('BaseItems', item(ids.excludedFolder, 'Folder', 'Excluded files', { TopParentId: ids.excludedFolder }));

  const addMedia = async (id, type, name, parentId, extra, lastPlayedDate, position = 1000n) => {
    await database.insert('BaseItems', item(id, type, name, { ParentId: parentId, TopParentId: parentId,
      Path: `Z:\\Resume\\${name}.mkv`, RunTimeTicks: 10000n, ...extra }));
    await database.insert('UserData', { ...emptyRow('UserData'), UserId: userId, ItemId: id,
      CustomDataKey: id.toLowerCase(), PlaybackPositionTicks: position, LastPlayedDate: lastPlayedDate });
  };
  await addMedia(ids.primary, 'Movie', 'Primary', ids.movieFolder, {}, '2026-09-20 12:00:00');
  await addMedia(ids.alternate, 'Movie', 'Alternate 4K', ids.movieFolder, { PrimaryVersionId: ids.primary }, '2026-09-25 12:00:00');
  await addMedia(ids.second, 'Movie', 'Second', ids.movieFolder, {}, '2026-09-24 12:00:00');
  await addMedia(ids.owned, 'Movie', 'Owned', ids.movieFolder, { OwnerId: ids.primary }, '2026-09-23 12:00:00');
  await addMedia(ids.audio, 'Audio', 'Audio', ids.movieFolder, { Path: 'Z:\\Resume\\audio.flac' }, '2026-09-22 12:00:00');
  await addMedia(ids.virtual, 'Movie', 'Virtual', ids.movieFolder, { IsVirtualItem: true, Path: null }, '2026-09-26 12:00:00');
  await addMedia(ids.excludedMovie, 'Movie', 'Excluded movie', ids.excludedFolder, {}, '2026-09-27 12:00:00');
}

async function setup(t, dialect) {
  const prefix = path.join(tmpdir(), 'mediamanager-resume-http-');
  const programDataPath = await mkdtemp(prefix);
  const schema = `resume_http_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
  let database, runtime;
  t.after(async () => {
    try {
      if (runtime) await runtime.close();
      else if (database && (dialect === 'postgres' || database.database.isOpen)) await database.close();
    } finally {
      try {
        if (dialect === 'postgres' && database) {
          const cleanup = await PostgresDatabase.open({ connectionString, schema });
          try {
            await cleanup.client.query(`DROP SCHEMA "${schema}" CASCADE`);
            await cleanup.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
          } finally { await cleanup.close(); }
        }
      } finally {
        assert.ok(path.resolve(programDataPath).startsWith(path.resolve(prefix)));
        await rm(programDataPath, { recursive: true });
      }
    }
  });
  database = await PostgresDatabase.open({ connectionString, schema, create: true });
  runtime = await createTestRuntime({ database, configuration: { IsStartupWizardCompleted: true, UICulture: 'en-US' },
    serverId: 'resume-http-test', serverName: 'Resume HTTP Test', programDataPath });
  const viewer = await runtime.users.createUser({ Name: 'Viewer', Password: 'viewer password' });
  const other = await runtime.users.createUser({ Name: 'Other', Password: 'other password' });
  const userId = (await runtime.users.getUser(viewer.Id)).Id;
  await seed(database, userId);
  await runtime.users.updateConfiguration(viewer.Id, { ...(await runtime.users.getUser(viewer.Id)).Configuration,
    LatestItemsExcludes: [] });
  await runtime.users.updatePolicy(viewer.Id, { ...(await runtime.users.getUser(viewer.Id)).Policy,
    EnableAllFolders: false, EnabledFolders: [ids.movies] });

  const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http' && entry.bound).port}`;
  const authorization = token => `MediaBrowser Client="ResumeTest", Device="Test", DeviceId="resume-device", Version="1"${token ? `, Token="${token}"` : ''}`;
  const request = async (route, { method = 'GET', token, body } = {}) => {
    const response = await fetch(origin + route, { method, headers: { Authorization: authorization(token), Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let data = text;
    try { data = JSON.parse(text); } catch {}
    return { status: response.status, data };
  };
  const login = await request('/Users/AuthenticateByName', { method: 'POST', body: { Username: 'Viewer', Pw: 'viewer password' } });
  assert.equal(login.status, 200);
  return { runtime, database, request, token: login.data.AccessToken, userId, viewer, other };
}

function resumeTest(name, run) {
  for (const dialect of ['postgres']) test(`${dialect}: ${name}`,
    { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, t => run(t, dialect));
}

resumeTest('Resume HTTP routes enforce user scope and return resumable real versions in native order', async (t, dialect) => {
  const { runtime, request, token, viewer, other } = await setup(t, dialect);
  const page = await request('/UserItems/Resume?IncludeItemTypes=Movie&MediaTypes=Video&StartIndex=1&Limit=1', { token });
  assert.equal(page.status, 200);
  assert.equal(page.data.TotalRecordCount, 3);
  assert.equal(page.data.StartIndex, 1);
  assert.deepEqual(page.data.Items.map(item => item.Name), ['Second']);

  const currentPageCount = await request('/UserItems/Resume?IncludeItemTypes=Movie&StartIndex=1&Limit=1&EnableTotalRecordCount=false', { token });
  assert.equal(currentPageCount.status, 200);
  assert.equal(currentPageCount.data.TotalRecordCount, 1);
  assert.equal(currentPageCount.data.Items.length, 1);
  const emptyPageCount = await request('/UserItems/Resume?IncludeItemTypes=Movie&StartIndex=99&Limit=1&EnableTotalRecordCount=false', { token });
  assert.equal(emptyPageCount.status, 200);
  assert.equal(emptyPageCount.data.TotalRecordCount, 0);
  assert.deepEqual(emptyPageCount.data.Items, []);

  const legacy = await request(`/Users/${viewer.Id}/Items/Resume?IncludeItemTypes=Movie&MediaTypes=Video`, { token });
  assert.equal(legacy.status, 200);
  assert.deepEqual(legacy.data.Items.map(item => item.Name), ['Alternate 4K', 'Second', 'Owned']);
  assert.equal(legacy.data.Items[0].Id, ids.alternate.replaceAll('-', '').toLowerCase());
  assert.equal(legacy.data.Items[0].UserData.PlaybackPositionTicks, 1000);
  assert.equal(legacy.data.Items.some(item => item.Name === 'Virtual'), false);
  assert.equal(legacy.data.Items.some(item => item.Name === 'Excluded movie'), false);
  for (const recursive of ['true', 'false', 'invalid']) {
    const unbound = await request(`/Users/${viewer.Id}/Items/Resume?IncludeItemTypes=Movie&MediaTypes=Video&Recursive=${recursive}`, { token });
    assert.equal(unbound.status, 200);
    assert.deepEqual(unbound.data, legacy.data, 'Resume ignores an argument absent from both native actions.');
  }
  const withPath = await request('/UserItems/Resume?IncludeItemTypes=Movie&MediaTypes=Video&Fields=Path', { token });
  assert.equal(withPath.status, 200);
  assert.ok(withPath.data.Items.every(item => item.Path));
  const unknownField = await request('/UserItems/Resume?IncludeItemTypes=Movie&MediaTypes=Video&Fields=BasicSyncInfo,Path,UnknownClientField', { token });
  assert.equal(unknownField.status, 200);
  assert.deepEqual(unknownField.data, withPath.data);

  const audio = await request('/UserItems/Resume?MediaTypes=Audio', { token });
  assert.equal(audio.status, 200);
  assert.deepEqual(audio.data.Items.map(item => item.Name), ['Audio']);
  const impossible = await request('/UserItems/Resume?IncludeItemTypes=Movie&MediaTypes=Audio', { token });
  assert.equal(impossible.status, 200);
  assert.equal(impossible.data.TotalRecordCount, 0);

  await runtime.users.updatePolicy(viewer.Id, { ...(await runtime.users.getUser(viewer.Id)).Policy, EnableAllFolders: true });
  const parent = await request(`/UserItems/Resume?ParentId=${ids.excluded}&IncludeItemTypes=Movie`, { token });
  assert.equal(parent.status, 200);
  assert.deepEqual(parent.data.Items.map(item => item.Name), ['Excluded movie']);
  assert.equal((await request(`/Users/${other.Id}/Items/Resume`, { token })).status, 403);

  const current = await runtime.users.getUser(viewer.Id);
  await runtime.users.updateConfiguration(viewer.Id, { ...current.Configuration, LatestItemsExcludes: [] });
  await runtime.users.updatePolicy(viewer.Id, { ...current.Policy, EnableAllFolders: false, EnabledFolders: [ids.movies] });
  const restricted = await request('/UserItems/Resume?IncludeItemTypes=Movie', { token });
  assert.deepEqual(restricted.data.Items.map(item => item.Name), ['Alternate 4K', 'Second', 'Owned']);
  const explicitRestrictedParent = await request(`/UserItems/Resume?ParentId=${ids.excluded}`, { token });
  assert.equal(explicitRestrictedParent.status, 200);
  assert.deepEqual(explicitRestrictedParent.data.Items.map(item => ({ Id: item.Id, Name: item.Name })),
    [{ Id: ids.excludedMovie.replaceAll('-', '').toLowerCase(), Name: 'Excluded movie' }]);
  assert.equal(explicitRestrictedParent.data.TotalRecordCount, 1);
  assert.equal(explicitRestrictedParent.data.StartIndex, 0);
});

resumeTest('Resume can exclude an active alternate and its complete media-version family', async (t, dialect) => {
  const { request, token } = await setup(t, dialect);
  assert.equal((await request('/Sessions/Playing', { method: 'POST', token, body: { ItemId: ids.alternate } })).status, 204);
  const page = await request('/UserItems/Resume?IncludeItemTypes=Movie&ExcludeActiveSessions=true', { token });
  assert.equal(page.status, 200);
  assert.deepEqual(page.data.Items.map(item => item.Name), ['Second', 'Owned']);
});

resumeTest('Resume includes only resumable Series and Season folders and aggregates distinct default leaves', async (t, dialect) => {
  const { database, request, token, userId } = await setup(t, dialect);
  const progressSeries = fixtureId('D', 1), progressSeason = fixtureId('D', 2);
  const progressEpisode = fixtureId('D', 3), progressAlternate = fixtureId('D', 4);
  await addFixtureItem(database, { id: progressSeries, type: 'Series', name: 'Progress Series', parentId: ids.movieFolder });
  await addFixtureItem(database, { id: progressSeason, type: 'Season', name: 'Progress Season', parentId: progressSeries });
  await addFixtureItem(database, { id: progressEpisode, type: 'Episode', name: 'Progress Episode', parentId: progressSeason });
  await addFixtureItem(database, { id: progressAlternate, type: 'Episode', name: 'Progress Episode Alternate', parentId: progressSeason,
    extra: { PrimaryVersionId: progressEpisode } });
  await addUserData(database, userId, progressAlternate, { position: 1000n, lastPlayedDate: '2026-09-20 10:00:00' });

  const mixedSeries = fixtureId('D', 10), mixedSeason = fixtureId('D', 11);
  const mixedPrimary = fixtureId('D', 12), mixedAlternate = fixtureId('D', 13);
  const mixedUnplayedA = fixtureId('D', 14), mixedUnplayedB = fixtureId('D', 15), mixedOwned = fixtureId('D', 16);
  const mixedSeasonReplica = fixtureId('D', 17), mixedReplicaEpisode = fixtureId('D', 18);
  await addFixtureItem(database, { id: mixedSeries, type: 'Series', name: 'Mixed Series', parentId: ids.movieFolder });
  await addFixtureItem(database, { id: mixedSeason, type: 'Season', name: 'Mixed Season', parentId: mixedSeries });
  await addFixtureItem(database, { id: mixedPrimary, type: 'Episode', name: 'Mixed Played Primary', parentId: mixedSeason });
  await addFixtureItem(database, { id: mixedAlternate, type: 'Episode', name: 'Mixed Played Alternate', parentId: mixedSeason,
    extra: { PrimaryVersionId: mixedPrimary } });
  await addFixtureItem(database, { id: mixedUnplayedA, type: 'Episode', name: 'Mixed Unplayed A', parentId: mixedSeason });
  await addFixtureItem(database, { id: mixedUnplayedB, type: 'Episode', name: 'Mixed Unplayed B', parentId: mixedSeason });
  await addFixtureItem(database, { id: mixedOwned, type: 'Episode', name: 'Mixed Owned Unplayed', parentId: mixedSeason,
    extra: { OwnerId: mixedPrimary } });
  await addUserData(database, userId, mixedAlternate, { played: true, lastPlayedDate: '2026-09-19 10:00:00' });
  await addFixtureItem(database, { id: mixedSeasonReplica, type: 'Season', name: 'Mixed Season Replica', parentId: ids.movieFolder,
    extra: { PresentationUniqueKey: mixedSeason } });
  await addFixtureItem(database, { id: mixedReplicaEpisode, type: 'Episode', name: 'Mixed Replica Unplayed', parentId: mixedSeasonReplica });

  const allPlayedSeries = fixtureId('D', 20), allPlayedSeason = fixtureId('D', 21);
  const allPlayedA = fixtureId('D', 22), allPlayedB = fixtureId('D', 23);
  await addFixtureItem(database, { id: allPlayedSeries, type: 'Series', name: 'All Played Series', parentId: ids.movieFolder });
  await addFixtureItem(database, { id: allPlayedSeason, type: 'Season', name: 'All Played Season', parentId: allPlayedSeries });
  await addFixtureItem(database, { id: allPlayedA, type: 'Episode', name: 'All Played A', parentId: allPlayedSeason });
  await addFixtureItem(database, { id: allPlayedB, type: 'Episode', name: 'All Played B', parentId: allPlayedSeason });
  await addUserData(database, userId, allPlayedA, { played: true, lastPlayedDate: '2026-09-18 10:00:00' });
  await addUserData(database, userId, allPlayedB, { played: true, lastPlayedDate: '2026-09-18 11:00:00' });

  const allUnplayedSeries = fixtureId('D', 30), allUnplayedSeason = fixtureId('D', 31);
  await addFixtureItem(database, { id: allUnplayedSeries, type: 'Series', name: 'All Unplayed Series', parentId: ids.movieFolder });
  await addFixtureItem(database, { id: allUnplayedSeason, type: 'Season', name: 'All Unplayed Season', parentId: allUnplayedSeries });
  await addFixtureItem(database, { id: fixtureId('D', 32), type: 'Episode', name: 'All Unplayed Episode', parentId: allUnplayedSeason });

  const plainFolder = fixtureId('D', 40), plainProgress = fixtureId('D', 41);
  await addFixtureItem(database, { id: plainFolder, type: 'Folder', name: 'Plain Progress Folder', parentId: ids.movieFolder });
  await addFixtureItem(database, { id: plainProgress, type: 'Episode', name: 'Plain Progress Episode', parentId: plainFolder });
  await addUserData(database, userId, plainProgress, { position: 1000n, lastPlayedDate: '2026-09-21 10:00:00' });

  const page = await request(`/UserItems/Resume?ParentId=${ids.movieFolder}&IncludeItemTypes=Series,Season,Folder&Fields=RecursiveItemCount`, { token });
  assert.equal(page.status, 200);
  assert.deepEqual(page.data.Items.map(entry => entry.Name).sort(), [
    'Mixed Season', 'Mixed Series', 'Progress Season', 'Progress Series',
  ]);
  assert.equal(page.data.Items.some(entry => entry.Name === 'Plain Progress Folder'), false);
  assert.equal(page.data.Items.some(entry => entry.Name.startsWith('All Played')), false);
  assert.equal(page.data.Items.some(entry => entry.Name.startsWith('All Unplayed')), false);

  const mixed = page.data.Items.find(entry => entry.Id === mixedSeason.replaceAll('-', '').toLowerCase());
  assert.ok(mixed);
  assert.equal(mixed.RecursiveItemCount, 4);
  assert.equal(mixed.UserData.UnplayedItemCount, 3);
  assert.equal(mixed.UserData.Played, false);
  assert.equal(mixed.UserData.PlayedPercentage, 25);

  assert.equal((await request('/Sessions/Playing', { method: 'POST', token, body: { ItemId: progressAlternate } })).status, 204);
  const active = await request(`/UserItems/Resume?ParentId=${ids.movieFolder}&IncludeItemTypes=Series,Season&ExcludeActiveSessions=true`, { token });
  assert.equal(active.status, 200);
  assert.deepEqual(active.data.Items.map(entry => entry.Name).sort(), [
    'Mixed Season', 'Mixed Series', 'Progress Season', 'Progress Series',
  ]);
});

resumeTest('Resume uses every UserData row for eligibility, version winners, and DatePlayed ordering without changing DTO key precedence', async (t, dialect) => {
  const { database, request, token, userId } = await setup(t, dialect);
  const scope = fixtureId('E', 1);
  await addFixtureItem(database, { id: scope, type: 'Folder', name: 'Multiple UserData Rows', parentId: ids.movieFolder });

  const canonicalFirst = fixtureId('E', 2);
  await addFixtureItem(database, { id: canonicalFirst, type: 'Movie', name: 'Canonical First', parentId: scope });
  await addUserData(database, userId, canonicalFirst, { key: 'legacy-canonical-first', position: 1000n,
    lastPlayedDate: '2026-09-20 12:00:00' });
  await addUserData(database, userId, canonicalFirst, { position: 0n, lastPlayedDate: '2026-09-30 12:00:00' });

  const sortControl = fixtureId('E', 3);
  await addFixtureItem(database, { id: sortControl, type: 'Movie', name: 'Sort Control', parentId: scope });
  await addUserData(database, userId, sortControl, { position: 1000n, lastPlayedDate: '2026-09-29 12:00:00' });

  const versionPrimary = fixtureId('E', 4), versionAlternate = fixtureId('E', 5);
  await addFixtureItem(database, { id: versionPrimary, type: 'Movie', name: 'Version Primary', parentId: scope });
  await addFixtureItem(database, { id: versionAlternate, type: 'Movie', name: 'Version Alternate', parentId: scope,
    extra: { PrimaryVersionId: versionPrimary } });
  await addUserData(database, userId, versionPrimary, { key: 'legacy-version-primary', position: 1000n,
    lastPlayedDate: '2026-09-28 12:00:00' });
  await addUserData(database, userId, versionPrimary, { position: 0n, lastPlayedDate: '2026-09-19 12:00:00' });
  await addUserData(database, userId, versionAlternate, { position: 1000n, lastPlayedDate: '2026-09-27 12:00:00' });

  const scopedPrimary = fixtureId('E', 6), outOfScopeAlternate = fixtureId('E', 7);
  await addFixtureItem(database, { id: scopedPrimary, type: 'Movie', name: 'Scoped Older Version', parentId: scope });
  await addFixtureItem(database, { id: outOfScopeAlternate, type: 'Movie', name: 'Out Of Scope Newer Version', parentId: ids.movieFolder,
    extra: { PrimaryVersionId: scopedPrimary } });
  await addUserData(database, userId, scopedPrimary, { position: 1000n, lastPlayedDate: '2026-09-25 12:00:00' });
  await addUserData(database, userId, outOfScopeAlternate, { position: 1000n, lastPlayedDate: '2026-09-26 12:00:00' });

  const page = await request(`/UserItems/Resume?ParentId=${scope}&IncludeItemTypes=Movie`, { token });
  assert.equal(page.status, 200);
  assert.deepEqual(page.data.Items.map(entry => entry.Name), ['Canonical First', 'Sort Control', 'Version Primary']);

  const canonicalDto = page.data.Items[0];
  assert.equal(canonicalDto.UserData.Key, canonicalFirst.toLowerCase());
  assert.equal(canonicalDto.UserData.PlaybackPositionTicks, 0);
  assert.equal(canonicalDto.UserData.LastPlayedDate, '2026-09-30T12:00:00.0000000Z');
  const versionDto = page.data.Items[2];
  assert.equal(versionDto.Id, versionPrimary.replaceAll('-', '').toLowerCase());
  assert.equal(versionDto.UserData.Key, versionPrimary.toLowerCase());
  assert.equal(versionDto.UserData.PlaybackPositionTicks, 0);
});

resumeTest('Resume version winners preserve nullable dates and use GUID ties within each date bucket', async (t, dialect) => {
  const { database, request, token, userId } = await setup(t, dialect);
  const scope = fixtureId('F', 1);
  const larger = fixtureId('F', 3);
  const smaller = '01111111-1111-1111-1111-000000000002';
  await addFixtureItem(database, { id: scope, type: 'Folder', name: 'Version Tie', parentId: ids.movieFolder });
  await addFixtureItem(database, { id: larger, type: 'Movie', name: 'Larger Earlier', parentId: scope });
  await addUserData(database, userId, larger, { position: 1000n, lastPlayedDate: '2026-09-25 12:00:00' });
  await addFixtureItem(database, { id: smaller, type: 'Movie', name: 'Smaller Later', parentId: scope,
    extra: { PrimaryVersionId: larger } });
  await addUserData(database, userId, smaller, { position: 1000n, lastPlayedDate: '2026-09-25 12:00:00' });

  const mixedNull = fixtureId('F', 4), mixedDated = fixtureId('F', 5);
  await addFixtureItem(database, { id: mixedNull, type: 'Movie', name: 'Mixed Null Primary', parentId: scope });
  await addFixtureItem(database, { id: mixedDated, type: 'Movie', name: 'Mixed Dated Alternate', parentId: scope,
    extra: { PrimaryVersionId: mixedNull } });
  await addUserData(database, userId, mixedNull, { position: 1000n });
  await addUserData(database, userId, mixedDated, { position: 1000n, lastPlayedDate: '2026-09-24 12:00:00' });

  const nullLarger = fixtureId('F', 6), nullSmaller = '02111111-1111-1111-1111-000000000007';
  await addFixtureItem(database, { id: nullLarger, type: 'Movie', name: 'Null Larger', parentId: scope });
  await addFixtureItem(database, { id: nullSmaller, type: 'Movie', name: 'Null Smaller', parentId: scope,
    extra: { PrimaryVersionId: nullLarger } });
  await addUserData(database, userId, nullLarger, { position: 1000n });
  await addUserData(database, userId, nullSmaller, { position: 1000n });

  const page = await request(`/UserItems/Resume?ParentId=${scope}&IncludeItemTypes=Movie`, { token });
  assert.equal(page.status, 200);
  assert.equal(page.data.TotalRecordCount, 4);
  assert.deepEqual(page.data.Items.map(entry => entry.Id), [smaller, mixedDated, mixedNull, nullSmaller]
    .map(value => value.replaceAll('-', '').toLowerCase()));

  const generic = await request(`/Items?ParentId=${scope}&Recursive=true&Filters=IsResumable&IncludeItemTypes=Movie&SortBy=DatePlayed&SortOrder=Descending`, { token });
  assert.equal(generic.status, 200);
  assert.deepEqual(generic.data.Items.map(entry => entry.Id), page.data.Items.map(entry => entry.Id));
});

resumeTest('Items IsResumable applies global version winners before scope and sorts by every UserData row', async (t, dialect) => {
  const { runtime, database, request, token, userId, viewer, other } = await setup(t, dialect);
  const scope = fixtureId('A', 1);
  await addFixtureItem(database, { id: scope, type: 'Folder', name: 'Repository Resume Scope', parentId: ids.movieFolder });

  const canonical = fixtureId('A', 2), sortControl = fixtureId('A', 3);
  await addFixtureItem(database, { id: canonical, type: 'Movie', name: 'Canonical Multi Row', parentId: scope });
  await addUserData(database, userId, canonical, { key: 'legacy-canonical-multi-row', position: 1000n,
    lastPlayedDate: '2026-09-20 12:00:00' });
  await addUserData(database, userId, canonical, { position: 0n, lastPlayedDate: '2026-09-30 12:00:00' });
  await addFixtureItem(database, { id: sortControl, type: 'Movie', name: 'Sort Control', parentId: scope });
  await addUserData(database, userId, sortControl, { position: 1000n, lastPlayedDate: '2026-09-29 12:00:00' });
  await addUserData(database, (await runtime.users.getUser(other.Id)).Id, sortControl, { lastPlayedDate: '2026-10-03 12:00:00' });

  const presentationOne = fixtureId('A', 4), presentationTwo = fixtureId('A', 5);
  await addFixtureItem(database, { id: presentationOne, type: 'Movie', name: 'Presentation One', parentId: scope,
    extra: { PresentationUniqueKey: 'shared-resume-presentation' } });
  await addFixtureItem(database, { id: presentationTwo, type: 'Movie', name: 'Presentation Two', parentId: scope,
    extra: { PresentationUniqueKey: 'shared-resume-presentation' } });
  await addUserData(database, userId, presentationOne, { position: 1000n, lastPlayedDate: '2026-09-28 12:00:00' });
  await addUserData(database, userId, presentationTwo, { position: 1000n, lastPlayedDate: '2026-09-27 12:00:00' });

  const scopedPrimary = fixtureId('A', 6), outOfScopeWinner = fixtureId('A', 7);
  await addFixtureItem(database, { id: scopedPrimary, type: 'Movie', name: 'Scoped Older Version', parentId: scope });
  await addFixtureItem(database, { id: outOfScopeWinner, type: 'Movie', name: 'Out Of Scope Winner', parentId: ids.movieFolder,
    extra: { PrimaryVersionId: scopedPrimary } });
  await addUserData(database, userId, scopedPrimary, { position: 1000n, lastPlayedDate: '2026-09-25 12:00:00' });
  await addUserData(database, userId, outOfScopeWinner, { position: 1000n, lastPlayedDate: '2026-09-26 12:00:00' });

  const owned = fixtureId('A', 8), virtual = fixtureId('A', 9);
  await addFixtureItem(database, { id: owned, type: 'Movie', name: 'Owned Resume', parentId: scope,
    extra: { OwnerId: canonical } });
  await addFixtureItem(database, { id: virtual, type: 'Movie', name: 'Virtual Resume', parentId: scope,
    extra: { IsVirtualItem: true, Path: null } });
  await addUserData(database, userId, owned, { position: 1000n, lastPlayedDate: '2026-10-01 12:00:00' });
  await addUserData(database, userId, virtual, { position: 1000n, lastPlayedDate: '2026-10-02 12:00:00' });

  const route = `/Items?ParentId=${scope}&Recursive=true&Filters=IsResumable,IsNotFolder&IncludeItemTypes=Movie&SortBy=DatePlayed&SortOrder=Descending`;
  const page = await request(`${route}&StartIndex=1&Limit=2`, { token });
  assert.equal(page.status, 200);
  assert.equal(page.data.TotalRecordCount, 4);
  assert.deepEqual(page.data.Items.map(entry => entry.Name), ['Sort Control', 'Presentation One']);

  const all = await request(`/Users/${viewer.Id}/Items?ParentId=${scope}&Recursive=true&Filters=IsResumable&IncludeItemTypes=Movie&SortBy=DatePlayed&SortOrder=Descending`, { token });
  assert.equal(all.status, 200);
  assert.deepEqual(all.data.Items.map(entry => entry.Name), [
    'Canonical Multi Row', 'Sort Control', 'Presentation One', 'Presentation Two',
  ]);
  assert.equal(all.data.Items[0].UserData.Key, canonical.toLowerCase());
  assert.equal(all.data.Items[0].UserData.PlaybackPositionTicks, 0);

  const currentPageCount = await request(`${route}&StartIndex=1&Limit=2&EnableTotalRecordCount=false`, { token });
  assert.equal(currentPageCount.data.TotalRecordCount, 2);
  const hiddenWinner = await request(`/Items?Ids=${scopedPrimary}&Filters=IsResumable`, { token });
  assert.equal(hiddenWinner.status, 200);
  assert.equal(hiddenWinner.data.TotalRecordCount, 0);

  const virtualOverride = await request(`/Items?ParentId=${scope}&Recursive=true&Filters=IsResumable&IncludeItemTypes=Movie&LocationTypes=Virtual`, { token });
  assert.equal(virtualOverride.status, 200);
  assert.deepEqual(virtualOverride.data.Items.map(entry => entry.Name).sort(), [
    'Canonical Multi Row', 'Presentation One', 'Presentation Two', 'Sort Control',
  ]);

  await runtime.apiKeys.create('Resume Date Sort');
  const apiKey = (await runtime.apiKeys.list()).Items.find(entry => entry.AppName === 'Resume Date Sort').AccessToken;
  const userless = await request(`/Items?Ids=${canonical},${sortControl}&SortBy=DatePlayed&SortOrder=Descending`, { token: apiKey });
  assert.equal(userless.status, 200);
  assert.deepEqual(userless.data.Items.map(entry => entry.Name), ['Sort Control', 'Canonical Multi Row']);
});

resumeTest('Items IsResumable exposes only resumable Series and Season folders', async (t, dialect) => {
  const { database, request, token, userId } = await setup(t, dialect);
  const scope = fixtureId('B', 1);
  await addFixtureItem(database, { id: scope, type: 'Folder', name: 'Folder Resume Scope', parentId: ids.movieFolder });

  const progressSeries = fixtureId('B', 2), progressSeason = fixtureId('B', 3), progressEpisode = fixtureId('B', 4);
  await addFixtureItem(database, { id: progressSeries, type: 'Series', name: 'Progress Series', parentId: scope });
  await addFixtureItem(database, { id: progressSeason, type: 'Season', name: 'Progress Season', parentId: progressSeries });
  await addFixtureItem(database, { id: progressEpisode, type: 'Episode', name: 'Progress Episode', parentId: progressSeason });
  await addUserData(database, userId, progressEpisode, { position: 1000n, lastPlayedDate: '2026-09-25 12:00:00' });

  const mixedSeries = fixtureId('B', 5), mixedSeason = fixtureId('B', 6);
  const mixedPlayed = fixtureId('B', 7), mixedUnplayed = fixtureId('B', 8);
  await addFixtureItem(database, { id: mixedSeries, type: 'Series', name: 'Mixed Series', parentId: scope });
  await addFixtureItem(database, { id: mixedSeason, type: 'Season', name: 'Mixed Season', parentId: mixedSeries });
  await addFixtureItem(database, { id: mixedPlayed, type: 'Episode', name: 'Mixed Played', parentId: mixedSeason });
  await addFixtureItem(database, { id: mixedUnplayed, type: 'Episode', name: 'Mixed Unplayed', parentId: mixedSeason });
  await addUserData(database, userId, mixedPlayed, { played: true, lastPlayedDate: '2026-09-24 12:00:00' });

  const plain = fixtureId('B', 9), plainEpisode = fixtureId('B', 10);
  await addFixtureItem(database, { id: plain, type: 'Folder', name: 'Plain Folder', parentId: scope });
  await addFixtureItem(database, { id: plainEpisode, type: 'Episode', name: 'Plain Progress', parentId: plain });
  await addUserData(database, userId, plainEpisode, { position: 1000n, lastPlayedDate: '2026-09-23 12:00:00' });

  const virtualSeries = fixtureId('B', 11), virtualEpisode = fixtureId('B', 12);
  await addFixtureItem(database, { id: virtualSeries, type: 'Series', name: 'Virtual Only Series', parentId: scope });
  await addFixtureItem(database, { id: virtualEpisode, type: 'Episode', name: 'Virtual Progress', parentId: virtualSeries,
    extra: { IsVirtualItem: true, Path: null } });
  await addUserData(database, userId, virtualEpisode, { position: 1000n, lastPlayedDate: '2026-09-22 12:00:00' });

  const folders = await request(`/Items?ParentId=${scope}&Recursive=true&Filters=IsResumable,IsFolder&IncludeItemTypes=Series,Season,Folder&SortBy=SortName`, { token });
  assert.equal(folders.status, 200);
  assert.deepEqual(folders.data.Items.map(entry => entry.Name), [
    'Mixed Season', 'Mixed Series', 'Progress Season', 'Progress Series',
  ]);
  const leaves = await request(`/Items?ParentId=${scope}&Recursive=true&Filters=IsResumable,IsNotFolder&IncludeItemTypes=Episode&SortBy=SortName`, { token });
  assert.equal(leaves.status, 200);
  assert.deepEqual(leaves.data.Items.map(entry => entry.Name), ['Plain Progress', 'Progress Episode']);
});

resumeTest('non-recursive folder IsResumable keeps preferred-row and cached-child behavior', async (t, dialect) => {
  const { database, request, token, userId } = await setup(t, dialect);
  const scope = fixtureId('9', 1);
  await addFixtureItem(database, { id: scope, type: 'Folder', name: 'Memory Resume Scope', parentId: ids.movieFolder });

  const preferredZero = fixtureId('9', 2), direct = fixtureId('9', 3), virtual = fixtureId('9', 4);
  await addFixtureItem(database, { id: preferredZero, type: 'Movie', name: 'Preferred Zero', parentId: scope });
  await addUserData(database, userId, preferredZero, { key: 'legacy-preferred-zero', position: 1000n });
  await addUserData(database, userId, preferredZero, { position: 0n });
  await addFixtureItem(database, { id: direct, type: 'Movie', name: 'Memory Direct', parentId: scope });
  await addUserData(database, userId, direct, { position: 1000n });
  await addFixtureItem(database, { id: virtual, type: 'Movie', name: 'Memory Virtual', parentId: scope,
    extra: { IsVirtualItem: true, Path: null } });
  await addUserData(database, userId, virtual, { position: 1000n });

  const primary = fixtureId('9', 5), alternate = fixtureId('9', 6), owned = fixtureId('9', 7);
  await addFixtureItem(database, { id: primary, type: 'Movie', name: 'Memory Primary', parentId: scope });
  await addFixtureItem(database, { id: alternate, type: 'Movie', name: 'Memory Alternate', parentId: scope,
    extra: { PrimaryVersionId: primary } });
  await addFixtureItem(database, { id: owned, type: 'Movie', name: 'Memory Owned', parentId: scope,
    extra: { OwnerId: direct } });
  await addUserData(database, userId, alternate, { position: 1000n });
  await addUserData(database, userId, owned, { position: 1000n });

  const folderOwn = fixtureId('9', 8), folderDescendant = fixtureId('9', 9), nestedProgress = fixtureId('9', 10);
  await addFixtureItem(database, { id: folderOwn, type: 'Folder', name: 'Folder Own Progress', parentId: scope });
  await addUserData(database, userId, folderOwn, { position: 1000n });
  await addFixtureItem(database, { id: folderDescendant, type: 'Folder', name: 'Folder Descendant Progress', parentId: scope });
  await addFixtureItem(database, { id: nestedProgress, type: 'Movie', name: 'Nested Progress', parentId: folderDescendant });
  await addUserData(database, userId, nestedProgress, { position: 1000n });

  const presentationOne = fixtureId('9', 11), presentationTwo = fixtureId('9', 12);
  await addFixtureItem(database, { id: presentationOne, type: 'Movie', name: 'Presentation One', parentId: scope,
    extra: { PresentationUniqueKey: 'memory-shared-presentation' } });
  await addFixtureItem(database, { id: presentationTwo, type: 'Movie', name: 'Presentation Two', parentId: scope,
    extra: { PresentationUniqueKey: 'memory-shared-presentation' } });
  await addUserData(database, userId, presentationOne, { position: 1000n });
  await addUserData(database, userId, presentationTwo, { position: 1000n });

  const page = await request(`/Items?ParentId=${scope}&Recursive=false&Filters=IsResumable&SortBy=SortName`, { token });
  assert.equal(page.status, 200);
  assert.deepEqual(page.data.Items.map(entry => entry.Name), [
    'Folder Own Progress', 'Memory Direct', 'Memory Virtual', 'Presentation One', 'Presentation Two',
  ]);
});
