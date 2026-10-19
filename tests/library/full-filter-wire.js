import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertValidationOutputChild } from '../../tools/validation/paths.js';

function normalizeBody(value, serverId) {
  if (Array.isArray(value)) return value.map(entry => normalizeBody(entry, serverId));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (key === 'ServerId') { assert.equal(entry, serverId, 'The isolated server identity must be individually bound.'); return [key, '$isolated-server']; }
    assert.notEqual(key, 'traceId', 'Successful/nested DTO fields must not be discarded.');
    return [key, normalizeBody(entry, serverId)];
  }));
  return value;
}
function fullContract(response, bodyField, serverId, traces) {
  const body = response[bodyField];
  const result = { status: response.status, contentType: response.contentType };
  if (response.bodyText === '') {
    if (body !== undefined) assert.equal(body, null);
    result.bodyText = '';
    return result;
  }
  if (!response.contentType?.includes('json')) {
    if (body !== undefined) assert.equal(body, null);
    result.bodyText = response.bodyText;
    return result;
  }
  if (body !== undefined) assert.deepEqual(JSON.parse(response.bodyText), body);
  if (response.status >= 400 && body && typeof body === 'object' && !Array.isArray(body) && Object.hasOwn(body, 'traceId')) {
    assert.match(body.traceId, /^00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$/u);
    assert.equal(traces.has(body.traceId), false, 'Every problem trace must be independently valid and unique.');
    traces.add(body.traceId);
    const { traceId, ...retained } = body;
    result.body = normalizeBody(retained, serverId);
  } else if (body !== undefined) result.body = normalizeBody(body, serverId);
  else result.bodyText = response.bodyText;
  return result;
}

export function assertCompleteFilterHttpResponses(actual, nativeHttp, { scenarioName, nativeServerId }) {
  const candidateServerId = scenarioName.replace(/[^a-z0-9]+/giu, '_').replace(/^_+|_+$/gu, '').toLowerCase().slice(0, 23) + '-postgres';
  const endpoints = actual.cases.flatMap(entry => entry.endpoints.map(endpoint => ({ name: entry.name, ...endpoint })));
  assert.equal(endpoints.length, nativeHttp.records.length);
  const candidateTraces = new Set(), nativeTraces = new Set();
  for (const [index, endpoint] of endpoints.entries()) {
    const reference = nativeHttp.records[index];
    assert.deepEqual([endpoint.name, endpoint.endpoint], [reference.name, reference.endpoint]);
    assert.ok(endpoint.response, 'Complete candidate response capture is required.');
    assert.deepEqual(fullContract(endpoint.response, 'body', candidateServerId, candidateTraces),
      fullContract(reference.response, 'bodyJson', nativeServerId, nativeTraces), endpoint.name + ':' + endpoint.endpoint);
  }
  return { responses: endpoints.length, candidateTracesValidated: candidateTraces.size, nativeTracesValidated: nativeTraces.size };
}

export async function writeCompleteFilterHttpEvidence(actual, nativeHttp, options) {
  if (!process.env.MEDIAMANAGER_FILTER_WIRE_EVIDENCE) return;
  assert.match(options.scenarioName, /^[a-z0-9-]+$/u);
  const comparison = assertCompleteFilterHttpResponses(actual, nativeHttp, options);
  const root = assertValidationOutputChild(path.resolve(process.env.MEDIAMANAGER_FILTER_WIRE_EVIDENCE));
  const output = assertValidationOutputChild(path.join(root, options.scenarioName));
  await mkdir(root, { recursive: true });
  assertValidationOutputChild(output);
  await mkdir(output, { recursive: false });
  const json = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n';
  await writeFile(path.join(output, 'postgres.json'), json(actual), { flag: 'wx' });
  await writeFile(path.join(output, 'comparison.json'), json({ ...comparison, ...options,
    completeHttpContractEqual: true, releaseAcceptance: false }), { flag: 'wx' });
}
