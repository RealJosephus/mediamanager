import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseLosslessJson } from '../../src/core/json.js';
import { parseConfigurationXml } from './fixtures/configuration/codecs.js';
import { model } from './fixtures/configuration/codecs.js';
import { configurationValue, configurationObservation } from './fixtures/configuration/observations.js';
import { recordedInputPath } from '../../tools/validation/paths.js';

void JSON.parse(await fs.readFile(new URL('./fixtures/configuration/required-inputs.json', import.meta.url)));
const fixture = new URL('./fixtures/configuration/', import.meta.url);
const [inputBytes, nativeBytes, proofBytes] = await Promise.all(['input.json', 'native.json', 'provenance.json'].map(name => fs.readFile(new URL(name, fixture))));
const input = JSON.parse(inputBytes), native = parseLosslessJson(nativeBytes.toString('utf8')), proof = JSON.parse(proofBytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('configuration evidence binds real XML, helper, plugin loaders, files, full types and independent repeat', async () => {
  assert.equal(hash(inputBytes), proof.inputSha256); assert.equal(hash(nativeBytes), proof.nativeSha256);
  assert.equal(hash(await fs.readFile(recordedInputPath(proof.rawRecording, [proof.nativeSha256]))), proof.nativeSha256); assert.equal(native.inputSha256, proof.inputSha256);
  for (const name of ['actualXmlSerializer', 'actualConfigurationHelper', 'actualPluginConfiguration', 'actualFiles']) assert.equal(native[name], true);
  assert.equal(proof.build.status, 0); assert.equal(proof.process.status, 0); assert.equal(proof.sourcesStable, true);
  assert.equal(proof.completeBuildInputClosure, false); assert.equal(proof.phaseAcceptance, false);
  for (const row of proof.sources) for (const root of ['D:/jellyfin', proof.buildSource]) assert.equal(hash(await fs.readFile(recordedInputPath(path.join(root, row.filename), [row.sha256]))), row.sha256, row.filename);
  for (const row of [...proof.oracleSources, ...proof.assemblies, proof.oracleAssembly, proof.dotnet]) assert.equal(hash(await fs.readFile(recordedInputPath(row.filename, [row.sha256]))), row.sha256, row.filename);
  assert.equal(hash(await fs.readFile(recordedInputPath(proof.resource.filename, [proof.resource.sha256]))), proof.resource.sha256);
  const schema = structuredClone(native.model); schema.definitions.ServerConfiguration.defaults.CacheSize = null; schema.roots.server.defaults.CacheSize = null;
  schema.hostDefaults = { ServerConfiguration: { CacheSize: 'processors-times-100' } }; assert.deepEqual(model, schema);
  assert.equal(hash(await fs.readFile(recordedInputPath(proof.repeat.filename, [proof.repeat.sha256]))), proof.repeat.sha256);
  assert.equal(hash(await fs.readFile(recordedInputPath(proof.repeat.comparison, [proof.repeat.comparisonSha256]))), proof.repeat.comparisonSha256);
  const repeated = parseLosslessJson((await fs.readFile(recordedInputPath(proof.repeat.filename, [proof.repeat.sha256]))).toString('utf8'));
  assert.deepEqual(native.results.map(configurationObservation), repeated.results.map(configurationObservation));
  assert.deepEqual(native.results.map(row => row.name), input.map(row => row.name));
});

for (const sample of input.filter(sample => !sample.helper)) test('configuration raw reader: ' + sample.name, () => {
  const expected = native.results.find(row => row.name === sample.name), bytes = Buffer.from(expected.beforeBytes ?? '', 'base64');
  if (!expected.accepted) assert.throws(() => parseConfigurationXml(bytes, sample.root));
  else assert.deepEqual(parseConfigurationXml(bytes, sample.root, { processors: native.host.processorCount }), configurationValue(expected.value, sample.root));
});
