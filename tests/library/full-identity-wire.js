import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertValidationOutputChild } from '../../tools/validation/paths.js';
import { assertCompleteFilterHttpResponses } from './full-filter-wire.js';
import { assertNativeIdentityOutput, nativeIdentityBinding } from './native-identity-inputs.js';

async function nativeServerId() {
  const descriptor = nativeIdentityBinding.preparationInputFiles[0];
  const bytes = await readFile(descriptor.filename);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.sha256);
  const ids = JSON.parse(bytes).observations.filter(entry => entry.route === '/Users/AuthenticateByName')
    .map(entry => entry.responseBody?.SessionInfo?.ServerId).filter(Boolean);
  assert.ok(ids.length > 0);
  assert.match(ids[0], /^[a-f0-9]{32}$/u);
  assert.ok(ids.every(id => id === ids[0]));
  return ids[0];
}

export async function assertCompleteIdentityHttpResponses(actual, native, { scenarioName }) {
  const records = [];
  let position = 0;
  for (const candidate of actual.cases) {
    for (const [index, endpoint] of candidate.endpoints.entries()) {
      const record = native.records[position++];
      assert.ok(record, 'Each identity response must have a native record.');
      assert.equal(record.name, candidate.name === 'parallel' ? `parallel-${index + 1}` : candidate.name);
      assert.equal(endpoint.endpoint, 'items');
      assert.equal(new URL(record.route, native.origin).pathname, '/Items');
      records.push({ ...record, name: candidate.name, endpoint: 'items' });
    }
  }
  assert.equal(position, native.records.length);
  return assertCompleteFilterHttpResponses(actual, { ...native, records }, {
    scenarioName, nativeServerId: await nativeServerId(),
  });
}

export async function writeCompleteIdentityHttpEvidence(actual, native, options) {
  const comparison = await assertCompleteIdentityHttpResponses(actual, native, options);
  if (!process.env.MEDIAMANAGER_IDENTITY_WIRE_EVIDENCE) return comparison;
  assert.match(options.scenarioName, /^[a-z0-9-]+$/u);
  const root = assertNativeIdentityOutput(assertValidationOutputChild(path.resolve(process.env.MEDIAMANAGER_IDENTITY_WIRE_EVIDENCE)));
  const output = assertNativeIdentityOutput(assertValidationOutputChild(path.join(root, options.scenarioName)));
  await mkdir(root, { recursive: true });
  assertValidationOutputChild(output);
  await mkdir(output);
  const json = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n';
  await writeFile(path.join(output, 'postgres.json'), json(actual), { flag: 'wx' });
  await writeFile(path.join(output, 'native-http.json'), json(native), { flag: 'wx' });
  await writeFile(path.join(output, 'comparison.json'), json({ ...comparison, ...options,
    completeHttpContractEqual: true, releaseAcceptance: false }), { flag: 'wx' });
  return comparison;
}
