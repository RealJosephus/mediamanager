import test from 'node:test';
import assert from 'node:assert/strict';
import { deserializeNativeItemData, NativeItemJsonError, serializeNativeItemData } from '../../src/library/native-item-data.js';
import { cloneNativeItemEntity, isNativeItemEntity, newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { createPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { EMPTY_ID, extraTypeCode, loadLibrary, mapRecord, repositoryTopParentId, repositoryValue, repositoryIdPresent } from '../../src/library/records.js';

const folder = 'MediaBrowser.Controller.Entities.Folder';
const movie = 'MediaBrowser.Controller.Entities.Movies.Movie';
const season = 'MediaBrowser.Controller.Entities.TV.Season';
const id = '95600000-0000-0000-0000-000000000001';

test('guide programs ignore source JSON while channels hydrate their number and radio kind', () => {
  const program = mapRecord({ Type: 'MediaBrowser.Controller.LiveTv.LiveTvProgram', Data: 'malformed{',
    Id: id, StartDate: '2026-10-21 12:00:00.1234567', IsSeries: true, IsMovie: false, IsRepeat: false,
    EpisodeTitle: 'Chapter', Tags: 'lIvE|NEWS|Kids|SPORTS|premiere' });
  assert.equal(program.StartDate, '2026-10-21T12:00:00.1234567Z');
  assert.deepEqual([program.IsLive, program.IsNews, program.IsKids, program.IsSports, program.IsPremiere],
    [true, true, true, true, true]);
  assert.equal(program.IsSeries, true);
  const channel = mapRecord({ Type: 'MediaBrowser.Controller.LiveTv.LiveTvChannel', Id: id,
    Data: '{"Number":"2.5","ChannelType":"Radio"}', ExternalServiceId: 'Guide', Path: null,
    IsSeries: false, IsMovie: true, IsRepeat: false });
  assert.deepEqual([channel.Number, channel.ChannelType, channel.MediaType, channel.SourceType, channel.LocationType,
    channel.ServiceName, channel.IsMovie, channel.UnratedType],
  ['2.5', 'Radio', 'Audio', 'LiveTV', 'Remote', 'Guide', true, 'LiveTvChannel']);
});

test('unknown exact discriminators are skipped and diagnosed before parsing Data', () => {
  for (const skip of [false, true]) {
    const unknown = [], json = [];
    assert.equal(deserializeNativeItemData('Plugin.Entities.Movie', 'bad{', {
      skip, onUnknownType: value => unknown.push(value), onJsonError: value => json.push(value),
    }), null);
    assert.deepEqual(unknown, [{ fullName: 'Plugin.Entities.Movie' }]);
    assert.deepEqual(json, []);
  }
  const warnings = [];
  assert.equal(mapRecord({ Type: 'Movie', Id: id, Data: 'bad{' }, { onUnknownType: value => warnings.push(value) }), null);
  assert.deepEqual(warnings, [{ fullName: 'Movie', itemId: id }]);
});

test('JSON fallback diagnoses once, returns a fresh typed constructor and propagates callback failures', () => {
  const errors = [];
  const item = deserializeNativeItemData(folder, '{"IsRoot":true,"Height":"wrong"}', {
    onJsonError: value => errors.push(value),
  });
  assert.equal(isNativeItemEntity(item), true);
  assert.equal(item.IsRoot, false);
  assert.equal(item.Height, 0);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].error instanceof NativeItemJsonError);
  assert.equal(errors[0].error.path, '$.Height');
  const callbackFailure = new Error('diagnostic callback failed');
  assert.throws(() => deserializeNativeItemData(folder, 'bad{', {
    onJsonError() { throw callbackFailure; },
  }), error => error === callbackFailure);
});

test('SQL null, JSON null, source-only types and explicit skip do not diagnose malformed fields', async t => {
  const errors = [];
  for (const [type, data, skip] of [[folder, null, false], [folder, 'null', false],
    [season, 'bad{', false], [folder, 'bad{', true]]) {
    const item = deserializeNativeItemData(type, data, { skip, onJsonError: value => errors.push(value) });
    assert.equal(isNativeItemEntity(item), true);
    assert.equal(item.Height, 0);
  }
  assert.deepEqual(errors, []);
  assert.equal(serializeNativeItemData(deserializeNativeItemData(season, 'bad{')), null);
  const rows = [{ Type: movie, Id: id, Data: '{"Container":"mkv","VideoType":"Iso"}' },
    { Type: 'MediaBrowser.Controller.Entities.UserRootFolder', Id: '95600000-0000-0000-0000-000000000002',
      Data: '{"IsRoot":true,"Container":"root-json"}' }];
  const db = await createPostgresTestDatabase(t, 'typed_data');
  await db.insertBatch('BaseItems', rows.map(row => postgresTestRow('BaseItems', row)));
  for (const skipBasic of [false, true]) {
    const state = await loadLibrary(db, { configuration: { SkipDeserializationForBasicTypes: skipBasic } },
      { baseRows: await db.rows('BaseItems') });
    assert.equal(state.items[0].Container, 'mkv', 'basic-type configuration cannot skip Movie Data');
    assert.equal(state.items[0].VideoType, 'Iso');
    assert.equal(state.items[1].Container, skipBasic ? null : 'root-json');
  }
});

test('typed Data retains lossless integers, lexical strings and declared nested converter values', () => {
  const item = deserializeNativeItemData(movie,
    '{"Size":9223372036854775807,"Container":1e+2,"AspectRatio":true,"VideoType":"iso",'
    + '"RemoteTrailers":[{"Url":12,"Name":false,"ignored":"no"}],'
    + '"LinkedAlternateVersions":[{"Type":"Shortcut","ItemId":"00000000000000000000000000000000"}],'
    + '"Unknown":true,"IsHD":true}');
  assert.equal(item.Size, 9223372036854775807n);
  assert.equal(item.Container, '1e+2');
  assert.equal(item.AspectRatio, 'true');
  assert.equal(item.VideoType, 'Iso');
  assert.equal(item.IsHD, false);
  assert.deepEqual(item.RemoteTrailers, [{ Url: '12', Name: 'false' }]);
  assert.deepEqual(item.LinkedAlternateVersions, [{ Path: null, Type: 'Shortcut', LibraryItemId: null, ItemId: EMPTY_ID }]);
  assert.equal(Object.hasOwn(item, 'Unknown'), false);
  const raw = serializeNativeItemData(item);
  assert.match(raw, /"Size":9223372036854775807/u);
  assert.ok(raw.includes('"LinkedAlternateVersions":[{"Type":"Shortcut","ItemId":null}]'));

  // These production controls complement the separately sealed duplicate
  // scalar oracle; they do not claim an additional native capture.
  for (const [source, expectedPath] of [
    ['{"Width":"wrong","Wi\\u0064th":2}', '$.Width'],
    ['{"RemoteTrailers":[{"Url":{},"Url":"valid"}]}', '$.RemoteTrailers[0].Url'],
    ['{"RemoteTrailers":[{"Url":"valid","Url":{}}]}', '$.RemoteTrailers[0].Url'],
    ['{"RemoteTrailers":[{"Url":{}}],"RemoteTrailers":[]}', '$.RemoteTrailers[0].Url'],
    ['{"LinkedAlternateVersions":[{"Type":"invalid","Type":"Shortcut"}]}', '$.LinkedAlternateVersions[0].Type'],
  ]) {
    const errors = [];
    const fallback = deserializeNativeItemData(movie, source, { onJsonError: event => errors.push(event.error) });
    assert.equal(errors.length, 1, source);
    assert.ok(errors[0] instanceof NativeItemJsonError, source);
    assert.equal(errors[0].path, expectedPath, source);
    assert.equal(fallback.Width, 0, source);
    assert.deepEqual(fallback.RemoteTrailers, [], source);
  }
  const duplicate = deserializeNativeItemData(movie,
    '{"Wi\\u0064th":1,"Width":2,"RemoteTrailers":[{"Url":1e+2,"Url":3e+4}],'
    + '"IsHD":{},"IsHD":true,"Unknown":{},"Unknown":1}');
  assert.equal(duplicate.Width, 2);
  assert.deepEqual(duplicate.RemoteTrailers, [{ Url: '3e+4', Name: null }]);
  assert.equal(duplicate.IsHD, false, 'read-only occurrences are ignored before conversion');
  assert.equal(Object.hasOwn(duplicate, 'Unknown'), false);
});

test('repository overlay preserves search scope separately from native entity fields and copies it without flattening', () => {
  const item = mapRecord({ Type: movie, Id: id, Data: '{"Width":1920,"Height":1080,"Size":5}',
    Width: null, Height: 700, Size: 9n, IsFolder: true, MediaType: 'Audio',
    TopParentId: id, ParentId: null, OwnerId: null, ChannelId: null, ExtraType: 2,
    SortName: 'stored', Name: 'Live Name', ForcedSortName: null, DateLastSaved: null });
  assert.equal(item.Width, 0);
  assert.equal(item.Height, 700);
  assert.equal(item.Size, 9n);
  assert.equal(item.IsHD, false);
  assert.equal(item.IsFolder, false);
  assert.equal(item.MediaType, 'Video');
  assert.equal(item.NativeMediaType, 'Audio');
  assert.equal(Object.hasOwn(item, 'TopParentId'), false, 'a search column is not a CLR entity field');
  assert.equal(repositoryTopParentId(item), id);
  assert.equal(repositoryTopParentId({ TopParentId: id }), id);
  assert.equal(Object.keys(item).includes('NativeTopParentId'), false);
  assert.equal(repositoryTopParentId(cloneNativeItemEntity(item)), id);
  assert.deepEqual([item.ParentId, item.OwnerId, item.ChannelId], [EMPTY_ID, EMPTY_ID, EMPTY_ID]);
  assert.equal(item.ExtraType, 'Trailer');
  assert.equal(extraTypeCode(item.ExtraType), 2);
  assert.equal(repositoryValue(item, 'Width'), null);
  assert.equal(repositoryValue(item, 'IsFolder'), true);
  assert.equal(repositoryValue(item, 'SortName'), 'stored');
  assert.equal(item.SortName, 'live name');
  assert.equal(repositoryValue(item, 'DateLastSaved'), null);
  assert.equal(repositoryIdPresent(item, 'OwnerId'), false);
  assert.equal(repositoryIdPresent(mapRecord({ Type: movie, OwnerId: EMPTY_ID }), 'OwnerId'), true);
  const copy = cloneNativeItemEntity(item);
  assert.equal(repositoryValue(copy, 'SortName'), 'stored');
  assert.equal(Object.keys(copy).includes('NativeRepositoryColumns'), false);
  assert.throws(() => { copy.NativeRepositoryColumns.SortName = 'changed'; }, TypeError);
});

test('native Data encoder preserves declared order and escapes Unicode and HTML-sensitive strings', () => {
  const item = deserializeNativeItemData(movie, '{"Container":"中文<>&\\\"","Height":720}');
  const raw = serializeNativeItemData(item);
  assert.match(raw, /"Container":"\\u4E2D\\u6587\\u003C\\u003E\\u0026\\u0022"/u);
  assert.ok(raw.indexOf('"IsHD":true') < raw.indexOf('"Height":720'));
  assert.match(raw, /"DateLastSaved":"0001-01-01T00:00:00\.0000000Z"/u);
});

test('AggregateFolder VirtualChildren serialize through the declared BaseItem contract', () => {
  const aggregate = newNativeItemEntity('MediaBrowser.Controller.Entities.AggregateFolder');
  const playlists = newNativeItemEntity('Emby.Server.Implementations.Playlists.PlaylistsFolder');
  aggregate.VirtualChildren.push(playlists);
  const data = JSON.parse(serializeNativeItemData(aggregate));
  assert.equal(data.VirtualChildren.length, 1);
  assert.equal(Object.hasOwn(data.VirtualChildren[0], 'IsRoot'), false);
  assert.equal(data.VirtualChildren[0].DateCreated, '0001-01-01T00:00:00.0000000Z');
});
