import { testFileSystem } from './plugin-files.js';
import { openMetadataRelations, trackMetadataContexts, attachMetadataItemCreation, closeMetadataFixture, removeMetadataTestRoot } from '../metadata/relations-fixture.js';
import test from 'node:test';
import { createTestMediaEncoder } from '../helpers/media-encoder.js';
import assert from 'node:assert/strict';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { ProbeService } from '../../src/library/probe-service.js';
import { LibraryService } from '../../src/library/library-service.js';
import { dateTicks } from '../../src/library/records.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { MetadataRefreshHost } from '../../src/metadata/refresh-host.js';
import { MetadataRegistry } from '../../src/metadata/registry.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { PlaybackService } from '../../src/playback/service.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import hlsReference from '../playback/fixtures/hls-reference.json' with { type: 'json' };

const videoId = '72727272-7272-7272-7272-727272727272';
const audioId = '73737373-7373-7373-7373-737373737373';
const storedDate = '2026-09-26T00:00:00.0000000Z';
const changedDate = new Date('2026-09-26T00:00:02.000Z');
const oldKeyframes = { TotalDuration: 350000000n, KeyframeTicks: '[0,104270000,208540000,312400000]' };
const probeResult = { raw: { format: { duration: '30.021', format_name: 'matroska,webm', size: '1894415', bit_rate: '504823' }, streams: [
  { index: 0, codec_type: 'video', codec_name: 'h264', width: 320, height: 240, bit_rate: '120823' },
  { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '44100', bit_rate: '192000' }
], chapters: [] } };

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function baseItem(values) {
  const row = Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => !column.generated).map(column => [column.name,
    column.nullable ? null : column.clrType === 'bool' ? false : '']));
  return { ...row, ...values };
}

async function setup(t) {
  const schema = `keyframe_invalidation_${randomBytes(6).toString('hex')}`;
  let database, registry, store, service, library, linkedChildren, itemCreation, stateRoot;
  const contextLoaders = [], dependentHosts = [];
  t.after(async () => {
    await closeMetadataFixture({ library, itemCreation, linkedChildren, contexts: contextLoaders,
      before: [...dependentHosts.map(host => () => host.close()), () => service?.close()],
      after: [() => registry?.close(),
        () => database?.client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`),
        () => database?.client.query(`DROP SCHEMA IF EXISTS "${schema}__mm" CASCADE`),
        () => store ? store.close() : database?.close(),
        () => stateRoot && removeMetadataTestRoot(stateRoot, 'keyframe-invalidation-state-')] });
  });
  database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  await database.insert('BaseItems', baseItem({ Id: videoId, Name: 'Changed video', Path: 'Z:\\media\\video.mkv', MediaType: 'Video',
    Type: 'MediaBrowser.Controller.Entities.Movies.Movie', DateModified: storedDate, Data: '{"VideoType":"VideoFile"}' }));
  await database.insert('BaseItems', baseItem({ Id: audioId, Name: 'Changed audio', Path: 'Z:\\media\\audio.flac', MediaType: 'Audio',
    Type: 'MediaBrowser.Controller.Entities.Audio.Audio', DateModified: storedDate, Data: '{}' }));
  await database.insert('KeyframeData', { ItemId: videoId, ...oldKeyframes });
  await database.insert('KeyframeData', { ItemId: audioId, ...oldKeyframes });

  registry = new StorageRegistry();
  registry.registerType('memory', () => new MemoryStorageAdapter());
  const adapter = await registry.createInstance('keyframe-invalidation', 'memory', {});
  await adapter.write('/video.mkv', Buffer.from('isolated video fixture'), { modified: new Date(storedDate) });
  await adapter.write('/audio.flac', Buffer.from('isolated audio fixture'), { modified: changedDate });
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/media', instanceId: 'keyframe-invalidation', capabilities: {} });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: 'Z:\\media', accessRoot: '/media', style: 'windows', returnAccess: 'Isolated keyframe invalidation fixture.' });
  const state = { mode: 'ok', calls: 0, entered: null, release: null };
  const probe = async () => {
    state.calls++;
    if (state.mode === 'failure') throw new Error('injected probe failure');
    if (state.mode === 'wait') { state.entered.resolve(); await state.release.promise; }
    return structuredClone(probeResult);
  };
  store = new DomainStore(database);
  stateRoot = await mkdtemp(path.join(os.tmpdir(), 'keyframe-invalidation-state-'));
  const spoolRoot = path.join(stateRoot, 'metadata-spool');
  linkedChildren = await openMetadataRelations(database, spoolRoot);
  library = new LibraryService({fileSystem: testFileSystem,  store, linkedChildren, serverId: 'keyframe-invalidation', programDataPath: stateRoot });
  const loadContext = trackMetadataContexts(createMetadataContextLoader({fileSystem: testFileSystem,  store, library, linkedChildren, spoolRoot, vfs, identityMap }), contextLoaders);
  itemCreation = attachMetadataItemCreation({ store, library, linkedChildren, loadContext });
  service = new ProbeService({ store, vfs, identityMap, mediaEncoder: await createTestMediaEncoder(t), probe });
  return { database, store, service, adapter, state, vfs, identityMap, library, linkedChildren, loadContext, dependentHosts };
}

function createRefreshHost(t, fixture) {
  const { library, linkedChildren, loadContext } = fixture;
  fixture.service.loadContext = loadContext;
  fixture.service.library = fixture.service.updates.library = library;
  const host = new MetadataRefreshHost({ registry: new MetadataRegistry(), loadContext, linkedChildren, store: fixture.store, vfs: fixture.vfs, probe: fixture.service });
  fixture.dependentHosts.push(host);
  return host;
}

async function keyframes(database, itemId) {
  return database.rows('KeyframeData', { where: { ItemId: itemId } });
}

async function renderManifest(t, result) {
  const server = http.createServer((request, response) => result.send(request, response));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/main.m3u8`);
  assert.equal(response.status, 200);
  return response.text();
}

async function failKeyframeDelete(database, message) {
  const functionName = `"${database.schemaName}".test_keyframe_delete_failure`;
  await database.client.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION '${message.replaceAll("'", "''")}'; END $$`);
  await database.client.query(`CREATE TRIGGER test_keyframe_delete_failure BEFORE DELETE ON "KeyframeData"
    FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
}

function abortAfterKeyframeDelete(database, controller) {
  const query = database.client.query.bind(database.client);
  database.client.query = async (...args) => {
    const result = await query(...args);
    const statement = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
    if (/\bDELETE FROM\s+(?:"[^"]+"\.)?"KeyframeData"(?:\s|$)/u.test(statement)) controller.abort();
    return result;
  };
  return () => { database.client.query = query; };
}

test('metadata refresh BeforeSave invalidates changed video keyframes with metadata disabled on PostgreSQL', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const fixture = await setup(t);
  // An unchanged existing item has already completed its first refresh and key creation.
  await fixture.database.update('BaseItems', { Id: videoId }, {
    DateLastRefreshed: storedDate, PresentationUniqueKey: videoId.replaceAll('-', '')
  });
  const host = createRefreshHost(t, fixture);

  const unchanged = await host.refresh(videoId, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None' });
  assert.equal(unchanged.changed, false);
  assert.equal((await keyframes(fixture.database, videoId)).length, 1);

  fixture.state.calls = 0;
  await fixture.adapter.write('/video.mkv', Buffer.from('changed isolated video fixture'), { modified: changedDate });
  const changed = await host.refresh(videoId, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None' });
  assert.equal(changed.changed, true);
  assert.equal(changed.UpdateType & ItemUpdateType.MetadataImport, ItemUpdateType.MetadataImport);
  assert.deepEqual(await keyframes(fixture.database, videoId), []);
  assert.equal((await fixture.database.rows('BaseItems', { where: { Id: videoId } }))[0].DateModified, '2026-09-26 00:00:02');
  assert.equal(fixture.state.calls, 0, 'MetadataRefreshMode.None never invokes the probe provider.');
});
test('first metadata refresh with metadata disabled saves its key and retains unchanged keyframes on PostgreSQL', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const fixture = await setup(t);
  const host = createRefreshHost(t, fixture);
  const reasons = [];
  host.updates.on('ItemUpdated', event => reasons.push(event.UpdateReason));

  const first = await host.refresh(videoId, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None' });
  assert.equal(first.changed, true);
  assert.deepEqual(reasons, [ItemUpdateType.MetadataImport, ItemUpdateType.None | ItemUpdateType.MetadataImport]);
  const saved = (await fixture.database.rows('BaseItems', { where: { Id: videoId } }))[0];
  assert.equal(saved.PresentationUniqueKey, videoId.replaceAll('-', ''));
  assert.ok(saved.DateLastSaved);
  assert.equal(saved.DateLastRefreshed, null);
  assert.equal((await keyframes(fixture.database, videoId)).length, 1);
  assert.equal(fixture.state.calls, 0);
});

test('metadata BeforeSave invalidation ignores caller cancellation and rolls back persistence failures on PostgreSQL', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const fixture = await setup(t);
  const host = createRefreshHost(t, fixture);
  await fixture.adapter.write('/video.mkv', Buffer.from('changed isolated video fixture'), { modified: changedDate });
  const before = (await fixture.database.rows('BaseItems', { where: { Id: videoId } }))[0];
  const controller = new AbortController();
  const restoreQuery = abortAfterKeyframeDelete(fixture.database, controller);
  await assert.rejects(host.refresh(videoId, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None', signal: controller.signal }), { name: 'AbortError' });
  restoreQuery();
  assert.deepEqual(await keyframes(fixture.database, videoId), [], 'Cancellation after the cancellation-independent prune does not restore stale keyframes.');
  assert.deepEqual((await fixture.database.rows('BaseItems', { where: { Id: videoId } }))[0], before);
  assert.equal(fixture.state.calls, 0);

  // Cancellation preserves the live BeforeSave mutation even though the
  // repository row was not saved. Start the independent prune failure with
  // the actual cold row whose stored file date still requires invalidation.
  fixture.library.itemCreation.unregisterItem(videoId);
  await fixture.linkedChildren.flushReleases();
  await fixture.library.itemCreation.withItem(videoId, item => {
    assert.equal(dateTicks(item.DateModified), dateTicks(before.DateModified));
  });
  await fixture.database.insert('KeyframeData', { ItemId: videoId, ...oldKeyframes });
  await failKeyframeDelete(fixture.database, 'injected BeforeSave persistence failure');
  await assert.rejects(host.refresh(videoId, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None' }), /injected BeforeSave persistence failure/u);
  assert.equal((await keyframes(fixture.database, videoId)).length, 1, 'A failed prune transaction restores the prior keyframe row.');
  assert.deepEqual((await fixture.database.rows('BaseItems', { where: { Id: videoId } }))[0], before);
  assert.equal(fixture.state.calls, 0);
});

test('confirmed video refresh invalidates stored keyframes on PostgreSQL', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const fixture = await setup(t);

  await fixture.service.refresh(videoId, { force: true });
  assert.equal((await keyframes(fixture.database, videoId)).length, 1, 'An unchanged forced video probe retains its timeline.');

  await fixture.service.refresh(audioId, { force: true });
  assert.equal((await keyframes(fixture.database, audioId)).length, 1, 'Audio source changes do not prune video keyframe data.');

  const dateBeforeFailedProbe = (await fixture.database.rows('BaseItems', { where: { Id: videoId } }))[0].DateModified;
  await fixture.adapter.write('/video.mkv', Buffer.from('changed isolated video fixture'), { modified: changedDate });
  fixture.state.mode = 'failure';
  await assert.rejects(fixture.service.refresh(videoId, { force: true }), /injected probe failure/u);
  assert.deepEqual(await keyframes(fixture.database, videoId), [], 'Native pre-provider invalidation survives a later probe failure.');
  assert.equal((await fixture.database.rows('BaseItems', { where: { Id: videoId } }))[0].DateModified, dateBeforeFailedProbe,
    'The independent invalidation commit does not claim that the failed probe persisted media fields.');
  await fixture.database.insert('KeyframeData', { ItemId: videoId, ...oldKeyframes });

  fixture.state.mode = 'wait';
  fixture.state.calls = 0;
  fixture.state.entered = deferred();
  fixture.state.release = deferred();
  const owner = fixture.service.refresh(videoId, { force: true });
  await fixture.state.entered.promise;
  const follower = fixture.service.refresh(videoId);
  fixture.state.release.resolve();
  const [ownerResult, followerResult] = await Promise.all([owner, follower]);
  assert.equal(ownerResult.changed, true);
  assert.equal(followerResult.reason, 'unchanged-version');
  assert.equal(fixture.state.calls, 1, 'Concurrent callers share one source refresh.');
  assert.deepEqual(await keyframes(fixture.database, videoId), []);

  const source = structuredClone(hlsReference.source);
  source.Id = videoId.replaceAll('-', '');
  source.Path = 'Z:\\media\\video.mkv';
  const playback = new PlaybackService({
    getEncodingOptions: () => defaultConfiguration('encoding'),
    library: {
      store: fixture.store,
      getItemRecord: async () => ({ Id: videoId, MediaType: 'Video' }),
      getMediaSources: async () => [source]
    },
    hls: { getEncodingOptions: () => ({ AllowOnDemandMetadataBasedKeyframeExtractionForExtensions: ['mkv'] }), initialize: async () => true }
  });
  const sourceId = source.Id;
  const manifest = await renderManifest(t, await playback.hlsStream(videoId, 'main', { MediaSourceId: sourceId, VideoCodec: 'copy', AudioCodec: 'copy',
    SegmentContainer: 'ts', SegmentLength: 6, QueryString: `MediaSourceId=${sourceId}&SegmentContainer=ts` }));
  assert.match(manifest, /#EXT-X-TARGETDURATION:6\r\n/u);
  assert.equal((manifest.match(/#EXTINF:/gu) ?? []).length, 6);
  assert.doesNotMatch(manifest, /#EXTINF:10\.427000/u, 'A new HLS request cannot observe the deleted timeline.');
});

test('keyframe invalidation precedes cancellation and blocks probing on PostgreSQL persistence failure', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const fixture = await setup(t);
  await fixture.adapter.write('/video.mkv', Buffer.from('changed isolated video fixture'), { modified: changedDate });
  const before = (await fixture.database.rows('BaseItems', { where: { Id: videoId } }))[0];
  fixture.state.calls = 0;

  const controller = new AbortController();
  const restoreQuery = abortAfterKeyframeDelete(fixture.database, controller);
  await assert.rejects(fixture.service.refresh(videoId, { force: true, signal: controller.signal }), { code: 'cancelled' });
  restoreQuery();
  assert.deepEqual((await fixture.database.rows('BaseItems', { where: { Id: videoId } }))[0], before);
  assert.deepEqual(await keyframes(fixture.database, videoId), [], 'Caller cancellation after invalidation does not restore the stale timeline.');
  assert.equal(fixture.state.calls, 0, 'Cancellation observed after invalidation prevents the probe from starting.');

  await fixture.database.insert('KeyframeData', { ItemId: videoId, ...oldKeyframes });
  await failKeyframeDelete(fixture.database, 'injected keyframe persistence failure');
  await assert.rejects(fixture.service.refresh(videoId, { force: true }), /injected keyframe persistence failure/u);
  assert.deepEqual((await fixture.database.rows('BaseItems', { where: { Id: videoId } }))[0], before);
  assert.equal((await keyframes(fixture.database, videoId)).length, 1, 'A failed invalidation transaction restores the timeline.');
  assert.equal(fixture.state.calls, 0, 'The probe does not run after invalidation fails.');
});
