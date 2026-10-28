import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { inspect } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createTestApplication } from '../helpers/application.js';
import { AuthenticationService } from '../../src/users/authentication-service.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { cloneNativeValue, parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { serverConfigurationDto } from '../../src/http/server-configuration-binding.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { serverConfigurationBindingInput } from './fixtures/server-configuration-binding/input.js';
import { errorObservation } from '../helpers/error-observation.js';
import { projectProblemTrace } from '../helpers/http-body-projection.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const hash = value => createHash('sha256').update(value).digest('hex');
const enabled = Boolean(process.env.MEDIAMANAGER_JELLYFIN_DLL);
const userId = 'f81b0000000000000000000000000001';
const baseline = () => ({ ...defaultConfiguration('server'), IsStartupWizardCompleted: true,
  PreviousVersion: '10.20.30', PreviousVersionStr: '10.20.30' });
const errorJson = (_key, value) => value instanceof Error
  ? { name: value.name, ...Object.fromEntries(Object.getOwnPropertyNames(value).map(key => [key, value[key]])) }
  : typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value;
const wire = value => {
  const json = projectProblemTrace(value.json === null ? null : cloneNativeValue(value.json), value.status);
  return { status: value.status, contentType: value.contentType ?? null,
    ...(json !== null ? { json } : { text: value.text }) };
};

test('server configuration and metadata defaults match current MVC, typed setters, validation and authorization', {
  skip: !enabled, timeout: 300000,
}, async () => {
  const output = path.join(validationOutputRoot(), 'server-configuration-binding-' + randomUUID());
  await mkdir(output);
  const input = serverConfigurationBindingInput(), inputBytes = Buffer.from(JSON.stringify(input));
  const inputFile = path.join(output, 'input.json'); await writeFile(inputFile, inputBytes, { flag: 'wx' });
  const report = { scope: 'Current MVC and typed model component with a controlled configuration replacement boundary.',
    inputSha256: hash(inputBytes), comparisons: [], differences: [], cleanup: {},
    componentAcceptance: false, phaseAcceptance: false, releaseAcceptance: false,
    excluded: ['production manager path validation and persistence', 'configuration events and runtime consumers', 'PostgreSQL and restart'] };
  let application, failed = false, failure, activeRequest;
  const unownedErrors = [];
  try {
    const build = await verifyNativeBuild();
    report.nativeBuild = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256 };
    const manifest = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    report.sourceBindings = [];
    for (const relative of ['Jellyfin.Api/Controllers/ConfigurationController.cs', 'MediaBrowser.Model/Configuration/ServerConfiguration.cs',
      'MediaBrowser.Model/Configuration/BaseApplicationConfiguration.cs', 'MediaBrowser.Model/Configuration/MetadataOptions.cs',
      'MediaBrowser.Model/System/CastReceiverApplication.cs', 'MediaBrowser.Model/Configuration/PathSubstitution.cs',
      'MediaBrowser.Model/Configuration/TrickplayOptions.cs', 'MediaBrowser.Model/Updates/RepositoryInfo.cs', 'MediaBrowser.Model/Dto/NameValuePair.cs',
      'src/Jellyfin.Extensions/Json/JsonDefaults.cs', 'src/Jellyfin.Extensions/Json/Converters/JsonVersionConverter.cs',
      'src/Jellyfin.Extensions/Json/Converters/JsonStringConverter.cs', 'Jellyfin.Server/Extensions/ApiServiceCollectionExtensions.cs',
      'Jellyfin.Api/Auth/DefaultAuthorizationPolicy/DefaultAuthorizationHandler.cs', 'Jellyfin.Api/Middleware/ExceptionMiddleware.cs']) {
      const expected = manifest.files.find(value => value.path === relative); assert.ok(expected, relative);
      const source = await describeFile(path.join(build.root, 'source', relative));
      assert.equal(source.available, true, relative); assert.equal(source.sha256, expected.sha256, relative);
      report.sourceBindings.push({ relative, source });
    }
    report.oracle = await recordOracle({ project: 'tests/http/fixtures/server-configuration-binding/Oracle.csproj',
      output: path.join(output, 'native'), args: [inputFile, '{output}/native.json'] });
    const nativeBytes = await readFile(path.join(output, 'native/native.json'));
    const native = parseLosslessJson(nativeBytes.toString('utf8'));
    assert.equal(native.inputSha256, hash(inputBytes));
    assert.equal(report.oracle.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, hash(nativeBytes));
    for (const name of ['actualMvc', 'actualController', 'actualTypedModelsAndSetters', 'actualDefaultAuthorization',
      'actualExceptionMiddleware', 'hostStopped', 'hostDisposed']) assert.equal(native[name], true, name);
    assert.equal(native.persistenceOrRuntimeConsumersExecuted, false);
    for (const assembly of native.assemblies) {
      assert.equal(hash(await readFile(assembly.filename)), assembly.sha256);
      assert.equal(hash(await readFile(path.join(build.runtime, path.basename(assembly.filename)))), assembly.sha256);
    }
    report.nativeProcessorCount = native.processorCount;
    const received = [];
    const user = { Id: userId, Policy: { IsAdministrator: false, EnableRemoteAccess: true }, AccessSchedules: [] };
    const authentication = new AuthenticationService({ store: {}, users: {}, serverId: 'configuration-binding', isLocalNetwork: () => true });
    authentication.authenticate = async request => {
      const identity = request.headers['x-identity'] ?? 'admin';
      const isAuthenticated = !['anonymous', 'invalid'].includes(identity);
      return { IsAuthenticated: isAuthenticated, IsApiKey: identity === 'apiKey',
        IsAdministrator: isAuthenticated && identity !== 'regular', UserId: userId, User: user };
    };
    const configurationStore = { configuration: baseline(), async replaceConfiguration(value) {
      received.push(cloneNativeValue(value));
      if (activeRequest.sample.rejectReplacement) {
        const error = Object.assign(new Error('Controlled configuration replacement failure.'), { code: 'controlled-configuration-replacement' });
        activeRequest.replacementFailed = true; activeRequest.replacementFailure = errorObservation(error); throw error;
      }
      this.configuration = value;
    } };
    application = await createTestApplication({ get configuration() { return configurationStore.configuration; }, configurationStore, authentication, onError: error => {
      const snapshot = { failure: errorObservation(error), raw: inspect(error, { depth: null }) };
      if (activeRequest?.open) activeRequest.diagnostics.push(snapshot);
      else unownedErrors.push(snapshot);
    } });
    await new Promise((resolve, reject) => { application.server.once('error', reject); application.server.listen(0, '127.0.0.1', () => {
      application.server.off('error', reject); resolve();
    }); });
    const compare = (name, actual, expected) => {
      try { assert.deepEqual(actual, expected, name); }
      catch (error) { report.differences.push({ name, actual, expected, message: error.message }); }
    };
    assert.equal(native.observations.length, input.length);
    for (const [index, sample] of input.entries()) {
      configurationStore.configuration = baseline(); received.length = 0;
      activeRequest = { index, sample, open: true, diagnostics: [], replacementFailed: false };
      const response = await fetch('http://127.0.0.1:' + application.server.address().port + sample.path, {
        method: sample.method, headers: { Accept: sample.accept ?? 'application/json', 'X-Identity': sample.identity ?? 'admin',
          ...(Object.hasOwn(sample, 'body') ? { 'Content-Type': sample.contentType ?? 'application/json' } : {}) },
        ...(Object.hasOwn(sample, 'body') ? { body: sample.body } : {}),
      });
      const text = await response.text(); let json = null;
      try { json = parseLosslessJson(text); } catch { }
      let currentRead = null;
      if (response.ok && sample.method === 'POST' && received.length) {
        const read = await fetch('http://127.0.0.1:' + application.server.address().port + '/System/Configuration', {
          headers: { Accept: 'application/json', 'X-Identity': sample.identity ?? 'admin' },
        });
        const text = await read.text(); let json = null;
        try { json = parseLosslessJson(text); } catch { }
        currentRead = { status: read.status, contentType: read.headers.get('content-type'), text, json };
      }
      activeRequest.open = false;
      const actual = { name: sample.name, status: response.status, contentType: response.headers.get('content-type'), text, json,
        received: cloneNativeValue(received), live: serverConfigurationDto(configurationStore.configuration), currentRead, diagnostics: activeRequest.diagnostics,
        replacementFailed: activeRequest.replacementFailed, replacementFailure: activeRequest.replacementFailure };
      const expected = native.observations[index]; assert.equal(expected.name, sample.name);
      compare(sample.name + ': full public wire', wire(actual), wire(expected));
      compare(sample.name + ': complete typed replacement arguments', actual.received, expected.received);
      compare(sample.name + ': complete live model', actual.live, expected.live);
      compare(sample.name + ': current configuration HTTP read', currentRead && wire(currentRead), expected.currentRead && wire(expected.currentRead));
      if (sample.rejectReplacement) assert.equal(actual.replacementFailed, true, 'The real replacement callback must enter its controlled failure.');
      report.comparisons.push({ sample, actual, expected });
    }
    assert.deepEqual(report.differences, [], stringifyNativeJson(report.differences.slice(0, 8)));
    report.componentAcceptance = true;
  } catch (error) { failed = true; failure = error; report.failure = errorObservation(error); report.failureRaw = inspect(error, { depth: null }); }
  finally {
    activeRequest = null;
    const cleanupErrors = [];
    try {
      application?.beginClose(); await application?.drainRequests();
      if (application?.server.listening) await new Promise((resolve, reject) => application.server.close(error => error ? reject(error) : resolve()));
      report.cleanup.nodeHostClosed = true;
    } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) report.componentAcceptance = false;
    report.cleanup.errors = cleanupErrors.map(error => errorObservation(error)); report.cleanup.unownedErrors = unownedErrors;
    report.cleanup.rawErrors = cleanupErrors.map(error => inspect(error, { depth: null }));
    await writeFile(path.join(output, 'comparison.json'), JSON.stringify(report, errorJson, 2) + '\n', { flag: 'wx' });
    if (cleanupErrors.length) throw new AggregateError(failed ? [failure, ...cleanupErrors] : cleanupErrors,
      'Server configuration HTTP and cleanup failed.', { cause: failed ? failure : cleanupErrors[0] });
  }
  if (failed) throw failure;
});
