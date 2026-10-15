import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { NativeIgnoreRules } from '../../src/library/ignore-rules.js';

const root = new URL('./fixtures/ignore-regex-references/', import.meta.url);
const repository = new URL('../../', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async name => JSON.parse(await readFile(new URL(name, root), 'utf8'))));

test('ignore reference recording binds actual CLR matching and pinned character facts', async () => {
  for (const file of provenance.fixtureFiles) assert.equal(createHash('sha256')
    .update(await readFile(new URL(file.path, repository))).digest('hex'), file.sha256, file.path);
  assert.equal(native.actualFrozenIgnoreEscapes, true);
  assert.equal(native.inputSha256, provenance.fixtureFiles[0].sha256);
  assert.equal(native.scope, provenance.scope);
  assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.equal(native.culture, 'zh-CN');
  assert.deepEqual(native.rules.map(value => value.id), input.map(value => value.id));
  assert.equal(native.rules.length, 53);
  assert.equal(native.rules.reduce((count, rule) => count + rule.checks.length, 0), 309);
});

for (const sample of input) test(`native ignore regex references: ${sample.id}`, () => {
  const rules = new NativeIgnoreRules(sample.patterns);
  const expected = native.rules.find(value => value.id === sample.id);
  assert.deepEqual(expected.checks.map(value => value.path), sample.paths);
  assert.deepEqual(sample.paths.map(path => ({ path, ignored: rules.isIgnored(path, { normalizePath: true }) })), expected.checks);
});
