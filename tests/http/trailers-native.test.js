import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { parseQuery } from '../../src/library/query.js';
import { dateTicks } from '../../src/library/records.js';
import { AuthenticationService } from '../../src/users/authentication-service.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createTestApplication } from '../helpers/application.js';
import { errorObservation } from '../helpers/error-observation.js';
import { projectProblemTrace } from '../helpers/http-body-projection.js';
import { makeInput, userId, arrayParameters, dateParameters, guidParameters, guidArrays } from './fixtures/trailers-current/input.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE;
const hash = value => createHash('sha256').update(value).digest('hex');
const key = value => value?.replaceAll('-', '').toLowerCase() ?? null;
const arrays = new Set(arrayParameters.map(name => name.toLowerCase()));
const dates = new Set(dateParameters.map(name => name.toLowerCase()));
const guids = new Set(guidParameters.map(name => name.toLowerCase()));
const ids = new Set(guidArrays.map(name => name.toLowerCase()));
const wire = observation => {
  const json = projectProblemTrace(observation.json, observation.status);
  return { status: observation.status, contentType: observation.contentType?.trim() ?? null,
    ...(json !== null && json !== undefined ? { json } : { body: observation.body }) };
};

// Only reader-neutral representations are projected. Native bound arguments,
// Node input/query and both original HTTP bodies remain in the comparison file.
function nodeValue(name, query) {
  const normalized = name.toLowerCase(), property = normalized === 'seriesstatus' ? 'seriesstatuses' : normalized;
  const value = query[property];
  if (dates.has(normalized)) return value == null ? null : { utcTicks: dateTicks(value).toString() };
  if (guids.has(normalized)) return key(value);
  if (ids.has(normalized)) return (value ?? []).map(key);
  if (normalized === 'years') return (value ?? []).map(Number);
  return value ?? (arrays.has(normalized) ? [] : null);
}

function request(origin, sample, signal) {
  return new Promise((resolve, reject) => {
    const body = sample.body === undefined ? undefined : Buffer.from(sample.body);
    const request = httpRequest(origin + sample.path, { method: 'GET', signal,
      headers: { Accept: 'application/json', 'X-Identity': sample.identity ?? 'admin',
        ...(body ? { 'Content-Type': sample.contentType ?? 'application/json', 'Content-Length': body.length } : {}) } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk)); response.once('error', reject);
      response.once('end', () => {
        const body = Buffer.concat(chunks).toString('utf8'); let json = null;
        try { json = JSON.parse(body); } catch { }
        resolve({ name: sample.name, path: sample.path, status: response.statusCode, body, json,
          contentType: response.headers['content-type'] ?? null });
      });
    });
    request.once('error', reject); request.end(body);
  });
}

test('Trailers uses specified native MVC binding, actual controller delegation and formal Node HTTP', { skip: !enabled, timeout: 300000 }, async t => {
  const input = makeInput(), bytes = Buffer.from(JSON.stringify(input));
  const output = path.join(validationOutputRoot(), 'trailers-native-' + randomUUID()); await mkdir(output, { recursive: true });
  const inputFile = path.join(output, 'input.json'); await writeFile(inputFile, bytes);
  const report = { comparisons: [], differences: [], cleanup: {}, componentAcceptance: false, phaseAcceptance: false, releaseAcceptance: false,
    boundary: { native: ['TrailersController', 'injected ItemsController', 'actual AddJellyfinApi controller activation',
      'actual comma/pipe collection binders', 'default authorization', 'ExceptionMiddleware'],
    node: ['createApplication', 'formal Trailers binding and public failure', 'AuthenticationService authorization', 'Items query controls'],
    controlled: ['authentication identity', 'user lookup', 'empty UserRootFolder result', 'library/DTO/search/rating services'],
    excluded: ['SQL selection and full library business', 'production runtime', 'media execution'],
    controllerContextAssignedByFixture: false } };
  let current, application, failed = false, failure;
  const compare = (name, actual, expected) => {
    try { assert.deepEqual(actual, expected, name); }
    catch (error) { report.differences.push({ name, actual, expected, error: errorObservation(error) }); }
  };
  try {
    current = await currentNativeReference(); report.preparation = current.preparation;
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/TrailersController.cs',
      'Jellyfin.Api/Controllers/ItemsController.cs', 'Jellyfin.Api/BaseJellyfinApiController.cs',
      'Jellyfin.Api/Helpers/RequestHelpers.cs', 'Jellyfin.Api/ModelBinders/CommaDelimitedCollectionModelBinder.cs',
      'Jellyfin.Api/ModelBinders/PipeDelimitedCollectionModelBinder.cs', 'Jellyfin.Api/Middleware/ExceptionMiddleware.cs',
      'Jellyfin.Api/Auth/DefaultAuthorizationPolicy/DefaultAuthorizationHandler.cs',
      'Jellyfin.Server/Extensions/ApiServiceCollectionExtensions.cs', 'MediaBrowser.Controller/Entities/InternalItemsQuery.cs',
      'MediaBrowser.Controller/Entities/Folder.cs', 'MediaBrowser.Controller/Entities/UserRootFolder.cs',
      'MediaBrowser.Controller/Dto/IDtoService.cs', 'MediaBrowser.Controller/Library/ISearchManager.cs']);
    const receipt = await recordOracle({ project: 'tests/http/fixtures/trailers-current/Oracle.csproj', output: path.join(output, 'native'),
      args: [inputFile, '{output}/native.json'] });
    assert.equal(receipt.passed, true);
    const nativeBytes = await readFile(path.join(output, 'native/native.json')), native = JSON.parse(nativeBytes);
    assert.equal(native.inputSha256, hash(bytes));
    assert.equal(receipt.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, hash(nativeBytes));
    for (const flag of ['actualMvc', 'actualTrailersController', 'actualInjectedItemsController', 'actualCollectionBinders',
      'actualDefaultAuthorization', 'actualExceptionMiddleware', 'hostStopped', 'hostDisposed']) assert.equal(native[flag], true, flag);
    assert.equal(native.controllerContextAssignedByFixture, false); assert.equal(native.mediaExecutionStarted, false);
    for (const assembly of native.assemblies) assert.equal(hash(await readFile(assembly.filename)), assembly.sha256);
    assert.equal(native.observations.length, input.requests.length);
    const captures = [], lookups = [], diagnostics = [];
    const user = { Id: userId, Policy: { IsAdministrator: true }, Configuration: {} };
    const users = { getUser: async id => { lookups.push(key(id)); return key(id) === userId ? user : null; } };
    const authentication = new AuthenticationService({ store: {}, users, serverId: 'trailer-binding', isLocalNetwork: () => true });
    authentication.authenticate = async request => {
      const identity = request.headers['x-identity'] ?? 'admin', apiKey = identity === 'apiKey';
      const currentUser = apiKey || identity === 'anonymous' ? null : await users.getUser(userId);
      return { IsAuthenticated: identity !== 'anonymous', IsApiKey: apiKey, IsAdministrator: !['regular', 'anonymous'].includes(identity),
        UserId: apiKey ? '0'.repeat(32) : userId, User: currentUser };
    };
    const captureItems = async (input, options) => {
      const capture = { rawInput: [...input], UserId: key(options.user?.Id), IsApiKey: options.isApiKey, parsed: null };
      captures.push(capture);
      const query = parseQuery(input, { allowNegativePaging: true }); capture.parsed = structuredClone(query);
      return { Items: [], TotalRecordCount: 0, StartIndex: query.startindex ?? 0 };
    };
    const library = { queryItems: captureItems, queryResumeItems: captureItems };
    application = await createTestApplication({ configuration: { IsStartupWizardCompleted: true }, users, authentication, library,
      onError: error => diagnostics.push(errorObservation(error)) });
    await new Promise((resolve, reject) => {
      application.server.once('error', reject); application.server.listen(0, '127.0.0.1', () => { application.server.off('error', reject); resolve(); });
    });
    const origin = 'http://127.0.0.1:' + application.server.address().port;
    for (const [index, sample] of input.requests.entries()) {
      const expected = native.observations[index]; assert.equal(expected.name, sample.name); assert.equal(expected.path, sample.path);
      assert.equal(expected.status, sample.expectedStatus, sample.name + ': observed native public status');
      captures.length = 0; lookups.length = 0; const diagnosticStart = diagnostics.length;
      const actual = await request(origin, sample, AbortSignal.any([t.signal, AbortSignal.timeout(30000)]));
      Object.assign(actual, { captures: structuredClone(captures), lookups: [...lookups], diagnostics: diagnostics.slice(diagnosticStart) });
      compare(sample.name + ': original HTTP contract', wire(actual), wire(expected));
      if (actual.json?.traceId !== undefined) assert.equal(typeof actual.json.traceId, 'string');
      if (expected.json?.traceId !== undefined) assert.equal(typeof expected.json.traceId, 'string');
      if (sample.path.startsWith('/Trailers') && expected.status === 500) {
        compare(sample.name + ': no item query before the public failure', actual.captures, []);
      }
      // Trailers' unused bound values remain diagnostics. Only successful Items
      // controls consume these selectors and require their functional projection.
      if (expected.bindings.length && actual.captures[0]?.parsed) {
        const bound = Object.fromEntries(Object.entries(expected.bindings[0].arguments).map(([name, value]) => [name.toLowerCase(), value]));
        const query = actual.captures[0].parsed;
        for (const name of sample.compare ?? []) {
          compare(sample.name + ': actual bound ' + name, nodeValue(name, query), bound[name.toLowerCase()] ?? null);
        }
        compare(sample.name + ': forced Trailer source', query.includeitemtypes, ['Trailer']);
        for (const name of sample.ignored ?? []) {
          compare(sample.name + ': Node ignores ' + name, actual.captures[0].rawInput.some(([key]) => key.toLowerCase() === name), false);
          compare(sample.name + ': native ignores ' + name, Object.hasOwn(bound, name), false);
        }
      }
      for (const query of expected.queries) compare(sample.name + ': native forced Trailer query', query.IncludeItemTypes, ['Trailer']);
      report.comparisons.push({ name: sample.name, declaredStatus: sample.expectedStatus ?? 200, actual, expected });
    }
    assert.deepEqual(report.differences, [], JSON.stringify(report.differences)); report.componentAcceptance = true;
  } catch (error) { failed = true; failure = error; throw error; }
  finally {
    const errors = []; report.failure = failed ? errorObservation(failure) : null;
    try {
      application?.beginClose(); await application?.drainRequests();
      if (application?.server.listening) await new Promise((resolve, reject) => application.server.close(error => error ? reject(error) : resolve()));
      report.cleanup.nodeHostClosed = true;
    } catch (error) { errors.push(error); }
    try { await current?.finish(); report.cleanup.referenceVerified = true; } catch (error) { errors.push(error); }
    if (errors.length) { report.componentAcceptance = false; report.cleanup.errors = errors.map(error => errorObservation(error)); }
    try { await writeFile(path.join(output, 'comparison.json'), JSON.stringify(report, null, 2) + '\n'); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(failed ? [failure, ...errors] : errors, 'Trailer MVC fixture cleanup failed.', failed ? { cause: failure } : undefined);
  }
});
