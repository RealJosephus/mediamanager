import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createTestApplication } from '../helpers/application.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { AuthenticationService } from '../../src/users/authentication-service.js';

async function fixture(configurationStore) {
  const configurationSource = configurationStore ?? {};
  configurationSource.configuration = { ...defaultConfiguration('server'), IsStartupWizardCompleted: true };
  const authentication = new AuthenticationService({ store: {}, users: {}, serverId: 'configuration-http', isLocalNetwork: () => true });
  authentication.authenticate = async () => ({ IsAuthenticated: true, IsApiKey: true, IsAdministrator: true });
  const errors = [];
  const application = await createTestApplication({ get configuration() { return configurationSource.configuration; },
    configurationStore, authentication, onError: error => errors.push(error) });
  await new Promise((resolve, reject) => { application.server.once('error', reject); application.server.listen(0, '127.0.0.1', () => {
    application.server.off('error', reject); resolve();
  }); });
  const call = async (route, body) => {
    const response = await fetch('http://127.0.0.1:' + application.server.address().port + route, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    const text = await response.text();
    return { status: response.status, contentType: response.headers.get('content-type'), text,
      body: text && response.headers.get('content-type')?.includes('json') ? parseLosslessJson(text) : text };
  };
  return { get configuration() { return configurationSource.configuration; }, errors, call, async close() {
    application.beginClose(); await application.drainRequests();
    await new Promise((resolve, reject) => application.server.close(error => error ? reject(error) : resolve()));
  } };
}

test('server configuration HTTP awaits replacement and preserves its actual failure before responding', async () => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const cause = Object.assign(new Error('Controlled configuration write refused.'), { code: 'EACCES' });
  const cleanup = Object.assign(new Error('Controlled configuration cleanup failed.'), { code: 'controlled-cleanup' });
  const failure = Object.assign(new AggregateError([cause, cleanup], 'Controlled configuration replacement failed.', { cause }),
    { code: 'controlled-configuration-write', status: 500 });
  let reject = false, incoming, pending, settled = false;
  const value = await fixture({ async replaceConfiguration(configuration) {
    if (reject) throw failure;
    entered.resolve(); await finish.promise; incoming = configuration; this.configuration = configuration;
  } });
  const previous = value.configuration;
  try {
    pending = value.call('/System/Configuration', '{"ServerName":"Saved server","PreviousVersionStr":"1.2.3","PreviousVersion":"4.5","SlowResponseThresholdMs":"9223372036854775807"}');
    pending.then(() => { settled = true; }, () => { settled = true; });
    await Promise.race([entered.promise, pending.then(response => {
      throw new Error('Configuration replacement was not entered: ' + JSON.stringify(response));
    })]);
    await setImmediate();
    assert.equal(settled, false, 'The HTTP response waits for the real replacement operation.');
    finish.resolve();
    assert.deepEqual(await pending, { status: 204, contentType: null, text: '', body: '' });
    const read = await value.call('/System/Configuration');
    assert.equal(read.status, 200); assert.equal(read.body.ServerName, 'Saved server');
    assert.equal(read.body.PreviousVersion, '4.5'); assert.equal(read.body.PreviousVersionStr, '4.5');
    assert.equal(read.body.SlowResponseThresholdMs, 9223372036854775807n);
    assert.equal(Object.hasOwn(read.body, 'NetworkConfiguration'), false);
    assert.equal(Object.hasOwn(read.body, 'BaseUrl'), false);
    previous.ServerName = 'Detached initial server'; incoming.ServerName = 'Late incoming server';
    const retainedRead = await value.call('/System/Configuration');
    assert.equal(retainedRead.status, 200); assert.equal(retainedRead.body.ServerName, 'Late incoming server');
    assert.equal(retainedRead.body.PreviousVersion, '4.5'); assert.equal(retainedRead.body.PreviousVersionStr, '4.5');
    assert.deepEqual(value.errors, []);
    reject = true;
    const rejected = await value.call('/System/Configuration', '{}');
    assert.equal(rejected.status, 500); assert.equal(rejected.contentType, 'text/plain');
    assert.equal(rejected.text, 'Error processing request.');
    assert.equal(value.errors.length, 1);
    assert.equal(value.errors[0].message, failure.message); assert.equal(value.errors[0].code, failure.code);
    assert.equal(value.errors[0].cause.code, 'EACCES');
    assert.deepEqual(value.errors[0].errors.map(error => error.code), ['EACCES', 'controlled-cleanup']);
    assert.deepEqual((await value.call('/System/Configuration')).body, retainedRead.body);
  } finally {
    finish.resolve(); await pending?.catch(() => {}); await value.close();
  }
  assert.equal(value.errors.length, 1, 'Normal close cannot add a failure to a completed request.');
});

test('server configuration POST requires persistence while GET retains its complete public shape', async () => {
  const value = await fixture();
  try {
    const original = await value.call('/System/Configuration'); assert.equal(original.status, 200);
    const response = await value.call('/System/Configuration', '{}');
    assert.equal(response.status, 503); assert.equal(response.text, 'Error processing request.');
    assert.equal(response.contentType, 'text/plain');
    assert.deepEqual((await value.call('/System/Configuration')).body, original.body);
    assert.equal(value.errors.length, 1); assert.equal(value.errors[0].status, 503);
  } finally { await value.close(); }
  assert.equal(value.errors.length, 1);
});
