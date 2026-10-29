import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { projectUserViewsBody, projectUserViewsData, rebindUserViewsDataPaths, recordedUserViewsStateRoots } from './user-views-projection.js';
import { loadUserViewsNativeContract } from './fixtures/user-views/native-contract.js';

test('UserViews recorded roots follow the bound UserRootFolder and actual metadata HTTP consumers', async () => {
  const contract = await loadUserViewsNativeContract(), fixture = JSON.parse(await readFile(new URL('./fixtures/user-views/input.json', import.meta.url), 'utf8'));
  const original = structuredClone(contract), roots = recordedUserViewsStateRoots(contract, fixture);
  assert.ok(roots.metadataViewIds.length > 0);
  assert.deepEqual(recordedUserViewsStateRoots({ ...contract, manifest: { ...contract.manifest, referenceRoot: 'a later evidence storage location' } }, fixture), roots);
  const changed = structuredClone(contract), record = changed.http.find(record => record.response.bodyJson?.Items?.some(item => roots.metadataViewIds.includes(item.Id.replaceAll('-', '').toLowerCase())));
  record.response.bodyJson.Items.find(item => roots.metadataViewIds.includes(item.Id.replaceAll('-', '').toLowerCase())).Path += '-other';
  assert.throws(() => recordedUserViewsStateRoots(changed, fixture), /actual metadata root/u);
  assert.deepEqual(contract, original);
});

test('UserViews instance bindings preserve descriptive and unknown DTO values', () => {
  const root = path.resolve('controlled-user-views'), body = { Items: [{ Id: 'a'.repeat(32), Type: 'UserView', ServerId: 'actual-server',
    Path: path.join(root, 'views', 'one'), Name: root + '/descriptive-name',
    ProviderIds: { ServerId: 'opaque-server', Path: root + '/provider-value' },
    Unknown: { Id: 'b'.repeat(32), Type: 'UserView', ServerId: 'opaque-server', Path: root + '/unknown' } }],
    ServerId: 'root-business-value' };
  const projected = projectUserViewsBody(body, root, { serverId: 'actual-server', status: 200 });
  assert.equal(projected.Items[0].ServerId, '$server');
  assert.equal(projected.Items[0].Path, '$instance\\views\\one');
  assert.equal(projected.Items[0].Name, body.Items[0].Name);
  assert.deepEqual(projected.Items[0].ProviderIds, body.Items[0].ProviderIds);
  assert.deepEqual(projected.Items[0].Unknown, body.Items[0].Unknown);
  assert.equal(projected.ServerId, body.ServerId);
  const changed = structuredClone(body); changed.Items[0].ProviderIds.ServerId = 'different';
  assert.notDeepEqual(projectUserViewsBody(changed, root, { serverId: 'actual-server' }), projected);
  assert.throws(() => projectUserViewsBody(body, root, { serverId: 'wrong-server' }), assert.AssertionError);
});

test('UserViews old Data remains raw TEXT outside declared path tokens', () => {
  const type = 'MediaBrowser.Controller.Entities.CollectionFolder', root = path.resolve('controlled-user-views');
  const location = JSON.stringify(path.join(root, 'media'));
  const text = '{ "PhysicalLocationsList" : [' + location + '], "Unknown" : {"Path":' + JSON.stringify(path.join(root, 'opaque')) + ', "ServerId":"native"}, "Number":1e0, "Duplicate":1, "Duplicate":2 }';
  const replay = rebindUserViewsDataPaths(text, type, value => value.replace(root, '/candidate'));
  assert.equal(replay, text.replace(location, JSON.stringify(path.join(root, 'media').replace(root, '/candidate'))));
  const projected = projectUserViewsData(text, type, root);
  assert.equal(projected, text.replace(location, JSON.stringify('$instance\\media')));
  assert.notEqual(projectUserViewsData(text.replace('1e0', '1.0'), type, root), projected);
  assert.notEqual(projectUserViewsData(text.replace('"native"', '"changed"'), type, root), projected);
  assert.equal(projectUserViewsData(null, type, root), null);
  assert.equal(projectUserViewsData('invalid JSON', type, root), 'invalid JSON');
});

test('UserViews new typed save clocks do not alter unknown nested values', () => {
  const type = 'MediaBrowser.Controller.Entities.UserView', root = path.resolve('controlled-user-views');
  const value = { DateLastSaved: '2026-10-27T00:00:00Z', ViewType: 'movies',
    Unknown: { DateLastSaved: 'opaque', ServerId: 'original', Path: root + '/description' } };
  const projected = projectUserViewsData(JSON.stringify(value), type, root, { newView: true });
  assert.equal(Object.hasOwn(projected.value, 'DateLastSaved'), false);
  assert.deepEqual(projected.value.Unknown, value.Unknown);
  assert.deepEqual(projected, projectUserViewsData('{ "Unknown":' + JSON.stringify(value.Unknown) + ', "ViewType":"movies", "DateLastSaved":"2026-10-27T00:00:01Z" }', type, root, { newView: true }));
  const changed = structuredClone(value); changed.Unknown.DateLastSaved = 'different';
  assert.notDeepEqual(projectUserViewsData(JSON.stringify(changed), type, root, { newView: true }), projected);
  const raw = '{"DateLastSaved":"2026-10-27T00:00:00Z","ViewType":"movies",' +
    '"Unknown":1e0,"Unknown":2,"RemoteTrailers":[{"Name":"Known","Url":"https://example.invalid/",' +
    '"Opaque":{"n":1e0,"n":2}}]}';
  const original = projectUserViewsData(raw, type, root, { newView: true });
  assert.deepEqual(original.unknown.map(value => value.path), [['Unknown'], ['Unknown'], ['RemoteTrailers', 0, 'Opaque']]);
  assert.notDeepEqual(projectUserViewsData(raw.replace('"Unknown":1e0', '"Unknown":1.0'), type, root, { newView: true }), original);
  assert.notDeepEqual(projectUserViewsData(raw.replace('"Unknown":1e0,', ''), type, root, { newView: true }), original);
  assert.notDeepEqual(projectUserViewsData(raw.replace('"n":1e0', '"n":1.0'), type, root, { newView: true }), original);
});
