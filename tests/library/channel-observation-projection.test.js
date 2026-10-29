import test from 'node:test';
import assert from 'node:assert/strict';
import { projectChannelAction, projectChannelEntitySummaries, projectChannelPath,
  projectChannelCacheFiles as cacheObservation } from '../helpers/channel-observation-projection.js';

test('channel actions bind DTO paths while retaining metadata, names and opaque dictionaries', () => {
  const root = '/fixture/source', literal = root + '/metadata/item';
  const opaque = { Path: literal, Id: root, traceId: root, ServerId: root };
  const dto = { Id: 'a'.repeat(32), Type: 'Movie', Path: literal, Name: literal, Overview: root,
    ProviderIds: structuredClone(opaque), Unknown: structuredClone(opaque),
    MediaSources: [{ Path: literal, RequiredHttpHeaders: structuredClone(opaque), MediaStreams: [{ Path: literal, Title: root }] }] };
  const action = { value: { Items: [dto], TotalRecordCount: 1, StartIndex: 0 } }, projected = projectChannelAction(action, root);
  const item = projected.value.Items[0];
  assert.equal(item.Path, '<ROOT>/metadata/item'); assert.equal(item.MediaSources[0].Path, '<ROOT>/metadata/item');
  assert.equal(item.MediaSources[0].MediaStreams[0].Path, '<ROOT>/metadata/item');
  assert.equal(item.Name, literal); assert.equal(item.Overview, root); assert.deepEqual(item.Unknown, opaque);
  assert.deepEqual(item.ProviderIds, opaque); assert.deepEqual(item.MediaSources[0].RequiredHttpHeaders, opaque);
  const named = { value: [{ Id: dto.Id, Type: dto.Type, Path: literal, Name: root }] };
  const other = { value: [{ Id: dto.Id, Type: dto.Type, Path: '/other/source/metadata/item', Name: '/other/source' }] };
  assert.notDeepEqual(projectChannelAction(named, root), projectChannelAction(other, '/other/source'));
  assert.equal(action.value.Items[0].Path, literal);
  assert.equal(projectChannelPath(root + '-other/file', root), root + '-other/file');
  assert.deepEqual(projectChannelAction({ failure: { status: 400, Message: root } }, root), { failure: { status: 400, Message: root } });
});

test('channel entity subsets and typed cache comparisons keep literal provider values and unknown fields', () => {
  const root = '/fixture/source', row = { Id: 'item', Path: root + '/metadata/item', Name: root, Overview: root, type: 'Movie',
    Unknown: { Path: root } };
  const projected = projectChannelEntitySummaries([row], root)[0];
  assert.equal(projected.Path, '<ROOT>/metadata/item'); assert.equal(projected.Name, root);
  assert.equal(projected.Overview, root); assert.deepEqual(projected.Unknown, row.Unknown);
  assert.notDeepEqual(projectChannelEntitySummaries([{ Path: root + '/item', Name: root }], root),
    projectChannelEntitySummaries([{ Path: '/other/source/item', Name: '/other/source' }], '/other/source'));
  const files = [{ path: 'cache/catalog.json', text: '{"Items":[{"Name":"/fixture/source","Path":"/fixture/source","Unknown":{"Path":"/fixture/source"}}]}' }];
  const original = cacheObservation(files);
  assert.equal(original[0].value.Items[0].Path, root); assert.equal(original[0].value.Items[0].Name, root);
  assert.notDeepEqual(cacheObservation([{ ...files[0], text: files[0].text.replaceAll(root, '/other/source') }]), original);
  assert.deepEqual(cacheObservation([{ path: 'cache/catalog.json', text: '{broken ' + root }]),
    [{ path: 'cache/catalog.json', value: '{broken ' + root }]);
});
