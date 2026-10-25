import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseLosslessJson } from '../../src/core/json.js';
import { runVideoDiscoveryScenario } from './video-ignore-scenario.js';
import { projectDiscoveryOutcome } from './video-discovery-fixture.js';
import { projectStatePath } from './fixture-state-path.js';

const root = new URL('./fixtures/video-version-ignore/', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async name => parseLosslessJson(await readFile(new URL(name, root), 'utf8'))));
const platformProof = JSON.parse(await readFile(new URL('platform/provenance.json', root), 'utf8'));
const posix = await Promise.all(platformProof.recordings.map(async proof => {
  const bytes = await readFile(new URL('platform/' + proof.native.filename, root));
  const recordBytes = await readFile(new URL('platform/' + proof.record.filename, root));
  return { proof, bytes, recordBytes, native: parseLosslessJson(bytes.toString('utf8')), record: JSON.parse(recordBytes) };
}));
const project = value => typeof value === 'string' ? projectStatePath(value, '$STATE')
  : Array.isArray(value) ? value.map(project)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, project(child)])) : value;
test('video version discovery ignore recording seals actual rules/resolver/batch/delete and exact Int64', async () => {
  for (const file of provenance.fixtureFiles) {
    const source = file.path === 'tests/Directory.Build.props' ? new URL('../../../Directory.Build.props', root)
      : new URL(file.path.split('/').at(-1), root);
    assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'), file.sha256, file.path);
  }
  assert.equal(native.actualFrozenVideoVersionDiscovery, true);
  assert.equal(native.inputSha256, provenance.fixtureFiles[0].sha256);
  assert.equal(native.scope, provenance.scope); assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
  assert.deepEqual(native.results.map(result => result.exception != null), input.map(sample => Boolean(sample.expectException)));
  assert.equal(native.results.length, 26);
  const existing = native.results.find(result => result.name === 'update-existing-bypasses-exclusion');
  assert.equal(existing.rows.find(row => row.name === 'Old version').runTimeTicks, 9007199254740995n);
  assert.equal(platformProof.inputSha256, provenance.fixtureFiles[0].sha256);
  assert.deepEqual(platformProof.recordings.map(value => value.platform).sort(), ['darwin', 'linux']);
  for (const entry of posix) {
    assert.equal(createHash('sha256').update(entry.bytes).digest('hex'), entry.proof.native.sha256);
    assert.equal(createHash('sha256').update(entry.recordBytes).digest('hex'), entry.proof.record.sha256);
    assert.equal(entry.native.inputSha256, entry.proof.selectedInputSha256);
    assert.equal(entry.native.actualFrozenVideoVersionDiscovery, true);
    assert.equal(entry.record.passed, true); assert.equal(entry.record.build.status, 0); assert.equal(entry.record.process.status, 0);
    assert.equal(entry.record.sourceFilesSha256, entry.proof.sourceFilesSha256);
    assert.equal(entry.native.results.length, 1); assert.equal(entry.native.results[0].name, platformProof.case);
    const projectSource = entry.record.sourceFiles.find(file => file.filename.endsWith('/PlatformOracle.csproj'));
    assert.equal(createHash('sha256').update(await readFile(new URL('PlatformOracle.csproj', root))).digest('hex'), projectSource.sha256);
  }
  assert.deepEqual(project(posix[0].native.results), project(posix[1].native.results));
});

for (const dialect of ['postgres']) for (const sample of input) {
  test(`${dialect}: complete native ignore discovery ${sample.name}`, { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const recording = process.platform !== 'win32' && sample.name === platformProof.case
      ? project(posix.find(entry => entry.proof.platform === process.platform).native.results[0])
      : native.results.find(result => result.name === sample.name);
    const actual = await runVideoDiscoveryScenario(t, dialect, sample);
    assert.deepEqual(projectDiscoveryOutcome(actual), projectDiscoveryOutcome(recording));
  });
}
