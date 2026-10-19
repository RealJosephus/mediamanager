import { createPlaybackState } from './runtime-state.js';
import { validationExecutable } from '../../tools/validation/paths.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { createRuntime } from '../../src/runtime.js';
import { IdentityAccessMap } from '../../src/storage/index.js';
import { extractionFixture } from './extraction-fixture.js';
import { probeStreamRow } from '../../src/library/probe-service.js';
import reference from './fixtures/remux-reference.json' with { type: 'json' };
import extracted from './fixtures/extraction-reference.json' with { type: 'json' };
import library from '../library/fixtures/reference-media.json' with { type: 'json' };

const itemId = '22222222-2222-2222-2222-222222222222';
const id = itemId.replaceAll('-', '');
const headersOf = response => ({ status: response.status, contentType: response.headers.get('content-type'), acceptRanges: response.headers.get('accept-ranges'), length: response.headers.get('content-length') });
const packetProjection = probe => ({ streams: probe.streams?.map(value => Object.fromEntries(['codec_name', 'profile', 'width', 'height', 'pix_fmt', 'sample_rate', 'channels'].filter(key => value[key] != null).map(key => [key, value[key]]))),
  packets: probe.packets?.map(value => Object.fromEntries(['stream_index', 'pts_time', 'dts_time', 'duration_time', 'size', 'data_hash', 'flags'].filter(key => value[key] != null).map(key => [key, value[key]]))) });
async function seed(database) {
  for (const [table, rows] of Object.entries(reference.tables)) {
    const columns = tableDefinition(table).columns, pending = [...rows], inserted = new Set();
    while (pending.length) {
      const index = table === 'BaseItems' ? pending.findIndex(row => [row.ParentId, row.OwnerId].every(value => !value || inserted.has(value))) : 0;
      assert.notEqual(index, -1);
      const [row] = pending.splice(index, 1);
      await database.insert(table, Object.fromEntries(Object.entries(row).map(([name, value]) => [name, value != null && typeof value === 'string' && columns.find(column => column.name === name)?.type === 'INTEGER' ? BigInt(value) : value])));
      inserted.add(row.Id);
    }
  }
}
async function eventually(condition) { for (let index = 0; index < 300; index++) { if (condition()) return; await delay(10); } assert.fail('Expected the asynchronous operation to finish.'); }

test('native progressive remux HTTP, packet hashes, multi-version access and cancellation on PostgreSQL', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async () => {
  const schema = `remux_http_${randomBytes(8).toString('hex')}`;
  const fixture = await extractionFixture(Object.fromEntries(reference.sources.map(source => ['/' + source.name, Buffer.from(source.media, 'base64')])));
  fixture.identityMap = new IdentityAccessMap();
  fixture.identityMap.addPrefix({ identityRoot: 'Z:\\Remux', accessRoot: '/', style: 'windows', returnAccess: 'Isolated HTTP fixture.' });
  const directory = await mkdtemp(path.join(tmpdir(), 'mediamanager-remux-'));
  const processes = [];
  const state = await createPlaybackState();
  let database, runtime;
  try {
    database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
    await seed(database);
    runtime = await createRuntime({ database, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, serverId: library.serverId, programDataPath: state.root,
      vfs: fixture.vfs, identityMap: fixture.identityMap, remuxOptions: { onProcess: entry => processes.push(entry.args), maxConcurrentRemuxes: 1 }, onError: () => {} });
    const user = await runtime.users.createUser({ Name: 'RemuxReader', Password: 'isolated-remux-password' });
    const policy = { ...library.user.Policy, EnableAudioPlaybackTranscoding: false, EnableVideoPlaybackTranscoding: false, EnablePlaybackRemuxing: true };
    await runtime.users.updatePolicy(user.Id, policy);
    await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${runtime.server.address().port}`;
    const login = await fetch(origin + '/Users/AuthenticateByName', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'MediaBrowser Client="Remux Fixture", Device="Isolated", DeviceId="remux-fixture", Version="1"' }, body: JSON.stringify({ Username: 'RemuxReader', Pw: 'isolated-remux-password' }) });
    assert.equal(login.status, 200);
    const token = (await login.json()).AccessToken, headers = { Authorization: `MediaBrowser Token="${token}"`, 'Content-Type': 'application/json' };
    const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'PlaySessionId').map(([key, value]) => [key, normalize(value)])) : typeof value === 'string' ? value.replaceAll(token, '<token>').replace(/PlaySessionId=[^&]+/g, 'PlaySessionId=<session>') : value;
    const info = async (entry, sourceId = id) => {
      const response = await fetch(origin + `/Items/${sourceId}/PlaybackInfo`, { method: 'POST', headers, body: JSON.stringify({ DeviceProfile: entry.profile, MediaSourceId: sourceId, ...entry.options }) });
      assert.equal(response.status, 200); return response.json();
    };
    let remuxUrl;
    for (const expected of reference.http) {
      const entry = reference.profiles.find(value => value.name === expected.name);
      if (entry.mediaType === 'Audio') {
        assert.deepEqual(normalize(await info(entry, expected.body.MediaSources[0].Id)), reference.audioDisabled);
        await runtime.users.updatePolicy(user.Id, { ...policy, EnableAudioPlaybackTranscoding: true });
      }
      const body = await info(entry, expected.body.MediaSources[0].Id);
      assert.deepEqual(normalize(body), expected.body, expected.name + ' PlaybackInfo');
      const url = body.MediaSources[0].TranscodingUrl; remuxUrl ??= url;
      const beforeHead = processes.length, beforeReads = fixture.requests.length;
      assert.deepEqual(headersOf(await fetch(origin + url, { method: 'HEAD', headers })), expected.head);
      assert.equal(processes.length, beforeHead); assert.equal(fixture.requests.length, beforeReads, 'HEAD must not open the input.');
      const response = await fetch(origin + url, { headers });
      assert.deepEqual(headersOf(response), expected.headers);
      const file = path.join(directory, expected.name + '.' + body.MediaSources[0].TranscodingContainer);
      await writeFile(file, Buffer.from(await response.arrayBuffer()));
      const probe = spawnSync(validationExecutable('ffprobe'), ['-v', 'error', '-show_streams', '-show_packets', '-show_data_hash', 'sha256', '-of', 'json', file], { windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      assert.equal(probe.status, 0, probe.stderr);
      const result = JSON.parse(probe.stdout);
      assert.equal(result.packets.length, expected.packetCount);
      assert.equal(createHash('sha256').update(JSON.stringify(packetProjection(result))).digest('hex'), expected.packetHash, expected.name + ' native packet timeline and bytes');
      if (entry.mediaType === 'Audio') await runtime.users.updatePolicy(user.Id, policy);
    }
    for (const name of ['no-video-copy', 'no-audio-copy', 'wrong-codec', 'bitrate']) {
      const body = await info(reference.profiles.find(value => value.name === name));
      assert.equal(body.MediaSources[0].SupportsTranscoding, false, name); assert.equal(body.MediaSources[0].TranscodingUrl, undefined);
    }
    const reads = fixture.requests.length;
    assert.equal((await fetch(origin + `/Videos/${id}/stream.mp4`)).status, 401);
    for (const parameters of ['VideoCodec=hevc', 'AllowAudioStreamCopy=false', 'MaxWidth=64', 'SubtitleStreamIndex=0&SubtitleMethod=Encode', 'StartTimeTicks=-1', 'h264-level=1', 'aac-profile=HE', 'h264-rangetype=HDR10']) {
      assert.equal((await fetch(origin + `/Videos/${id}/stream.mp4?${parameters}`, { headers })).status, 400, parameters);
    }
    assert.equal(fixture.requests.length, reads, 'Rejected requests must not reach VFS.');
    await runtime.users.updatePolicy(user.Id, { ...policy, EnablePlaybackRemuxing: false });
    assert.equal((await fetch(origin + remuxUrl, { headers })).status, 403);
    assert.equal((await info(reference.profiles[0])).MediaSources[0].SupportsTranscoding, false);
    await runtime.users.updatePolicy(user.Id, policy);

    // A selected version supplies its own path and streams and must pass visibility checks.
    const alternateId = '77777777-7777-7777-7777-777777777777', alternate = alternateId.replaceAll('-', '');
    const primary = (await database.rows('BaseItems', { where: { Id: itemId } }))[0];
    await database.insert('BaseItems', { ...primary, Id: alternateId, Path: 'Y:\\Original\\version.mkv', Tags: 'restricted-version', Data: JSON.stringify({ ...JSON.parse(primary.Data), PrimaryVersionId: itemId }) });
    fixture.identityMap.bind(alternateId, '/version.mkv');
    await database.insert('LinkedChildren', { ParentId: itemId, ChildId: alternateId, ChildType: 2, SortOrder: 0 });
    fixture.replace('/version.mkv', Buffer.from(extracted.sources[0].media, 'base64'));
    for (const stream of extracted.sources[0].source.MediaStreams) await database.insert('MediaStreamInfos', probeStreamRow(alternateId, stream));
    for (const stream of extracted.sources[0].source.MediaAttachments) await database.insert('AttachmentStreamInfos', Object.fromEntries(tableDefinition('AttachmentStreamInfos').columns.map(column => [column.name, ({ ...stream, ItemId: alternateId, Filename: stream.FileName })[column.name] ?? null])));
    const versionPaths = [`/Videos/${id}/stream.mkv?static=true&mediaSourceId=${alternate}`, `/Videos/${id}/${alternate}/Subtitles/1/0/Stream.srt`, `/Videos/${id}/${alternate}/Attachments/3`];
    for (const url of versionPaths) { const response = await fetch(origin + url, { headers }); assert.equal(response.status, 200, url); await response.arrayBuffer(); }
    // Use the AV version for a genuine remux and the extraction version for subtitle/attachment reads.
    for (const row of await database.rows('MediaStreamInfos', { where: { ItemId: alternateId } })) await database.delete('MediaStreamInfos', { ItemId: alternateId, StreamIndex: row.StreamIndex });
    for (const stream of reference.sources[0].source.MediaStreams) await database.insert('MediaStreamInfos', probeStreamRow(alternateId, stream));
    fixture.replace('/version.mkv', Buffer.from(reference.sources[0].media, 'base64'));
    const selectedRemux = `/Videos/${id}/stream.mp4?mediaSourceId=${alternate}`;
    const selectedResponse = await fetch(origin + selectedRemux, { headers }); assert.equal(selectedResponse.status, 200); await selectedResponse.arrayBuffer();
    assert.ok(fixture.requests.some(request => request.path === '/version.mkv' && request.method === 'GET'));
    await runtime.users.updatePolicy(user.Id, { ...policy, BlockedTags: ['restricted-version'] });
    const restrictedReads = fixture.requests.length;
    for (const url of [...versionPaths, selectedRemux]) assert.equal((await fetch(origin + url, { headers })).status, 404, url);
    const unavailable = await fetch(origin + `/Items/${id}/PlaybackInfo`, { method: 'POST', headers, body: JSON.stringify({ DeviceProfile: reference.profiles[0].profile, MediaSourceId: alternate }) });
    assert.deepEqual(await unavailable.json(), { MediaSources: [], ErrorCode: 'NoCompatibleStream' });
    assert.equal(fixture.requests.length, restrictedReads, 'Restricted versions must not open storage or extraction caches.');

    fixture.setDelay(1000);
    const controller = new AbortController(), getCount = fixture.requests.filter(request => request.method === 'GET').length;
    const pending = fetch(origin + remuxUrl, { headers, signal: controller.signal });
    const cancelled = assert.rejects(pending, { name: 'AbortError' });
    await eventually(() => fixture.requests.filter(request => request.method === 'GET').length > getCount);
    assert.equal((await fetch(origin + remuxUrl, { headers })).status, 429);
    controller.abort(); await cancelled;
    await eventually(() => fixture.closedReads > 0);
    await delay(50);
    const timeoutMs = runtime.remux.timeoutMs;
    runtime.remux.timeoutMs = 100;
    assert.equal((await fetch(origin + remuxUrl, { headers })).status, 504, 'The whole read must obey the remux timeout.');
    runtime.remux.timeoutMs = timeoutMs;
    fixture.setDelay(0);
    const resumed = await fetch(origin + remuxUrl, { headers }); assert.equal(resumed.status, 200); await resumed.arrayBuffer();
    assert.ok(processes.every(args => args[args.indexOf('-c') + 1] === 'copy' && !args.some(arg => ['-vf', '-af', '-filter_complex'].includes(arg))));
    assert.equal(fixture.requests.some(request => request.authorization), false);
    fixture.setDelay(1000);
    const beforeShutdown = fixture.requests.filter(request => request.method === 'GET').length;
    const draining = fetch(origin + remuxUrl, { headers }).then(response => response.arrayBuffer()).catch(() => undefined);
    await eventually(() => fixture.requests.filter(request => request.method === 'GET').length > beforeShutdown);
    await runtime.remux.close(); await draining;
    assert.equal(runtime.remux.supports(reference.sources[0].source, { Container: 'mp4' }), false);
  } finally {
    if (database) { await database.client.query(`DROP SCHEMA "${schema}" CASCADE`); await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`); }
    if (runtime) await runtime.close(); else await database?.close();
    await fixture.close(); await state.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('mediamanager-remux-'));
    await rm(directory, { recursive: true, force: true });
  }
});
