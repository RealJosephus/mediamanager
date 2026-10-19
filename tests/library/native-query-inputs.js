import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const binding = JSON.parse(await readFile(new URL('./fixtures/native-query-inputs/binding.json', import.meta.url), 'utf8'));
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
export const nativeQueryReference = binding.reference;
export const nativeItemFilterRecordedOutputRoot = binding.recordedFilterOutputRoot;
export const nativeQueryExecutables = {
  dotnet: resolveNativeQueryInput(nativeQueryReference.preparationInputs[8][1]),
  jellyfinDll: resolveNativeQueryInput(nativeQueryReference.preparationInputs[9][1]),
  ffmpeg: resolveNativeQueryInput(nativeQueryReference.preparationInputs[10][1]),
};
export async function readNativeQueryServerId() {
  const filename = resolveNativeQueryInput(nativeQueryReference.preparationInputs[0][1]);
  const descriptor = binding.preparationInputFiles.find(entry => path.resolve(entry.filename) === filename);
  assert.ok(descriptor, 'The native bootstrap must be an explicitly hash-bound input.');
  const bytes = await readFile(filename);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.sha256);
  const ids = JSON.parse(bytes).observations.filter(entry => entry.route === '/Users/AuthenticateByName')
    .map(entry => entry.responseBody?.SessionInfo?.ServerId).filter(Boolean);
  assert.ok(ids.length > 0); assert.match(ids[0], /^[a-f0-9]{32}$/u);
  assert.ok(ids.every(value => value === ids[0]));
  return ids[0];
}
export async function verifyNativeQuerySourceBindings() {
  const source = nativeQueryReference.sourceDatabase;
  assert.equal(createHash('sha256').update(await readFile(source.filename)).digest('hex'), source.sha256);
  for (const descriptor of binding.independentNativeAudits) {
    const bytes = await readFile(descriptor.filename);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.sha256);
    assert.ok(['allRawArtifactsAndCurrentInputsVerified', 'passed'].includes(descriptor.acceptanceField));
    assert.equal(JSON.parse(bytes)[descriptor.acceptanceField], true);
  }
}
export function resolveNativeQueryInput(filename) {
  assert.ok(nativeQueryReference.preparationInputs.some(([, expected]) => expected === filename),
    'Native query inputs resolve only the exact independently audited source allowlist.');
  return path.resolve(repositoryRoot, filename);
}
