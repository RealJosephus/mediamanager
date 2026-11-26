import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { queryPostgresSeriesEpisodePage } from '../../src/library/postgres-series-episodes-query.js';
import { queryPostgresItemPage } from '../../src/database/postgres-item-query.js';
import { LibraryConfigurationService } from '../../src/library/library-configuration-service.js';
import { dtoOptions, projectItem } from '../../src/library/dto.js';
import { mapRecord } from '../../src/library/records.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { exportCurrentSqlite, transferDatabase } from '../../src/migration/database-transfer.js';
import { searchHistoryClient, searchHistoryKey } from '../../src/sessions/search-history.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { jellyfinCatalog } from '../../src/migration/emby/catalog.js';
import { writeEmby } from '../../src/migration/emby/write-emby.js';
import { insert, writeJellyfin } from '../../src/migration/emby/write-jellyfin.js';
import { translatedRows } from '../../src/migration/emby/identities.js';
import { changesBetween } from '../../src/migration/emby/reconcile.js';
import { exchange } from '../../src/migration/emby/exchange.js';
import { permissionNames } from '../../src/users/native.js';
import { authenticatePassword } from '../../src/core/password.js';
import { projectStream } from '../../src/library/media-streams.js';
import { collectAssets, projectAssetRows } from '../../src/migration/emby/assets.js';
import { editObjectFields, fromBlob, toBlob } from '../../src/migration/emby/format.js';
import { inventory, mergeAssets } from '../../src/migration/emby/files.js';
import { readJellyfinLibraryOptions, reconcileJellyfinLibraryRemovals, writeJellyfinLibraryOptions } from '../../src/migration/emby/libraries.js';
import { markerProviderId, readMarkers, reserveChapterIndexes, writeMarker } from '../../src/migration/emby/chapter-markers.js';
import { repairEmbyPostgresFolders } from '../../src/migration/emby/folder-classification.js';
import { exchangeFixture, exchangeId, stoppedEmby, withCatalog } from './emby-exchange-fixture.js';

test('sealed receipts carry target edits across both directions and keep divergent fields open until agreement', async t => {
  const fixture = await exchangeFixture(t);
  fixture.emby.prepare("INSERT INTO MediaItems(Id,guid,type,Name,Overview,Tagline) VALUES(1,?,5,'Movie','A','start')").run(toBlob(exchangeId(1)));
  const original = await stoppedEmby(fixture);
  const step = (direction, source, name, template) => exchange({ direction, source, output: path.join(fixture.directory, name), template });
  const first = await step('import', original, 'initial');
  withCatalog(original, 'emby', db => db.exec("UPDATE MediaItems SET Overview='B'"));
  const outbound = await step('export', first.output, 'outbound', original);
  assert.equal(outbound.changes, 0);
  const inbound = await step('import', outbound.output, 'inbound');
  assert.equal(inbound.changes, 1);
  assert.equal(withCatalog(inbound.output, 'jellyfin', db => db.prepare('SELECT Overview FROM BaseItems').get().Overview), 'B');
  const repeated = await step('export', inbound.output, 'repeated');
  assert.equal(repeated.changes, 0);
  assert.equal((await step('import', repeated.output, 'replayed')).changes, 0);
  withCatalog(inbound.output, 'jellyfin', db => db.exec("UPDATE BaseItems SET Name='manager edit', Tagline='manager tagline'"));
  withCatalog(repeated.output, 'emby', db => db.exec("UPDATE MediaItems SET Overview='C', Tagline='Emby tagline'"));
  const conflicting = await step('import', repeated.output, 'conflicting', inbound.output);
  const returning = await step('export', conflicting.output, 'returning');
  for (const [result, type, table, tagline] of [[conflicting, 'jellyfin', 'BaseItems', 'manager tagline'], [returning, 'emby', 'MediaItems', 'Emby tagline']]) {
    assert.deepEqual(withCatalog(result.output, type, db => ({ ...db.prepare(`SELECT Name, Overview, Tagline FROM ${table}`).get() })),
      { Name: 'manager edit', Overview: 'C', Tagline: tagline });
    const report = JSON.parse(await readFile(result.report));
    assert.deepEqual(report.issues.filter(i => i.status === 'conflict').map(i => i.field), ['Tagline']);
  }
  withCatalog(returning.output, 'emby', db => db.exec("UPDATE MediaItems SET Tagline='manager tagline'"));
  const resolved = await step('import', returning.output, 'resolved');
  assert.equal(resolved.changes, 0);
  assert.equal(resolved.conflicts, 0);
});

test('first import selects one administrator by normalized login and publishes no instance for invalid choices', async t => {
  const fixture = await exchangeFixture(t);
  const put = fixture.emby.prepare('INSERT INTO accounts.LocalUsersv2 VALUES(?,?,?)');
  for (const [id, name] of [[1, 'Alice'], [2, 'Bob']]) put.run(id, toBlob(exchangeId(id)), JSON.stringify({ Name: name }));
  const source = await stoppedEmby(fixture), output = path.join(fixture.directory, 'manager');
  const run = adminUser => exchange({ direction: 'import', source, output, adminUser, adminPassword: adminUser && 'bootstrap password' });
  await assert.rejects(run(), /requires --admin-user/u);
  await assert.rejects(run('missing'), /matched 0/u);
  const accounts = new DatabaseSync(path.join(source, 'data/users.db'));
  try {
    accounts.prepare('UPDATE LocalUsersv2 SET data=? WHERE Id=2').run('{"Name":"ALICE"}');
    await assert.rejects(run('Alice'), /matched 2/u);
    await assert.rejects(fs.stat(output), { code: 'ENOENT' });
    accounts.prepare('UPDATE LocalUsersv2 SET data=? WHERE Id=2').run('{"Name":"Bob"}');
  } finally { accounts.close(); }
  await run('alice');
  const users = withCatalog(output, 'jellyfin', db => db.prepare(`SELECT Username, Password, admin.Value AS admin, disabled.Value AS disabled
    FROM Users u JOIN Permissions admin ON admin.UserId=u.Id AND admin.Kind=?
    JOIN Permissions disabled ON disabled.UserId=u.Id AND disabled.Kind=? ORDER BY Username`)
    .all(permissionNames.indexOf('IsAdministrator'), permissionNames.indexOf('IsDisabled')));
  assert.deepEqual(users.map(u => [u.Username, u.admin, u.disabled]), [['Alice', 1, 0], ['Bob', 0, 1]]);
  assert.deepEqual(await authenticatePassword('Alice', 'bootstrap password', users[0]), { Username: 'Alice' });
});

test('subtitle hearing impairment survives native catalogs, both writers and the media stream DTO', async t => {
  const { emby, jellyfin, readEmby, readJellyfin, applyToJellyfin, directory, report } = await exchangeFixture(t);
  const id = exchangeId(1), key = 'item/' + id;
  emby.prepare("INSERT INTO MediaItems(Id,guid,type,Name) VALUES(1,?,5,'Movie')").run(toBlob(id));
  emby.exec("ALTER TABLE MediaStreams2 ADD StreamType INTEGER; ALTER TABLE MediaStreams2 ADD Title TEXT; ALTER TABLE MediaStreams2 ADD IsHearingImpaired INTEGER; INSERT INTO MediaStreams2 VALUES(1,0,3,'Captions',1)");
  const source = readEmby();
  assert.equal(source.rows.get(key).Streams[0].IsHearingImpaired, 1);
  await applyToJellyfin(source, readJellyfin());
  const first = readJellyfin();
  const dto = () => projectStream(jellyfin.prepare('SELECT * FROM MediaStreamInfos').get());
  assert.equal(dto().Type, 'Subtitle');
  assert.equal(dto().IsHearingImpaired, true);
  jellyfin.exec('UPDATE MediaStreamInfos SET IsHearingImpaired=0');
  const edited = readJellyfin();
  await writeEmby(emby, changesBetween(edited.rows, source.rows, first.rows, source.rows, report, { sourceType: 'jellyfin' }), source, edited, report, directory);
  assert.equal(readEmby().rows.get(key).Streams[0].IsHearingImpaired, 0);
  assert.equal(dto().IsHearingImpaired, false);
  emby.exec('ALTER TABLE MediaStreams2 DROP COLUMN IsHearingImpaired');
  const old = readEmby();
  assert.equal(Object.hasOwn(old.rows.get(key).Streams[0], 'IsHearingImpaired'), false);
  jellyfin.exec('UPDATE MediaStreamInfos SET IsHearingImpaired=1');
  const target = readJellyfin();
  emby.exec("UPDATE MediaStreams2 SET Title='Legacy edit'");
  await applyToJellyfin(readEmby(), target, old.rows, target.rows);
  assert.equal(dto().Title, 'Legacy edit');
  assert.equal(dto().IsHearingImpaired, true);
});

test('new and existing Emby by-name rows use the native folder discriminator in PostgreSQL', async t => {
  const fixture = await exchangeFixture(t);
  const { emby, jellyfin, readEmby, readJellyfin, applyToJellyfin } = fixture;
  const put = emby.prepare('INSERT INTO MediaItems(Id,guid,type,Name,ParentId) VALUES(?,?,?,?,?)');
  const byName = [[13, 'MusicArtist'], [14, 'MusicGenre'], [21, 'Genre'], [23, 'Person'], [29, 'Studio']];
  for (const [type, name] of byName) put.run(type, toBlob(exchangeId(type)), type, name, null);
  put.run(3, toBlob(exchangeId(3)), 3, 'Music', null);
  put.run(113, toBlob(exchangeId(113)), 13, 'Artist directory', 3);
  const source = readEmby();
  await applyToJellyfin(source, readJellyfin());
  const priorTarget = readJellyfin();
  const folders = () => jellyfin.prepare('SELECT Name FROM BaseItems WHERE IsFolder=1 ORDER BY Name').all().map(row => row.Name);
  assert.deepEqual(folders(), ['Artist directory', 'Music']);

  jellyfin.exec('UPDATE BaseItems SET IsFolder=1');
  await applyToJellyfin(source, readJellyfin(), source.rows, priorTarget.rows);
  assert.deepEqual(folders(), ['Artist directory', 'Music']);
  emby.exec('UPDATE MediaItems SET ParentId=3 WHERE Id=13; UPDATE MediaItems SET ParentId=NULL WHERE Id=113');
  await applyToJellyfin(readEmby(), readJellyfin(), source.rows, priorTarget.rows);
  assert.deepEqual(folders(), ['Music', 'MusicArtist']);
  fixture.closeJellyfin();

  const origin = 'emby:old-migration-fixture';
  const database = await createPostgresTestDatabase(t, 'emby_folders');
  const sqlite = new SqliteDatabase(fixture.filename, { readOnly: true });
  try {
    await transferDatabase(sqlite, database, { instanceBinding: { serverId: exchangeId(1).replaceAll('-', ''),
      originIdentityDigest: createHash('sha256').update(origin).digest('hex') } });
  } finally { sqlite.close(); }
  const filtered = async isfolder => (await database.withConnection(db => queryPostgresItemPage(db, { isfolder })))
    .rows.map(row => row.Name).sort();
  const nonFolders = ['Artist directory', 'Genre', 'MusicGenre', 'Person', 'Studio'];
  assert.deepEqual(await filtered(true), ['Music', 'MusicArtist']);
  assert.deepEqual(await filtered(false), nonFolders);

  await database.client.query('UPDATE "BaseItems" SET "IsFolder"=true');
  await repairEmbyPostgresFolders(database, 'emby:other-origin');
  assert.deepEqual(await filtered(false), []);
  await Promise.all([repairEmbyPostgresFolders(database, origin), repairEmbyPostgresFolders(database, origin)]);
  assert.deepEqual(await filtered(true), ['Music', 'MusicArtist']);
  assert.deepEqual(await filtered(false), nonFolders);
});

test('Emby reclassification keeps an item GUID and updates its PostgreSQL media type', async t => {
  const fixture = await exchangeFixture(t);
  const { emby, jellyfin, readEmby, readJellyfin, applyToJellyfin } = fixture;
  const id = exchangeId(12);
  emby.prepare('INSERT INTO MediaItems(Id,guid,type,Name) VALUES(?,?,5,?)').run(12, toBlob(id), 'Reclassified');
  const before = readEmby();
  await applyToJellyfin(before, readJellyfin());
  const target = readJellyfin();
  assert.equal(jellyfin.prepare('SELECT MediaType FROM BaseItems WHERE Id=?').get(id).MediaType, 'Video');
  emby.exec('UPDATE MediaItems SET type=11 WHERE Id=12');
  await applyToJellyfin(readEmby(), target, before.rows, target.rows);
  const row = jellyfin.prepare('SELECT Type, MediaType FROM BaseItems WHERE Id=?').get(id);
  assert.equal(row.Type, 'MediaBrowser.Controller.Entities.Audio.Audio');
  assert.equal(row.MediaType, 'Audio');
  fixture.closeJellyfin();
  const database = await createPostgresTestDatabase(t, 'emby_media_type');
  const sqlite = new SqliteDatabase(fixture.filename, { readOnly: true });
  try {
    await transferDatabase(sqlite, database, { instanceBinding: { serverId: exchangeId(1).replaceAll('-', ''), originIdentityDigest: 'a'.repeat(64) } });
  } finally { sqlite.close(); }
  const filter = mediatypes => queryPostgresItemPage(database, { mediatypes });
  assert.deepEqual((await filter(['Audio'])).rows.map(row => row.Id), [id]);
  assert.deepEqual((await filter(['Video'])).rows, []);
});

test('an Emby virtual library deletion retires its configuration and preserves independently edited libraries', async t => {
  const fixture = await exchangeFixture(t);
  const { emby, jellyfin, directory, readEmby, readJellyfin, applyToJellyfin, report } = fixture;
  const instance = path.join(directory, 'target'), programDataPath = path.join(instance, 'data');
  const configured = path.join(programDataPath, 'root', 'default'), origin = path.join(directory, 'source');
  const names = ['Archived', 'Edited Options', 'Edited Row'];
  const destinations = names.map(name => path.join(configured, name));
  for (const [index, name] of names.entries()) {
    const destination = destinations[index];
    emby.prepare('INSERT INTO MediaItems(Id,guid,type,Name,Path) VALUES(?,?,4,?,?)')
      .run(index + 1, toBlob(exchangeId(index + 1)), name, destination);
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, 'options.xml'), '<LibraryOptions/>');
    await writeFile(path.join(destination, 'media.mblink'), '/owned/' + name);
  }
  const source = readEmby();
  await applyToJellyfin(source, readJellyfin());
  const baseline = await inventory(configured);
  const priorTarget = readJellyfin();
  await readJellyfinLibraryOptions(priorTarget, instance);

  // A stale source directory cannot resurrect the removed library on publish.
  await mkdir(path.join(origin, 'Archived'), { recursive: true });
  await writeFile(path.join(origin, 'Archived', 'old.mblink'), '/stale');
  const editedOptions = '<LibraryOptions><IndependentField>keep me</IndependentField></LibraryOptions>';
  await writeFile(path.join(destinations[1], 'options.xml'), editedOptions);
  jellyfin.prepare('UPDATE BaseItems SET Name=? WHERE Id=?').run('Independently renamed', exchangeId(3));
  emby.exec('DELETE FROM MediaItems');
  const afterSource = readEmby(), target = readJellyfin();
  await readJellyfinLibraryOptions(target, instance);
  const changes = changesBetween(afterSource.rows, target.rows, source.rows, priorTarget.rows, report, { sourceType: 'emby' });
  const removals = await reconcileJellyfinLibraryRemovals(changes, instance, {
    sourceRows: afterSource.rows, targetRows: target.rows, previousSource: source.rows, previousTargetAssets: baseline.members, report,
  });
  assert.deepEqual(removals.changes.filter(change => !change.value).map(change => change.key), ['item/' + exchangeId(1)]);
  jellyfin.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON');
  await writeJellyfin(jellyfin, removals.changes, target, afterSource, report);
  await writeJellyfinLibraryOptions(removals.changes, instance, report);
  jellyfin.exec('COMMIT');
  await mergeAssets(origin, configured, baseline, baseline, report, {
    include: name => !removals.excludedDirectories.has(name.split('/')[0]) && !/^[^/]+\/options\.xml$/iu.test(name),
  });
  assert.deepEqual((await readdir(configured)).sort(), ['Edited Options', 'Edited Row']);
  assert.equal(await readFile(path.join(destinations[1], 'options.xml'), 'utf8'), editedOptions);
  assert.equal(await readFile(path.join(destinations[2], 'media.mblink'), 'utf8'), '/owned/Edited Row');
  assert.ok(fixture.issues.some(([status, kind, id, field, reason]) => status === 'conflict' && kind === 'item'
    && id === exchangeId(2) && field === 'deletion' && reason.includes('configuration directory')));
  assert.ok(fixture.issues.some(([status, kind, id, field, reason]) => status === 'conflict' && kind === 'item'
    && id === exchangeId(3) && field === 'deletion' && reason === 'target has edits'));
  fixture.closeJellyfin();

  const database = await createPostgresTestDatabase(t, 'emby_removed_library');
  const sqlite = new SqliteDatabase(fixture.filename, { readOnly: true });
  try {
    await transferDatabase(sqlite, database, { instanceBinding: { serverId: exchangeId(1).replaceAll('-', ''), originIdentityDigest: 'a'.repeat(64) } });
  } finally { sqlite.close(); }
  assert.deepEqual(await database.rows('BaseItems', { where: { Id: exchangeId(1) } }), []);
  const service = new LibraryConfigurationService({ programDataPath, fileSystem: fs, mediaAssets: {}, optionsStore: { bind: async () => ({}) },
    lifecycle: {}, monitor: {}, queueLibraryScan() {}, host: {
      getUserRootFolder: async () => ({}), withCachedChildren: async (_root, read) => read({
        firstByPath: async filename => (await database.rows('BaseItems', { where: { Path: filename } }))[0],
      }),
    } });
  try {
    const listed = await service.getVirtualFolders();
    assert.deepEqual(listed.map(({ Name, ItemId }) => [Name, ItemId?.replaceAll('-', '')]).sort(),
      [['Edited Options', exchangeId(2).replaceAll('-', '')], ['Edited Row', exchangeId(3).replaceAll('-', '')]]);
  } finally { await service.close(); }
});

test('asset exchange applies both member type transitions and retries against file-only receipts', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mm-emby-asset-types-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source'), target = path.join(directory, 'target');
  const member = name => path.join(source, name), output = name => path.join(target, name);
  const issues = [], report = (...args) => issues.push(args);
  await mkdir(source);
  await writeFile(member('poster'), 'old');
  const first = await mergeAssets(source, target, {}, {}, report);
  await rm(member('poster'));
  await mkdir(member('poster'));
  await mkdir(member('poster/empty'));
  await writeFile(member('poster/a.jpg'), 'new');
  const second = await mergeAssets(source, target, first.source.members, first.target.members, report);
  assert.deepEqual((await readdir(output('poster'))).sort(), ['a.jpg', 'empty']);
  assert.equal(await readFile(output('poster/a.jpg'), 'utf8'), 'new');
  assert.deepEqual(await mergeAssets(source, target, first.source.members, first.target.members, report), second);

  await rm(member('poster'), { recursive: true });
  await writeFile(member('poster'), 'published');
  await writeFile(output('poster/a.jpg'), 'independent target edit');
  await mkdir(output('poster/only-on-target'));
  await mergeAssets(source, target, second.source, second.target, report);
  assert.equal(await readFile(output('poster/a.jpg'), 'utf8'), 'independent target edit');
  assert.deepEqual((await readdir(output('poster'))).sort(), ['a.jpg', 'empty', 'only-on-target']);
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0].slice(0, 4), ['conflict', 'asset', 'poster', 'kind']);

  await writeFile(output('poster/a.jpg'), 'new');
  // The remaining target-only member is enough to keep the directory.
  await mergeAssets(source, target, second.source, second.target, report);
  assert.equal(issues.length, 2);
  await rm(output('poster/only-on-target'), { recursive: true });
  const replaced = await mergeAssets(source, target, second.source, second.target, report);
  assert.equal(await readFile(output('poster'), 'utf8'), 'published');
  assert.deepEqual(await mergeAssets(source, target, replaced.source, replaced.target, report), replaced);
  assert.equal(issues.length, 2);
});

test('an Emby playback deletion only removes the reconciled Jellyfin migration key', async t => {
  const fixture = await exchangeFixture(t);
  const { emby, jellyfin, readEmby, readJellyfin, applyToJellyfin } = fixture;
  const user = exchangeId(90), [plain, multiple, hiddenEdit, replaced, nativeKey] = [10, 20, 30, 40, 50].map(exchangeId);
  const canonical = id => id.replaceAll('-', '');
  emby.prepare('INSERT INTO accounts.LocalUsersv2 VALUES(1,?,?)').run(toBlob(user), '{"Name":"Reader"}');
  for (const number of [10, 20, 30, 40, 50]) {
    emby.prepare('INSERT INTO MediaItems(Id,guid,type,Name,UserDataKeyId) VALUES(?,?,5,?,?)')
      .run(number, toBlob(exchangeId(number)), 'Movie ' + number, number);
    emby.prepare('INSERT INTO UserDatas(UserDataKeyId,userId,LastPlayedDateInt,PlayCount,PlaybackPositionTicks) VALUES(?,1,1000,1,0)')
      .run(number);
  }
  const beforeSource = readEmby();
  await applyToJellyfin(beforeSource, readJellyfin());
  const getOriginal = jellyfin.prepare('SELECT * FROM UserData WHERE ItemId=? AND UserId=?');
  jellyfin.prepare('UPDATE UserData SET CustomDataKey=? WHERE ItemId=?').run(nativeKey, nativeKey);
  insert(jellyfin, 'UserData', { ...getOriginal.get(multiple, user), CustomDataKey: 'other-edition', LastPlayedDate: null });
  insert(jellyfin, 'UserData', { ...getOriginal.get(hiddenEdit, user), CustomDataKey: 'primary-edition', LastPlayedDate: '2000-01-01 00:00:00' });
  const beforeTarget = readJellyfin();
  jellyfin.prepare('UPDATE UserData SET PlaybackPositionTicks=987654321 WHERE ItemId=? AND CustomDataKey=?')
    .run(multiple, 'other-edition');
  jellyfin.prepare('UPDATE UserData SET PlaybackPositionTicks=12345 WHERE ItemId=? AND CustomDataKey=?')
    .run(hiddenEdit, canonical(hiddenEdit));
  jellyfin.prepare('UPDATE UserData SET CustomDataKey=? WHERE ItemId=? AND CustomDataKey=?')
    .run('replacement-edition', replaced, canonical(replaced));
  const current = readJellyfin();
  for (const id of [plain, multiple, hiddenEdit, replaced, nativeKey])
    assert.deepEqual(current.rows.get(`play/${id}/${user}`), beforeTarget.rows.get(`play/${id}/${user}`));
  emby.exec('DELETE FROM UserDatas');
  await applyToJellyfin(readEmby(), current, beforeSource.rows, beforeTarget.rows);
  fixture.closeJellyfin();
  const cold = new DatabaseSync(fixture.filename, { readOnly: true });
  try {
    const stored = cold.prepare('SELECT ItemId,CustomDataKey,PlaybackPositionTicks FROM UserData WHERE UserId=? ORDER BY ItemId,CustomDataKey');
    assert.deepEqual(stored.all(user).map(row => [row.ItemId, row.CustomDataKey, row.PlaybackPositionTicks]), [
      [multiple, 'other-edition', 987654321],
      [hiddenEdit, canonical(hiddenEdit), 12345],
      [hiddenEdit, 'primary-edition', 0],
      [replaced, 'replacement-edition', 0],
    ]);
  } finally { cold.close(); }
  assert.ok(fixture.issues.some(([kind, entity, key, field]) =>
    kind === 'conflict' && entity === 'play' && key === `play/${multiple}/${user}` && field === 'deletion'));
});

test('Emby box sets retain their own member order in both exchange directions', async t => {
  const { emby, jellyfin, directory, readEmby, readJellyfin, applyToJellyfin, report } = await exchangeFixture(t);
  const [a, b, boxA, boxB] = [10, 20, 30, 40].map(exchangeId);
  const put = emby.prepare('INSERT INTO MediaItems(Id,guid,type,Name) VALUES(?,?,?,?)');
  for (const number of [10, 20, 30, 40]) put.run(number, toBlob(exchangeId(number)), number < 30 ? 5 : 9, 'Item ' + number);
  emby.exec('INSERT INTO ItemLinks2 VALUES(20,6,30,0),(10,6,30,1),(10,6,40,0),(20,6,40,1)');
  const members = (catalog, id) => catalog.rows.get('item/' + id).Members;
  const original = readEmby();
  await applyToJellyfin(original, readJellyfin());
  const imported = readJellyfin();
  assert.deepEqual(members(imported, boxA), [b, a]);
  assert.deepEqual(members(imported, boxB), [a, b]);

  jellyfin.exec('UPDATE LinkedChildren SET SortOrder=SortOrder+2; UPDATE LinkedChildren SET SortOrder=3-SortOrder');
  const edited = readJellyfin();
  const changes = changesBetween(edited.rows, original.rows, imported.rows, original.rows, report, { sourceType: 'jellyfin' });
  await writeEmby(emby, changes, original, edited, report, directory);
  const returned = readEmby();
  assert.deepEqual(members(returned, boxA), [a, b]);
  assert.deepEqual(members(returned, boxB), [b, a]);
  assert.deepEqual(emby.prepare('SELECT ItemId FROM ItemLinks2 WHERE LinkedId=40 AND Type=6 ORDER BY LinkOrder')
    .all().map(row => row.ItemId), [20, 10]);
});

test('an Emby season name change reaches mapped episodes and their detail DTO after reopening', async t => {
  const fixture = await exchangeFixture(t);
  const { emby, readEmby, readJellyfin, applyToJellyfin } = fixture;
  const put = emby.prepare('INSERT INTO MediaItems(Id,guid,type,Name,ParentId,SeriesId,IndexNumber,ParentIndexNumber) VALUES(?,?,?,?,?,?,?,?)');
  for (const [id, type, name, parent, series, index, season] of [
    [10, 6, 'Series', null, null, null, null],
    [20, 7, 'Season One', 10, 10, 1, null], [30, 7, 'Season Two', 10, 10, 2, null],
    [40, 8, 'Episode One', 20, 10, 1, 1], [50, 8, 'Episode Two', 10, 10, 2, 1], [60, 8, 'Episode Three', 30, 10, 1, 2],
  ]) put.run(id, toBlob(exchangeId(id)), type, name, parent, series, index, season);
  const original = readEmby();
  await applyToJellyfin(original, readJellyfin());
  const imported = readJellyfin();
  const getEpisode = fixture.jellyfin.prepare('SELECT SeasonId,SeasonName FROM BaseItems WHERE Id=?');
  assert.deepEqual({ ...getEpisode.get(exchangeId(40)) }, { SeasonId: exchangeId(20), SeasonName: 'Season One' });
  assert.deepEqual({ ...getEpisode.get(exchangeId(50)) }, { SeasonId: exchangeId(20), SeasonName: 'Season One' });
  emby.exec("UPDATE MediaItems SET Name='Renamed Season' WHERE Id=20");
  await applyToJellyfin(readEmby(), imported, original.rows, imported.rows);
  fixture.closeJellyfin();

  const cold = new SqliteDatabase(fixture.filename, { readOnly: true });
  try {
    for (const [id, season, name] of [[40, 20, 'Renamed Season'], [50, 20, 'Renamed Season'], [60, 30, 'Season Two']]) {
      const [row] = cold.rows('BaseItems', { where: { Id: exchangeId(id) } });
      assert.equal(row.SeasonId, exchangeId(season));
      assert.equal(row.SeasonName, name);
      const dto = await projectItem(mapRecord(row), { byId: new Map() }, null, dtoOptions({ enableimages: false }), {});
      assert.equal(dto.SeasonName, name);
      assert.equal(dto.SeasonId, exchangeId(season).replaceAll('-', ''));
    }
  } finally { cold.close(); }
});

test('Emby seasons and episodes with a confirmed series inherit a missing grouping key on import and reimport', async t => {
  const { emby, jellyfin, filename, closeJellyfin, readEmby, readJellyfin, applyToJellyfin } = await exchangeFixture(t);
  const add = emby.prepare(`INSERT INTO MediaItems
    (Id,guid,type,Name,ParentId,SeriesId,IndexNumber,PresentationUniqueKey,SeriesPresentationUniqueKey)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  for (const [number, type, parent, series, index, key, seriesKey] of [
    [10, 6, null, null, null, 'series-a', null],
    [20, 7, 10, 10, 1, 'series-a-001', null],
    [30, 8, 20, 10, 1, 'episode-a', null],
    [40, 8, 20, 10, 2, 'episode-b', 'existing-key'],
    [50, 8, null, 20, 3, 'episode-c', null],
  ]) add.run(number, toBlob(exchangeId(number)), type, `Item ${number}`, parent, series, index, key, seriesKey);
  const source = readEmby();
  await applyToJellyfin(source, readJellyfin());
  const imported = readJellyfin();
  const groupKey = id => imported.rows.get('item/' + exchangeId(id)).SeriesPresentationUniqueKey;
  assert.equal(groupKey(20), 'series-a');
  assert.equal(groupKey(30), 'series-a');
  assert.equal(groupKey(40), 'existing-key');
  assert.equal(groupKey(50), null);

  // Reproduce an earlier import and a populated key edited on the target.
  const set = jellyfin.prepare('UPDATE BaseItems SET SeriesPresentationUniqueKey=? WHERE Id=?');
  set.run(null, exchangeId(20));
  set.run('target-key', exchangeId(30));
  const previous = readJellyfin();
  await applyToJellyfin(source, previous, source.rows, previous.rows);
  closeJellyfin();
  const cold = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.deepEqual(cold.prepare('SELECT Id,SeriesPresentationUniqueKey FROM BaseItems WHERE SeriesId IS NOT NULL ORDER BY Id')
      .all().map(row => [row.Id, row.SeriesPresentationUniqueKey]), [
      [exchangeId(20), 'series-a'], [exchangeId(30), 'target-key'],
      [exchangeId(40), 'existing-key'], [exchangeId(50), null],
    ]);
  } finally { cold.close(); }
});

test('an Emby episode that moves to a different series is listed under its new series after exchange', { skip: !postgresTestConnectionString }, async t => {
  const fixture = await exchangeFixture(t);
  const put = fixture.emby.prepare(`INSERT INTO MediaItems
    (Id,guid,type,Name,ParentId,SeriesId,IndexNumber,ParentIndexNumber,PresentationUniqueKey)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const [id, type, parent, series, index, season, key] of [
    [10, 6, null, null, null, null, 'series-a'], [11, 7, 10, 10, 1, null, 'season-a'],
    [20, 6, null, null, null, null, 'series-b'], [21, 7, 20, 20, 1, null, 'season-b'],
    [30, 8, 11, 10, 1, 1, 'episode'], [31, 8, 11, 10, 2, 1, 'target-edited'], [32, 8, 11, 10, 3, 1, 'target-cleared'],
  ]) put.run(id, toBlob(exchangeId(id)), type, key, parent, series, index, season, key);
  const first = await exchange({ direction: 'import', source: await stoppedEmby(fixture), output: path.join(fixture.directory, 'first') });
  const readEpisode = instance => withCatalog(instance, 'jellyfin', db => ({ ...db.prepare(
    'SELECT SeriesId,SeasonId,SeriesPresentationUniqueKey FROM BaseItems WHERE Id=?').get(exchangeId(30)) }));
  assert.equal(readEpisode(first.output).SeriesPresentationUniqueKey, 'series-a');
  const outbound = await exchange({ direction: 'export', source: first.output, output: path.join(fixture.directory, 'outbound') });
  withCatalog(outbound.output, 'emby', db => {
    assert.equal(db.prepare('SELECT SeriesPresentationUniqueKey FROM MediaItems WHERE Id=30').get().SeriesPresentationUniqueKey, null);
    db.exec('UPDATE MediaItems SET ParentId=21, SeriesId=20 WHERE Id IN (30,31,32)');
  });
  withCatalog(first.output, 'jellyfin', db => {
    const edit = db.prepare('UPDATE BaseItems SET SeriesPresentationUniqueKey=? WHERE Id=?');
    edit.run('target-only', exchangeId(31));
    edit.run(null, exchangeId(32));
  });
  const moved = await exchange({ direction: 'import', source: outbound.output, template: first.output, output: path.join(fixture.directory, 'moved') });
  const stored = readEpisode(moved.output);
  assert.equal(stored.SeriesId, exchangeId(20));
  assert.equal(stored.SeasonId, exchangeId(21));
  assert.equal(stored.SeriesPresentationUniqueKey, 'series-b');
  withCatalog(moved.output, 'jellyfin', db => {
    const group = db.prepare('SELECT SeriesPresentationUniqueKey FROM BaseItems WHERE Id=?');
    assert.equal(group.get(exchangeId(31)).SeriesPresentationUniqueKey, 'target-only');
    assert.equal(group.get(exchangeId(32)).SeriesPresentationUniqueKey, null);
  });
  const database = await createPostgresTestDatabase(t, 'moved_episode');
  const sqlite = new SqliteDatabase(path.join(moved.output, 'data', 'data', 'jellyfin.db'), { readOnly: true });
  try {
    await transferDatabase(sqlite, database, { instanceBinding: { serverId: exchangeId(1).replaceAll('-', ''), originIdentityDigest: 'a'.repeat(64) } });
  } finally { sqlite.close(); }
  const forSeries = async seriesKey => (await database.withConnection(db => queryPostgresSeriesEpisodePage(db, { seriesKey }))).rows.map(row => row.Id);
  const listing = { oldSeries: await forSeries('series-a'), newSeries: await forSeries('series-b') };
  assert.deepEqual(listing, { oldSeries: [], newSeries: [exchangeId(30)] });
});

test('Emby search history imports into PostgreSQL and round-trips a Node mark and clear through SQLite', {
  skip: !postgresTestConnectionString, timeout: 60000,
}, async t => {
  const fixture = await exchangeFixture(t);
  const { emby, readEmby, readJellyfin, report, directory, applyToJellyfin } = fixture;
  const user = exchangeId(90), [first, second] = [10, 20].map(exchangeId);
  emby.exec('ALTER TABLE UserDatas ADD COLUMN DateLastSearchedInt INTEGER');
  emby.prepare('INSERT INTO accounts.LocalUsersv2 VALUES(1,?,?)').run(toBlob(user), '{"Name":"Reader"}');
  const putItem = emby.prepare('INSERT INTO MediaItems(Id,guid,type,Name,UserDataKeyId) VALUES(?,?,5,?,?)');
  putItem.run(10, toBlob(first), 'Previously searched', 10);
  putItem.run(20, toBlob(second), 'Search only', 20);
  emby.exec(`INSERT INTO UserDatas(UserDataKeyId,userId,LastPlayedDateInt,PlayCount,PlaybackPositionTicks,
    DateLastSearchedInt,RatingLastModified,PlaystateLastModified) VALUES(10,1,1000,7,9007199254740993,2000,111,222)`);
  const original = readEmby();
  await applyToJellyfin(original, readJellyfin(), new Map(), new Map(), { adminUser: 'Reader', adminPassword: 'isolated-search-user' });
  const imported = readJellyfin();
  fixture.closeJellyfin();

  const database = await createPostgresTestDatabase(null, 'emby_history_exchange');
  let runtime;
  t.after(async () => { try { await runtime?.close(); } finally { await dropPostgresTestDatabase(database); } });
  const source = new SqliteDatabase(fixture.filename, { readOnly: true });
  const serverId = user.replaceAll('-', '');
  try { await transferDatabase(source, database, { instanceBinding: { serverId, originIdentityDigest: 'a'.repeat(64) } }); }
  finally { source.close(); }
  runtime = await createTestRuntime({ database, programDataPath: path.join(directory, 'program'),
    serverId, configuration: { ...defaultConfiguration('server'), IsStartupWizardCompleted: true } });
  const token = (await runtime.apiKeys.create('Search exchange')).AccessToken;
  const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}`;
  const request = (route, options = {}) => fetch(origin + '/emby/Users/' + user + route, { ...options, signal: t.signal,
    headers: { Authorization: `Emby Client="Emby Web", Token="${token}"`, 'Content-Type': 'application/json' } });
  const search = async () => {
    const response = await request(`/Items?Ids=${first},${second}&WasSearched=true&Recursive=true&SortBy=DateLastSearched`);
    assert.equal(response.status, 200);
    return (await response.json()).Items.map(row => row.Id);
  };
  const readHistory = async ItemId => (await database.rows('CustomItemDisplayPreferences',
    { where: { UserId: user, ItemId, Client: searchHistoryClient, Key: searchHistoryKey } }))[0]?.Value;
  const exportHistory = async (phase, beforeSource, beforeTarget) => {
    const filename = path.join(directory, phase + '.db');
    await exportCurrentSqlite(database, filename, { testOnlyAllowSyntheticEnvelope: true });
    const sqlite = new DatabaseSync(filename, { readOnly: true });
    let view;
    try { view = jellyfinCatalog(sqlite, report); } finally { sqlite.close(); }
    const target = readEmby();
    const changes = changesBetween(view.rows, target.rows, beforeSource.rows, beforeTarget.rows, report, { sourceType: 'jellyfin' });
    await writeEmby(emby, changes.filter(change => change.key.startsWith('search/')), target, view, report, directory);
    return view;
  };
  assert.equal(await readHistory(first), '2000');
  assert.deepEqual(await search(), [first.replaceAll('-', '')]);
  const mark = await request('/SearchedItems', { method: 'POST', body: JSON.stringify({ Ids: [first, second] }) });
  assert.equal(mark.status, 204);
  const marked = [await readHistory(first), await readHistory(second)];
  assert.ok(marked.every(value => BigInt(value) > 2000n));
  const markedView = await exportHistory('marked', imported, original);
  const markedEmby = readEmby();
  const nativeHistory = emby.prepare('SELECT DateLastSearchedInt FROM UserDatas ORDER BY UserDataKeyId');
  nativeHistory.setReadBigInts(true);
  assert.deepEqual(nativeHistory.all().map(row => row.DateLastSearchedInt), marked.map(BigInt));
  const playback = emby.prepare('SELECT PlayCount,PlaybackPositionTicks,RatingLastModified,PlaystateLastModified FROM UserDatas WHERE UserDataKeyId=10');
  playback.setReadBigInts(true);
  const originalPlayback = { PlayCount: 7n, PlaybackPositionTicks: 9007199254740993n, RatingLastModified: 111n, PlaystateLastModified: 222n };
  assert.deepEqual({ ...playback.get() }, originalPlayback);

  assert.equal((await request('/RecentlySearched/Delete', { method: 'POST' })).status, 204);
  assert.deepEqual(await search(), []);
  await exportHistory('cleared', markedView, markedEmby);
  assert.deepEqual(nativeHistory.all().map(row => row.DateLastSearchedInt), [null, null]);
  assert.deepEqual({ ...playback.get() }, originalPlayback);
});

test('a legacy Emby catalog without a search column preserves the existing search history on either side of reconciliation', async t => {
  const { emby, readEmby, readJellyfin, report, directory, applyToJellyfin, issues } = await exchangeFixture(t);
  const item = exchangeId(10), user = exchangeId(90), key = `search/${item}/${user}`;
  emby.exec('ALTER TABLE UserDatas ADD COLUMN DateLastSearchedInt INTEGER');
  emby.prepare('INSERT INTO accounts.LocalUsersv2 VALUES(1,?,?)').run(toBlob(user), '{"Name":"Reader"}');
  emby.prepare('INSERT INTO MediaItems(Id,guid,type,Name,UserDataKeyId) VALUES(10,?,5,\'Movie\',10)').run(toBlob(item));
  emby.exec('INSERT INTO UserDatas(UserDataKeyId,userId,PlayCount,PlaybackPositionTicks,DateLastSearchedInt) VALUES(10,1,7,0,2000)');
  const newer = readEmby();
  await applyToJellyfin(newer, readJellyfin());
  const jellyfin = readJellyfin();
  emby.exec('ALTER TABLE UserDatas DROP COLUMN DateLastSearchedInt');
  const legacy = readEmby();
  assert.equal(legacy.hasDateLastSearched, false);
  assert.equal(legacy.rows.has(key), false);
  await applyToJellyfin(legacy, jellyfin, newer.rows, jellyfin.rows);
  assert.deepEqual(readJellyfin().rows.get(key), { DateLastSearched: '2000' });
  const changes = changesBetween(jellyfin.rows, legacy.rows, new Map(), legacy.rows, report, { sourceType: 'jellyfin' });
  await writeEmby(emby, changes.filter(change => change.key === key), legacy, jellyfin, report, directory);
  assert.ok(issues.some(([status, kind, id, field]) => status === 'origin-only' && kind === 'search' && id === key && field === searchHistoryKey));
  assert.equal(emby.prepare('SELECT PlayCount FROM UserDatas').get().PlayCount, 7);
});

test('a shared Emby search key preserves conflicting history and clears independently of playback', async t => {
  const { emby, readEmby, report, issues, directory } = await exchangeFixture(t);
  const [left, right, user] = [10, 20, 90].map(exchangeId);
  emby.exec('ALTER TABLE UserDatas ADD COLUMN DateLastSearchedInt INTEGER');
  emby.prepare('INSERT INTO accounts.LocalUsersv2 VALUES(1,?,?)').run(toBlob(user), '{"Name":"Reader"}');
  const put = emby.prepare("INSERT INTO MediaItems(Id,guid,type,Name,UserDataKeyId) VALUES(?,?,5,'Movie',13)");
  put.run(10, toBlob(left)); put.run(20, toBlob(right));
  emby.exec('INSERT INTO UserDatas(UserDataKeyId,userId,PlayCount,PlaybackPositionTicks,DateLastSearchedInt) VALUES(13,1,7,0,2000)');
  const keyLeft = `search/${left}/${user}`, keyRight = `search/${right}/${user}`;
  const target = readEmby(), date = '9007199254740993';
  const next = new Map([[keyLeft, { DateLastSearched: date }], [keyRight, target.rows.get(keyRight)]]);
  const reconcile = async (catalog, rows) => {
    const changes = changesBetween(rows, catalog.rows, catalog.rows, catalog.rows, report, { sourceType: 'jellyfin' })
      .filter(change => change.key.startsWith('search/'));
    await writeEmby(emby, changes, catalog, { rows }, report, directory);
  };
  const row = emby.prepare('SELECT DateLastSearchedInt,PlayCount FROM UserDatas'); row.setReadBigInts(true);
  await reconcile(target, next);
  assert.deepEqual({ ...row.get() }, { DateLastSearchedInt: 2000n, PlayCount: 7n });
  assert.ok(issues.some(([status, kind, key]) => status === 'conflict' && kind === 'search' && key === keyLeft));
  next.set(keyRight, next.get(keyLeft));
  await reconcile(target, next);
  assert.deepEqual({ ...row.get() }, { DateLastSearchedInt: BigInt(date), PlayCount: 7n });
  await reconcile(readEmby(), new Map());
  assert.deepEqual({ ...row.get() }, { DateLastSearchedInt: null, PlayCount: 7n });
});

function markerFixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE Chapters3(ItemId INTEGER,ChapterIndex INTEGER,StartPositionTicks INTEGER,Name TEXT,
      ImagePath TEXT,ImageDateModified INTEGER,MarkerType INTEGER,PRIMARY KEY(ItemId,ChapterIndex));
    CREATE TABLE MediaSegments(Id TEXT PRIMARY KEY,ItemId TEXT,Type INTEGER,StartTicks INTEGER,EndTicks INTEGER,SegmentProviderId TEXT);
    CREATE TABLE ItemExtradataTypes(ExtradataTypeId INTEGER,Name TEXT);
    CREATE TABLE ItemExtradata(ItemId INTEGER,ExtradataTypeId INTEGER);
    INSERT INTO ItemExtradataTypes VALUES(7,'IntroDetectionExtradata'),(8,'Other');
    INSERT INTO ItemExtradata VALUES(1,7),(1,8);
  `);
  const issues = [], report = (...issue) => issues.push(issue);
  const read = (type, runtime) => {
    const item = { RunTimeTicks: runtime, IntroSkip: null, CreditsSkip: null };
    readMarkers(db, type, new Map([[type === 'emby' ? 1n : 'movie', item]]), () => 'movie', report);
    return item;
  };
  return { db, read, issues, report };
}

test('typed intro boundaries preserve exact ticks, native identity, ordinary chapters and private marker metadata', t => {
  const { db, read, report } = markerFixture(t);
  const end = 9007199254740993n, runtime = String(end + 100n);
  db.exec("INSERT INTO Chapters3 VALUES(1,0,0,'Chapter',NULL,NULL,NULL),(1,1,0,'Opening','poster',123,1),(1,16,9007199254740993,'Cut',NULL,NULL,2)");
  const original = read('emby', runtime);
  assert.deepEqual(original.IntroSkip, { StartTicks: '0', EndTicks: String(end) });
  writeMarker(db, 'jellyfin', 'movie', 'id', 'IntroSkip', original.IntroSkip, null, runtime, report);
  const inserted = db.prepare('SELECT Id,SegmentProviderId FROM MediaSegments').get();
  assert.equal(inserted.SegmentProviderId, markerProviderId);
  db.prepare("UPDATE MediaSegments SET EndTicks=?,SegmentProviderId='existing provider'").run(end - 4n);
  const edited = read('jellyfin', runtime);
  writeMarker(db, 'emby', 1, 'id', 'IntroSkip', edited.IntroSkip, original, runtime, report);
  assert.deepEqual(read('emby', runtime).IntroSkip, edited.IntroSkip);
  reserveChapterIndexes(db, 1, [{ ChapterIndex: 0 }, { ChapterIndex: 1 }]);
  const point = db.prepare('SELECT * FROM Chapters3 WHERE MarkerType=1').get();
  assert.deepEqual([point.Name, point.ImagePath, point.ImageDateModified], ['Opening', 'poster', 123]);
  assert.notEqual(point.ChapterIndex, 1);
  assert.equal(db.prepare('SELECT ExtradataTypeId FROM ItemExtradata').get().ExtradataTypeId, 8);
  writeMarker(db, 'jellyfin', 'movie', 'id', 'IntroSkip', original.IntroSkip, edited, runtime, report);
  assert.deepEqual({ ...db.prepare('SELECT Id,SegmentProviderId FROM MediaSegments').get() },
    { Id: inserted.Id, SegmentProviderId: 'existing provider' });
  writeMarker(db, 'emby', 1, 'id', 'IntroSkip', null, edited, runtime, report);
  assert.deepEqual(db.prepare('SELECT Name FROM Chapters3').all().map(r => r.Name), ['Chapter']);
});

test('a sole credits start has no known end; only an explicit policy or an existing native tail provides one', t => {
  const { db, read, issues, report } = markerFixture(t);
  db.exec("INSERT INTO Chapters3 VALUES(1,10,70,'Credits Start',NULL,NULL,3)");
  const start = read('emby', null).CreditsSkip;
  assert.deepEqual(start, { StartTicks: '70', EndTicks: null });
  const write = (runtime, policy) => writeMarker(db, 'jellyfin', 'movie', 'id', 'CreditsSkip', start,
    read('jellyfin', runtime), runtime, report, policy);
  write('100');
  write(null, 'runtime');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM MediaSegments').get().n, 0);
  assert.equal(issues.at(-1)[0], 'origin-only');
  write('100', 'runtime');
  assert.equal(issues.at(-1)[0], 'inferred');
  db.exec("UPDATE MediaSegments SET StartTicks=82");
  write('100');
  assert.deepEqual(read('jellyfin', '100').CreditsSkip, { StartTicks: '70', EndTicks: '100' });
  db.exec("UPDATE MediaSegments SET EndTicks=87");
  write('100', 'runtime');
  assert.equal(issues.at(-1)[0], 'conflict');
  assert.equal(db.prepare('SELECT EndTicks FROM MediaSegments').get().EndTicks, 87);
  assert.equal(Object.hasOwn(read('jellyfin', '100'), 'CreditsSkip'), false);
});

test('incomplete, repeated and future marker types never overwrite existing intervals', t => {
  const { db, read, issues, report } = markerFixture(t);
  db.exec("INSERT INTO Chapters3 VALUES(1,1,20,NULL,NULL,NULL,1),(1,2,50,NULL,NULL,NULL,3),(1,3,62,NULL,NULL,NULL,9)");
  assert.equal(Object.hasOwn(read('emby', '80'), 'IntroSkip'), false);
  assert.equal(Object.hasOwn(read('emby', '80'), 'CreditsSkip'), false);
  db.exec("INSERT INTO Chapters3 VALUES(1,4,9,NULL,NULL,NULL,2)");
  assert.equal(Object.hasOwn(read('emby', '80'), 'IntroSkip'), false);
  db.exec("UPDATE Chapters3 SET StartPositionTicks=24 WHERE MarkerType=2; INSERT INTO Chapters3 VALUES(1,5,22,NULL,NULL,NULL,2)");
  assert.equal(Object.hasOwn(read('emby', '80'), 'IntroSkip'), false);
  db.exec("INSERT INTO MediaSegments VALUES('1','movie',5,1,5,'a'),('2','movie',5,1,5,'b'),('3','movie',3,0,1,'a')");
  const target = read('jellyfin', '80');
  writeMarker(db, 'jellyfin', 'movie', 'id', 'IntroSkip', null, target, '80', report);
  assert.equal(issues.at(-1)[0], 'conflict');
  assert.deepEqual(db.prepare('SELECT Id FROM MediaSegments ORDER BY Id').all().map(r => r.Id), ['1', '2', '3']);
  assert.ok(issues.some(issue => issue[3] === 'MediaSegments.Type' && issue[4] === '3'));
});

test('marker reconciliation distinguishes a first import, ambiguous points, independent edits and legacy ordinary chapters', () => {
  const m = row => new Map(row ? [['item/id', row]] : []);
  const a = { StartTicks: '1', EndTicks: '5' }, b = { ...a, EndTicks: '7' }, c = { ...a, EndTicks: '9' };
  const issues = [], plan = (s, t, oldS, oldT) =>
    changesBetween(m(s), m(t), m(oldS), m(oldT), (...i) => issues.push(i), { legacyChapters: true });
  assert.deepEqual(plan({ IntroSkip: a }, { IntroSkip: null }, {}, {})[0].fields, ['IntroSkip']);
  assert.deepEqual(plan({ IntroSkip: null }, { IntroSkip: a }, {}, {}), []);
  assert.deepEqual(plan({}, { IntroSkip: a }, { IntroSkip: a }, { IntroSkip: a }), []);
  assert.deepEqual(plan({ IntroSkip: null }, { IntroSkip: a }, { IntroSkip: a }, { IntroSkip: a })[0].fields, ['IntroSkip']);
  assert.deepEqual(plan({ IntroSkip: b }, { IntroSkip: c }, { IntroSkip: a }, { IntroSkip: a }), []);
  assert.equal(issues.at(-1)[0], 'conflict');
  const old = [{ Name: 'Custom', ChapterIndex: 1 }], after = [{ ...old[0], ImageDateModified: null }];
  assert.deepEqual(plan({ Chapters: after }, { Chapters: [] }, { Chapters: old }, { Chapters: old }), []);
});

test('each side has its own baseline; divergent edits and deletion keep the target', () => {
  const map = (row) => new Map(row ? [['item/id', row]] : []),
    reports = [];
  const source = { Name: 'original', Length: '9007199254740993' },
    target = { Name: 'source name rounded', Length: '200' };
  const plan = (a, b) =>
    changesBetween(map(a), map(b), map(source), map(target), (...args) => reports.push(args));
  assert.deepEqual(plan(source, { ...target, Name: 'edited B' }), []);
  assert.deepEqual(plan({ ...source, Length: '9007199254740995' }, { ...target, Name: 'edited B' })[0].fields, [
    'Length',
  ]);
  assert.deepEqual(plan({ ...source, Name: 'edited A' }, { ...target, Name: 'edited B' }), []);
  assert.equal(reports.at(-1)[3], 'Name');
  assert.deepEqual(plan(null, { ...target, Name: 'edited B' }), []);
  assert.equal(reports.at(-1)[3], 'deletion');
  assert.deepEqual(plan(null, target), [{ key: 'item/id', value: null, fields: [] }]);
});
test('editing a media container preserves unknown 64-bit values and duplicate JSON keys', () => {
  const original = '{"Unknown":90071992547409935, "X":1,"X":2, "Container":"old" }';
  assert.equal(
    editObjectFields(original, { Container: 'wav', IndexNumberEnd: 2 }),
    original.replace('"old"', '"wav"').replace('}', ',"IndexNumberEnd":2}'),
  );
});

test('both stream projections translate native kinds by meaning and preserve unknown or occupied indexes', () => {
  const records = streams => streams && new Map([['item/movie', { Streams: streams }]]);
  const stream = (index, type, title) => ({ StreamIndex: index, StreamType: type, Title: title });
  const read = (sourceType, input, target, beforeSource, beforeTarget) => {
    const issues = [];
    const result = changesBetween(records(input), records(target) ?? new Map(), records(beforeSource) ?? new Map(),
      records(beforeTarget) ?? new Map(), (...args) => issues.push(args), { sourceType });
    return { streams: result[0]?.value.Streams, issues: issues.map(i => [i[0], i[3]]) };
  };
  const jellyfin = [0, 1, 2, 3, 4].map((kind, i) => stream(i, kind, String(i)));
  const emby = [1, 2, 3, 4, 6].map((kind, i) => stream(i, kind, String(i)));
  assert.deepEqual(read('emby', emby), { streams: jellyfin, issues: [] });
  assert.deepEqual(read('jellyfin', jellyfin), { streams: emby, issues: [] });
  const attachment = stream(5, 5, 'font'), unknown = stream(6, 0, 'unknown'), future = stream(7, 17, 'future');
  for (const row of [attachment, unknown, future]) {
    assert.deepEqual(read('emby', [...emby, row]), { streams: jellyfin, issues: [['origin-only', 'Streams']] });
  }
  const lyric = stream(5, 5, 'lyrics');
  assert.deepEqual(read('jellyfin', [...jellyfin, lyric]), { streams: emby, issues: [['origin-only', 'Streams']] });
  const target = [attachment, future];
  assert.deepEqual(read('jellyfin', [stream(5, 0, 'song'), stream(8, 1, 'video')], target, [], target),
    { streams: [...target, stream(8, 2, 'video')], issues: [['conflict', 'Streams']] });

  // A pre-fix receipt copied Emby's video ordinal 2 into a Jellyfin subtitle slot.
  const wrong = [stream(0, 2, 'old')];
  assert.deepEqual(read('jellyfin', [stream(0, 2, 'edited')], wrong, wrong, wrong),
    { streams: undefined, issues: [['conflict', 'Streams']] });
  assert.deepEqual(read('jellyfin', [stream(0, 1, 'corrected')], wrong, wrong, wrong),
    { streams: [stream(0, 2, 'corrected')], issues: [] });
  assert.deepEqual(read('emby', emby, jellyfin, emby, jellyfin), { streams: undefined, issues: [] });
});
test('native .NET GUIDs use mixed endian fields', () => {
  const guid = '00112233-4455-6677-8899-AABBCCDDEEFF';
  assert.equal(toBlob(guid).toString('hex'), '33221100554477668899aabbccddeeff');
  assert.equal(fromBlob(toBlob(guid), 'unused'), guid);
});
test('an explicitly paired account can have different native login names at the two endpoints', () => {
  const source = new Map([['user/u', { Username: 'runner' }]]),
    target = new Map([['user/t', { Username: 'bridge' }]]);
  const map = { items: {}, users: { u: 't' } };
  assert.equal(translatedRows(source, map, target, true).get('user/t').Username, 'bridge');
  assert.equal(translatedRows(source, map, target, false).get('user/t').Username, 'runner');
});
test('a shared Emby playback key accepts agreed fields, preserves divergent progress, and deletes only after both items clear it', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(
    'CREATE TABLE MediaItems(Id INTEGER PRIMARY KEY,UserDataKeyId INTEGER); INSERT INTO MediaItems VALUES(1,13),(2,13); CREATE TABLE UserDatas(UserDataKeyId INTEGER,userId INTEGER,Played INTEGER,PlayCount INTEGER,IsFavorite INTEGER,PlaystateLastModified INTEGER,RatingLastModified INTEGER); INSERT INTO UserDatas VALUES(13,3,0,7,0,0,0)',
  );
  const catalog = {
    items: new Map([
      ['a', { Id: 1 }],
      ['b', { Id: 2 }],
    ]),
    users: new Map([['u', { Id: 3 }]]),
    shared: new Map([[13n, ['a', 'b']]]),
  };
  const left = 'play/a/u',
    right = 'play/b/u';
  const a = { IsFavorite: 1, PlayCount: 9 },
    b = { IsFavorite: 1, PlayCount: 11 };
  const source = {
      rows: new Map([
        [left, a],
        [right, b],
      ]),
    },
    report = [];
  const apply = (changes) => writeEmby(db, changes, catalog, source, (...e) => report.push(e));
  await apply([
    { key: left, value: a, fields: ['IsFavorite', 'PlayCount'] },
    { key: right, value: b, fields: ['IsFavorite', 'PlayCount'] },
  ]);
  assert.deepEqual(
    { ...db.prepare('SELECT IsFavorite,PlayCount FROM UserDatas').get() },
    { IsFavorite: 1, PlayCount: 7 },
  );
  assert.equal(report.length, 1);
  assert.equal(report[0][3], 'PlayCount');
  source.rows.delete(left);
  await apply([{ key: left, value: null, fields: [] }]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM UserDatas').get().n, 1);
  source.rows.delete(right);
  await apply([
    { key: left, value: null, fields: [] },
    { key: right, value: null, fields: [] },
  ]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM UserDatas').get().n, 0);
});
test('a stopped Emby custom metadata base and foreign sidecar paths become portable while preserving edits on both sides', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mm-asset-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const instance = path.join(root, 'source'),
    external = path.join(root, 'external'),
    physical = path.join(root, 'sidecars');
  await mkdir(path.join(instance, 'config'), { recursive: true });
  await mkdir(path.join(external, 'metadata'), { recursive: true });
  await mkdir(physical);
  const xml =
    '<ServerConfiguration><MetadataPath>' +
    external.replaceAll('&', '&amp;') +
    '</MetadataPath></ServerConfiguration>';
  await writeFile(path.join(instance, 'config', 'system.xml'), xml);
  await writeFile(path.join(external, 'metadata', 'poster.jpg'), 'first');
  await writeFile(path.join(physical, 'scene.en.srt'), 'captions');
  await writeFile(path.join(physical, 'scene.mkv'), 'media');
  const issues = [];
  const assets = await collectAssets({
    instance,
    original: instance,
    type: 'emby',
    stage: path.join(root, 'capture'),
    roots: [{ id: 'library', identityRoot: 'Z:\\Movies', directory: physical }],
    report: (...e) => issues.push(e),
  });
  assert.equal(await readFile(path.join(assets.directory, 'poster.jpg'), 'utf8'), 'first');
  await assert.rejects(readFile(path.join(assets.directory, 'migration-assets/library/scene.mkv')), {
    code: 'ENOENT',
  });
  const row = {
    Images: [{ Path: path.join(external, 'metadata', 'poster.jpg') }],
    Chapters: [],
    Streams: [{ Path: 'Z:\\Movies\\scene.en.srt', IsExternal: 1 }],
  };
  const result = await projectAssetRows(new Map([['item/id', row]]), assets, (...e) => issues.push(e));
  const value = result.rows.get('item/id');
  assert.equal(value.Images[0].Path, '%MetadataPath%' + path.sep + 'poster.jpg');
  assert.equal(
    value.Streams[0].Path,
    ['%MetadataPath%', 'migration-assets', 'library', 'scene.en.srt'].join(path.sep),
  );
  const to = path.join(root, 'published'),
    report = (...e) => issues.push(e);
  const first = await mergeAssets(assets.directory, to, undefined, undefined, report);
  await writeFile(path.join(assets.directory, 'poster.jpg'), 'source edit');
  await writeFile(path.join(to, 'poster.jpg'), 'target edit');
  await mergeAssets(assets.directory, to, first.source, first.target, report);
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0].slice(0, 4), ['conflict', 'asset', 'poster.jpg', 'bytes']);
  assert.equal(await readFile(path.join(to, 'poster.jpg'), 'utf8'), 'target edit');
  assert.equal(await readFile(path.join(instance, 'config/system.xml'), 'utf8'), xml);
});
