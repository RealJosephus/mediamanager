import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { analyzeJavaScriptDependencies, dependencyVariables } from '../../tools/validation/inventory.js';
import { repositoryRoot } from '../../tools/validation/paths.js';

// Inspect checked-in declarations without importing or executing their consumers.
const repositoryText = filename => readFile(path.join(repositoryRoot, filename), 'utf8');

test('native configuration consumers declare the Jellyfin assembly service before oracle execution', async () => {
  for (const filename of ['tests/core/configuration-file.test.js', 'tests/core/configuration-runtime.test.js']) {
    const analysis = analyzeJavaScriptDependencies(await repositoryText(filename));
    const services = Object.entries(dependencyVariables)
      .filter(([, variable]) => analysis.environmentVariables.includes(variable)).map(([service]) => service);
    assert.ok(services.includes('jellyfinDll'), filename + ' must expose its real oracle assembly dependency to preflight');
    assert.ok(analysis.testRegistrations > 0, filename + ' remains an executable test consumer');
  }
});

test('server identity required inputs bind every consumed historical hash without inventing execution pins', async () => {
  const directory = 'tests/core/fixtures/server-identity/';
  const proof = JSON.parse(await repositoryText(directory + 'provenance.json'));
  const manifest = JSON.parse(await repositoryText(directory + 'required-inputs.json'));
  const expected = [
    { filename: proof.rawRecording, sha256: proof.nativeSha256 },
    ...proof.sources.flatMap(row => ['D:/jellyfin', proof.buildSource]
      .map(root => ({ filename: path.win32.join(root, row.filename), sha256: row.sha256 }))),
    ...proof.oracleSources, ...proof.assemblies, proof.oracleAssembly, proof.dotnet,
    { filename: proof.repeat.filename, sha256: proof.repeat.sha256 },
    { filename: proof.repeat.comparison, sha256: proof.repeat.comparisonSha256 },
  ];
  const identity = row => path.win32.normalize(row.filename).toLowerCase() + '\0' + row.sha256;
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(manifest.inputs.every(row => row.required === true && /^[a-f0-9]{64}$/u.test(row.sha256)));
  assert.deepEqual([...new Set(manifest.inputs.map(identity))].sort(), [...new Set(expected.map(identity))].sort());
});
