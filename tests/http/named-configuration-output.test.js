import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createTestApplication } from '../helpers/application.js';
import { AuthenticationService } from '../../src/users/authentication-service.js';
import { NamedConfigurationStore } from '../../src/core/named-configuration-store.js';
import { defaultConfiguration, readConfigurationDocument } from '../../src/core/configuration-xml.js';
import { stringifyNativeJson } from '../../src/core/json.js';
import { currentNamedConfiguration, namedInput, namedWire, namedError, namedFailurePayload } from '../core/named-configuration-current.js';
import { configurationJson } from '../core/fixtures/configuration/observations.js';
import { validationOutputRoot, assertValidationOutputChild } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];

test('formal named routes retain non-finite XML values and return the current Native output failure', {
  skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 300000,
}, async t => {
  const captured = await currentNamedConfiguration();
  const sample = namedInput.http.find(row => row.name === 'encoding-float-special');
  const expected = captured.native.http.find(row => row.name === sample.name);
  const repeated = captured.repeat.http.find(row => row.name === sample.name);
  const root = await fs.mkdtemp(path.join(validationOutputRoot(), 'named-output-')); assertValidationOutputChild(root);
  const store = new NamedConfigurationStore({ configurationDirectoryPath: path.join(root, 'config') });
  const report = { scope: 'Formal configuration route/body/output with actual named XML persistence and cold read; authenticated admin gateway, no full runtime boot.',
    nativeCapture: captured.output, requests: [], diagnostics: [], unowned: [], cleanup: {}, phaseAcceptance: false, releaseAcceptance: false };
  const failures = [];
  let application, cold, active;
  try {
    const authentication = new AuthenticationService({ store: {}, users: {}, serverId: 'named-output', isLocalNetwork: () => true });
    authentication.authenticate = async () => ({ IsAuthenticated: true, IsApiKey: true, IsAdministrator: true });
    application = await createTestApplication({ configuration: { ...defaultConfiguration('server'), IsStartupWizardCompleted: true },
      authentication, namedConfiguration: store, onError: error => (active ? report.diagnostics : report.unowned)
        .push({ request: active, failure: namedError(error) }) });
    await new Promise((resolve, reject) => { application.server.once('error', reject); application.server.listen(0, '127.0.0.1', () => {
      application.server.off('error', reject); resolve();
    }); });
    const call = async (method, body) => {
      active = method;
      try {
        const response = await fetch('http://127.0.0.1:' + application.server.address().port + '/System/Configuration/encoding', {
          method, signal: t.signal, ...(body !== undefined && { headers: { 'Content-Type': 'application/json' }, body }),
        });
        const bytes = Buffer.from(await response.arrayBuffer()), text = bytes.toString();
        const observation = { method, requestBody: body, status: response.status, contentType: response.headers.get('content-type'),
          headers: Object.fromEntries(response.headers), text, bytes: bytes.toString('base64'), json: null, error: null };
        report.requests.push(observation); return observation;
      } finally { active = undefined; }
    };
    const response = await call(sample.method, sample.body);
    assert.deepEqual(namedWire(response, root), namedWire(expected.response, expected.root));
    assert.deepEqual(report.diagnostics, []);
    const filename = path.join(root, 'config', 'encoding.xml'), bytes = await fs.readFile(filename);
    report.xml = { bytes: bytes.toString('base64'), nonFinitePersisted: Number.isNaN(readConfigurationDocument(bytes, 'encoding').value.DownMixAudioBoost) };
    assert.equal(report.xml.nonFinitePersisted, true);
    let outputFailure;
    try { stringifyNativeJson(store.getCurrentConfiguration('encoding')); } catch (error) { outputFailure = error; }
    assert.ok(outputFailure, 'The actual retained value must fail JSON output.');
    report.outputFailure = namedError(outputFailure);
    const afterRead = await call('GET');
    assert.deepEqual(namedWire(repeated.afterRead, repeated.root), namedWire(expected.afterRead, expected.root));
    assert.deepEqual(namedWire(afterRead, root), namedWire(expected.afterRead, expected.root));
    for (const diagnostic of report.diagnostics) {
      assert.equal(diagnostic.request, 'GET');
      assert.deepEqual(namedFailurePayload(diagnostic.failure), namedFailurePayload(outputFailure));
    }
    cold = new NamedConfigurationStore({ configurationDirectoryPath: path.join(root, 'config') });
    report.coldNonFinite = Number.isNaN((await cold.getConfiguration('encoding')).DownMixAudioBoost);
    assert.equal(report.coldNonFinite, true); assert.deepEqual(report.unowned, []);
  } catch (error) { failures.push(error); }
  finally {
    for (const [name, close] of [['http', async () => {
      application?.beginClose(); await application?.drainRequests();
      if (application?.server.listening) await new Promise((resolve, reject) => application.server.close(error => error ? reject(error) : resolve()));
    }], ['store', () => store.close()], ['cold', () => cold?.close()]]) {
      try { await close(); report.cleanup[name] = true; } catch (error) { failures.push(error); }
    }
    if (report.unowned.length) failures.push(new Error('Unexpected named output background or close failures.', { cause: report.unowned }));
    report.failures = failures.map(namedError);
    await fs.writeFile(path.join(root, 'comparison.json'), configurationJson(report), { flag: 'wx' });
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Named output and cleanup failed.', { cause: failures[0] });
});
