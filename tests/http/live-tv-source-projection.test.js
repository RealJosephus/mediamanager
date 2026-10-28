import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLosslessJson } from '../../src/core/json.js';
import { canonical, canonicalRows } from './fixtures/live-tv-sources-http/scenario.js';

const id = 'AABBCCDD-0011-2233-4455-66778899AABB';
const key = 'aabbccdd00112233445566778899aabb';
const ids = { [key]: '$tuner' };
const stamp = '2026-10-27T00:00:00.1000000Z';
const clock = { start: Date.parse('2026-10-27T00:00:00Z'), end: Date.parse('2026-10-27T00:01:00Z') };
const row = Data => ({ Id: id, Type: 'MediaBrowser.Controller.LiveTv.LiveTvChannel',
  Name: id, Overview: id, DateCreated: stamp, Data });
const projectedRow = (Data, options = {}) => parseLosslessJson(canonicalRows({ BaseItems: [row(Data)] }, options).BaseItems[0]);

test('source comparison maps only the bound identity fields of its actual HTTP and file roles', () => {
  const value = { Id: id, FriendlyName: id, EnabledTuners: [id], Unknown: { Id: id, StartDate: stamp } };
  const tuner = canonical(value, { ids, role: 'http', route: '/LiveTv/TunerHosts', status: 200 });
  assert.deepEqual(tuner, { ...value, Id: '$tuner' });
  const listing = canonical(value, { ids, role: 'http', route: '/LiveTv/ListingProviders', status: 200 });
  assert.deepEqual(listing, { ...value, Id: '$tuner', EnabledTuners: ['$tuner'] });
  assert.deepEqual(canonical(value, { ids }), value);
  const request = { route: '/LiveTv/ChannelMappings', body: { ProviderId: id, ProviderChannelId: id, Unknown: { Id: id } } };
  assert.deepEqual(canonical(request, { ids, role: 'request', route: request.route }),
    { ...request, body: { ...request.body, ProviderId: '$tuner' } });
  const channel = { Id: id, Name: id, TunerHostId: id, Unknown: { TunerHostId: id } };
  assert.deepEqual(canonical([channel], { ids, role: 'channels' }), [{ ...channel, TunerHostId: '$tuner' }]);
});

test('item dates compare by their real DTO roles while opaque values retain their complete strings', () => {
  const value = { Items: [{ Id: key, Type: 'TvChannel', Name: id, DateCreated: stamp,
    ProviderIds: { Id: id, StartDate: stamp, traceId: id }, Unknown: { StartDate: stamp, Id: id }, traceId: id }] };
  const project = value => canonical(value, { ids, role: 'http', route: '/LiveTv/Channels', status: 200 });
  const expected = project(value);
  assert.equal(expected.Items[0].Name, id);
  assert.deepEqual(expected.Items[0].ProviderIds, value.Items[0].ProviderIds);
  assert.deepEqual(expected.Items[0].Unknown, value.Items[0].Unknown);
  assert.equal(expected.Items[0].traceId, id);
  const equivalentDate = structuredClone(value); equivalentDate.Items[0].DateCreated = stamp.replace('.1000000', '.1');
  assert.deepEqual(project(equivalentDate), expected);
  const changedOpaqueDate = structuredClone(value); changedOpaqueDate.Items[0].Unknown.StartDate = stamp.replace('.1000000', '.1');
  assert.notDeepEqual(project(changedOpaqueDate), expected);
});

test('typed database columns cannot normalize descriptive TEXT or imported and unknown Data tokens', () => {
  const raw = '{ "DateLastSaved": "' + stamp + '", "Unknown":1e0,"Unknown":1.0,"Note":"' + id + '" }';
  const baselineItems = new Map([[key, row(raw)]]);
  const imported = projectedRow(raw, { clock, baselineItems });
  assert.equal(imported.Id, key); assert.equal(imported.Name, id); assert.equal(imported.Overview, id);
  assert.equal(imported.Data, raw);
  const newDocument = projectedRow(raw, { clock });
  assert.equal(typeof newDocument.Data, 'string');
  assert.ok(newDocument.Data.includes('"Unknown":1e0,"Unknown":1.0,"Note":"' + id + '"'));
  assert.notDeepEqual(projectedRow(raw.replace('1e0', '1.0'), { clock }), newDocument);
  assert.notDeepEqual(projectedRow(raw.replace(id, key), { clock }), newDocument);
});

test('new known typed Data allows JSON layout while preserving every Int64 value', () => {
  const left = '{"Number":"11","ChannelType":"TV","Size":9007199254740993,"DateLastSaved":"' + stamp + '","RemoteTrailers":[]}';
  const right = '{ "RemoteTrailers": [], "Size": 9007199254740993, "ChannelType": "TV", "Number": "11", "DateLastSaved": "' + stamp.replace('.1000000', '.1') + '" }';
  assert.deepEqual(projectedRow(left, { clock }), projectedRow(right, { clock }));
  assert.notDeepEqual(projectedRow(left.replace('9007199254740993', '9007199254740992'), { clock }), projectedRow(right, { clock }));
});
