import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfigurationXml } from './fixtures/configuration/codecs.js';
import { model } from './fixtures/configuration/codecs.js';
import { configurationValue, configurationObservation } from './fixtures/configuration/observations.js';
import { currentConfiguration, input } from './configuration-current.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];

test('configuration evidence binds real XML, helper, plugin loaders, files, full types and independent repeat', async () => {
  const { native, repeat: repeated, report } = await currentConfiguration();
  assert.equal(report.nativeExecutionRecorded, true);
  // This frozen producer records its declared seven roots. New named owners
  // have independent current producers rather than extending that old input.
  for (const root of Object.keys(native.model.roots)) {
    const schema = model.roots[root];
    assert.ok(schema, root + ' recorded reader');
    const defaults = parseConfigurationXml(Buffer.from(`<${schema.element}/>`), root, { processors: native.host.processorCount });
    assert.deepEqual(defaults, configurationValue(native.model.roots[root].defaults, root), root + ' complete public defaults');
  }
  assert.deepEqual(native.results.map(configurationObservation), repeated.results.map(configurationObservation));
  assert.deepEqual(native.results.map(row => row.name), input.map(row => row.name));
});

for (const sample of input.filter(sample => !sample.helper)) test('configuration raw reader: ' + sample.name, async () => {
  const { native } = await currentConfiguration();
  const expected = native.results.find(row => row.name === sample.name), bytes = Buffer.from(expected.beforeBytes ?? '', 'base64');
  if (!expected.accepted) assert.throws(() => parseConfigurationXml(bytes, sample.root));
  else assert.deepEqual(parseConfigurationXml(bytes, sample.root, { processors: native.host.processorCount }), configurationValue(expected.value, sample.root));
});
