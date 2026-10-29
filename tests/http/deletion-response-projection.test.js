import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDeletionRecording } from './deletion-response-projection.js';

test('deletion comparison accepts opaque request traces while preserving other response bytes and the original observation', () => {
  for (const trace of ['node-request-7', '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-00', 'request"\\\n台灣']) {
    const jsonBody = { status: 404, title: 'Not Found', traceId: trace, detail: trace };
    const body = '{ "status":404,"title":"Not Found", "traceId":' + JSON.stringify(trace) + ',"detail":' + JSON.stringify(trace) + ' }';
    const record = { results: [{ status: 404, contentType: 'application/json', body, jsonBody,
      committed: ['kept'], remaining: ['untouched'] }] };
    const projected = normalizeDeletionRecording(record);
    assert.equal(projected.results[0].body, '{ "status":404,"title":"Not Found", "traceId":"$TRACE","detail":' + JSON.stringify(trace) + ' }');
    assert.deepEqual(projected.results[0].jsonBody, { ...jsonBody, traceId: '$TRACE' });
    assert.deepEqual(projected.results[0].committed, ['kept']); assert.deepEqual(projected.results[0].remaining, ['untouched']);
    assert.equal(record.results[0].body, body); assert.equal(record.results[0].jsonBody.traceId, trace);
  }
});

test('deletion comparison rejects invalid trace values and mismatched body observations', () => {
  for (const traceId of ['', null, 0]) {
    const jsonBody = { traceId };
    assert.throws(() => normalizeDeletionRecording({ results: [{ body: JSON.stringify(jsonBody), jsonBody }] }));
  }
  assert.throws(() => normalizeDeletionRecording({ results: [{ body: '{"traceId":"body"}', jsonBody: { traceId: 'other' } }] }));
  assert.throws(() => normalizeDeletionRecording({ results: [{ body: '{"traceId":"same","traceId":"same"}', jsonBody: { traceId: 'same' } }] }));
});
