import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseNfo, parseNfoAsync } from '../../plugins/nfo/parser.js';

const root = new URL('./fixtures/nfo-scalar-provider/', import.meta.url);
const [inputBytes, nativeBytes, provenanceBytes, differencesBytes] = await Promise.all(
  ['input.json', 'native.json', 'provenance.json', 'candidate-differences.json']
  .map(filename => readFile(new URL(filename, root))));
const input = JSON.parse(inputBytes);
const native = JSON.parse(nativeBytes);
const provenance = JSON.parse(provenanceBytes);
const historicalDifferences = JSON.parse(differencesBytes);
const layouts = await (await import('./reader-layout-fixture.js')).layoutFixture('nfo-scalar-provider');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const externalIds = [
  'Imdb', 'Tmdb', 'Tvdb', 'TvRage', 'Zap2It', 'MusicBrainzArtist', 'MusicBrainzAlbum',
  'MusicBrainzAlbumArtist', 'MusicBrainzReleaseGroup', 'MusicBrainzTrack', 'MusicBrainzRecording',
  'AudioDbArtist', 'AudioDbAlbum', 'CustomMapped',
];
const nullable = value => value ?? null;

function oracleDate(value) {
  if (value == null) return null;
  const [seconds, fraction = ''] = String(value).replace(' ', 'T').replace(/Z$/u, '').split('.');
  return `${seconds}.${fraction.padEnd(7, '0').slice(0, 7)}Z`;
}

function sortedProviders(values = {}) {
  return Object.fromEntries(Object.entries(values).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function projectItem(item, sample) {
  const series = sample.type === 'Series';
  const episode = sample.type === 'Episode';
  const musicVideo = sample.type === 'MusicVideo';
  return {
    runtimeType: sample.type === 'SeriesSeason' ? 'Season' : sample.type,
    Name: nullable(item.Name),
    OriginalTitle: nullable(item.OriginalTitle),
    SortName: nullable(item.SortName),
    ForcedSortName: nullable(item.ForcedSortName),
    Overview: nullable(item.Overview),
    PreferredMetadataLanguage: nullable(item.PreferredMetadataLanguage),
    PreferredMetadataCountryCode: nullable(item.PreferredMetadataCountryCode),
    Tagline: nullable(item.Tagline),
    OfficialRating: nullable(item.OfficialRating),
    CustomRating: nullable(item.CustomRating),
    dateCreated: nullable(item.DateCreated),
    premiereDate: oracleDate(item.PremiereDate),
    endDate: oracleDate(item.EndDate),
    ProductionYear: nullable(item.ProductionYear),
    CommunityRating: nullable(item.CommunityRating),
    CriticRating: nullable(item.CriticRating),
    runTimeTicks: item.RunTimeTicks == null ? null : String(item.RunTimeTicks),
    IsLocked: Boolean(item.IsLocked),
    lockedFields: (item.LockedFields ?? []).map(String),
    productionLocations: item.ProductionLocations ?? [],
    studios: item.Studios ?? [],
    genres: item.Genres ?? [],
    tags: item.Tags ?? [],
    trailers: (item.RemoteTrailers ?? []).map(value => value.Url),
    providers: sortedProviders(item.ProviderIds),
    aspectRatio: ['Movie', 'Video', 'MusicVideo', 'Episode'].includes(sample.type) ? nullable(item.AspectRatio) : null,
    displayOrder: series ? nullable(item.DisplayOrder) : null,
    collectionName: sample.type === 'Movie' ? nullable(item.TmdbCollectionName) : null,
    artists: musicVideo ? item.Artists ?? [] : null,
    album: musicVideo ? nullable(item.Album) : null,
    airTime: series ? nullable(item.AirTime) : null,
    airDays: series ? (item.AirDays ?? []).map(String) : null,
    status: series ? nullable(item.Status == null ? null : String(item.Status)) : null,
    IndexNumber: nullable(item.IndexNumber),
    indexNumberEnd: episode ? nullable(item.IndexNumberEnd) : null,
    ParentIndexNumber: nullable(item.ParentIndexNumber),
    airsBeforeEpisodeNumber: episode ? nullable(item.AirsBeforeEpisodeNumber) : null,
    airsAfterSeasonNumber: episode ? nullable(item.AirsAfterSeasonNumber) : null,
    airsBeforeSeasonNumber: episode ? nullable(item.AirsBeforeSeasonNumber) : null,
    seriesName: episode ? nullable(item.SeriesName) : null,
  };
}

const projectPerson = person => ({
  Name: person.Name,
  Type: String(person.Type),
  Role: nullable(person.Role),
  SortOrder: nullable(person.SortOrder),
  ImageUrl: nullable(person.ImageUrl),
});

function exceptionName(error) {
  if (!error) return null;
  if (error.name === 'XmlError') return 'XmlException';
  if (error.name === 'AbortError') return 'OperationCanceledException';
  return error.nativeException ?? error.name ?? error.constructor.name;
}

async function candidateResult(sample, frozen, mode) {
  const type = sample.type === 'SeriesSeason' ? 'Season' : sample.type;
  const item = {
    Type: type,
    ProviderIds: { ...(sample.initialProviderIds ?? {}) },
    ...(sample.indexNumber == null ? {} : { IndexNumber: sample.indexNumber }),
    ...(sample.initialName == null ? {} : { Name: sample.initialName }),
    ...(sample.initialOverview == null ? {} : { Overview: sample.initialOverview }),
  };
  const cancellation = new AbortController();
  if (sample.preCanceled) cancellation.abort();
  let result;
  let error = null;
  let hasMetadata = false;
  const options = {
    type,
    item,
    seriesSeason: sample.type === 'SeriesSeason',
    configuration: { ReleaseDateFormat: sample.releaseDateFormat ?? 'yyyy-MM-dd' },
    externalIds: sample.externalIds ?? externalIds,
    signal: cancellation.signal,
  };
  try {
    result = mode === 'sync'
      ? parseNfo(sample.text, options)
      : await parseNfoAsync(sample.text, options);
    hasMetadata = true;
  } catch (caught) {
    error = caught;
  }
  return {
    exception: exceptionName(error),
    hasMetadata,
    item: projectItem(item, sample),
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

test('native scalar and provider fixture seals source, DLL, oracle and all 69 exact UTF-8 inputs', async () => {
  for (const file of Object.values(provenance.files)) {
    assert.equal(sha256(await readFile(new URL('../../' + file.path, import.meta.url))), file.sha256, file.path);
  }
  assert.equal(native.frozenJellyfinHead, '208c278b75abd897aefa1e1175126eac5e4dbfaa');
  assert.equal(native.candidateVerified, false);
  assert.equal(provenance.candidateVerified, false);
  assert.deepEqual(provenance.matrix, {
    inputs: 69,
    candidateModes: ['sync', 'async'],
    exactComparisons: 138,
    historicalDifferenceRecords: 50,
    historicalDifferenceScenarios: 25,
  });
  assert.equal(provenance.runtime.jellyfinDll.sha256, 'a43fa24c44677e579fcec79d637789b9f36633d02e5434e76a0e03fa13027767');
  assert.equal(provenance.runtime.assemblies['MediaBrowser.XbmcMetadata.dll'].sha256,
    '82ddd82082f44faf43284258609ba4efce9a94759d24e0f7161ebf5c7d18558e');
  assert.equal(Object.keys(provenance.runtime.assemblies).length, 7);
  assert.equal(Object.keys(provenance.jellyfin.sources).length, 13);
  assert.equal(provenance.record.sourceFilesSha256, 'c69072458797c8d55c8a551efbf0abd0cb589617bcfc4ac3933aaac7c8011dc6');
  assert.equal(provenance.record.oracleAssemblySha256, 'c9536b6cbef0461aeb7e0b52fcbc854ec756f7b63355a2082006c1a0bdbbc761');
  assert.equal(historicalDifferences.length, 50);
  assert.equal(new Set(historicalDifferences.map(entry => `${entry.capture ?? 'initial-audit'}:${entry.name}`)).size, 25);
  assert.equal(input.length, 69);
  assert.equal(native.results.length, input.length);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
  assert.equal(native.inputSha256, sha256(inputBytes));
  for (const [index, sample] of input.entries()) {
    const bytes = Buffer.from(sample.text);
    const frozen = native.results[index];
    assert.equal(bytes.toString('base64'), frozen.raw.base64, sample.name);
    assert.equal(bytes.length, frozen.raw.bytes, sample.name);
    assert.equal(sha256(bytes), frozen.raw.sha256, sample.name);
  }
});

test('native matrix fixes the scalar, date, provider and cancellation boundaries', () => {
  const byName = new Map(native.results.map(result => [result.name, result]));
  assert.deepEqual(byName.get('lock fields parse whitespace casing numerics and preserve on empty').item.lockedFields,
    ['Genres', 'Name', '9', 'Cast', '-1']);
  assert.deepEqual(byName.get('actors accept the complete PersonKind enum and unknown fallback').people.map(person => person.Type),
    ['Arranger', 'Narrator', 'Unknown', 'Actor']);
  assert.equal(byName.get('actor type accepts defined numeric PersonKind').people[0].Type, 'Arranger');
  assert.equal(byName.get('actor type preserves undefined positive numeric PersonKind').people[0].Type, '27');
  assert.equal(byName.get('actor type preserves undefined negative numeric PersonKind').people[0].Type, '-1');
  assert.equal(byName.get('actor type combines comma separated named PersonKinds').people[0].Type, 'Composer');
  assert.equal(byName.get('actor type locks named numeric comma composite behavior').people[0].Type, 'Unknown');
  assert.equal(byName.get('actor type locks numeric comma composite behavior').people[0].Type, 'Unknown');
  assert.equal(byName.get('actor type invalid comma composite resets to unknown').people[0].Type, 'Unknown');
  assert.equal(byName.get('actor type accepts maximum Int32 numeric PersonKind').people[0].Type, '2147483647');
  assert.equal(byName.get('actor type accepts minimum Int32 numeric PersonKind').people[0].Type, '-2147483648');
  assert.equal(byName.get('actor type positive Int32 overflow resets to unknown').people[0].Type, 'Unknown');
  assert.equal(byName.get('actor type negative Int32 overflow resets to unknown').people[0].Type, 'Unknown');
  assert.deepEqual(byName.get('trailers convert both youtube plugin forms and deduplicate').item.trailers,
    ['https://www.youtube.com/watch?v=abc123', 'https://www.youtube.com/watch?v=def456']);
  assert.equal(byName.get('custom release format adjusts positive offset across previous year').item.ProductionYear, 2023);
  assert.equal(byName.get('dateadded trims CLR whitespace and accepts month names').item.dateCreated,
    '2024-01-02T03:04:05.0000000Z');
  assert.equal(byName.get('dateadded preserves seven fractional digits').item.dateCreated,
    '2024-02-03T04:05:06.1234567Z');
  assert.equal(byName.get('dateadded preserves a single 100ns tick').item.dateCreated,
    '2024-02-03T04:05:06.0000001Z');
  assert.equal(byName.get('dateadded preserves fractional ticks while adjusting offset').item.dateCreated,
    '2023-12-31T10:30:00.7654321Z');
  assert.equal(byName.get('dateadded canonicalizes no fraction to seven zero digits').item.dateCreated,
    '2024-02-03T04:05:06.0000000Z');
  assert.deepEqual(byName.get('provider node lookup is case insensitive and invalid overwrite is rejected').item.providers,
    { Imdb: 'tt8765432', Tmdb: '88', Tvdb: 'anything' });
  assert.deepEqual(byName.get('pre-cancelled movie url only commits providers and completes').item.providers,
    { Imdb: 'tt4567890', Tmdb: '701' });
  assert.equal(byName.get('pre-cancelled movie url only commits providers and completes').exception, null);
  assert.equal(byName.get('pre-cancelled movie paired empty root observes cancellation').exception, 'OperationCanceledException');
  assert.equal(byName.get('pre-cancelled strict malformed setup fails before cancellation').exception, 'XmlException');
  assert.equal(byName.get('pre-cancelled movie no-closing malformed setup is treated as url only').hasMetadata, true);
});

test('sync and async production parsers match every native scalar and provider result', async () => {
  const report = [];
  for (const [index, sample] of [...input, ...layouts.input].entries()) {
    const expected = [...native.results, ...layouts.native.results][index];
    const frozen = { exception: expected.exception, hasMetadata: expected.hasMetadata, item: expected.item, people: expected.people };
    for (const mode of ['sync', 'async']) {
      const actual = await candidateResult(sample, expected, mode);
      const paths = differencePaths(actual, frozen);
      if (paths.length) report.push({ name: sample.name, mode, paths });
    }
  }
  if (process.env.MEDIAMANAGER_CAPTURE_NFO_SCALAR_DIFF === '1') {
    process.stdout.write(`NFO_SCALAR_DIFF=${JSON.stringify(report)}\n`);
  }
  assert.deepEqual(report, []);
});
