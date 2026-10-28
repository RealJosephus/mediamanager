import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AuthenticationService } from '../../src/users/authentication-service.js';
import { domainError } from '../../src/users/native.js';
import { NetworkService } from '../../src/network/network-service.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { SystemLifecycle } from '../../src/system/lifecycle.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createTestApplication } from '../helpers/application.js';
import { errorObservation } from '../helpers/error-observation.js';
import { makeInput, userId } from './fixtures/system-lifecycle-current/input.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE;
const hash = value => createHash('sha256').update(value).digest('hex');
const outcome = promise => promise.then(value => ({ failed: false, value }), reason => ({ failed: true, reason }));
const wire = row => ({ status: row.status, contentType: row.contentType ?? null, body: row.body, allow: row.allow ?? null });

test('System restart and shutdown match actual Native MVC authorization and drain real Node HTTP owners', { skip: !enabled, timeout: 300000 }, async t => {
  const output = path.join(validationOutputRoot(), 'system-lifecycle-native-' + randomUUID()); await mkdir(output, { recursive: true });
  const input = makeInput(), bytes = Buffer.from(JSON.stringify(input, null, 2) + '\n'), inputFile = path.join(output, 'input.json');
  await writeFile(inputFile, bytes, { flag: 'wx' });
  const report = { schemaVersion: 1, phaseAcceptance: false, releaseAcceptance: false,
    scope: 'Actual Native MVC/SystemManager/authorization/host stop, compared with formal Node routing, real network classification and actual HTTP owner close/reopen. Production CLI/PG/Local restart is independently tested.',
    observations: [] };
  let current, primary, failed = false;
  try {
    current = await currentNativeReference(); report.preparation = current.preparation;
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/SystemController.cs',
      'Emby.Server.Implementations/SystemManager.cs', 'Jellyfin.Server/Program.cs',
      'Jellyfin.Server/Extensions/ApiServiceCollectionExtensions.cs',
      'Jellyfin.Api/Auth/LocalAccessOrRequiresElevationPolicy/LocalAccessOrRequiresElevationHandler.cs',
      'Jellyfin.Api/Middleware/ExceptionMiddleware.cs']);
    const receipt = await recordOracle({ project: 'tests/http/fixtures/system-lifecycle-current/Oracle.csproj', output: path.join(output, 'native'),
      args: [inputFile, '{output}/native.json'] });
    assert.equal(receipt.passed, true);
    const nativeBytes = await readFile(path.join(output, 'native/native.json')), native = JSON.parse(nativeBytes);
    assert.equal(native.inputSha256, hash(bytes));
    assert.equal(receipt.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, hash(nativeBytes));
    for (const name of ['actualMvc', 'actualSystemController', 'actualSystemManager', 'actualAuthorizationPolicies', 'actualHostLifetime']) assert.equal(native[name], true);
    for (const assembly of native.assemblies) assert.equal(hash(await readFile(assembly.filename)), assembly.sha256);
    assert.equal(native.observations.length, input.requests.length);
    for (const [index, sample] of input.requests.entries()) await t.test(sample.name, async () => {
      const expected = native.observations[index]; assert.equal(expected.name, sample.name); assert.equal(expected.status, sample.expectedStatus);
      const configuration = { ...defaultConfiguration('network'), InternalHttpPort: 0, LocalNetworkAddresses: ['127.0.0.1'],
        LocalNetworkSubnets: input.localNetworks, KnownProxies: ['127.0.0.1'], EnableRemoteAccess: true, AutoDiscovery: false };
      const network = new NetworkService({ getNetworkConfiguration: () => configuration,
        getInterfaces: () => [{ name: 'declared-loopback', address: '127.0.0.1', prefixLength: 8, index: 1 }] });
      await network.initialize();
      const authentication = new AuthenticationService({ store: {}, users: {}, serverId: 'system-lifecycle',
        isLocalNetwork: address => network.isInLocalNetwork(address) });
      authentication.authenticate = async request => {
        const identity = request.headers['x-identity'];
        if (identity === 'invalid') throw domainError(401, 'Invalid token.');
        return { IsAuthenticated: identity !== 'anonymous', IsAdministrator: ['admin', 'apiKey'].includes(identity), IsApiKey: identity === 'apiKey',
          UserId: userId, User: identity === 'anonymous' ? null : { Id: userId,
            Policy: { IsAdministrator: identity === 'admin', EnableRemoteAccess: false }, Configuration: {} } };
      };
      const ready = Promise.withResolvers(), reopened = Promise.withResolvers();
      let original, replacement;
      const lifecycle = new SystemLifecycle({ start: async ({ systemLifecycle, onApplication }) => {
        const application = await createTestApplication({ configuration: { ...defaultConfiguration('server'), IsStartupWizardCompleted: true },
          authentication, network, getNetworkConfiguration: () => configuration, systemLifecycle });
        let closing;
        const close = () => closing ??= (async () => {
          application.beginClose(); await application.drainRequests(); await application.webSockets?.close();
          if (application.server.listening) await new Promise((resolve, reject) => application.server.close(error => error ? reject(error) : resolve()));
        })();
        onApplication({ close });
        await new Promise((resolve, reject) => {
          application.server.once('error', reject); application.server.listen(0, '127.0.0.1', () => { application.server.off('error', reject); resolve(); });
        });
        return { ...application, close };
      }, onReady(application) {
        if (!original) { original = application; ready.resolve(application); }
        else { replacement = application; reopened.resolve(application); }
      } });
      const running = outcome(lifecycle.run());
      const wait = promise => Promise.race([promise, running.then(result => { throw new Error('The actual HTTP lifecycle ended before the expected listener.', { cause: result.reason }); })]);
      const record = { sample, native: expected }; report.observations.push(record);
      try {
        const application = await wait(ready.promise), origin = 'http://127.0.0.1:' + application.server.address().port;
        const response = await fetch(origin + sample.path, { method: sample.method,
          headers: { Accept: 'application/json', 'X-Identity': sample.identity, 'X-Forwarded-For': sample.remote,
            ...(sample.contentType && { 'Content-Type': sample.contentType }) },
          ...(sample.body !== undefined && { body: sample.body }), signal: AbortSignal.any([t.signal, AbortSignal.timeout(15000)]) });
        record.actual = { status: response.status, body: await response.text(), contentType: response.headers.get('content-type'), allow: response.headers.get('allow') };
        assert.deepEqual(wire(record.actual), wire(expected));
        assert.equal(expected.hostStopped, true); assert.equal(expected.hostDisposed, true);
        if (response.status === 204) {
          assert.equal(expected.actualStop, true); assert.equal(expected.normalOwnerStopped, true);
          assert.equal(expected.requestedRestart, sample.path.endsWith('Restart'));
          if (sample.path.endsWith('Restart')) {
            await wait(reopened.promise);
            assert.equal(original.server.listening, false); assert.equal(replacement.server.listening, true);
            const ping = await fetch('http://127.0.0.1:' + replacement.server.address().port + '/System/Ping', { signal: t.signal });
            assert.equal(ping.status, 200); await ping.body?.cancel(); record.actualRestartedListener = true;
          } else {
            assert.equal((await running).failed, false); assert.equal(original.server.listening, false); record.actualShutdown = true;
          }
        } else {
          assert.equal(original.server.listening, true);
          const ping = await fetch(origin + '/System/Ping', { signal: t.signal }); assert.equal(ping.status, 200); await ping.body?.cancel();
          record.deniedRequestRetainsListener = true;
        }
      } finally {
        await lifecycle.close(); const result = await running;
        await network.close(); assert.equal(result.failed, false, result.failed ? String(result.reason) : '');
      }
    });
  } catch (error) { primary = error; failed = true; report.failure = errorObservation(error); }
  finally {
    const failures = [];
    try {
      if (current) { await current.finish(); report.immutableInputsVerified = true; }
    } catch (error) { failures.push(error); report.inputVerificationFailure = errorObservation(error); }
    try { await writeFile(path.join(output, 'comparison.json'), JSON.stringify(report, null, 2) + '\n'); }
    catch (error) { failures.push(error); }
    if (failures.length) {
      const reasons = [...(failed ? [primary] : []), ...failures];
      if (reasons.length === 1) throw reasons[0];
      throw new AggregateError(reasons, 'System HTTP comparison and immutable input verification failed.', { cause: reasons[0] });
    }
  }
  if (failed) throw primary;
});
