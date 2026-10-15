import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { parseLosslessJson } from '../src/core/json.js';

// Project only public JSON bodies. Preserve text/error bodies and the complete
// response envelope; fixture recordings and persisted Data are never rewritten.
export function publicJsonBody({ body, contentType, ...response }) {
  return { ...response, contentType, body: contentType?.split(';')[0].trim().toLowerCase() === 'application/json'
    ? parseLosslessJson(body) : body };
}

// Keep both observations in TAP even when release comparison deliberately
// ignores a diagnostic representation. Never manufacture candidate values.
export function observeComparison(t, label, candidate, reference) {
  t.diagnostic('comparison ' + JSON.stringify({ label, reference, candidate,
    diagnosticEqual: isDeepStrictEqual(candidate, reference) }, (_, value) =>
    typeof value === 'bigint' ? { int64: value.toString() } : value));
}

export function assertProjectedEqual(t, label, candidate, reference, project = value => value) {
  observeComparison(t, label, candidate, reference);
  assert.deepEqual(project(candidate), project(reference), label);
}
