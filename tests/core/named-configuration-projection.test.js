import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { namedCoreProjection, namedDiskProjection, namedExpand, namedExpandBody, namedExpandPath,
  namedHttpProjection, namedNfoPhasesProjection, namedPathsProjection, namedWire } from './named-configuration-current.js';

const root = path.join(os.tmpdir(), 'named-configuration-projection');
const wire = (json, status = 200, contentType = 'application/json; charset=utf-8') => ({
  status, contentType, headers: {}, error: null, json, text: JSON.stringify(json),
});
const disk = value => ({ directory: false, accepted: true, value });

test('named configuration projections bind actual path fields while preserving codec and ordinary root-valued data', () => {
  const configuration = { TranscodingTempPath: path.join(root, 'transcodes'), FallbackFontPath: path.join(root, 'fonts'),
    EncoderAppPathDisplay: `Encoder description ${root}`, EncoderPreset: root, HardwareDecodingCodecs: [root, root + '/codec'],
    Unknown: { FallbackFontPath: path.join(root, 'opaque'), traceId: root } };
  const state = { current: { encoding: configuration }, retained: { saved: configuration }, disk: disk(configuration),
    linkedDisk: null, files: ['encoding.xml', root] };
  const row = { name: root, key: 'encoding', root, before: state, after: state,
    steps: [{ step: { action: 'get' }, accepted: true, result: configuration, state }],
    events: [{ phase: 'updated', key: 'encoding', configuration, state }] };
  const before = structuredClone(row), projected = namedCoreProjection(row);
  for (const value of [projected.before.current.encoding, projected.before.retained.saved, projected.steps[0].result,
    projected.events[0].configuration, projected.after.disk.value]) {
    assert.equal(value.TranscodingTempPath, '@/transcodes'); assert.equal(value.FallbackFontPath, '@/fonts');
    assert.equal(value.EncoderPreset, root); assert.deepEqual(value.HardwareDecodingCodecs, [root, root + '/codec']);
    assert.equal(value.EncoderAppPathDisplay, `Encoder description ${root}`); assert.deepEqual(value.Unknown, configuration.Unknown);
  }
  assert.equal(projected.name, root); assert.deepEqual(projected.before.files, ['encoding.xml', root]);
  assert.deepEqual(row, before, 'the original state and literal fields remain available');
  assert.equal(namedDiskProjection(disk({ FallbackFontPath: root + '-other/fonts' }), 'encoding', root).value.FallbackFontPath,
    root + '-other/fonts', 'matching a directory-name prefix is insufficient');
  const response = wire(configuration), http = namedHttpProjection({ name: 'encoding', root, response, afterRead: response,
    live: configuration, events: [{ phase: 'updated', key: 'encoding', configuration }], disk: disk(configuration) }, 'encoding');
  assert.equal(http.live.EncoderPreset, root); assert.deepEqual(http.response.json.HardwareDecodingCodecs, configuration.HardwareDecodingCodecs);
});

test('named fixture input expands only declared root configuration paths and explicit file operations', () => {
  const encoding = { TranscodingTempPath: '@/transcodes', HardwareDecodingCodecs: ['@/codec'], EncoderPreset: '@/preset',
    Unknown: { TranscodingTempPath: '@/opaque' } };
  assert.deepEqual(namedExpand(encoding, root, 'encoding'), { ...encoding, TranscodingTempPath: path.join(root, 'transcodes') });
  const network = { CertificatePath: '@/tls/server.pfx', CertificatePassword: '@/literal',
    LocalNetworkAddresses: ['@/address'], Unknown: { CertificatePath: '@/opaque' } };
  assert.deepEqual(namedExpand(network, root, 'NETWORK'), { ...network, CertificatePath: path.join(root, 'tls', 'server.pfx') });
  const nfo = { ReleaseDateFormat: '@/literal-format', UserId: '@/literal-user' };
  assert.deepEqual(namedExpand(nfo, root, 'xbmcmetadata'), nfo);
  assert.equal(namedExpandPath('@/a/.jellyfin-transcode', root), path.join(root, 'a', '.jellyfin-transcode'));
});

test('named HTTP path input keeps duplicate keys, opaque values, number tokens and rejected JSON text', () => {
  const text = ' {"TranscodingTempPath":"@/first", "Unknown":{"TranscodingTempPath":"@/opaque"},'
    + '"HardwareDecodingCodecs":["@/codec"],"TranscodingTempPath":"@/last","EncoderPreset":"@/literal",'
    + '"H264Crf":"0042","Future":9223372036854775807,"TranscodingTemp\\u0050ath":"@/escaped"} ';
  const filename = suffix => JSON.stringify(root.replaceAll('\\', '/') + '/' + suffix);
  const expected = text.replace('"@/first"', filename('first')).replace('"@/last"', filename('last')).replace('"@/escaped"', filename('escaped'));
  assert.equal(namedExpandBody(text, root, 'encoding'), expected);
  for (const original of ['{"TranscodingTempPath":"@/unchanged",}', '[{"TranscodingTempPath":"@/array"}]',
    '{"future":{"CertificatePath":"@/opaque"}}', '{"certificatePath":"@/wrong-case"}']) {
    assert.equal(namedExpandBody(original, root, 'network'), original);
  }
});

test('named public wire preserves successful trace data, complete media type and lossless opaque fields', () => {
  const success = wire({ traceId: 7, CertificatePassword: root, Unknown: { traceId: 'business', CertificatePath: root } });
  assert.deepEqual(namedWire(success, root, 'network').json, success.json);
  assert.notDeepEqual(namedWire(success, root), namedWire({ ...success, contentType: 'application/json; charset=utf-16' }, root));
  assert.notDeepEqual(namedWire(success, root), namedWire({ ...success, contentType: 'application/json; charset=utf-8; profile=CamelCase' }, root));
  const text = '{"traceId":"business","future":9223372036854775807,"date":"2026-01-02T03:04:05.1234567Z"}';
  const projected = namedWire({ ...wire({}), json: JSON.parse(text), text }, root, 'encoding');
  assert.equal(projected.json.future, 9223372036854775807n); assert.equal(projected.json.date, '2026-01-02T03:04:05.1234567Z');
  assert.equal(projected.json.traceId, 'business');
  const problem = { status: 400, title: 'Invalid request', traceId: 'request-one',
    errors: { traceId: ['actual business error'] }, ProviderIds: { traceId: 'provider-value', CertificatePath: root } };
  const error = wire(problem, 400, 'application/problem+json; charset=utf-8'), before = structuredClone(error);
  assert.deepEqual(namedWire(error, root, 'network').json, { ...problem, traceId: '$trace' });
  assert.notDeepEqual(namedWire(error, root), namedWire(wire({ ...problem, ProviderIds: { ...problem.ProviderIds, traceId: 'changed' } }, 400, error.contentType), root));
  const { traceId: _trace, ...withoutTrace } = problem;
  assert.notDeepEqual(namedWire(error, root), namedWire(wire(withoutTrace, 400, error.contentType), root));
  for (const traceId of [null, 7, {}]) assert.throws(() => namedWire(wire({ ...problem, traceId }, 400), root));
  assert.deepEqual(error, before, 'the raw original wire remains unchanged');
});

test('named path effects bind only actual directory results and a physically recorded conflicting marker', () => {
  const marker = path.join(root, 'foreign', '.jellyfin-data');
  const message = `Expected to find only .jellyfin-transcode but found marker for ${marker}.`;
  const state = { encoding: { TranscodingTempPath: path.join(root, 'foreign'), EncoderPreset: root },
    metadata: { UseFileCreationTimeForDateAdded: false }, cachePath: path.join(root, 'cache'),
    tree: [{ path: 'foreign/.jellyfin-data', directory: false, bytes: Buffer.from(root).toString('base64') }] };
  const row = { name: 'physical-path', root, before: state, after: state, steps: [
    { step: { action: 'get' }, accepted: false, result: null, error: { message }, state },
    { step: { action: 'save' }, accepted: false, result: null, error: { message }, state },
    { step: { action: 'get' }, accepted: false, result: null, error: { message }, state: { ...state, tree: [] } },
    { step: { action: 'get' }, accepted: true, result: path.join(root, 'a'), error: null, state },
  ] };
  const projected = namedPathsProjection(row);
  assert.equal(projected.steps[0].error, 'Expected to find only .jellyfin-transcode but found marker for @/foreign/.jellyfin-data.');
  assert.equal(projected.steps[1].error, message); assert.equal(projected.steps[2].error, message);
  assert.equal(projected.steps[3].result, '@/a'); assert.equal(projected.before.cachePath, '@/cache');
  assert.equal(projected.before.encoding.EncoderPreset, root); assert.deepEqual(projected.before.tree, state.tree);
});

test('NFO phase summary only aligns the actual poster path and retains literal format and summary values', () => {
  const phases = [{ name: root, configuration: { ReleaseDateFormat: root, UserId: root }, bytes: 'original XML ' + root,
    nfo: { poster: path.join(root, 'media', 'poster.png'), premiered: root, unknown: { poster: root } } }];
  const before = structuredClone(phases), projected = namedNfoPhasesProjection(phases, root);
  assert.equal(projected[0].nfo.poster, '@/media/poster.png'); assert.equal(projected[0].nfo.premiered, root);
  assert.deepEqual(projected[0].configuration, phases[0].configuration); assert.deepEqual(projected[0].nfo.unknown, { poster: root });
  assert.equal(projected[0].name, root); assert.equal(Object.hasOwn(projected[0], 'bytes'), false);
  assert.deepEqual(phases, before, 'original XML is retained outside the existing finite summary');
});
