import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPersistedItemData } from '../helpers/persisted-item-data-projection.js';

const movie = 'MediaBrowser.Controller.Entities.Movies.Movie';
const project = text => projectPersistedItemData(text, movie, { created: true });

test('new typed Data compares reader values across layout while retaining precision, nulls and ordered members', () => {
  const before = '{"Width":1920,"Size":9007199254740993,"DateLastSaved":"2026-10-27T00:00:00.1234000Z","AdditionalParts":["a","b"],"TmdbCollectionName":null}';
  const after = '{ "TmdbCollectionName":null, "AdditionalParts": ["a", "b"], "DateLastSaved":"2026-10-27T00:00:00.1234Z", "Size":"9007199254740993", "Width":1920 }';
  assert.deepEqual(project(before), project(after));
  assert.notDeepEqual(project(before), project(before.replace('9007199254740993', '9007199254740992')));
  assert.notDeepEqual(project(before), project(before.replace('.1234000Z', '.1234001Z')));
  assert.notDeepEqual(project(before), project(before.replace('["a","b"]', '["b","a"]')));
  assert.notDeepEqual(project(before), project(before.replace('"TmdbCollectionName":null', '"TmdbCollectionName":""')));
  assert.notDeepEqual(project(before), project(before.replace('"TmdbCollectionName":null', '"TmdbCollectionName":[]')));
  assert.equal(project(before).value.Size, 9007199254740993n);
});

test('new typed Data retains unknown duplicate property spans, exact number tokens and relative order', () => {
  const text = '{"Width":1920,"Opaque":1e0,"Opaque":{"Path":"/fixture/raw","Id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"Other":[2,1]}';
  const result = project(text);
  assert.equal(result.unknown.length, 3);
  assert.deepEqual(result.unknown.map(value => value.path), [[{ field: 'Opaque', occurrence: 0 }],
    [{ field: 'Opaque', occurrence: 1 }], [{ field: 'Other', occurrence: 0 }]]);
  assert.equal(result.unknown[0].raw, '"Opaque":1e0');
  assert.notDeepEqual(result, project(text.replace('1e0', '1.0')));
  assert.notDeepEqual(result, project(text.replace('"Opaque":1e0,', '')));
  assert.notDeepEqual(result, project(text.replace('"Opaque":1e0,', '').replace('"Other":[2,1]', '"Other":[2,1],"Opaque":1e0')));
  assert.notDeepEqual(result, project(text.replace('"Opaque":1e0', '"\\u004Fpaque":1e0')));
  assert.deepEqual(result, project(text.replace('"Width":1920,', '').replace('"Other":[2,1]', '"Other":[2,1], "Width":1920')));
});

test('known numeric and string tokens keep their actual Int64, binary64 and scalar-string values', () => {
  assert.equal(project('{"Size":9223372036854775807}').value.Size, 9223372036854775807n);
  assert.equal(project('{"Size":-9223372036854775808}').value.Size, -9223372036854775808n);
  assert.notDeepEqual(project('{"Size":9223372036854775807}'), project('{"Size":9223372036854775806}'));
  const photo = text => projectPersistedItemData(text, 'MediaBrowser.Controller.Entities.Photo', { created: true });
  assert.deepEqual(photo('{"Aperture":1e0}'), photo('{ "Aperture":1.0 }'));
  assert.notDeepEqual(photo('{"Aperture":1}'), photo('{"Aperture":1.0000000000000002}'));
  assert.deepEqual(project('{"Container":1e0}'), project('{"Container":"1e0"}'));
  assert.notDeepEqual(project('{"Container":1e0}'), project('{"Container":"1"}'));
  assert.notDeepEqual(project('{"DateLastSaved":"2026-10-27T00:00:00Z"}'),
    project('{"DateLastSaved":"2026-10-27T00:00:00+00:00"}'));
});

test('typed paths bind only declared path roles and unknown nested occurrences retain their ancestry', () => {
  const guid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const text = '{"ShortcutPath":"/fixture/media","TmdbCollectionName":"/fixture/media","RemoteTrailers":[{"Url":"/fixture/media","Name":"' + guid + '","Opaque":{"Path":"/fixture/media"}}],"LinkedAlternateVersions":[{"Path":"/fixture/media","LibraryItemId":"' + guid + '","ItemId":"' + guid + '","Opaque":1e0,"Opaque":2}]}';
  const result = projectPersistedItemData(text, movie, { created: true,
    path: value => value === '/fixture/media' ? '$media' : value, identity: () => '$relation' });
  assert.equal(result.value.ShortcutPath, '$media');
  assert.equal(result.value.TmdbCollectionName, '/fixture/media');
  assert.equal(result.value.RemoteTrailers[0].Url, '/fixture/media');
  assert.equal(result.value.RemoteTrailers[0].Name, guid);
  assert.equal(result.value.LinkedAlternateVersions[0].Path, '$media');
  assert.equal(result.value.LinkedAlternateVersions[0].LibraryItemId, guid);
  assert.equal(result.value.LinkedAlternateVersions[0].ItemId, '$relation');
  assert.deepEqual(result.unknown[0], { path: [{ field: 'RemoteTrailers', occurrence: 0 }, 0, { field: 'Opaque', occurrence: 0 }],
    raw: '"Opaque":{"Path":"/fixture/media"}' });
  assert.deepEqual(result.unknown.slice(1).map(value => value.path), [
    [{ field: 'LinkedAlternateVersions', occurrence: 0 }, 0, { field: 'Opaque', occurrence: 0 }],
    [{ field: 'LinkedAlternateVersions', occurrence: 0 }, 0, { field: 'Opaque', occurrence: 1 }],
  ]);
  const duplicateParent = '{"RemoteTrailers":[{"Opaque":1e0}],"RemoteTrailers":[{"Url":"a"}]}';
  const moved = '{"RemoteTrailers":[{}],"RemoteTrailers":[{"Url":"a","Opaque":1e0}]}';
  assert.notDeepEqual(project(duplicateParent), project(moved));
});

test('old rows, null Data, nonserialized types and invalid documents remain literal', () => {
  const text = '{ "Width":1920,"Opaque":1e0 }';
  assert.equal(projectPersistedItemData(text, movie), text);
  assert.equal(projectPersistedItemData(text, movie, { created: false }), text);
  assert.equal(projectPersistedItemData(null, movie, { created: true }), null);
  assert.equal(projectPersistedItemData(text, 'MediaBrowser.Controller.Entities.Year', { created: true }), text);
  assert.equal(projectPersistedItemData(text, 'Unknown.Plugin.Type', { created: true }), text);
  for (const invalid of ['{broken', 'null', '[]', '{"Width":null}', '{"Width":null,"Width":1920}']) {
    assert.equal(project(invalid), invalid);
  }
  const duplicate = '{"Width":100,"Width":1920}';
  assert.deepEqual(project(duplicate), project('{"Width":1920}'));
  assert.notDeepEqual(project('{"Width":1920,"Width":100}'), project(duplicate));
});
