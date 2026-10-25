import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { TmdbClient } from '../../plugins/tmdb/client.js';
import { createTmdbPlugin } from '../../plugins/tmdb/plugin.js';
import { tmdbClientInput as input } from './fixtures/tmdb-client-current/input.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { validationOutputRoot, assertValidationOutputChild } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const root = new URL('./fixtures/tmdb-client-current/', import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n';
const errorValue = error => error == null ? null : { name: error.name, message: error.message,
  code: error.code, status: error.status, retryAfter: error.retryAfter,
  cause: error.cause === undefined ? undefined : errorValue(error.cause),
  errors: error.errors === undefined ? undefined : Array.from(error.errors, errorValue) };

async function invoke(client, operation, signal) {
  const options = { signal }, language = 'en', images = 'en,null', country = 'US';
  const detail = value => value == null ? null : { id: value.id, name: operation === 'movie' ? value.title : value.name };
  switch (operation) {
    case 'configuration': return { secureBaseUrl: (await client.getClientConfiguration()).images?.secure_base_url ?? null };
    case 'movie': return detail(await client.movie(1, language, images, country, options));
    case 'series': return detail(await client.series(1, language, images, country, options));
    case 'season': return detail(await client.season(1, 1, language, images, country, options));
    case 'episode': return detail(await client.episode(1, 1, 1, '', language, images, country, options));
    case 'person': return detail(await client.person(1, language, country, options));
    case 'collection': return detail(await client.collection(1, language, images, country, options));
    case 'find': return (await client.find('tt0000001', 'imdb_id', language, country, options))?.movie_results
      ?.map(value => ({ id: value.id, name: value.title })) ?? null;
    case 'search': return (await client.search('Movie', 'Recovery', 2020, language, country, options))
      ?.map(value => ({ id: value.id, name: value.title })) ?? null;
    case 'recommendationsMovie':
    case 'recommendationsSeries': {
      const movie = operation === 'recommendationsMovie';
      const result = await client.recommendations(movie ? 'Movie' : 'Series', 1, 1, language, options);
      return { results: result.Results.map(value => ({ id: value.id, name: movie ? value.title : value.name })),
        totalPages: result.TotalPages };
    }
    case 'provider': {
      const provider = createTmdbPlugin({ client }).providers.find(value => value.id === 'TmdbMovieProvider');
      const result = await provider.getMetadata({ Name: 'Incoming title', MetadataLanguage: language,
        MetadataCountryCode: country, ProviderIds: { Tmdb: '1' } }, options);
      return { HasMetadata: result.HasMetadata, name: result.Item?.Name ?? null, overview: result.Item?.Overview ?? null,
        providerIds: result.Item?.ProviderIds ?? null, productionYear: result.Item?.ProductionYear ?? null };
    }
    default: throw new Error('Unknown controlled TMDB operation.');
  }
}

async function candidateCase(sample) {
  const requests = [], calls = [], timers = new Set();
  const started = performance.now();
  let responseIndex = 0, callIndex = 0, cancellation;
  const elapsed = () => performance.now() - started;
  const client = new TmdbClient({ apiKey: 'fixture-key', baseUrl: 'http://tmdb.invalid/3/', fetch: async (uri, settings) => {
    settings.signal.throwIfAborted();
    const configuration = uri.pathname.endsWith('/configuration');
    const targeted = configuration === (sample.operation === 'configuration' || sample.throttleConfiguration === true);
    const index = targeted ? responseIndex++ : -1;
    const status = targeted ? sample.statuses[Math.min(index, sample.statuses.length - 1)] : 200;
    const success = status >= 200 && status < 300;
    const property = success ? 'contentType' : 'errorContentType';
    const contentType = targeted && Object.hasOwn(sample, property) ? sample[property] : 'application/json';
    let body = JSON.stringify(configuration ? input.configuration : input.responses[sample.operation]);
    if (!success) body = '{"status_code":25,"status_message":"Controlled TMDB failure"}';
    const bodyProperty = success ? 'bodyText' : 'errorText';
    if (targeted && Object.hasOwn(sample, bodyProperty)) body = sample[bodyProperty];
    const retryAfter = status === 429 ? sample.retryAfter ?? null : null;
    const headers = new Headers();
    if (contentType != null) headers.set('content-type', contentType);
    if (retryAfter != null) headers.set('retry-after', retryAfter);
    requests.push({ callIndex, method: settings.method ?? 'GET', uri: uri.toString(), requestBodySha256: sha(Buffer.alloc(0)),
      status, contentType, responseBody: body, retryAfter, responseMs: elapsed() });
    if (targeted && sample.cancelResponse === index + 1) {
      const controller = cancellation;
      const timer = setTimeout(() => {
        timers.delete(timer); controller.abort(new Error('Controlled TMDB caller cancellation.'));
      }, sample.cancelAfterMs);
      timers.add(timer);
    }
    return new Response(Buffer.from(body), { status, headers });
  } });
  try {
    for (; callIndex < sample.repeats; callIndex++) {
      cancellation = new AbortController();
      if (sample.cancelBefore) cancellation.abort(new Error('Controlled TMDB caller cancellation.'));
      const start = elapsed();
      let value = null, failure;
      try { value = await invoke(client, sample.operation, cancellation.signal); }
      catch (error) { failure = error; }
      calls.push({ outcome: failure ? cancellation.signal.aborted ? 'cancelled' : 'error' : 'success', value,
        startedMs: start, completedMs: elapsed(), diagnostic: errorValue(failure) });
    }
    return { name: sample.name, calls, requests };
  } finally { for (const timer of timers) clearTimeout(timer); client.close(); }
}

const requestProjection = request => {
  const { uri, responseMs: _responseMs, ...other } = request;
  const url = new URL(uri);
  // append_to_response names independent expansions. Its spelling order does
  // not change the requested resources; image language order stays intact.
  const query = [...url.searchParams].map(([key, value]) => [key,
    key === 'append_to_response' ? value.split(',').sort().join(',') : value]);
  query.sort(([left, leftValue], [right, rightValue]) => left < right ? -1 : left > right ? 1
    : leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0);
  return { ...other, origin: url.origin, path: url.pathname, query };
};
const functional = result => ({ name: result.name,
  calls: result.calls.map(({ outcome, value }) => ({ outcome, value })), requests: result.requests.map(requestProjection) });

function verifyWaits(result, sample) {
  for (const [index, request] of result.requests.entries()) {
    if (request.status !== 429 || sample.errorText === '{') continue;
    const next = result.requests[index + 1];
    const call = result.calls[request.callIndex];
    if ((!next || next.callIndex !== request.callIndex) && call.outcome === 'cancelled') continue;
    const completed = next?.callIndex === request.callIndex ? next.responseMs : call.completedMs;
    const delay = /^\d+$/u.test(sample.retryAfter ?? '') && Number(sample.retryAfter) > 0
      ? Number(sample.retryAfter) * 1000 : 1000;
    assert.ok(completed - request.responseMs >= delay - 100,
      `${sample.name}: each completed rate-limit wait must delay the next request or final failure.`);
  }
}

test('current TMDB manager and library transport preserve retry, cancellation, null, cache and provider effects', {
  skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 240000,
}, async t => {
  const output = path.join(validationOutputRoot(), 'tmdb-client-current-' + randomUUID());
  assertValidationOutputChild(output); await mkdir(output);
  const inputBytes = Buffer.from(JSON.stringify(input) + '\n'), inputFile = path.join(output, 'input.json');
  const report = { schemaVersion: 1, inputSha256: sha(inputBytes), sourceBindings: [], dependencySources: [], cases: [], differences: [],
    phaseAcceptance: false, releaseAcceptance: false, scope: 'Current Native manager and TMDbLib with controlled HTTP responses; Node client, cache and Movie provider. No live TMDB, public host HTTP or database persistence.' };
  try {
    const dependency = JSON.parse(await readFile(new URL('dependency-source.json', root), 'utf8'));
    report.dependency = dependency;
    for (const file of dependency.files) {
      const actual = await describeFile(fileURLToPath(new URL(file.path, root)));
      assert.equal(actual.available, true, file.path);
      assert.equal(actual.sha256, file.sha256, file.path); assert.equal(actual.bytes, file.bytes, file.path);
      report.dependencySources.push(actual);
    }
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const packageManifest = await describeFile(path.join(build.nugetRoot, 'tmdblib/3.0.0/tmdblib.nuspec'));
    const expectedNuspec = dependency.files.find(file => file.path.endsWith('/tmdblib.nuspec'));
    assert.equal(packageManifest.sha256, expectedNuspec.sha256, 'The executing dependency must retain the supplied package source identity.');
    report.packageManifest = packageManifest;
    const manifest = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    for (const relativePath of ['MediaBrowser.Providers/Plugins/Tmdb/TmdbClientManager.cs',
      'MediaBrowser.Providers/Plugins/Tmdb/Movies/TmdbMovieProvider.cs', 'Directory.Packages.props']) {
      const expected = manifest.files.find(value => value.path === relativePath);
      assert.ok(expected, relativePath);
      const actual = await describeFile(path.join(build.sourceRoot, relativePath));
      assert.equal(actual.sha256, expected.sha256, relativePath);
      report.sourceBindings.push({ relativePath, ...actual });
    }
    await writeFile(inputFile, inputBytes, { flag: 'wx' });
    const nativeRoot = path.join(output, 'native');
    report.capture = await recordOracle({ project: 'tests/metadata/fixtures/tmdb-client-current/Oracle.csproj',
      output: nativeRoot, args: [inputFile, '{output}/native.json'] });
    const filename = path.join(nativeRoot, 'native.json'), nativeBytes = await readFile(filename), native = JSON.parse(nativeBytes);
    report.observation = await describeFile(filename);
    assert.equal(native.actualExecution, true); assert.equal(native.inputSha256, sha(inputBytes));
    assert.equal(report.capture.outputs.find(value => value.filename === filename)?.sha256, sha(nativeBytes));
    for (const assembly of native.assemblies) {
      const actual = await describeFile(path.join(build.runtime, assembly.name + '.dll'));
      assert.equal(actual.sha256, assembly.sha256, assembly.name);
    }
    assert.deepEqual(native.results.map(value => value.name), input.cases.map(value => value.name));
    for (const [index, sample] of input.cases.entries()) {
      const reference = native.results[index], candidate = await candidateCase(sample);
      report.cases.push({ name: sample.name, reference, candidate });
      try {
        assert.deepEqual(functional(candidate), functional(reference), sample.name);
        verifyWaits(reference, sample); verifyWaits(candidate, sample);
      } catch (error) { report.differences.push({ name: sample.name, diagnostic: errorValue(error) }); }
      await writeFile(path.join(output, 'report.json'), json(report));
    }
    t.diagnostic('TMDB current observations: ' + output);
    assert.deepEqual(report.differences, []);
  } catch (error) { report.error = errorValue(error); throw error; }
  finally { await writeFile(path.join(output, 'report.json'), json(report)); }
});
