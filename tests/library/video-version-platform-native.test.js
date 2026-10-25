import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLosslessJson } from '../../src/core/json.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { projectStatePath } from './fixture-state-path.js';
import { runVideoDiscoveryScenario } from './video-ignore-scenario.js';
import { projectDiscoveryOutcome } from './video-discovery-fixture.js';

const sourceInput = new URL('./fixtures/video-version-ignore/input.json', import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? JSON.rawJSON(String(entry)) : entry, 2) + '\n';
const project = value => typeof value === 'string' ? projectStatePath(value, '$STATE')
  : Array.isArray(value) ? value.map(project)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, project(child)])) : value;

test('postgres: native mixed-separator version persistence follows the actual host filesystem', async t => {
  const inputBytes = await readFile(sourceInput), inputs = parseLosslessJson(inputBytes.toString('utf8'));
  const sample = inputs.find(sample => sample.name === 'update-nested-nearest'); assert.ok(sample);
  const root = path.join(validationOutputRoot(), 'video-version-platform-' + randomUUID()); await mkdir(root, { recursive: true });
  const selectedBytes = Buffer.from(json([sample])), selected = path.join(root, 'input.json'); await writeFile(selected, selectedBytes);
  const output = path.join(root, 'oracle');
  const execution = await recordOracle({ project: 'tests/library/fixtures/video-version-ignore/PlatformOracle.csproj', output,
    args: [selected, '{output}/native.json', '{output}/state'] });
  const nativeBytes = await readFile(path.join(output, 'native.json')), native = parseLosslessJson(nativeBytes.toString('utf8'));
  assert.equal(native.inputSha256, sha256(selectedBytes)); assert.equal(native.results.length, 1);
  const observed = project(native.results[0]), actual = await runVideoDiscoveryScenario(t, 'postgres', sample);
  await writeFile(path.join(root, 'comparison.json'), json({ schemaVersion: 1, platform: process.platform,
    originalInput: { filename: fileURLToPath(sourceInput), sha256: sha256(inputBytes) }, selectedInputSha256: sha256(selectedBytes),
    nativeSha256: sha256(nativeBytes), native: observed, actual, execution, phaseAcceptance: false }));
  assert.deepEqual(projectDiscoveryOutcome(actual), projectDiscoveryOutcome(observed));
});
