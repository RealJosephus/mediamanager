import { validationExecutable } from '../../tools/validation/paths.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { createRuntime } from '../../src/runtime.js';
import { IdentityAccessMap } from '../../src/storage/index.js';
import { extractionFixture } from './extraction-fixture.js';
import reference from './fixtures/hls-reference.json' with { type: 'json' };
import lifecycle from './fixtures/hls-lifecycle-reference.json' with { type: 'json' };
import masterVariants from './fixtures/hls-master-reference.json' with { type: 'json' };
import sessionReference from './fixtures/hls-session-reference.json' with { type: 'json' };
import library from '../library/fixtures/reference-media.json' with { type: 'json' };
import { hlsManifestProjection } from './layout-projection.js';
import { readDeliveredHlsLayouts } from './hls-layout-reader.js';
import { observeComparison } from '../comparison-observations.js';
import { assertValidationOutputChild } from '../../tools/validation/paths.js';

const id = '22222222222222222222222222222222';
const headersOf = response => ({ status: response.status, headers: Object.fromEntries(['content-type', 'content-length', 'accept-ranges', 'expires', 'cache-control', 'etag', 'last-modified'].map(key => [key, response.headers.get(key)])) });
const projection = probe => ({ streams: probe.streams?.map(value => Object.fromEntries(['codec_name', 'profile', 'width', 'height', 'pix_fmt', 'sample_rate', 'channels'].filter(key => value[key] != null).map(key => [key, value[key]]))),
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

test('native HLS manifest semantics, reader delivery, copy packets, seek and task lifecycle on PostgreSQL', { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const schema = `hls_http_${randomBytes(8).toString('hex')}`;
  const fixture = await extractionFixture({ '/source.mkv': Buffer.from(reference.media, 'base64') });
  fixture.identityMap = new IdentityAccessMap(); fixture.identityMap.addPrefix({ identityRoot: 'Z:\\Hls', accessRoot: '/', style: 'windows', returnAccess: 'Isolated HTTP fixture.' });
  const directory = await mkdtemp(path.join(tmpdir(), 'mediamanager-hls-test-')), processes = [], errors = [];
  let database, runtime;
  try {
    database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
    await seed(database);
    runtime = await createRuntime({ database, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, serverId: library.serverId, programDataPath: library.programDataPath,
      vfs: fixture.vfs, identityMap: fixture.identityMap, hlsOptions: { onProcess: entry => processes.push(entry.args), cacheDirectory: directory,
        // This frozen HTTP recording covers the native equal-segment branch.
        // On-demand Matroska VFS extraction has its own SQLite/PostgreSQL test.
        encodingOptions: { EnableSegmentDeletion: false, SegmentKeepSeconds: 720, AllowOnDemandMetadataBasedKeyframeExtractionForExtensions: [] } },
      onError: error => errors.push({ message: error.message, code: error.code, details: error.details }) });
    const user = await runtime.users.createUser({ Name: 'HlsReader', Password: 'isolated-hls-password' });
    const policy = { ...library.user.Policy, EnableAudioPlaybackTranscoding: false, EnableVideoPlaybackTranscoding: false, EnablePlaybackRemuxing: true };
    await runtime.users.updatePolicy(user.Id, policy);
    await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${runtime.server.address().port}`;
    const login = await fetch(origin + '/Users/AuthenticateByName', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'MediaBrowser Client="HLS Fixture", Device="Isolated", DeviceId="hls-fixture", Version="1"' }, body: JSON.stringify({ Username: 'HlsReader', Pw: 'isolated-hls-password' }) });
    assert.equal(login.status, 200); const token = (await login.json()).AccessToken;
    const headers = { Authorization: `MediaBrowser Token="${token}"`, 'Content-Type': 'application/json' };
    const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'PlaySessionId').map(([key, value]) => [key, normalize(value)]))
      : typeof value === 'string' ? value.replaceAll(token, '<token>').replace(/PlaySessionId=[^&\r\n]+/g, 'PlaySessionId=<session>') : value;
    const info = async entry => { const response = await fetch(origin + `/Items/${id}/PlaybackInfo`, { method: 'POST', headers, body: JSON.stringify({ DeviceProfile: entry.profile, MediaSourceId: id, ...entry.options }) }); return { status: response.status, body: await response.json() }; };
    let lastSegment, lastBytes;
    for (const expected of reference.records) {
      const entry = reference.profiles.find(value => value.name === expected.name), actualInfo = await info(entry);
      assert.deepEqual(normalize(actualInfo), expected.info, expected.name + ' PlaybackInfo');
      const masterUrl = origin + actualInfo.body.MediaSources[0].TranscodingUrl, playSessionId = actualInfo.body.PlaySessionId;
      const master = await fetch(masterUrl, { headers }), masterText = await master.text();
      const compareManifest = (response, text, wanted, label) => {
        const actual = { ...headersOf(response), text: normalize(text) };
        observeComparison(t, label + ' raw manifest', actual, wanted);
        assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(text));
        const project = ({ text, headers, ...value }) => {
          const { 'content-length': ignoredLength, ...remainingHeaders } = headers;
          return { ...value, headers: remainingHeaders, text: hlsManifestProjection(text) };
        };
        assert.deepEqual(project(actual), project(wanted), label);
      };
      compareManifest(master, masterText, expected.master, expected.name + ' master');
      assert.deepEqual(headersOf(await fetch(masterUrl, { headers, method: 'HEAD' })), expected.head);
      const variant = masterText.split(/\r?\n/).find(line => line && !line.startsWith('#')), mainUrl = new URL(variant, masterUrl);
      const main = await fetch(mainUrl, { headers }), mainText = await main.text();
      compareManifest(main, mainText, expected.main, expected.name + ' main');
      assert.equal(runtime.hls.hasJob(playSessionId), false, 'Manifests must not start a process.');
      let init = Buffer.alloc(0);
      for (const segment of expected.segments) {
        const url = new URL(segment.url.replaceAll('<token>', token).replaceAll('<session>', playSessionId), mainUrl);
        const response = await fetch(url, { headers }), bytes = Buffer.from(await response.arrayBuffer()), actualHeaders = headersOf(response);
        assert.equal(response.status, segment.status, `${expected.name} ${url.pathname}: ${JSON.stringify(errors)}`);
        assert.ok(Number.isFinite(Date.parse(actualHeaders.headers['last-modified']))); actualHeaders.headers['last-modified'] = '<date>';
        assert.deepEqual(actualHeaders, { status: segment.status, headers: segment.headers }, expected.name + ' ' + url.pathname);
        assert.equal(bytes.length, segment.size);
        if (url.pathname.endsWith('/-1.mp4')) { init = bytes; continue; }
        const file = path.join(directory, expected.name + '-' + path.basename(url.pathname)); await writeFile(file, Buffer.concat([init, bytes]));
        const probe = spawnSync(validationExecutable('ffprobe'), ['-v', 'error', '-show_streams', '-show_packets', '-show_data_hash', 'sha256', '-of', 'json', file], { windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
        assert.equal(probe.status, 0, probe.stderr); const result = JSON.parse(probe.stdout);
        assert.equal(result.packets.length, segment.packetCount, expected.name + ' packet count');
        assert.equal(createHash('sha256').update(JSON.stringify(projection(result))).digest('hex'), segment.packetHash, expected.name + ' packet hash');
        lastSegment = url; lastBytes = bytes;
      }
      assert.equal(runtime.hls.hasJob(playSessionId), true);
      if (expected === reference.records[0]) {
        let output;
        const requests = [], observeRequest = (request, response) => {
          const entry = { url: request.url, method: request.method, userAgent: request.headers['user-agent'], range: request.headers.range, receivedAt: Date.now() }; requests.push(entry);
          response.once('finish', () => Object.assign(entry, { status: response.statusCode, length: response.getHeader('Content-Length'), finishedAt: Date.now() }));
        };
        runtime.server.prependListener('request', observeRequest);
        if (process.env.MEDIAMANAGER_HLS_LAYOUT_EVIDENCE) {
          output = assertValidationOutputChild(path.resolve(process.env.MEDIAMANAGER_HLS_LAYOUT_EVIDENCE)); await mkdir(output, { recursive: false });
        }
        let proof;
        try {
          proof = await readDeliveredHlsLayouts({ masterText, masterUrl, mainText, mainUrl, processCount: () => processes.length,
            onObservation: async observed => {
              if (output) await writeFile(path.join(output, 'reader-delivery.json'), JSON.stringify({ ...observed, runtimeRequests: requests }, null, 2), { flag: 'wx' });
            } });
        } finally { runtime.server.removeListener('request', observeRequest); }
        assert.equal(proof.serverStopped, true);
        const segmentRequests = requests.filter(entry => entry.url.includes('/hls1/'));
        assert.ok(segmentRequests.some((entry, index) => segmentRequests.slice(index + 1)
          .some(other => other.receivedAt < entry.finishedAt)), 'The actual reader overlaps segment requests.');
        assert.ok(segmentRequests.every(entry => entry.status === 206 && entry.finishedAt != null && Number(entry.length) > 0));
        assert.equal(runtime.hls.hasJob(playSessionId), true);
        for (const result of proof.results) {
          const baseline = proof.results.find(entry => entry.path === result.path && entry.layout === 'base');
          const value = entry => ({ packetHash: entry.packetHash, packetCount: entry.packetCount });
          observeComparison(t, result.path + '/' + result.layout + ' target reader', value(result), value(baseline));
        }
      }
      assert.equal((await fetch(origin + `/Sessions/Playing/Ping?playSessionId=${playSessionId}`, { method: 'POST', headers })).status, expected.ping);
      const range = await fetch(lastSegment, { headers: { ...headers, Range: 'bytes=10-99' } });
      assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), lastBytes.subarray(10, 100));
      assert.equal((await fetch(origin + `/Videos/ActiveEncodings?deviceId=hls-fixture&playSessionId=${playSessionId}`, { method: 'DELETE', headers })).status, expected.stop);
      assert.equal(runtime.hls.hasJob(playSessionId), false);
    }
    for (const name of ['no-video-copy', 'wrong-codec']) assert.equal((await info(reference.profiles.find(value => value.name === name))).body.MediaSources[0].SupportsTranscoding, false);
    const currentInfo = await info(reference.profiles[0]), sessionId = currentInfo.body.PlaySessionId;
    const masterUrl = origin + currentInfo.body.MediaSources[0].TranscodingUrl;
    for (const expected of masterVariants) {
      const url = new URL(masterUrl);
      for (const [key, value] of Object.entries(expected.changes)) { if (value == null) url.searchParams.delete(key); else url.searchParams.set(key, value); }
      const response = await fetch(url, { headers });
      assert.equal(response.status, expected.status, expected.name);
      const text = await response.text();
      assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(text));
      assert.deepEqual(hlsManifestProjection(normalize(text)), hlsManifestProjection(expected.text), expected.name);
    }
    const mainUrl = new URL((await (await fetch(masterUrl, { headers })).text()).split(/\r?\n/).find(line => line && !line.startsWith('#')), masterUrl);
    const segmentUrl = new URL((await (await fetch(mainUrl, { headers })).text()).split(/\r?\n/).find(line => line && !line.startsWith('#')), mainUrl);
    const full = await fetch(segmentUrl, { headers }), date = full.headers.get('last-modified'); await full.arrayBuffer();
    const cases = [['head-main', mainUrl, { method: 'HEAD' }], ['head-segment', segmentUrl, { method: 'HEAD' }]];
    for (const [name, extra] of [['range', { Range: 'bytes=10-99' }], ['suffix', { Range: 'bytes=-32' }], ['beyond', { Range: 'bytes=999999999-' }], ['zero', { Range: 'bytes=-0' }], ['reversed', { Range: 'bytes=100-10' }], ['multiple', { Range: 'bytes=0-9,20-30' }], ['malformed', { Range: 'nonsense' }],
      ['if-range-current', { Range: 'bytes=0-9', 'If-Range': date }], ['if-range-old', { Range: 'bytes=0-9', 'If-Range': 'Sat, 01 Jan 2000 00:00:00 GMT' }], ['modified-current', { 'If-Modified-Since': date }], ['modified-future', { 'If-Modified-Since': 'Fri, 01 Jan 2100 00:00:00 GMT' }], ['unmodified-old', { 'If-Unmodified-Since': 'Sat, 01 Jan 2000 00:00:00 GMT' }], ['if-none-match', { 'If-None-Match': '*' }], ['if-match', { 'If-Match': '*' }]]) cases.push([name, segmentUrl, { headers: { ...headers, ...extra } }]);
    const missing = new URL(segmentUrl); missing.searchParams.delete('runtimeTicks'); missing.searchParams.delete('actualSegmentLengthTicks'); cases.push(['missing-ticks', missing]);
    const forbidden = new URL(segmentUrl); forbidden.searchParams.set('StartTimeTicks', '1'); cases.push(['forbidden-start', forbidden]);
    cases.push(['stop-missing-device', origin + '/Videos/ActiveEncodings?playSessionId=' + sessionId, { method: 'DELETE' }]);
    for (const [name, url, init] of cases) {
      const expected = lifecycle.find(value => value.name === name), response = await fetch(url, { headers, ...init }), bytes = Buffer.from(await response.arrayBuffer());
      const actual = { name, status: response.status, headers: Object.fromEntries(Object.keys(expected.headers).map(key => [key, response.headers.get(key)])), size: bytes.length };
      if (actual.headers['last-modified']) actual.headers['last-modified'] = '<date>';
      if (expected.body != null) { actual.body = typeof expected.body === 'object' ? JSON.parse(bytes.toString()) : bytes.toString(); if (actual.body?.traceId) delete actual.body.traceId; }
      assert.deepEqual(actual, expected, name);
    }
    const other = await runtime.users.createUser({ Name: 'HlsOther', Password: 'other-password' });
    await runtime.users.updatePolicy(other.Id, { ...policy, IsAdministrator: false });
    const otherLogin = await (await fetch(origin + '/Users/AuthenticateByName', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'MediaBrowser Client="HLS Other", Device="Other", DeviceId="other-device", Version="1"' }, body: JSON.stringify({ Username: 'HlsOther', Pw: 'other-password' }) })).json();
    const otherHeaders = { Authorization: `MediaBrowser Token="${otherLogin.AccessToken}"`, 'Content-Type': 'application/json' }, otherUrl = new URL(segmentUrl); otherUrl.searchParams.delete('ApiKey');
    let processCount = processes.length;
    const shared = await fetch(otherUrl, { headers: otherHeaders }); assert.equal(shared.status, 200); await shared.arrayBuffer();
    assert.equal(processes.length, processCount, 'Native HLS cache identity is shared between authorized users.');
    await runtime.users.updatePolicy(other.Id, { ...policy, IsAdministrator: false, EnableMediaPlayback: false, EnablePlaybackRemuxing: false });
    const disabled = await fetch(otherUrl, { headers: otherHeaders }); assert.equal(disabled.status, 200); await disabled.arrayBuffer();
    await runtime.users.updatePolicy(other.Id, { ...policy, IsAdministrator: false, EnableAllFolders: false, EnabledFolders: [] });
    const hidden = await fetch(otherUrl, { headers: otherHeaders }); assert.equal(hidden.status, 200); await hidden.arrayBuffer();
    assert.equal((await fetch(origin + '/Videos/ActiveEncodings?deviceId=wrong&playSessionId=' + sessionId, { method: 'DELETE', headers: otherHeaders })).status, 204);
    assert.equal(runtime.hls.hasJob(sessionId), false);
    await (await fetch(segmentUrl, { headers })).arrayBuffer();
    const report = { ItemId: id, MediaSourceId: id, PlaySessionId: sessionId, PlayMethod: 'Transcode', PositionTicks: 10000000 };
    assert.equal((await fetch(origin + '/Sessions/Playing', { method: 'POST', headers, body: JSON.stringify(report) })).status, 204);
    let sessions = await (await fetch(origin + '/Sessions', { headers })).json();
    assert.equal(sessions.find(session => session.DeviceId === 'hls-fixture').PlayState.PlayMethod, 'Transcode');
    const actualTranscodingInfo = sessions.find(session => session.DeviceId === 'hls-fixture').TranscodingInfo;
    const expectedTranscodingInfo = sessionReference.find(value => value.name === 'after-copy').TranscodingInfo;
    const { Framerate, CompletionPercentage, ...stableTranscodingInfo } = actualTranscodingInfo;
    assert.deepEqual(stableTranscodingInfo, expectedTranscodingInfo);
    if (Object.hasOwn(actualTranscodingInfo, 'Framerate')) {
      assert.equal(typeof Framerate, 'number');
      assert.ok(Number.isFinite(Framerate) && Framerate >= 0);
    }
    if (Object.hasOwn(actualTranscodingInfo, 'CompletionPercentage')) {
      assert.equal(typeof CompletionPercentage, 'number');
      assert.ok(Number.isFinite(CompletionPercentage) && CompletionPercentage >= 0);
    }
    assert.equal((await fetch(origin + '/Sessions/Playing/Progress', { method: 'POST', headers, body: JSON.stringify({ ...report, IsPaused: true }) })).status, 204);
    assert.equal(runtime.hls.hasJob(sessionId), true);
    assert.equal((await fetch(origin + '/Videos/ActiveEncodings?deviceId=another-device&playSessionId=' + sessionId.toUpperCase(), { method: 'DELETE', headers })).status, 204);
    assert.equal(runtime.hls.hasJob(sessionId), false, 'The native stop operation selects a play session across devices.');
    await (await fetch(segmentUrl, { headers })).arrayBuffer();
    assert.equal((await fetch(origin + '/Sessions/Playing/Stopped', { method: 'POST', headers, body: JSON.stringify(report) })).status, 204);
    assert.equal(runtime.hls.hasJob(sessionId), false);
    await fetch(origin + '/Sessions/Playing', { method: 'POST', headers, body: JSON.stringify(report) });
    sessions = await (await fetch(origin + '/Sessions', { headers })).json();
    assert.equal(sessions.find(session => session.DeviceId === 'hls-fixture').PlayState.PlayMethod, 'DirectPlay');
    assert.equal(sessions.find(session => session.DeviceId === 'hls-fixture').TranscodingInfo, undefined);
    const reads = fixture.requests.length;
    assert.equal((await fetch(lastSegment.origin + lastSegment.pathname)).status, 401);
    for (const query of ['VideoCodec=hevc', 'AllowAudioStreamCopy=false', 'MaxWidth=64', 'SegmentLength=0', 'SubtitleStreamIndex=0&SubtitleMethod=Encode']) {
      assert.equal((await fetch(origin + `/Videos/${id}/master.m3u8?${query}`, { headers })).status, 400, query);
    }
    assert.equal(fixture.requests.length, reads);
    assert.ok(processes.length >= reference.records.length);
    for (const args of processes) {
      assert.equal(args[args.indexOf('-codec:v:0') + 1], 'copy'); assert.equal(args[args.indexOf('-codec:a:0') + 1], 'copy');
      assert.ok(!args.includes('-vf') && !args.includes('-af')); assert.equal(args[args.indexOf('-i') + 1], '[private source]');
    }
  } finally {
    await runtime?.close(); await fixture.close();
    const cleanup = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema });
    try { await cleanup.client.query(`DROP SCHEMA IF EXISTS "${schema}", "${schema}__mm" CASCADE`); } finally { await cleanup.close(); }
    if (runtime) {
      assert.equal(runtime.server.listening, false);
      assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('mediamanager-hls-')), []);
    }
    assert.equal(path.dirname(directory), tmpdir()); await rm(directory, { recursive: true, force: true });
  }
});
