import assert from 'node:assert/strict';

// Request tracing is the only dynamic HTTP value. Retain exact response bytes
// and all state/action observations except this verified W3C identifier.
export function normalizeDeletionRecording(record) {
  const copy = structuredClone(record);
  for (const result of copy.results) {
    if (!result.jsonBody || typeof result.jsonBody !== 'object' || !Object.hasOwn(result.jsonBody, 'traceId')) continue;
    const trace = result.jsonBody.traceId;
    assert.match(trace, /^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
    assert.equal(result.body.split(trace).length, 2);
    result.body = result.body.replace(trace, '$TRACE');
    result.jsonBody.traceId = '$TRACE';
  }
  return copy;
}
