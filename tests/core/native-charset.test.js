import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { detectNativeCharset } from '../../src/core/native-charset.js';
import { decodePlaylistText } from '../../src/metadata/playlist-items.js';
import { observeComparison, assertProjectedEqual } from '../comparison-observations.js';
import { recordCurrentOracleOnce } from '../helpers/current-oracle.js';

const root = new URL('./fixtures/native-charset/', import.meta.url);
const input = JSON.parse(await readFile(new URL('input.json', root)));
const sampleNames = input.languages.flatMap(language => language.encodings.flatMap(encoding =>
  input.repetitions.flatMap(repeat => input.prefixLengths.map(prefix => `${language.name}-${encoding}-${repeat}-${prefix}`))))
  .concat(input.hexCases.map(sample => sample.name), input.singleBytes
    ? Array.from({ length: 256 }, (_, value) => `single-byte-${value.toString(16).padStart(2, '0')}`) : [],
  Array.from({ length: input.randomCases }, (_, index) => `binary-${index}-${input.randomLengths[index % input.randomLengths.length]}`));
const selection = details => {
  const first = details?.[0];
  return { first: first?.name ?? null, encoding: first?.encoding ?? null, bom: first?.bom ?? false,
    aboveThreshold: first != null && first.confidence >= 0.5,
    selectedEncoding: first?.encoding && first.confidence >= 0.5 ? first.encoding : 'utf-8' };
};
const current = () => recordCurrentOracleOnce({ owner: import.meta.url, label: 'native-charset',
  project: 'tests/core/fixtures/native-charset/current/Oracle.csproj',
  input: 'tests/core/fixtures/native-charset/input.json' });

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const enabled = { skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 240000 };

test('current Native charset corpus preserves all neutral byte and feed-boundary samples', enabled, async () => {
  const { inputBytes, native } = await current();
  assert.equal(native.inputSha256, createHash('sha256').update(inputBytes).digest('hex'));
  assert.equal(sampleNames.length, 662);
  assert.equal(new Set(sampleNames).size, sampleNames.length);
  assert.deepEqual(native.samples.map(sample => sample.name), sampleNames);
  for (const sample of native.samples) {
    assert.equal(sample.buffer.error, null, sample.name);
    assert.equal(sample.stream.error, null, sample.name);
    assert.equal(typeof sample.stream.text, 'string', sample.name);
  }
});

for (const name of sampleNames) test(`current Native charset selection and Playlist decoding: ${name}`, enabled, async t => {
  const { native } = await current();
  const sample = native.samples.find(sample => sample.name === name);
  assert.ok(sample, name);
  assert.equal(sample.buffer.error, null, name);
  assert.equal(sample.stream.error, null, name);
  const bytes = Buffer.from(sample.bytes, 'base64');
  for (const mode of ['buffer', 'stream']) {
    const actual = detectNativeCharset(bytes, { stream: mode === 'stream' });
    observeComparison(t, `${mode} detector candidates`, actual.details, sample[mode].details);
    if (mode === 'stream') {
      assertProjectedEqual(t, 'Playlist selection', selection(actual.details), sample.stream.selection);
      assert.equal(decodePlaylistText(bytes, '.m3u'), sample.stream.text, 'Native StreamReader decoded text');
    }
  }
});

test('charset retains current Native final stream selections across feed boundaries', enabled, async t => {
  const { native } = await current();
  const changes = native.samples.filter(sample => JSON.stringify(sample.buffer.selection) !== JSON.stringify(sample.stream.selection));
  for (const sample of changes) {
    const bytes = Buffer.from(sample.bytes, 'base64');
    assertProjectedEqual(t, sample.name, selection(detectNativeCharset(bytes, { stream: true }).details), sample.stream.selection);
  }
});

test('charset falls back when a detected encoding is unavailable and rejects non-byte input', () => {
  const bytes = Buffer.from('2b2f76382d4142', 'hex');
  assert.deepEqual(selection(detectNativeCharset(bytes, { stream: true }).details),
    { first: 'utf-7', encoding: null, bom: true, aboveThreshold: true, selectedEncoding: 'utf-8' });
  assert.equal(decodePlaylistText(Buffer.alloc(0), '.m3u'), '');
  assert.throws(() => detectNativeCharset('Café'), TypeError);
});
