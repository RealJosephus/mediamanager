import assert from 'node:assert/strict';
import { tokenizeJson } from '../../src/core/json-tokens.js';

// Preserve every response byte outside the public request trace value.
export function normalizeDeletionRecording(record) {
  const copy = structuredClone(record);
  for (const result of copy.results) {
    if (!result.jsonBody || typeof result.jsonBody !== 'object' || !Object.hasOwn(result.jsonBody, 'traceId')) continue;
    const trace = result.jsonBody.traceId;
    assert.equal(typeof trace, 'string');
    assert.ok(trace.length > 0);
    assert.deepEqual(JSON.parse(result.body), result.jsonBody);
    const properties = tokenizeJson(result.body).properties.filter(([key]) => key === 'traceId');
    assert.equal(properties.length, 1);
    const [, value] = properties[0];
    assert.equal(value.value, trace);
    result.body = result.body.slice(0, value.start) + '"$TRACE"' + result.body.slice(value.end);
    result.jsonBody.traceId = '$TRACE';
  }
  return copy;
}
