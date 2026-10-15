import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { detectNativeCharset } from '../../src/core/native-charset.js';
import { decodeNativeTextEncoding } from '../../src/core/native-text.js';
import { decodePlaylistText } from '../../src/metadata/playlist-items.js';
import { observeComparison, assertProjectedEqual } from '../comparison-observations.js';

const root = new URL('./fixtures/native-charset/', import.meta.url);
const [inputBytes, nativeBytes, provenanceBytes] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(name => readFile(new URL(name, root))));
const input = JSON.parse(inputBytes), native = JSON.parse(nativeBytes), provenance = JSON.parse(provenanceBytes);
const modelsUrl = new URL('../../src/core/resources/native-charset-models.json', import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const bits = value => { const bytes = Buffer.alloc(4); bytes.writeFloatLE(value); return bytes.readUInt32LE(); };
const project = details => details?.map(({ confidence, ...detail }) => ({ name: detail.name,
  confidenceBits: bits(confidence), encoding: detail.encoding, bom: detail.bom })) ?? null;
const selection = details => {
  const first = details?.[0];
  return { first: first?.name ?? null, encoding: first?.encoding ?? null, bom: first?.bom ?? false,
    aboveThreshold: first != null && first.confidence >= Math.fround(0.5),
    selectedEncoding: first?.encoding && first.confidence >= Math.fround(0.5) ? first.encoding : 'utf-8' };
};
const verify = async descriptor => assert.equal(hash(await readFile(descriptor.filename ?? descriptor.path)), descriptor.sha256);

test('charset model and native corpus retain independent actual-process seals', async () => {
  assert.equal(hash(provenanceBytes), 'e4138afc2f0417a0b09675304773da1d4c34add0b526b19344934cffe3ec0737');
  assert.equal(hash(nativeBytes), 'd991eef18f86c60115cb945cc401d2a8f94fcd04798bb117a25d3271b9fbef2f');
  assert.equal(provenance.native.sha256, hash(nativeBytes));
  assert.equal(provenance.files.find(file => file.filename.endsWith('input.json')).sha256, hash(inputBytes));
  const modelsBytes = await readFile(modelsUrl), models = JSON.parse(modelsBytes);
  assert.equal(hash(modelsBytes), 'b2cf04b458d60c38fc6c8ef5521e0db6c6062ef300f35b461e317c3b75131cbf');
  assert.equal(provenance.tables.sha256, hash(modelsBytes));
  assert.equal(provenance.candidateVerified, false);
  assert.equal(provenance.jellyfin.commit, '208c278b75abd897aefa1e1175126eac5e4dbfaa');
  assert.equal(provenance.upstream.commit, 'fd4c6fab634ef3783f8b5cb88e9ae9b2cc295ad5');
  assert.ok(provenance.loadedAssemblies.some(value => value.name === 'UtfUnknown' && /^[a-f0-9]{64}$/u.test(value.sha256)));
  assert.equal(models.sequences.length, 101);
  assert.equal(models.multibyte.length, 8);
  assert.equal(models.escape.length, 4);
  assert.equal(models.japaneseWidth, 83);
  assert.equal(native.samples.length, 662);
  assert.equal(input.singleBytes, true);
  assert.equal(new Set(native.samples.map(sample => sample.name)).size, native.samples.length);
  for (const file of provenance.files) {
    const name = file.filename.split(/[\\/]/u).at(-1);
    assert.equal(hash(await readFile(new URL(name, root))), file.sha256, `Oracle source ${name}`);
  }
  for (const descriptor of [provenance.record, provenance.raw, provenance.native, provenance.modelRaw,
    provenance.tables, provenance.dotnet, provenance.jellyfin.packages, ...provenance.resolution,
    ...provenance.upstream.sources, ...provenance.loadedAssemblies]) await verify(descriptor);
  const record = JSON.parse(await readFile(provenance.record.filename, 'utf8'));
  assert.equal(record.build.status, 0);
  assert.equal(record.process.status, 0);
  assert.equal(record.passed, true);
  assert.equal(provenance.repeat.sampleProjectionEqual, true);
  assert.equal(provenance.repeat.tablesByteEqual, true);
  for (const descriptor of [provenance.repeat.record, provenance.repeat.raw, provenance.repeat.models]) await verify(descriptor);
  const repeated = JSON.parse(await readFile(provenance.repeat.raw.filename, 'utf8'));
  assert.deepEqual(repeated.samples, native.samples);
});

for (const sample of native.samples) for (const mode of ['buffer', 'stream']) {
  test(`native charset ${mode}: ${sample.name}`, t => {
    const actual = detectNativeCharset(Buffer.from(sample.bytes, 'base64'), { stream: mode === 'stream' });
    const expected = sample[mode];
    assert.equal(expected.error, null, 'Native errors must be explicitly reproduced, never treated as detector results.');
    observeComparison(t, 'detector candidates', project(actual.details), expected.details?.map(({ confidence, ...detail }) => detail) ?? null);
    if (mode === 'stream') {
      assertProjectedEqual(t, 'Playlist selection', selection(actual.details), selection(expected.details));
      assert.equal(decodePlaylistText(Buffer.from(sample.bytes, 'base64'), '.m3u'),
        decodeNativeTextEncoding(Buffer.from(sample.bytes, 'base64'), selection(expected.details).selectedEncoding));
    }
  });
}

test('charset retains recorded final stream selections across feed boundaries', t => {
  const changes = native.samples.filter(sample => JSON.stringify(selection(sample.buffer.details)) !== JSON.stringify(selection(sample.stream.details)));
  for (const sample of changes) {
    const bytes = Buffer.from(sample.bytes, 'base64');
    assertProjectedEqual(t, sample.name, selection(detectNativeCharset(bytes, { stream: true }).details), selection(sample.stream.details));
    observeComparison(t, sample.name + ' buffer', selection(detectNativeCharset(bytes).details), selection(sample.buffer.details));
  }
});

test('charset does not conflate an unavailable .NET encoding with a supported encoding', () => {
  const result = detectNativeCharset(Buffer.from('2b2f76382d4142', 'hex'), { stream: true });
  assert.deepEqual(result.details, [{ name: 'utf-7', confidence: 1, encoding: null, bom: true }]);
  assert.deepEqual(detectNativeCharset(Buffer.alloc(0)), { details: null });
  assert.throws(() => detectNativeCharset('Café'), TypeError);
});
