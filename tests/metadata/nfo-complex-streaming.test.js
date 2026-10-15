import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseNfo, parseNfoAsync } from '../../plugins/nfo/parser.js';

const root = new URL('./fixtures/nfo-complex-streaming/', import.meta.url);
const [input, native, provenance, historicalDifferences] = await Promise.all(
  ['input.json', 'native.json', 'provenance.json', 'candidate-differences.json']
    .map(async filename => JSON.parse(await readFile(new URL(filename, root), 'utf8'))));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const nullable = value => value ?? null;

function projectItem(item, type) {
  const video = type === 'Movie';
  return {
    runtimeType: type,
    Name: nullable(item.Name),
    Overview: nullable(item.Overview),
    CommunityRating: nullable(item.CommunityRating),
    CriticRating: nullable(item.CriticRating),
    runTimeTicks: item.RunTimeTicks == null ? null : String(item.RunTimeTicks),
    providers: Object.fromEntries(Object.entries(item.ProviderIds ?? {}).sort(([left], [right]) => left.localeCompare(right))),
    aspectRatio: video ? nullable(item.AspectRatio) : null,
    width: video ? item.Width ?? 0 : null,
    height: video ? item.Height ?? 0 : null,
    video3DFormat: video ? nullable(item.Video3DFormat) : null,
    hasSubtitles: video ? item.HasSubtitles ?? false : null,
  };
}

function projectPerson(person) {
  return { Name: person.Name, Type: person.Type, Role: nullable(person.Role), SortOrder: nullable(person.SortOrder), ImageUrl: nullable(person.ImageUrl) };
}

function exceptionName(error) {
  if (!error) return null;
  if (error.name === 'XmlError') return 'XmlException';
  return error.nativeException ?? error.name ?? error.constructor.name;
}

function candidateResult(sample, frozen) {
  const item = { Type: sample.type, ProviderIds: {},
    ...(sample.initialName == null ? {} : { Name: sample.initialName }),
    ...(sample.indexNumber == null ? {} : { IndexNumber: sample.indexNumber }) };
  let result, error = null, hasMetadata = false;
  try {
    result = parseNfo(Buffer.from(frozen.raw.base64, 'base64').toString('utf8'), {
      type: sample.type, item, indexNumber: sample.indexNumber, seriesSeason: sample.seriesSeason ?? false,
    });
    hasMetadata = true;
  } catch (caught) {
    error = caught;
  }
  return {
    exception: exceptionName(error),
    hasMetadata,
    item: projectItem(item, sample.type),
    people: (result?.People ?? []).map(projectPerson),
  };
}

async function candidateResultAsync(sample, frozen) {
  const item = { Type: sample.type, ProviderIds: {},
    ...(sample.initialName == null ? {} : { Name: sample.initialName }),
    ...(sample.indexNumber == null ? {} : { IndexNumber: sample.indexNumber }) };
  let result, error = null, hasMetadata = false;
  try {
    result = await parseNfoAsync(Buffer.from(frozen.raw.base64, 'base64').toString('utf8'), {
      type: sample.type, item, indexNumber: sample.indexNumber, seriesSeason: sample.seriesSeason ?? false,
    });
    hasMetadata = true;
  } catch (caught) {
    error = caught;
  }
  return {
    exception: exceptionName(error),
    hasMetadata,
    item: projectItem(item, sample.type),
    people: (result?.People ?? []).map(projectPerson),
  };
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

test('native complex NFO streaming fixture binds raw bytes, oracle, source tree and DLL', async () => {
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
  assert.equal(provenance.record.sourceFilesSha256, 'da3cdcb3cce9b4b73b70cd3aea8caa1dc0f9bccafc1444e409dd69b1211a163c');
  assert.equal(provenance.record.oracleAssemblySha256, 'c164cd8cf9d6e3927aa138c4815fc3635c15c80526b4ec4f4e671d38332c05e5');
  assert.equal(Object.keys(provenance.jellyfin.sources).length, 8);
  assert.equal(provenance.jellyfin.sources['MediaBrowser.Controller/Extensions/XmlReaderExtensions.cs'],
    '45e5ecd70806044d4d803f2d7b9a2b9c370d9ba21c232234f2d7de61f7ca446c');
  assert.equal(input.length, 40);
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

test('native complex NFO streaming fixture freezes subtree commits and strict XML edges', () => {
  const byName = new Map(native.results.map(result => [result.name, result]));
  assert.equal(byName.get('complete actor commits before immediate truncated token').people[0].Name, 'Committed Actor');
  assert.equal(byName.get('complete actor commits before unclosed root eof').people[0].Name, 'Committed At EOF');
  assert.equal(byName.get('partial actor retains no person').people.length, 0);
  const nested = byName.get('season scalar nested element propagates and does not commit');
  assert.equal(nested.exception, 'XmlException');
  assert.equal(nested.hasMetadata, false);
  assert.equal(nested.item.Name, 'Initial');
  assert.equal(byName.get('critic rating nested element is swallowed and does not commit').item.CriticRating, null);
  assert.equal(byName.get('series-season skips ratings subtree').item.CommunityRating, null);
  assert.equal(byName.get('series-season skips actor scalar rules before named season').item.Name, 'Winter');
  assert.equal(byName.get('non-video fileinfo ignores nested video fields').exception, null);
  assert.equal(byName.get('scalar does not commit before immediate truncated token').item.Name, 'Initial');
  assert.equal(byName.get('scalar commits after lexing valid next sibling start').item.Name, 'Committed');
  assert.equal(byName.get('rating value commits before ratings subtree truncation').item.CommunityRating, 7.5);
  assert.equal(byName.get('rating value does not commit before malformed child token').item.CommunityRating, null);
  assert.equal(byName.get('first rating commits before second rating truncates').item.CommunityRating, 6.5);
  assert.equal(byName.get('critic rating commits independently before later community truncates').item.CriticRating, 82);
  const completeFileInfo = byName.get('complete fileinfo commits before immediate truncated token').item;
  assert.deepEqual({ aspect: completeFileInfo.aspectRatio, width: completeFileInfo.width, height: completeFileInfo.height,
    ticks: completeFileInfo.runTimeTicks, format: completeFileInfo.video3DFormat, subtitles: completeFileInfo.hasSubtitles },
  { aspect: '1.85:1', width: 1920, height: 1080, ticks: '610000000', format: 'HalfSideBySide', subtitles: true });
  assert.equal(byName.get('video width waits for valid following token').item.width, 0);
  assert.deepEqual([byName.get('video width commits before height lookahead fails').item.width,
    byName.get('video width commits before height lookahead fails').item.height], [1920, 0]);
  assert.equal(byName.get('subtitle flag waits for language lookahead').item.hasSubtitles, false);
  assert.equal(byName.get('subtitle flag commits after complete subtitle before truncation').item.hasSubtitles, true);
  assert.equal(byName.get('default namespace keeps unprefixed parser names').item.Name, 'Namespaced');
  assert.equal(byName.get('declared prefixed scalar name is ignored case exactly').item.Name, 'Initial');
  assert.deepEqual(byName.get('attributes are case sensitive').item.providers, { Imdb: 'tt0000303' });
  for (const name of ['nonwhitespace text after root is rejected after final scalar commit', 'second root is rejected after first scalar commit']) {
    assert.equal(byName.get(name).exception, 'XmlException', name);
    assert.equal(byName.get(name).item.Name, 'Committed', name);
  }
});

test('production complex NFO streaming matches every frozen native result', () => {
  const report = [];
  for (const [index, sample] of input.entries()) {
    const expected = native.results[index];
    const frozen = { exception: expected.exception, hasMetadata: expected.hasMetadata, item: expected.item, people: expected.people };
    const actual = candidateResult(sample, expected);
    const paths = differencePaths(actual, frozen);
    if (paths.length) report.push({ name: sample.name, paths });
  }
  if (process.env.MEDIAMANAGER_CAPTURE_NFO_COMPLEX_DIFF === '1') process.stdout.write(`NFO_COMPLEX_DIFF=${JSON.stringify(report)}\n`);
  assert.equal(historicalDifferences.length, 23);
  assert.deepEqual(report, []);
});

test('production async complex NFO streaming matches every frozen native result', async () => {
  const report = [];
  for (const [index, sample] of input.entries()) {
    const expected = native.results[index];
    const frozen = { exception: expected.exception, hasMetadata: expected.hasMetadata, item: expected.item, people: expected.people };
    const actual = await candidateResultAsync(sample, expected);
    const paths = differencePaths(actual, frozen);
    if (paths.length) report.push({ name: sample.name, paths });
  }
  assert.equal(historicalDifferences.length, 23);
  assert.deepEqual(report, []);
});
