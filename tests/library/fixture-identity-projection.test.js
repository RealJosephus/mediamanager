import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureIdentityProjector, projectItemDataIdentities } from '../helpers/fixture-identity-projection.js';
import { idKey } from '../../src/library/records.js';

const actualUser = '12345678-1234-4234-8234-123456789ABC';
const fixtureUser = '87654321-4321-4321-8321-CBA987654321';
const actualView = '11111111-2222-4333-8444-555555555555';
const fixtureView = '99999999-8888-4777-8666-555555555555';
const identities = new Map([[idKey(actualUser), fixtureUser], [idKey(actualView), fixtureView]]);
const viewType = 'MediaBrowser.Controller.Entities.UserView';
const viewPath = '%MetadataPath%/views/' + idKey(actualView);
const fixturePath = '%MetadataPath%/views/' + idKey(fixtureView);

test('fixture Data binds typed relations while opaque metadata and its persistent TEXT remain distinguishable', () => {
  const data = user => '{\r\n  "Opaque": {"UserId":"' + actualUser + '","Path":"' + viewPath
    + '","n":9007199254740993},\n  "UserId" : "' + user + '", "ViewType":"movies",'
    + ' "DisplayParentId":"' + idKey(actualView) + '", "Unknown":1, "Unknown":2, "Escaped":"\\u0061",'
    + ' "constructor":"' + actualUser + '", "__proto__":{"UserId":"' + actualUser + '"}\n}\n';
  const projected = projectItemDataIdentities(data(actualUser), viewType, identities);
  const expected = data(fixtureUser).replace('"DisplayParentId":"' + idKey(actualView) + '"',
    '"DisplayParentId":"' + idKey(fixtureView) + '"');
  assert.equal(projected, expected);
  // A value regression that the former recursive replacement hid remains a
  // real difference after both inputs have had their identity roles aligned.
  const corrupted = data(actualUser).replace('"Opaque": {"UserId":"' + actualUser,
    '"Opaque": {"UserId":"' + fixtureUser);
  assert.notEqual(projectItemDataIdentities(corrupted, viewType, identities), projected);
  for (const text of ['{ "not-json" ', '["' + actualUser + '"]', null]) {
    assert.equal(projectItemDataIdentities(text, viewType, identities), text);
  }
  assert.equal(projectItemDataIdentities(data(actualUser), 'Unregistered.Native.Entity', identities), data(actualUser));
  const playlist = '{"OwnerUserId":"' + actualUser + '","Shares":[{"UserId":"' + actualUser
    + '","CanEdit":true,"Opaque":"' + actualUser + '"}],"Unknown":{"UserId":"' + actualUser + '"}}';
  assert.equal(projectItemDataIdentities(playlist, 'MediaBrowser.Controller.Playlists.Playlist', identities),
    '{"OwnerUserId":"' + fixtureUser + '","Shares":[{"UserId":"' + fixtureUser
      + '","CanEdit":true,"Opaque":"' + actualUser + '"}],"Unknown":{"UserId":"' + actualUser + '"}}');
});

test('fixture snapshots align relationship columns and owned view paths without rewriting other persisted values', () => {
  const view = { Id: actualView, Type: viewType, Path: viewPath, PresentationUniqueKey: idKey(actualView),
    Name: actualUser, Overview: viewPath, Data: '{ "UserId":"' + actualUser + '", "Unknown":"' + actualUser + '" }' };
  const project = createFixtureIdentityProjector({ identities, viewRows: [view] });
  const snapshot = { database: {
    baseItems: [view, { Id: 'abcdefab-cdef-4abc-8def-abcdefabcdef', Type: 'MediaBrowser.Controller.Entities.Movies.Movie',
      Path: viewPath, Name: actualView, Overview: actualUser, ProviderIds: '{"UserId":"' + actualUser + '"}',
      Data: '{"UserId":"' + actualUser + '"}' }],
    ancestorIds: [{ ItemId: actualView, ParentItemId: actualUser, Note: actualView }],
    userData: [{ ItemId: actualView, UserId: actualUser, CustomDataKey: actualView, Note: actualUser }],
    foreignKeyCheck: [], opaqueRows: [{ Id: actualUser }],
  }, filesystem: { metadata: { exists: true, entries: [
    { path: 'views/' + idKey(actualView), type: 'directory' },
    { path: 'views/' + idKey(actualView) + '/poster.jpg', type: 'file' },
    { path: 'notes/views/' + idKey(actualView), type: 'file' },
  ] }, libraries: { exists: true, entries: [{ path: 'views/' + idKey(actualView), type: 'file' }] } } };
  const output = project.snapshot(snapshot), created = output.database.baseItems[0];
  assert.equal(created.Id, fixtureView); assert.equal(created.Path, fixturePath);
  assert.equal(created.PresentationUniqueKey, idKey(fixtureView));
  assert.equal(created.Name, actualUser); assert.equal(created.Overview, viewPath);
  assert.equal(created.Data, '{ "UserId":"' + fixtureUser + '", "Unknown":"' + actualUser + '" }');
  assert.deepEqual(output.database.baseItems[1], snapshot.database.baseItems[1]);
  assert.deepEqual(output.database.ancestorIds, [{ ItemId: fixtureView, ParentItemId: fixtureUser, Note: actualView }]);
  assert.deepEqual(output.database.userData, [{ ItemId: fixtureView, UserId: fixtureUser, CustomDataKey: fixtureView, Note: actualUser }]);
  assert.deepEqual(output.database.opaqueRows, snapshot.database.opaqueRows);
  assert.deepEqual(output.filesystem.metadata.entries.map(entry => entry.path), [
    'views/' + idKey(fixtureView), 'views/' + idKey(fixtureView) + '/poster.jpg', 'notes/views/' + idKey(actualView),
  ]);
  assert.deepEqual(output.filesystem.libraries, snapshot.filesystem.libraries);
  assert.equal(snapshot.database.baseItems[0].Id, actualView);
  const wrongKey = project.row('BaseItems', { ...view, PresentationUniqueKey: actualUser });
  assert.equal(wrongKey.PresentationUniqueKey, actualUser);
});

test('fixture HTTP identities preserve names, opaque dictionaries and wrong public owner keys as differences', () => {
  const project = createFixtureIdentityProjector({ identities, viewRows: [{ Id: actualView, Type: viewType, Path: viewPath }] });
  const item = { Id: idKey(actualView), Type: 'UserView', ParentId: idKey(actualUser),
    Path: '/instance/metadata/views/' + idKey(actualView), Name: actualUser, Overview: viewPath,
    UserData: { ItemId: idKey(actualView), Key: actualView, Played: false },
    ProviderIds: { UserId: actualUser, Id: actualView, Path: viewPath },
    Unknown: { Id: actualView, Type: 'UserView', UserId: actualUser, Path: viewPath } };
  const output = project.body({ Items: [item], TotalRecordCount: 1, StartIndex: 0 }).Items[0];
  assert.equal(output.Id, idKey(fixtureView)); assert.equal(output.ParentId, idKey(fixtureUser));
  assert.equal(output.Path, '/instance/metadata/views/' + idKey(fixtureView));
  assert.equal(output.Name, actualUser); assert.equal(output.Overview, viewPath);
  assert.deepEqual(output.UserData, { ItemId: idKey(fixtureView), Key: fixtureView, Played: false });
  assert.deepEqual(output.ProviderIds, item.ProviderIds); assert.deepEqual(output.Unknown, item.Unknown);
  const corrupted = project.body({ ...item, Name: fixtureUser, ProviderIds: { ...item.ProviderIds, UserId: fixtureUser } });
  assert.notDeepEqual(corrupted, output);
  const wrongKey = project.body({ ...item, UserData: { ...item.UserData, Key: actualUser } });
  assert.equal(wrongKey.UserData.Key, actualUser);
  assert.equal(project.body({ ...item, Type: 'Movie' }).Path, item.Path);
  assert.equal(project.body({ ...item, ParentId: '-' + actualUser }).ParentId, '-' + actualUser);
  const request = { method: 'POST', body: { UserId: actualUser, Name: actualUser, Unknown: { UserId: actualUser } } };
  assert.deepEqual(project.request(request, '/LiveTv/Programs?'), { method: 'POST',
    body: { UserId: fixtureUser, Name: actualUser, Unknown: { UserId: actualUser } } });
  assert.deepEqual(project.request(request, '/Unrelated'), request);
  assert.deepEqual(project.request({ ...request, method: 'GET' }, '/LiveTv/Programs'), { ...request, method: 'GET' });
});
