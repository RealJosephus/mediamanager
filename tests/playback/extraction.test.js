import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ExtractionService, buildExtractionArguments, subtitleInputIndex } from '../../src/playback/extraction.js';
import { ProbeReadBridge } from '../../src/storage/probe-bridge.js';
import { negotiateSource } from '../../src/playback/profile.js';
import { extractionFixture } from './extraction-fixture.js';
import reference from './fixtures/extraction-reference.json' with { type: 'json' };
import profileInput from './fixtures/oracle-input.json' with { type: 'json' };
import profileOracle from './fixtures/oracle-output.json' with { type: 'json' };

const files = () => Object.fromEntries(reference.sources.map(value => ['/' + value.name, Buffer.from(value.media, 'base64')]));
const source = reference.sources[0].source;
const subtitle = source.MediaStreams.find(value => value.Type === 'Subtitle');
async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(10); }
  assert.fail('The expected extraction state was not reached.');
}
async function setup(t, options = {}, fixtureOptions = {}) {
  const fixture = await extractionFixture(files(), fixtureOptions);
  const processes = [];
  const service = new ExtractionService({ vfs: fixture.vfs, onProcess: entry => processes.push(entry.args), ...options });
  t.after(async () => { await service.close(); await fixture.close(); });
  assert.equal(await service.initialize(), true, 'A real ffmpeg executable is required for extraction verification.');
  return { fixture, service, processes, count: () => processes.filter(args => !args.includes('-version')).length };
}

test('real HTTP container extraction matches frozen native DLL bytes and never selects audio or video outputs', async t => {
  const { fixture, service, processes } = await setup(t);
  for (const expected of reference.outputs) {
    const entry = reference.sources.find(value => value.name === expected.source);
    const stream = (expected.type === 'subtitle' ? entry.source.MediaStreams : entry.source.MediaAttachments).find(value => value.Index === expected.index);
    const result = await service[expected.type](entry.source, stream, '/' + entry.name);
    assert.equal(result.bytes.toString('base64'), expected.bytes, `${entry.name}:${expected.index}`);
    assert.equal(result.format, expected.format);
    assert.equal(result.consistency, 'versioned');
  }
  const attachment = source.MediaAttachments[0];
  assert.match(attachment.FileName, /^\.\.\//);
  assert.equal((await service.attachment(source, attachment, '/media.mkv')).bytes.toString('base64'), reference.attachment);
  for (const args of processes.filter(args => !args.includes('-version'))) {
    assert.equal(args.includes(attachment.FileName), false);
    assert.equal(args.includes('[private source]'), true);
    assert.deepEqual(args.slice(args.indexOf('-protocol_whitelist'), args.indexOf('-protocol_whitelist') + 2), ['-protocol_whitelist', 'http,tcp']);
    if (args.includes('-map')) {
      assert.deepEqual(args.slice(args.indexOf('-c:s'), args.indexOf('-c:s') + 2), ['-c:s', 'copy']);
      assert.equal(args.includes('-vn') && args.includes('-an'), true);
    } else assert.equal(args.some(value => value.startsWith('-dump_attachment:')), true);
  }
  assert.equal(fixture.requests.filter(value => value.method === 'GET').every(value => value.range === 'bytes=0-' && value.ifMatch && !value.authorization), true);
});

test('private VFS input supports seeking and binds every read to its leased version', async t => {
  const { fixture } = await setup(t);
  const bridge = new ProbeReadBridge(fixture.vfs);
  t.after(() => bridge.close());
  const lease = await bridge.lease('/media.mkv');
  t.after(() => lease.release());
  const response = await fetch(lease.url, { headers: { Range: 'bytes=31-47' } });
  assert.equal(response.status, 206);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), files()['/media.mkv'].subarray(31, 48));
  fixture.replace('/media.mkv', files()['/media.mkv']);
  assert.equal((await fetch(lease.url, { headers: { Range: 'bytes=100-' } })).status, 412);
  assert.equal((await fetch(lease.url, { method: 'HEAD' })).status, 412);
});

test('concurrent readers share extraction while individual cancellation preserves the other result', async t => {
  const { fixture, service, count } = await setup(t);
  fixture.setDelay(200);
  const controller = new AbortController();
  const first = service.subtitle(source, subtitle, '/media.mkv', { signal: controller.signal });
  const firstCheck = assert.rejects(first, { code: 'cancelled' });
  const second = service.subtitle(source, subtitle, '/media.mkv');
  await until(() => fixture.requests.some(value => value.method === 'GET'));
  controller.abort();
  await firstCheck;
  const result = await second;
  assert.equal(result.bytes.toString('base64'), reference.outputs[0].bytes);
  assert.equal(count(), 1);
  result.bytes.fill(0);
  assert.equal((await service.subtitle(source, subtitle, '/media.mkv')).bytes.toString('base64'), reference.outputs[0].bytes);
  assert.equal(count(), 1, 'The cache must return independent buffers.');
});

test('cancelling all readers closes the upstream and permits an immediate independent retry', async t => {
  const { fixture, service, count } = await setup(t);
  fixture.setDelay(1000);
  const controller = new AbortController();
  const pending = service.subtitle(source, subtitle, '/media.mkv', { signal: controller.signal });
  const checked = assert.rejects(pending, { code: 'cancelled' });
  await until(() => fixture.requests.some(value => value.method === 'GET'));
  controller.abort(); await checked;
  fixture.setDelay(0);
  assert.equal((await service.subtitle(source, subtitle, '/media.mkv')).bytes.toString('base64'), reference.outputs[0].bytes);
  await until(() => fixture.closedReads > 0);
  assert.equal(count(), 2);
});

test('strong source versions isolate cache entries and detect mutation during extraction', async t => {
  const { fixture, service, count } = await setup(t);
  await service.subtitle(source, subtitle, '/media.mkv');
  const original = files()['/media.mkv'];
  const changed = Buffer.from(original);
  const offset = changed.lastIndexOf(Buffer.from('Second'));
  assert.ok(offset > 0); changed.write('Update', offset);
  fixture.replace('/media.mkv', changed);
  assert.match((await service.subtitle(source, subtitle, '/media.mkv')).bytes.toString(), /Update/);
  assert.equal(count(), 2);
  fixture.setDelay(200);
  fixture.replace('/media.mkv', original);
  const before = fixture.requests.filter(value => value.method === 'GET').length;
  const pending = service.subtitle(source, subtitle, '/media.mkv');
  const checked = assert.rejects(pending, { code: 'version-changed' });
  await until(() => fixture.requests.filter(value => value.method === 'GET').length > before);
  fixture.replace('/media.mkv', changed);
  await checked;
  fixture.setDelay(0);
  assert.match((await service.subtitle(source, subtitle, '/media.mkv')).bytes.toString(), /Update/);
  assert.equal(count(), 4, 'Changed content must never populate an older version cache entry.');
});

test('unversioned adapters are explicitly uncached and unsupported branches start no process', async t => {
  const { service, count } = await setup(t, {}, { reliableVersion: false });
  for (let i = 0; i < 2; i++) assert.equal((await service.subtitle(source, subtitle, '/media.mkv')).consistency, 'unversioned');
  assert.equal(count(), 2);
  assert.equal(service.supportsSubtitle(source, source.MediaStreams.find(stream => stream.Codec === 'ass'), 'vtt'), true);
  assert.equal(service.supportsSubtitle(source, { ...subtitle, Codec: 'ssa' }, 'webvtt'), true);
  assert.equal(service.supportsSubtitle(source, { ...subtitle, Codec: 'pgssub' }, 'vtt'), false);
  assert.equal(service.supportsSubtitle(source, { ...subtitle, Codec: 'dvdsub' }, 'vtt'), false);
  await assert.rejects(service.subtitle(source, { ...subtitle, Codec: 'mov_text' }, '/media.mkv'), { code: 'not-supported' });
  await assert.rejects(service.attachment(source, { Index: 0, Codec: 'mjpeg' }, '/media.mkv'), { code: 'not-found' });
  await assert.rejects(service.subtitle({ ...source, VideoType: 'BluRay' }, subtitle, '/media.mkv'), { code: 'not-supported' });
  assert.equal(count(), 2);
});

test('embedded External negotiation matches the native DLL only after its extraction capability is available', async t => {
  const { service } = await setup(t);
  const entry = profileInput.profiles.find(value => value.name === 'embedded subtitle External');
  const expected = profileOracle.profiles.find(value => value.name === entry.name).result;
  const candidate = structuredClone(entry.source);
  const actual = negotiateSource(candidate, { Id: candidate.Id, MediaType: entry.mediaType }, entry.profile,
    { ...entry.options, CanExtractSubtitle: (stream, format) => service.supportsSubtitle(candidate, stream, format) });
  assert.equal(actual.SupportsDirectPlay, expected.SupportsDirectPlay);
  assert.equal(actual.DefaultSubtitleStreamIndex, expected.SubtitleStreamIndex);
  assert.equal(actual.MediaStreams.find(value => value.Index === expected.SubtitleStreamIndex).DeliveryMethod, 'External');
  assert.equal(service.supportsSubtitle(source, { Codec: 'dvdsub' }, 'dvdsub'), false, 'An MKS packet-copy output must not be advertised as an IDX/SUB pair.');
  assert.equal(service.supportsSubtitle(source, { Codec: 'dvdsub' }, 'mks'), true);
});

test('extraction enforces output limits, timeout and shutdown cancellation', async t => {
  const { fixture, service } = await setup(t, { maxOutputBytes: 8 });
  await assert.rejects(service.subtitle(source, subtitle, '/media.mkv'), { code: 'invalid-response' });
  service.maxOutputBytes = 1024 * 1024;
  service.timeoutMs = 100;
  fixture.setDelay(1000);
  await assert.rejects(service.subtitle(source, subtitle, '/media.mkv'), { code: 'timeout' });
  service.timeoutMs = 5000;
  const before = fixture.requests.filter(value => value.method === 'GET').length;
  const pending = service.subtitle(source, subtitle, '/media.mkv');
  const checked = assert.rejects(pending, { code: 'cancelled' });
  await until(() => fixture.requests.filter(value => value.method === 'GET').length > before);
  await service.close(); await checked;
  await assert.rejects(service.subtitle(source, subtitle, '/media.mkv'), { code: 'closed' });
});

test('stream indexes follow native input-path grouping and process arguments reject arbitrary inputs', () => {
  const internal = { Index: 7, Type: 'Subtitle', Codec: 'subrip' };
  const external = { Index: 9, Type: 'Subtitle', Codec: 'ass', Path: 'Z:\\Extraction\\subtitles.mks', IsExternal: true };
  const mixed = { MediaStreams: [{ Index: 0, Type: 'Audio', Path: 'external.aac' }, { Index: 1, Type: 'Audio' }, internal,
    { Index: 8, Type: 'Subtitle', Path: external.Path }, external] };
  assert.equal(subtitleInputIndex(mixed, internal), 1);
  assert.equal(subtitleInputIndex(mixed, external), 1);
  assert.throws(() => buildExtractionArguments('file:///private.mkv', { kind: 'subtitle', index: 0, muxer: 'srt' }), TypeError);
  assert.throws(() => buildExtractionArguments('http://127.0.0.1:123/' + 'a'.repeat(64), { kind: 'subtitle', index: -1, muxer: 'srt' }), TypeError);
  assert.throws(() => buildExtractionArguments('http://127.0.0.1:123/' + 'a'.repeat(64), { kind: 'subtitle', index: 0, muxer: 'mpegts' }), TypeError);
});
