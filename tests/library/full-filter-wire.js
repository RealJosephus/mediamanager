import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertValidationOutputChild } from '../../tools/validation/paths.js';
import { projectItemBody } from '../helpers/http-body-projection.js';

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
  if (body !== undefined) {
    result.body = projectItemBody(body, { status: response.status, serverId, date: value => value });
    if (result.body !== body && result.body?.traceId === '$trace' && typeof body?.traceId === 'string') traces.add(body.traceId);
  } else result.bodyText = response.bodyText;
  return result;
}

export function assertCompleteFilterHttpResponses(actual, nativeHttp, { nativeServerId }) {
  const candidateServerId = actual.serverId;
  assert.equal(typeof candidateServerId, 'string'); assert.ok(candidateServerId.length > 0);
  assert.equal(typeof nativeServerId, 'string'); assert.ok(nativeServerId.length > 0);
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

export function assertCompleteNativeFilterHttpRepeat(left, right, { leftServerId, rightServerId }) {
  assert.equal(typeof leftServerId, 'string'); assert.ok(leftServerId.length > 0);
  assert.equal(typeof rightServerId, 'string'); assert.ok(rightServerId.length > 0);
  assert.equal(left.records.length, right.records.length);
  const leftTraces = new Set(), rightTraces = new Set();
  for (const [index, record] of left.records.entries()) {
    const repeated = right.records[index];
    assert.deepEqual({ name: record.name, endpoint: record.endpoint, query: record.query,
      scope: record.scope, route: record.route, expectedStatus: record.expectedStatus },
    { name: repeated.name, endpoint: repeated.endpoint, query: repeated.query,
      scope: repeated.scope, route: repeated.route, expectedStatus: repeated.expectedStatus });
    assert.deepEqual(fullContract(record.response, 'bodyJson', leftServerId, leftTraces),
      fullContract(repeated.response, 'bodyJson', rightServerId, rightTraces), record.name + ':' + record.endpoint);
  }
  return { responses: left.records.length, leftTracesValidated: leftTraces.size, rightTracesValidated: rightTraces.size };
}
