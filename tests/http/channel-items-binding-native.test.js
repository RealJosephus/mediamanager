import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createTestApplication } from '../helpers/application.js';
import { projectProblemTrace } from '../helpers/http-body-projection.js';
import { AuthenticationService } from '../../src/users/authentication-service.js';
import { makeInput, userId } from './fixtures/channel-items-binding/input.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE;
const hash = value => createHash('sha256').update(value).digest('hex');
const errorRecord = error => ({ type: error.nativeException ?? error.name, status: error.status ?? error.statusCode ?? 500, Message: error.message, StackTrace: error.stack });
const key = value => value?.replaceAll('-', '').toLowerCase() ?? null;
const wire = observation => {
  const json = projectProblemTrace(observation.json && structuredClone(observation.json), observation.status);
  return { status: observation.status, contentType: observation.contentType?.trim() ?? null,
    ...(json !== null && json !== undefined ? { json } : { body: observation.body }) };
};

test('Channel Items and Latest use the actual MVC query, filters and authorization contract', { skip: !enabled, timeout: 300000 }, async () => {
  const input = makeInput(), bytes = Buffer.from(JSON.stringify(input));
  const output = path.join(validationOutputRoot(), 'channel-items-binding-' + randomUUID()); await mkdir(output, { recursive: true });
  const inputFile = path.join(output, 'input.json'); await writeFile(inputFile, bytes);
  const report = { comparisons: [], differences: [], cleanup: {}, componentAcceptance: false, phaseAcceptance: false, releaseAcceptance: false,
    boundary: { native: ['ChannelsController', 'AddJellyfinApi MVC', 'CommaDelimitedCollectionModelBinder', 'default authorization', 'ExceptionMiddleware'],
      node: ['createApplication', 'formal Channel Items/Latest routes', 'AuthenticationService authorization'],
      controlled: ['authentication identity', 'user lookup', 'IChannelManager empty result/recorded query'],
      excluded: ['Channel provider/cache/SQL business', 'full production runtime', 'media execution'] } };
  let current, application, failure;
  const compare = (name, actual, expected) => { try { assert.deepEqual(actual, expected, name); } catch (error) { report.differences.push({ name, actual, expected, error: errorRecord(error) }); } };
  try {
    current = await currentNativeReference(); report.preparation = current.preparation;
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/ChannelsController.cs', 'Jellyfin.Api/Helpers/RequestHelpers.cs',
      'Jellyfin.Api/ModelBinders/CommaDelimitedCollectionModelBinder.cs', 'Jellyfin.Api/Middleware/ExceptionMiddleware.cs',
      'Jellyfin.Api/Auth/DefaultAuthorizationPolicy/DefaultAuthorizationHandler.cs',
      'MediaBrowser.Controller/Entities/InternalItemsQuery.cs', 'MediaBrowser.Model/Querying/ItemFilter.cs', 'MediaBrowser.Model/Querying/QueryResult.cs']);
    const receipt = await recordOracle({ project: 'tests/http/fixtures/channel-items-binding/Oracle.csproj', output: path.join(output, 'native'), args: [inputFile, '{output}/native.json'] });
    assert.equal(receipt.passed, true); const nativeBytes = await readFile(path.join(output, 'native/native.json')), native = JSON.parse(nativeBytes);
    assert.equal(hash(bytes), native.inputSha256); assert.equal(receipt.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, hash(nativeBytes));
    for (const field of ['actualMvc', 'actualController', 'actualCommaBinder', 'actualDefaultAuthorization', 'actualExceptionMiddleware', 'hostStopped', 'hostDisposed']) assert.equal(native[field], true, field);
    assert.equal(native.mediaExecutionStarted, false);
    for (const assembly of native.assemblies) assert.equal(hash(await readFile(assembly.filename)), assembly.sha256);
    const queries = [], lookups = [], diagnostics = []; report.diagnostics = diagnostics;
    const user = { Id: userId, Policy: { IsAdministrator: true }, Configuration: {} };
    const users = { getUser: async id => { lookups.push(key(id)); return key(id) === userId ? user : null; } };
    const authentication = new AuthenticationService({ store: {}, users, serverId: 'channel-binding', isLocalNetwork: () => true });
    authentication.authenticate = async request => {
      const identity = request.headers['x-identity'] ?? 'admin', apiKey = identity === 'apiKey';
      const authenticatedUser = apiKey || identity === 'anonymous' ? null : await users.getUser(userId);
      return { IsAuthenticated: identity !== 'anonymous', IsApiKey: apiKey, IsAdministrator: !['regular', 'anonymous'].includes(identity),
        UserId: apiKey ? '0'.repeat(32) : userId, User: authenticatedUser };
    };
    const capture = kind => async query => {
      const user = query.User;
      queries.push({ kind, UserId: key(user?.Id), ParentId: key(query.ParentId) ?? '0'.repeat(32),
        ChannelIds: query.ChannelIds, StartIndex: query.StartIndex ?? null, Limit: query.Limit ?? null,
        OrderBy: (query.OrderBy ?? []).map(pair => pair.map(String)), Fields: (query.Fields ?? []).map(String),
        ...Object.fromEntries(['IsFolder', 'IsPlayed', 'IsFavorite', 'IsResumable', 'IsLiked', 'IsFavoriteOrLiked'].map(field => [field, query[field] ?? null])) });
      return { Items: [], TotalRecordCount: 0, StartIndex: query.StartIndex ?? 0 };
    };
    const channels = { getChannelItems: capture('items'), getLatestChannelItems: capture('latest') };
    application = await createTestApplication({ configuration: { IsStartupWizardCompleted: true }, authentication, users, channels, onError: error => diagnostics.push(errorRecord(error)) });
    await new Promise((resolve, reject) => { application.server.once('error', reject); application.server.listen(0, '127.0.0.1', () => { application.server.off('error', reject); resolve(); }); });
    for (const [index, request] of input.requests.entries()) {
      const expected = native.observations[index]; assert.equal(expected.name, request.name); assert.equal(expected.path, request.path);
      assert.equal(expected.status, request.status ?? 200, request.name + ': declared native status');
      queries.length = 0; lookups.length = 0; const diagnosticStart = diagnostics.length;
      const response = await fetch('http://127.0.0.1:' + application.server.address().port + request.path, { headers: { Accept: 'application/json', 'X-Identity': request.identity ?? 'admin' } });
      const body = await response.text(); let json = null; try { json = JSON.parse(body); } catch { }
      const actual = { name: request.name, path: request.path, status: response.status, body, json, contentType: response.headers.get('content-type'),
        queries: structuredClone(queries), lookups: [...lookups], diagnostics: diagnostics.slice(diagnosticStart) };
      compare(request.name + ': actual MVC wire', wire(actual), wire(expected));
      compare(request.name + ': actual controller query', actual.queries, expected.queries);
      compare(request.name + ': actual user lookup order', actual.lookups, expected.lookups);
      report.comparisons.push({ name: request.name, actual, expected });
    }
    assert.deepEqual(report.differences, [], JSON.stringify(report.differences)); report.componentAcceptance = true;
  } catch (error) { failure = error; throw error; }
  finally {
    const errors = []; report.failure = failure ? errorRecord(failure) : null;
    try { application?.beginClose(); await application?.drainRequests(); if (application?.server.listening) await new Promise((resolve, reject) => application.server.close(error => error ? reject(error) : resolve())); report.cleanup.nodeHostClosed = true; } catch (error) { errors.push(error); }
    try { await current?.finish(); report.cleanup.referenceVerified = true; } catch (error) { errors.push(error); }
    if (errors.length) { report.componentAcceptance = false; report.cleanup.errors = errors.map(errorRecord); }
    try { await writeFile(path.join(output, 'comparison.json'), JSON.stringify(report, null, 2)); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors, failure?.message ?? 'Channel MVC binding cleanup failed.', failure ? { cause: failure } : undefined);
  }
});
