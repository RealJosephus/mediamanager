import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseNfo, parseNfoAsync } from '../../plugins/nfo/parser.js';
import { observeComparison } from '../comparison-observations.js';

const root = new URL('./fixtures/nfo-fanart-set-streaming/', import.meta.url);
const [input, native, provenance, historicalDifferences] = await Promise.all(
  ['input.json', 'native.json', 'provenance.json', 'candidate-differences.json']
    .map(async filename => JSON.parse(await readFile(new URL(filename, root), 'utf8'))));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const nullable = value => value ?? null;

function project(sample, item, result) {
  return {
    item: {
      Name: nullable(item.Name),
      collectionName: nullable(item.TmdbCollectionName),
      providers: Object.fromEntries(Object.entries(item.ProviderIds ?? {}).sort(([left], [right]) => left.localeCompare(right))),
    },
    remoteImages: (result?.RemoteImages ?? []).map(image => ({ url: image.Url, type: image.Type })),
    localImages: (result?.LocalImageCandidates ?? []).map(image => ({ type: image.Type })),
  };
}

function exceptionDetails(error) {
  if (!error) return null;
  return { name: error.name, message: error.message, code: error.code, status: error.status, stack: error.stack };
}
const outcome = ({ exception, ...value }) => ({ ...value, failed: exception != null });

function candidateResult(sample, frozen) {
  const item = { Type: 'Movie', ProviderIds: {},
    ...(sample.initialName == null ? {} : { Name: sample.initialName }),
    ...(sample.initialCollectionName == null ? {} : { TmdbCollectionName: sample.initialCollectionName }) };
  let result, error = null, hasMetadata = false;
  try {
    result = parseNfo(Buffer.from(frozen.raw.base64, 'base64').toString('utf8'), { type: 'Movie', item });
    hasMetadata = true;
  } catch (caught) {
    error = caught;
  }
  return { exception: exceptionDetails(error), hasMetadata, ...project(sample, item, result) };
}

async function candidateResultAsync(sample, frozen) {
  const item = { Type: 'Movie', ProviderIds: {},
    ...(sample.initialName == null ? {} : { Name: sample.initialName }),
    ...(sample.initialCollectionName == null ? {} : { TmdbCollectionName: sample.initialCollectionName }) };
  let result, error = null, hasMetadata = false;
  try {
    result = await parseNfoAsync(Buffer.from(frozen.raw.base64, 'base64').toString('utf8'), { type: 'Movie', item });
    hasMetadata = true;
  } catch (caught) {
    error = caught;
  }
  return { exception: exceptionDetails(error), hasMetadata, ...project(sample, item, result) };
}

function frozenResult(expected) {
  return { exception: expected.exception, hasMetadata: expected.hasMetadata, item: expected.item,
    remoteImages: expected.remoteImages, localImages: expected.localImages };
}

function differencePaths(actual, expected, path = '') {
  if (Object.is(actual, expected)) return [];
  if (actual == null || expected == null || typeof actual !== 'object' || typeof expected !== 'object') return [path || '/'];
  if (Array.isArray(actual) !== Array.isArray(expected)) return [path || '/'];
  const keys = Array.isArray(actual) && Array.isArray(expected)
    ? Array.from({ length: Math.max(actual.length, expected.length) }, (_, index) => String(index))
    : [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort();
  return keys.flatMap(key => differencePaths(actual[key], expected[key], `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`));
}

test('native fanart and set fixture binds raw bytes, oracle, source tree and DLL', async () => {
  for (const file of Object.values(provenance.files)) {
    assert.equal(sha256(await readFile(new URL('../../' + file.path, import.meta.url))), file.sha256, file.path);
  }
  assert.equal(native.inputSha256, provenance.files.input.sha256);
  assert.equal(native.frozenJellyfinHead, provenance.jellyfin.head);
  assert.equal(native.candidateVerified, false);
  assert.equal(provenance.candidateVerified, false);
  assert.equal(provenance.runtime.jellyfinDll.sha256, 'a43fa24c44677e579fcec79d637789b9f36633d02e5434e76a0e03fa13027767');
  assert.equal(provenance.runtime.assemblies['MediaBrowser.XbmcMetadata.dll'].sha256, '82ddd82082f44faf43284258609ba4efce9a94759d24e0f7161ebf5c7d18558e');
  assert.equal(Object.keys(provenance.runtime.assemblies).length, 6);
  assert.equal(provenance.record.sourceFilesSha256, 'b4689fbef96bd9ffb3759b7b6cd0995eadffdb1f42b2d445eacc183fbe88e9ff');
  assert.equal(provenance.record.oracleAssemblySha256, 'e6405190806e7db0909d779bcc54947002c706af62235f8e17be293d6675acd1');
  assert.equal(Object.keys(provenance.jellyfin.sources).length, 4);
  assert.equal(provenance.jellyfin.sources['MediaBrowser.XbmcMetadata/Parsers/BaseNfoParser.cs'],
    'f50fd3439d423330b0bc1c40ab5b413a2c2b3811a14a0955ecd9fbb63b32c152');
  assert.equal(input.length, 36);
  assert.equal(native.results.length, input.length);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
  for (const [index, sample] of input.entries()) {
    const bytes = Buffer.from(sample.text, 'utf8');
    const frozen = native.results[index];
    assert.equal(bytes.toString('base64'), frozen.raw.base64, sample.name);
    assert.equal(bytes.length, frozen.raw.bytes, sample.name);
    assert.equal(sha256(bytes), frozen.raw.sha256, sample.name);
  }
});

test('native fanart and set fixture freezes complex subtree partial commits', () => {
  const byName = new Map(native.results.map(result => [result.name, result]));
  const image = name => byName.get(name).remoteImages;
  assert.deepEqual(image('flat thumb commits at root end'), [{ url: 'https://example.test/flat-root.jpg', type: 'Primary' }]);
  assert.deepEqual(image('flat thumb waits for immediate malformed sibling token'), []);
  assert.deepEqual(image('flat thumb commits before later scalar truncation'), [{ url: 'https://example.test/flat-prefix.jpg', type: 'Primary' }]);
  assert.deepEqual(image('fanart direct thumb commits as backdrop'), [{ url: 'https://example.test/backdrop.jpg', type: 'Backdrop' }]);
  assert.deepEqual(image('fanart considers only first thumb'), [{ url: 'https://example.test/first-backdrop.jpg', type: 'Backdrop' }]);
  assert.deepEqual(image('fanart finds nested descendant thumb'), [{ url: 'https://example.test/nested-backdrop.jpg', type: 'Backdrop' }]);
  assert.deepEqual(image('fanart dotted first thumb prevents later candidate'), []);
  assert.deepEqual(image('fanart thumb waits for malformed immediate token'), []);
  assert.deepEqual(image('fanart thumb commits before later subtree mismatch'),
    [{ url: 'https://example.test/committed-before-mismatch.jpg', type: 'Backdrop' }]);
  assert.deepEqual(image('fanart completed thumb at truncated eof waits'), []);
  assert.equal(byName.get('set direct text commits').item.collectionName, 'Direct Collection');
  assert.equal(byName.get('set name child commits').item.collectionName, 'Named Collection');
  const attribute = byName.get('set attribute commits while truncated inner name does not');
  assert.equal(attribute.item.collectionName, 'Initial Collection');
  assert.deepEqual(attribute.item.providers, { TmdbCollection: '401' });
  assert.equal(byName.get('set nested name content leaves initial name but commits attribute').item.collectionName, 'Initial Collection');
  assert.equal(byName.get('set first name persists before later nested name error').item.collectionName, 'First Collection');
  assert.equal(byName.get('set direct text short circuits later nested error').item.collectionName, 'Direct Prefix');
  assert.equal(byName.get('set cdata is skipped before following name').item.collectionName, 'After CData');
  assert.equal(byName.get('set later name overwrites first name').item.collectionName, 'Second Collection');
  assert.equal(byName.get('set name waits for malformed immediate root token').item.collectionName, 'Initial Collection');
  assert.equal(byName.get('set name commits before later sibling mismatch').item.collectionName, 'Committed Collection');
  assert.equal(byName.get('set completed at truncated movie eof').item.collectionName, 'Initial Collection');
  for (const result of native.results) {
    assert.equal(result.exception, null, result.name);
    assert.equal(result.hasMetadata, true, result.name);
  }
});

test('production fanart and set streaming matches every frozen native result', t => {
  const report = [];
  for (const [index, sample] of input.entries()) {
    const expected = native.results[index];
    const actual = candidateResult(sample, expected), frozen = frozenResult(expected);
    observeComparison(t, sample.name, actual, frozen);
    const paths = differencePaths(outcome(actual), outcome(frozen));
    if (paths.length) report.push({ name: sample.name, paths });
  }
  if (process.env.MEDIAMANAGER_CAPTURE_NFO_FANART_SET_DIFF === '1') {
    process.stdout.write(`NFO_FANART_SET_DIFF=${JSON.stringify(report)}\n`);
  }
  assert.equal(historicalDifferences.length, 6);
  assert.deepEqual(report, []);
});

test('production async fanart and set streaming matches every frozen native result', async t => {
  const report = [];
  for (const [index, sample] of input.entries()) {
    const expected = native.results[index];
    const actual = await candidateResultAsync(sample, expected), frozen = frozenResult(expected);
    observeComparison(t, sample.name, actual, frozen);
    const paths = differencePaths(outcome(actual), outcome(frozen));
    if (paths.length) report.push({ name: sample.name, paths });
  }
  assert.equal(historicalDifferences.length, 6);
  assert.deepEqual(report, []);
});
