import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { BinaryResult } from '../../src/http/binary-result.js';
import { createTestApplication } from '../helpers/application.js';

const payload = Buffer.from('Recovered response bytes.\n');
const route = '/Items/f9b10000000000000000000000000001/File';
function failurePayload(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(failurePayload);
  const keys = value instanceof Error ? Object.getOwnPropertyNames(value).filter(key => !['name', 'stack'].includes(key)) : Object.keys(value);
  return Object.fromEntries(keys.map(key => [key, failurePayload(value[key])]));
}

async function fixture(t) {
  let selected;
  const diagnostics = [], authentication = {
    read: () => ({ Client: 'Jellyfin' }),
    async authenticate() {
      if (selected?.phase === 'authentication') throw selected.reason;
      return { IsAuthenticated: true, IsApiKey: true, IsAdministrator: true };
    },
    authorize() { if (selected?.phase === 'authorization') throw selected.reason; },
  };
  const application = await createTestApplication({
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, authentication,
    playback: { async file() {
      if (selected?.phase === 'action') throw selected.reason;
      if (selected?.phase === 'response-stream') return new BinaryResult(async (_request, response) => {
        response.setHeader('Content-Type', 'application/octet-stream');
        response.end(payload);
        throw selected.reason;
      });
      return BinaryResult.bytes(payload, 'application/octet-stream');
    } },
    runWithContext: operation => {
      if (selected?.phase === 'context') return Promise.reject(selected.reason);
      return operation();
    },
    onError: (error, { request, phase }) => diagnostics.push({ url: request.url, phase, error: failurePayload(error) }),
  });
  t.after(async () => {
    application.beginClose();
    application.server.closeAllConnections();
    await application.drainRequests();
    if (application.server.listening) await new Promise((resolve, reject) => application.server.close(error => error ? reject(error) : resolve()));
  });
  application.server.listen(0, '127.0.0.1');
  await once(application.server, 'listening', { signal: t.signal });
  const origin = `http://127.0.0.1:${application.server.address().port}`;
  let ordinal = 0;
  return { diagnostics, async request(fault) {
    selected = fault;
    const url = route + '?case=' + ordinal++;
    const response = await fetch(origin + url, { signal: AbortSignal.any([t.signal, AbortSignal.timeout(10000)]) });
    const bytes = Buffer.from(await response.arrayBuffer());
    await application.drainRequests();
    return { url, status: response.status, headers: Object.fromEntries(response.headers), bytes };
  } };
}

test('HTTP failures preserve primitive and structured reasons through authentication, authorization and actions', { timeout: 30000 }, async t => {
  const owned = await fixture(t);
  const reasons = [false, 0, '', null, undefined,
    Object.assign(new Error('The actual dependency rejected the request.', { cause: null }), { code: 'dependency-failed', status: 503 }),
    { message: 'The plugin refused the request.', name: 'Business value', stack: 'Business value', statusCode: 409, errors: [false, null] }];
  for (const phase of ['authentication', 'authorization', 'action', 'context']) {
    for (const reason of reasons) {
      const result = await owned.request({ phase, reason });
      assert.equal(result.status, phase === 'context' ? 500 : reason?.status ?? reason?.statusCode ?? 500);
      assert.equal(result.bytes.toString(), 'Error processing request.');
      if (phase !== 'context') {
        assert.match(result.headers['content-type'], /^text\/plain(?:;|$)/u);
        assert.equal(result.headers['content-language'], 'en-US');
      }
      const observed = owned.diagnostics.find(value => value.url === result.url && value.phase === (phase === 'context' ? 'admission' : phase));
      assert.ok(observed, 'The original request failure must remain observable.');
      assert.deepEqual(observed.error, failurePayload(reason));
      const recovered = await owned.request();
      assert.equal(recovered.status, 200);
      assert.deepEqual(recovered.bytes, payload);
    }
  }
  t.diagnostic(JSON.stringify({ failures: owned.diagnostics }));
});

test('a rejected response cleanup preserves completed bytes and its actual failure reason', { timeout: 30000 }, async t => {
  const owned = await fixture(t);
  for (const reason of [false, 0, '', null, undefined]) {
    const result = await owned.request({ phase: 'response-stream', reason });
    assert.equal(result.status, 200);
    assert.deepEqual(result.bytes, payload);
    const observed = owned.diagnostics.find(value => value.url === result.url && value.phase === 'response-stream');
    assert.ok(observed, 'The completed response cleanup failure must remain observable.');
    assert.deepEqual(observed.error, reason);
    const recovered = await owned.request();
    assert.equal(recovered.status, 200);
    assert.deepEqual(recovered.bytes, payload);
  }
  t.diagnostic(JSON.stringify({ failures: owned.diagnostics }));
});
